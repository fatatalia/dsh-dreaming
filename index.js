/**
 * dsh-dreaming — host 半部分
 *
 * 梦境记忆整合：每天凌晨随机窗口触发 Deep 闭环 —— agent 从 Hindsight 只读取材、
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

export const inject = ["typert", "settings", "llm", "agents", "agentDefaultModel", "agentPresets", "sessions", "workspaceRegistry", "connection", "tools"];

/** `dreaming` settings namespace：默认工作区 + 随机窗口。 */
const DreamSchema = z.object({
  workspace: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  provider: z.string(),
  model: z.string(),
  /** turn 级单步超时（秒）：step 超过该时长被 dsh-turn-guard 强制 cancel；不配/0 = 不限制。 */
  stepTimeoutSec: z.number(),
});

// ── Typert wire schemas（宽松 parse，同 imessage 插件） ──────────────────────
function parseObj() {
  return {
    parse(value) {
      if (typeof value !== "object" || value === null) throw new Error("expected object");
      return value;
    },
  };
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
      result: { mode: "strict", typeSymbol: "dsh-dreaming#DreamingConfig", schema: getResultSchema },
    },
    {
      id: "dsh-dreaming#dreaming/listProviders",
      service: "dreaming",
      namespace: "dreaming",
      method: "listProviders",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-dreaming#ProviderList", schema: getResultSchema },
    },
    {
      id: "dsh-dreaming#dreaming/listModels",
      service: "dreaming",
      namespace: "dreaming",
      method: "listModels",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-dreaming#ProviderParam", schema: getResultSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-dreaming#ModelList", schema: getResultSchema },
    },
    {
      id: "dsh-dreaming#dreaming/setConfig",
      service: "dreaming",
      namespace: "dreaming",
      method: "setConfig",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-dreaming#SetPayload", schema: setPayloadSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-dreaming#SetResult", schema: setResultSchema },
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

  /** 指定 provider 的模型列表。 */
  async listModels(payload) {
    const provider = typeof payload?.provider === "string" ? payload.provider : "";
    if (!provider) throw new Error("provider 必填");
    const list = await this.llm?.listModels?.(provider) ?? [];
    return list.map((m) => ({ id: m.id, name: m.name ?? m.id }));
  }

  getConfig() {
    const snap = this.scope.get();
    return {
      workspace: typeof snap?.workspace === "string" ? snap.workspace : "",
      windowStart: typeof snap?.windowStart === "string" ? snap.windowStart : "02:00",
      windowEnd: typeof snap?.windowEnd === "string" ? snap.windowEnd : "04:30",
      provider: typeof snap?.provider === "string" ? snap.provider : "",
      model: typeof snap?.model === "string" ? snap.model : "",
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
    if (typeof payload?.stepTimeoutSec === "number") patch.stepTimeoutSec = payload.stepTimeoutSec > 0 ? payload.stepTimeoutSec : 0;
    if (Object.keys(patch).length === 0) return { ok: true };
    await this.scope.update(patch);
    // 热更新引擎（工作区/窗口 + 重排下一次）。
    this.engine.setConfig({
      workspace: patch.workspace,
      provider: patch.provider,
      model: patch.model,
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

  // settings namespace：默认工作区 = 当前用户 dsh/mayacode，窗口 02:00-04:30。
  const scope = ctx.settings.register("dreaming", DreamSchema, {
    base: {
      workspace: join(homedir(), "dsh", "mayacode"),
      windowStart: "02:00",
      windowEnd: "04:30",
    },
  });

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
    stepTimeoutSec: typeof scope.get()?.stepTimeoutSec === "number" && scope.get()?.stepTimeoutSec > 0 ? scope.get()?.stepTimeoutSec : 0,
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


