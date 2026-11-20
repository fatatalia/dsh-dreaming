/**
 * nudge —— 记忆链路的前半段。
 *
 *   原始对话 ──(nudge)──> memory/daily ──(梦境)──> MEMORY / USER
 *              ↑ 本文件                      ↑ dream-engine.mjs
 *
 * 为什么需要它：dream-engine 每晚从 memory/daily 里提炼，但 daily 本身
 * 一直靠主会话"记得写"。三天只有 3 份、四个工作区里三个一份没有 —— 靠自觉
 * 就是这个下场。nudge 补的是这一段。
 *
 * ── 设计约束（都是踩过的坑）────────────────────────────────────────────
 *
 * 1. **绝不在 turn/end 回调里同步 await**。
 *    在回调里直接调 followup 会撞上 session append 重入锁，且重试永不生效
 *    （`~/.dsh/MEMORY.md` 有原案）。这里用 setTimeout(…, 0) 出队。
 *
 * 2. **模型不给任何工具**。
 *    memory-curator preset 是 complete:true 的裸上下文 —— 它只返回 JSON，
 *    写文件由本文件的代码做。这样模型没有能力改别的文件，也不会有
 *    "先 bash ls 看看目录"这种分心。
 *
 * 3. **只写 daily，不碰 MEMORY.md / USER.md**。
 *    那两份走梦境那条慢车道，有门控和预算。nudge 一天能跑十几次，
 *    放它写长期记忆等于把门控绕过去了。
 *
 * 4. **同一会话两次 nudge 至少隔 minGapMs**。
 *    触发阈值是"累计 N 轮"，但如果一个 turn 里模型疯狂调工具，
 *    turn 数涨得比实际内容快。加时间闸防抖。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { extractMessages } from "./extract.mjs";
import {
  composeAgentSetup,
  lastAssistantText,
  localDate,
  extractJsonArray,
} from "./agent-setup.mjs";

/** nudge 专用 preset（声明在 cordis.patch.yml，裸上下文、无工具）。 */
const NUDGE_PRESET = "memory-curator";

/** 默认阈值：累计 10 轮触发一次。 */
const DEFAULT_TURN_THRESHOLD = 10;
/** 两次 nudge 的最小间隔。 */
const DEFAULT_MIN_GAP_MS = 5 * 60 * 1000;
/** 喂给模型的源文本上限（字符）。超了取尾部 —— 最近的对话更有价值。 */
const MAX_SOURCE_CHARS = 8000;
/** 单条笔记长度上限（与 curate.mjs 的 MAX_INSIGHT_CHARS 对齐）。 */
const MAX_NOTE_CHARS = 160;

/** 允许的笔记类型。 */
const NOTE_TYPES = new Set(["lesson", "fact", "rule", "todo"]);

/**
 * 解析模型输出。
 * @returns 数组（可能为空）；解析失败返回 null
 */
function parseNotes(raw) {
  const arr = extractJsonArray(raw);
  if (arr === null) return null;
  return arr
    .filter((x) => x && typeof x.content === "string" && x.content.trim().length > 0)
    .map((x) => ({
      type: NOTE_TYPES.has(x.type) ? x.type : "fact",
      content: String(x.content).trim().replace(/\s+/g, " ").slice(0, MAX_NOTE_CHARS),
    }))
    .slice(0, 3);
}

/** 把消息压成一段可读文本（只保留有实际内容的行）。 */
function renderSource(messages) {
  const lines = [];
  for (const m of messages) {
    const role = m.role === "user" ? "人" : m.role === "assistant" ? "我" : m.role;
    const text = String(m.content ?? "").trim();
    if (text === "") continue;
    // 工具输出通常极长且没营养，截断到 400 字
    const clipped = text.length > 400 ? text.slice(0, 400) + "…" : text;
    lines.push(`${role}：${clipped}`);
  }
  const joined = lines.join("\n\n");
  return joined.length > MAX_SOURCE_CHARS
    ? joined.slice(joined.length - MAX_SOURCE_CHARS)
    : joined;
}

/**
 * 一次 nudge 的完整流程。
 * 任何一步失败都只 warn，绝不抛给上层 —— 它是旁路，不该影响对话。
 */
class NudgeEngine {
  constructor({
    agents,
    agentPresets,
    defaultModel,
    sessions,
    workspaceRegistry,
    log = console,
    // 配置用 getter 传入而不是取值：设置页改了要能立刻生效，不需要重启。
    getConfig = () => ({}),
    fallbackWorkspace = "",
  }) {
    this.agents = agents;
    this.sessions = sessions;
    this.workspaceRegistry = workspaceRegistry;
    this.services = { agentPresets, defaultModel };
    this.log = log;
    this.getConfig = getConfig;
    this.fallbackWorkspace = fallbackWorkspace;
    /** sessionId → { turns, lastSeq, busy, lastFireAt } */
    this.states = new Map();
  }

  stateOf(sessionId) {
    let st = this.states.get(sessionId);
    if (st === undefined) {
      st = { turns: 0, lastSeq: -1, busy: false, lastFireAt: 0 };
      this.states.set(sessionId, st);
    }
    return st;
  }

  /** turn/end 时调用。只记账 + 出队，不做任何 I/O。 */
  observe(session, event) {
    if (event?.type !== "turn/end") return;
    const id = session?.id;
    if (typeof id !== "string") return;

    // 每次现读：设置页关掉 nudge 立刻停，不用重启。
    const cfg = this.getConfig() ?? {};
    if (cfg.enabled === false) return;
    const threshold = Number(cfg.turnThreshold) > 0 ? Number(cfg.turnThreshold) : DEFAULT_TURN_THRESHOLD;
    const minGap = Number(cfg.minGapMs) > 0 ? Number(cfg.minGapMs) : DEFAULT_MIN_GAP_MS;

    // 排除内部会话 —— nudge 自己和梦境都不能再触发 nudge，否则会自我循环。
    const preset = session.header?.agentPreset ?? session.meta?.agentPreset;
    if (typeof preset === "string" && (preset.startsWith("dream-") || preset === NUDGE_PRESET)) return;

    const st = this.stateOf(id);
    st.turns += 1;

    if (st.busy) return;
    if (st.turns < threshold) return;
    if (Date.now() - st.lastFireAt < minGap) return;

    // 立刻重置计数：fire 期间新来的 turn 重新累计，不会叠加成一次巨型 nudge。
    st.turns = 0;
    st.lastFireAt = Date.now();
    st.busy = true;

    setTimeout(() => {
      this.fire(session)
        .catch((e) => this.log?.warn?.(`nudge: 执行失败 ${e instanceof Error ? e.message : e}`))
        .finally(() => { st.busy = false; });
    }, 0);
  }

  async fire(session) {
    const st = this.stateOf(session.id);
    // 会话目录在持久化 header 里，不是 meta（meta 只在 agents.create 建会话时用）。
    // memory.mjs 落库也用 session.header.cwd —— 同一个事实来源。
    const cwd = session.header?.cwd || session.meta?.cwd || this.fallbackWorkspace;
    if (typeof cwd !== "string" || cwd === "") {
      this.log?.warn?.("nudge: 拿不到工作区目录，跳过");
      return;
    }

    const sourceMessages = extractMessages(session.log ?? [], { sinceSeq: st.lastSeq });
    const source = renderSource(sourceMessages);
    // 太短的对话不值得提炼（比如三句话就结束）。
    if (source.length < 200) {
      this.log?.info?.(`nudge: ${session.id} 素材过短（${source.length} 字），跳过`);
      return;
    }

    const today = localDate();
    const dailyPath = join(cwd, "memory", "daily", `${today}.md`);

    // 已存在的标题行，防止模型重复写同一件事
    let existingHeadings = "";
    try {
      const prev = await readFile(dailyPath, "utf8");
      existingHeadings = prev
        .split("\n")
        .filter((l) => l.startsWith("## "))
        .slice(-12)
        .join("\n");
    } catch { /* 文件不存在 = 今天第一次，正常 */ }

    const composition = await composeAgentSetup(this.services, NUDGE_PRESET, {
      reasoningEffort: "low",
    });
    const id = SessionId(`nudge-${Date.now()}-nu`);
    // agentOptions 与 setup 里的 installModelSelection 是两套入口，dream-engine 两个都传，
    // 这里照做 —— 少传一个会让 agent 落在"未选模型"的默认路径上。
    const sel = this.services.defaultModel?.currentSelection?.();
    const agentOptions = sel === undefined
      ? undefined
      : { provider: sel.provider, model: sel.model, reasoningEffort: "low" };

    const created = await this.agents.create({
      sessionId: id,
      meta: { cwd, ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }) },
      ...(agentOptions === undefined ? {} : { agentOptions }),
      setup: composition.setup,
    });
    const agent = created.agent;

    try {
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      const body = [
        "这是一段进行中的对话。把它里面**以后还有用**的东西抄下来。",
        "",
        "对话：",
        source,
        existingHeadings === "" ? "" : `\n今天已经记过这些（别重复）：\n${existingHeadings}`,
      ].filter(Boolean).join("\n");

      agent.followup(createUserMessage({
        content: [{ type: "text", text: body }],
        source: { kind: "user" },
      }));
      await agent.whenIdle();
      await this.sessions.flush(agent.session);

      const raw = lastAssistantText(agent.session.snapshotEvents(), firstSeq).trim();
      const notes = parseNotes(raw);
      if (notes === null) {
        this.log?.warn?.(`nudge: 输出无法解析，前 160 字：${raw.slice(0, 160)}`);
        return;
      }
      if (notes.length === 0) {
        this.log?.info?.(`nudge: ${session.id} 无可记内容`);
        return;
      }

      await this.appendDaily(dailyPath, today, notes);
      this.log?.info?.(`nudge: ${session.id} 沉淀 ${notes.length} 条 → ${dailyPath}`);

      // 推进水位：下次只看这之后的消息
      const lastEvent = Array.isArray(session.log) ? session.log[session.log.length - 1] : undefined;
      if (typeof lastEvent?.seq === "number") st.lastSeq = lastEvent.seq;
    } finally {
      await this.archive(id);
    }
  }

  /** 追加到当天 daily。段首带时间戳与来源标记，方便区分是谁写的。 */
  async appendDaily(dailyPath, today, notes) {
    await mkdir(dirname(dailyPath), { recursive: true });
    const now = new Date();
    const hhmm = now.toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const label = { lesson: "认知", fact: "事实", rule: "规则", todo: "待办" };
    const lines = ["", `## 🔍 ${hhmm} 对话沉淀（nudge）`, ""];
    for (const n of notes) lines.push(`- **${label[n.type] ?? "事实"}**：${n.content}`);
    lines.push("");

    let prefix = "";
    try {
      const prev = await readFile(dailyPath, "utf8");
      if (!prev.endsWith("\n")) prefix = "\n";
    } catch { /* 新文件，不需要补换行 */ }
    await appendFile(dailyPath, prefix + lines.join("\n"), "utf8");
  }

  async archive(sessionId) {
    try {
      if (this.workspaceRegistry) await this.workspaceRegistry.archiveSession(sessionId);
    } catch (e) {
      this.log?.warn?.(`nudge: 归档失败 ${e instanceof Error ? e.message : e}`);
    }
  }

  dispose() {
    this.states.clear();
  }
}

/**
 * 挂载入口。
 * @param ctx 插件上下文
 * @param cfg { enabled?, turnThreshold?, minGapMs? }
 * @param log
 */
export function applyNudge(ctx, cfg, log) {
  // 不在这里判断 enabled —— 判断了就等于「启动时关着，之后永远开不起来」。
  // 挂载照挂，开关在 observe 里每次现读。
  const getConfig = typeof cfg?.getConfig === "function" ? cfg.getConfig : () => ({});

  const agents = ctx.get("agents");
  const agentPresets = ctx.get("agentPresets");
  const defaultModel = ctx.get("defaultModel");
  const sessions = ctx.get("sessions");
  const workspaceRegistry = ctx.get("workspaceRegistry");

  if (agents === undefined || sessions === undefined) {
    log?.warn?.("nudge: 缺 agents/sessions 服务，未挂载");
    return;
  }

  const engine = new NudgeEngine({
    agents,
    agentPresets,
    defaultModel,
    sessions,
    workspaceRegistry,
    log,
    getConfig,
    fallbackWorkspace: typeof cfg?.workspace === "string" ? cfg.workspace : "",
  });

  // 与 memory.mjs 同一写法：直接 ctx.on，不用 ctx.effect 包一层。
  ctx.on("session/event", (session, event) => {
    try {
      engine.observe(session, event);
    } catch (e) {
      log?.warn?.(`nudge: observe 异常 ${e instanceof Error ? e.message : e}`);
    }
  });
  ctx.on("dispose", () => engine.dispose());

  const c0 = getConfig() ?? {};
  log?.info?.(
    c0.enabled === false
      ? "nudge: 已挂载（当前关闭，可在设置页开启）"
      : `nudge: 已挂载（每 ${Number(c0.turnThreshold) > 0 ? c0.turnThreshold : DEFAULT_TURN_THRESHOLD} 轮触发，最小间隔 ${Math.round((Number(c0.minGapMs) > 0 ? c0.minGapMs : DEFAULT_MIN_GAP_MS) / 60000)} 分钟）`,
  );
}
