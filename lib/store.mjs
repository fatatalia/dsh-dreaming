/**
 * store.mjs — dsh-dreaming SQLite 存储（node:sqlite，Node 24 内置）
 *
 * 梦境日记与晋升记录独立存库，便于页面展示/查询，不混入 MEMORY.md。
 * 表：
 *   dreams(id, date, content, created_at)      — 梦境日记正文
 *   promotions(id, dream_id, content, target, evidence, rule, promoted_at) — 晋升内容（信号驱动，可审计）
 *   recall_stats(fragment_hash, snippet, recall_count, unique_queries, first_seen, last_seen, last_query, promoted) — 跨天"被想起"信号累计
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const DEFAULT_DB_PATH = () => join(homedir(), ".dsh", "dreaming.db");

export class DreamStore {
  constructor(dbPath = DEFAULT_DB_PATH()) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS promotions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dream_id INTEGER,
        content TEXT NOT NULL,
        target TEXT NOT NULL,
        evidence TEXT,
        rule TEXT,
        promoted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recall_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fragment_hash TEXT NOT NULL UNIQUE,
        snippet TEXT NOT NULL,
        recall_count INTEGER NOT NULL DEFAULT 0,
        unique_queries INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_query TEXT,
        promoted INTEGER NOT NULL DEFAULT 0
      );
    `);
    // 兼容旧库：promotions 表若缺 evidence/rule 列则补上（老库升级路径）
    this.ensurePromotionColumns();
  }

  /** 老库迁移：promotions 表补 evidence / rule 列（不存在才加）。 */
  ensurePromotionColumns() {
    const cols = this.db.prepare("PRAGMA table_info(promotions)").all().map((c) => c.name);
    if (!cols.includes("evidence")) this.db.exec("ALTER TABLE promotions ADD COLUMN evidence TEXT");
    if (!cols.includes("rule")) this.db.exec("ALTER TABLE promotions ADD COLUMN rule TEXT");
  }

  /** 新增一条梦境日记，返回 id。 */
  addDream({ date, content }) {
    const created = new Date().toISOString();
    const r = this.db.prepare(
      "INSERT INTO dreams (date, content, created_at) VALUES (?, ?, ?)",
    ).run(String(date), String(content), created);
    return Number(r.lastInsertRowid);
  }

  /** 新增一条晋升记录（关联梦境），返回 id。 */
  addPromotion({ dreamId, content, target, evidence = null, rule = null }) {
    const promoted = new Date().toISOString();
    const r = this.db.prepare(
      "INSERT INTO promotions (dream_id, content, target, evidence, rule, promoted_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(dreamId ?? null, String(content), String(target || "MEMORY.md"), evidence ?? null, rule ?? null, promoted);
    return Number(r.lastInsertRowid);
  }

  /** 梦境日记列表（新→旧；可选按日期过滤，date 为 "YYYY-MM-DD"）。 */
  listDreams(limit = 50, date = null) {
    if (date) {
      return this.db.prepare(
        "SELECT id, date, content, created_at FROM dreams WHERE date = ? ORDER BY id DESC",
      ).all(String(date));
    }
    return this.db.prepare(
      "SELECT id, date, content, created_at FROM dreams ORDER BY id DESC LIMIT ?",
    ).all(limit);
  }

  /** 晋升记录列表（新→旧，含关联梦境日期）。 */
  listPromotions(limit = 50) {
    return this.db.prepare(`
      SELECT p.id, p.dream_id, p.content, p.target, p.evidence, p.rule, p.promoted_at, d.date AS dream_date
      FROM promotions p LEFT JOIN dreams d ON d.id = p.dream_id
      ORDER BY p.id DESC LIMIT ?
    `).all(limit);
  }

  /** 单条梦境（含其晋升记录）。 */
  getDream(id) {
    const dream = this.db.prepare("SELECT * FROM dreams WHERE id = ?").get(id);
    if (!dream) return null;
    const promotions = this.db.prepare(
      "SELECT * FROM promotions WHERE dream_id = ? ORDER BY id",
    ).all(id);
    return { ...dream, promotions };
  }

  /** 记录一次"被想起"：累计 recall_count / unique_queries / 天数。 */
  touchRecall({ hash, snippet, query, day }) {
    const existing = this.db.prepare("SELECT * FROM recall_stats WHERE fragment_hash = ?").get(hash);
    if (!existing) {
      this.db.prepare(
        "INSERT INTO recall_stats (fragment_hash, snippet, recall_count, unique_queries, first_seen, last_seen, last_query, promoted) VALUES (?, ?, 1, 1, ?, ?, ?, 0)",
      ).run(hash, String(snippet || ""), day, day, query ?? null);
      return;
    }
    const lastSeenDay = existing.last_seen?.slice(0, 10);
    const sameDay = lastSeenDay === day; // 同日多次命中：计 recall 但不计"新的一天"
    const alreadySeenQuery = existing.last_query === query;
    const newQueryCount = alreadySeenQuery ? existing.unique_queries : existing.unique_queries + 1;
    this.db.prepare(
      "UPDATE recall_stats SET recall_count = recall_count + 1, unique_queries = ?, last_seen = ?, last_query = ? WHERE fragment_hash = ?",
    ).run(newQueryCount, day, query ?? null, hash);
    void sameDay;
  }

  /** 查询全部 recall_stats（信号评估用）。 */
  listRecallStats(limit = 1000) {
    return this.db.prepare("SELECT * FROM recall_stats ORDER BY recall_count DESC, unique_queries DESC LIMIT ?").all(limit);
  }

  /** 按片段哈希查 recall_stats。 */
  getRecallStat(hash) {
    return this.db.prepare("SELECT * FROM recall_stats WHERE fragment_hash = ?").get(hash);
  }

  /** 标记某哈希已晋升（防重复，对齐 OpenClaw promotedAt）。 */
  markPromoted(hash) {
    this.db.prepare("UPDATE recall_stats SET promoted = 1 WHERE fragment_hash = ?").run(hash);
  }

  /** 按归一化文本相似度查重：内容与已有晋升记录相似则视为重复晋升。 */
  findPromotionSimilar(content, threshold = 0.85) {
    const rows = this.db.prepare("SELECT content FROM promotions").all();
    for (const row of rows) {
      if (similarity(String(row.content), String(content)) >= threshold) return row.content;
    }
    return null;
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

/** 简易字符串相似度（字符级 Dice 系数，中文友好）。 */
export function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const da = new Set();
  const db = new Set();
  for (let i = 0; i < a.length - 1; i++) da.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) db.add(b.slice(i, i + 2));
  let inter = 0;
  for (const bigram of da) if (db.has(bigram)) inter++;
  return (2 * inter) / (da.size + db.size);
}
