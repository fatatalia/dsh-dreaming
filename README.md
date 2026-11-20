# dsh-dreaming — 梦境记忆

dsh 的记忆整合插件。三件事，彼此独立、可单独关掉：

| 模块 | 什么时候跑 | 干什么 | 产物 |
|---|---|---|---|
| **梦境** | 每天凌晨随机窗口一次（默认 02:00–04:30） | 把当天素材写成一篇梦，再把高价值结论晋升回长期记忆 | `dreams` + `promotions` 表，`MEMORY.md` |
| **对话沉淀** | 对话进行中，每累计 N 轮一次 | 把这段对话里以后还有用的东西抄成草稿 | 各工作区 `memory/daily/YYYY-MM-DD.md` |
| **记忆注入** | 每轮 model 调用 | 把长期记忆送进 system prompt | 无（纯注入） |

设计上有一条主线：**LLM 只负责写和提炼，判定交给规则。** 值不值得晋升不是让模型自己说，而是看这条结论在后续对话里被"想起"了几次。

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
│   └── agent-setup.mjs      # agent 装配
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

**`MEMORY.md`** — `~/.dsh/MEMORY.md`，只追加 `## YYYY-MM-DD — 梦境沉淀（dsh-dreaming）` 段。

---

## Web 界面

**左侧菜单「梦境记忆」→ 独立页面**（`main` + `sidebar.panellist` 双注册，同一个 id `dreaming`）。页内三个子 Tab：

1. **梦境日记** — 按日期查，默认今天
2. **晋升沉淀** — 历史晋升记录 + 证据链
3. **记忆注入** — 只读快照：MEMORY.md 与各工作区 USER.md 的字节数、预算占用、是否截断、当前冻结了哪些会话，正文可展开

**设置页（Settings → 梦境记忆）** — 窗口时间、模型、梦境开关、对话沉淀开关/轮数/间隔。

**RPC 通道** `/dsh-dreaming`（`connection.rpc.handle`，`authority: trusted`）：

| 端点 | 用途 |
|---|---|
| `listDreams` / `getDream` | 梦境列表与单篇 |
| `listPromotions` | 晋升记录 |
| `runNow` | 立即做梦 |
| `status` | 运行状态与下次排程 |
| `memoryStatus` | 注入层快照（只读，不触碰冻结缓存） |

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

**注意**：`client.js` 是前端 bundle，服务端重启后**浏览器必须刷新**才会看到改动。判断重启是否真的换了代码，看 `ps -p <pid> -o lstart=` 与文件 mtime 的先后 —— `launchctl kickstart` 返回 abort 时进程往往已经重启了。

---

## 开发要点

- **依赖软链**：插件项目要建 `node_modules/@deepseek-ai` → dsh 全局依赖树的软链，否则 import 报 `ERR_MODULE_NOT_FOUND`
- **`connection.rpc.handle` 必须传第三个参数** `{ authority }`（register 读 `options.authority`，缺省会崩）
- **`export const inject` 必须含 `"webServer"`**（dsh 0.1.5 起严格检查），漏了报 `cannot get property "webServer" without inject` 并导致插件加载失败
- **`.volatile()` 字段读出来是 Value 包装**，要用 `.get()`，直接当值用会静默出错
- **错误信封必须带 `details`**，否则客户端把它重写成 `connection: invalid server-response failure`，原始错误丢失
- **会话事实在 `session.header`**（`header.cwd` / `header.agentPreset`），不在 `session.meta` —— 后者只在 `agents.create()` 建会话时用
- **改代码后重启**：`launchctl kickstart -k system/com.dsh.web`（HMR 已禁用）

## dsh 版本兼容性

**要求 dsh ≥ 0.1.7-rc.1。**

三项 0.1.7 适配（2026-09-24）：

1. **`ctx.settings.register()` 已移除** —— 原 `dreaming` settings namespace 并入插件 `Config`，`inject` 去掉 `settings`
2. **Typert strict codec 必须带 `create()` 工厂**（客户端与服务端两处）
3. **preset 改为声明式** —— `~/.dsh/.agent-presets/` 文件系统方式废弃，见上文「三份 agent preset」
