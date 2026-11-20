/**
 * dsh-fatatalia-memory · lib/db.mjs
 *
 * SQLite 存储层。用 **node:sqlite 内置模块**（Node 24 自带，SQLite 3.53.3），
 * 零外部依赖 —— 这是选它的核心理由：不必给 dsh 主实例塞 native 依赖。
 *
 * ── 检索分流（本文件最关键的一段逻辑）────────────────────────────────
 *
 * FTS5 `trigram` tokenizer 把文本切成 3 字符滑窗。**查询串不足 3 个字符时必然 0 命中**，
 * 与语料是否含该词无关。2026-09-29 实测（对 17 个知识页）：
 *
 *     「三」    (1 字) → 0      「SQL」  (3) → 6
 *     「三层」  (2 字) → 0      「iMe」  (3) → 14
 *     「三层记」(3 字) → 7  ← 门槛
 *
 * ⇒ 因此：**查询 ≥3 个字符走 FTS5 MATCH，<3 个字符回退 LIKE**。
 *   长度按 **Unicode 码点**数（`[...q].length`），中文一字算一个 —— `q.length`
 *   对代理对（emoji）会算 2，用码点更准。
 *
 * ── 三路分流（2026-11-20 照 Hermes Agent 对齐）──────────────────────
 *
 * 只按「整串长度」分流是不够的：多词查询被整串当一个 phrase，
 * 「梦境记忆 注入」要求两词连续出现 → 必然 0 命中。Hermes 的做法是按 token 判：
 *
 *   ① 无 CJK                      → messages_fts（unicode61），bm25
 *   ② CJK，且**每个** token ≥3 字  → messages_fts_trigram，bm25
 *   ③ CJK，有 token <3 字          → LIKE 子串全扫，每 token 一子句、OR 连接
 *
 * ③ 的判断必须**逐 token**：`广西 桂林` 总共 4 个 CJK 字，但每 token 只有 2 字，
 * trigram 仍然 0 命中（Hermes `_trigram_route_ok` 的注释原话）。
 * LIKE 层 token 之间用 OR 而非 AND —— 召回优先，命中任一词就返回。
 *
 * 参考实现：hermes-agent `persistence/sqlite/conversation/_store/search.py`
 * （`_trigram_route_ok` / `_has_short_cjk_token` / `_search_cjk`）。
 */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** 把 `~/x` 展开成绝对路径。 */
export function expandPath(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** 2026-11-20 两插件合并：与 dreaming 共用一个库，文件名按公共插件命名规律。 */
export const DEFAULT_DB_PATH = join(homedir(), ".dsh", "dreaming-memory.db");

/** 按 Unicode 码点数长度（CJK/emoji 友好）。 */
export function charLen(s) {
  return [...String(s ?? "")].length;
}

// ── CJK 判定（照 Hermes Agent 的码点区间）────────────────────────────
const CJK_RANGES = [
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0x3400, 0x4dbf], // 扩展 A
  [0x20000, 0x2a6df], // 扩展 B
  [0x3000, 0x303f], // CJK 标点
  [0x3040, 0x309f], // 平假名
  [0x30a0, 0x30ff], // 片假名
  [0xac00, 0xd7af], // 谚文音节
];

/** 该码点是否属 CJK/日文/韩文区。 */
function isCjkCodePoint(cp) {
  return CJK_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** 文本里是否含 CJK 字符。 */
function containsCjk(s) {
  for (const ch of String(s ?? "")) if (isCjkCodePoint(ch.codePointAt(0))) return true;
  return false;
}

/** 统计 CJK 字符个数（按码点）。 */
function countCjk(s) {
  let n = 0;
  for (const ch of String(s ?? "")) if (isCjkCodePoint(ch.codePointAt(0))) n += 1;
  return n;
}

/** FTS5 保留操作符，拆词时要跳过（否则会被当成语法）。 */
const FTS_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);

/**
 * 按空白拆 token，去掉 FTS5 操作符。
 * 为什么按空白：FTS5 自身没有中文分词器，我们也不做词法分析 ——
 * 只把用户用空格隔开的部分当独立词，这是 Hermes 的做法（`_non_operator_tokens`）。
 */
function searchTokens(q) {
  return String(q ?? "")
    .split(/\s+/)
    .filter((t) => t && !FTS_OPERATORS.has(t.toUpperCase()));
}

/**
 * 是否有「<3 个 CJK 字」的 token —— trigram 对这类 token 必然 0 命中，
 * 且 FTS5 隐式 AND 会让整个 MATCH 归零（Hermes `_has_short_cjk_token`）。
 */
function hasShortCjkToken(q) {
  return searchTokens(q).some((t) => containsCjk(t) && countCjk(t) < 3);
}

/**
 * 能否走 trigram：含 CJK、总 CJK 字 ≥3、且没有任何 <3 字的 CJK token。
 * 反例：`广西 桂林` —— 总 4 字但每 token 2 字，trigram 0 命中。
 */
function trigramRouteOk(q) {
  return containsCjk(q) && countCjk(q) >= 3 && !hasShortCjkToken(q);
}

/**
 * 把查询转成 FTS5 MATCH 表达式：**逐 token 加双引号，空格连接**。
 *
 * 空格在 FTS5 里是隐式 AND，所以 `梦境记忆 注入` 变成 `"梦境记忆" "注入"` ——
 * 两词各自命中即可，不再要求连续出现。这是修掉「多词查询必然 0 命中」的关键。
 *
 * 双引号内的双引号要写两次（FTS5 短语转义），否则语法报错。
 */
function toFtsQuery(q) {
  const tokens = searchTokens(q);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(" ");
}

/** 转义 LIKE 模式里的 `%` `_` `\`（配合 `ESCAPE '\'` 使用）。 */
function escapeLike(s) {
  return String(s ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export class MemoryDB {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.path = expandPath(dbPath);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this._init();
  }

  _init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        workspace     TEXT,
        source        TEXT,
        title         TEXT,
        started_at    REAL NOT NULL,
        ended_at      REAL,
        message_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        seq        INTEGER,
        role       TEXT NOT NULL,
        content    TEXT,
        timestamp  REAL NOT NULL,
        turn       INTEGER,
        step       INTEGER,
        event_type TEXT,
        tool_call_id TEXT,
        is_error   INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
      -- 注意：seq 相关索引不能放在这里。老库的 messages 表建表时还没有 seq 列，
      -- 索引会先于 _migrate() 的 ALTER 执行并报 no such column: seq。
      -- 它们在 _migrate() 补列成功之后才创建。

      -- 注意：两张 FTS 表必须同为 external-content。曾经把 messages_fts_trigram 建成
      -- inline（无 content=），结果删除触发器对 inline 表发 'delete' 命令必然报
      -- SQL logic error，连 DELETE FROM messages 都做不了（2026-09-29 实测）。
      -- 已验证 trigram 与 content=/content_rowid= 完全兼容（含 rebuild 与三种触发器）。
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, content='messages', content_rowid='id'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
        content, content='messages', content_rowid='id', tokenize='trigram'
      );

      -- 注意：触发器定义统一在 _createFtsTriggers() 里（_init 末尾调用），
      -- 不在此处内联 —— 否则同一套定义存在两份，改一处忘另一处必然出事。

      CREATE TABLE IF NOT EXISTS knowledge_pages (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        tags        TEXT,
        folder      TEXT,
        content     TEXT,
        source      TEXT,
        page_ts     TEXT,
        updated_at  REAL NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        name, description, content, tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        session_id  TEXT PRIMARY KEY,
        last_seq    INTEGER NOT NULL DEFAULT -1,
        last_sync   REAL
      );

      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    this._migrate();
    this._stmts = {};
  }

  /**
   * 补列迁移。
   *
   * `CREATE TABLE IF NOT EXISTS` **不会**修改已存在的表 —— 探针阶段建的 messages 表
   * 只有 (id, session_id, role, content, timestamp)，缺 seq/turn/step/… 六列。
   * 直接跑预编译语句会炸 `no such column: seq`（2026-09-29 实测踩到）。
   * 因此这里显式检查并 ALTER 补列，老库无需重建、知识页数据不丢。
   */
  _migrate() {
    const have = new Set(this.db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name));
    const want = {
      seq: "INTEGER",
      turn: "INTEGER",
      step: "INTEGER",
      event_type: "TEXT",
      tool_call_id: "TEXT",
      is_error: "INTEGER DEFAULT 0",
    };
    const added = [];
    for (const [col, type] of Object.entries(want)) {
      if (!have.has(col)) {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
        added.push(col);
      }
    }
    // 无条件建（IF NOT EXISTS 幂等）—— 不能只在 added.length 时建：
    // 全新的库建表时就带 seq，added 为空，但索引仍然需要存在。
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(session_id, seq)`);
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_uniq ON messages(session_id, seq, role)`);

    this._migrateFts();
    return added;
  }

  /**
   * FTS 表模式迁移：把 inline 的 messages_fts_trigram 改造成 external-content。
   *
   * 探针阶段把它建成了 `fts5(content, tokenize='trigram')`（inline）。inline 表上
   * 发 `VALUES('delete', …)` 命令会报 `SQL logic error`，导致删除触发器把
   * `DELETE FROM messages` 一起拖死（2026-09-29 实测）。external-content 模式才支持
   * 该命令。`CREATE VIRTUAL TABLE IF NOT EXISTS` 不会改已存在的表，所以这里显式重建。
   *
   * **触发器无论如何都要刷新**（2026-11-20 修）：原实现「已是 external-content 就
   * return」导致老库的旧触发器永远留着 —— 触发器定义随版本演进（trigram 加了
   * `role <> 'tool'` 过滤），提前返回等于新定义静默不生效。
   */
  _migrateFts() {
    const row = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts_trigram'`
    ).get();
    const alreadyExternal = !row?.sql || /content\s*=/.test(row.sql);

    if (!alreadyExternal) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS messages_fts_ai;
        DROP TRIGGER IF EXISTS messages_fts_ad;
        DROP TRIGGER IF EXISTS messages_fts_au;
        DROP TABLE IF EXISTS messages_fts_trigram;
        CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
          content, content='messages', content_rowid='id', tokenize='trigram'
        );
        INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('rebuild');
      `);
    }
    this._createFtsTriggers();
    if (!alreadyExternal) return true;

    return this._migrateTrigramToolExclusion();
  }

  /**
   * 一次性迁移：把 trigram 索引里的 tool 行剔除（2026-11-20 照 Hermes 对齐）。
   *
   * 为什么需要独立迁移：`'rebuild'` 命令**无视触发器**，直接扫 content 表全量重建 ——
   * 所以光改触发器不会影响既有索引，必须显式重灌。
   *
   * 做法：DROP 表 → 重建 → **手动** `INSERT ... SELECT ... WHERE role <> 'tool'`。
   * 用 meta 表里的标记保证只跑一次（全量重灌 4 万多行，每次启动都跑不可接受）。
   */
  _migrateTrigramToolExclusion() {
    const MARK = "trigram_tool_exclusion_v1";
    const done = this.db.prepare(`SELECT v FROM meta WHERE k = ?`).get(MARK);
    if (done) return false;

    this.db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      DROP TABLE IF EXISTS messages_fts_trigram;
      CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
        content, content='messages', content_rowid='id', tokenize='trigram'
      );
      INSERT INTO messages_fts_trigram(rowid, content)
        SELECT id, content FROM messages WHERE role <> 'tool' AND content IS NOT NULL;
    `);
    this._createFtsTriggers();
    this.db.prepare(`INSERT INTO meta(k, v) VALUES(?, ?)
                     ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(MARK, String(Date.now()));
    return true;
  }

  /**
   * 建 FTS 同步触发器（重建表后需重跑）。
   *
   * **用 DROP + CREATE 而非 IF NOT EXISTS**：触发器定义会随版本演进
   * （2026-11-20 给 trigram 加了 `role <> 'tool'` 过滤），若用 IF NOT EXISTS，
   * 老库里的旧触发器永远留着，新定义静默不生效 —— 索引照样索引 tool 行。
   *
   * trigram 侧的条件写在 **WHERE 子句**（`INSERT ... SELECT ... WHERE`）里，
   * 不写成触发器 `WHEN`：`WHEN` 是**整个触发器**的闸门，会把 BEGIN 块里所有语句
   * 一起挡住 —— 而 DELETE 侧必须无条件发 `'delete'`，否则「先以 user 写入、
   * 再改成 tool」的行会在索引里留垃圾。
   * （两种写法在 node:sqlite 下都验证可用，见 test；选 WHERE 只为语句级精确控制。）
   * ⚠️ 用 `sqlite3` CLI 手工验证时会报 `unsafe use of virtual table` ——
   * 那是 CLI 默认 `trusted_schema=OFF`，不是语句写错；node:sqlite 默认为 1。
   */
  _createFtsTriggers() {
    this.db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;

      -- 插入：messages_fts 无条件；trigram 只要非 tool 行
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        INSERT INTO messages_fts_trigram(rowid, content)
          SELECT new.id, new.content WHERE new.role <> 'tool';
      END;

      -- 删除：两个表都必须无条件发 delete，否则索引与 content 表失同步
      -- （先判断 role 再决定要不要 delete 会让"先非 tool 后改 role"的行残留垃圾）
      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content)
          SELECT 'delete', old.id, old.content WHERE old.role <> 'tool';
      END;

      -- 更新：先删旧、再按新内容的 role 决定是否写回
      CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content)
          SELECT 'delete', old.id, old.content WHERE old.role <> 'tool';
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        INSERT INTO messages_fts_trigram(rowid, content)
          SELECT new.id, new.content WHERE new.role <> 'tool';
      END;
    `);
  }

  /** 预编译语句缓存。 */
  _s(key, sql) {
    if (!this._stmts[key]) this._stmts[key] = this.db.prepare(sql);
    return this._stmts[key];
  }

  // ── 会话 ─────────────────────────────────────────────────────────────
  upsertSession({ id, workspace, source, title, startedAt }) {
    if (!id) return;
    this._s("upsertSession", `
      INSERT INTO sessions(id, workspace, source, title, started_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace = COALESCE(excluded.workspace, sessions.workspace),
        source    = COALESCE(excluded.source, sessions.source),
        title     = COALESCE(excluded.title, sessions.title)
    `).run(id, workspace ?? null, source ?? null, title ?? null, startedAt ?? Date.now() / 1000);
  }

  bumpSession(id, count = 0) {
    if (!id) return;
    this._s("bumpSession", `UPDATE sessions SET message_count = message_count + ? WHERE id = ?`).run(count, id);
  }

  setSessionTitle(id, title) {
    if (!id || !title) return;
    this._s("setTitle", `UPDATE sessions SET title = ? WHERE id = ?`).run(title, id);
    this._s("setTitleIns", `INSERT OR IGNORE INTO sessions(id, title, started_at) VALUES(?, ?, ?)`).run(id, title, Date.now() / 1000);
  }

  // ── 消息写入 ─────────────────────────────────────────────────────────
  /** 批量插入消息，返回实际新增条数（靠 UNIQUE(session_id,seq,role) 去重）。 */
  insertMessages(sessionId, msgs) {
    if (!sessionId || !Array.isArray(msgs) || !msgs.length) return 0;
    const st = this._s("insMsg", `
      INSERT OR IGNORE INTO messages
        (session_id, seq, role, content, timestamp, turn, step, event_type, tool_call_id, is_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const m of msgs) {
        const r = st.run(
          sessionId,
          m.seq ?? null,
          m.role ?? "unknown",
          m.content ?? "",
          m.timestamp ?? Date.now(),
          m.turn ?? null,
          m.step ?? null,
          m.eventType ?? null,
          m.toolCallId ?? null,
          m.isError ? 1 : 0,
        );
        if (r.changes) n += r.changes;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw e;
    }
    if (n) this.bumpSession(sessionId, n);
    return n;
  }

  /** 读某会话已同步到的最大 seq。 */
  getLastSeq(sessionId) {
    const r = this._s("getLastSeq", `SELECT last_seq FROM sync_state WHERE session_id = ?`).get(sessionId);
    return r?.last_seq ?? -1;
  }

  setLastSeq(sessionId, seq) {
    this._s("setLastSeq", `
      INSERT INTO sync_state(session_id, last_seq, last_sync) VALUES(?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq, last_sync = excluded.last_sync
    `).run(sessionId, seq ?? -1, Date.now());
  }

  // ── ★ 检索分流 ───────────────────────────────────────────────────────
  /**
   * 检索历史对话。三路分流（详见文件头注释）：
   *
   *   ① 无 CJK                     → unicode61 表，bm25
   *   ② CJK 且每 token ≥3 字        → trigram 表，bm25
   *   ③ CJK 且有 token <3 字        → LIKE 全扫，每 token 一子句、OR
   *
   * `via` 回报实际走的路径，便于排查「为什么这条搜不到」。
   *
   * @param {string} query
   * @param {{limit?:number, sessionId?:string, roles?:string[], since?:number}} opts
   */
  search(query, opts = {}) {
    const q = String(query ?? "").trim();
    if (!q) return [];
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
    const clauses = [];
    const params = [];

    if (opts.sessionId) { clauses.push("m.session_id = ?"); params.push(opts.sessionId); }
    if (opts.since) { clauses.push("m.timestamp >= ?"); params.push(opts.since); }
    if (Array.isArray(opts.roles) && opts.roles.length) {
      clauses.push(`m.role IN (${opts.roles.map(() => "?").join(",")})`);
      params.push(...opts.roles);
    }
    const filter = clauses.length ? " AND " + clauses.join(" AND ") : "";

    const matchQuery = toFtsQuery(q);
    const cjk = containsCjk(q);

    // ② trigram：仅当每个 CJK token 都够长。trigram 表已排除 role='tool'（见触发器），
    //   所以显式要 tool 行时不能走这条路，否则必然漏结果 —— 交给 ③。
    const wantsToolRows = Array.isArray(opts.roles) && opts.roles.includes("tool");
    if (matchQuery && (!cjk || (trigramRouteOk(q) && !wantsToolRows))) {
      const table = cjk ? "messages_fts_trigram" : "messages_fts";
      try {
        const rows = this._s("searchFts" + table + filter, `
          SELECT m.id, m.session_id, m.seq, m.role, m.content, m.timestamp, m.turn, m.step,
                 snippet(${table}, 0, '«', '»', '…', 24) AS snip,
                 bm25(${table}) AS score
          FROM ${table} f
          JOIN messages m ON m.id = f.rowid
          WHERE ${table} MATCH ?${filter}
          ORDER BY score LIMIT ?
        `).all(matchQuery, ...params, limit);
        if (rows.length) return rows.map((r) => ({ ...r, via: cjk ? "fts-trigram" : "fts" }));
      } catch { /* 语法错误 / 索引不可用 → 落 LIKE */ }
    }

    // ③ LIKE 全扫：每个 token 一组子句，组间 OR（召回优先，命中任一词即可）。
    //    ⚠️ 本表只有 content 一个文本列（无 Hermes 的 tool_name/tool_calls），
    //       所以每组就一个 LIKE。
    // ⚠️ 缓存 key 必须带 filter：SQL 的占位符个数随 filter 变化，
    //    若共用同一个 key，第二次会拿旧语句配新参数 → column index out of range。
    // ⚠️ 也要带 token 个数：token 数不同 → 占位符数量不同，同样会错配。
    const tokens = searchTokens(q);
    const likeTokens = tokens.length ? tokens : [q];
    const likeWhere = likeTokens.map(() => "m.content LIKE ? ESCAPE '\\'").join(" OR ");
    const likeParams = likeTokens.map((t) => `%${escapeLike(t)}%`);
    const rows = this._s("searchLike" + likeTokens.length + filter, `
      SELECT m.id, m.session_id, m.seq, m.role, m.content, m.timestamp, m.turn, m.step,
             substr(m.content, 1, 240) AS snip, 0 AS score
      FROM messages m
      WHERE (${likeWhere})${filter}
      ORDER BY m.timestamp DESC LIMIT ?
    `).all(...likeParams, ...params, limit);
    return rows.map((r) => ({ ...r, via: "like" }));
  }

  /** 最近 N 条消息（无查询词，按时间倒序）。 */
  recent(limit = 20, sessionId = null) {
    const l = Math.min(Math.max(limit, 1), 200);
    if (sessionId) {
      return this._s("recentOne", `
        SELECT id, session_id, seq, role, content, timestamp, turn, step
        FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?
      `).all(sessionId, l);
    }
    return this._s("recentAll", `
      SELECT id, session_id, seq, role, content, timestamp, turn, step
      FROM messages ORDER BY timestamp DESC LIMIT ?
    `).all(l);
  }

  // ── 上下文读取（memory_read 用）─────────────────────────────────────
  /** 按消息 id 取单条（用于拿到它的 session_id / seq 当锚点）。 */
  getMessage(id) {
    const n = Number(id);
    if (!Number.isFinite(n)) return null;
    return this._s("getMessage", `
      SELECT id, session_id, seq, role, content, timestamp, turn, step
      FROM messages WHERE id = ?
    `).get(n) ?? null;
  }

  /**
   * 以某条消息为中心读上下文（同一会话，前后各半）。
   *
   * 为什么需要它：`memory_search` 只返回 400 字片段，看不到「这句话的前因后果」。
   * 本方法补上上下文窗口。
   *
   * @param sessionId 会话 id
   * @param centerSeq 中心 seq；非有限数时退化为「该会话最近 limit 条」
   * @param limit     总条数（含中心点），1-200
   */
  readAround(sessionId, centerSeq, limit = 20) {
    const sid = String(sessionId ?? "");
    if (!sid) return [];
    const l = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const center = Number(centerSeq);
    const COLS = "id, session_id, seq, role, content, timestamp, turn, step";

    // 无中心点 → 该会话最近 l 条（正序返回，方便阅读）
    if (!Number.isFinite(center)) {
      return this._s("readAroundTail", `
        SELECT ${COLS} FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?
      `).all(sid, l).reverse();
    }

    const half = Math.floor(l / 2);
    const before = this._s("readAroundBefore", `
      SELECT ${COLS} FROM messages WHERE session_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?
    `).all(sid, center, l - half);
    const after = this._s("readAroundAfter", `
      SELECT ${COLS} FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?
    `).all(sid, center, half);
    return [...before.reverse(), ...after];
  }

  // ── 知识页 ───────────────────────────────────────────────────────────
  /** 检索知识页（与 messages 同一套三路分流）。 */
  searchKnowledge(query, limit = 5) {
    const q = String(query ?? "").trim();
    if (!q) return [];
    const l = Math.min(Math.max(limit, 1), 50);
    const matchQuery = toFtsQuery(q);
    const cjk = containsCjk(q);

    // knowledge_fts 只有 trigram tokenizer，没有 unicode61 表 ——
    // 所以非 CJK 长查询也走 trigram（ASCII ≥3 码点时 trigram 一样可用）。
    if (matchQuery && (!cjk || trigramRouteOk(q))) {
      try {
        const rows = this._s("kFts", `
          SELECT p.id, p.name, p.folder, snippet(knowledge_fts, 2, '«', '»', '…', 20) AS snip,
                 bm25(knowledge_fts) AS score
          FROM knowledge_fts f JOIN knowledge_pages p ON p.rowid = f.rowid
          WHERE knowledge_fts MATCH ? ORDER BY score LIMIT ?
        `).all(matchQuery, l);
        if (rows.length) return rows.map((r) => ({ ...r, via: "fts-trigram" }));
      } catch { /* 语法错 / 索引不可用 → 落 LIKE */ }
    }

    // LIKE：每 token 一子句、OR 连接（召回优先）
    const tokens = searchTokens(q);
    const likeTokens = tokens.length ? tokens : [q];
    const likeWhere = likeTokens
      .map(() => "(name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')").join(" OR ");
    const likeParams = likeTokens.flatMap((t) => {
      const pat = `%${escapeLike(t)}%`;
      return [pat, pat];
    });
    return this._s("kLike" + likeTokens.length, `
      SELECT id, name, folder, substr(content, 1, 240) AS snip, 0 AS score
      FROM knowledge_pages WHERE (${likeWhere}) LIMIT ?
    `).all(...likeParams, l).map((r) => ({ ...r, via: "like" }));
  }

  listKnowledge() {
    return this._s("kList", `SELECT id, name, folder, updated_at FROM knowledge_pages ORDER BY name`).all();
  }

  readKnowledge(id) {
    return this._s("kRead", `SELECT * FROM knowledge_pages WHERE id = ? OR name = ? LIMIT 1`).get(id, id) ?? null;
  }

  // ── 统计 ─────────────────────────────────────────────────────────────
  stats() {
    const g = (sql) => this.db.prepare(sql).get();
    return {
      dbPath: this.path,
      sessions: g(`SELECT COUNT(*) AS n FROM sessions`).n,
      messages: g(`SELECT COUNT(*) AS n FROM messages`).n,
      byRole: this.db.prepare(`SELECT role, COUNT(*) AS n FROM messages GROUP BY role ORDER BY n DESC`).all(),
      knowledge: g(`SELECT COUNT(*) AS n FROM knowledge_pages`).n,
      oldest: g(`SELECT MIN(timestamp) AS t FROM messages`).t,
      newest: g(`SELECT MAX(timestamp) AS t FROM messages`).t,
    };
  }

  close() {
    try { this.db.close(); } catch {}
  }
}
