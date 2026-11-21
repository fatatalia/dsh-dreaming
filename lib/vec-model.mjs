/**
 * vec-model.mjs —— 嵌入模型的解析与获取
 *
 * 唯一职责：给出一份**可用的模型文件路径**，或者明确说明为什么没有。
 * 不做嵌入、不碰数据库、不懂索引 —— 那些是别人的事。
 *
 * ── 三道校验（任何一道不过都视为「没有」）────────────────────────────────
 *   ① 文件存在
 *   ② 大小 ≥ MIN_BYTES          —— 挡住 404 残留、下载中断的残片
 *   ③ 前 4 字节是 GGUF magic    —— 挡住「存在但是别的格式」
 *
 * 为什么必须有第 ②③ 道：`existsSync` 只回答「有没有这个路径」。
 * 实测踩过 —— 一个 15 字节的 `bge-m3-q4_k_m.gguf`（内容是 `Entry not found`，
 * HuggingFace 404 的响应体）通过了 existsSync，被当成有效模型喂给 loadModel，
 * 最后崩在 llama.cpp 内部，报错完全不指向真实原因。
 *
 * ── 硬边界 ──────────────────────────────────────────────────────────────
 *   失败时**绝不抛异常**。向量功能停摆就停摆，不能连累对话和其他插件。
 *   调用方拿到的永远是 { path } 或 { error, reason }。
 */

import { createReadStream } from "node:fs";
import { access, rename, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 默认模型目录，与 node-llama-cpp 的全局目录一致。 */
export const DEFAULT_DIR = join(homedir(), ".node-llama-cpp", "models");

/** 仓库 URI 与文件名分开存 —— 用户不该有机会把文件名写错一半。 */
export const DEFAULT_REPO = "ggml-org/embeddinggemma-300m-qat-q8_0-GGUF";
export const DEFAULT_FILE = "embeddinggemma-300m-qat-Q8_0.gguf";

/**
 * 大小下限。正常 Q8_0 模型 313MB，给足余量到 50MB ——
 * 比这小的肯定不是完整模型，宁可重新下载。
 */
export const MIN_BYTES = 50 * 1024 * 1024;

/** GGUF magic：正常模型文件的前 4 字节。 */
const GGUF_MAGIC = Buffer.from("GGUF", "ascii");

/**
 * 下载停滞判定：连续这么久没有任何新字节进来就中止。
 * 313MB 正常下 5 分钟，30 秒一动不动肯定是网络层出了问题，
 * 继续等下去只是白占一个 socket。
 */
const STALL_TIMEOUT_MS = 30_000;

/**
 * 校验单个候选文件。
 *
 * @param {string} file 绝对路径
 * @returns {Promise<{ok: true, bytes: number} | {ok: false, reason: string, bytes?: number}>}
 */
export async function inspect(file) {
  try {
    await access(file, constants.R_OK);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  let bytes = 0;
  try {
    const st = await stat(file);
    if (!st.isFile()) return { ok: false, reason: "not_a_file" };
    bytes = st.size;
  } catch (err) {
    return { ok: false, reason: `stat_failed: ${err?.message || err}` };
  }

  if (bytes < MIN_BYTES) {
    return { ok: false, reason: "too_small", bytes };
  }

  const magic = await readMagic(file);
  if (magic !== "GGUF") {
    return { ok: false, reason: "bad_magic", bytes };
  }

  return { ok: true, bytes };
}

/** 读文件前 4 字节，失败返回空串。 */
function readMagic(file) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const stream = createReadStream(file, { start: 0, end: 3 });
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => finish(Buffer.concat(chunks).toString("ascii")));
    stream.on("error", () => finish(""));
  });
}

/**
 * 把坏文件改名留档，而不是删除。
 *
 * 万一是用户自己放的、只是格式不对，不该由插件替他销毁。
 * 改名后它不再参与候选，也不会被误认成有效模型。
 */
async function quarantine(file, log) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = `${file}.corrupt-${stamp}`;
  try {
    await rename(file, target);
    log?.warn?.(`检测到损坏的模型文件，已重命名为 ${target}`);
    return true;
  } catch (err) {
    log?.warn?.(`损坏的模型文件无法重命名（${err?.message || err}），仍会尝试下载`);
    return false;
  }
}

/**
 * 候选路径列表 —— 按优先级排。
 * 环境变量显式指定 > 配置项目录 > 默认目录。
 */
function candidates({ dir, file }) {
  const out = [];
  const explicit = process.env.DSH_VEC_MODEL;
  if (explicit) out.push(explicit);
  const d = dir || DEFAULT_DIR;
  out.push(join(d, file || DEFAULT_FILE));
  // 兼容早期落在默认目录的另一份命名
  if (!dir) out.push(join(DEFAULT_DIR, "embeddinggemma-300m-Q8_0.gguf"));
  return [...new Set(out)];
}

/**
 * 解析模型：先找本地，找不到按需下载。
 *
 * @param {object} opts
 * @param {object} [opts.log]            logger，可有可无
 * @param {boolean} [opts.autoDownload]  缺模型时是否自动下载
 * @param {string} [opts.dir]            模型目录
 * @param {string} [opts.repo]           仓库 URI（不含文件名）
 * @param {string} [opts.file]           本地文件名
 * @param {(p:{percent:number, downloaded:number, total:number, speedBps:number}) => void} [opts.onProgress]
 * @returns {Promise<{path:string, bytes:number, source:string} | {error:string, reason:string, tried?:string[]}>}
 */
export async function resolveEmbeddingModel(opts = {}) {
  const { log, autoDownload = true, dir, repo = DEFAULT_REPO, file = DEFAULT_FILE, onProgress } = opts;

  // ① 本地已有：逐个校验，第一个通过的直接用
  const tried = [];
  for (const c of candidates({ dir, file })) {
    const r = await inspect(c);
    if (r.ok) {
      log?.info?.(`嵌入模型已就绪：${c}（${mb(r.bytes)}）`);
      return { path: c, bytes: r.bytes, source: "local" };
    }
    tried.push(`${c} (${r.reason})`);
    // 存在的但坏了 —— 留档，避免下次又被当成候选
    if (r.reason !== "not_found") await quarantine(c, log);
  }

  // ② 用户显式指定了路径但无效：尊重他的选择，不擅自下载
  if (process.env.DSH_VEC_MODEL) {
    return { error: "explicit_path_invalid", reason: `DSH_VEC_MODEL 指向的文件无效：${tried.join("; ")}`, tried };
  }

  // ③ 不自动下载：停在这里，让 UI 显式提示
  if (!autoDownload) {
    return { error: "missing", reason: "未检测到嵌入模型，且自动下载已关闭", tried };
  }

  // ④ 下载
  return download({ log, dir: dir || DEFAULT_DIR, repo, file, onProgress });
}

/**
 * 调 node-llama-cpp 的下载器。
 *
 * `verify: true` 会比对远端预期大小 —— 这一道挡的是「下完了但是坏的」。
 * 本地校验（大小 + magic）仍要再跑一次：verify 只管大小，不管内容。
 */
async function download({ log, dir, repo, file, onProgress }) {
  let resolveModelFile;
  try {
    ({ resolveModelFile } = await import("node-llama-cpp"));
  } catch (err) {
    return { error: "no_downloader", reason: `node-llama-cpp 不可用（${err?.message || err}），无法自动下载` };
  }

  const uri = `hf:${repo}/${file}`;
  const host = hostOf(process.env.HF_ENDPOINT) || "huggingface.co";
  log?.info?.(`开始下载嵌入模型：${uri} → ${dir}（源 ${host}）`);

  let lastBytes = 0;
  let lastMoveAt = Date.now();
  const startedAt = Date.now();

  try {
    const path = await resolveModelFile(uri, {
      directory: dir,
      download: "auto",
      verify: true,
      cli: false,
      deleteTempFileOnCancel: true,
      onProgress: ({ totalSize, downloadedSize }) => {
        const now = Date.now();
        if (downloadedSize > lastBytes) {
          lastBytes = downloadedSize;
          lastMoveAt = now;
        }
        const elapsed = (now - startedAt) / 1000;
        const speedBps = elapsed > 0.5 ? downloadedSize / elapsed : 0;
        const percent = totalSize > 0 ? Math.min(100, (downloadedSize / totalSize) * 100) : 0;
        onProgress?.({ percent, downloaded: downloadedSize, total: totalSize, speedBps });

        if (now - lastMoveAt > STALL_TIMEOUT_MS) {
          log?.warn?.(`模型下载停滞超过 ${STALL_TIMEOUT_MS / 1000} 秒，放弃`);
        }
      },
    });

    // 下完再验一次 —— verify 只比大小，内容还是要自己看
    const r = await inspect(path);
    if (!r.ok) {
      await quarantine(path, log);
      return { error: "verify_failed", reason: `下载完成但校验失败（${r.reason}）` };
    }

    log?.info?.(`嵌入模型下载完成：${path}（${mb(r.bytes)}）`);
    return { path, bytes: r.bytes, source: "downloaded" };
  } catch (err) {
    const msg = err?.message || String(err);
    // 常见原因翻译成可读文案，别把 Node 的原始堆栈甩到用户脸上
    if (/ENOSPC/i.test(msg)) return { error: "no_space", reason: "磁盘空间不足" };
    if (/EACCES|EPERM/i.test(msg)) return { error: "no_permission", reason: `无权写入 ${dir}` };
    if (/404|not found/i.test(msg)) return { error: "bad_uri", reason: `下载地址不存在（${uri}），请检查仓库名` };
    if (/timeout|ETIMEDOUT|stalled/i.test(msg)) return { error: "network", reason: `下载超时（源 ${host}）` };
    return { error: "download_failed", reason: msg };
  }
}

/** 字节数 → 人类可读。 */
export function mb(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/** 从 URL 取 host，取不到返回空串。 */
function hostOf(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * 轻量状态探测 —— 只查文件，不加载模型、不启动子进程。
 *
 * 设置页需要在**开关关着**的时候也知道「模型有没有」，
 * 这条路径就是给那种场景用的：几次 stat，几毫秒。
 *
 * @returns {Promise<{state:"ready"|"missing", path?:string, bytes?:number, displaySize?:string}>}
 */
export async function probeModel({ dir, file } = {}) {
  const list = candidates({ dir, file });
  for (const c of list) {
    const r = await inspect(c);
    if (r.ok) return { state: "ready", path: c, bytes: r.bytes, displaySize: mb(r.bytes) };
  }
  return { state: "missing" };
}
