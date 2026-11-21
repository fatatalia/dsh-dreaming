/**
 * vec-hybrid.mjs —— 向量 + 关键词混合打分
 *
 * 这里集中了四条实测踩出来的修正，每一条漏掉都会「看起来能跑但其实错」：
 *
 *   ① `ORDER BY d`         —— vec0 的 KNN 不保证有序，在 vec-store 里已强制
 *   ② BM25 归一化          —— 关键词分必须映射到 [0,1]
 *   ③ LIKE 路由假满分      —— db.search 的 LIKE 分支 score 硬编码 0，
 *                              bm25RankToScore(0) = 1.0 满分，必须单独降权
 *   ④ 单路命中按单路归一    —— 只有关键词分的结果若按 0.3×txt 算，最高 0.3，
 *                              永远过不了 minScore；刚入库未索引的消息全落这里
 */

/** OpenClaw 的归一化函数（manager-DB4_iNu4.js:394-401），照抄。 */
export function bm25RankToScore(rank) {
  if (!Number.isFinite(rank)) return 1e-3;
  if (rank < 0) {
    const rel = -rank;
    return rel / (1 + rel);
  }
  return 1 / (1 + rank);
}

/**
 * db.search 返回的分 → [0,1]。
 * ⚠️ LIKE 路由的 score 是硬编码 0，直接归一化会变成满分 1.0，
 *    所以按 `via` 单独给一个低权重，而不是让它冒充完美命中。
 */
export function textScoreOf(row) {
  if (!row) return 0;
  if (row.via === "like") return 0.25;
  return bm25RankToScore(row.score);
}

/**
 * 合并两路结果并打分。
 *
 * @param {object} p
 * @param {Array<{id:number, dist:number}>} p.vecHits      向量命中（dist 越小越近）
 * @param {Array<object>} p.textHits                        关键词命中（db.search 的行）
 * @param {number} p.vectorWeight                           默认 0.7
 * @param {number} p.excludeSessionId                       回声抑制：排除当前会话
 * @param {number} p.minScore                               默认 0.62
 * @param {number} p.perSessionLimit                        同一会话最多几条，默认 2
 * @param {number} p.topK                                   最终返回几条，默认 6
 * @param {(ids:number[]) => Map<number,object>} p.fetchRows 向量命中缺正文时回查，可省略
 * @returns {Array<object>} 已过滤、已排序的结果
 */
export function mergeHybrid({
  vecHits = [],
  textHits = [],
  vectorWeight = 0.7,
  excludeSessionId = null,
  minScore = 0.62,
  perSessionLimit = 2,
  topK = 6,
  fetchRows = null,
} = {}) {
  // textWeight 恒为 1 - vectorWeight：两个权重独立填若都填小值，
  // 总分整体缩水，所有结果被 minScore 静默误杀。
  const vw = clamp01(vectorWeight);
  const tw = 1 - vw;

  /** id → 合并后的条目 */
  const pool = new Map();

  const ensure = (row) => {
    const id = Number(row.id);
    let e = pool.get(id);
    if (!e) {
      e = {
        id,
        sessionId: row.session_id ?? "",
        role: row.role ?? "",
        content: row.content ?? "",
        timestamp: row.timestamp ?? 0,
        vec: 0,
        txt: 0,
      };
      pool.set(id, e);
    }
    return e;
  };

  // ── 向量路：dist → score = 1 - dist（余弦距离天然落在 [0,1]，但可能溢出）
  for (const h of vecHits) {
    const e = ensure(h);
    e.vec = Math.max(0, Math.min(1, 1 - Number(h.dist)));
  }

  // ── 关键词路
  for (const r of textHits) {
    const e = ensure(r);
    const s = textScoreOf(r);
    if (s > e.txt) e.txt = s; // 同一 id 可能多次命中，取最高
  }

  /*
   * 向量命中只带 {id, dist}，session_id / content 全是空。
   * 回声抑制和拼 snippet 都需要正文，所以必须回查。
   * 只回查「还没有正文」的那部分 id。
   */
  if (fetchRows) {
    const need = [];
    for (const e of pool.values()) {
      if (!e.content) need.push(e.id);
    }
    if (need.length > 0) {
      const rows = fetchRows(need);
      for (const [id, row] of rows) {
        const e = pool.get(id);
        if (!e) continue;
        e.sessionId = row.session_id ?? "";
        e.role = row.role ?? "";
        e.content = row.content ?? "";
        e.timestamp = row.timestamp ?? 0;
      }
    }
  }

  // ── 回声抑制：当前会话的消息不注入（否则检索出来的全是刚说过的话）
  if (excludeSessionId) {
    for (const [id, e] of pool) {
      if (e.sessionId === excludeSessionId) pool.delete(id);
    }
  }

  // ── 打分
  const scored = [];
  for (const e of pool.values()) {
    let score;
    if (e.vec > 0 && e.txt > 0) score = vw * e.vec + tw * e.txt;
    else if (e.vec > 0) score = e.vec;      // 只有向量
    else if (e.txt > 0) score = e.txt;      // 只有关键词
    else continue;

    if (score < minScore) continue;
    scored.push({ ...e, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // ── 同一会话最多 perSessionLimit 条，避免一段对话霸屏
  const perSession = new Map();
  const picked = [];
  for (const e of scored) {
    const n = perSession.get(e.sessionId) || 0;
    if (n >= perSessionLimit) continue;
    perSession.set(e.sessionId, n + 1);
    picked.push(e);
    if (picked.length >= topK) break;
  }

  return picked;
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0.7;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * 把结果压成注入用的文本片段。
 * @param {Array<object>} hits
 * @param {number} maxChars 每条最多多少字
 */
export function toSnippets(hits, maxChars = 200) {
  return hits.map((h) => {
    const raw = String(h.content ?? "").replace(/\s+/g, " ").trim();
    const text = raw.length > maxChars ? raw.slice(0, maxChars) + "…" : raw;
    return {
      id: h.id,
      role: h.role,
      timestamp: h.timestamp,
      score: h.score,
      snippet: text,
    };
  });
}
