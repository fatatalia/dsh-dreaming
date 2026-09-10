# dsh-dreaming — 梦境记忆整合插件（v2）

每天凌晨**随机时间**（默认 02:00-04:30 窗口）把当天的记忆"梦境化"：引擎预取 Hindsight 记忆碎片，交给**裸上下文 narrative 会话**写纯梦日记；高价值洞察由**信号驱动规则**判定（无 LLM、无关键词白名单）并晋升回 MEMORY.md；梦境与晋升记录存 SQLite，web 端"梦境" Tab 展示。随 dsh web 启停。

**v2 核心哲学：LLM 只写梦，判定交给行为学信号。**（对齐 OpenClaw Dreaming）

## 工作原理（v2 闭环）

```
凌晨随机时刻触发（可手动"立即做梦"）
  → 引擎多查询 recall（Hindsight HTTP 127.0.0.1:8888，4 个不同角度查询）
  → 去重 + 碎片化（每条 ≤280 字符，编号+来源）→ 注入 narrative 会话
  → 创建 dream-narrative 专属 preset 会话（裸上下文：不注入 AGENTS.md、无工具）
       persona = 梦境 prompt（complete:true），user message 只含碎片
  → 生成纯梦日记（第一人称 150-300 字，禁"我在做梦"/禁 AI 自指/纯散文）
  → 信号驱动晋升（纯规则）：
       · uniqueQueries（不同查询命中数）≥2 硬门槛
       · 量化评分 confidence = 得分×0.45 + 对数命中×0.25 + 实体丰富度×0.1
       · 候选 ≥0.45；相似度 0.85 去重；promotions 表查重防重复；上限 5 条/夜
  → 梦境日记 → SQLite dreams 表
  → 洞察 → SQLite promotions 表（含 evidence/rule 证据链）+ MEMORY.md 追加
  → MEMORY.md 预算管理：超 25KB 只删「梦境沉淀」最老标记段，手写内容永不触碰
  → 会话归档，重排下一次
```

## 目录

```
dsh-dreaming/
├── index.js              # host 插件：connection.rpc 数据通道 + 引擎装配
├── client.js             # 浏览器 bundle：conversation.view "梦境" Tab
├── lib/
│   ├── dream-engine.mjs  # v2：多查询 recall + narrative 会话 + 信号晋升 + 预算
│   └── store.mjs         # SQLite：dreams + promotions + recall_stats 表
├── test/v2-unit.test.mjs # 单元测试（node test/v2-unit.test.mjs，14 项）
├── docs/
│   ├── v2-plan.md        # v2 完整方案（设计依据）
│   └── prompt-v2-draft.md
├── cordis.patch.yml
└── package.json
```

## 数据

- **SQLite**：`~/.dsh/dreaming.db`
  - `dreams`（梦境日记正文）
  - `promotions`（晋升洞察 + `evidence` 来源/命中数/实体 + `rule` 触发信号名）
  - `recall_stats`（跨天"被想起"信号：命中次数 / 不同查询数 / 首见·最近命中日期 / 是否已晋升）
- **MEMORY.md**：只追加「## YYYY-MM-DD — 梦境沉淀（dsh-dreaming）」段；预算超限自动回收最老标记段

## 专属 agent preset

`~/.dsh/.agent-presets/dream-narrative/`（dsh agent-presets 用户根目录）：

- persona = 梦境 prompt（`complete: true` + `includeRuntimeContext: false`）
- **不挂** `agent-instructions`（不注入 AGENTS.md 人格/工作区指令）
- **不含任何工具**（素材引擎注入，写梦不碰 exec/fs/网络）

效果 = OpenClaw narrative 的 `lightContext: true`（bootstrap 引导文件全清空）。

## web Tab

会话页 `conversation.view` 槽位注册"梦境"Tab（同 dsh-automation 模式）：
- 晋升记录（日期 + 内容 + 证据链）+ 梦境日记列表（日期 + 正文）
- "立即做梦"按钮、刷新
- 数据经 `connection.rpc` 通道 `/dsh-dreaming`（listDreams / listPromotions / getDream / runNow / status）

## 配置（代码内常量，后续可参数化）

- 随机窗口：`DEFAULT_WINDOW = { start: "02:00", end: "04:30" }`（dream-engine.mjs）
- MEMORY.md 路径：`~/dsh/mayacode/MEMORY.md`
- 晋升阈值：`PROMOTION_MIN_RECALL_COUNT=2` / `CANDIDATE_CONFIDENCE=0.45` / `PROMOTION_MAX_PER_NIGHT=5` / `DEDUPE_THRESHOLD=0.85`
- MEMORY.md 预算：`DEFAULT_MEMORY_BUDGET_BYTES = 25 * 1024`

## 验证

```
node test/v2-unit.test.mjs   # 14 项：store 迁移 / 碎片累计 / 信号晋升 / 预算回收
```

手动触发一次梦境：POST 到 `http://127.0.0.1:3080/dsh-dreaming/runNow`，信封 `{"type":"client-request","rpcId":"x","method":"runNow","payload":{}}`。检查 `/var/log/dsh-web.log` 的 `[dr]` 日志与 `~/.dsh/dreaming.db`。

## 开发要点

- 新插件项目必须建依赖软链（`node_modules/@deepseek-ai` → dsh 全局依赖树），否则 import 报 ERR_MODULE_NOT_FOUND
- `connection.rpc.handle` 必须传第三个参数 `{ authority }`（register 读 options.authority，缺省会崩）
- **inject 必须声明 `webServer`**（dsh 0.1.5 起严格检查）：index.js 的 `export const inject` 需含 `"webServer"`，漏了报 `cannot get property "webServer" without inject`，插件加载失败（2026-09-10 踩过）
- 改代码后重启 web 生效（HMR 已禁用）：`launchctl kickstart -k system/com.dsh.web`