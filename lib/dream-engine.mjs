/**
 * dream-engine.mjs — dsh-dreaming v2 核心（随机定时 + 纯梦叙事 + 信号驱动晋升）
 *
 * v2 改动（2026-08-18，依据 docs/v2-plan.md）：
 *   1. 梦境正文改用 dream-narrative 专用 preset（persona=梦境 prompt，complete:true，
 *      不挂 agent-instructions/工具）→ 裸上下文写梦（对齐 OpenClaw lightContext）
 *   2. 素材由引擎预取注入（多查询 Hindsight recall + 截断碎片），agent 不再自己 curl
 *   3. 输出纯正文（无 JSON），insight 不再由 LLM 判定
 *   4. 晋升改为信号驱动：多查询命中数（uniqueQueries）+ entities 概念聚类 +
 *      跨天累计（recall_stats 表）+ 量化评分（0.45 候选 / 0.75 晋升）
 *   5. MEMORY.md 预算管理：超限只删带「梦境沉淀」标记的最老段
 *
 * 依赖经构造注入（agents/agentDefaultModel/agentPresets/sessions/workspaceRegistry），
 * 本模块不持有框架状态。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { readFile, appendFile, readdir, rename, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { similarity } from "./store.mjs";

/** 随机触发窗口（本地时间 HH:mm），启动后每次计算当天窗口内随机时刻。 */
const DEFAULT_WINDOW = { start: "02:00", end: "04:30" };
/** MEMORY.md 默认路径（按工作区 cwd 推导）。 */
const DEFAULT_MEMORY_PATH = () => join(homedir(), "dsh", "mayacode", "MEMORY.md");
/** narrative 专用 agent preset（~/.dsh/.agent-presets/dream-narrative）。 */
const NARRATIVE_PRESET = "dream-narrative";
/** Hindsight recall 接口（本机，无鉴权）。 */
const HINDSIGHT_BASE = "http://127.0.0.1:8888";
const HINDSIGHT_BANK = "coding-agent::mayacode";
/** 多查询口径：不同角度 recall，产生 uniqueQueries 信号。 */
const RECALL_QUERIES = [
  "今天发生了什么 / 今天的关键事件与对话",
  "最近两天的重要决定、项目进展与待办",
  "家人相关的变化、健康、生日或值得记住的事",
  "有什么反复出现、值得长期记住的事情",
];
const RECALL_LIMIT_PER_QUERY = 12;
/** 碎片注入上限（对齐 OpenClaw snippets ≤12）。 */
const FRAGMENT_CAP = 12;
const FRAGMENT_MAX_CHARS = 280;
/** 晋升阈值（对齐 OpenClaw：候选 ≥0.45，晋升评分参考 0.75）。 */
const CANDIDATE_CONFIDENCE = 0.45;
const PROMOTION_MIN_RECALL_COUNT = 2; // 至少被 2 个不同查询命中
const PROMOTION_MAX_PER_NIGHT = 5;
const DEDUPE_THRESHOLD = 0.85;
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

/** URL 编码 Hindsight bank id（含 "::"）。 */
function bankUrl() {
  return `${HINDSIGHT_BASE}/v1/default/banks/${encodeURIComponent(HINDSIGHT_BANK)}`;
}

/**
 * v2：多查询 Hindsight recall → 原始记录（后续 dedupe）。
 * @returns {Promise<Array>} 原始命中记录
 */
async function recallToday(log) {
  const results = [];
  for (const query of RECALL_QUERIES) {
    try {
      const res = await fetch(`${bankUrl()}/memories/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, limit: RECALL_LIMIT_PER_QUERY }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const r of data.results ?? []) {
        if (!r || typeof r.text !== "string" || !r.text.trim()) continue;
        results.push({
          id: r.id,
          text: r.text.trim(),
          entities: Array.isArray(r.entities) ? r.entities.filter((e) => typeof e === "string") : [],
          score: r.scores?.final ?? r.scores?.reranker ?? 0,
          day: (r.occurred_start ?? r.mentioned_at ?? "").slice(0, 10),
          query,
        });
      }
    } catch (e) {
      log?.warn?.(`dreaming: recall 失败(query=${query.slice(0, 20)}) ${e instanceof Error ? e.message : e}`);
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

/** 从一条记忆文本里提取"一句话洞察"（规则截取：首句/最长句 ≤120 字）。 */
function extractInsight(text) {
  const sentences = text.split(/[。！？!?；;]/).map((s) => s.trim()).filter((s) => s.length >= 8);
  if (sentences.length === 0) return text.slice(0, 120);
  sentences.sort((a, b) => b.length - a.length);
  let best = sentences[0];
  if (best.length > 120) best = best.slice(0, 120) + "…";
  return best;
}

export class DreamEngine {
  constructor({
    agents, defaultModel, sessions, agentPresets, workspaceRegistry,
    store, log = console, memoryPath = DEFAULT_MEMORY_PATH(),
    windowStart = DEFAULT_WINDOW.start, windowEnd = DEFAULT_WINDOW.end,
    workspace, provider = "", model = "", stepTimeoutMs = 0,
  }) {
    this.agents = agents;
    this.defaultModel = defaultModel;
    this.sessions = sessions;
    this.agentPresets = agentPresets;
    this.workspaceRegistry = workspaceRegistry;
    this.store = store;
    this.log = log;
    this.memoryPath = memoryPath;
    this.windowStart = windowStart;
    this.windowEnd = windowEnd;
    this.workspace = workspace || join(homedir(), "dsh", "default");
    this.provider = provider; // 配置指定 provider（空 = 全局默认）
    this.model = model; // 配置指定模型（空 = 全局默认）
    this.stepTimeoutMs = Number(stepTimeoutMs) > 0 ? Number(stepTimeoutMs) : 0; // turn 级单步超时（dsh-turn-guard 读取）
    this.budgetBytes = DEFAULT_MEMORY_BUDGET_BYTES;
    this._timer = null;
  }

  /** 热更新配置（设置页保存后调用）：工作区 + 模型 + 随机窗口，并重排下一次。 */
  setConfig({ workspace, provider, model, windowStart, windowEnd, stepTimeoutMs } = {}) {
    if (typeof workspace === "string" && workspace.trim()) this.workspace = workspace.trim();
    if (typeof provider === "string") this.provider = provider;
    if (typeof model === "string") this.model = model;
    if (typeof windowStart === "string" && /^\d{2}:\d{2}$/.test(windowStart)) this.windowStart = windowStart;
    if (typeof windowEnd === "string" && /^\d{2}:\d{2}$/.test(windowEnd)) this.windowEnd = windowEnd;
    if (stepTimeoutMs !== undefined) this.stepTimeoutMs = Number(stepTimeoutMs) > 0 ? Number(stepTimeoutMs) : 0;
    this.log?.info?.(`dreaming: 配置更新 workspace=${this.workspace} provider=${this.provider || "(全局默认)"} model=${this.model || "(全局默认)"} 窗口=${this.windowStart}-${this.windowEnd} stepTimeoutMs=${this.stepTimeoutMs || "不限"}`);
    this.scheduleNext();
  }

  /** 依据 agent-presets 组合出 web 兼容的 agent setup（override 空则全局默认）。 */
  async composeSetup(presetId, override) {
    const presets = this.agentPresets;
    const baseSel = this.defaultModel.currentSelection();
    const selection = override
      ? { provider: override.provider || baseSel.provider, model: override.model || baseSel.model }
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
    const agentOptions = { provider, model };
    try {
      // 1. 素材准备（引擎侧，注入而非 agent 自取）——只查一次，供写梦与晋升共用
      const records = await recallToday(this.log);
      const fragments = await this.prepareFragments(records);
      if (fragments.length === 0) {
        this.log?.warn?.(`dreaming: ${id} 无素材（Hindsight recall 空），跳过本次`);
        return;
      }
      const fragmentsText = fragments
        .map((f, i) => `[${i + 1}]（${f.day || "记忆"}）${f.snippet}`)
        .join("\n");

      // 2. 纯梦叙事：dream-narrative 预设（裸上下文），user message 只含碎片
      const composition = await this.composeSetup(NARRATIVE_PRESET, { provider, model });
      const created = await this.agents.create({
        sessionId: id,
        meta: { cwd: this.workspace, ...(composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }) },
        agentOptions,
        setup: composition.setup,
      });
      const agent = created.agent;
      // turn 级单步超时配置（dsh-turn-guard 读取）：从引擎配置读 stepTimeoutMs，
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
        if (this.stepTimeoutMs > 0) agent.__pluginConfig.turnGuard = { stepMs: this.stepTimeoutMs };
        else delete agent.__pluginConfig.turnGuard;
      }
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(createUserMessage({
        content: [{ type: "text", text: buildNarrativeMessage(fragmentsText) }],
        source: { kind: "user" },
      }));
      await agent.whenIdle();
      await this.sessions.flush(agent.session);
      const dreamText = lastAssistantText(agent.session.events, firstSeq).trim();
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
   * 归档超过 7 天的每日记忆文件（memory/daily/YYYY-MM-DD.md → memory/archive/）。
   * 三层记忆架构：每日文件承载当天记录，保留 7 天，过期按单独文件归档（不合并）。
   */
  async archiveDailyMemory() {
    const dailyDir = join(this.workspace, "memory", "daily");
    const archiveDir = join(this.workspace, "memory", "archive");
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
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
      this.log?.warn?.(`dreaming: 归档每日记忆失败 ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * v2：信号驱动晋升（对齐 OpenClaw calculateCandidateTruthConfidence）。
   * 信号：avgScore(0.45) + recallStrength(0.25，对数压缩命中数) + conceptual(0.1，entities 丰富度)，
   * 另以 uniqueQueries 作为硬门槛（≥2 个不同查询命中才候选）。
   * 纯规则，无 LLM——可审计、稳定。
   */
  async promoteBySignals(fragments, allRecords, date) {
    const today = localDate();
    const candidates = [];
    for (const rec of allRecords) {
      const recallCount = rec.recallCount ?? rec.querySet?.size ?? 1;
      if (recallCount < PROMOTION_MIN_RECALL_COUNT) continue; // 硬门槛：至少 2 个不同查询想起
      if (rec.promoted) continue;

      // 量化评分（对齐 OpenClaw 权重：avgScore×0.45 + recallStrength×0.25 + consolidation×0.2 + conceptual×0.1）
      // Hindsight scores.final 约 0.8-1.2，直接 min(1, score) 归一化（对齐 OpenClaw 相似度语义）
      const avgScore = Math.min(1, Math.max(0, rec.score ?? 0));
      const recallStrength = Math.min(1, Math.log1p(recallCount) / Math.log1p(6));
      const conceptual = Math.min(1, (rec.entities?.length ?? 0) / 6);
      const confidence = avgScore * 0.45 + recallStrength * 0.25 + conceptual * 0.1;
      if (confidence >= CANDIDATE_CONFIDENCE) {
        const content = extractInsight(rec.text);
        // 防重复：与已晋升内容相似则不重复晋升
        const dup = this.store.findPromotionSimilar(content, DEDUPE_THRESHOLD);
        if (dup) continue;
        candidates.push({
          content,
          confidence,
          rule: recallCount >= 3 ? "signal-recalls" : "signal-candidate",
          evidence: `来源=${rec.id.slice(0, 8)} 命中=${recallCount}个查询 实体=${(rec.entities ?? []).slice(0, 5).join("/")||"无"} 置信=${confidence.toFixed(2)}`,
          hash: rec.id,
        });
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence);
    const picked = candidates.slice(0, PROMOTION_MAX_PER_NIGHT);
    // 标记 recall_stats 已晋升（防跨夜重复）
    for (const c of picked) {
      if (c.hash) { try { this.store.markPromoted(c.hash); } catch { /* ignore */ } }
    }
    return picked.map((c) => ({ content: c.content, rule: c.rule, evidence: c.evidence }));
  }

  /** v2：晋升写回 MEMORY.md（先预算回收，再追加）。 */
  async appendPromotionsToMemory(date, dreamId, promotions) {
    if (!promotions.length) return;
    const block = [
      "",
      `## ${date} — 梦境沉淀（dsh-dreaming）`,
      "",
      `> 梦境日记见 SQLite（dreams #${dreamId}）。当夜信号晋升洞察：`,
      "",
      ...promotions.map((p) => `- ${p.content}`),
      "",
    ].join("\n");
    try {
      await this.compactMemoryForBudget();
      await appendFile(this.memoryPath, block, "utf8");
      this.log?.info?.(`dreaming: 晋升 ${promotions.length} 条写回 ${this.memoryPath}（预算 ${this.budgetBytes} 字节）`);
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

/** v2：narrative user message——只含碎片素材（persona 在 preset 里）。 */
function buildNarrativeMessage(fragmentsText) {
  return `今天的记忆碎片（引擎已预取，按来源标注）：\n\n${fragmentsText}\n\n从这些碎片写一篇梦境日记。`;
}