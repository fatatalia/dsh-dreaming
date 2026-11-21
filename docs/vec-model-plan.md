# 方案：嵌入模型自动获取（通用插件化）

> 状态：**待评审**，2026-11-21。目标是把 dsh-dreaming 从「自用插件」变成
> 「别人装上就能用」—— 当前别人装上，向量功能是死的（缺模型 → `fatal`）。
>
> 前提已实测，不是假设（见 §1）。

---

## 1. 已核实的事实

| # | 事实 | 证据 |
|---|---|---|
| 1 | 底层库自带下载能力，不用自己写 HTTP | `node-llama-cpp` 导出 `resolveModelFile` / `createModelDownloader` |
| 2 | 支持进度回调 | `resolveModelFile({ onProgress: ({totalSize, downloadedSize}) })` |
| 3 | **能校验文件完整性** | `verify?: boolean`，默认 `false` —— 开启后比对远端预期大小 |
| 4 | **支持镜像** | 底层读 `HF_ENDPOINT` 环境变量；也可用 `endpoints` 选项 |
| 5 | 正确下载地址 | `ggml-org/embeddinggemma-300m-qat-q8_0-GGUF` → **HTTP 200, 313MB** |
| 6 | 官方源与镜像都通 | HF 1.14 MB/s ≈ 4.6 分钟；hf-mirror 0.82 MB/s ≈ 6.4 分钟（各测 2MB 推算） |
| 7 | **错误地址会留下垃圾文件** | 本机 `bge-m3-q4_k_m.gguf` 只有 **15 字节**，内容是 `Entry not found` |

> ⚠️ 第 7 条是 §2-Q3 的直接证据：当前 `findModel()` 只判 `existsSync`，
> 这种 404 残留会被当成有效模型喂给 `loadModel`，然后崩在 llama.cpp 内部，
> 报错完全不指向真实原因。

**顺带纠正**：仓库里没有写任何下载地址。之前猜的 `unsloth/embeddinggemma-300m-GGUF`
实测 **404**。正确来源是 `ggml-org/embeddinggemma-300m-qat-q8_0-GGUF`，
文件名 `embeddinggemma-300m-qat-Q8_0.gguf`，313MB —— 与本机文件大小完全吻合。

---

## 2. 三个问题怎么解

### Q1｜下载源在国内能不能用

**问题**：313MB 走 HF 直连，国内大概率卡死或超时，表现为「进度永远 0%」。

**解法** —— 分三层，优先级从高到低：

1. **`DSH_VEC_MODEL`**：用户显式指定本地路径，完全不联网（离线/内网场景）
2. **`HF_ENDPOINT`**：底层自动读取，用户设成 `https://hf-mirror.com` 即可
3. **默认值**：`https://huggingface.co`

**不做的事**：不自动猜镜像、不静默回退。自动切换会让人搞不清「到底连的哪」，
出问题无从排查。镜像由用户显式配，README 给一行示例。

**额外**：UI 上显示当前使用的是哪个源（host 名即可），失败时也带上它 ——
用户一眼能看出「哦是连的 huggingface.co 超时了」。

### Q2｜下载期间索引状态怎么算

**问题**：现在只有「就绪 / 未就绪」两态。加下载后必然出现第三态「模型在下载中」，
而它**不是异常**，不该显示成「已启用但 0 条」那种看起来坏掉的样子。

**解法** —— 状态机从 2 态扩成 4 态：

```
       ┌──────────┐  自动下载开启     ┌──────────┐
       │  missing │ ───────────────→ │ loading  │
       └──────────┘                   └────┬─────┘
            │                              │ 下载+加载完成
            │ 自动下载关闭 / 用户取消        ↓
            │                         ┌──────────┐
            └───────────────────────→ │  ready   │
                                      └──────────┘
                                           │ 失败
                                           ↓
                                      ┌──────────┐
                                      │  failed  │
                                      └──────────┘
```

| 状态 | UI 文案 | 索引行为 | 注入行为 |
|---|---|---|---|
| `missing` | 「未检测到嵌入模型 · 点击下载（313MB）」 | 不启动 | 跳过（不报错） |
| `loading` | 「正在下载模型 42% · 1.3/3.1 MB/s」 | **不启动**，等就绪 | 跳过 |
| `ready` | 「向量 1650/14925」 | 正常运行 | 正常运行 |
| `failed` | 「模型获取失败：<原因>」+ 重试按钮 | 不启动 | 跳过 |

**关键约束**：
- `loading` 期间**绝不能开始索引** —— 没模型，索引一跑就报错刷屏
- `loading` 期间页面要显示**具体百分比和速度**，不能只转圈 ——
  313MB 要下 5 分钟，光转圈像卡死
- 四个状态都要能被 `vectorStatus` RPC 返回，页面才画得对

### Q3｜半截文件算不算「有模型」

**问题**：`existsSync` 只看文件在不在。404 残留（15B）、下载中断的残片、
磁盘写满的半个文件 —— 全都通过检查。

**解法** —— 三道校验，任何一道不过都视为「没有」：

1. **大小下限**：< 50MB 直接判定为坏文件（正常模型 313MB，给足余量）
2. **GGUF magic**：读前 4 字节必须是 `GGUF`（ASCII 0x47 0x47 0x55 0x46）
3. **远端大小比对**：用 `resolveModelFile` 的 `verify: true`，
   下载后核对是否等于预期 313MB

**发现坏文件时**：重命名成 `<原名>.corrupt-<时间戳>` 而不是直接删 ——
万一是用户自己放的、只是格式不对，不该由插件替他销毁。然后继续走下载。
日志要明确写「检测到损坏模型文件，已重命名」。

**注意**：`verify: true` 只在**下载路径**生效；第 1、2 道校验必须自己写，
因为 `DSH_VEC_MODEL` 指定的路径不经过下载器。

---

## 3. 配置项

在现有 `semantic*` 系列后面追加，默认值保证「不配也能用」：

| 配置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `semanticAutoDownload` | bool | **`true`** | 缺模型时是否自动下载。`false` → 停在 `missing`，等用户手动放 |
| `semanticModelUri` | string | `ggml-org/embeddinggemma-300m-qat-q8_0-GGUF` | 只写到仓库，不含文件名 —— 文件名由代码固定，避免用户写错 |
| `semanticModelFile` | string | `embeddinggemma-300m-qat-Q8_0.gguf` | 落到本地的文件名 |
| `semanticModelDir` | string | `~/.node-llama-cpp/models` | 模型目录 |

**为什么默认 `true`**：这个插件的核心功能是语义检索，缺模型等于功能不存在。
默认 `false` 的话，别人装上会以为「这功能就这样」。

**为什么 URI 和文件名分开**：`resolveModelFile` 支持只给仓库、
自动按仓库内容挑文件，但那样多一次网络往返且可能挑到非 Q8 的量化版本。
写死文件名最省事、最可预期。

---

## 4. 改动清单

按**实施顺序**排 —— 顺序不可反，前一步验证过再走下一步。

### 第 1 步：`lib/vec-model.mjs`（新建）

唯一的模型解析入口，对外只暴露一个函数：

```
resolveEmbeddingModel({ log, onProgress }) → { path, source } | { error, reason }
```

内部逻辑：

1. `DSH_VEC_MODEL` 有值 → 校验（大小 + magic）→ 通过则返回
2. 扫候选路径（现有两个文件名 + 配置项）→ 逐个校验 → 第一个通过的返回
3. 全都不通过 → `semanticAutoDownload` 为 false 则返回 `{error: 'missing'}`
4. 否则调 `resolveModelFile({ directory, verify: true, onProgress })` 下载
5. 下载完再校验一次（大小 + magic），防「下完了但是坏的」

**这一层独立成文件的原因**：`vec-embed-child.mjs` 是**子进程**，
下载要报进度给父进程、再转给页面，放子进程里得再发明一套协议。
模型解析放在父进程做，子进程只管「拿到路径就加载」，职责干净。

### 第 2 步：`lib/vec-embed.mjs` 接受外部传入的模型路径

现在 `EmbedClient` 构造时不知道模型在哪，由子进程自己去找。
改成父进程解析好路径、通过 IPC 传给子进程：

```
{ type: 'boot', modelPath: '/path/to/model.gguf' }
```

子进程收到后再 `loadModel`，找不到模型不再是子进程的事。

### 第 3 步：`index.js` 接状态机

- 启动时（`ensureVecReady`）先查模型状态，填进 `vectorStatus`
- 新增 RPC `downloadModel`（手动触发，用于 `missing` 态下的按钮）
- `vectorStatus` 返回值增加 `modelState` / `downloadProgress` / `error`

### 第 4 步：`client.js` 画四态（**最后做**）

- `missing` → 显示「下载模型（313MB）」按钮，点了调 `downloadModel`
- `loading` → 进度条 + 百分比 + 速度，每 1 秒轮询（下载比索引进得快，3 秒太钝）
- `failed` → 红字原因 + 重试按钮
- `ready` → 现有进度条不变

---

## 5. 失败路径（必须都有明确文案）

| 情况 | 表现 | 处理 |
|---|---|---|
| 网络超时 | 下载卡住 | 30 秒无进展 → 中止，`failed`，文案带 host |
| 镜像 404 | 立刻 404 | `failed`，「地址不存在，请检查 semanticModelUri」 |
| 磁盘写满 | 写入中断 | `failed`，「磁盘空间不足」+ 剩余空间 |
| 下载完但校验失败 | 大小/magic 不对 | 重命名坏文件，`failed`，「模型校验失败」 |
| 用户取消 | — | 回到 `missing`，**删除临时文件**（`deleteTempFileOnCancel` 默认 true） |
| `DSH_VEC_MODEL` 指向坏文件 | 校验不过 | `failed`，「指定路径的模型文件无效」，**不自动下载**（用户显式指定就尊重他） |

**共同的硬边界**：模型相关的一切失败，**都不能影响 dsh 主进程和其他插件**。
向量功能停摆就停摆，对话照常。

---

## 6. 验收标准

按顺序，每条都要在**真实运行环境**里过一遍（不是看代码推断）：

1. 删掉模型文件 → 重启 → 页面显示 `missing` + 下载按钮，**索引没启动**
2. 点下载 → `loading`，百分比和速度在动（不能长时间不动）
3. 下载完成 → 自动转 `ready`，索引**自动开始**，不用我再点一次
4. 下载中途拔网线 → 30 秒内转 `failed`，文案指明是网络问题
5. 手动把模型文件截断成 1000 字节 → 重启 → 识别为损坏、重命名、重新下载
6. `semanticAutoDownload: false` + 无模型 → 停在 `missing`，不自动下
7. 设置 `HF_ENDPOINT=https://hf-mirror.com` → 下载源变成镜像（日志可验证）
8. 设 `DSH_VEC_MODEL` 指向有效模型 → 跳过所有下载逻辑，直接 `ready`

---

## 7. 设置页展示（代码东 2026-11-21 追加）

> 原话：「模型在设置页面上可以做一下展示，这样就能知道模型是不是已经下载并且具备了」

**落点**：`client.js` 的 `DreamSettings` 组件 —— 「设置 → 梦境记忆 → 语义检索」折叠区。
这是一个**普通 React 组件**（不是 Schema 驱动的表单），可以自由渲染运行状态，不受
Schemastery 只能画配置字段的限制。

**位置**：启用开关那一行**之后**、子配置块**之前**（即 client.js 的 `line 615` 与 `line 616` 之间）。
理由 —— 「模型是否具备」是独立信息，**不管开关开着还是关着都该看得到**。
放在 `semanticEnabled ?` 里面的话，关着开关就永远看不见模型状态。

**显示内容**（四态，与 §2-Q2 一致）：

| 状态 | 显示 | 可操作 |
|---|---|---|
| `ready` | `✓ 模型已就绪 · 313MB · <目录>` | 无（或「重新下载」次要链接） |
| `missing` | `未检测到嵌入模型 · 需要 313MB` | 「下载」按钮 |
| `loading` | `正在下载 42% · 1.3/3.1 MB/s` + 进度条 | 「取消」按钮 |
| `failed` | `模型不可用：<原因>` | 「重试」按钮 |

**数据来源**：`vectorStatus` RPC 新增 `model` 字段：

```
model: {
  state: "ready" | "missing" | "loading" | "failed",
  path: "/Users/xxx/.node-llama-cpp/models/embeddinggemma-300m-qat-Q8_0.gguf",
  bytes: 328286112,          // 实际字节数，ready 时给
  displaySize: "313MB",      // 人类可读
  host: "huggingface.co",    // 下载源 host，loading/failed 时给
  percent: 42,               // loading 时给
  speedBps: 1363148,         // loading 时给
  error: null,               // failed 时给可读原因
}
```

**关键约束**：`enabled: false` 时**也要返回 model 状态** —— 只做轻量文件检测
（存在 + 大小 + magic），不加载模型、不启动子进程，开销是几次 `stat`，
不违背「开关关着不该有副作用」这个前提。

---

## 8. 明确不做

- **不做多模型切换**：一套模型绑定一套向量，换模型意味着全部重算。
  要换就清空 `messages_vec` 重建，走手动流程。
- **不做下载加速**（多线程分片）：`parallel` 默认 4 已够，2 核机器上再快没意义。
- **不把模型打进 npm 包**：313MB 的包没人愿意下。
- **不做增量校验**（断点续传）：`deleteTempFileOnCancel` 默认会清临时文件，
  重下 5 分钟比维护续传状态简单。**如果实测发现网络确实不稳，再单独议。**
