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
  // ⚠️ vec0 虚拟表不支持 INSERT OR REPLACE —— 重复 id 直接报
  //    "UNIQUE constraint failed on messages_vec primary key"（实测）。
  //    只能先 DELETE 再 INSERT。
  db.prepare("DELETE FROM messages_vec WHERE id = ?").run(BigInt(id));
  db.prepare("INSERT INTO messages_vec(id, embedding) VALUES(?, ?)")
    .run(BigInt(id), new Float32Array(vec));
}

export function putVectors(db, rows) {
  const del = db.prepare("DELETE FROM messages_vec WHERE id = ?");
  const ins = db.prepare("INSERT INTO messages_vec(id, embedding) VALUES(?, ?)");
  for (const { id, vec } of rows) {
    del.run(BigInt(id));
    ins.run(BigInt(id), new Float32Array(vec));
  }
}

export function deleteVector(db, id) {
  db.prepare("DELETE FROM messages_vec WHERE id = ?").run(BigInt(id));
}

export function hasVector(db, id) {
  try {
    const row = db.prepare("SELECT 1 AS x FROM messages_vec WHERE id = ?").get(BigInt(id));
    return !!row;
  } catch {
    return false;
  }
}

export function countVectors(db) {
  try {
    return Number(db.prepare("SELECT COUNT(*) c FROM messages_vec").get().c);
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
  const rows = db.prepare(`
    SELECT id, distance AS d
    FROM messages_vec
    WHERE embedding MATCH ? AND k = ?
    ORDER BY d
  `).all(new Float32Array(vec), k);

  // 读出来的 id 是 BigInt —— JSON.stringify 会直接炸，必须转回 number。
  // dist 是 cosine 距离 = 1 - cos_sim，范围 [0,2]；1 - dist 即余弦相似度。
  return rows.map((r) => ({ id: Number(r.id), dist: Number(r.d) }));
}

/* ─────────────────────────── 候选与统计 ─────────────────────────── */

/** 待索引消息的条件。与 syncOnce / countPending 必须完全一致。 */
const PENDING_WHERE = `
  role IN ('user','assistant')
  AND length(content) >= 10
  AND session_id NOT LIKE 'dreaming-%'
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
    ${onlyMissing ? "LEFT JOIN messages_vec v ON v.id = m.id" : ""}
    WHERE m.id > ? ${upper} AND ${PENDING_WHERE}
    ${onlyMissing ? "AND v.id IS NULL" : ""}
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
      LEFT JOIN messages_vec v ON v.id = m.id
      WHERE v.id IS NULL AND ${PENDING_WHERE}
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
    DELETE FROM messages_vec;
    UPDATE vec_state SET value = '0' WHERE key IN ('watermark_id', 'hot_max_id', 'warm_floor_id', 'warm_cursor_id');
  `);
}

export const VEC_DIM = DIM;
export const VEC_MODEL_ID = MODEL_ID;
