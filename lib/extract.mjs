/**
 * dsh-fatatalia-memory · lib/extract.mjs
 *
 * 从 `session.log` 提取消息。log 是「全量事件流」，事件类型经 2026-09-29 实测确认
 * （样本 10067 条，会话 gateway-mufaeycc6d7mbr-gw）：
 *
 *   step/start 1543 · assistant/message 1543 · step/end 1543
 *   tool/result 1527 · tool/call 1479 · user/message 763
 *   agent/inbox/spliced 499 · turn/start|end 243 · session/title 242
 *   compaction/summary 59 · system/message 3 · developer/message 3
 *
 * ⚠️ 三种消息事件的**结构不统一**，这是本文件存在的理由：
 *
 *   user/message      → content 在 `data.content`（第一层），**没有 turn/step**
 *   assistant/message → content 在 `data.message.content`（第二层），有 turn/step
 *   tool/result       → content 在 `data.message.content`（第二层），有 turn/step
 *   system/message    → content 在 `data.message.content`
 *   developer/message → content 在 `data.message.content`
 *
 * ⚠️ `assistant/message.content` 混装 `reasoning` / `tool-call` / `text` / `tool-result`
 *    多种 type —— **只有 `type === "text"` 是模型的实际输出**，其余是过程。
 *    默认只取 text（reasoning 体积大且属过程性内容）；需要时用 includeReasoning 打开。
 *
 * ⚠️ `agent.frozenMessages` 在 turn/end 时是 `object{0}` **空对象** —— 不是消息数组，
 *    不要走那条路（2026-09-29 实测否证）。
 */

/**
 * 注入类噪音前缀 —— 这些**不是对话内容**，而是 harness / 插件每轮塞进上下文的元信息。
 * 2026-09-29 实测统计（3923 条库内数据）：
 *
 *   "Time sampled while preparing turn …"                 349 条  harness 每步时间采样
 *   "This is an automatically generated checkpoint …"      64 条  压缩摘要（原文已在库，纯冗余）
 *   "<system-reminder>…"                                   81 条  AGENTS.md / skill 目录注入
 *   "Current runtime context. This snapshot …"             35 条  运行时快照
 *   "<hindsight_knowledge…>…"                              30 条  Hindsight banner（插件已卸，仅存于历史）
 *   "Background subagent …"                                 2 条  子代理通知
 *   ─────────────────────────────────────────────────────────────
 *   合计 559 / 3923 = 14.2%，扣掉后 824 条 user 里只剩约 265 条真人发言。
 *
 * 危害不只是占体积：这些文本**重复且含高频词**，会污染 FTS5 排序 ——
 * 实测拿「教训 / 决定 / 记住」检索，返回的头部全是 `<system-reminder>`。
 */
const INJECTED_NOISE_PREFIXES = [
  "Time sampled while preparing turn",
  "This is an automatically generated checkpoint",
  "<system-reminder>",
  "Current runtime context.",
  "<hindsight_knowledge",
  "Background subagent ",
];

/** 该条内容是否是注入类噪音（应丢弃，不入库）。 */
export function isInjectedNoise(content) {
  if (typeof content !== "string") return false;
  const head = content.slice(0, 80);
  return INJECTED_NOISE_PREFIXES.some((p) => head.startsWith(p) || head.includes(p));
}

/** 从 content 数组里取纯文本。 */
function joinText(content, { includeReasoning = false } = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (includeReasoning && c.type === "reasoning" && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("\n");
}

/**
 * 从 content 数组里抽 `tool-call` 块 → `[{id, name}]`。
 *
 * 为什么单独抽：`joinText` 只要 `type === "text"`，tool-call 块被丢掉 ——
 * 所以 assistant 行的正文里**没有工具名**。而工具名是「哪些消息调过 bash」
 * 这类查询唯一的抓手，必须单独存一列。
 *
 * ⚠️ 不存 `arguments`：它可能有几十 KB，而正文里已经能看出调了什么。
 */
function extractToolCalls(content) {
  if (!Array.isArray(content)) return null;
  const out = [];
  for (const c of content) {
    if (c && typeof c === "object" && c.type === "tool-call" && typeof c.name === "string") {
      out.push({ id: c.id ?? null, name: c.name });
    }
  }
  return out.length ? out : null;
}

/**
 * 从 tool/result 事件里取 callId。
 *
 * 实测（2026-11-20，session-3172cbf2）落盘格式里 message 只有
 * `content/id/role/source`，工具名不在其中 —— 只有一个 callId：
 *   `message.source.callId` 或 `message.content[].toolCallId`
 * 拿到 callId 之后要回查 assistant 消息的 tool-call 块才知道是哪个工具。
 */
function extractToolCallId(m) {
  // 顶层 toolCallId（2026-11 之后的格式有）
  if (typeof m?.toolCallId === "string" && m.toolCallId) return m.toolCallId;
  // source.callId（2026-08 格式靠这个）
  const fromSource = m?.source?.callId;
  if (typeof fromSource === "string" && fromSource) return fromSource;
  if (Array.isArray(m?.content)) {
    for (const c of m.content) {
      if (c && typeof c.toolCallId === "string" && c.toolCallId) return c.toolCallId;
    }
  }
  return null;
}

/** 该事件是否是「可入库的消息」。 */
export function isMessageEvent(type) {
  return type === "user/message" || type === "assistant/message" || type === "tool/result"
      || type === "system/message" || type === "developer/message";
}

/**
 * 从一条 log 事件提取消息。非消息事件返回 null。
 * @param {Map<string,string>|null} toolNameByCallId callId → 工具名（由 extractMessages 预算好）
 * @returns {{seq, role, content, timestamp, turn, step, id, toolCallId, toolName, toolCalls, isError}|null}
 */
export function extractOne(ev, opts = {}, toolNameByCallId = null) {
  if (!ev || typeof ev !== "object") return null;
  const type = ev.type;
  if (!isMessageEvent(type)) return null;
  const d = ev.data ?? {};

  let role, content, id, toolCallId, isError, turn, step, toolName = null, toolCalls = null;

  if (type === "user/message") {
    role = d.role || "user";
    content = joinText(d.content, opts);
    id = d.id;
    turn = typeof d.turn === "number" ? d.turn : null;   // 实测通常没有
    step = typeof d.step === "number" ? d.step : null;
  } else {
    const m = d.message ?? {};
    role = m.role || type.split("/")[0];
    content = joinText(m.content, opts);
    id = m.id;
    toolCallId = extractToolCallId(m);
    isError = m.isError;
    // assistant 行：正文里没有工具名，从 tool-call 块另存一列
    toolCalls = extractToolCalls(m.content);
    // tool/result 行：拿 callId 回查是哪个工具
    if (type === "tool/result" && toolCallId && toolNameByCallId) {
      toolName = toolNameByCallId.get(toolCallId) ?? null;
    }
    turn = typeof d.turn === "number" ? d.turn : null;
    step = typeof d.step === "number" ? d.step : null;
  }

  if (!content || !content.trim()) return null;
  // 注入类噪音不入库（详见文件上方 INJECTED_NOISE_PREFIXES）。
  if (!opts.keepInjected && isInjectedNoise(content)) return null;

  return {
    seq: ev.seq,
    role,
    content,
    timestamp: typeof ev.time === "number" ? ev.time : Date.now(),
    turn, step,
    id: id ?? null,
    toolCallId: toolCallId ?? null,
    toolName: toolName ?? null,
    toolCalls: toolCalls ? JSON.stringify(toolCalls) : null,
    isError: isError === true,
    eventType: type,
  };
}

/**
 * 从整条 log 提取消息（增量友好：`sinceSeq` 之后的事件）。
 * @param {Array} log session.log
 * @param {{sinceSeq?:number, includeReasoning?:boolean}} opts
 */
export function extractMessages(log, opts = {}) {
  const { sinceSeq = -1 } = opts;
  if (!Array.isArray(log)) return [];

  // ⚠️ callId → 工具名的映射必须扫**全量** log，不能只看增量部分：
  //    增量提取时 tool/result 的 seq 大于 sinceSeq，但它对应的 assistant
  //    tool-call 块 seq 更小 —— 只看增量会拿不到工具名。
  const toolNameByCallId = new Map();
  for (const ev of log) {
    if (ev?.type !== "assistant/message") continue;
    const calls = extractToolCalls(ev?.data?.message?.content);
    if (!calls) continue;
    for (const c of calls) if (c.id) toolNameByCallId.set(c.id, c.name);
  }

  const out = [];
  for (const ev of log) {
    if (typeof ev?.seq === "number" && ev.seq <= sinceSeq) continue;
    const m = extractOne(ev, opts, toolNameByCallId);
    if (m) out.push(m);
  }
  return out;
}

/** 统计 log 里的事件类型分布（诊断用）。 */
export function typeHistogram(log) {
  const h = {};
  if (!Array.isArray(log)) return h;
  for (const ev of log) {
    const t = ev?.type ?? "(no-type)";
    h[t] = (h[t] ?? 0) + 1;
  }
  return h;
}
