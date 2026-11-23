/**
 * vec-store.mjs —— 向量表、水位线、KNN 查询
 *
 * 单库架构：向量表 `messages_vec` 与消息表同库，靠触发器自动维护删除。
 *
 * ⚠️ 三件必须记住的事（全部实测踩出来的）：
 *   ① vec0 的 KNN **不保证按距离排序**，必须显式 `ORDER BY d`，漏了不报错只是顺序错
 *   ② INTEGER 主键不接受 JS number（按 double 传），读写两端都用 BigInt
 *   ③ 扩展加载失败只影响 vec0，主库照常可用 —— 所以这里绝不抛异常出去
 */

import { existsSync } from "node:fs";
import { chunkIdFor } from "./vec-chunk.mjs";

const DIM = 768;
const MODEL_ID = "embeddinggemma-300m-q8";

/** 模块级 require —— ESM 里没有，由 import 时用 createRequire 造一个。 */
let _require = null;

/** 让调用方注入 require（ESM 里没有 require）。 */
export function setVecRequire(req) {
  _require = req;
}

/** vec0 扩展的加载路径：只认项目自己的 sqlite-vec 依赖。 */
function resolveVecExtension() {
  if (!_require) return null;
  try {
    const mod = _require("sqlite-vec");
    const p = mod?.getLoadablePath?.();
    if (p && existsSync(p)) return p;
  } catch { /* 没装 = 功能不可用，不是错误 */ }
  return null;
}

/**
 * 加载 vec0 扩展。
 * @returns {boolean} 成功 true；失败 false（**不抛异常** —— 插件必须能起来）
 */
export function loadVecExtension(db) {
  const path = resolveVecExtension();
  if (!path) return false;
  try {
    db.loadExtension(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 建表 + 触发器 + 状态行。幂等。
 * 只在 vec0 可用时调用；不可用时上层不该调。
 */
export function initVecSchema(db) {
  db.exec(`
    -- ⚠️ distance_metric=cosine 必须写。
    --    默认是 L2 平方距离，而 getEmbeddingFor 返回的向量模长约 28（未归一化），
    --    L2 距离会到 25 以上，1 - dist 算出 -24，所有分数全废。
    --    改 cosine 后 distance = 1 - cos_sim ∈ [0,2]，1 - dist 就是余弦相似度。
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_vec USING vec0(
      id INTEGER PRIMARY KEY,
      embedding FLOAT[${DIM}] distance_metric=cosine
    );

    CREATE TABLE IF NOT EXISTS vec_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO vec_state(key, value) VALUES
      ('watermark_id', '0'),
      ('hot_max_id', '0'),
      ('model', '${MODEL_ID}'),
      ('dim', '${DIM}'),
      ('metric', 'cosine');

    -- ── 分块层（chunk）─────────────────────────────────────────────
    -- 一条消息按 vec-chunk 切成多段，每段存一条向量。
    -- 为什么要分块：模型上下文放不下一整条长消息，而一批里只要 1 条超限
    -- 整批就全废（实测 3000 字符报 "Input is longer than the context size"）。
    --
    -- chunk_id = msg_id * 100 + seq（见 vec-chunk.mjs），幂等、无并发冲突。
    CREATE TABLE IF NOT EXISTS msg_chunks (
      chunk_id INTEGER PRIMARY KEY,
      msg_id   INTEGER NOT NULL,
      seq      INTEGER NOT NULL,
      UNIQUE(msg_id, seq)
    );

    CREATE INDEX IF NOT EXISTS msg_chunks_msg ON msg_chunks(msg_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[${DIM}] distance_metric=cosine
    );

    -- 删除消息 → 连带删它的所有分块向量。
    CREATE TRIGGER IF NOT EXISTS msg_chunks_cleanup
    AFTER DELETE ON messages
    BEGIN
      DELETE FROM chunks_vec WHERE chunk_id IN
        (SELECT chunk_id FROM msg_chunks WHERE msg_id = OLD.id);
      DELETE FROM msg_chunks WHERE msg_id = OLD.id;
    END;

    -- 内容变了 → 删全部分块，等下一轮 sync 重算。
    CREATE TRIGGER IF NOT EXISTS msg_chunks_invalidate
    AFTER UPDATE OF content ON messages
    BEGIN
      DELETE FROM chunks_vec WHERE chunk_id IN
        (SELECT chunk_id FROM msg_chunks WHERE msg_id = OLD.id);
      DELETE FROM msg_chunks WHERE msg_id = OLD.id;
    END;

    -- 删除消息 → 同步删向量。O(1)，不需要全表对账。
    CREATE TRIGGER IF NOT EXISTS messages_vec_cleanup
    AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_vec WHERE id = OLD.id;
    END;

    -- 内容变了 → 删旧向量，等下一轮 sync 重算。
    CREATE TRIGGER IF NOT EXISTS messages_vec_invalidate
    AFTER UPDATE OF content ON messages
    BEGIN
      DELETE FROM messages_vec WHERE id = OLD.id;
    END;
  `);
}

/* ─────────────────────────── 状态读写 ─────────────────────────── */

export function getState(db, key, fallback = null) {
  try {
    const row = db.prepare("SELECT value FROM vec_state WHERE key = ?").get(key);
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

export function setState(db, key, value) {
  db.prepare(
    "INSERT INTO vec_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

export function getWatermark(db) {
  return Number(getState(db, "watermark_id", "0")) || 0;
}

export function setWatermark(db, id) {
  setState(db, "watermark_id", id);
}

export function getHotMaxId(db) {
  return Number(getState(db, "hot_max_id", "0")) || 0;
}

/**
 * 第 1 趟（近期优先）的游标。
 * 没有它，每轮都会从 warm 切片的第 0 条重新开始 —— 永远在重算同一批，
 * hot_max_id 永远写不进去，表现为「进度条卡在同一个数字不动」（2026-11-21 踩的）。
 *   warm_floor_id  这一趟的下边界（最近 want 条里最老的那条 id）
 *   warm_cursor_id 已处理到的最大 id（0 = 还没开始）
 */
export function getWarmFloor(db) {
  return Number(getState(db, "warm_floor_id", "0")) || 0;
}
export function setWarmFloor(db, id) {
  setState(db, "warm_floor_id", id);
}
export function getWarmCursor(db) {
  return Number(getState(db, "warm_cursor_id", "0")) || 0;
}
export function setWarmCursor(db, id) {
  setState(db, "warm_cursor_id", id);
}

export function setHotMaxId(db, id) {
  setState(db, "hot_max_id", id);
}

/**
 * 模型指纹校验：换模型后向量空间就变了，必须拒绝复用旧向量。
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkModelFingerprint(db) {
  const model = getState(db, "model", "");
  const dim = getState(db, "dim", "");
  if (model && model !== MODEL_ID) {
    return { ok: false, reason: `索引用的是 ${model}，当前是 ${MODEL_ID}，需重建` };
  }
  if (dim && Number(dim) !== DIM) {
    return { ok: false, reason: `索引维度 ${dim}，当前 ${DIM}，需重建` };
  }
  const metric = getState(db, "metric", "");
  if (metric && metric !== "cosine") {
    return { ok: false, reason: `索引度量是 ${metric}，当前 cosine，需重建` };
  }
  return { ok: true };
}

/* ─────────────────────────── 向量读写 ─────────────────────────── */

/**
 * 写入一条向量。
 * ⚠️ id 必须转 BigInt —— node:sqlite 绑 JS number 时按 double 传，
 *    vec0 的 INTEGER 主键会报 "Only integers are allowed for primary key values"。
 */
export function putVector(db, id, vec) {
  // 单块写入 —— 等价于「这条消息只有一段」。
  putMessageChunks(db, id, [vec]);
}

/**
 * 写入一条消息的全部分块向量。
 *
 * ⚠️ 必须先删干净再写：vec0 不支持 INSERT OR REPLACE，重复 chunk_id 直接报
 *    "UNIQUE constraint failed on chunks_vec primary key"（实测）。
 *    重算同一条消息时，段数可能变少，残留的旧块会变成幽灵向量 —— 所以整条清空。
 *
 * @param {object} db
 * @param {number} msgId 消息 id
 * @param {Array<number[]|Float32Array>} vecs 按 seq 顺序的分块向量
 */
export function putMessageChunks(db, msgId, vecs) {
  const mid = BigInt(msgId);
  db.prepare("DELETE FROM chunks_vec WHERE chunk_id IN (SELECT chunk_id FROM msg_chunks WHERE msg_id = ?)")
    .run(mid);
  db.prepare("DELETE FROM msg_chunks WHERE msg_id = ?").run(mid);

  const insChunk = db.prepare("INSERT INTO msg_chunks(chunk_id, msg_id, seq) VALUES(?, ?, ?)");
  const insVec = db.prepare("INSERT INTO chunks_vec(chunk_id, embedding) VALUES(?, ?)");
  vecs.forEach((vec, seq) => {
    const cid = BigInt(chunkIdFor(msgId, seq));
    insChunk.run(cid, mid, seq);
    insVec.run(cid, new Float32Array(vec));
  });
}

/**
 * 批量写入。rows 里每项可以是 {id, vec}（单块）或 {id, vecs}（多块）。
 */
export function putVectors(db, rows) {
  for (const r of rows) {
    if (Array.isArray(r.vecs)) putMessageChunks(db, r.id, r.vecs);
    else putMessageChunks(db, r.id, [r.vec]);
  }
}

export function deleteVector(db, id) {
  db.prepare("DELETE FROM chunks_vec WHERE chunk_id IN (SELECT chunk_id FROM msg_chunks WHERE msg_id = ?)")
    .run(BigInt(id));
  db.prepare("DELETE FROM msg_chunks WHERE msg_id = ?").run(BigInt(id));
}

export function hasVector(db, id) {
  try {
    const row = db.prepare("SELECT 1 AS x FROM msg_chunks WHERE msg_id = ? LIMIT 1").get(BigInt(id));
    return !!row;
  } catch {
    return false;
  }
}

export function countVectors(db) {
  try {
    // 按消息数算，不是分块数 —— 界面上的「已索引 N 条」指的是消息。
    return Number(db.prepare("SELECT COUNT(DISTINCT msg_id) c FROM msg_chunks").get().c);
  } catch {
    return 0;
  }
}

/** 分块总数（排查用：一条长消息会产生多块）。 */
export function countChunks(db) {
  try {
    return Number(db.prepare("SELECT COUNT(*) c FROM msg_chunks").get().c);
  } catch {
    return 0;
  }
}

/* ─────────────────────────── KNN 查询 ─────────────────────────── */

/**
 * 向量近邻检索。
 * ⚠️ `ORDER BY d` 必须写 —— 实测 vec0 返回不保证有序，且不写不报错。
 * @param {number[]|Float32Array} vec 查询向量
 * @param {number} k 取多少条
 * @returns {Array<{id:number, dist:number}>} 按距离升序
 */
export function queryKnn(db, vec, k) {
  // 分块级 KNN：一条消息可能贡献多段，所以多取一些再按消息去重。
  // pool 取 k*6 —— 长消息最多切几段，留足冗余又不至于把候选撑爆。
  const pool = Math.max(k * 6, k + 20);
  const rows = db.prepare(`
    SELECT chunk_id, distance AS d
    FROM chunks_vec
    WHERE embedding MATCH ? AND k = ?
    ORDER BY d
  `).all(new Float32Array(vec), pool);

  if (rows.length === 0) return [];

  // 读出来是 BigInt —— JSON.stringify 会直接炸，必须转回 number。
  const ids = rows.map((r) => Number(r.chunk_id));
  const ph = ids.map(() => "?").join(",");
  const map = new Map(
    db.prepare(`SELECT chunk_id, msg_id FROM msg_chunks WHERE chunk_id IN (${ph})`)
      .all(...ids.map((i) => BigInt(i)))
      .map((r) => [Number(r.chunk_id), Number(r.msg_id)])
  );

  // 同一消息只留最相似的那一段（距离最小），其余丢弃
  const best = new Map();
  for (const r of rows) {
    const mid = map.get(Number(r.chunk_id));
    if (mid === undefined) continue;
    const d = Number(r.d);
    const cur = best.get(mid);
    if (cur === undefined || d < cur) best.set(mid, d);
  }

  // dist 是 cosine 距离 = 1 - cos_sim，范围 [0,2]；1 - dist 即余弦相似度。
  return [...best.entries()]
    .map(([id, dist]) => ({ id, dist }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, k);
}

/* ─────────────────────────── 候选与统计 ─────────────────────────── */

/**
 * 待索引消息的条件。与 syncOnce / countPending 必须完全一致。
 *
 * ⚠️ 排除 dreaming- 和 nudge- 两种会话（2026-11-23 代码东指出）：
 *    它们不是「对话」，是记忆处理的中间产物 ——
 *      · dreaming-：夜间提炼，产出直接进 dreams 表
 *      · nudge-：对话沉淀，user 侧是原文对话的复制、assistant 侧是 fact 列表
 *    原文早已被索引过一轮，提炼结果也已写进 MEMORY，再索一遍纯属重复，
 *    而且它们是全库最长的消息（8271 字），正是撑爆嵌入上下文的那批。
 */
const PENDING_WHERE = `
  role IN ('user','assistant')
  AND length(content) >= 10
  AND session_id NOT LIKE 'dreaming-%'
  AND session_id NOT LIKE 'nudge-%'
  AND content NOT LIKE '%automatically generated checkpoint%'
`;

/**
 * 取待索引消息（按 id 升序）。
 * @param {object} opts
 * @param {number} opts.afterId 只取 id > afterId
 * @param {number} opts.limit
 * @param {boolean} opts.desc 逆序（第 1 趟「近期优先」用）
 * @param {boolean} opts.onlyMissing 只取还没有向量的。
 *   **增量阶段必须开** —— 第 2 趟补完历史后水位线会越过第 1 趟已索引的区间，
 *   不跳过已索引的就会把它们重新嵌入一遍（实测 2945 条 × 473ms ≈ 23 分钟白烧 CPU，
 *   而 `putVector` 是先删后插，所以连报错都没有，只看得出「向量总数不涨」）。
 */
export function collectMessages(
  db,
  { afterId = 0, beforeId = null, limit = 100, desc = false, onlyMissing = false } = {}
) {
  const upper = beforeId === null ? "" : "AND m.id <= ?";
  const args = beforeId === null ? [afterId, limit] : [afterId, beforeId, limit];
  const sql = `
    SELECT m.id, m.session_id, m.role, m.content, m.timestamp
    FROM messages m
    WHERE m.id > ? ${upper} AND ${PENDING_WHERE}
    ${onlyMissing ? "AND NOT EXISTS (SELECT 1 FROM msg_chunks c WHERE c.msg_id = m.id)" : ""}
    ORDER BY m.id ${desc ? "DESC" : "ASC"}
    LIMIT ?
  `;
  return db.prepare(sql).all(...args).map((r) => ({ ...r, id: Number(r.id) }));
}

/**
 * 统计待索引条数。
 * @param {object} opts
 * @param {number} opts.afterId 水位线
 * @param {number} opts.beforeId 上界（第 1 趟已覆盖的区间要排除）
 */
export function countPending(db, { afterId = 0, beforeId = null } = {}) {
  const upper = beforeId === null ? "" : "AND id < ?";
  const args = beforeId === null ? [afterId] : [afterId, beforeId];
  const row = db.prepare(`
    SELECT COUNT(*) c FROM messages
    WHERE id > ? ${upper} AND ${PENDING_WHERE}
  `).get(...args);
  return Number(row.c);
}

/**
 * 简化版：直接算「还有多少条没向量」。
 * 用 LEFT JOIN 而不是靠 id 区间 —— id 有断档，区间算不准。
 */
export function countMissing(db) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) c
      FROM messages m
      WHERE NOT EXISTS (SELECT 1 FROM msg_chunks c2 WHERE c2.msg_id = m.id)
        AND ${PENDING_WHERE}
    `).get();
    return Number(row.c);
  } catch {
    return 0;
  }
}

/** 本库可索引总条数（分母）。 */
export function countEligible(db) {
  return Number(db.prepare(`SELECT COUNT(*) c FROM messages WHERE ${PENDING_WHERE}`).get().c);
}

/** 最大 id（判断新消息是否已到齐）。 */
export function maxMessageId(db) {
  const row = db.prepare("SELECT MAX(id) m FROM messages").get();
  return row?.m === null || row?.m === undefined ? 0 : Number(row.m);
}

/**
 * 一次性拿齐统计，供 vectorStatus() 用。
 */
export function vecStats(db) {
  const total = countEligible(db);
  const indexed = countVectors(db);
  return {
    total,
    indexed,
    missing: countMissing(db),
    watermark: getWatermark(db),
    hotMaxId: getHotMaxId(db),
    maxId: maxMessageId(db),
  };
}

/**
 * 按 id 批量取消息正文。
 * 向量命中只带 {id, dist}，没有 content，必须回查才能拼 snippet。
 * @returns {Map<number, object>}
 */
export function getMessagesByIds(db, ids) {
  const out = new Map();
  if (!ids || ids.length === 0) return out;
  const uniq = [...new Set(ids.map(Number))];
  const ph = uniq.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, session_id, role, content, timestamp FROM messages WHERE id IN (${ph})`
  ).all(...uniq);
  for (const r of rows) out.set(Number(r.id), { ...r, id: Number(r.id) });
  return out;
}

/* ─────────────────────────── 维护 ─────────────────────────── */

/** 清空向量与状态（换模型 / 重建时用）。不删触发器。 */
export function resetVec(db) {
  db.exec(`
    DELETE FROM chunks_vec;
    DELETE FROM msg_chunks;
    DELETE FROM messages_vec;
    UPDATE vec_state SET value = '0' WHERE key IN ('watermark_id', 'hot_max_id', 'warm_floor_id', 'warm_cursor_id');
  `);
}

export const VEC_DIM = DIM;
export const VEC_MODEL_ID = MODEL_ID;
