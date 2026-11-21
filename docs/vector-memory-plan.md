# 向量记忆改造方案 v3（定稿）

> 2026-11-21 定稿。全部数字来自本机实测，非估算。
> **状态：待实施。阶段 1 未开始。**
>
> v2 → v3 变更：`minScore` 0.35 → **0.62**（扫了 24 个真实查询的分数分布），
> 建库候选 14,743 → **14,632**（排除 179 条汇总消息），补三处实测坑。
>
> **配套文档：`ui-plan.md`** —— 设置页分组、三级开关、索引进度条、限速与暂停。
> 本文件讲「怎么实现」，那份讲「界面上怎么用」。

---

## 一、要解决的问题

`memory_search` 现在只有关键词检索（FTS5 trigram + LIKE）。实测两个盲区：

| 查询 | 现在 | 原因 |
|---|---|---|
| 「二号机满了要换袋吗」 | **0 条** | 字面没有共同字符串 |
| 「鸭掌木要浇水了」 | top1 精确 | 但换个说法就废 |

**加向量补这块。但纯向量会泛化过头** ——「鸭掌木」被「浇水」这个动作带走，
返回金钱草、发财树。**所以最终形态是混合：关键词钉实体，向量连概念。**

---

## 二、实测依据

### 组件（均已本机跑通）

| 项 | 值 |
|---|---|
| 模型 | `embeddinggemma-300m-qat-Q8_0.gguf`，313 MB，768 维 |
| 运行时 | `node-llama-cpp` 3.19.0，纯 CPU |
| 向量索引 | `sqlite-vec` v0.1.9（`vec0.dylib`） |
| 模型加载 | 一次性约 2.5 s |
| 单条嵌入 | 短文本 17–63 ms；**全量建库均 329 ms** |

### 全量建库（已完成）

```
14,743 条 / 4,855.7 s（81 分钟）/ 均 329 ms / 库 53.3 MB
```

### 召回质量（24 个真实历史提问，144 条 top6）

```
max 0.966   p90 0.782   p75 0.742   中位 0.705   p25 0.677   min 0.584

0.80-1.0   10 条
0.70-0.80  66 条  ← 46%
0.65-0.70  53 条  ← 37%
0.60-0.65  14 条
0.55-0.60   1 条
0.50 以下   0 条  ← 一条都没有
```

**逐条人工判断的内容质量：**

```
「shadowrocket 域名支持通配符么」   6/6 相关
  0.841 但是我记得你说过 shadowrocket 里面域名不能通配？
  0.762 不支持。Shadowrocket 的 [Host] 段采用精确匹配...
  0.751 你记得对，是我刚才说错了。11-03 你问过同一个问题...

「看看现在还有哪些待办没完成」      6/6 相关（0.714–0.757）
「HA 容器可以设置 dns 么」          5/6 相关
「阿里云上的 wg 有配置 dns 么」      4/6 相关
```

### 三项架构验证

**① 主库能加载 vec0**

```
扩展加载成功 ✓
vec0 建表成功 ✓
原有 46,203 条数据仍可读 ✓
```

**② 扩展挂了主库不跟着瘫痪**（决定性）

```
loadExtension 抛异常 ✓
连接仍可用，能读 46,203 条 ✓
普通表读写正常 ✓
vec0 表报错（预期）: no such module: vec0 ✓
```

**③ vec0 能被触发器删**

```
✓ 触发器生效，vec 剩 1 行
```

---

## 三、架构：单库

```
~/.dsh/dreaming-memory.db   （206 MB → 实测 53 MB 向量，合计约 260 MB）
├─ messages              已有，INTEGER PRIMARY KEY AUTOINCREMENT
├─ messages_fts          已有
├─ messages_fts_trigram  已有
├─ dreams / knowledge_*  已有
├─ meta                  已有
├─ messages_vec      ★ vec0 虚拟表
├─ vec_state         ★ 水位线 + 模型指纹
└─ 触发器 ×2         ★ 删除即删、更新即失效
```

**为什么单库而不是独立 `dreaming-vec.db`** —— 原方案拆库的理由是「隔离风险」，
验证后不成立（扩展挂了只影响 vec0 表）。换来的收益是实打实的：

| | 双库 | 单库 |
|---|---|---|
| 删除清理 | ATTACH + `NOT IN` 全表扫 | **触发器 O(1)** |
| 更新检测 | 做不了 | **触发器** |
| 事务一致 | 无 | **有** |
| 悬空引用 | 可能 | **不可能** |

---

## 四、表结构

```sql
-- ① 向量表
CREATE VIRTUAL TABLE IF NOT EXISTS messages_vec USING vec0(
  id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);

-- ② 状态
CREATE TABLE IF NOT EXISTS vec_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO vec_state(key, value) VALUES
  ('watermark_id', '0'),
  ('hot_max_id', '0'),      -- 第 1 趟（近期）已覆盖到的最大 id；0 = 未做
  ('model', 'embeddinggemma-300m-q8'),
  ('dim', '768');

-- ③ 删除即删向量
CREATE TRIGGER IF NOT EXISTS messages_vec_cleanup
AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_vec WHERE id = OLD.id;
END;

-- ④ 内容变了 → 删旧向量，等下一轮重算
CREATE TRIGGER IF NOT EXISTS messages_vec_invalidate
AFTER UPDATE OF content ON messages
BEGIN
  DELETE FROM messages_vec WHERE id = OLD.id;
END;
```

**`model` + `dim` 是安全阀**：换模型时向量空间变了，启动对不上就**拒绝使用旧向量**，
而不是给出「看起来正常但错误」的结果。

**触发器里不直接算向量** —— SQLite 触发器没法调 embed。只做删除，
新增由定时任务扫水位线补。

---

## 五、增量判据

**水位线 = 已入库的最大 `message.id`。**

```sql
SELECT id, role, content FROM messages
WHERE id > CAST((SELECT value FROM vec_state WHERE key='watermark_id') AS INTEGER)
  AND role IN ('user','assistant')
  AND length(content) >= 10
  AND session_id NOT LIKE 'dreaming-%'
  AND content NOT LIKE '%automatically generated checkpoint%'
ORDER BY id;
```

**安全性依据（实测）：**

```
id INTEGER PRIMARY KEY AUTOINCREMENT   ← 单调递增，永不复用
max-min+1 = 46,765   实际 count = 46,203   差 562 条（删过）
id 断档处: 438
```

`AUTOINCREMENT` 保证 id 不复用 ⇒ 水位线不会漏。删除的已由触发器同步清掉
⇒ 不会有悬空引用。

**为什么不用 OpenClaw 的 `revision` 计数器** —— 它用 6 个触发器维护计数，
让上层去对账（`openclaw-agent-db-DKpxi-Ll.js:89-127`）。我们是同库，
**可以直接同步删**，比「标记 + 对账」更简单也更可靠。

---

## 六、定时同步

**照抄我们自己的 `dream-engine.mjs:513`：**

```js
scheduleNext() {
  if (this._timer !== null) { clearTimeout(this._timer); this._timer = null; }  // 防重入
  this._timer = setTimeout(async () => {
    try { await this.syncOnce(); }
    catch (e) { this.log?.error?.(...) }
    finally { this.scheduleNext(); }        // 跑完再排，不堆积
  }, this.intervalMs);                       // 默认 10 分钟
}

dispose()        { clearTimeout(this._timer); this._timer = null; }   // 插件卸载
pauseSchedule()  { clearTimeout(this._timer); this._timer = null; }   // 开关关闭
```

**`syncOnce()` 流程：**

```
① 若 hot_max_id == 0（从未建过）→ 先跑第 1 趟（近期优先），见下
② 取 watermark
③ SELECT 新消息（条件见第五节）
④ 逐条 slice(0,3000) → 子进程 embed → INSERT messages_vec
⑤ 每 100 条推进一次 watermark（崩溃后只重算一小段）
⑥ 全部完成 → watermark = max(id)
```

**每 100 条推进一次** —— 中途崩溃最多重算 100 条，不会从头再来。

### 两趟建库：近期优先

**全量按 `id` 正序建有个大问题：`id` 小的 = 旧消息，建到 50% 时索引的是
最早那一半，最新的反而一条都没有。而检索最常要的恰恰是近期记忆。**

**所以首次建库分两趟：**

```
第 1 趟（warm up）  最近 20% 的消息，上限 5000 条
                   SELECT ... ORDER BY id DESC LIMIT min(maxId * 0.2, 5000)
                   完成后写 hot_max_id = 本趟覆盖的最小 id，
                   并用 watermark 跳到「第 1 趟覆盖范围之前」，
                   使第 2 趟自然跳过已建的部分
第 2 趟（full）     剩下的从旧往新建，正序推进 watermark
```

**20% 与 5000 都是比例/上限，不是绝对条数** —— 小库（1000 条）取 200 条，
大库（100 万条）取 5000 条封顶。**公共插件不能写死绝对条数。**

**收益：前约 15% 的时间就能让近期记忆可用**，而不是等到全部建完。
全量索引在慢机器上可能要数小时，这个差别是「能不能用」的差别。

**代价：多一个 `hot_max_id` 状态字段，`phase` 多一档 `warming`。**

**第 1 趟不推进 `watermark`** —— 水位线的语义保持"连续覆盖到哪"不被破坏。
第 2 趟开始时把 `watermark` 设为第 1 趟覆盖的最小 id 减 1，两者拼起来正好无缝。

---

## 七、检索与混合打分

### 并发两路

```
用户消息
  ├→ embed → 向量 KNN top-24（过采样 160 后过滤）约 100–400 ms
  └→ MemoryDB.search(limit=48) → 取 24         约 5–20 ms
       ↓
  合并去重 → 混合加权
       ↓
  minScore 0.62 过滤 → 同 session 最多 2 条 → top 6
```

### 向量侧查询

```sql
SELECT m.id, m.session_id, m.role, m.content, m.timestamp,
       vec_distance_cosine(v.embedding, ?) AS d
FROM messages_vec v JOIN messages m ON m.id = v.id
WHERE v.embedding MATCH ? AND k = 160
ORDER BY d
```

⚠️ **`ORDER BY d` 必须显式写，不能省。** 实测 `vec0` 的 KNN 返回**不保证按距离排序**，
而且它不报错：

```
id=47985  dist=0.2487   ← 排第一
id=48492  dist=0.2236   ← 更近，却排第二
```

漏掉的表现是「结果看起来都对，但顺序就是不对」，极难查。

`score = 1 - dist`，天然在 [0,1]。

**过采样 ×4 = 24**，不照抄 OpenClaw 的 ×8 —— 2 核机器，省算力。

### BM25 归一化（照抄 OpenClaw `manager-DB4_iNu4.js:394`）

```js
function bm25RankToScore(rank) {
  if (!Number.isFinite(rank)) return 1e-3;
  if (rank < 0) { const rel = -rank; return rel / (1 + rel); }
  return 1 / (1 + rank);
}
```

⚠️ **`db.search` 的 LIKE 路由 `score` 硬编码为 `0`**，
`bm25RankToScore(0) = 1.0` —— **满分**。不处理会让 LIKE 噪音盖过真命中：

```js
const txtRaw = r.via === 'like' ? 0.25 : bm25RankToScore(r.score);
```

### 关键词零命中时的归一化（实测必须）

关键词池为空时很常见（5 个测试查询里有 4 个），朴素加权 `0.7×vec + 0.3×0`
等于**凭空打七折**：

```
「为什么 9092 端口不响应」  关键词 0 条
  OpenClaw 0.7/0.3  → 最高 0.478   （0.682 × 0.7）
  text-lean 0.4/0.6 → 最高 0.273   ← 低于 minScore，全部误杀
```

**修正：按「实际参与的分支」重新归一。**

```js
const hasText = pool.some(e => e.txt > 0);
const denom = hasText ? 1 : vw;              // 无关键词时不乘 text 权重
score = (vw * e.vec + tw * e.txt) / denom;
```

> 判定用「整个候选池有没有 text 分」，不是「本次关键词命中数」——
> 池是两路合并的，只要有任何一条带 text 分，就走正常加权。

**OpenClaw 没有这一步**（`manager:402-445`）——它靠 0.7/0.3 的权重让
`0.7 × 0.68 = 0.478 > 0.35` 侥幸不触发，是**避开**不是**解决**。

### 单路命中必须按单路归一（否则一半结果直接失效）

**上面那个 `denom` 只解决"整个池子没有关键词分"，解决不了"某一条只有一路分"。**

朴素加权下：

```
某条只有关键词命中（向量还没有它）：
  score = 0.7 × 0 + 0.3 × txt = 0.3 × txt     最高 0.3
  minScore = 0.62
  → 永远过不了阈值
```

**这不是边缘情况**：任何消息**刚入库、还没被索引进程处理**的那几分钟，就处于这个状态。
索引建立期间更是**大部分消息**都处于这个状态。

**修正 —— 按实际有分的路归一：**

```js
let score;
if (e.vec > 0 && e.txt > 0)      score = (vw * e.vec + tw * e.txt) / 1;
else if (e.vec > 0)              score = e.vec;
else if (e.txt > 0)              score = e.txt;
```

**副作用是"强关键词命中会排到前面"** —— 这是对的，字面完全匹配本就该优先于弱语义相似。

### 三条抑制规则

1. **回声抑制** —— 排除当前 `session_id`。实测不排除时，检索结果里全是
   我们刚才的对话，把真正的历史全挤掉
2. **低分丢弃** —— `minScore 0.62`。**宁可没有，不要噪音**
3. **重复抑制** —— 同一 session 最多 2 条，避免一段对话霸屏

### minScore 为什么是 0.62

**扫了 24 个真实历史提问，144 条 top6，最低 0.584。** 逐条判断内容质量后：

| 阈值 | 精确查询表现 | 泛查询表现 |
|---|---|---|
| 0.35 | 「鸭掌木」注入 5 条，**2 条相关**（0.52–0.53 是别的植物） | 5 条噪音 |
| 0.60 | 2 条，**2/2** | 4 条噪音 |
| **0.62** | 2 条，**2/2** | **4 条噪音** |

**五个查询在 0.62 下的表现：**

| 查询 | 注入 | 相关 |
|---|---|---|
| 鸭掌木要浇水了 | 2 | **2/2** ✓ |
| 为什么 9092 不响应 | 2 | **2/2** ✓ |
| 二号机满了要换袋吗 | 5 | **5/5** ✓ |
| 向量检索怎么做 | 4 | 0/4 ✗ |
| 路由器配置对不对 | 5 | 1/5 ✗ |

**对比 `minScore 0.35` 时只有 1/5 达标 —— 这是实质进步。**

**泛查询救不了，这是事实：** 这类问题的结果全挤在 0.63–0.69，和精确命中（0.64–0.68）
分数重叠，**任何阈值都切不开**。原因不在检索，在于「这类问题本来就该我回答，
不是翻历史」。而且 24 个真实样本里**一个泛查询都没有**。

---

## 八、注入

### 模板（照抄 `dsh-time-context` / `dsh-agent-loop`）

```js
import { createUserMessage } from "@deepseek-ai/dsh-llm";

ctx.on("agent/pre-step", async (payload, next) => {
  const decision = await next();                    // ← 必须先调
  if (decision.kind === "reject" || payload.signal.aborted) return decision;

  const hits = await searchHybrid(lastUserText(payload.messages));
  if (!hits.length) return decision;                // ← 无命中就不注入

  const body = hits.map((h, i) =>
    `${i+1}. (${fmtDate(h.timestamp)}) ${h.snippet}`).join("\n");

  return {
    ...decision,
    messages: [...decision.messages, createUserMessage({
      content: [{ type: "text",
        text: `<system-reminder>\n以下是与你当前问题可能相关的历史记忆，`
            + `仅供参考，可能已过时；涉及当前状态时请重新核实：\n\n${body}\n</system-reminder>` }],
      source: {
        kind: "memory-vector",
        form: "snapshot",             // ← 前端认这个，渲染成可折叠卡片
        sections: [{ name: "记忆检索", text: body }],
      },
    })],
  };
}, { prepend: true });
```

### 四个要点

1. **`form: "snapshot"`** —— dsh 定义的类型值（`dsh-llm/lib/types/message.d.ts:52`），
   要求带 `sections`。前端 `dsh-client-ui-conversation` 据此渲染 ——
   **这就是「web 页面能看到这次注入」的机制，不用自己写前端。**
2. **`source.kind` 用本插件名** —— 与 `time-context`、`agent-loop` 区分
3. **`await next()` 必须先调** —— 否则盖掉别的注入器
4. **无命中就不注入** —— 没东西就不产生消息，不留空壳

### 为什么不能走 `systemPrompt.section`

实测类型定义（`dsh-system-prompt/lib/types/index.d.ts:60`）：

```ts
readonly text: string | ((context: AssembleContext) => string);
```

**只吃同步函数。** 向量检索是异步的，放不进去。

现有的 MEMORY.md / USER.md 注入走 section（`inject.mjs:165`），**保持原样不动。**

### prompt cache 友好

注入固定在**最后一条 user 消息之后**：

```
[...历史...] [user 本次问题] [注入的记忆] ← 只影响尾部
```

前面不变，前缀缓存保住。

---

## 九、配置

**实现用的是平铺字段**（`semanticEnabled` 这一组），不是嵌套的 `memorySearch.semantic`。
理由：与插件里已有的 8 个记忆配置项同风格，`.volatile()` 热改路径已验证可用，
设置页 `save()` 的字段列表也不用做嵌套展开。下面按分组列，字段名就是真实键名。

```yaml
# ① 总开关
semanticEnabled: false         # 关掉则完全不加载 vec0、不启嵌入子进程
# ② 自动注入（仅 semanticEnabled 为真时有效）
semanticAutoInject: true       # 关掉 = 只索引不注入
# ③ 节奏
semanticIntervalMin: 10        # 增量索引间隔（分钟）
# ④ 质量
semanticMinScore: 0.62
semanticCandidatePool: 24
semanticTopK: 6
semanticVectorWeight: 0.7      # ← textWeight 恒为 1 - 此值，不单独配置
semanticMaxSnippetChars: 200
```

**三级开关：**

| semanticEnabled | semanticAutoInject | 行为 |
|---|---|---|
| false | — | 完全关闭，与加此功能前一致 |
| true | false | 只索引不注入（`memory_search` 能用向量，prompt 里不出现） |
| true | true | 全开 |

数值配置全部走 `numCfg()` 兜底：非法值（NaN / 超范围）一律回落默认，
**公共插件不能因为填了脏数据就崩**。

**`textWeight` 不单独暴露，恒为 `1 - vectorWeight`** —— 两个权重独立填时，
若用户填 `0.3 / 0.3`，总分整体缩到 0.6 倍，**所有结果被 minScore 静默误杀**，
表现为"检索突然变差了"且不报错。这条必须在代码里强制。

**`enabled: false` 时：**

- 不启动定时器
- 不挂 `agent/pre-step`
- `memory_search` 走原路径（纯 FTS5）
- **行为与现在完全一致**

**扩展加载失败时自动降级**，不走配置：`vec0` 不可用 → 向量分支静默跳过 → 纯关键词。

---

## 十、新文件

| 文件 | 职责 |
|---|---|
| `lib/vec-store.mjs` | 建表、触发器、水位线读写、KNN 查询（BigInt 封装在这） |
| `lib/vec-embed-child.mjs` | 子进程 worker：收文本 → 回向量，串行队列 |
| `lib/vec-embed.mjs` | 主进程侧：子进程生命周期、请求应答、超时 |
| `lib/vec-hybrid.mjs` | 混合打分（BM25 归一化 + 零命中归一 + 去重） |
| `lib/vec-sync.mjs` | 定时同步（`scheduleNext` 那套） |
| `lib/vec-inject.mjs` | `agent/pre-step` hook |
| `scripts/vec-backfill.mjs` | 离线全量补（首次灌库用） |

**改动只有一处** —— `index.js` 的 `apply()` 里加：

```js
applySemanticMemory(ctx, cfg.memorySearch?.semantic, log);   // 在 applyPromptInjection 之后
```

---

## 十一、必须记住的坑

### ⓪ `distance_metric=cosine` 必须显式写（2026-11-21 实测踩的）

**这是整轮实现里最贵的一个坑，而且不报错。**

`vec0` 建表默认用 **L2 平方距离**。而 `node-llama-cpp` 的 `getEmbeddingFor()`
返回的向量**没有归一化** —— 实测模长 **28.49**（768 维）。

后果：

```
L2 距离实测 25.29
score = 1 - dist = 1 - 25.29 = -24.29
```

**所有分数变成负数，`minScore=0.62` 一条都过不了 → 检索永远返回空。
不抛异常、不写日志，看起来像「库里没有相关内容」。**

建表时显式指定：

```sql
CREATE VIRTUAL TABLE messages_vec USING vec0(
  id INTEGER PRIMARY KEY,
  embedding FLOAT[768] distance_metric=cosine
);
```

改后 `distance = 1 - cos_sim ∈ [0, 2]`，`1 - dist` 直接就是余弦相似度。

**验算（同一向量 / 相近 / 相反）：**

| 输入 | cos_dist | 说明 |
|---|---|---|
| 自身 | 0.000000 | ✓ |
| 相邻一维 | 0.001554 | ✓ |
| 取反 | 2.000000 | ✓ 余弦距离上界 |

**为什么之前的试验脚本没暴露**：那版借用 openclaw 的 llama provider，向量是归一化过的；
换成项目内的 `node-llama-cpp@3.19.0` 后行为变了。**换了嵌入实现必须重验距离度量。**

`vec_state` 里记 `metric=cosine`，指纹校验会拒绝复用 L2 建的旧库。

### ⓪′ 向量命中不带正文，必须回查

`queryKnn()` 只返回 `{id, dist}` —— 没有 `content`、`session_id`。
直接喂给 `mergeHybrid` 会得到「分数正确、片段全空」的结果，且**回声抑制也失效**
（它依赖 `sessionId` 判当前会话）。

所以 `mergeHybrid` 加了 `fetchRows` 回调：

```js
mergeHybrid({
  vecHits,
  fetchRows: (ids) => V.getMessagesByIds(db.db, ids),   // 只回查还没正文的那部分
  ...
})
```

回查放在**回声抑制之前** —— 顺序反了就等于没排除。

### ⓪″ `hot_max_id` 只能在第 1 趟**完整跑完**后写

`hot_max_id = H` 的语义是「**id > H 的都已有向量**」。

第 1 趟按 `--limit` 截断或中途 Ctrl-C 时，只建了最近 N 条，中间一大段还没建。
此时若照写，那一段会被标记成「已覆盖」而**永远不会补**。

实测：`--limit 50` 时 `hot_max_id=40011`，而只建了 40,012..40,228 ——
**中间 8,751 条被静默漏掉**。

```js
const warmComplete = warmSlice.length === warmRows.length;
if (warmComplete) {
  hotMax = warmRows[0].id - 1;
  V.setHotMaxId(db, hotMax);
} else {
  log("第 1 趟中断，不写 hot_max_id，下次重跑");
  throw { done: true };
}
```

### ① BigInt

`node:sqlite` 绑 JS number 时按 **double** 传，vec0 的 INTEGER 主键不接受：

```
Error: Only integers are allows for primary key values on messages_vec
```

```js
stmt.run(BigInt(row.id), vectorBytes);   // ✓
stmt.run(row.id, vectorBytes);            // ✗
```

**反过来，查询结果的 id 也是 BigInt**，`JSON.stringify` 直接炸。取出要 `Number(row.id)`。

**两处都封在 `vec-store.mjs` 里，外面不感知。**

### ② 建库必须排除 `role='system'`

```
assistant  11,472 条   2.16M 字符   均 188
user        3,754 条   0.92M 字符   均 244
system      1,903 条  17.23M 字符   均 9,054   ← 76% 字符量，全是重复系统提示词
```

早期实测没排除，平均耗时从 30–63 ms 飙到 676–1250 ms。

### ③ 建库必须排除汇总类消息（实测 179 条）

```
梦境素材   178 条  45.0 万字符  均 2,530 字    ← 「今天的素材：[1] …」
压缩摘要     1 条   2.8 万字符  均 27,729 字   ← 「This is an automatically generated checkpoint…」
```

**占 1.2% 条数，却占 17% 字符量。** 实测不排除时，「鸭掌木要浇水了」的前几名
全是这类汇总，把真正的历史对话挤到后面。

**排除后候选 = 14,632 条。**

### ④ 超长截断

`>3000` 字的极少（system 已排除），统一 `slice(0, 3000)`。

**不切块分片** —— OpenClaw 切块（400 token / 80 重叠）是因为它索引文件；
我们的消息天然带 id，切块会让一条变多条，注入时不好还原。

### ⑤ 子进程隔离

`node-llama-cpp` 是 C++ 原生绑定，崩了会拖垮整个 dsh 进程（所有会话全断）。
**必须独立子进程**，串行队列，一次一条。

### ⑥ 扩展加载要 try/catch

已验证失败不影响主库，但**必须包住**，否则插件 `apply()` 直接抛异常，
整个 dreaming 插件起不来。

---

## 十二、实施阶段

### 阶段 0：验证（✅ 已完成）

- ✅ 三个组件本机跑通
- ✅ 全量 14,743 条建库（81 分钟 / 53.3 MB）
- ✅ 24 个真实查询的分数分布扫描
- ✅ 五组查询的混合配比对比

### 阶段 1：查询侧（不改任何自动行为）

- `vec-store.mjs`：建表 + 触发器 + 水位线
- `vec-embed-child.mjs` / `vec-embed.mjs`：子进程嵌入
- `vec-hybrid.mjs`：混合打分（四条修正全在这）
- `scripts/vec-backfill.mjs`：全量灌一次
- `memory_search` 加向量分支（**手动调用，不自动注入**）
- 验证：同一查询，加向量前后召回对比

**出问题删 `messages_vec` 表就回到原状。**

### 阶段 2：索引侧（含界面）

- `vec-sync.mjs`：定时增量 + `status()` / `pause()` / `resume()`
- `index.js`：switch 加 `vectorStatus` / `vectorPause` / `vectorResume`
- `client.js`：① 删冻结会话卡 ② 设置页「向量检索」分组 + 首次确认弹窗 ③ 索引状态卡 + 轮询

**顺序不能反** —— 先改前端会拿到 `undefined`，页面直接崩。
和 11-06 那次「删硬件历史代码连带切掉 `readHardware`」是同一类错误。

**这一阶段能验证索引质量**（页面上直接看进度和条数），
据此再决定阶段 3 要不要开。

### 阶段 3：自动注入

- `vec-inject.mjs`：`agent/pre-step` + `form: "snapshot"`
- **默认关闭**（`autoInject: true` 但 `enabled: false`）
- 开之前测：注入 2–6 条对 prompt 的实际影响（约 +0.5–1.5 KB）

**依赖顺序：** 阶段 1 能给手动调用 → 阶段 2 能在页面上看见索引 →
阶段 3 才自动往 prompt 里塞。**前两阶段都可单独回退。**

---

## 十三、验收标准

改造算成功，要**同时**满足：

1. **「二号机满了要换袋吗」能召回猫砂盆相关**（现在 0 条）✅ 已证：5/5
2. **「鸭掌木要浇水了」top1 仍是精确那句**（不被泛化带走）✅ 已证：0.797 精确
3. **单轮额外延迟 < 500 ms** ✅ 已证：embed 17–60 ms
4. **注入的条数里人工判断 ≥ 80% 相关**
5. **关掉开关后行为与现在完全一致**

**第 1、2 条已用实测量化验证。第 4 条在精确查询上达标（2/2、5/5），
泛查询不达标——已知且接受。**

---

## 十四、明确不做的

| 项 | 决定 | 理由 |
|---|---|---|
| 查询重写（Hermes `query_rewrite.py`） | **不做** | 每轮多一次 LLM 调用（0.5–2 s），混合打分已够 |
| Rerank（RetainDB 的第三阶段） | **不做** | 交叉编码器要多占几百 MB，本机空闲仅约 553 MB |
| 跨工作区隔离 | **不做** | 全家共用一套记忆，全局可见 |
| MMR 去重 | **不做** | OpenClaw 默认关闭 |
| 时间衰减 | **不做** | 同上 |
| 分块 | **不做** | 一条消息一个单元 |
| 独立向量库文件 | **不做** | 单库已验证更优 |
| 提高 minScore 挡泛查询 | **不做** | 切不开，会连带误杀精确命中 |

---

## 附：与 OpenClaw / Hermes 的差异

| | OpenClaw | Hermes (RetainDB) | 我们 |
|---|---|---|---|
| 索引对象 | 文件 | 云端会话 | **消息流** |
| 分块 | 400 token / 80 重叠 | 未知（云端） | **不切块** |
| 存储 | 三表并存 | 云端 | **单库两表** |
| 增量判据 | `revision` + 6 触发器对账 | 云端托管 | **水位线 + 触发器同步删** |
| 检索阶段 | 向量 + BM25 | 向量 + BM25 + **Rerank** | **向量 + BM25** |
| 过采样 | k×8，上限 4096 | 未知 | **k×4，上限 24** |
| 混合公式 | `vw·vec + tw·txt` | 未知 | 同，**但加零命中归一** |
| 注入入口 | 未找到 | 未找到 | `agent/pre-step` + `snapshot` |
| 权重 | 0.7 / 0.3 | 未知 | **0.7 / 0.3（实测确认）** |
| minScore | 0.35 | 未知 | **0.62（实测确认）** |
