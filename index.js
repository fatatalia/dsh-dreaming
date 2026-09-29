/**
 * dsh-dreaming — host 半部分
 *
 * 梦境记忆整合：每天凌晨随机窗口触发 Deep 闭环 —— 引擎从**本地取材**
 * （每日记忆 memory/daily/*.md + 记忆库 ~/.dsh/fatatalia-memory.db 的近期对话）、
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
import { DreamStore } from "./lib/store.mjs";
import { renderDreams } from "./lib/dream-render.mjs";

export const name = "dsh-dreaming";

export const inject = ["typert", "llm", "agents", "agentDefaultModel", "agentPresets", "sessions", "workspaceRegistry", "connection", "tools", "webServer"];

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

  // 0.1.7：配置即插件 Config 的 volatile 字段，这里适配出等价的 scope 外壳。
  // （默认工作区 = 当前用户 dsh/mayacode，窗口 02:00-04:30。）
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


