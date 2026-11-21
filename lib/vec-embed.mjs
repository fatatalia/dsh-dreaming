/**
 * vec-embed.mjs —— 主进程侧的嵌入子进程管理
 *
 * 职责：懒启动、请求配对、超时、崩溃自愈、优雅关闭。
 * 失败一律降级为「向量不可用」，绝不把异常抛给插件 apply()。
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveEmbeddingModel } from "./vec-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "vec-embed-child.mjs");

const BOOT_TIMEOUT_MS = 120_000;   // 首次加载模型慢，给足时间
// 单批嵌入超时不能用固定值：一批 100 条长文本（约 500ms/条）要 50 秒，
// 撞上 60s 上限就整批静默失败 —— 实测首次全量回填正是这么挂的
// （报「嵌入失败（子进程无响应）」，实际子进程还在算）。
// 改成「基准 + 每条预算」：小批不受影响，大批也不会被误杀。
const REQUEST_TIMEOUT_BASE_MS = 30_000;
const REQUEST_TIMEOUT_PER_ITEM_MS = 3_000;

const requestTimeoutFor = (n) =>
  REQUEST_TIMEOUT_BASE_MS + Math.max(0, Number(n) || 0) * REQUEST_TIMEOUT_PER_ITEM_MS;
const MAX_RESTARTS = 3;

export class EmbedClient {
  /**
   * @param {object} [opts]
   * @param {object} [opts.log]
   * @param {string} [opts.modelPath] 已由 vec-model 解析并校验过的模型绝对路径。
   *   不给时 start() 会自己解析（可能触发下载）—— 走的是同一套三道校验。
   * @param {boolean} [opts.autoDownload] 缺模型时是否自动下载
   * @param {string} [opts.modelDir]      模型目录
   * @param {string} [opts.modelRepo]     仓库 URI
   * @param {string} [opts.modelFile]     本地文件名
   * @param {Function} [opts.onProgress]  下载进度回调
   */
  constructor({
    log = console,
    modelPath = null,
    autoDownload = true,
    modelDir = null,
    modelRepo = null,
    modelFile = null,
    onProgress = null,
  } = {}) {
    this.log = log;
    this.modelPath = modelPath;
    this.autoDownload = autoDownload;
    this.modelDir = modelDir;
    this.modelRepo = modelRepo;
    this.modelFile = modelFile;
    this.onProgress = onProgress;
    /** 最近一次模型解析失败的原因 —— vectorStatus 要展示给用户。 */
    this.modelError = null;
    this.child = null;
    this.ready = false;
    this.dim = 768;
    this._seq = 0;
    this._pending = new Map(); // id → {resolve, reject, timer}
    this._booting = null;
    this._restarts = 0;
    this._dead = false;
    this._stopping = false; // 主动关闭时不要报「崩溃」
  }

  /** 启动子进程并等 ready。并发调用共用同一次启动。 */
  async start() {
    if (this.ready) return true;
    if (this._dead) return false;
    if (this._booting) return this._booting;
    this._stopping = false;

    /*
     * 模型路径没传就先解析（可能触发下载）。
     *
     * ⚠️ 这里**不能**设 this._dead：模型缺失是可恢复的 ——
     * 用户下完模型、或者把 DSH_VEC_MODEL 指对之后，再调一次 start() 就该能起来。
     * _dead 留给「fork 都失败」那种环境级问题。
     */
    if (!this.modelPath) {
      // 这几个字段允许传函数 —— 配置在运行时可变，每次启动重新求值
      const val = (v) => (typeof v === "function" ? v() : v);
      const r = await resolveEmbeddingModel({
        log: this.log,
        autoDownload: val(this.autoDownload) !== false,
        dir: val(this.modelDir) || undefined,
        repo: val(this.modelRepo) || undefined,
        file: val(this.modelFile) || undefined,
        onProgress: val(this.onProgress) || undefined,
      });
      if (r.error) {
        this.log?.error?.(`[vec] 嵌入模型不可用：${r.reason}`);
        this.modelError = { error: r.error, reason: r.reason };
        return false;
      }
      this.modelPath = r.path;
      this.modelError = null;
    }

    this._booting = new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(bootTimer);
        resolve(ok);
      };

      let child;
      try {
        // execArgv 必须显式清空：fork 默认继承宿主的 process.execArgv，
        // 宿主若带 --input-type / --eval 之类的参数，子进程一启动就
        // ERR_INPUT_TYPE_NOT_ALLOWED（实测 322ms 退出 code=1）。
        // 子进程是纯 ESM 文件，不需要宿主的任何 node 参数。
        child = fork(CHILD, [], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          // 模型路径走环境变量传给子进程 —— 子进程的 findModel() 第一优先
          // 就读 DSH_VEC_MODEL，所以这样传过去它直接命中，一行都不用改。
          env: {
            ...process.env,
            ...(this.modelPath ? { DSH_VEC_MODEL: this.modelPath } : {}),
          },
          execArgv: [],
        });
      } catch (e) {
        this.log?.error?.(`[vec] 子进程启动失败: ${e?.message}`);
        this._dead = true; // fork 都失败 = 环境问题，别再重试
        return done(false);
      }

      this.child = child;

      const bootTimer = setTimeout(() => {
        this.log?.error?.("[vec] 子进程启动超时");
        try { child.kill("SIGKILL"); } catch {}
        done(false);
      }, BOOT_TIMEOUT_MS);

      child.on("message", (msg) => {
        if (msg?.type === "ready") {
          this.ready = true;
          this.dim = msg.dim || 768;
          this._restarts = 0;
          done(true);
          return;
        }
        if (msg?.type === "fatal") {
          // 带上 error 码，别让设置页只显示「失败」却说不出原因。
          // no_engine / model_missing / model_load_failed 三种，前端各有一句文案。
          this.modelError = { error: msg.error || "boot_failed", reason: msg.message };
          this.log?.error?.(`[vec] 子进程 fatal（${this.modelError.error}）: ${msg.message}`);
          // no_engine / model_load_failed 是永久性错误（没装引擎 / 模型文件坏），
          // 重启三次也不会变好，只会把同一条日志刷三遍 —— 直接停掉等用户修完重启。
          // model_missing 例外：那是可恢复的（补上模型再 start() 就该起来），不设 dead。
          if (this.modelError.error !== "model_missing") this._dead = true;
          done(false);
          return;
        }
        this._onMessage(msg);
      });

      child.on("exit", (code, signal) => {
        this.ready = false;
        this.child = null;
        done(false);
        this._failAllPending("子进程退出");

        if (this._restarts >= MAX_RESTARTS) {
          this.log?.error?.(`[vec] 子进程反复崩溃（已 ${this._restarts} 次），停止重启`);
          this._dead = true;
          return;
        }
        // 主动 stop() 造成的退出不是异常
        if (this._stopping) return;

        // 非预期退出 → 下次 embed 时自动重启，不在这里立刻拉起（避免崩溃循环）
        if (code !== 0 || signal) {
          this._restarts += 1;
          this.log?.warn?.(`[vec] 子进程退出 code=${code} signal=${signal}，下次请求时重启`);
        }
      });

      child.on("error", (e) => {
        this.log?.error?.(`[vec] 子进程错误: ${e?.message}`);
        done(false);
      });
    }).finally(() => { this._booting = null; });

    return this._booting;
  }

  _onMessage(msg) {
    if (msg?.type === "result" || msg?.type === "error") {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === "result") p.resolve(msg.vectors || []);
      else p.reject(new Error(msg.message || "嵌入失败"));
    }
  }

  _failAllPending(reason) {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this._pending.delete(id);
    }
  }

  /**
   * 嵌入一批文本。
   * @param {string[]} texts
   * @returns {Promise<number[][]|null>} 失败返回 null（**不抛异常**，调用方降级即可）
   */
  async embed(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const ok = await this.start();
    if (!ok || !this.child) return null;

    const id = ++this._seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve(null);
      }, requestTimeoutFor(texts.length));

      this._pending.set(id, {
        resolve: (v) => resolve(v),
        reject: () => resolve(null), // 失败一律 null，不抛
        timer,
      });

      try {
        this.child.send({ type: "embed", id, texts });
      } catch {
        clearTimeout(timer);
        this._pending.delete(id);
        resolve(null);
      }
    });
  }

  /** 单条嵌入的便捷方法。失败返回 null。 */
  async embedOne(text) {
    const batch = await this.embed([text]);
    if (!batch || !batch[0]) return null;
    return batch[0];
  }

  stop() {
    this._stopping = true;
    const c = this.child;
    this.child = null;
    this.ready = false;
    this._failAllPending("客户端关闭");
    if (c) {
      try { c.send({ type: "shutdown" }); } catch {}
      try { c.kill("SIGTERM"); } catch {}
    }
  }

  get status() {
    return { ready: this.ready, dim: this.dim, dead: this._dead };
  }
}
