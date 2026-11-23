/**
 * vec-embed-child.mjs —— 嵌入子进程 worker
 *
 * ⚠️ 为什么必须独立进程：`node-llama-cpp` 是 C++ 原生绑定，
 *    崩了会一起带走整个 dsh 进程（所有会话全断）。隔离在这个进程里，
 *    它炸了只是向量功能停摆，主库和其他插件照常。
 *
 * 协议（父进程 ←→ 本进程）：
 *   父 → 子  { type: "embed", id: <请求号>, texts: string[] }
 *   子 → 父  { type: "ready", dim: 768 }
 *            { type: "result", id, vectors: number[][], ms: number }
 *            { type: "error", id, message }
 *            { type: "fatal", message }
 *
 * 串行处理：一次只算一批，不并发 —— 2 核机器上并发只会互相拖慢。
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODEL_ID = "embeddinggemma-300m-q8";
const DIM = 768;
const MAX_CHARS = 1500; // 超长截断。实测 2400 可过、3000 会超，取 1500 留足余量

/** 模型搜索路径：环境变量 → 用户目录 → 项目内。 */
function findModel() {
  const explicit = process.env.DSH_VEC_MODEL;
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [
    join(homedir(), ".node-llama-cpp", "models", "embeddinggemma-300m-Q8_0.gguf"),
    join(homedir(), ".node-llama-cpp", "models", "embeddinggemma-300m-qat-Q8_0.gguf"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

let llama = null;
let model = null;
let embeddingCtx = null;

async function boot() {
  const modelPath = findModel();
  if (!modelPath) {
    send({
      type: "fatal",
      error: "model_missing",
      message: "找不到嵌入模型（可设 DSH_VEC_MODEL 指定路径）",
    });
    return false;
  }

  /*
   * 分两段兜底，别让裸 import 把子进程崩掉。
   * 为什么重要：`node-llama-cpp` 是 optionalDependencies，装失败时 npm 不报错。
   * 裸 await import() 抛异常 → 子进程退出 → 主进程只看到「反复崩溃（已 N 次）」，
   * 看不出真正原因是「引擎没装」。分清楚才能给用户一句能照着做的话。
   */
  let getLlama;
  try {
    ({ getLlama } = await import("node-llama-cpp"));
  } catch (err) {
    send({
      type: "fatal",
      error: "no_engine",
      message: `node-llama-cpp 不可用（${err?.message || err}）。语义检索需要它，请重新安装插件依赖`,
    });
    return false;
  }

  // 引擎在、但加载失败：模型文件损坏 / 内存不够 / 不支持的量化格式都落这里
  try {
    llama = await getLlama({ gpu: false }); // 纯 CPU：这台机器没有可用 GPU
    model = await llama.loadModel({ modelPath, gpuLayers: 0 });
    embeddingCtx = await model.createEmbeddingContext();
  } catch (err) {
    send({
      type: "fatal",
      error: "model_load_failed",
      message: `嵌入模型加载失败：${err?.message || err}`,
    });
    return false;
  }

  send({ type: "ready", dim: DIM, model: MODEL_ID });
  return true;
}

function send(msg) {
  if (process.connected) process.send(msg);
}

/** 逐条嵌入，串行。返回 number[][]。 */
async function embedBatch(texts) {
  const out = [];
  for (const raw of texts) {
    const text = String(raw ?? "").slice(0, MAX_CHARS);
    if (!text.trim()) {
      out.push(new Array(DIM).fill(0));
      continue;
    }
    const emb = await embeddingCtx.getEmbeddingFor(text);
    // getEmbeddingFor 返回的 vector 可能是 Float32Array 或 number[]
    out.push(Array.from(emb.vector));
  }
  return out;
}

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "embed") {
    const t0 = Date.now();
    try {
      if (!embeddingCtx) throw new Error("模型未就绪");
      const vectors = await embedBatch(msg.texts || []);
      send({ type: "result", id: msg.id, vectors, ms: Date.now() - t0 });
    } catch (e) {
      send({ type: "error", id: msg.id, message: e?.message || String(e) });
    }
    return;
  }

  if (msg.type === "shutdown") {
    try { await model?.dispose?.(); } catch {}
    process.exit(0);
  }
});

boot().then((ok) => {
  if (!ok) {
    // 起不来也别僵着 —— 父进程会收到 fatal 并降级
    setTimeout(() => process.exit(1), 100);
  }
}).catch((e) => {
  send({ type: "fatal", message: e?.message || String(e) });
  setTimeout(() => process.exit(1), 100);
});
