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
import { applyPromptInjection } from "./lib/inject.mjs";
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
  workspace: z.string().default(join(homedir(), "dsh", "mayacode")).volatile(),
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
  dbPath: z.string().default(DEFAULT_DB_PATH),
  /** 对话落库总开关。梦境开关另见 dreamingEnabled。 */
  memoryEnabled: z.boolean().default(true),
  /** 是否把 assistant 的 reasoning 也入库（体积大，默认关）。 */
  storeReasoning: z.boolean().default(false),
  /** 单个 turn 最多入库多少条（防御性上限，超出部分下轮续）。 */
  maxPerTurn: z.number().default(2000),
  /** 落库与检索的日志详细程度。 */
  memoryVerbose: z.boolean().default(true),
  /** 提炼（梦境）总开关 —— 与对话落库独立，关掉梦境不影响检索。 */
  dreamingEnabled: z.boolean().default(true),

  // ── 以下 3 项 2026-11-20 加：nudge（对话中途沉淀）──────────────────────
  // 补的是记忆链路的前半段：原始对话 → daily。梦境只从 daily 取材，
  // 而 daily 一直靠主会话自觉写（三天 3 份、四个工作区里三个一份没有）。
  /** nudge 总开关。关掉只停中途沉淀，梦境与检索照跑。 */
  nudgeEnabled: z.boolean().default(true),
  /** 累计多少轮触发一次（turn/end 计数）。0 或负数 = 用默认 10。 */
  nudgeTurnThreshold: z.number().default(10),
  /** 同一会话两次 nudge 的最小间隔（分钟）—— 防抖，避免工具密集的 turn 刷触发。 */
  nudgeMinGapMin: z.number().default(5),
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
    return {
      workspace: typeof snap?.workspace === "string" ? snap.workspace : "",
      windowStart: typeof snap?.windowStart === "string" ? snap.windowStart : "02:00",
      windowEnd: typeof snap?.windowEnd === "string" ? snap.windowEnd : "04:30",
      provider: typeof snap?.provider === "string" ? snap.provider : "",
      model: typeof snap?.model === "string" ? snap.model : "",
      reasoningEffort: typeof snap?.reasoningEffort === "string" ? snap.reasoningEffort : "high",
      stepTimeoutSec: typeof snap?.stepTimeoutSec === "number" && snap.stepTimeoutSec > 0 ? snap.stepTimeoutSec : 0,
      writable: true,
    };
  }

  async setConfig(payload) {
    const patch = {};
    if (typeof payload?.workspace === "string") patch.workspace = payload.workspace;
    if (typeof payload?.windowStart === "string") patch.windowStart = payload.windowStart;
    if (typeof payload?.windowEnd === "string") patch.windowEnd = payload.windowEnd;
    if (typeof payload?.provider === "string") patch.provider = payload.provider;
    if (typeof payload?.model === "string") patch.model = payload.model;
    if (typeof payload?.reasoningEffort === "string") patch.reasoningEffort = payload.reasoningEffort;
    if (typeof payload?.stepTimeoutSec === "number") patch.stepTimeoutSec = payload.stepTimeoutSec > 0 ? payload.stepTimeoutSec : 0;
    if (Object.keys(patch).length === 0) return { ok: true };
    await this.scope.update(patch);
    // 热更新引擎（工作区/窗口/思考等级 + 重排下一次）。
    this.engine.setConfig({
      workspace: patch.workspace,
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
  const memCfg = {
    dbPath: config?.dbPath ?? DEFAULT_DB_PATH,
    enabled: config?.memoryEnabled !== false,
    storeReasoning: config?.storeReasoning === true,
    maxPerTurn: Number(config?.maxPerTurn) > 0 ? Number(config.maxPerTurn) : 2000,
    verbose: config?.memoryVerbose !== false,
  };
  const memLog = memCfg.verbose ? log : { info: () => {}, warn: log.warn, error: log.error };
  try {
    applyMemory(ctx, memCfg, memLog);
  } catch (e) {
    log.error(`记忆模块加载失败（不影响梦境）：${e instanceof Error ? e.message : e}`);
  }

  // ── 记忆注入层（P3）：把 MEMORY.md / USER.md 送进 system prompt ────────
  // 与落库独立：注入失败只影响「我记不记得」，不影响「我记不记」。
  try {
    applyPromptInjection(ctx, log);
  } catch (e) {
    log.error(`记忆注入层加载失败（不影响落库与梦境）：${e instanceof Error ? e.message : e}`);
  }

  // ── nudge（P4）：对话进行中把值得记的抄进 memory/daily ─────────────────
  // 只写 daily，不碰 MEMORY.md / USER.md —— 那两份走梦境那条带门控的慢车道。
  // 任何异常都吞在内部：它是旁路，不该影响对话。
  try {
    applyNudge(ctx, {
      enabled: config?.nudgeEnabled !== false,
      turnThreshold: Number(config?.nudgeTurnThreshold) > 0 ? Number(config.nudgeTurnThreshold) : 10,
      minGapMs: (Number(config?.nudgeMinGapMin) > 0 ? Number(config.nudgeMinGapMin) : 5) * 60 * 1000,
      workspace: config?.workspace?.get?.() ?? config?.workspace ?? "",
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
        case "status":
          return { ok: true, value: { nextWindow: { start: engine.windowStart, end: engine.windowEnd }, workspace: engine.workspace } };
        default:
          throw new Error(`unknown endpoint: ${endpoint}`);
      }
    } catch (e) {
      return { ok: false, error: { code: "ERR", message: e instanceof Error ? e.message : String(e) } };
    }
  }, { authority: "trusted" });
  log.info("梦境数据 RPC 已注册（/dsh-dreaming）");

  // 排程首次梦境（启动后自动计算凌晨窗口内随机时刻）。
  engine.scheduleNext();

  ctx.on("dispose", () => {
    engine.dispose();
    store.close();
  });
  log.info(`梦境引擎已启动（工作区 ${engine.workspace}，窗口 ${engine.windowStart}-${engine.windowEnd}）`);
}


