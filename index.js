/**
 * dsh-dreaming — host 半部分
 *
 * 梦境记忆整合：每天凌晨随机窗口触发 Deep 闭环 —— 引擎从**本地取材**
 * （各工作区 memory/daily/*.md + 记忆库 ~/.dsh/dreaming-memory.db 的近期对话）、
 * 生成叙事化梦境日记（法塔人格）、自主判定高价值洞察；梦境存 SQLite、晋升写回
 * MEMORY.md。web 端经 connection.rpc 读取梦境数据（"/dsh-dreaming" 通道）在
 * "梦境" Tab 展示；设置页（Settings → 梦境）经 Typert remote 配置默认工作区与
 * 随机窗口。
 */
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { homedir } from "node:os";
import { join } from "node:path";
import { DreamEngine } from "./lib/dream-engine.mjs";
import { applyMemory } from "./lib/memory.mjs";
import { EmbedClient } from "./lib/vec-embed.mjs";
import { probeModel, DEFAULT_DIR as VEC_DEFAULT_DIR, DEFAULT_FILE as VEC_DEFAULT_FILE, DEFAULT_REPO as VEC_DEFAULT_REPO } from "./lib/vec-model.mjs";
import { applyPromptInjection, memoryStatus } from "./lib/inject.mjs";
import { applySemanticInjection } from "./lib/vec-inject.mjs";
import { applyNudge } from "./lib/nudge.mjs";
import { DEFAULT_DB_PATH } from "./lib/db.mjs";
import { DreamStore } from "./lib/store.mjs";
import { renderDreams } from "./lib/dream-render.mjs";

export const name = "dsh-dreaming";

// 2026-11-20：并入记忆功能后补 sessionPersistence（原 fatatalia-memory 的 inject 里就有，
// 落库走 session/event，缺它会在 apply 时抛依赖缺失）。
export const inject = ["typert", "llm", "agents", "agentDefaultModel", "agentPresets", "sessions", "sessionPersistence", "workspaceRegistry", "connection", "tools", "webServer", "systemPrompt"];

// 2026-09-24 适配 dsh 0.1.7：ctx.settings.register() 已移除，原 `dreaming`
// settings namespace 并入插件 Config；.volatile() 字段可在设置页热改。
/** `dreaming` 配置：默认工作区 + 随机窗口。 */
export const Config = z.object({
  /** 默认工作区（梦境产物落盘位置）。 */
  workspace: z.string().default(homedir()).volatile(),
  // ↑ 默认值只是兜底（梦境 session 的 cwd）。真实工作区由 profile 的
  //    config.workspace 显式指定；漏配时会落到家目录，不至于启动失败。
  //    2026-11-20 之前这里硬编码成 ~/dsh/mayacode —— 对别人的 profile 是无意义的路径。
  windowStart: z.string().default("02:00").volatile(),
  windowEnd: z.string().default("04:30").volatile(),
  provider: z.string().volatile(),
  model: z.string().volatile(),
  /**
   * 思考等级：off/low/medium/high/max，空串 = 跟随 provider 默认。
   * 2026-09-11 加：此前梦境的 reasoningEffort 由 provider 层 `reasoning: high` 隐式兜底，
   * 设置页无从调整；现在显式配置、默认 high、保存即热生效。
   */
  reasoningEffort: z.string().default("high").volatile(),
  /** turn 级单步超时（秒）：step 超过该时长被 dsh-turn-guard 强制 cancel；不配/0 = 不限制。 */
  stepTimeoutSec: z.number().volatile(),

  // ── 以下 5 项 2026-11-20 从 dsh-fatatalia-memory 并入 ──────────────────
  // 两插件已合并：dreaming 管梦，memory 管落库与检索，同一个库、同一个进程。
  /** SQLite 库路径（对话 + 梦境共用）。 */
  dbPath: z.string().default(DEFAULT_DB_PATH).volatile(),
  /** 对话落库总开关。梦境开关另见 dreamingEnabled。 */
  memoryEnabled: z.boolean().default(true).volatile(),
  /** 是否把 assistant 的 reasoning 也入库（体积大，默认关）。 */
  storeReasoning: z.boolean().default(false).volatile(),
  /** 单个 turn 最多入库多少条（防御性上限，超出部分下轮续）。 */
  maxPerTurn: z.number().default(2000).volatile(),
  /** 落库与检索的日志详细程度。 */
  memoryVerbose: z.boolean().default(true).volatile(),
  /** 提炼（梦境）总开关 —— 与对话落库独立，关掉梦境不影响检索。 */
  dreamingEnabled: z.boolean().default(true).volatile(),

  // ── 以下 3 项 2026-11-20 加：nudge（对话中途沉淀）──────────────────────
  // 补的是记忆链路的前半段：原始对话 → daily。梦境只从 daily 取材，
  // 而 daily 一直靠主会话自觉写（三天 3 份、四个工作区里三个一份没有）。
  /** nudge 总开关。关掉只停中途沉淀，梦境与检索照跑。 */
  nudgeEnabled: z.boolean().default(true).volatile(),
  /** 累计多少轮触发一次（turn/end 计数）。0 或负数 = 用默认 10。 */
  nudgeTurnThreshold: z.number().default(10).volatile(),
  /** 同一会话两次 nudge 的最小间隔（分钟）—— 防抖，避免工具密集的 turn 刷触发。 */
  nudgeMinGapMin: z.number().default(5).volatile(),

  // ── 语义检索（2026-11-21 加）──────────────────────────────────────────
  // 平铺而非嵌套：与上面 8 项同风格，volatile 热改路径已验证。
  // 三级开关：全关 / 只索引不注入(enable=true,autoInject=false) / 全开。
  /** 语义检索总开关。关掉则完全不加载 vec0、不启嵌入子进程。 */
  semanticEnabled: z.boolean().default(false).volatile(),
  /** 自动注入。仅 semanticEnabled 为真时有效；关掉 = 只索引不注入。 */
  semanticAutoInject: z.boolean().default(true).volatile(),
  /** 增量索引间隔（分钟）。 */
  semanticIntervalMin: z.number().default(10).volatile(),
  /** 最低相关度：低于此分不注入/不返回。0.62 由 24 个真实查询的分数分布定。 */
  semanticMinScore: z.number().default(0.62).volatile(),
  /** 候选池大小（向量近邻取多少条参与混合打分）。2 核机器取 24 省算力。 */
  semanticCandidatePool: z.number().default(24).volatile(),
  /** 注入/返回条数。 */
  semanticTopK: z.number().default(6).volatile(),
  /** 向量权重。关键词权重恒为 1 - 此值（两个独立配会让总分缩水被 minScore 误杀）。 */
  semanticVectorWeight: z.number().default(0.7).volatile(),
  /** 单条注入的截断字数。 */
  semanticMaxSnippetChars: z.number().default(200).volatile(),
  /** 缺模型时是否自动下载。关掉则停在「未检测到模型」，等用户手动放文件。 */
  semanticAutoDownload: z.boolean().default(true).volatile(),
  /** 模型目录。留空 = ~/.node-llama-cpp/models */
  semanticModelDir: z.string().default("").volatile(),
  /** 模型仓库 URI（不含文件名）。留空 = 内置默认仓库。 */
  semanticModelRepo: z.string().default("").volatile(),
  /** 本地文件名。留空 = 内置默认文件名。 */
  semanticModelFile: z.string().default("").volatile(),
});

// ── Typert wire schemas（宽松 parse，同 imessage 插件） ──────────────────────
function parseObj() {
  // 0.1.7：typert strict codec 必须有 create() 工厂（gateway 走 codec.create().parse(v)）。
  const parse = (value) => {
    if (typeof value !== "object" || value === null) throw new Error("expected object");
    return value;
  };
  return { parse, create: () => ({ parse }) };
}
const getResultSchema = parseObj();
const setPayloadSchema = parseObj();
const setResultSchema = parseObj();

const MANIFEST = {
  package: "dsh-dreaming",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-dreaming#dreaming/getConfig",
      service: "dreaming",
      namespace: "dreaming",
      method: "getConfig",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-dreaming#DreamingConfig", schema: getResultSchema, create: () => getResultSchema },
    },
    {
      id: "dsh-dreaming#dreaming/listProviders",
      service: "dreaming",
      namespace: "dreaming",
      method: "listProviders",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-dreaming#ProviderList", schema: getResultSchema, create: () => getResultSchema },
    },
    {
      id: "dsh-dreaming#dreaming/listModels",
      service: "dreaming",
      namespace: "dreaming",
      method: "listModels",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-dreaming#ProviderParam", schema: getResultSchema, create: () => getResultSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-dreaming#ModelList", schema: getResultSchema, create: () => getResultSchema },
    },
    {
      id: "dsh-dreaming#dreaming/setConfig",
      service: "dreaming",
      namespace: "dreaming",
      method: "setConfig",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-dreaming#SetPayload", schema: setPayloadSchema, create: () => setPayloadSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-dreaming#SetResult", schema: setResultSchema, create: () => setResultSchema },
    },
  ],
  model: { services: [], events: [], objects: [] },
};

/** Remote service：读写 dreaming 配置（落盘 settings.yaml），保存后热更新引擎。 */
class DreamingService extends TypertRemoteService {
  constructor(ctx, scope, engine, llm) {
    super(ctx, "dreaming");
    this.scope = scope;
    this.engine = engine;
    this.llm = llm;
  }

  /** 可用 provider 目录（注册了适配器的路由）。返回裸值，Typert 自动包装 ok/value。 */
  async listProviders() {
    const list = await this.llm?.listProviders?.() ?? [];
    return list.map((p) => ({ id: p.provider ?? p.id, name: p.name ?? p.provider ?? p.id }));
  }

  /**
   * 指定 provider 的模型列表。附带给每个模型带上它支持的思考等级（设置页下拉用）。
   * llm.listModels 只回 id/name，能力元数据要走 resolveModelInfo；逐个查询是本地目录
   * 查询（无网络），失败则该项不带 efforts（客户端回落标准五档）。
   */
  async listModels(payload) {
    const provider = typeof payload?.provider === "string" ? payload.provider : "";
    if (!provider) throw new Error("provider 必填");
    const list = await this.llm?.listModels?.(provider) ?? [];
    const resolve = this.llm?.resolveModelInfo;
    const out = [];
    for (const m of list) {
      const item = { id: m.id, name: m.name ?? m.id };
      if (typeof resolve === "function") {
        try {
          const info = await resolve.call(this.llm, provider, m.id);
          const reasoning = info?.reasoning;
          if (reasoning !== void 0) {
            item.efforts = reasoning.efforts.map((e) => e.id);
            if (reasoning.defaultEffort !== void 0) item.defaultEffort = reasoning.defaultEffort;
          }
        } catch { /* 能力未知：留空，客户端用标准档位兜底 */ }
      }
      out.push(item);
    }
    return out;
  }

  getConfig() {
    const snap = this.scope.get();
    /*
     * ⚠️ volatile 字段在 scope.get() 的快照里**不是裸值**，而是
     * `Object.freeze({ get() => value, [write] })` 包装器
     * （见 cosmokit 的 createVolatile）。
     *
     * 直接拿它做判断的后果（2026-11-21 实测，全页回填错误）：
     *   `snap?.semanticEnabled === true`   → 恒 false  ⇒ 勾选框永远不勾
     *   `!== false`                        → 恒 true   ⇒ 配置是 false 也显示开
     *   `typeof snap?.windowStart === "string"` → 恒 false ⇒ 永远回落默认值
     *
     * 所以每个字段都必须先 v() 解包再判断。
     */
    const v = (x) => (x && typeof x === "object" && typeof x.get === "function" ? x.get() : x);
    return {
      // workspace 不再暴露：素材召回已跨全部工作区，这里只剩「内部兜底目录」的语义，
      // 摆到设置页会让人以为「梦境只看这个工作区」。Config 里仍保留该字段。
      windowStart: typeof v(snap?.windowStart) === "string" ? v(snap.windowStart) : "02:00",
      windowEnd: typeof v(snap?.windowEnd) === "string" ? v(snap.windowEnd) : "04:30",
      provider: typeof v(snap?.provider) === "string" ? v(snap.provider) : "",
      model: typeof v(snap?.model) === "string" ? v(snap.model) : "",
      reasoningEffort: typeof v(snap?.reasoningEffort) === "string" ? v(snap.reasoningEffort) : "high",
      stepTimeoutSec: typeof v(snap?.stepTimeoutSec) === "number" && v(snap.stepTimeoutSec) > 0 ? v(snap.stepTimeoutSec) : 0,
      // ── 记忆（2026-11-20 并入）──
      memoryEnabled: v(snap?.memoryEnabled) !== false,
      storeReasoning: v(snap?.storeReasoning) === true,
      maxPerTurn: typeof v(snap?.maxPerTurn) === "number" && v(snap.maxPerTurn) > 0 ? v(snap.maxPerTurn) : 2000,
      memoryVerbose: v(snap?.memoryVerbose) !== false,
      dreamingEnabled: v(snap?.dreamingEnabled) !== false,
      // ── nudge（对话中途沉淀）──
      nudgeEnabled: v(snap?.nudgeEnabled) !== false,
      nudgeTurnThreshold: typeof v(snap?.nudgeTurnThreshold) === "number" && v(snap.nudgeTurnThreshold) > 0 ? v(snap.nudgeTurnThreshold) : 10,
      nudgeMinGapMin: typeof v(snap?.nudgeMinGapMin) === "number" && v(snap.nudgeMinGapMin) > 0 ? v(snap.nudgeMinGapMin) : 5,
      // ── 语义检索（2026-11-21）──
      // 与 setConfig 的白名单成对出现：只补一边 = 存得进去但读不回来（或反过来）。
      semanticEnabled: v(snap?.semanticEnabled) === true,
      semanticAutoInject: v(snap?.semanticAutoInject) !== false,
      semanticIntervalMin: typeof v(snap?.semanticIntervalMin) === "number" && v(snap.semanticIntervalMin) > 0 ? v(snap.semanticIntervalMin) : 10,
      semanticMinScore: typeof v(snap?.semanticMinScore) === "number" ? v(snap.semanticMinScore) : 0.62,
      semanticCandidatePool: typeof v(snap?.semanticCandidatePool) === "number" && v(snap.semanticCandidatePool) > 0 ? v(snap.semanticCandidatePool) : 24,
      semanticTopK: typeof v(snap?.semanticTopK) === "number" && v(snap.semanticTopK) > 0 ? v(snap.semanticTopK) : 6,
      semanticVectorWeight: typeof v(snap?.semanticVectorWeight) === "number" ? v(snap.semanticVectorWeight) : 0.7,
      semanticMaxSnippetChars: typeof v(snap?.semanticMaxSnippetChars) === "number" && v(snap.semanticMaxSnippetChars) > 0 ? v(snap.semanticMaxSnippetChars) : 200,
      // ── 模型获取（2026-11-21）──
      semanticAutoDownload: v(snap?.semanticAutoDownload) !== false,
      semanticModelDir: typeof v(snap?.semanticModelDir) === "string" ? v(snap.semanticModelDir) : "",
      semanticModelRepo: typeof v(snap?.semanticModelRepo) === "string" ? v(snap.semanticModelRepo) : "",
      semanticModelFile: typeof v(snap?.semanticModelFile) === "string" ? v(snap.semanticModelFile) : "",
      writable: true,
    };
  }

  async setConfig(payload) {
    const patch = {};
    if (typeof payload?.windowStart === "string") patch.windowStart = payload.windowStart;
    if (typeof payload?.windowEnd === "string") patch.windowEnd = payload.windowEnd;
    if (typeof payload?.provider === "string") patch.provider = payload.provider;
    if (typeof payload?.model === "string") patch.model = payload.model;
    if (typeof payload?.reasoningEffort === "string") patch.reasoningEffort = payload.reasoningEffort;
    if (typeof payload?.stepTimeoutSec === "number") patch.stepTimeoutSec = payload.stepTimeoutSec > 0 ? payload.stepTimeoutSec : 0;
    // 记忆与 nudge：类型校验后落，非法值忽略（不静默写成 0/false）。
    if (typeof payload?.memoryEnabled === "boolean") patch.memoryEnabled = payload.memoryEnabled;
    if (typeof payload?.storeReasoning === "boolean") patch.storeReasoning = payload.storeReasoning;
    if (typeof payload?.maxPerTurn === "number" && payload.maxPerTurn > 0) patch.maxPerTurn = Math.floor(payload.maxPerTurn);
    if (typeof payload?.memoryVerbose === "boolean") patch.memoryVerbose = payload.memoryVerbose;
    if (typeof payload?.dreamingEnabled === "boolean") patch.dreamingEnabled = payload.dreamingEnabled;
    if (typeof payload?.nudgeEnabled === "boolean") patch.nudgeEnabled = payload.nudgeEnabled;
    if (typeof payload?.nudgeTurnThreshold === "number" && payload.nudgeTurnThreshold > 0) patch.nudgeTurnThreshold = Math.floor(payload.nudgeTurnThreshold);
    if (typeof payload?.nudgeMinGapMin === "number" && payload.nudgeMinGapMin > 0) patch.nudgeMinGapMin = Math.floor(payload.nudgeMinGapMin);
    // 语义检索：新增字段必须逐个进白名单 —— 这里只落 patch 里有的键，
    // 漏写就等于前端改了、保存「成功」、实际什么都没变（2026-11-21 踩过）。
    if (typeof payload?.semanticEnabled === "boolean") patch.semanticEnabled = payload.semanticEnabled;
    if (typeof payload?.semanticAutoInject === "boolean") patch.semanticAutoInject = payload.semanticAutoInject;
    if (typeof payload?.semanticIntervalMin === "number" && payload.semanticIntervalMin > 0) patch.semanticIntervalMin = Math.floor(payload.semanticIntervalMin);
    if (typeof payload?.semanticMinScore === "number") patch.semanticMinScore = Math.min(1, Math.max(0, payload.semanticMinScore));
    if (typeof payload?.semanticCandidatePool === "number" && payload.semanticCandidatePool > 0) patch.semanticCandidatePool = Math.floor(payload.semanticCandidatePool);
    if (typeof payload?.semanticTopK === "number" && payload.semanticTopK > 0) patch.semanticTopK = Math.floor(payload.semanticTopK);
    if (typeof payload?.semanticVectorWeight === "number") patch.semanticVectorWeight = Math.min(1, Math.max(0, payload.semanticVectorWeight));
    if (typeof payload?.semanticMaxSnippetChars === "number" && payload.semanticMaxSnippetChars > 0) patch.semanticMaxSnippetChars = Math.floor(payload.semanticMaxSnippetChars);
    // 模型获取（2026-11-21）：同样必须成对补上 getConfig 回传，否则
    // 表现是「保存成功、界面也变了、重开就回到默认」，全程零报错。
    if (typeof payload?.semanticAutoDownload === "boolean") patch.semanticAutoDownload = payload.semanticAutoDownload;
    if (typeof payload?.semanticModelDir === "string") patch.semanticModelDir = payload.semanticModelDir.trim();
    if (typeof payload?.semanticModelRepo === "string") patch.semanticModelRepo = payload.semanticModelRepo.trim();
    if (typeof payload?.semanticModelFile === "string") patch.semanticModelFile = payload.semanticModelFile.trim();
    if (Object.keys(patch).length === 0) return { ok: true };
    await this.scope.update(patch);
    // 热更新引擎（工作区/窗口/思考等级 + 重排下一次）。
    this.engine.setConfig({
      provider: patch.provider,
      model: patch.model,
      reasoningEffort: patch.reasoningEffort,
      windowStart: patch.windowStart,
      windowEnd: patch.windowEnd,
      stepTimeoutSec: patch.stepTimeoutSec,
    });
    return { ok: true };
  }
}

export function apply(ctx, config) {
  const Logger = ctx.logger;
  const log = {
    info: (m) => { console.log(`[dr] ${m}`); try { Logger?.info?.(m); } catch {} },
    warn: (m) => { console.warn(`[dr:warn] ${m}`); try { Logger?.warn?.(m); } catch {} },
    error: (m) => { console.error(`[dr:err] ${m}`); try { Logger?.error?.(m); } catch {} },
  };

  // ── 记忆落库与检索（2026-11-20 从 dsh-fatatalia-memory 并入）──────────
  // 独立于梦境：memoryEnabled 关掉只停落库，梦境照跑；dreamingEnabled 反之。
  // 用 try/catch 包住 —— 记忆是辅助功能，坏掉不能拖垮梦境调度。
  /*
   * 下载进度 —— 由 EmbedClient 的 onProgress 回调持续更新，
   * vectorStatus 把它带给设置页。null 表示当前没有下载在进行。
   */
  let downloadProgress = null;
  const onDownloadProgress = (p) => { downloadProgress = p; };

  /*
   * 嵌入子进程客户端（2026-11-21）。
   * 懒启动 —— 开关关着时它连进程都不 fork，零开销。
   * stop() 挂在 dispose 上，否则 dsh 退出后子进程会变孤儿继续吃 CPU。
   *
   * 模型路径不再写死在这里：start() 时会调 vec-model 解析（本地三道校验
   * → 缺失则按配置下载），失败原因存进 modelError 供设置页展示。
   */
  const embedClient = new EmbedClient({
    log,
    autoDownload: () => config?.semanticAutoDownload?.get?.() !== false,
    modelDir: () => config?.semanticModelDir?.get?.() || null,
    modelRepo: () => config?.semanticModelRepo?.get?.() || VEC_DEFAULT_REPO,
    modelFile: () => config?.semanticModelFile?.get?.() || VEC_DEFAULT_FILE,
    onProgress: onDownloadProgress,
  });

  /** 取数值配置，非法值一律回落默认 —— 公共插件不能因为填了脏数据就崩。 */
  const numCfg = (get, fallback, min, max) => {
    const n = Number(typeof get === "function" ? get() : get);
    if (!Number.isFinite(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  };

  const semantic = {
    enabled: () => config?.semanticEnabled?.get?.() === true,
    autoInject: () => config?.semanticAutoInject?.get?.() !== false,
    minScore: () => numCfg(config?.semanticMinScore?.get?.(), 0.62, 0, 1),
    candidatePool: () => numCfg(config?.semanticCandidatePool?.get?.(), 24, 1, 200),
    topK: () => numCfg(config?.semanticTopK?.get?.(), 6, 1, 20),
    vectorWeight: () => numCfg(config?.semanticVectorWeight?.get?.(), 0.7, 0, 1),
    maxSnippetChars: () => numCfg(config?.semanticMaxSnippetChars?.get?.(), 200, 50, 2000),
    intervalMin: () => numCfg(config?.semanticIntervalMin?.get?.(), 10, 1, 1440),
    /** 查询嵌入。失败返回 null，调用方自动回落关键词路。 */
    embedQuery: async (q) => {
      try { return await embedClient.embedOne(q); } catch { return null; }
    },
    /** 供索引同步器用的嵌入客户端（阶段 2 用）。 */
    client: embedClient,
  };

  const memCfg = {
    // 这些字段都是 .volatile() 的：volatile 字段访问到的是 Value 包装器，
    // 必须 .get() 取真值；直接拿包装器传给 path 函数就是
    // "p.startsWith is not a function"。
    dbPath: config?.dbPath?.get?.() ?? DEFAULT_DB_PATH,
    enabled: config?.memoryEnabled?.get?.() !== false,
    semantic,
    // 运行时开关（applyMemory 每次 turn/end 现读），热改立即生效。
    isEnabled: () => config?.memoryEnabled?.get?.() !== false,
    getStoreReasoning: () => config?.storeReasoning?.get?.() === true,
    getMaxPerTurn: () => {
      const n = Number(config?.maxPerTurn?.get?.());
      return n > 0 ? n : 2000;
    },
    isVerbose: () => config?.memoryVerbose?.get?.() !== false,
    storeReasoning: config?.storeReasoning?.get?.() === true,
    maxPerTurn: Number(config?.maxPerTurn?.get?.()) > 0 ? Number(config.maxPerTurn.get()) : 2000,
    verbose: config?.memoryVerbose?.get?.() !== false,
  };
  // 日志开关也做成活的：设置页关掉立刻安静，不用重启。
  const memLog = {
    info: (...args) => { if (memCfg.isVerbose()) log.info(...args); },
    warn: (...args) => log.warn(...args),
    error: (...args) => log.error(...args),
  };
  let memHandle = null;
  try {
    memHandle = applyMemory(ctx, memCfg, memLog);
  } catch (e) {
    log.error(`记忆模块加载失败（不影响梦境）：${e instanceof Error ? e.message : e}`);
  }

  // ── 记忆注入层（P3）：把 MEMORY.md / USER.md 送进 system prompt ────────
  // 与落库独立：注入失败只影响「我记不记得」，不影响「我记不记」。
  try {
    applyPromptInjection(ctx, log);
  /*
   * 语义记忆注入（2026-11-21）。
   * 与上面那条完全不同：那条是 MEMORY.md / USER.md 的静态全文注入，
   * 这条是「按当前这句话去检索历史对话」的动态注入。
   * 开关语义：semanticEnabled 关 = 整条链都不存在；只关 autoInject = 索引照建、不注入。
   */
  applySemanticInjection(ctx, memLog, {
    enabled: semantic.enabled,
    autoInject: semantic.autoInject,
    // vec 没就绪（开关刚开、扩展加载失败、指纹不匹配）时静默跳过，不报错
    ready: () => memHandle?.available?.() === true,
    embedQuery: semantic.embedQuery,
    db: () => memHandle?.db ?? null,
    topK: semantic.topK,
    minScore: semantic.minScore,
    maxSnippetChars: semantic.maxSnippetChars,
  });
  } catch (e) {
    log.error(`记忆注入层加载失败（不影响落库与梦境）：${e instanceof Error ? e.message : e}`);
  }

  // ── nudge（P4）：对话进行中把值得记的抄进 memory/daily ─────────────────
  // 只写 daily，不碰 MEMORY.md / USER.md —— 那两份走梦境那条带门控的慢车道。
  // 任何异常都吞在内部：它是旁路，不该影响对话。
  try {
    applyNudge(ctx, {
      // 传 getter 而不是值：设置页改完立刻生效，无需重启。
      getConfig: () => ({
        enabled: config?.nudgeEnabled?.get?.() !== false,
        turnThreshold: Number(config?.nudgeTurnThreshold?.get?.()) > 0 ? Number(config.nudgeTurnThreshold.get()) : 10,
        minGapMs: (Number(config?.nudgeMinGapMin?.get?.()) > 0 ? Number(config.nudgeMinGapMin.get()) : 5) * 60 * 1000,
      }),
      workspace: config?.workspace?.get?.() ?? "",
    }, log);
  } catch (e) {
    log.error(`nudge 加载失败（不影响落库、注入与梦境）：${e instanceof Error ? e.message : e}`);
  }

  // 0.1.7：配置即插件 Config 的 volatile 字段，这里适配出等价的 scope 外壳。
  // （2026-11-20：workspace 语义已变 —— 不再是「素材来源」，而是梦境 session 的 cwd 兜底；
  //   素材来源改为从记忆库 sessions.workspace 动态取全部工作区。窗口 02:00-04:30。）
  const scope = {
    get: () => ({
      workspace: config.workspace.get(),
      windowStart: config.windowStart.get(),
      windowEnd: config.windowEnd.get(),
      provider: config.provider.get(),
      model: config.model.get(),
      reasoningEffort: config.reasoningEffort.get(),
      stepTimeoutSec: config.stepTimeoutSec.get(),
      // 2026-11-20 并入的两组配置：设置页要读写，热改了要能生效。
      dbPath: config.dbPath.get(),
      memoryEnabled: config.memoryEnabled.get(),
      storeReasoning: config.storeReasoning.get(),
      maxPerTurn: config.maxPerTurn.get(),
      memoryVerbose: config.memoryVerbose.get(),
      dreamingEnabled: config.dreamingEnabled.get(),
      nudgeEnabled: config.nudgeEnabled.get(),
      nudgeTurnThreshold: config.nudgeTurnThreshold.get(),
      nudgeMinGapMin: config.nudgeMinGapMin.get(),
      /*
       * 语义检索 / 模型获取（2026-11-21）。
       * ⚠️ 这里是**手写白名单**，加配置字段时必须同步补进来 ——
       * 漏了的表现是 getConfig() 读不到（undefined → 回落默认值），
       * 设置页勾选框永远回填不上，而 setConfig 那边却是好的。
       * 本次就是靠诊断日志发现 semanticEnabled 取到 undefined 才定位的。
       */
      semanticEnabled: config.semanticEnabled.get(),
      semanticAutoInject: config.semanticAutoInject.get(),
      semanticIntervalMin: config.semanticIntervalMin.get(),
      semanticMinScore: config.semanticMinScore.get(),
      semanticCandidatePool: config.semanticCandidatePool.get(),
      semanticTopK: config.semanticTopK.get(),
      semanticVectorWeight: config.semanticVectorWeight.get(),
      semanticMaxSnippetChars: config.semanticMaxSnippetChars.get(),
      semanticAutoDownload: config.semanticAutoDownload.get(),
      semanticModelDir: config.semanticModelDir.get(),
      semanticModelRepo: config.semanticModelRepo.get(),
      semanticModelFile: config.semanticModelFile.get(),
    }),
    async update(patch) {
      const editor = ctx.get("configEditor");
      const entry = ctx.fiber?.entry;
      if (!editor || entry === undefined) return;
      await editor.edit(entry, (current) => ({ ...current, ...patch }));
    },
    watch(cb) {
      ctx.on("loader/volatile-update", () => { cb(scope.get()); });
    },
  };

  const store = new DreamStore();
  const engine = new DreamEngine({
    agents: ctx.get("agents"),
    defaultModel: ctx.get("agentDefaultModel"),
    sessions: ctx.get("sessions"),
    agentPresets: ctx.get("agentPresets"),
    workspaceRegistry: ctx.get("workspaceRegistry"),
    store,
    log,
    workspace: scope.get()?.workspace,
    provider: scope.get()?.provider,
    model: scope.get()?.model,
    windowStart: scope.get()?.windowStart,
    windowEnd: scope.get()?.windowEnd,
    reasoningEffort: typeof scope.get()?.reasoningEffort === "string" ? scope.get()?.reasoningEffort : "high",
    stepTimeoutSec: typeof scope.get()?.stepTimeoutSec === "number" && scope.get()?.stepTimeoutSec > 0 ? scope.get()?.stepTimeoutSec : 0,
    llm: ctx.get("llm"),
  });

  // 注册 dream_latest 工具：查询最近梦境（供早安心跳等场景调用，替代读 OpenClaw 遗留 DREAMS.md）。
  const dreamLatestTool = defineTool({
    name: "dream_latest",
    description: "查询最近几天的梦境日记（dsh-dreaming 存储，SQLite）。用于早安心跳分享梦境。返回最近 N 条梦境（日期 + 内容），新→旧。",
    parameters: {
      days: { type: "number", description: "返回最近 N 天的梦境（每天最多 2 条），默认 2，范围 1-7" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dreams: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                date: { type: "string", required: true },
                content: { type: "string", required: true },
              },
            },
          },
        },
      },
      render(args, value) {
        return [{ type: "text", text: renderDreams(value?.dreams) }];
      },
    },
    async execute(args) {
      const days = Math.min(Math.max(Number(args?.days) || 2, 1), 7);
      const dreams = store.listDreams(days * 2, null);
      return { dreams: dreams.slice(0, days * 2).map((d) => ({ date: d.date, content: d.content })) };
    },
  });
  ctx.tools.register(dreamLatestTool);
  log.info("已注册 dream_latest 工具（最近梦境查询）");
  // 配置 remote（设置页读写）+ typert manifest。
  new DreamingService(ctx, scope, engine, ctx.get("llm"));
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-dreaming: typert manifest");

  /**
   * 组装模型状态，给设置页用。
   *
   * 顺序有讲究：下载中 > 失败 > 探测。
   * 正在下载时必须报 loading（哪怕旧文件还在），否则页面会显示「已就绪」
   * 而实际上下载还没完，用户以为坏了。
   */
  async function modelStatus() {
    const modelDir = config?.semanticModelDir?.get?.() || null;
    const modelFile = config?.semanticModelFile?.get?.() || null;

    if (downloadProgress) {
      return {
        state: "loading",
        percent: Math.round(downloadProgress.percent || 0),
        downloaded: downloadProgress.downloaded || 0,
        total: downloadProgress.total || 0,
        speedBps: Math.round(downloadProgress.speedBps || 0),
        host: hfHost(),
        error: null,
      };
    }

    if (embedClient.modelError) {
      return {
        state: "failed",
        errorCode: embedClient.modelError.error,
        error: embedClient.modelError.reason,
        host: hfHost(),
      };
    }

    const probe = await probeModel({ dir: modelDir || undefined, file: modelFile || undefined });
    return {
      state: probe.state,
      path: probe.path || null,
      bytes: probe.bytes || 0,
      displaySize: probe.displaySize || null,
      host: null,
      error: null,
    };
  }

  /** 下载源 host —— 让设置页能显示「到底连的哪」。 */
  function hfHost() {
    const ep = process.env.HF_ENDPOINT;
    if (!ep) return "huggingface.co";
    try {
      return new URL(ep).hostname;
    } catch {
      return ep;
    }
  }

  /**
   * 后台下载模型（设置页按钮触发）。
   *
   * 直接走 EmbedClient.start()：它会先解析（触发下载）、再 fork 子进程。
   * 下完模型索引会自动接着跑，不用用户再点一次。
   */
  async function runModelDownload() {
    if (downloadProgress) return; // 已经在下了
    log.info("手动触发模型下载");
    // 先清掉上次的失败态，否则 start() 里 modelPath 为空会重新解析
    embedClient.modelError = null;
    try {
      await embedClient.start();
      if (!embedClient.modelError) memHandle?.ensureVecReady?.();
    } finally {
      downloadProgress = null;
    }
  }

  // web 端数据通道：梦境 Tab 查询 + 手动触发。
  // 2026-08-17：authority 由 "loopback" 改为 "trusted" —— 走 connection 全局
  // trustedHosts（LAN IP 10.5.20.253 / 域名已在 profiles/web/cordis.patch.yml
  // 的 connection.trustedHosts 列出），允许 Caddy HTTPS 反代访问梦境通道；
  // options 参数必传（register 会读 options.authority），不能省略。
  ctx.connection.rpc.handle("/dsh-dreaming", async (endpoint, payload, signal) => {
    try {
      if (signal?.aborted) throw new Error("The request was cancelled.");
      const p = payload && typeof payload === "object" ? payload : {};
      switch (endpoint) {
        case "listDreams":
          // 支持 { date: "YYYY-MM-DD" } 按日期过滤；不传返回最近 N 条。
          return { ok: true, value: store.listDreams(Number(p.limit) || 50, typeof p.date === "string" && p.date ? p.date : null) };
        case "listPromotions":
          return { ok: true, value: store.listPromotions(Number(p.limit) || 50) };
        case "getDream":
          return { ok: true, value: store.getDream(Number(p.id)) };
        case "runNow":
          // 手动触发一次梦境（异步执行，立即返回）。
          engine.runOnce().catch((e) => log.error(`dreaming: 手动触发失败 ${e instanceof Error ? e.message : e}`));
          return { ok: true, value: { started: true } };
        case "memoryStatus":
          // 只读快照：MEMORY.md / 各工作区 USER.md 的实际注入内容与字节数，
          // 外加当前冻结了哪些会话。梦境页「记忆注入」子 Tab 的数据源。
          return { ok: true, value: memoryStatus() };
        case "vectorStatus": {
          /*
           * 语义索引状态。开关关着 / vec0 不可用时也必须正常应答 ——
           * 前端靠这个判断「未启用」，抛错会让整个设置页崩。
           *
           * model 字段（2026-11-21）：设置页要在**开关关着**的时候也能看出
           * 「模型到底有没有」。所以这里只做轻量文件探测（几次 stat），
           * 不加载模型、不启动子进程。
           */
          const model = await modelStatus();
          const enabled = semantic.enabled();
          if (!enabled) {
            return { ok: true, value: { enabled: false, autoInject: semantic.autoInject(), phase: "idle", pending: 0, indexed: 0, total: 0, model } };
          }
          // 探一次 —— 用户可能刚从设置页打开开关，同步器还没被创建
          memHandle?.ensureVecReady?.();
          const sync = memHandle?.sync ?? null;
          if (!sync) {
            return { ok: true, value: { enabled: true, autoInject: semantic.autoInject(), phase: "idle", pending: 0, indexed: 0, total: 0, unavailable: true, model } };
          }
          return { ok: true, value: { ...sync.status({ enabled: true, autoInject: semantic.autoInject() }), model } };
        }
        case "downloadModel": {
          /*
           * 手动触发模型下载（设置页「下载」按钮）。
           * 立即返回，真正的下载在后台跑；进度由 vectorStatus 轮询取。
           */
          if (!semantic.enabled()) return { ok: true, value: { started: false, reason: "语义检索未启用" } };
          runModelDownload().catch((e) => log.error(`下载模型失败：${e instanceof Error ? e.message : e}`));
          return { ok: true, value: { started: true } };
        }
        case "vectorPause":
          memHandle?.sync?.pause();
          return { ok: true, value: { paused: true } };
        case "vectorResume":
          memHandle?.sync?.resume();
          return { ok: true, value: { paused: false } };

        case "status":
          return { ok: true, value: { nextWindow: { start: engine.windowStart, end: engine.windowEnd }, workspace: engine.workspace } };
        default:
          throw new Error(`unknown endpoint: ${endpoint}`);
      }
    } catch (e) {
      // details 必填：客户端 parseConnectionResponse 要求 isRecord(error.details)，
      // 缺了它整条错误会被替换成 "connection: invalid server-response failure"，
      // 真实原因彻底看不见（2026-11-20 梦境页面就是这么被掩盖的）。
      return {
        ok: false,
        error: {
          code: "ERR",
          message: e instanceof Error ? e.message : String(e),
          details: { endpoint: String(endpoint) },
        },
      };
    }
  }, { authority: "trusted" });
  log.info("梦境数据 RPC 已注册（/dsh-dreaming）");

  // 排程首次梦境（启动后自动计算凌晨窗口内随机时刻）。
  // dreamingEnabled 之前只有 Config 定义、没有消费方 —— 设置页那个开关是假的。
  const dreamOn = () => config?.dreamingEnabled?.get?.() !== false;
  if (dreamOn()) {
    engine.scheduleNext();
  } else {
    log.info("dreaming: 已关闭（dreamingEnabled=false），不排程");
  }
  ctx.on("loader/volatile-update", () => {
    try {
      if (dreamOn()) {
        if (engine._timer === null) { engine.scheduleNext(); log.info("dreaming: 已恢复排程"); }
      } else if (engine._timer !== null) {
        engine.pauseSchedule();
        log.info("dreaming: 已暂停排程");
      }
    } catch (e) {
      log.warn(`dreaming: 排程热更新失败 ${e instanceof Error ? e.message : e}`);
    }
  });

  ctx.on("dispose", () => {
    engine.dispose();
    store.close();
    // 嵌入子进程必须显式停 —— 否则 dsh 退出后它变孤儿，继续占 CPU
    try { embedClient.stop(); } catch {}
  });
  log.info(`梦境引擎已启动（工作区 ${engine.workspace}，窗口 ${engine.windowStart}-${engine.windowEnd}）`);
}


