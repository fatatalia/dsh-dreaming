# dsh-dreaming v2 方案 — 梦境回归 + 规则化晋升

> 状态：方案定稿（待用户确认后落地）
> 参考：OpenClaw `dreaming-narrative-*` / `dreaming-phases-*` / `short-term-promotion-*` 源码 + 咱们 v1 `dream-engine.mjs`
> 相关：`docs/prompt-v2-draft.md`（prompt 细节草案）

---

## 1. 背景与问题（为什么要改）

v1（当前实现）三个已知问题：

| # | 问题 | 现象 | 根因 |
|---|---|---|---|
| 1 | **梦境太像日记** | 产出是"有情绪的一天回顾"（线性叙述 + 点评），不是"梦" | narrative 用单个 prompt 一把梭，agent 会话还带着 AGENTS.md 满身人格上下文 + prompt 显式要求法塔人格 = 双重人格注入；且"不许编造"约束让模型不敢做隐喻变形 |
| 2 | **晋升不可审计** | 洞察由 LLM 自主判定，阈值、依据、重复性都无法追踪 | 判定逻辑完全在模型黑盒里，无规则、无去重、无证据链 |
| 3 | **MEMORY.md 膨胀** | 晋升段无预算控制，2026-07-10 已涨到 44KB 被 bootstrap 截断 | 每夜晋升无上限追加，从不回收 |

## 2. 目标

- 梦境正文 → **纯梦**：裸上下文 narrative 会话，OpenClaw 式 prompt，隐喻变形、凝缩、无我。
- 洞察晋升 → **信号驱动**：多查询 recall + 跨天累计 + 概念提取 + 量化评分（无关键词白名单），可审计、稳定、不随模型漂移、零人工预设。
- MEMORY.md → **有预算**：超限丢最老晋升段，保留用户手写内容，永不爆。

## 3. 总架构（两阶段流水线）

```
日间记忆（Hindsight recall + MEMORY.md + 当天会话）
        │
        ▼
① prepareFragments（引擎侧预拉取）
        │   每条 ≤280字符，带 [编号]（来源）标签，8-15 条
        ▼
② narrative 会话（裸上下文，LLM 写梦）
        │   输出纯正文（150-300 字），存 dreams 表
        ▼
③ 信号驱动晋升（引擎侧）
        │   多查询 recall + 跨天累计 + 概念聚类 + 量化评分 → promotions 表
        ▼
④ MEMORY.md 追加 + 预算回收
```

**核心分工：LLM 只写梦，判定交给行为学信号。**（对齐 OpenClaw 哲学）

## 4. 模块设计

### 4.1 素材采集 `prepareFragments()`

```
- Hindsight recall：POST /v1/default/banks/coding-agent::mayacode/memories/recall
    Body: {"query": "今天的关键事件与对话", "limit": 25}
- 附加：MEMORY.md 顶部稳定区 + 当天会话摘要
- 每条截断 ≤280 字符，编号 + 来源标签（会话/MEMORY/洞察）
- 目标 8-15 条，宁少勿滥
- 输出：fragmentsText（注入 narrative）
```

> 对齐 OpenClaw：素材=280 字符碎片（`DAILY_INGESTION_MAX_SNIPPET_CHARS=280`），**碎片化注入**诱发拼接/变形，不让 agent 自己 curl（省一半 token + 专注写作）。

### 4.2 narrative 会话（写梦）

**会话隔离（关键·已确认可行）**：梦境 narrative 会话必须**轻量上下文**——不注入 AGENTS.md / 工作区指令，只给 narrative prompt + 碎片。

- OpenClaw 用 `lightContext: true` → `bootstrapContextMode="lightweight"` → `applyContextModeFilter` 返回 `[]`（清空全部引导文件）。
- **dsh 等价机制 = agent preset（已核验）**：dsh 的 agent 会话由 AGENT-PLANE 预设组成，`standard` 预设挂 `persona`（"You are a coding agent…"）+ `agent-instructions`（maxBytes 64K 的 AGENTS.md 注入）+ 全套工具；而 **`minimal` 预设没有任何 agent-instructions**——persona 是 `complete: true` 的固定提示、`includeRuntimeContext: false`（连运行时上下文都不注入），只带 bash + 编辑器。这证明 dsh 天然支持"裸上下文"会话。
- **实施**：新建 **`dream-narrative` 专用预设**（放 `config/agent-presets/dream-narrative/`）：
  - persona = narrative prompt（`complete: true`，作为唯一系统提示）
  - **不挂** `agent-instructions`
  - **不挂任何工具**（素材已由引擎注入，梦境 agent 不需要 exec/fs/网络）
  - `composeSetup("dream-narrative", {provider, model})` 替换现在的 `composeSetup(undefined, …)`（默认 standard）
- 效果：narrative 会话上下文 = narrative prompt + 碎片，与 OpenClaw lightweight 模式等价的纯净状态。

**Prompt**：采用 `docs/prompt-v2-draft.md` 的 Prompt A（中文移植版），要点：
- 禁"我在做梦/梦里"类 meta-commentary
- 禁 AI/agent/模型技术自指
- 纯散文，无 markdown
- 150-300 字
- 只输出正文，无前言落款

**输出**：纯文本正文 → 存 `dreams` 表（不再要求 JSON）。

### 4.3 信号驱动晋升（无关键词白名单）

**核心哲学（对齐 OpenClaw）**：重要 ≠ 关键词命中；重要 = **反复想起、多角度想起、持续想起、信息密度高**。四个行为学信号全部自动采集，零人工预设。

**① 多查询 recall（产生 uniqueQueries 信号）**
每夜不用单一 query，而是用 3-5 个不同角度查询（如"今天发生什么""最近的重要决定""家人的变化""反复出现的事""有什么值得记住的"），统计同一片段被多少个**不同查询**命中。

**② 跨天累计（产生 recallCount / recallDays 信号）**
dreaming.db 新增 `recall_stats` 表，按片段哈希累计：命中次数、命中天数、不同查询数。时间越久，信号越强——"反复想起"是累计出来的，不是一晚看出来的。

**③ 概念提取 + 主题聚类（产生 conceptual 信号）**
- 对候选片段做中文分词，提取概念标签（对齐 OpenClaw `deriveConceptTags`：分词 + 归一化 + 上限 8）
- 聚类统计：同一概念跨 N 条记忆出现 → 主题强度 `strength = min(1, count/条目数×2)`
- 强主题直接进入"反复浮现"候选

**④ 量化评分（对齐 OpenClaw `calculateCandidateTruthConfidence`）**

```
confidence = 平均recall得分×0.45
           + min(1, log1p(recallCount)/log1p(6))×0.25
           + min(1, recallDays/3)×0.2
           + min(1, 概念标签数/6)×0.1
```

- 候选真相阈值：`confidence ≥ 0.45`
- 晋升门槛（可配）：`MIN_SCORE=0.75`、`MIN_RECALL_COUNT=3`、`MIN_UNIQUE_QUERIES=2`
- 每次晋升上限 5 条/夜，宁缺毋滥

**⑤ 去重与防重复**
- 候选去重：相似度 `DEDUPE_THRESHOLD=0.85`（对齐 OpenClaw `dedupeEntries`）
- 已晋升拦截：`promotions` 表按归一化文本相似度查重，已晋升主题跳过（对齐 `promotedAt` 标记）
- 概念黑名单：通用停用词（对齐 OpenClaw `REM_REFLECTION_TAG_BLACKLIST`），只挡噪声不挡主题

**证据链**：每条晋升记录 `evidence`（来源路径/recall 次数/不同查询数/概念标签）+ `rule`（触发信号名），存入 promotions 表，可审计。

> 调整记录：2026-08-18 方案修订——原"家庭/长期事项关键词白名单"**撤回**，改为信号驱动。理由：关键词匹配是"人预设什么重要"，行为学信号是"系统观察到什么重要"；前者有漏网（如"妹妹第一次骑车"零关键词命中），后者自适应任何新主题。

### 4.4 MEMORY.md 预算管理

**写段格式**（带可识别标记）：
```
## YYYY-MM-DD — 梦境沉淀（dsh-dreaming）
> 梦境日记见 SQLite（dreams #id）。当夜规则晋升洞察：
- 洞察1
...
```

**预算策略**（对齐 OpenClaw `compactMemoryForBudget`）：
- 目标：MEMORY.md 总长 ≤ 25KB（默认，可配）
- 超预算时：解析 MEMORY.md，**只删带 `— 梦境沉淀（dsh-dreaming）` 标记的最老段**，直到达标
- **绝不触碰**：用户手写段落、顶部稳定区、其他日期段
- 每夜写入前执行一次

> 这直接解决 v1 的 44KB 灾难；OpenClaw 的 `compactMemoryForBudget` 是同一思路（"drop the OLDEST auto-promoted sections… non-promotion content is preserved"）。

### 4.5 存储 schema 变更

```sql
-- dreams 表：content 改为纯正文（不变更 schema，语义变化）
-- promotions 表：扩展可审计字段
ALTER TABLE promotions ADD COLUMN evidence TEXT;      -- 来源/命中次数/不同查询数/概念标签
ALTER TABLE promotions ADD COLUMN rule TEXT;           -- 触发信号名（recall_count/unique_queries/pattern/…）
-- 新增 recall_stats 表：跨天累计"被想起"信号（OpenClaw short-term store 等价物）
CREATE TABLE recall_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fragment_hash TEXT NOT NULL,        -- 片段归一化哈希
  snippet TEXT NOT NULL,              -- 代表性片段（最新）
  recall_count INTEGER NOT NULL DEFAULT 0,      -- 累计命中次数
  unique_queries INTEGER NOT NULL DEFAULT 0,    -- 不同查询命中数
  first_seen TEXT NOT NULL,             -- 首见日期
  last_seen TEXT NOT NULL,              -- 最近命中日期
  last_query TEXT,                      -- 最近命中 query
  promoted INTEGER NOT NULL DEFAULT 0,  -- 是否已晋升（对齐 promotedAt）
  UNIQUE(fragment_hash)
);
```

## 5. OpenClaw 对照表（v2 对齐情况）

| 环节 | OpenClaw | 咱们 v2 |
|---|---|---|
| 素材碎片 | 280 字符注入 | ✅ 同样 ≤280 字符注入 |
| narrative 隔离 | lightContext 清空引导文件 | ✅ agent preset 隔离（dream-narrative 专用预设，已核验） |
| 写梦 prompt | 硬编码英文 + 禁 meta/自指 | ✅ 中文移植版（草案 Prompt A） |
| 概念提取 | deriveConceptTags 分词 | ✅ 中文分词 + 归一化（对齐） |
| 洞察判定 | 行为学信号（recallCount/uniqueQueries/跨天/聚类） | ✅ 信号驱动（多查询 recall + recall_stats 跨天累计 + 量化评分） |
| 晋升落点 | MEMORY.md | ✅ MEMORY.md |
| 预算管理 | compactMemoryForBudget | ✅ 按标记删最老晋升段 |
| 防重复 | promotedAt 标记 | ✅ recall_stats.promoted + promotions 查重 |
| 三阶段 | Light + REM（Deep 已吸收） | ✅ 简化为"写梦 + 晋升"两环节 |

## 6. 落地步骤（dream-engine.mjs）

1. **核验 agentPresets 自定义 preset 支持**（`presets.resolve("dream-narrative")` 能否解析项目级 preset；不能则注册到全局 config/agent-presets）
2. 新建 `dream-narrative` preset（persona=Prompt A，`complete: true`，不挂 agent-instructions/工具）
3. 实现 `prepareFragments()`（引擎侧 Hindsight 拉取 + 截断 + 标签）
4. 替换 `dreamPrompt()` → `narrativePrompt(fragmentsText)`（纯正文输出，OpenClaw 式）
5. 实现 `recall_stats` 表 + 跨天累计更新（多查询 recall → 命中计数）
6. 实现概念提取 + 主题聚类 + 量化评分 `promoteBySignals()`（0.45 候选 / 0.75 晋升 / 去重 / 上限）
7. 新增 `compactMemoryForBudget(memoryPath, maxBytes)`（预算回收）
8. 更新 `runOnce()` 流程：prepareFragments → 更新 recall_stats → narrative 会话 → 存 dreams → 信号晋升 → 写 MEMORY.md（先预算）→ 存 promotions（含 evidence/rule）
9. 更新 web"梦境"Tab 展示（纯正文 + 洞察证据链）

## 7. 验证方案

1. **并排对比**：取同一天素材，v1 prompt vs v2 prompt 各跑一篇，人工判断"像梦"程度（变形/无我/凝缩三指标）
2. **晋升审计**：检查 promotions 表 evidence/rule 字段是否可追溯到来源
3. **预算压力测试**：人为把 MEMORY.md 撑到超限，验证只删标记段、手写内容无损
4. **重复拦截**：连跑两夜，确认同一主题不重复晋升
5. **回归**：web 梦境 Tab 正常显示，dreaming.db 结构可迁移

## 8. 风险与待确认

| 项 | 说明 | 状态 |
|---|---|---|
| narrative 会话隔离 | dsh 通过 agent preset 实现（minimal 预设即证据）→ 新建 dream-narrative 预设 | ✅ 已确认可行 |
| agentPresets 是否支持项目级自定义 preset | 需核验 preset 解析源（全局 config/agent-presets 或可注册项目 preset） | 🔧 落地第一步核验 |
| Hindsight recall 无 conceptTags | 用中文分词自动提取概念标签（对齐 OpenClaw deriveConceptTags），无白名单 | ✅ 已定（2026-08-18 修订） |
| recall_stats 冷启动 | 新表初始无累计信号，前几夜晋升可能偏少（信号未积累）；可设"试运行期"或放宽首周阈值 | ⚠️ 预期行为 |
| 中文分词依赖 | 需要 jieba 或轻量分词方案（引擎侧 Node 实现需引入依赖） | 🔧 落地时定 |
| 旧 dreams 表数据 | 无 schema 破坏（content 语义变化），历史记录保留可读 | ✅ 已定 |
| 深夜窗口多一次调度 | 写梦 + 晋升都在同一会话/进程内，无额外定时 | ✅ 已定 |

---

*方案定稿 2026-08-18。确认后按第 6 节步骤动工。*
