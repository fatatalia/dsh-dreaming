/**
 * dream-engine.mjs — dsh-dreaming v2 核心（随机定时 + 纯梦叙事 + 信号驱动晋升）
 *
 * v2 改动（2026-08-18，依据 docs/v2-plan.md）：
 *   1. 梦境正文改用 dream-narrative 专用 preset（persona=梦境 prompt，complete:true，
 *      不挂 agent-instructions/工具）→ 裸上下文写梦（对齐 OpenClaw lightContext）
 *   2. 素材由引擎预取注入（**v3 起：多通道取自本地每日记忆 + SQLite**，见下方
 *      RECALL_CHANNELS；v2 时期是 Hindsight 多查询 recall），agent 不再自己 curl
 *   3. 输出纯正文（无 JSON），insight 不再由 LLM 判定
 *   4. 晋升改为信号驱动：多查询命中数（uniqueQueries）+ entities 概念聚类 +
 *      跨天累计（recall_stats 表）+ 量化评分（0.45 候选 / 0.75 晋升）
 *   5. MEMORY.md 预算管理：超限只删带「梦境沉淀」标记的最老段
 *
 * 依赖经构造注入（agents/agentDefaultModel/agentPresets/sessions/workspaceRegistry），
 * 本模块不持有框架状态。
 */
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { readFile, appendFile, writeFile, readdir, rename, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { similarity } from "./store.mjs";

/** 随机触发窗口（本地时间 HH:mm），启动后每次计算当天窗口内随机时刻。 */
const DEFAULT_WINDOW = { start: "02:00", end: "04:30" };
/** 合法思考等级（与 provider 的 reasoningEfforts 映射同名）。 */
export const REASONING_EFFORTS = ["off", "low", "medium", "high", "max"];
/**
 * 规整思考等级：空串/非法 → undefined（= 不显式指定，交 provider 默认）。
 * 2026-09-11 加：此前 selection 不带 reasoningEffort，installModelSelection 又剥掉继承值
 * → 梦境实际由 provider 层 `reasoning: high` 兜底，设置页无从调整。
 */
export function normalizeEffort(value) {
  const v = typeof value === "string" ? value.trim() : "";
  return REASONING_EFFORTS.includes(v) ? ReasoningEffortId(v) : void 0;
}
/** MEMORY.md 默认路径（按工作区 cwd 推导）。 */
const DEFAULT_MEMORY_PATH = () => join(homedir(), "dsh", "mayacode", "MEMORY.md");
/** narrative 专用 agent preset（~/.dsh/.agent-presets/dream-narrative）。 */
const NARRATIVE_PRESET = "dream-narrative";
/** 提炼专用 agent preset（~/.dsh/.agent-presets/dream-insight）——裸上下文、无工具、约 600 token。
 *  2026-10-27 新建：替代 extractInsight() 的「取最长句」，改为 LLM 判定「什么值得记」。
 *  为什么不用 fatatalia preset：它会注入 ~25K token（人格 3K + AGENTS.md 12K + 20 个工具 10K），
 *  且工具会让模型"想做事"而不是老实提炼。 */
const INSIGHT_PRESET = "dream-insight";
/** ★ 2026-09-29 数据源切换：Hindsight recall → 本地（每日记忆 + SQLite）
 *
 * 背景：Hindsight 服务（127.0.0.1:8888）已停用，原 recallToday() 打过去必然返回空，
 * 而「无素材」走的是 log.warn —— 不进 /var/log/dsh-web.log ⇒ 梦境会**静默停摆**。
 *
 * 设计：把原来的「4 个语义查询」换成「4 个取材通道」，每条记录仍带 query 标记，
 * 于是下游 dedupeRecalls() 的 uniqueQueries 信号与 promoteBySignals() 的晋升阈值
 * **一行都不用改** —— 一条内容被 ≥2 个通道命中即满足晋升条件。
 *
 * 通道职责分层（对齐「SQLite = 完整档案 / 每日记忆 = 当日工作台」的新架构）：
 *   每日记忆  → 高信号素材（人读过的、筛过的），score 0.9
 *   SQLite    → 兜底补漏（原始对话，未筛过），score 0.6–0.75
 */
const RECALL_CHANNELS = [
  { name: "今日记忆", kind: "daily", daysBack: 0 },
  { name: "昨日记忆", kind: "daily", daysBack: 1 },
  // 2026-10-27 加：晋升改为「只认 daily」后素材池缩到 1 天太小，
  // 梦境跑在凌晨 2:00–4:30 时「今天」的 daily 还没生成，实际只有昨天一天，
  // 扩到 3 天窗口（与 daily 保留 3 天的策略一致）。
  { name: "前日记忆", kind: "daily", daysBack: 2 },
  { name: "三日记忆", kind: "daily", daysBack: 3 },
  { name: "近期对话", kind: "messages", hours: 24 },
  { name: "关键线索", kind: "keyword", hours: 72 },
];
/** 「关键线索」通道的内容过滤（捞决策/教训这类高价值句子）。 */
const KEYWORD_PATTERN = /决定|方案|结论|教训|注意|记住|坑|修复|改掉/;
/** 记忆库路径（与 dsh-fatatalia-memory 插件共用）。 */
const MEMORY_DB_PATH = () => join(homedir(), ".dsh", "fatatalia-memory.db");
/** 每日记忆目录。 */
const DAILY_DIR = () => join(homedir(), "dsh", "mayacode", "memory", "daily");
const RECALL_LIMIT_PER_CHANNEL = 12;
/** 每日记忆文件保留天数（2026-09-29 由 7 收紧为 3：细节层职责已交给记忆库）。 */
const DAILY_RETENTION_DAYS = 3;
/** 碎片注入上限（对齐 OpenClaw snippets ≤12）。 */
const FRAGMENT_CAP = 12;
const FRAGMENT_MAX_CHARS = 280;
/**
 * 连续性上下文：把最近 N 篇旧梦回灌给 narrative（对齐 OpenClaw RECENT_DIARY_CONTEXT_LIMIT=3）。
 * 2026-10-14 加：此前每篇梦境都是孤立生成的，它看不到自己昨天写过什么，
 * 于是每次都重新发明同一套手法（服务器嗡鸣 + 十六进制颜色 + 末尾顿悟），
 * 八篇读起来像一个模子。回灌旧梦 + 明确要求换角度，是压掉这种"模板感"的关键。
 */
const RECENT_DREAM_CONTEXT_LIMIT = 3;
/** 单篇旧梦回灌的截断长度（保留开头——梦境的开头最有辨识度）。 */
const RECENT_DREAM_MAX_CHARS = 400;
/** 回灌的"沉淀记忆"条数与单条长度上限。 */
const RECENT_PROMOTION_LIMIT = 3;
const RECENT_PROMOTION_MAX_CHARS = 160;
/** 晋升上限（每晚最多写几条）。
 *  ⚠️ 2026-10-27 删除了 CANDIDATE_CONFIDENCE(0.45) 与 PROMOTION_MIN_RECALL_COUNT(2)：
 *  它们随 v2「信号驱动」一起废弃 —— 那套评分依赖「当晚通道命中数」，而通道语义
 *  在 9-29 从「语义查询」变成「取材来源」后，该信号恒为 1，门槛永远过不了。
 *  现在由 LLM 直接判定「什么值得记」，阈值交给 persona 里的判断标准。 */
const PROMOTION_MAX_PER_NIGHT = 5;
const DEDUPE_THRESHOLD = 0.85;
/** 提炼时注入给 LLM 的「已有沉淀」条数（新→旧）。
 *  语义去重靠它，不靠 DEDUPE_THRESHOLD —— 后者是字符级 Dice 系数，拦不住同义改写。 */
const EXISTING_PROMOTION_LIMIT = 60;
/** MEMORY.md 预算（字节）。2026-08-18：归档后手写体量约 120KB → 预算 128KB（>手写量+晋升余量，晋升段可留存；膨胀到 128KB 起才开始回收最老晋升段）。 */
const DEFAULT_MEMORY_BUDGET_BYTES = 128 * 1024;
/** MEMORY.md 晋升段标记（预算回收只删这种段）。 */
const PROMOTION_SECTION_MARK = "— 梦境沉淀（dsh-dreaming）";

/** 从事件取给定区间最后一条纯文本 assistant 回复。 */
function lastAssistantText(events, firstSeq) {
  let text = "";
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data.message.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
  }
  return text;
}

/** 解析 凌晨窗口 "HH:mm" → 当天该时刻的 Date。 */
function windowTimeToDate(dateStr, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(dateStr);
  d.setHours(h, m, 0, 0);
  return d;
}

/** 本地日期 YYYY-MM-DD（Asia/Shanghai）。 */
function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

/**
 * 剥离记忆 text 里的元数据字段（| When: … | Involving: … |）。
 *
 * 2026-08-25 引入：Hindsight recall 返回的 text 混有元数据，直接晋升会泄漏进 MEMORY.md
 * （如「| When: 2026-08-19 | Involving: 助手 | 保留时间线…」）。
 *
 * ⚠️ 2026-09-29 起数据源已换成本地（每日记忆 + SQLite），产出中不再有这类元数据，
 * **引擎主流程已不再调用本函数** —— 但 `test/v2-unit.test.mjs` 仍在测它，故保留。
 */
function stripMeta(text) {
  return text
    .replace(/\s*\|\s*(When|Involving)\s*:[^|\n]*?(?=\s*\||\s*$)/g, " ")
    .replace(/\s*\|\s*无(?=\s*\||\s*$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** N 天前的本地日期 YYYY-MM-DD（Asia/Shanghai）。 */
function localDateOffset(daysBack) {
  const d = new Date(Date.now() - daysBack * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

/** 通道 1/2：每日记忆文件 → 高信号素材（按 `## ` 标题切段）。 */
async function fromDaily(ch) {
  const day = localDateOffset(ch.daysBack);
  const file = join(DAILY_DIR(), `${day}.md`);
  let raw;
  try { raw = await readFile(file, "utf8"); } catch { return []; }
  if (!raw || raw.length < 60) return [];
  const paras = raw.split(/\n(?=## )/).map((s) => s.trim()).filter((s) => s.length > 60);
  return paras.slice(-RECALL_LIMIT_PER_CHANNEL).map((s, i) => ({
    id: `daily:${day}:${i}`,
    text: s.slice(0, 1500),
    entities: [...s.matchAll(/^#+\s*(.+)$/gm)].map((m) => m[1].trim()).slice(0, 6),
    score: 0.9,           // 人读过的、筛过的 → 最高信号
    day,
    query: ch.name,
  }));
}

/** node:sqlite 惰性加载（Node 24 内置）。加载失败返回 null，不抛。 */
let _sqliteModule;
async function getSqlite() {
  if (_sqliteModule === undefined) {
    try { _sqliteModule = await import("node:sqlite"); }
    catch { _sqliteModule = null; }
  }
  return _sqliteModule;
}

/** 打开记忆库（只读）。打不开就返回 null，不抛。 */
async function openMemoryDb() {
  const mod = await getSqlite();
  if (!mod?.DatabaseSync) return null;
  try { return new mod.DatabaseSync(MEMORY_DB_PATH(), { readOnly: true }); }
  catch { return null; }
}

/** 通道 3：SQLite 近 N 小时的真实对话（user + assistant，剔除工具输出）。 */
async function fromMessages(ch) {
  const db = await openMemoryDb();
  if (!db) return [];
  try {
    const since = Date.now() - ch.hours * 3600000;
    const rows = db.prepare(
      `SELECT id, role, content, timestamp FROM messages
       WHERE timestamp >= ? AND role IN ('user','assistant')
       ORDER BY timestamp DESC LIMIT ?`
    ).all(since, RECALL_LIMIT_PER_CHANNEL * 4);
    return rows.map((r) => ({
      id: `msg:${r.id}`,
      text: String(r.content ?? "").slice(0, 1500),
      entities: [],
      score: r.role === "user" ? 0.75 : 0.6,
      day: new Date(Number(r.timestamp)).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
      query: ch.name,
    })).filter((r) => r.text.trim());
  } catch { return []; } finally { try { db.close(); } catch {} }
}

/** 通道 4：SQLite 近 N 小时含「决策/教训」关键词的内容 → 捞高价值线索。 */
async function fromKeyword(ch) {
  const db = await openMemoryDb();
  if (!db) return [];
  try {
    const since = Date.now() - ch.hours * 3600000;
    const rows = db.prepare(
      `SELECT id, role, content, timestamp FROM messages
       WHERE timestamp >= ? AND role IN ('user','assistant') AND LENGTH(content) > 80
       ORDER BY timestamp DESC LIMIT 400`
    ).all(since);
    const out = [];
    for (const r of rows) {
      const text = String(r.content ?? "");
      if (!KEYWORD_PATTERN.test(text)) continue;
      out.push({
        id: `kw:${r.id}`,
        text: text.slice(0, 1500),
        entities: [],
        score: 0.7,
        day: new Date(Number(r.timestamp)).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }),
        query: ch.name,
      });
      if (out.length >= RECALL_LIMIT_PER_CHANNEL) break;
    }
    return out;
  } catch { return []; } finally { try { db.close(); } catch {} }
}

/**
 * v3（2026-09-29）：多通道取材 → 原始记录（后续 dedupe）。
 * 取代 v2 的 Hindsight 多查询 recall。**失败一律 info，不用 warn**
 * —— warn 不进 /var/log/dsh-web.log，曾因此让梦境静默停摆无从察觉。
 * @returns {Promise<Array>} 原始命中记录
 */
async function recallToday(log) {
  const results = [];
  for (const ch of RECALL_CHANNELS) {
    try {
      let got = [];
      if (ch.kind === "daily") got = await fromDaily(ch);
      else if (ch.kind === "messages") got = await fromMessages(ch);
      else if (ch.kind === "keyword") got = await fromKeyword(ch);
      log?.info?.(`dreaming: 取材通道「${ch.name}」→ ${got.length} 条`);
      results.push(...got);
    } catch (e) {
      log?.info?.(`dreaming: 取材通道「${ch.name}」失败 ${e instanceof Error ? e.message : e}`);
    }
  }
  return results;
}

/** 去重：同 id 保留；不同 id 但文本相似（≥DEDUPE）合并为一次命中，记下被多少不同查询命中。 */
function dedupeRecalls(records) {
  const byId = new Map(); // id -> record
  const merged = [];
  for (const r of records) {
    const existing = byId.get(r.id);
    if (existing) {
      if (!existing.querySet.has(r.query)) existing.querySet.add(r.query);
      existing.score = Math.max(existing.score, r.score);
      continue;
    }
    const rec = { ...r, querySet: new Set([r.query]), queryCount: 1 };
    byId.set(r.id, rec);
    merged.push(rec);
  }
  const out = [];
  for (const rec of merged) {
    // 相似文本合并（不同 id）：与已有输出条目相似则并入
    let hit = out.find((o) => similarity(o.text.slice(0, 80), rec.text.slice(0, 80)) >= DEDUPE_THRESHOLD);
    if (hit) {
      hit.querySet = new Set([...hit.querySet, ...rec.querySet]);
      hit.score = Math.max(hit.score, rec.score);
      continue;
    }
    out.push({ ...rec, recallCount: rec.querySet.size, uniqueQueries: rec.querySet.size });
  }
  return out;
}

/** 提取碎片文本（≤FRAGMENT_MAX_CHARS），供注入 narrative。 */
function toFragment(rec) {
  const t = rec.text.length > FRAGMENT_MAX_CHARS ? rec.text.slice(0, FRAGMENT_MAX_CHARS) + "…" : rec.text;
  return { ...rec, snippet: t };
}

/** 从一条记忆文本里提取"一句话洞察"（规则截取：首句/最长句 ≤120 字）。
 *
 *  ⚠️ 2026-10-27 起不再用于晋升主路径（晋升改用 LLM 提炼，见 extractInsightsByLlm）。
 *  保留它是因为两个理由：① 历史晋升记录是按这个逻辑产生的，排查时还要对照；
 *  ② 极端情况下（LLM 提炼长期失败）可能需要临时回退。
 *  它的致命缺陷：按「句子长度」排序取最长句 —— 而「我做了什么」天然比「我学到了什么」
 *  更长（带路径、文件名、状态），所以它挑出来的几乎必然是动作流水。 */
function extractInsight(text) {
  const sentences = text.split(/[。！？!?；;]/).map((s) => s.trim()).filter((s) => s.length >= 8);
  if (sentences.length === 0) return text.slice(0, 120);
  sentences.sort((a, b) => b.length - a.length);
  let best = sentences[0];
  if (best.length > 120) best = best.slice(0, 120) + "…";
  return best;
}

/**
 * 解析 LLM 提炼输出（2026-10-27 加）。
 *
 * 约定：模型返回严格 JSON 数组 `[{"type":"lesson","content":"..."}]`。
 * 但模型偶尔会包代码块、加前后缀解释，所以做三件事：
 *   1. 剥掉 ```json 围栏
 *   2. 取第一个 `[` 到最后一个 `]` 之间的内容（容忍前后废话）
 *   3. 校验每项：type 只认 lesson/fact/rule，content 非空、截到 120 字
 *
 * 返回值语义（这个区分很重要）：
 *   - **数组** → 解析成功（含空数组，表示「真的没有值得记的」）
 *   - **null** → 解析失败（格式错乱 / JSON 语法错）⇒ 调用方应视为「本轮失败」
 * 把「格式错」和「真空」混为一谈，就永远分不清「今晚没料」和「今晚模型抽风了」。
 */
function parseInsights(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  let arr;
  try {
    arr = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const ALLOWED = new Set(["lesson", "fact", "rule"]);
  return arr
    .filter((x) => x && typeof x.content === "string" && x.content.trim().length > 0)
    .map((x) => ({
      type: ALLOWED.has(x.type) ? x.type : "lesson",
      content: String(x.content).trim().replace(/\s+/g, " ").slice(0, 120),
    }))
    .slice(0, 3);
}

export class DreamEngine {
  constructor({
    agents, defaultModel, sessions, agentPresets, workspaceRegistry,
    store, log = console, memoryPath = DEFAULT_MEMORY_PATH(),
    windowStart = DEFAULT_WINDOW.start, windowEnd = DEFAULT_WINDOW.end,
    workspace, provider = "", model = "", stepTimeoutSec = 0,
    reasoningEffort = "high", llm,
  }) {
    this.agents = agents;
    this.defaultModel = defaultModel;
    this.sessions = sessions;
    this.agentPresets = agentPresets;
    this.workspaceRegistry = workspaceRegistry;
    this.store = store;
    this.log = log;
    this.llm = llm;
    this.memoryPath = memoryPath;
    this.windowStart = windowStart;
    this.windowEnd = windowEnd;
    this.workspace = workspace || join(homedir(), "dsh", "default");
    this.provider = provider; // 配置指定 provider（空 = 全局默认）
    this.model = model; // 配置指定模型（空 = 全局默认）
    this.stepTimeoutSec = Number(stepTimeoutSec) > 0 ? Number(stepTimeoutSec) : 0; // turn 级单步超时（dsh-turn-guard 读取）
    this.reasoningEffort = typeof reasoningEffort === "string" ? reasoningEffort : "high"; // 空串 = 跟随 provider 默认
    this.budgetBytes = DEFAULT_MEMORY_BUDGET_BYTES;
    this._timer = null;
  }

  /** 热更新配置（设置页保存后调用）：工作区 + 模型 + 随机窗口 + 思考等级，并重排下一次。 */
  setConfig({ workspace, provider, model, windowStart, windowEnd, stepTimeoutSec, reasoningEffort } = {}) {
    if (typeof workspace === "string" && workspace.trim()) this.workspace = workspace.trim();
    if (typeof provider === "string") this.provider = provider;
    if (typeof model === "string") this.model = model;
    if (typeof windowStart === "string" && /^\d{2}:\d{2}$/.test(windowStart)) this.windowStart = windowStart;
    if (typeof windowEnd === "string" && /^\d{2}:\d{2}$/.test(windowEnd)) this.windowEnd = windowEnd;
    if (stepTimeoutSec !== undefined) this.stepTimeoutSec = Number(stepTimeoutSec) > 0 ? Number(stepTimeoutSec) : 0;
    if (typeof reasoningEffort === "string") this.reasoningEffort = reasoningEffort;
    this.log?.info?.(`dreaming: 配置更新 workspace=${this.workspace} provider=${this.provider || "(全局默认)"} model=${this.model || "(全局默认)"} 窗口=${this.windowStart}-${this.windowEnd} 思考等级=${this.reasoningEffort || "(provider 默认)"} stepTimeoutSec=${this.stepTimeoutSec || "不限"}`);
    this.scheduleNext();
  }

  /**
   * 解析本次实际可用的思考等级：配置值 → 该 route 支持的等级之一。
   * 不支持或模型无推理能力时退回 undefined（= 不显式指定，走 provider 默认），
   * 避免把 UNSUPPORTED_REASONING_EFFORT 抛进每次梦境。
   */
  async resolveEffort(provider, model) {
    const effort = normalizeEffort(this.reasoningEffort);
    if (effort === void 0) return void 0;
    const llm = this.llm;
    if (typeof llm?.resolveModelInfo !== "function") return effort; // 无能力查询：照发（旧行为）
    try {
      const info = await llm.resolveModelInfo(provider, model);
      const reasoning = info?.reasoning;
      if (reasoning === void 0) return void 0; // 该模型无推理能力
      if (reasoning.efforts.some((e) => e.id === effort)) return effort;
      this.log?.warn?.(`dreaming: 模型 ${provider}/${model} 不支持思考等级 ${effort}，本次改用 provider 默认`);
      return void 0;
    } catch (e) {
      this.log?.warn?.(`dreaming: 查询 ${provider}/${model} 思考等级失败（按配置照发）: ${e instanceof Error ? e.message : e}`);
      return effort;
    }
  }

  /** 依据 agent-presets 组合出 web 兼容的 agent setup（override 空则全局默认）。 */
  async composeSetup(presetId, override) {
    const presets = this.agentPresets;
    const baseSel = this.defaultModel.currentSelection();
    const effort = normalizeEffort(override?.reasoningEffort);
    const selection = override
      ? {
          provider: override.provider || baseSel.provider,
          model: override.model || baseSel.model,
          // 显式指定的等级随 selection 一起下传（installModelSelection 会剥掉继承值，
          // 只认这里的 reasoningEffort）；空值 = 不指定 → provider 默认。
          ...(effort === void 0 ? {} : { reasoningEffort: effort }),
        }
      : baseSel;
    if (presets === void 0) {
      return {
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: void 0 });
          return Promise.resolve();
        },
      };
    }
    const resolvedId = (await presets.resolve(presetId)).id;
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: void 0 });
        await presets.mount(agentCtx, resolvedId);
      },
    };
  }

  /**
   * 排程下一次梦境：计算"最近一个凌晨窗口内的随机时刻"，到点触发。
   * 启动时调用；每次触发后自动排下一次。跨重启：错过窗口则排明天。
   */
  scheduleNext() {
    if (this._timer !== null) { clearTimeout(this._timer); this._timer = null; }
    const now = new Date();
    let day = localDate();

    // 今天窗口内已执行过（store 已有当天梦境记录）→ 直接排明天，避免连环触发
    const todayRecorded = this.store.listDreams(1, day).length > 0;

    let start = windowTimeToDate(day, this.windowStart);
    let end = windowTimeToDate(day, this.windowEnd);
    if (end <= now || todayRecorded) {
      const tomorrow = new Date(day + "T00:00:00");
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tLocal = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000);
      day = tLocal.toISOString().slice(0, 10);
      start = windowTimeToDate(day, this.windowStart);
      end = windowTimeToDate(day, this.windowEnd);
    }
    let fireAt = new Date(start.getTime() + Math.floor(Math.random() * (end.getTime() - start.getTime())));
    if (fireAt.getTime() <= now.getTime()) {
      fireAt = new Date(end.getTime() - 1);
      if (fireAt.getTime() <= now.getTime()) {
        fireAt = new Date(now.getTime() + 60000);
      }
    }
    const delay = fireAt.getTime() - now.getTime();
    this.log?.info?.(`dreaming: 下次梦境排程于 ${fireAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（${Math.round(delay / 60000)} 分钟后）`);
    this._timer = setTimeout(() => {
      this.runOnce().catch((e) => this.log?.error?.(`dreaming: 执行失败 ${e instanceof Error ? e.message : e}`));
    }, delay);
  }

  dispose() {
    if (this._timer !== null) { clearTimeout(this._timer); this._timer = null; }
  }

  /** v2：素材准备——由外部传入 recall 原始记录 → 去重 → 碎片化 → 更新 recall_stats。 */
  async prepareFragments(records) {
    const deduped = dedupeRecalls(records);
    // 排序：今日/近日优先 + 得分高优先
    //
    // ⚠️ 2026-10-27 记：这里「daily 被今日对话挤掉名额」是**有意为之，不是 bug**。
    //   fromMessages 的 day = 消息时间戳 ⇒ 当天对话 aday=1；fromDaily 的 day 是
    //   10-25/10-26 ⇒ aday=0。所以 slice(0,12) 经常全被对话占满，daily 一段不进。
    //   代码东的判断（原话）：梦是碎片重组，「而不是规则整理过后的内容」；
    //   daily 是人按时间整理过的日志，塞进梦里只会让梦变成一天的时间线复述。
    //   ⇒ 不要为了「让 daily 也进梦」改这里的排序或配额。
    //   （晋升不受此处影响：promoteBySignals 走 allRecords，见调用点传入
    //     dedupeRecalls(records) 全量，未经 FRAGMENT_CAP 截断。）
    const today = localDate();
    deduped.sort((a, b) => {
      const aday = a.day === today ? 1 : a.day ? 0 : -1;
      const bday = b.day === today ? 1 : b.day ? 0 : -1;
      if (aday !== bday) return bday - aday;
      return b.score - a.score;
    });
    const fragments = deduped.slice(0, FRAGMENT_CAP).map(toFragment);

    // 更新 recall_stats（跨天信号：recallCount / uniqueQueries）
    for (const rec of deduped.slice(0, 60)) {
      try {
        this.store.touchRecall({
          hash: rec.id,
          snippet: rec.text.slice(0, 200),
          query: rec.querySet?.size > 0 ? [...rec.querySet][0] : rec.query,
          day: localDate(),
        });
      } catch (e) {
        this.log?.warn?.(`dreaming: recall_stats 更新失败 ${e instanceof Error ? e.message : e}`);
      }
    }
    return fragments;
  }

  /** 执行一次梦境闭环（v2 流程：素材 → 纯梦叙事 → 信号晋升 → 预算写回）。 */
  async runOnce() {
    const id = SessionId(`dreaming-${Date.now()}-dr`);
    this.log?.info?.(`dreaming: 开始 ${id}`);
    const selection = this.defaultModel.currentSelection();
    const provider = this.provider || selection.provider;
    const model = this.model || selection.model;
    const reasoningEffort = await this.resolveEffort(provider, model);
    const agentOptions = { provider, model, ...(reasoningEffort === void 0 ? {} : { reasoningEffort }) };
    this.log?.info?.(`dreaming: ${id} 模型 ${provider}/${model} 思考等级=${reasoningEffort ?? "(provider 默认)"}`);
    try {
      // 1. 素材准备（引擎侧，注入而非 agent 自取）——只查一次，供写梦与晋升共用
      const records = await recallToday(this.log);
      const fragments = await this.prepareFragments(records);
      if (fragments.length === 0) {
        this.log?.info?.(`dreaming: ${id} 无素材（四个取材通道均无内容），跳过本次`);
        return;
      }
      // 碎片不带日期（2026-10-14 改）：时间线一旦精确到"今天/昨天"，梦就退化成日志。
      // 排序仍按"今日优先"，但那只影响顺序，不把日期写进素材。
      const fragmentsText = fragments
        .map((f, i) => `[${i + 1}] ${f.snippet}`)
        .join("\n");

      // 1.5 连续性上下文（2026-10-14 加）：读最近 N 篇旧梦 + 近期沉淀，一并回灌 narrative。
      // 读失败不阻断做梦——连续性上下文是加分项，不是必需项。
      let recentEntries = [];
      let recentPromotions = [];
      try {
        recentEntries = this.store
          .listDreams(RECENT_DREAM_CONTEXT_LIMIT)
          .map((row) => clampDreamContext(row.content))
          .filter((text) => text.length > 0)
          .reverse(); // listDreams 是"新→旧"，反转为"旧→新"，阅读顺序自然
        recentPromotions = this.store
          .listPromotions(RECENT_PROMOTION_LIMIT)
          .map((row) => String(row.content || "").replace(/\s+/g, " ").trim().slice(0, RECENT_PROMOTION_MAX_CHARS))
          .filter((text) => text.length > 0);
      } catch (e) {
        this.log?.warn?.(`dreaming: 连续性上下文读取失败 ${e instanceof Error ? e.message : e}`);
      }

      // 2. 纯梦叙事：dream-narrative 预设（裸上下文），user message 只含碎片
      const composition = await this.composeSetup(NARRATIVE_PRESET, { provider, model, reasoningEffort: this.reasoningEffort });
      const created = await this.agents.create({
        sessionId: id,
        meta: { cwd: this.workspace, ...(composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }) },
        agentOptions,
        setup: composition.setup,
      });
      const agent = created.agent;
      // turn 级单步超时配置（dsh-turn-guard 读取）：从引擎配置读 stepTimeoutSec，
      // 挂到 agent 上的通用扩展容器 __pluginConfig。0/不配 → 不挂（turn-guard 不干预）。
      if (agent && !agent.__pluginConfig) {
        try {
          Object.defineProperty(agent, "__pluginConfig", {
            enumerable: false,
            writable: true,
            configurable: true,
            value: {},
          });
        } catch (e) {
          this.log?.warn?.(`dreaming: 初始化 __pluginConfig 失败: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (agent?.__pluginConfig) {
        if (this.stepTimeoutSec > 0) agent.__pluginConfig.turnGuard = { stepSec: this.stepTimeoutSec };
        else delete agent.__pluginConfig.turnGuard;
      }
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(createUserMessage({
        content: [{ type: "text", text: buildNarrativeMessage(fragmentsText, recentEntries, recentPromotions) }],
        source: { kind: "user" },
      }));
      await agent.whenIdle();
      await this.sessions.flush(agent.session);
      const dreamText = lastAssistantText(agent.session.snapshotEvents(), firstSeq).trim();
      this.log?.info?.(`dreaming: ${id} narrative 回复 ${dreamText.length} 字符`);

      // 3. 落库梦境（纯正文）
      const date = localDate();
      const dreamId = this.store.addDream({ date, content: dreamText || "(空)" });

      // 4. 信号驱动晋升（规则，无 LLM 判定）——复用同一批 recall 记录
      const promotions = await this.promoteBySignals(fragments, dedupeRecalls(records), date);
      const saved = [];
      for (const p of promotions.slice(0, PROMOTION_MAX_PER_NIGHT)) {
        const pid = this.store.addPromotion({
          dreamId,
          content: p.content,
          target: "MEMORY.md",
          evidence: p.evidence,
          rule: p.rule,
        });
        saved.push({ ...p, id: pid });
      }
      if (saved.length > 0) {
        // 5. 预算写回 MEMORY.md
        await this.appendPromotionsToMemory(date, dreamId, saved);
      }
      this.log?.info?.(`dreaming: ${id} 梦境 #${dreamId} 已存，晋升 ${saved.length} 条`);
    } catch (e) {
      this.log?.error?.(`dreaming: 执行失败 ${e instanceof Error ? e.message : e}`);
    } finally {
      await this.attachWorkspace(id);
      await this.archiveDailyMemory();
      await this.archive(id);
      this.scheduleNext();
    }
  }

  /**
   * 归档超过 DAILY_RETENTION_DAYS 天的每日记忆文件（memory/daily/YYYY-MM-DD.md → memory/archive/）。
   *
   * ★ 2026-09-29 由 7 天收紧为 3 天。原因：记忆库（~/.dsh/fatatalia-memory.db）已保存
   * **全部原始对话**，每日文件的「细节层 / 7 天回溯」职责被它取代 —— 再留 7 天是重复存储。
   * 每日文件现在的定位是**当日工作台**（人读的高信号摘要），梦境提炼完即可退场；
   * 留 3 天纯属安全垫（万一梦境连续抽风，还有得回捞）。
   */
  async archiveDailyMemory() {
    const dailyDir = join(this.workspace, "memory", "daily");
    const archiveDir = join(this.workspace, "memory", "archive");
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DAILY_RETENTION_DAYS);
    try {
      const files = await readdir(dailyDir);
      for (const f of files) {
        const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f);
        if (!m) continue;
        const d = new Date(`${m[1]}T00:00:00`);
        if (Number.isNaN(d.getTime()) || d >= cutoff) continue;
        await mkdir(archiveDir, { recursive: true });
        await rename(join(dailyDir, f), join(archiveDir, f));
        this.log?.info?.(`dreaming: 归档每日记忆 ${f} → memory/archive/`);
      }
    } catch (e) {
      // 必须是 info：log.warn 不进 /var/log/dsh-web.log（2026-09-29 教训）。
      this.log?.info?.(`dreaming: 归档每日记忆失败 ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * 2026-10-27 重写：LLM 提炼驱动的晋升（原名 promoteBySignals，v2 信号驱动已废弃）。
   *
   * 旧实现的两个致命问题（2026-10-26 排查确认）：
   *   ① 门槛读的是 rec.recallCount ——「当晚 4 个通道里有几个同时命中」；
   *      而 9-29 Hindsight 移除后「通道」从「4 个语义查询」变成「4 个取材来源」，
   *      数据源互斥 ⇒ 同一条内容几乎不可能跨 2 个通道 ⇒ 门槛永远过不了 ⇒ 9-26 起零晋升。
   *   ② 即使过了门槛，extractInsight() 也是按「句子长度」取最长句，
   *      而动作句天然比认知句长 ⇒ 晋升出来的全是「助手更新了 X 文件」。
   *
   * 新实现：
   *   ① 只认 daily（人筛过的工作台）—— 原始对话只喂梦，不参与晋升；
   *   ② 提炼交给 dream-insight preset 的 LLM，判断标准写进它的 persona；
   *   ③ LLM 提炼失败（null）⇒ 跳过晋升，不降级 —— 「缺证据不是通过」。
   */
  async promoteBySignals(fragments, allRecords, date) {
    // ① 晋升只认 daily。msg:/keyword 通道只用于写梦（梦需要原始素材），不参与晋升。
    //
    // ⚠️ 必须从 allRecords 取，不能用 fragments —— fragments 已被 FRAGMENT_CAP(=12) 截断，
    // 而排序把「今天」的记录排最前，fromMessages 的 day 恰好也是今天（消息时间戳的日期），
    // 于是 48 条今日对话挤满前 12 个名额，daily 碎片一条都进不来。
    // 2026-10-27 实测：通道日志「昨日 2 条 / 前日 9 条」，晋升却报「无 daily 素材」。
    const dailyRecords = allRecords.filter((rec) => typeof rec.id === "string" && rec.id.startsWith("daily:"));
    if (dailyRecords.length === 0) {
      this.log?.info?.("dreaming: 无 daily 素材可晋升（本次跳过晋升，梦境照常落库）");
      return [];
    }

    // ② LLM 提炼：只喂 daily 素材（自己限长，不依赖 fragments 的 snippet）
    const fragmentsText = dailyRecords
      .map((rec, i) => {
        const t = rec.text.length > FRAGMENT_MAX_CHARS ? rec.text.slice(0, FRAGMENT_MAX_CHARS) + "…" : rec.text;
        return `[${i + 1}] ${t}`;
      })
      .join("\n");
    const insights = await this.extractInsightsByLlm(fragmentsText);
    if (insights === null) {
      this.log?.warn?.("dreaming: LLM 提炼失败（返回 null），本轮跳过晋升 —— 不降级到规则截取");
      return [];
    }
    if (insights.length === 0) {
      this.log?.info?.("dreaming: LLM 提炼结果为空（确实没有值得记的），本轮无晋升");
      return [];
    }

    // ③ 去重 + 组装
    const picked = [];
    for (const ins of insights) {
      const dup = this.store.findPromotionSimilar(ins.content, DEDUPE_THRESHOLD);
      if (dup) {
        this.log?.info?.(`dreaming: 提炼项与已有沉淀重复，跳过：${ins.content.slice(0, 30)}…`);
        continue;
      }
      picked.push({
        content: ins.content,
        type: ins.type,
        rule: `llm-${ins.type}`,
        evidence: `LLM提炼 type=${ins.type} 素材=${dailyRecords.length}段(daily)`,
      });
      if (picked.length >= PROMOTION_MAX_PER_NIGHT) break;
    }
    return picked;
  }

  /**
   * LLM 提炼（2026-10-27 加）：用 dream-insight preset 从 daily 碎片里挑出可复用的认知。
   *
   * 为什么不复用写梦的 agent：dream-narrative 的 persona 就是「你在写一篇梦境日记」，
   * 且是 complete:true 的裸上下文。在同一个 agent 里追加「顺便提炼三条认知」，
   * 它会用梦的语法回答 —— 场景乱跳、数字变形。
   *
   * 返回值：数组（含空数组，表示真的没有）/ null（失败，调用方跳过晋升）。
   * 思考等级用 medium：提炼是分类判断，不需要 high 的长推理，省一半 token。
   */
  async extractInsightsByLlm(fragmentsText) {
    const id = SessionId(`dreaming-${Date.now()}-ins`);
    const selection = this.defaultModel.currentSelection();
    const provider = this.provider || selection.provider;
    const model = this.model || selection.model;
    const agentOptions = { provider, model, reasoningEffort: "medium" };
    try {
      // 2026-10-27 加：把已沉淀的认知一并喂给 LLM，让它自己避开语义重复。
      //
      // 为什么不能靠 findPromotionSimilar：它用的是字符级 Dice 系数（bigram 重合率），
      // 只认字面。实测同义改写的三组相似度是 0.351 / 0.835 / 0.339，阈值 0.85 全拦不住
      // ——「日级聚合会撒谎」和「日级聚合会掩盖小时级变化」语义相同，字面几乎不重。
      // 调低阈值会误杀真正不同的内容（两条都提「记账」不等于说的是同一件事）。
      // 字面比较留作兜底，语义判断交给模型。
      const existing = this.store
        .listPromotions(EXISTING_PROMOTION_LIMIT)
        .map((row) => String(row.content || "").replace(/\s+/g, " ").trim())
        .filter((c) => c.length > 0);
      const existingBlock =
        existing.length > 0
          ? `\n\n===== 已经沉淀过的认知（语义相同的不要重复）=====\n${existing
              .map((c, i) => `[${i + 1}] ${c}`)
              .join("\n")}\n`
          : "";
      const composition = await this.composeSetup(INSIGHT_PRESET, { provider, model, reasoningEffort: "medium" });
      const created = await this.agents.create({
        sessionId: id,
        meta: { cwd: this.workspace, ...(composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }) },
        agentOptions,
        setup: composition.setup,
      });
      const agent = created.agent;
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(createUserMessage({
        content: [{ type: "text", text: `今天的素材：\n\n${fragmentsText}${existingBlock}` }],
        source: { kind: "user" },
      }));
      await agent.whenIdle();
      await this.sessions.flush(agent.session);
      const raw = lastAssistantText(agent.session.snapshotEvents(), firstSeq).trim();
      const insights = parseInsights(raw);
      if (insights === null) {
        this.log?.warn?.(`dreaming: ${id} 提炼输出无法解析，原始回复前 200 字：${raw.slice(0, 200)}`);
      } else {
        this.log?.info?.(`dreaming: ${id} 提炼 → ${insights.length} 条`);
      }
      return insights;
    } catch (e) {
      this.log?.warn?.(`dreaming: ${id} 提炼失败 ${e instanceof Error ? e.message : e}`);
      return null;
    } finally {
      // 2026-10-27 补：提炼会话要自己归档。runOnce 的 finally 只归档写梦会话（-dr），
      // 这里的 id 是 -ins，不归档会在会话列表里不断堆积（每晚 +1）。
      await this.archive(id);
    }
  }

  /** v2：晋升写回 MEMORY.md（先预算回收，再追加当天段）。 */
  ///
  /// 2026-10-27 改：同一天已有沉淀段就把条目并进那一段，不再新建段。
  /// 原来是无条件 appendFile 一个新段，正常一天跑一次看不出来；手工连跑两次
  /// 就会出现两个同名 `## YYYY-MM-DD — 梦境沉淀`，读起来像重复。一天只留一段。
  /// 追溯用的 dreamId 靠 promotions 表（每行都有 dream_id），段内不必重复。
  async appendPromotionsToMemory(date, dreamId, promotions) {
    if (!promotions.length) return;
    const entries = promotions.map((p) => `- ${p.type ? `[${p.type}] ` : ""}${p.content}`);
    const heading = `## ${date} — 梦境沉淀（dsh-dreaming）`;
    try {
      await this.compactMemoryForBudget();
      let text = "";
      try {
        text = await readFile(this.memoryPath, "utf8");
      } catch {
        text = "";
      }
      if (text.includes(heading)) {
        // 当天已有段 → 插到该段末尾（下一个 "## " 之前，或文件末尾）
        const idx = text.indexOf(heading);
        const rest = text.slice(idx + heading.length);
        const nextIdx = rest.search(/\n## /);
        const insertAt = nextIdx === -1 ? text.length : idx + heading.length + nextIdx;
        const before = text.slice(0, insertAt).replace(/\s+$/, "");
        const after = text.slice(insertAt);
        await writeFile(this.memoryPath, `${before}\n${entries.join("\n")}\n${after}`, "utf8");
        this.log?.info?.(
          `dreaming: 晋升 ${promotions.length} 条并入当天沉淀段写回 ${this.memoryPath}（预算 ${this.budgetBytes} 字节）`,
        );
      } else {
        const block = [
          "",
          heading,
          "",
          `> 梦境日记见 SQLite（dreams #${dreamId}）。当夜 LLM 提炼：`,
          "",
          ...entries,
          "",
        ].join("\n");
        await appendFile(this.memoryPath, block, "utf8");
        this.log?.info?.(`dreaming: 晋升 ${promotions.length} 条写回 ${this.memoryPath}（预算 ${this.budgetBytes} 字节）`);
      }
    } catch (e) {
      this.log?.warn?.(`dreaming: MEMORY.md 写入失败 ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * v2：MEMORY.md 预算回收（对齐 OpenClaw compactMemoryForBudget）。
   * 超预算时：只删带「梦境沉淀（dsh-dreaming）」标记的最老 ## 段，直到达标；
   * 用户手写段落、顶部稳定区绝不触碰。
   */
  async compactMemoryForBudget() {
    let content;
    try {
      content = await readFile(this.memoryPath, "utf8");
    } catch {
      return; // 文件不存在则不处理
    }
    if (Buffer.byteLength(content, "utf8") <= this.budgetBytes) return;
    const lines = content.split("\n");
    // 解析全部 ## 段的行区间 [startLine, endLine)
    const sections = [];
    let current = null;
    lines.forEach((line, i) => {
      if (/^##\s/.test(line)) {
        if (current) current.end = i;
        current = { heading: line, start: i, end: lines.length, automated: line.includes(PROMOTION_SECTION_MARK) };
        sections.push(current);
      } else if (current && current.end === lines.length && sections[sections.indexOf(current)].end === lines.length) {
        current.end = lines.length; // 保持末段 end = 行数（无变化）
      }
    });
    if (current) current.end = lines.length;
    // 只考虑带标记的自动化段，按标题日期从老到新
    const automated = sections.filter((s) => s.automated).sort((a, b) => a.heading.localeCompare(b.heading));
    const removeIndexes = [];
    let size = Buffer.byteLength(content, "utf8");
    for (const sec of automated) {
      if (size <= this.budgetBytes) break;
      const seg = lines.slice(sec.start, sec.end);
      const segSize = Buffer.byteLength(seg.join("\n"), "utf8");
      removeIndexes.push(sec);
      size -= segSize;
    }
    if (removeIndexes.length === 0) return;
    // 按行区间一次性删除（从后往前删避免位移），并把段前空行一并吃掉
    const drop = new Set();
    for (const sec of removeIndexes) {
      let s = sec.start;
      if (s > 0 && lines[s - 1].trim() === "") s--;
      for (let i = s; i < sec.end; i++) drop.add(i);
    }
    const kept = lines.filter((_, i) => !drop.has(i));
    const next = kept.join("\n");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(this.memoryPath, next, "utf8");
    this.log?.warn?.(`dreaming: MEMORY.md 预算回收，删除 ${removeIndexes.length} 个最老晋升段（${removeIndexes[0].heading} 等）`);
  }

  /** 把梦境会话归属到对应 workspace（幂等）。 */
  async attachWorkspace(sessionId) {
    const registry = this.workspaceRegistry;
    if (registry === void 0) return;
    try {
      let workspace = await registry.resolveByPath(this.workspace);
      if (workspace === void 0) workspace = await registry.create(this.workspace);
      await workspace.attachSession(sessionId);
    } catch (e) {
      this.log?.warn?.(`dreaming: attach workspace 失败 ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 归档梦境会话（完成后隐藏，session 文件保留可查）。 */
  async archive(sessionId) {
    try {
      if (this.workspaceRegistry) await this.workspaceRegistry.archiveSession(sessionId);
      this.log?.info?.(`dreaming: ${sessionId} 已归档`);
    } catch (e) {
      this.log?.warn?.(`dreaming: 归档失败 ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** v2：narrative user message —— 碎片素材 + 连续性上下文（persona 在 preset 里）。 */
function buildNarrativeMessage(fragmentsText, recentEntries = [], recentPromotions = []) {
  const lines = [
    "这些是今天留下的东西（顺序没有意义，混在一起看）：",
    "",
    fragmentsText,
  ];
  if (recentEntries.length > 0) {
    lines.push("", "你之前写过这些（旧→新）：", "");
    for (const e of recentEntries) lines.push(`- ${e}`);
    lines.push(
      "",
      "换个角度。别再用同一套比喻、同一套开头、同一套收尾——你自己上次已经用过了。",
    );
  }
  // 沉淀记忆排最后：它们是规则驱动的技术性条目（"助手更新了 X 文件"这类），
  // 排前面会把整篇拽回"工作摘要"腔。让旧梦先占住语感，沉淀只当背景材料。
  if (recentPromotions.length > 0) {
    lines.push("", "从更早的日子沉淀下来、现在还留着的：");
    for (const p of recentPromotions) lines.push(`- ${p}`);
  }
  lines.push(
    "",
    "把它们打碎之后再写，写成一篇梦境日记：不是这一天，是这一天留下的东西。",
  );
  return lines.join("\n");
}

/** 截断回灌的旧梦，避免上下文膨胀（压掉换行，只保留开头——梦境的开头最有辨识度）。 */
function clampDreamContext(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > RECENT_DREAM_MAX_CHARS ? t.slice(0, RECENT_DREAM_MAX_CHARS) + "…" : t;
}

export { stripMeta, recallToday };