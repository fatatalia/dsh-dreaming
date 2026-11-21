# dsh-dreaming — 梦境记忆

dsh 的记忆整合插件。四件事，彼此独立、可单独关掉：

| 模块 | 什么时候跑 | 干什么 | 产物 |
|---|---|---|---|
| **梦境** | 每天凌晨随机窗口一次（默认 02:00–04:30） | 把当天素材写成一篇梦，再把高价值结论晋升回长期记忆 | `dreams` + `promotions` 表，`MEMORY.md` |
| **对话沉淀** | 对话进行中，每累计 N 轮一次 | 把这段对话里以后还有用的东西抄成草稿 | 各工作区 `memory/daily/YYYY-MM-DD.md` |
| **记忆注入** | 每轮 model 调用 | 把长期记忆送进 system prompt | 无（纯注入） |
| **语义检索** | 后台常驻，分批推进 | 给历史对话建向量索引，按语义找回相关片段 | `messages_vec`（sqlite-vec 虚表）+ `vec_state` |

设计上有一条主线：**LLM 只负责写和提炼，判定交给规则。** 值不值得晋升不是让模型自己说，而是看这条结论在后续对话里被"想起"了几次。

前三个模块只用 FTS/子串，**零外部依赖**；语义检索需要嵌模型（313 MB），
但它是可选件 —— 关掉行为和原来完全一致，不会因为它缺模型而影响其他三条路。


---

## 梦境：夜间闭环

```
凌晨随机时刻（窗口内均匀取样，可手动「立即做梦」）
  → 取材，全部本地，零 HTTP：
       · 今日 / 昨日记忆 —— 各工作区 memory/daily/*.md
       · 近期对话（24h）/ 关键线索（72h）—— ~/.dsh/dreaming-memory.db
  → 去重 + 碎片化（每片 ≤280 字符，编号 + 来源）
  → 起一个 dream-narrative 会话（裸上下文，无工具），只喂碎片
  → 写梦（第一人称 150–300 字纯散文，禁「我在做梦」、禁 AI 自指）
  → 信号驱动晋升（纯规则，无 LLM 参与判定）：
       · 跨天「被想起」次数 ≥ 2 才入围
       · confidence = 得分×0.45 + log(命中数)×0.25 + 实体丰富度×0.1
       · 候选线 0.45，相似度 0.85 去重，promotions 表查重，每夜上限 5 条
  → 梦境进 dreams 表；洞察进 promotions 表（带 evidence / rule 证据链）
  → 晋升内容追加进 MEMORY.md（只追加标记段，手写内容永不触碰）
  → 会话归档，排下一次
```

**为什么要「被想起」这个信号**：单次对话里冒出来的"洞察"大多是噪音，第二天就没人提了。真有用的东西会反复被召回。所以晋升门槛是**跨天召回次数**，不是模型的自评分。

---

## 对话沉淀（nudge）

梦境一天只有一次，长会话里当天产生的东西要等到第二天凌晨才被整理。nudge 补这个空档。

- 计数在 `turn/end` 上累计，达到 `nudgeTurnThreshold`（默认 10 轮）触发一次
- 同一会话两次之间至少隔 `nudgeMinGapMin`（默认 5 分钟）—— 工具密集的 turn 会连发 `turn/end`，不防抖会刷屏
- 用 `memory-curator` preset（裸上下文、无工具），只返回 JSON 数组
- **只写草稿层**：落到当天 `memory/daily`，不碰 `MEMORY.md`。长期记忆的提炼仍然归梦境
- 会跳过自己是 `dream-*` 或 `memory-curator` 的会话，避免自己沉淀自己

---

## 记忆注入层

把 `MEMORY.md`（公共环境事实，`~/.dsh/MEMORY.md`）和各工作区的 `USER.md`（`<cwd>/USER.md`）送进 system prompt 末尾（`order: 10100`）。

**会话级冻结**：同一会话只读一次盘，之后走内存缓存，缓存键是 `sessionId|cwd`。原因是 system prompt 在最前面，任何字节变动都会让它后面的全部历史 cache miss。`MEMORY.md` 每天凌晨被梦境重写，如果每轮都重读，每天必吃一次全量重算。

**什么时候换新内容**：`compaction/end` 时作废该会话的缓存，下一次 model 调用重新读。压缩本来就已经把前缀废掉了，所以这次更新是免费的 —— 更新点落在「压缩后第一次 model 调用」，不是压缩那一刻。

**预算**：`MEMORY + USER` 合计上限 10 KB。超了截断 USER（按 UTF-8 边界退让，不切坏多字节字符），保留头部并告警。MEMORY 独占超限的情况会在日志里明确报出来。

**缓存键必须含 cwd**：不同工作区的 `USER.md` 内容不同，只按 sessionId 缓存会串味。

---

## 三份 agent preset

都声明在本插件的 `cordis.patch.yml` 里（`@deepseek-ai/dsh-agent-preset` 插件行），不是 `~/.dsh/.agent-presets/` 目录 —— dsh 0.1.7 起文件系统方式已废弃。

| preset id | order | 用于 | 特点 |
|---|---|---|---|
| `dream-narrative` | 10 | 写梦境正文 | persona 即完整 prompt，`complete: true` |
| `dream-insight` | 11 | 从 daily 提炼可复用认知 | 同上，只输出结构化结果 |
| `memory-curator` | 12 | 对话沉淀 | 同上，只输出 JSON 数组 |

**为什么不复用主 preset**：那一套会注入人格 + AGENTS.md + 二十来个工具定义，约 25K token。为了写一段梦境或提炼三条记忆付这个成本没有意义。三份都是**裸上下文**：不挂 `agent-instructions`、不挂任何工具、不注入运行时上下文。

因为写在插件包里，**加载本插件 → 三个 preset 一起注册**；反过来，从 profile 的 `bundles` 里移除它，三个 preset 和整个闭环一起消失。

---

## 目录

```
dsh-dreaming/
├── index.js                 # host 插件：Config + RPC 通道 + 引擎装配
├── client.js                # 浏览器 bundle：左侧菜单页 + 三个子 Tab + 设置页卡片
├── cordis.patch.yml         # 插件声明 + 三份 agent preset
├── lib/
│   ├── dream-engine.mjs     # 取材 / 写梦 / 信号晋升 / 预算回收
│   ├── nudge.mjs            # 对话中途沉淀
│   ├── inject.mjs           # 记忆注入层（冻结 + 截断 + memoryStatus）
│   ├── store.mjs            # dreams / promotions / recall_stats
│   ├── db.mjs               # SQLite 连接与迁移
│   ├── memory.mjs           # 对话落库
│   ├── extract.mjs          # 素材提取与碎片化
│   ├── curate.mjs           # 洞察候选筛选
│   ├── dream-render.mjs     # 渲染
│   ├── agent-setup.mjs      # agent 装配
│   ├── vec-model.mjs        # 嵌入模型解析 / 校验 / 下载（父进程侧）
│   ├── vec-embed.mjs        # 嵌入客户端（管子进程生命周期）
│   ├── vec-embed-child.mjs  # 嵌入子进程（独占 llama.cpp 上下文）
│   ├── vec-store.mjs        # vec0 虚表读写 / 游标 / KNN
│   ├── vec-sync.mjs         # 后台同步器（第 1 趟近期 + 第 2 趟历史 + 增量）
│   ├── vec-hybrid.mjs       # 向量 + 文本混合打分
│   └── vec-inject.mjs       # 语义记忆注入（每轮检索 + 拼 prompt）
├── scripts/                 # 运维脚本（回填 / 体检）
├── test/v2-unit.test.mjs
├── docs/
│   ├── v2-plan.md
│   └── prompt-v2-draft.md
└── package.json
```

## 数据

**SQLite** — `~/.dsh/dreaming-memory.db`（可用 `dbPath` 改）

- `dreams` — 梦境日记正文
- `promotions` — 晋升结论 + `evidence`（来源/命中数/实体）+ `rule`（触发的信号名）
- `recall_stats` — 跨天「被想起」统计：命中次数、不同通道数、首见与最近命中日期、是否已晋升
- `sessions` — 对话落库（供素材召回与检索）
- `messages_vec` — 语义向量（`vec0` 虚表，`distance_metric=cosine`，768 维）
- `vec_state` — 索引游标：`watermark_id`（增量水位）、`hot_max_id`（第 1 趟上界）、
  `warm_floor_id` / `warm_cursor_id`（近期段下边界与进度）、`model` / `dim` / `metric`（模型指纹）

**`MEMORY.md`** — `~/.dsh/MEMORY.md`，只追加 `## YYYY-MM-DD — 梦境沉淀（dsh-dreaming）` 段。

---

## 语义检索（向量）

文本检索只在**字面**上找词，问「上次那个温度的问题」就找不到写着「CPU 76°C」的对话。
语义检索补这一块：把消息嵌成 768 维向量，按**意思**找。**默认关闭**，关掉时行为与原来完全一致。

### 嵌入模型：怎么来的

模型不随 npm 包分发（313 MB），而是**首次用到时自动下载**到
`~/.node-llama-cpp/models/`（`node-llama-cpp` 的标准缓存目录）。解析顺序：

| 优先级 | 来源 | 行为 |
|---|---|---|
| 1 | 环境变量 `DSH_VEC_MODEL` | 指向哪个文件就用哪个。**无效时直接报错，不自动下载** —— 显式指定的路径出错必须让人看见 |
| 2 | `semanticModelDir` / `semanticModelFile` 配置 | 同上 |
| 3 | 默认目录下的默认文件名 | 命中即用 |
| 4 | 都不存在，且 `semanticAutoDownload = true` | 从 `hf:<repo>/<file>` 下载 |
| 5 | 都不存在，且 `semanticAutoDownload = false` | 停在 `missing`，等人来点 |

下载走 `HF_ENDPOINT` 环境变量（hf-mirror 直接生效，**不做自动猜镜像** —— 静默回退会让人查不出问题）。
界面会显示当前用的 host。

**三道校验**（半截文件是常态：HF 404 会返回一小段文本、断网会留 `.part`）：

1. 文件大小 ≥ 50 MB（正常模型 313 MB）
2. 前 4 字节必须是 `GGUF` magic
3. 下载时 `verify: true`，比对远端 Content-Length

任何一道不过 ⇒ 重命名成 `<原名>.corrupt-<ISO时间戳>`**保留现场不删**，然后重下。
保留是因为「坏成什么样」本身就是线索 —— 15 字节的那种一眼就能看出是 404 页面。

### 索引：三趟推进

| 趟 | 范围 | 方向 | 游标 |
|---|---|---|---|
| 第 1 趟 | 最近 20%（上限 5000 条） | 由新到旧 | `warm_cursor_id` **递减** |
| 第 2 趟 | `id ≤ hot_max_id` 的历史 | 由旧到新 | `watermark_id` 递增 |
| 增量 | 水位线之后的新消息 | 由旧到新 | 同上 |

⚠️ **第 1 趟的游标是递减的** —— 它从最新往旧推，看到游标变小是正常的，不是死循环。
判断「有没有推进」要看**是否触及 `warm_floor_id`**，别只看数字方向。

`hot_max_id` 在**第 1 趟收尾时**才写（= `warm_floor_id - 1`），所以它长期是 0 属正常 ——
说明第 1 趟还没跑完。第 2 趟的上界靠它，`watermark_id` 则必须留 0，
否则第 2 趟就再也取不到历史部分。

**分批与预算**：每批 `CHUNK` 条嵌入 + 事务写，`TICK_BUDGET_MS` 到点就停，下轮继续。
积压时用 `CATCHUP_MS` 短间隔追平，追平后回到 `intervalMs`。

### 混合打分

向量召回 `semanticCandidatePool`（默认 24）条候选，再与文本命中按权重融合：

```
score = vectorWeight × 余弦相似度 + (1 - vectorWeight) × 文本得分
```

`semanticVectorWeight` 默认 0.7。**文本权重恒为 `1 - vectorWeight`**，不单独暴露 ——
两个都让人调容易调成 1.5 或 0.3，没意义。

### 注入

每轮 model 调用前检索一次，命中的片段拼在最后一条 user 消息**之后**
（放前面会让 prompt cache 前缀全失效）。门槛 `semanticMinScore` 默认 0.62，
最多 `semanticTopK` 条，单条截断 `semanticMaxSnippetChars`。
注入内容带来源标注（会话 / 时间），不会与 `MEMORY.md` 的注入混在一起。

### 实测性能（MacBookPro14,1 / i7-7660U / 2 物理核）

| 场景 | 嵌入 | KNN | 合计 |
|---|---|---|---|
| 索引空闲 | 166–190 ms | 3–6 ms | 169–194 ms |
| 索引运行中 | ~1054 ms | ~6 ms | ~1060 ms |
| 模型冷启动 | — | — | 2617 ms |

索引满载时注入会慢到 1 秒。**接受，不优化**（2 核机器上拆进程或加避让延迟只会让索引更慢）。

---

## 检索：三路分流

`memory_search` / `searchKnowledge` 按查询形态走三条不同的路（照
`nousresearch/hermes-agent` 的 `persistence/sqlite/conversation/_store/search.py`）：

| 查询形态 | 走哪 | 排序 |
|---|---|---|
| 不含 CJK | `messages_fts`（unicode61） | `bm25()` |
| 含 CJK，且**每个 token** 都 ≥3 个 CJK 字 | `messages_fts_trigram` | `bm25()` |
| 含 CJK，且有 token <3 个 CJK 字 | LIKE 全扫，**每 token 一子句、OR 连接** | `timestamp DESC` |

`memory_search` 结果里的「检索方式」回报的是**实际走的路径**，不是按查询长度猜的：

| `via` | 含义 |
|---|---|
| `fts` | unicode61 索引命中 |
| `fts-trigram` | trigram 索引命中 |
| `fts-relaxed` | AND 零命中后放宽成「命中任一词」才找到的（见下） |
| `like` | 子串全扫 |
| `like-fts-stale` | FTS 索引报了错，自动降级到子串全扫 |

### 查询语法

与 FTS5 同构的一个子集，`parseQuery()` 解析一次，FTS 和 LIKE 两处共用（否则会出现
「fts 搜得到、like 搜不到」）：

| 写法 | 语义 |
|---|---|
| `梦境 注入` | 空格 = **隐含 AND** |
| `广西 OR 桂林` | **OR 开新组**，命中任一组即可 |
| `鸭掌木 NOT 换盆` | **NOT 排除**下一个词 |
| `"记忆注入"` | 引号内整串是一个**短语**，要求连续出现 |
| `memo*` | **前缀匹配**（仅非 CJK —— trigram 会把 `*` 当字面星号） |

组内 AND、组间 OR：`A B OR C D` → `(A 且 B) 或 (C 且 D)`，与 FTS5 原生语义一致。

### OR 松弛

多词 AND 查询**零命中**时，自动重试成「命中任一词」（Hermes `_or_relaxed_query`）：

```
查询「hexapod zzznotexist」→ AND 零命中
  → 重试「hexapod OR zzznotexist」→ 2 条，via=fts-relaxed
```

**严格限定触发条件**，否则会毁掉用户明确表达的语义：

- 单组、正向词 ≥2（单词没法松弛）
- 非 CJK（CJK 走 trigram/LIKE，语义不同）
- 用户没写显式 `OR` / `NOT`
- 只在**零命中**时触发 —— 有结果就保持精确匹配语义

### 索引陈旧与降级

FTS 查询抛异常时（索引损坏、MATCH 语法不可用），标记该表陈旧 5 分钟，期间直接走 LIKE：

- **按表分别标记**：trigram 坏了不连累 unicode61 的拉丁查询，反之亦然
- 5 分钟后自动重试，不需要人工介入
- 降级后 `via` 报 `like-fts-stale`，能看出「这次结果是全扫来的」

### 工具名与 tool_calls 也进索引

`messages` 表有两列专门存工具信息，**它们不在正文里**，必须单独索引：

| 列 | 存什么 | 谁写 |
|---|---|---|
| `tool_name` | `bash` / `read` / `memory_search` … | tool 行 |
| `tool_calls` | `[{"id","name"}]` JSON | assistant 行 |

**为什么要单独存**：`joinText()` 只取 `type === "text"` 的块，`tool-call` 块被丢掉 ——
所以 assistant 行的正文里根本没有工具名。

**tool 行的工具名怎么来**：`tool/result` 事件本身**不含工具名**，只有一个 `callId`
（`message.toolCallId` 或 `message.source.callId`）。所以 `extractMessages()`
会先扫**全量** log 建一张 `callId → 工具名` 的映射（来自 assistant 的 `tool-call` 块），
再给每条 tool 行回填。

⚠️ 映射必须扫全量、不能只看增量：增量提取时 tool/result 的 seq 大于 `sinceSeq`，
但对应的 assistant tool-call 块 seq 更小 —— 只看增量会拿不到工具名。

`messages_fts` 是三列索引（`content` + `tool_name` + `tool_calls`），LIKE 路由也是
三列任一命中（`COALESCE(...,'')` 不能省 —— NULL LIKE 返回 NULL，取反时会静默变成不匹配）。

**历史数据没有工具名**：老库迁移时新列全是 NULL，这是预期的 ——
从迁移那一刻起新写入的消息才有。

### 排序、分页、上下文窗口

| 参数 | 说明 |
|---|---|
| `sort` | `rank`（默认，bm25 相关度）/ `newest` / `oldest`。LIKE 路由没有 score，只能按时间 |
| `offset` | 跳过前 N 条，翻页用 |
| `context` | `true` 时每条命中附带**前后各一条**消息（Hermes `_CONTEXT_WINDOW_SQL`）。默认关 —— 文本量变约 3 倍 |

**为什么必须分流（实测数据）：**

- `unicode61` 把连续 CJK 当成**一整个 token** ⇒ `记忆` 0 命中、`梦境` 0 命中
- `trigram` 是 3 码点滑窗 ⇒ **必须 ≥3 个 CJK 字**。`梦`(1)→0、`梦境`(2)→0、`梦境记`(3)→1
- ⇒ **两字中文词在两种 tokenizer 下都永远 0 命中**，只能靠 LIKE 兜底

**为什么判断要逐 token 而不是看整串长度**：`广西 桂林` 总共 4 个 CJK 字看着够长，
但每个 token 只有 2 字，trigram 仍然 0 命中。

**MATCH 表达式构造**：逐 token 加双引号、空格连接（`梦境记忆 注入` → `"梦境记忆" "注入"`）。
空格在 FTS5 里是隐式 AND。**整串包成一个 phrase 是错的** —— 那要求原文连续出现，
多词查询必然 0 命中。

### trigram 的 external-content 源是视图，不是 `messages` 表

```sql
CREATE VIEW messages_fts_trigram_src AS
  SELECT id, content FROM messages
  WHERE role <> 'tool' AND content IS NOT NULL;

CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
  content, content='messages_fts_trigram_src', content_rowid='id', tokenize='trigram'
);
```

**这不是为了省空间，是为了索引合法性。** FTS5 的 external-content 表要求
「源能精确读回索引里的内容」—— `'integrity-check'` 和 `'delete'` 都会回源表按 rowid
取内容比对。若源是 `messages` 原表、而触发器排除了 tool 行，索引就比源少几万行，
检查直接报 `database disk image is malformed`。

（hermes 的 `FTS_STORAGE_VERSION` 走到 **3** 才修掉这个问题：v1/v2 都是「触发器过滤 + 源仍为原表」。
抄它的 SQL 要连版本演进一起看。）

**触发器三个分支的谓词必须与视图逐字一致**：

```sql
-- insert：只写非 tool 行
INSERT INTO messages_fts_trigram(rowid, content)
  SELECT new.id, new.content WHERE new.role <> 'tool' AND new.content IS NOT NULL;

-- delete：也只删非 tool 行（tool 行根本不在索引里，无条件 delete 会破坏一致性）
INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content)
  SELECT 'delete', old.id, old.content WHERE old.role <> 'tool' AND old.content IS NOT NULL;
```

把过滤放进视图之后，`'rebuild'` 命令才会**恢复可用**（它无视触发器、直接扫源，
而源已经过滤过了）。

`_migrateTrigramSrcView()` 的判据**不看 meta 标记**，而是直接查 `messages_fts_trigram`
的实际 `sql` 里有没有 `messages_fts_trigram_src` —— 源不对就重建。这样手改过库、
或从旧备份恢复，都能自动纠正。

### tool 行为什么不进 trigram 索引

- trigram 索引体积约为所覆盖文本的 **2.6 倍**，而 tool 输出占消息字节的 ~67%（本库实测）
- 但**能力不丢**：tool 行完整存在 `messages` 表，仍可被 `messages_fts`（unicode61）搜到；
  显式 `role: ["tool"]` 的查询由 `search()` 检测到 `wantsToolRows` 后强制走 LIKE，
  能拿到完整内容

---

## 排查：SQLite / FTS5 的几个反直觉行为

都是实测踩出来的，**验证一律写临时 node 脚本跑，别用 `sqlite3` CLI**。

1. **`sqlite3` CLI 默认 `trusted_schema=OFF`，`node:sqlite` 默认 `=1`。**
   同一套 DDL，CLI 里报 `unsafe use of virtual table "x"`（尤其触发器里写虚拟表），
   插件里却跑得好好的。**CLI 验出来的「失败」十有八九是假警报。**

2. **external-content 表的 `count(*)` 读的是底层 content 表**，不是索引行数。
   要知道索引里到底有什么，用 `fts5vocab(<表>, 'instance')` 的 `doc` 集合：

   ```sql
   CREATE VIRTUAL TABLE _i USING fts5vocab(messages_fts_trigram, 'instance');
   SELECT count(DISTINCT doc) FROM _i;
   -- 注意：fts5vocab 建在 temp schema 里会报 no such fts5 table，必须建在主 schema
   ```

3. **`'integrity-check'` 才是索引健康的唯一判据**，`count(*)` 和 `MATCH` 都看不出来：

   ```sql
   INSERT INTO messages_fts_trigram(messages_fts_trigram, rank) VALUES('integrity-check', 1);
   ```

4. **判断触发器过滤是否生效，不能拿常见词去 MATCH** —— 该词在别的行里也有
   （本库用「工具输出」测出 1807 条假阳性，实际都是 assistant 消息）。
   要数 `fts5vocab` 的 doc 集合里目标角色的占比。

---

## Web 界面

**左侧菜单「梦境记忆」→ 独立页面**（`main` + `sidebar.panellist` 双注册，同一个 id `dreaming`）。页内三个子 Tab：

1. **梦境日记** — 按日期查，默认今天
2. **晋升沉淀** — 历史晋升记录 + 证据链
3. **记忆注入** — 只读快照：MEMORY.md 与各工作区 USER.md 的字节数、预算占用、是否截断、当前冻结了哪些会话，正文可展开

**设置页（Settings → 梦境记忆）** — 窗口时间、模型、梦境开关、对话沉淀开关/轮数/间隔、语义检索全部参数。

语义检索区块顶部有一行**模型状态**（只读，来自 `vectorStatus.model`，与配置项无关）：

| 状态 | 显示 | 可操作 |
|---|---|---|
| `missing` | `未找到模型` + 下载来源 | 「下载」按钮（`semanticAutoDownload=false` 时改为提示去开开关） |
| `loading` | `下载中 47% · 1.1 MB/s` + 进度条 | — |
| `ready` | `✓ 已就绪 · 313MB` + 文件路径 | 失败时可「重试」 |
| `failed` | 错误码 + 原因 | 「重试」按钮 |

`loading` 期间**索引绝不启动** —— 半截模型嵌出来的向量是垃圾，污染索引比没有索引更糟。
进度必须显示百分比和速度：313 MB 在慢网上要五分钟，只转圈会让人以为卡死。

**RPC 通道** `/dsh-dreaming`（`connection.rpc.handle`，`authority: trusted`）：

| 端点 | 用途 |
|---|---|
| `listDreams` / `getDream` | 梦境列表与单篇 |
| `listPromotions` | 晋升记录 |
| `runNow` | 立即做梦 |
| `status` | 运行状态与下次排程 |
| `memoryStatus` | 注入层快照（只读，不触碰冻结缓存） |
| `vectorStatus` | 语义索引状态：进度、游标、命中统计 + `model` 子对象（四态） |
| `downloadModel` | 后台触发模型下载（未启用语义检索时直接返回 `started:false`） |

`getConfig` / `setConfig` / `listProviders` / `listModels` 走 Typert remote（`remote.dreaming`），不是这条通道。

---

## 配置

`Config`（`index.js`）全部字段都是 `.volatile()`，改完由 loader 提交进运行中的引用，不用重启。

| 字段 | 默认 | 说明 | UI |
|---|---|---|---|
| `workspace` | `homedir()` | 梦境 session 的 cwd 兜底。**真实值应由 profile 显式指定** | — |
| `windowStart` / `windowEnd` | `02:00` / `04:30` | 随机窗口，本地时间 | ✓ |
| `provider` / `model` | 跟随全局默认 | 梦境与提炼用的模型 | ✓ |
| `reasoningEffort` | `high` | 推理等级 | — |
| `stepTimeoutSec` | 不限 | 单步超时，超过被 turn-guard 取消 | — |
| `dbPath` | `~/.dsh/dreaming-memory.db` | 库路径 | — |
| `dreamingEnabled` | `true` | 梦境总开关 | ✓ |
| `nudgeEnabled` | `true` | 对话沉淀总开关 | ✓ |
| `nudgeTurnThreshold` | `10` | 累计多少轮触发一次 | ✓ |
| `nudgeMinGapMin` | `5` | 同会话两次沉淀的最小间隔（分钟） | ✓ |
| `memoryEnabled` | `true` | 对话落库总开关 | — |
| `storeReasoning` | `false` | 是否把 reasoning 也入库（体积大） | — |
| `maxPerTurn` | `2000` | 单 turn 入库条数上限 | — |
| `memoryVerbose` | `true` | 落库与检索日志详细程度 | — |
| `semanticEnabled` | `false` | 语义检索总开关。关掉时其他三条路完全不变 | ✓ |
| `semanticAutoInject` | `true` | 每轮自动注入命中的片段 | ✓ |
| `semanticIntervalMin` | `10` | 追平后的增量同步间隔（分钟） | ✓ |
| `semanticMinScore` | `0.62` | 注入门槛，低于此分不注入 | ✓ |
| `semanticCandidatePool` | `24` | 向量召回候选数，再与文本融合 | ✓ |
| `semanticTopK` | `6` | 最终注入条数上限 | ✓ |
| `semanticVectorWeight` | `0.7` | 混合打分里向量的权重（文本恒为 `1-w`） | ✓ |
| `semanticMaxSnippetChars` | `200` | 单条片段截断长度 | ✓ |
| `semanticAutoDownload` | `true` | 缺模型时是否自动下载 | ✓ |
| `semanticModelDir` | 缓存目录 | 模型所在目录 | — |
| `semanticModelRepo` | `ggml-org/embeddinggemma-300m-qat-q8_0-GGUF` | 下载源仓库 | — |
| `semanticModelFile` | `embeddinggemma-300m-qat-Q8_0.gguf` | 下载源文件名 | — |

⚠️ **加配置字段要改三处**，缺一处就是静默故障：
① `Config` schema ② `setConfig` 白名单 ③ **`scope.get()` 的手写白名单**
（第 ③ 处最容易漏 —— 它只影响 `getConfig` 的回传，表现为设置页永远显示默认值，全程零报错）

代码内另有几处常量（改动需重启）：注入预算 `MAX_TOTAL_BYTES = 10 KB`（`lib/inject.mjs`）、MEMORY 预算 `DEFAULT_MEMORY_BUDGET_BYTES = 10 KB`、晋升阈值（`PROMOTION_MIN_RECALL_COUNT=2` / `CANDIDATE_CONFIDENCE=0.45` / `PROMOTION_MAX_PER_NIGHT=5` / `DEDUPE_THRESHOLD=0.85`）。

---

## 验证

```bash
node test/v2-unit.test.mjs   # store 迁移 / 碎片累计 / 信号晋升 / 预算回收 / 去重
node --check index.js
npx esbuild client.js --loader:.js=jsx --outfile=/dev/null
```

跑完看日志里的 `[dr]` 行确认各层挂载：

```
[dr] 记忆注入层已挂载（…上限 10240B，会话级冻结）
[dr] 梦境数据 RPC 已注册（/dsh-dreaming）
[dr] dreaming: 下次梦境排程于 …
[dr] 记忆注入层：会话 <id> 首次注入 MEMORY <n>B + USER <n>B（cwd=…）
```

语义检索开着时还应看到：

```
[dr] 嵌入模型已就绪：<路径>（313MB）
[dr] 语义索引写入 30 条（本批 30，…ms/条）
[dr] 语义索引第 1 趟完成：近期 <n> 条，hot_max_id=<id>
[dr] 语义记忆注入：命中 <n> 条，最高分 <s>，注入 <n>B（嵌入 …ms，总计 …ms）
```

没有「嵌入模型已就绪」而只有别的，说明停在 `missing`/`failed` —— 去设置页看那一行的状态。

直接验模型文件本身（不启动插件）：

```bash
node --input-type=module -e "
import { probeModel } from '/Users/fatatalia/project/dsh-dreaming/lib/vec-model.mjs';
console.log(await probeModel({}));
"
```

**注意**：`client.js` 是前端 bundle，服务端重启后**浏览器必须刷新**才会看到改动。判断重启是否真的换了代码，看 `ps -p <pid> -o lstart=` 与文件 mtime 的先后 —— `launchctl kickstart` 返回 abort 时进程往往已经重启了。

---

## 开发要点

- **依赖软链**：插件项目要建 `node_modules/@deepseek-ai` → dsh 全局依赖树的软链，否则 import 报 `ERR_MODULE_NOT_FOUND`
- **`connection.rpc.handle` 必须传第三个参数** `{ authority }`（register 读 `options.authority`，缺省会崩）
- **`export const inject` 必须含 `"webServer"`**（dsh 0.1.5 起严格检查），漏了报 `cannot get property "webServer" without inject` 并导致插件加载失败
- **`.volatile()` 字段的形态有两种**：正常写进配置的是裸值；只有解析失败被 autofix 时才会变成
  `Object.freeze({ get })` 包装器。读它一律用
  `const v = (x) => (x && typeof x === "object" && typeof x.get === "function" ? x.get() : x)` 包一层 —
  **直接 `=== true` / `typeof === "string"` 是错的**（2026-11-21 实际栽过：勾选框永远不勾）。
  更常见的坑是 `scope.get()` 那份手写白名单漏字段，见「配置」章节的 ⚠️
- **错误信封必须带 `details`**，否则客户端把它重写成 `connection: invalid server-response failure`，原始错误丢失
- **会话事实在 `session.header`**（`header.cwd` / `header.agentPreset`），不在 `session.meta` —— 后者只在 `agents.create()` 建会话时用
- **改代码后重启**：`launchctl kickstart -k system/com.dsh.web`（HMR 已禁用）

## dsh 版本兼容性

**要求 dsh ≥ 0.1.7-rc.1。** 当前实际运行在 **0.2.2-rc.3** 上（2026-11-20 核对）。

> 三个 peer 依赖实测都满足声明范围：`@deepseek-ai/cordis` `^4.0.1` → 4.1.0 ·
> `dsh-typert-protocol` `>=0.1.0-rc.6` → 0.2.2-rc.3 · `schemastery` `>=3.18.0` → 3.19.0。
> 运行证据：记忆写入持续（`messages` 表最新时间戳即本轮对话），
> `disabling profile plugin` 重启后零新增 —— `session/event` 钩子没被静默禁用。
>
> 下面三项 0.1.7 适配至今仍有效，0.2.x 没有再次改动这几个 API 面。

三项 0.1.7 适配（2026-09-24）：

1. **`ctx.settings.register()` 已移除** —— 原 `dreaming` settings namespace 并入插件 `Config`，`inject` 去掉 `settings`
2. **Typert strict codec 必须带 `create()` 工厂**（客户端与服务端两处）
3. **preset 改为声明式** —— `~/.dsh/.agent-presets/` 文件系统方式废弃，见上文「三份 agent preset」
