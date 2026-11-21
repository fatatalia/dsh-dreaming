#!/usr/bin/env node
/**
 * dsh-dreaming — 语义检索召回验证
 *
 * 回填跑完后用它对比「纯关键词」与「混合检索」的实际差异。
 * 只读不写，不改库里的任何东西。
 *
 * 用法：
 *   node scripts/vec-verify.mjs                    # 默认查询集
 *   node scripts/vec-verify.mjs --query "鸭掌木"    # 单条
 *   node scripts/vec-verify.mjs --db /path.db
 *
 * 为什么单独做成脚本而不是写进插件：验证是一次性动作，不该常驻主进程。
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../lib/db.mjs";
import * as V from "../lib/vec-store.mjs";
import { EmbedClient } from "../lib/vec-embed.mjs";
import { mergeHybrid } from "../lib/vec-hybrid.mjs";

V.setVecRequire(createRequire(import.meta.url));

/* ─────────────────────────── 参数 ─────────────────────────── */

function opt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DB_PATH = opt("db", join(homedir(), ".dsh", "dreaming-memory.db"));
const SINGLE = opt("query", null);
const MIN_SCORE = Number(opt("min-score", "0.62"));
const POOL = Number(opt("pool", "24"));
const TOPK = Number(opt("top", "3"));

/**
 * 默认查询集：2026-11-21 定 minScore 时用的那批真实提问。
 * 混了「有明确实体」和「泛查询」两类 —— 后者的失败是已知局限，不该被藏起来。
 */
const DEFAULT_QUERIES = [
  "鸭掌木浇水",
  "二号机砂盆",
  "路由器配置",
  "向量检索怎么做",
  "9092 端口",
  "发财树叶子黄了",
  "DeepSeek 余额",
  "猫砂盆满桶",
  "dsh 插件升级",
  "群晖日历",
  "FAMILY.md 在哪",
  "心跳静默时段",
];

/* ─────────────────────────── 主流程 ─────────────────────────── */

const db = new MemoryDB(DB_PATH);
console.log(`  库: ${DB_PATH}`);

if (!V.loadVecExtension(db.db)) {
  console.error("  ✗ vec0 扩展加载失败 —— 先确认 sqlite-vec 已安装");
  process.exit(1);
}
const st = V.vecStats(db.db);
console.log(`  向量 ${st.indexed.toLocaleString()} / ${st.total.toLocaleString()} 条` +
  (st.missing > 0 ? `  ⚠️ 还差 ${st.missing.toLocaleString()} 条没索引` : "  ✓ 已全部索引"));
console.log(`  minScore=${MIN_SCORE}  candidatePool=${POOL}  topK=${TOPK}`);
console.log("");

const client = new EmbedClient({ log: { error() {}, warn() {} } });
await client.start();

const queries = SINGLE ? [SINGLE] : DEFAULT_QUERIES;
let kwTotal = 0, hyTotal = 0, rescTotal = 0, hitQueries = 0;
const rows = [];

for (const q of queries) {
  const kw = db.search(q, { limit: TOPK });
  const qv = await client.embedOne(q);

  let merged = [];
  if (qv) {
    const textRows = db.search(q, { limit: Math.max(TOPK * 4, POOL), offset: 0, sort: "rank" });
    const vecHits = V.queryKnn(db.db, qv, POOL);
    merged = mergeHybrid({
      vecHits, textHits: textRows, vectorWeight: 0.7, minScore: MIN_SCORE, topK: TOPK,
      fetchRows: (ids) => V.getMessagesByIds(db.db, ids),
    });
  }

  const kwIds = new Set(kw.map((r) => r.id));
  const rescued = merged.filter((m) => !kwIds.has(m.id)).length;

  kwTotal += kw.length;
  hyTotal += merged.length;
  rescTotal += rescued;
  if (merged.length > 0) hitQueries++;

  rows.push({ q, kw: kw.length, hy: merged.length, rescued, top: merged[0]?.score ?? null });

  const bar = "─".repeat(46);
  console.log(bar);
  console.log(`「${q}」  关键词 ${kw.length} → 混合 ${merged.length}` +
    (rescued ? `  (补回 ${rescued})` : ""));
  if (merged.length === 0 && kw.length === 0) console.log("   (两路都空)");
  else if (merged.length === 0)              console.log("   (混合后全被 minScore 滤掉)");
  for (const m of merged.slice(0, TOPK)) {
    const t = String(m.content ?? "").replace(/\s+/g, " ").slice(0, 56);
    console.log(`   ${m.score.toFixed(3)} [${m.role}] ${t}`);
  }
}

client.stop();
db.close();

/* ─────────────────────────── 汇总 ─────────────────────────── */

console.log("");
console.log("═".repeat(48));
console.log(`  查询 ${queries.length} 条 · 有结果 ${hitQueries} 条`);
console.log(`  关键词总命中 ${kwTotal} → 混合总命中 ${hyTotal}`);
console.log(`  其中 ${rescTotal} 条是关键词完全没召回的（向量的净贡献）`);
if (queries.length > 0) {
  const rate = (rescTotal / Math.max(hyTotal, 1) * 100).toFixed(1);
  console.log(`  增量占比 ${rate}%`);
}
console.log("");
console.log("  零结果的查询：");
const zeros = rows.filter((r) => r.hy === 0).map((r) => r.q);
console.log(zeros.length ? "    " + zeros.join(" · ") : "    无");
