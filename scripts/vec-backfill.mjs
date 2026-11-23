#!/usr/bin/env node
/**
 * vec-backfill.mjs —— 全量建库（两趟，近期优先）
 *
 * 用法：
 *   node scripts/vec-backfill.mjs                 # 正常跑
 *   node scripts/vec-backfill.mjs --limit 500     # 只跑 500 条（调试）
 *   node scripts/vec-backfill.mjs --dry-run       # 只统计不写入
 *   node scripts/vec-backfill.mjs --db /path.db   # 指定库
 *
 * 两趟的由来：
 *   全量按 id 正序建有个大问题 —— id 小的 = 旧消息，建到 50% 时索引的是
 *   最早那一半，最新的反而一条都没有。而检索最常要的是近期记忆。
 *   所以第 1 趟先建最近 20%（上限 5000 条），第 2 趟再补剩下的。
 *
 * ⚠️ 必须独立进程跑：DatabaseSync 是同步 API，在主进程里跑会堵死事件循环。
 */

import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as V from "../lib/vec-store.mjs";
import { chunkText } from "../lib/vec-chunk.mjs";
import { EmbedClient } from "../lib/vec-embed.mjs";

V.setVecRequire(createRequire(import.meta.url));

/* ─────────────────────── 参数 ─────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DB_PATH = opt("db", join(homedir(), ".dsh", "dreaming-memory.db"));
const DRY = flag("dry-run");
const LIMIT = Number(opt("limit", "0")) || 0;

// 每批条数 = 事务粒度 = 水位线推进粒度 = 可见性粒度。
// 100 条实测会超过嵌入超时（100×约500ms≈50s，撞 60s 上限），
// 首批直接失败「子进程无响应」。30 条约 15 秒，安全且进度可见。
const BATCH = 30;
const WARMUP_RATIO = 0.2;   // 第 1 趟覆盖最近 20%
const WARMUP_CAP = 5000;    // 但不超过 5000 条
const THROTTLE_RATIO = 0.3; // 每批让出已用时间的 30%

/* ─────────────────────── 工具 ─────────────────────── */

const fmt = (n) => n.toLocaleString("zh-CN");
const pct = (a, b) => (b > 0 ? ((a / b) * 100).toFixed(1) : "0.0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) { console.log(`  ${msg}`); }

function bar(done, total, width = 28) {
  const n = total > 0 ? Math.round((done / total) * width) : 0;
  return "█".repeat(n) + "░".repeat(Math.max(0, width - n));
}

/* ─────────────────────── 主流程 ─────────────────────── */

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`  ✗ 库不存在: ${DB_PATH}`);
    process.exit(1);
  }

  log(`库: ${DB_PATH}`);
  const db = new DatabaseSync(DB_PATH, { allowExtension: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");

  if (!V.loadVecExtension(db)) {
    console.error("  ✗ vec0 扩展加载失败（检查 sqlite-vec 是否安装）");
    process.exit(1);
  }
  V.initVecSchema(db);
  log("vec0 已加载，表与触发器就绪");

  const fp = V.checkModelFingerprint(db);
  if (!fp.ok) {
    console.error(`  ✗ ${fp.reason}`);
    console.error("    先执行 --reset 清空向量再重建");
    process.exit(1);
  }

  const stats = V.vecStats(db);
  log(`可索引 ${fmt(stats.total)} 条 · 已有向量 ${fmt(stats.indexed)} 条 · 待补 ${fmt(stats.missing)} 条`);

  if (DRY) {
    log("--dry-run：不写入，退出");
    db.close();
    return;
  }

  const todo = LIMIT > 0 ? Math.min(LIMIT, stats.missing) : stats.missing;
  if (todo === 0) {
    log("没有需要索引的消息，已是最新");
    db.close();
    return;
  }

  const client = new EmbedClient({ log: console });
  log("启动嵌入子进程…");
  const ok = await client.start();
  if (!ok) {
    console.error("  ✗ 嵌入子进程启动失败");
    db.close();
    process.exit(1);
  }
  log("模型就绪");

  let done = 0;
  const t0 = Date.now();

  const progress = (phase) => {
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done > 0 ? elapsed / done : 0;
    const eta = todo > done ? Math.round((todo - done) * rate) : 0;
    const etaStr = eta > 60 ? `约 ${(eta / 60).toFixed(1)} 分钟` : `约 ${eta} 秒`;
    process.stdout.write(
      `\r  ${phase} ${bar(done, todo)} ${fmt(done)}/${fmt(todo)} (${pct(done, todo)}%) ` +
      `单条 ${(rate * 1000).toFixed(0)}ms 剩余 ${etaStr}    `
    );
  };

  /** 处理一批：嵌入 → 事务写向量 + 推进水位线。 */
  const processBatch = async (rows, advanceWatermark) => {
    // 先切分：一条长消息拆成多段，每段单独嵌入（否则一条超限整批全废）
    const piecesPerMsg = rows.map((r) => {
      const ps = chunkText(r.content);
      return ps.length > 0 ? ps : [r.content];
    });
    const flat = piecesPerMsg.flat();

    // 分批嵌入：段数会膨胀，不一次全送（否则超时线被拉到几分钟）
    const vectors = [];
    const EMBED_BATCH = 40;
    for (let s = 0; s < flat.length; s += EMBED_BATCH) {
      const part = flat.slice(s, s + EMBED_BATCH);
      const got = await client.embed(part);
      if (!got || got.length !== part.length) {
        throw new Error("嵌入失败（子进程无响应）");
      }
      for (const v of got) vectors.push(v);
    }

    const batchStart = Date.now();

    // 短事务：BEGIN IMMEDIATE 立刻拿写锁，避免 DEFERRED 的升级死锁。
    // 与 dsh 主进程并发写同一个库是安全的 —— 实测 4 秒 27 万次写入零冲突。
    db.exec("BEGIN IMMEDIATE");
    try {
      // 按段数把 flat 的向量分回每条消息，一次写全部分块
      let cursor = 0;
      for (let i = 0; i < rows.length; i++) {
        const n = piecesPerMsg[i].length;
        V.putMessageChunks(db, rows[i].id, vectors.slice(cursor, cursor + n));
        cursor += n;
      }
      if (advanceWatermark) {
        const maxId = rows[rows.length - 1].id;
        db.prepare(
          "INSERT INTO vec_state(key,value) VALUES('watermark_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        ).run(String(maxId));
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }

    done += rows.length;
    progress("索引中");

    // 限速：让出已用时间的固定比例，任何机器都是约 1.3 倍总耗时
    const spent = Date.now() - batchStart;
    if (spent > 5) await sleep(Math.round(spent * THROTTLE_RATIO));
  };

  try {
    /*
     * 语义约定（两趟的核心，写清楚免得再搞反）：
     *   hot_max_id = H  ⇒  id > H 的都已由第 1 趟覆盖
     *   第 2 趟补齐      id <= H 且 id > watermark 的部分，从旧往新
     */

    /* ── 第 1 趟：近期优先 ── */
    let hotMax = V.getHotMaxId(db);
    if (hotMax === 0) {
      const warmCount = Math.min(Math.ceil(stats.total * WARMUP_RATIO), WARMUP_CAP);
      log(`第 1 趟：覆盖最近 ${fmt(warmCount)} 条（近期记忆优先可用）`);

      // 从最新往回取，再反转成升序写（写入顺序稳定，便于观察进度）
      const warmRows = V.collectMessages(db, { afterId: 0, limit: warmCount, desc: true }).reverse();
      if (warmRows.length > 0) {
        const warmSlice = warmRows.slice(0, Math.min(warmRows.length, todo));

        for (let i = 0; i < warmSlice.length; i += BATCH) {
          await processBatch(warmSlice.slice(i, i + BATCH), false);
        }

        // ⚠️ hot_max_id 的语义是「id > H 的都已覆盖」，只有第 1 趟**完整跑完**
        //    才成立。--limit 截断或中途 Ctrl-C 时若照写，会把中间一大段
        //    标记成已覆盖而永远不补 —— 实测 --limit 50 就漏掉 8,751 条。
        const warmComplete = warmSlice.length === warmRows.length;
        if (warmComplete) {
          hotMax = warmRows[0].id - 1;
          V.setHotMaxId(db, hotMax);
          process.stdout.write("\n");
          log(`第 1 趟完成 ${fmt(warmSlice.length)} 条，近期记忆已可用（hot_max_id=${hotMax}）`);
        } else {
          process.stdout.write("\n");
          log(`第 1 趟中断（${fmt(warmSlice.length)}/${fmt(warmRows.length)} 条），不写 hot_max_id，下次重跑`);
          throw { done: true };
        }
      }
      if (LIMIT > 0 && done >= LIMIT) throw { done: true };
    } else {
      log(`第 1 趟已完成过（hot_max_id=${hotMax}），跳过`);
    }

    /* ── 第 2 趟：剩余全量，从旧往新，上界为 hot_max_id ── */
    let cursor = V.getWatermark(db);
    log(`第 2 趟：补齐 id ∈ (${fmt(cursor)}, ${fmt(hotMax)}]`);

    while (done < todo) {
      const take = Math.min(BATCH, todo - done);
      const rows = V.collectMessages(db, { afterId: cursor, beforeId: hotMax, limit: take });
      if (rows.length === 0) break;

      await processBatch(rows, true);
      cursor = rows[rows.length - 1].id;
    }

    process.stdout.write("\n");
  } catch (e) {
    if (e?.done) {
      process.stdout.write("\n");
      log(`达到 --limit ${fmt(LIMIT)}，停止`);
    } else {
      process.stdout.write("\n");
      console.error(`  ✗ 失败: ${e?.message || e}`);
      client.stop();
      db.close();
      process.exit(1);
    }
  }

  client.stop();
  db.close();
  log(`完成：本次索引 ${fmt(done)} 条 · 总耗时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
}

main().catch((e) => {
  console.error(`  ✗ ${e?.stack || e}`);
  process.exit(1);
});
