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
 *   ③ CJK，有 token <3 字          → LIKE 子串全扫，每 token 一子句、AND 连接
 *
 * ③ 的判断必须**逐 token**：`广西 桂林` 总共 4 个 CJK 字，但每 token 只有 2 字，
 * trigram 仍然 0 命中（Hermes `_trigram_route_ok` 的注释原话）。
 * LIKE 层与 FTS 层严格同构：**组内 AND、组间 OR**。组由查询里的 `OR` 关键字切分；没有 `OR` 时整句就是一个组，
 * ⇒ 所有 token 都必须命中（2026-11-20 核实：`toLikeClauses` 里是 `join(" AND ")`，此前本注释写作「用 OR 而非 AND」，与实现相反）。
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

/** FTS5 保留操作符。NEAR 我们不支持（语义含糊），当普通词处理。 */
const FTS_OPERATORS = new Set(["AND", "OR", "NOT"]);

/**
 * 把查询解析成 **OR 分组**（照 FTS5 原生语义，也是 Hermes `_compile_like_boolean_query` 的做法）。
 *
 * - 组内 **隐式 AND**：`梦境 注入` → 同一组两个词，都命中才算
 * - `OR` **开新组**：`广西 OR 桂林` → 两组，命中任一即可
 * - `NOT` **标记下一个词取反**：`梦境 NOT 注入`
 * - **引号里的整串是一个 phrase**：`"梦境记忆 注入"` 要求连续出现
 * - **结尾 `*` 是前缀匹配**：`nimb*`（CJK 除外 —— trigram 会把它当字面星号）
 *
 * 返回 `{ groups: [[{text, negate, prefix}]], explicitOr, explicitNot }`。
 * 空查询返回 `{ groups: [] }`。
 *
 * 为什么不直接交给 FTS5 解析：SQLite 的 FTS5 语法遇到未转义的特殊字符会抛错，
 * 而我们还必须用**同一套分组**去生成 LIKE SQL（走 ③ 时），两边语义不一致就会出现
 * 「fts 搜得到、like 搜不到」。所以自己解析一次，两处共用。
 */
function parseQuery(q) {
  const raw = String(q ?? "");
  const groups = [[]];
  let negateNext = false;
  let explicitOr = false;
  let explicitNot = false;

  // 先按「引号短语 | 空白分隔」切分，保住引号内的空格
  const parts = raw.match(/"[^"]*"|\S+/g) ?? [];
  for (const part of parts) {
    const upper = part.toUpperCase();
    if (upper === "OR") {
      if (groups[groups.length - 1].length) { groups.push([]); explicitOr = true; }
      negateNext = false;
      continue;
    }
    if (upper === "AND") { negateNext = false; continue; }
    if (upper === "NOT") { negateNext = true; explicitNot = true; continue; }

    // 引号短语：整串一个 term，内部不拆
    const quoted = part.startsWith('"');
    let text = quoted ? part.slice(1, part.length - 1) : part;
    let prefix = false;
    // 前缀通配：只对非 CJK 生效 —— trigram 路由下 `*` 会被引号包成字面星号，
    // 剥掉它至少保证语义是「包含该词」而不是「包含星号」（Hermes `_strip_cjk_wildcards`）。
    if (!quoted && text.endsWith("*")) {
      text = text.replace(/\*+$/, "");
      if (text && !containsCjk(text)) prefix = true;
    }
    if (!text) { negateNext = false; continue; }

    groups[groups.length - 1].push({ text, negate: negateNext, prefix });
    negateNext = false;
  }

  return { groups: groups.filter((g) => g.length), explicitOr, explicitNot };
}

/** 解析结果里的全部正向词（`NOT` 的不算）—— 路由判据只看正向词。 */
function positiveTerms(parsed) {
  return parsed.groups.flat().filter((t) => !t.negate).map((t) => t.text);
}

/** 解析结果里的全部词（**含取反**）—— 取反词也要进 MATCH，必须能被 tokenizer 表达。 */
function allTerms(q) {
  return parseQuery(q).groups.flat().map((t) => t.text);
}

/** 兼容旧调用：只取正向词。 */
function searchTokens(q) {
  return positiveTerms(parseQuery(q));
}

/**
 * 是否有「<3 个 CJK 字」的 token —— trigram 对这类 token 必然 0 命中，
 * 且 FTS5 隐式 AND 会让整个 MATCH 归零（Hermes `_has_short_cjk_token`）。
 *
 * ⚠️ 必须检查**全部**词，含取反的。取反词表达不了时 `NOT "浇水"` 在 trigram 里
 * 什么都排除不掉（因为「浇水」本就搜不到），结果会静默变成「不排除」—— 比报错更糟。
 */
function hasShortCjkToken(q) {
  return allTerms(q).some((t) => containsCjk(t) && countCjk(t) < 3);
}

/**
 * 能否走 trigram：含 CJK、全部词总 CJK 字 ≥3、且没有任何 <3 字的 CJK token。
 * 反例：`广西 桂林` —— 总 4 字但每 token 2 字，trigram 0 命中。
 */
function trigramRouteOk(q) {
  const terms = allTerms(q);
  const cjk = terms.filter(containsCjk);
  return cjk.length > 0 && cjk.reduce((n, t) => n + countCjk(t), 0) >= 3 && !hasShortCjkToken(q);
}

/** 单个词 → FTS5 字面量。双引号内的双引号写两次（FTS5 短语转义）。 */
function ftsTerm(t) {
  const quoted = `"${String(t.text).replace(/"/g, '""')}"`;
  return t.prefix ? `${quoted}*` : quoted;
}

/**
 * 解析结果 → FTS5 MATCH 表达式。
 *
 * 组内空格连接 = 隐式 AND；组间 ` OR `。
 * 取反词用 FTS5 的 `NOT`：`A NOT B`。多个取反合并成 `NOT (B OR C)` ——
 * FTS5 的 NOT 是二元操作符，不能链式写 `A NOT B NOT C`。
 * 某组只有取反词时（`NOT 注入`）没有左边操作数，用空串代替不了，
 * 这时退化成「不含该词」无法表达 —— 直接返回 null，让上层走 LIKE（LIKE 能表达）。
 */
function toFtsQuery(q) {
  const parsed = parseQuery(q);
  if (!parsed.groups.length) return null;
  const groupSql = [];
  for (const g of parsed.groups) {
    const pos = g.filter((t) => !t.negate).map(ftsTerm);
    const neg = g.filter((t) => t.negate).map(ftsTerm);
    if (!pos.length) {
      if (g.length && parsed.groups.length === 1) return null;  // 纯取反，FTS 表达不了
      continue;
    }
    let s = pos.join(" ");
    if (neg.length) s += neg.length === 1 ? ` NOT ${neg[0]}` : ` NOT (${neg.join(" OR ")})`;
    groupSql.push(s);
  }
  return groupSql.length ? groupSql.join(" OR ") : null;
}

/**
 * 单列的「三列任一命中」谓词（照 Hermes `_LIKE_ANY_COLUMN_SQL`）。
 *
 * 为什么要三列：工具名和 tool_calls JSON **不在正文里**（joinText 只取 text 块），
 * 只查 content 就永远搜不到「哪些消息调过 bash」。
 *
 * `COALESCE(...,'')` 不能省：NULL LIKE 返回 NULL，取反时 `NOT NULL` 还是 NULL，
 * 会让整条谓词静默变成「不匹配」—— 表现为「NOT 掉一个词反而什么都搜不到」。
 */
const LIKE_ANY_COLUMN = `(m.content LIKE ? ESCAPE '\\'
  OR COALESCE(m.tool_name,'') LIKE ? ESCAPE '\\'
  OR COALESCE(m.tool_calls,'') LIKE ? ESCAPE '\\')`;

/**
 * 解析结果 → LIKE 的 WHERE 片段（不含外层括号）。参数按顺序返回。
 *
 * 组内 AND、组间 OR —— 与 `toFtsQuery` 严格同构。
 * 取反词写成 `NOT (...)`；每个词固定贡献 3 个参数（三列各一）。
 */
function toLikeClauses(parsed) {
  const groupSql = [];
  const params = [];
  for (const g of parsed.groups) {
    if (!g.some((t) => !t.negate)) continue;   // 纯取反组无法表达，跳过
    const clauses = [];
    for (const t of g) {
      const pat = t.prefix ? `${escapeLike(t.text)}%` : `%${escapeLike(t.text)}%`;
      clauses.push(t.negate ? `NOT ${LIKE_ANY_COLUMN}` : LIKE_ANY_COLUMN);
      params.push(pat, pat, pat);
    }
    groupSql.push(`(${clauses.join(" AND ")})`);
  }
  if (!groupSql.length) return null;
  return { sql: `(${groupSql.join(" OR ")})`, params };
}

/** LIKE 语句的缓存签名：词数 / 取反数 / 前缀数任一变化都要换语句。 */
function likeSignature(parsed) {
  return parsed.groups
    .map((g) => g.map((t) => (t.negate ? "n" : "p") + (t.prefix ? "*" : "")).join(""))
    .join("|");
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
        tool_name  TEXT,
        tool_calls TEXT,
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
      -- 三列：content + tool_name + tool_calls（照 Hermes）。
      -- 为什么要工具名进索引：正文里根本不含工具名（joinText 只取 type='text'），
      -- 不单独索引就永远搜不到「哪些消息调过 bash」。
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, tool_name, tool_calls, content='messages', content_rowid='id'
      );

      -- trigram 的 external-content 源是【过滤视图】，不是 messages 原表。
      -- 原因（照 hermes FTS_STORAGE_VERSION=3）：FTS5 的 external-content 表要求
      -- 源能精确读回触发器写进索引的内容 —— 'integrity-check' 和 'delete' 都会
      -- 回源表按 rowid 取内容比对。若源是原表而触发器排除了 tool 行，索引就比源
      -- 少几万行，完整性检查会判成 "database disk image is malformed"。
      -- 把过滤放进视图，索引行数与源行数就永远一致，'rebuild' 也能直接用。
      CREATE VIEW IF NOT EXISTS messages_fts_trigram_src AS
        SELECT id, content FROM messages
        WHERE role <> 'tool' AND content IS NOT NULL;

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
        content, content='messages_fts_trigram_src', content_rowid='id', tokenize='trigram'
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
      tool_name: "TEXT",
      tool_calls: "TEXT",
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
    this._migrateFtsColumns();
    return added;
  }

  /**
   * 给 `messages_fts` 补 `tool_name` / `tool_calls` 两列（2026-11-20）。
   *
   * 为什么必须 DROP 重建：FTS5 的列在 CREATE 时定死，`ALTER TABLE` 不支持加列。
   * 判据是 `pragma_table_info` 的列数 —— 3 列才算新。
   *
   * 重建流程照 `_migrateFts` 的顺序：**先删触发器 → 删表 → 建表 → 建触发器 → rebuild**。
   * 顺序错了会在删表时被触发器引用卡住，或者 rebuild 时触发器把半成品再写一遍。
   *
   * ⚠️ 老数据没有工具名（历史 tool 行根本没存过），新建列会是 NULL ——
   *    这是**预期**的，不是 bug：从今天起新写入的消息才有。
   */
  _migrateFtsColumns() {
    const cols = this.db.prepare("PRAGMA table_info(messages_fts)").all().map((c) => c.name);
    if (cols.includes("tool_name") && cols.includes("tool_calls")) return false;

    this.db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      DROP TABLE IF EXISTS messages_fts;
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content, tool_name, tool_calls, content='messages', content_rowid='id'
      );
    `);
    this._createFtsTriggers();
    // 全量重建索引（历史行没有工具名，但 content 要重新进索引）
    this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    return true;
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

    return this._migrateTrigramSrcView();
  }

  /**
   * 一次性迁移：把 trigram 的 external-content 源从 `messages` 换成过滤视图
   * `messages_fts_trigram_src`（2026-11-20 照 hermes FTS_STORAGE_VERSION=3）。
   *
   * **为什么必须换源**：FTS5 的 external-content 表要求「源能精确读回索引里的内容」。
   * 原实现是「源 = messages 原表，但触发器排除 tool 行」—— 索引比源少 2.8 万行，
   * `'integrity-check'` 直接判 `database disk image is malformed`（已实测）。
   * 换成过滤视图后，索引行数与源行数恒等，检查通过。
   *
   * 顺带的好处：`'rebuild'` 终于能用了 —— 它无视触发器、直接扫源，而源已经是过滤过的。
   *
   * 判据不靠 meta 标记，而是**直接查表的实际定义**：源不是那个视图就重建。
   * 这样手改过库、或者从旧备份恢复，都能自动纠正。
   */
  _migrateTrigramSrcView() {
    const row = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts_trigram'`
    ).get();
    if (row?.sql && /messages_fts_trigram_src/.test(row.sql)) return false;   // 已是视图源

    this.db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;
      DROP TABLE IF EXISTS messages_fts_trigram;
      CREATE VIEW IF NOT EXISTS messages_fts_trigram_src AS
        SELECT id, content FROM messages
        WHERE role <> 'tool' AND content IS NOT NULL;
      CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(
        content, content='messages_fts_trigram_src', content_rowid='id', tokenize='trigram'
      );
      INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('rebuild');
    `);
    this._createFtsTriggers();
    return true;
  }

  /**
   * 建 FTS 同步触发器（重建表后需重跑）。
   *
   * **用 DROP + CREATE 而非 IF NOT EXISTS**：触发器定义会随版本演进
   * （2026-11-20 给 trigram 加了 `role <> 'tool'` 过滤），若用 IF NOT EXISTS，
   * 老库里的旧触发器永远留着，新定义静默不生效 —— 索引照样索引 tool 行。
   *
   * **trigram 侧三个分支都必须带同一个 `role <> 'tool' AND content IS NOT NULL` 谓词**，
   * 且必须与 `messages_fts_trigram_src` 视图的条件**逐字一致**。这是 FTS5
   * external-content 的硬约束：索引里有哪些行，必须精确等于源视图里有哪些行。
   * 多写一行或少删一行都会让 'integrity-check' 判索引损坏。
   *
   * ⚠️ 用 `sqlite3` CLI 手工验证时会报 `unsafe use of virtual table` ——
   * 那是 CLI 默认 `trusted_schema=OFF`，不是语句写错；node:sqlite 默认为 1。
   */
  _createFtsTriggers() {
    this.db.exec(`
      DROP TRIGGER IF EXISTS messages_fts_ai;
      DROP TRIGGER IF EXISTS messages_fts_ad;
      DROP TRIGGER IF EXISTS messages_fts_au;

      -- 插入：messages_fts 无条件（三列：content + tool_name + tool_calls）；
      --       trigram 与源视图同谓词（单列，trigram 已排除 tool 行，工具名在其中恒为 NULL）
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, tool_name, tool_calls)
          VALUES (new.id, new.content, new.tool_name, new.tool_calls);
        INSERT INTO messages_fts_trigram(rowid, content)
          SELECT new.id, new.content
          WHERE new.role <> 'tool' AND new.content IS NOT NULL;
      END;

      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, tool_calls)
          VALUES('delete', old.id, old.content, old.tool_name, old.tool_calls);
        INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content)
          SELECT 'delete', old.id, old.content
          WHERE old.role <> 'tool' AND old.content IS NOT NULL;
      END;

      -- 更新：先删旧、再按新内容写回，两侧都走同一谓词
      CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content, tool_name, tool_calls)
          VALUES('delete', old.id, old.content, old.tool_name, old.tool_calls);
        INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, content)
          SELECT 'delete', old.id, old.content
          WHERE old.role <> 'tool' AND old.content IS NOT NULL;
        INSERT INTO messages_fts(rowid, content, tool_name, tool_calls)
          VALUES (new.id, new.content, new.tool_name, new.tool_calls);
        INSERT INTO messages_fts_trigram(rowid, content)
          SELECT new.id, new.content
          WHERE new.role <> 'tool' AND new.content IS NOT NULL;
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
        (session_id, seq, role, content, timestamp, turn, step, event_type,
         tool_call_id, tool_name, tool_calls, is_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          m.toolName ?? null,
          m.toolCalls ?? null,
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
   *   ③ CJK 且有 token <3 字        → LIKE 全扫
   *
   * `via` 回报实际走的路径，便于排查「为什么这条搜不到」：
   * `fts` / `fts-trigram` / `fts-relaxed`（OR 松弛命中）/ `like` / `like-fts-stale`。
   *
   * @param {string} query
   * @param {{limit?:number, offset?:number, sort?:'rank'|'newest'|'oldest',
   *          sessionId?:string, roles?:string[], since?:number, context?:boolean}} opts
   */
  search(query, opts = {}) {
    const q = String(query ?? "").trim();
    if (!q) return [];
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
    const offset = Math.min(Math.max(Number(opts.offset) || 0, 0), 10_000);
    const sort = ["rank", "newest", "oldest"].includes(opts.sort) ? opts.sort : "rank";

    const clauses = [];
    const params = [];
    if (opts.sessionId) { clauses.push("m.session_id = ?"); params.push(opts.sessionId); }
    if (opts.since) { clauses.push("m.timestamp >= ?"); params.push(opts.since); }
    if (Array.isArray(opts.roles) && opts.roles.length) {
      clauses.push(`m.role IN (${opts.roles.map(() => "?").join(",")})`);
      params.push(...opts.roles);
    }
    const filter = clauses.length ? " AND " + clauses.join(" AND ") : "";

    const parsed = parseQuery(q);
    const matchQuery = toFtsQuery(q);
    const cjk = containsCjk(q);

    // 排序：FTS 有 score（bm25，越小越相关），LIKE 没有，只能按时间。
    const orderFts = sort === "newest" ? "ORDER BY m.timestamp DESC, score"
                   : sort === "oldest" ? "ORDER BY m.timestamp ASC, score"
                   : "ORDER BY score";
    const orderLike = sort === "oldest" ? "ORDER BY m.timestamp ASC" : "ORDER BY m.timestamp DESC";

    // ② trigram：仅当每个 CJK token 都够长。trigram 表已排除 role='tool'（见触发器），
    //   所以显式要 tool 行时不能走这条路，否则必然漏结果 —— 交给 ③。
    const wantsToolRows = Array.isArray(opts.roles) && opts.roles.includes("tool");
    const ftsTable = cjk ? "messages_fts_trigram" : "messages_fts";
    const ftsEligible = !!matchQuery && !this._isFtsStale(ftsTable)
      && (!cjk || (trigramRouteOk(q) && !wantsToolRows));

    let rows = [];
    let via = null;

    if (ftsEligible) {
      const table = ftsTable;
      const stmt = this._s("searchFts" + table + sort + filter, `
        SELECT m.id, m.session_id, m.seq, m.role, m.content, m.timestamp, m.turn, m.step,
               snippet(${table}, 0, '«', '»', '…', 24) AS snip,
               bm25(${table}) AS score
        FROM ${table} f
        JOIN messages m ON m.id = f.rowid
        WHERE ${table} MATCH ?${filter}
        ${orderFts} LIMIT ? OFFSET ?
      `);
      try {
        rows = stmt.all(matchQuery, ...params, limit, offset);
        via = cjk ? "fts-trigram" : "fts";
      } catch {
        // 索引损坏 / MATCH 语法不可用 —— 标记陈旧，后续请求直接走 LIKE，
        // 免得每次查询都先撞一次异常（Hermes 的 `_fts_stale`）。
        this._markFtsStale(ftsTable);
        rows = [];
        via = null;
      }
    }

    // ★ OR 松弛（Hermes `_or_relaxed_query`）：多词隐式 AND 零命中时，重试「命中任一词」。
    //   严格限定条件：单组、正向词 ≥2、非 CJK、用户没写显式 OR/NOT ——
    //   否则会毁掉用户明确表达的语义。
    if (rows.length === 0 && via && !cjk && !parsed.explicitOr && !parsed.explicitNot
        && parsed.groups.length === 1 && parsed.groups[0].length >= 2
        && !parsed.groups[0].some((t) => t.negate)) {
      const relaxed = parsed.groups[0].map((t) => ftsTerm(t)).join(" OR ");
      const table = "messages_fts";
      try {
        const relaxedRows = this._s("searchFts" + table + sort + filter, `
          SELECT m.id, m.session_id, m.seq, m.role, m.content, m.timestamp, m.turn, m.step,
                 snippet(${table}, 0, '«', '»', '…', 24) AS snip,
                 bm25(${table}) AS score
          FROM ${table} f
          JOIN messages m ON m.id = f.rowid
          WHERE ${table} MATCH ?${filter}
          ${orderFts} LIMIT ? OFFSET ?
        `).all(relaxed, ...params, limit, offset);
        if (relaxedRows.length) { rows = relaxedRows; via = "fts-relaxed"; }
      } catch { /* 松弛失败就保持零结果，继续走 LIKE */ }
    }

    // ③ LIKE 全扫：组内 AND、组间 OR，与 toFtsQuery 同构。
    //    ⚠️ 本表只有 content 一个文本列（无 Hermes 的 tool_name/tool_calls）。
    // ⚠️ 缓存 key 必须带 filter：SQL 占位符个数随 filter 变化，共用会错配参数。
    // ⚠️ 也要带 likeSignature：词数/取反数/前缀数变化都会改变语句结构。
    if (rows.length === 0) {
      const like = toLikeClauses(parsed);
      const sql = like?.sql ?? LIKE_ANY_COLUMN;
      const likeParams = like?.params ?? [`%${escapeLike(q)}%`, `%${escapeLike(q)}%`, `%${escapeLike(q)}%`];
      rows = this._s("searchLike" + likeSignature(parsed) + sort + filter, `
        SELECT m.id, m.session_id, m.seq, m.role, m.content, m.timestamp, m.turn, m.step,
               substr(m.content, 1, 240) AS snip, 0 AS score
        FROM messages m
        WHERE (${sql})${filter}
        ${orderLike} LIMIT ? OFFSET ?
      `).all(...likeParams, ...params, limit, offset);
      via = this._isFtsStale() ? "like-fts-stale" : "like";
    }

    if (opts.context && rows.length) rows = this._withContext(rows);
    return rows.map((r) => ({ ...r, via }));
  }

  /**
   * FTS 索引是否处于「最近失败过」状态（短时间内直接走 LIKE）。
   *
   * **按表分别标记**：trigram 坏了不该连累 unicode61 的拉丁查询，反之亦然。
   * 传 `table` 判具体表；不传则任一张坏就算坏（整库降级）。
   */
  _isFtsStale(table) {
    const now = Date.now();
    const m = this._ftsStaleUntil ?? {};
    if (table) return (m[table] ?? 0) > now;
    return Object.values(m).some((t) => t > now);
  }

  /** 标记某张 FTS 表陈旧。5 分钟后自动重试，不需要人工介入。 */
  _markFtsStale(table, ms = 5 * 60_000) {
    this._ftsStaleUntil = { ...(this._ftsStaleUntil ?? {}), [table]: Date.now() + ms };
  }

  /**
   * 给每条命中补上「前后各一条」的上下文（Hermes `_CONTEXT_WINDOW_SQL`）。
   *
   * 为什么需要：`memory_search` 只给 240 字片段，看不出这句话是在什么语境里说的。
   * 默认关闭 —— 每条命中从 240 字变约 720 字，开多了会撑爆上下文。
   */
  _withContext(rows) {
    const ids = rows.map((r) => r.id);
    const sql = `
      SELECT t.hit_id AS hit_id, m.id, m.session_id, m.seq, m.role, m.content, m.timestamp
      FROM (SELECT id AS hit_id, session_id, seq FROM messages
            WHERE id IN (${ids.map(() => "?").join(",")})) t
      JOIN messages m ON m.id IN (
        t.hit_id,
        (SELECT p.id FROM messages p WHERE p.session_id = t.session_id AND p.seq < t.seq
           ORDER BY p.seq DESC LIMIT 1),
        (SELECT n.id FROM messages n WHERE n.session_id = t.session_id AND n.seq > t.seq
           ORDER BY n.seq ASC LIMIT 1)
      )
      ORDER BY t.hit_id, m.seq
    `;
    const grouped = new Map();
    for (const r of this._s("ctxWin" + ids.length, sql).all(...ids)) {
      if (!grouped.has(r.hit_id)) grouped.set(r.hit_id, []);
      grouped.get(r.hit_id).push({ id: r.id, role: r.role, seq: r.seq, content: r.content });
    }
    return rows.map((r) => ({ ...r, context: grouped.get(r.id) ?? [] }));
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
