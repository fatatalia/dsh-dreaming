/**
 * dsh-fatatalia-memory — 自研记忆插件（SQLite FTS5）
 *
 * 用 SQLite FTS5 取代 Hindsight 在这一层的实际用途：零 LLM 成本的历史会话检索。
 * 与 Hindsight 的分工（本插件**不**做）：不做语义/向量检索、不做 reflect 式深度推理、
 * 不做知识页的自动生成与刷新。它只做一件 Hindsight 做得昂贵的事：
 * **把对话原样存下来，让你能按关键词毫秒级翻回去。**
 *
 * ── 已由实测钉死的事实（2026-09-29，会话 gateway-mufaeycc6d7mbr-gw）────────
 *
 * 1. 事件订阅：`ctx.on("session/event", (session, event) => …)`；
 *    `turn/end` 的载荷是 `{type, seq, time, data:{turn, reason}}` —— **event 不含正文**。
 * 2. 正文在 **`session.log`**（`array[N]`，实测 10067 条），是一条全量事件流。
 *    消息事件类型：`user/message` / `assistant/message` / `tool/result`
 *    / `system/message` / `developer/message`（结构不统一，见 lib/extract.mjs）。
 * 3. `agent.frozenMessages` 在 turn/end 时是 **`object{0}` 空对象** —— 不是消息数组。
 * 4. **`sessionPersistence` 必须写进 `inject`**，否则 `ctx.get()` 静默返回 undefined。
 * 5. **`sessionPersistence.load()` 不存在**（54 个真实方法里没有它）。
 * 6. FTS5 `trigram` **查询 <3 个字符必然 0 命中** —— 故检索必须 FTS/LIKE 分流。
 *
 * ── 本插件的定位（一句话）────────────────────────────────────────────
 * 它是一台**录像机**，不是**大脑**：忠实、便宜、随时可查。
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { MemoryDB, DEFAULT_DB_PATH, charLen } from "./db.mjs";
import { extractMessages } from "./extract.mjs";
import { createRequire } from "node:module";
import * as V from "./vec-store.mjs";
import { mergeHybrid } from "./vec-hybrid.mjs";
import { VectorSync } from "./vec-sync.mjs";

// vec-store 用 CJS 的 sqlite-vec，ESM 里得自己造 require
V.setVecRequire(createRequire(import.meta.url));


/**
 * agents：拿 agent 对象（诊断用）。
 * sessions：session 事件由它发布。
 * sessionPersistence：**必须声明**，否则 ctx.get 拿不到（实测踩过）。
 * tools：**注册工具必须声明**。漏了它，`ctx.tools.register()` 会抛错，apply() 从那一行
 *        起整体中断 —— 而排在其后的 `ctx.on("session/event")` 也就从未注册。症状很隐蔽：
 *        日志停在「库已就绪」，库永远是 0 条，看起来像事件没触发，其实是插件没装完。
 *        参考：dsh-dreaming / dsh-fatatalia-tools / dsh-synology-calendar 三个注册工具的
 *        插件，inject 里都有 "tools"。2026-09-29 实测踩到。
 */



/** 时间戳（ms）→ 本地可读。 */
function fmtTime(ts) {
  if (!ts) return "?";
  const ms = ts < 1e12 ? ts * 1000 : ts;   // 容忍秒/毫秒两种单位
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 截断长文本（展示用）。 */
function clip(s, n = 300) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export function applyMemory(ctx, cfg, log) {

  // 不在这里 return：启动时关着等于之后永远开不起来。开关在 turn/end 里每次现判。

  const db = new MemoryDB(cfg.dbPath);
  const s0 = db.stats();
  log.info(`库已就绪：${db.path}`);
  log.info(`  会话 ${s0.sessions} · 消息 ${s0.messages} · 知识页 ${s0.knowledge}`);

  /*
   * 语义检索就绪判定（2026-11-21）。
   *
   * 三层防御：① 开关关着完全不做 ② vec0 加载失败只降级不抛 ③ 指纹不符拒绝复用。
   * 任何一步失败都必须让插件照常起来 —— 索引坏了不该拖垮检索与落库。
   *
   * **惰性 + 缓存成功**：配置是 volatile 的，用户可能热开开关。只在成功时置
   * `vecReady`，失败不缓存 —— 下次调用会重试，装上 sqlite-vec 后不用重启。
   */
  let vecReady = false;
  /** 同步器实例；开关关着或 vec0 不可用时一直是 null。 */
  let sync = null;
  function ensureVecReady() {
    if (vecReady) return true;
    if (!cfg.semantic?.enabled?.()) return false;
    try {
      if (!V.loadVecExtension(db.db)) {
        log.warn("语义检索不可用：vec0 扩展加载失败（sqlite-vec 未安装？）");
        return false;
      }
      V.initVecSchema(db.db);
      const fp = V.checkModelFingerprint(db.db);
      if (!fp.ok) {
        log.warn(`语义检索不可用：${fp.reason}`);
        return false;
      }
      vecReady = true;
      const st = V.vecStats(db.db);
      log.info(`语义检索已就绪：向量 ${st.indexed}/${st.total} 条，待补 ${st.missing}`);

      /*
       * 同步器在这里起 —— 与 vec0 就绪同生共死。
       * 生命周期跟着插件走：dsh 退出它被 dispose，dsh 起来它重新排程，
       * 靠水位线自己接着补。不需要任何系统级守护进程。
       */
      if (!sync && cfg.semantic?.client) {
        sync = new VectorSync({
          db: db.db,
          embed: cfg.semantic.client,
          log,
          intervalMs: (cfg.semantic.intervalMin?.() ?? 2) * 60_000,
        });
        sync.start();
        log.info(
          `语义索引同步器已启动（间隔 ${(cfg.semantic.intervalMin?.() ?? 2)} 分钟，` +
          `warm 上限 ${Math.min(5000, Math.ceil(st.total * 0.2))} 条）`
        );
      } else if (!cfg.semantic?.client) {
        log.warn("语义索引同步器未创建：semantic.client 缺失");
      }
      return true;
    } catch (e) {
      log.warn(`语义检索初始化失败（不影响关键词检索）：${e instanceof Error ? e.message : e}`);
      return false;
    }
  }
  // 启动时探一次，让日志里能看出语义检索是否可用（失败不影响任何东西）
  if (cfg.semantic?.enabled?.()) ensureVecReady();

  // ── 核心：turn/end 时把本轮新消息落库 ────────────────────────────────
  let turnsSeen = 0;
  let totalInserted = 0;
  ctx.on("session/event", (session, event) => {
    // 只关心 turn 边界。其余事件（含每 token 一条的 assistant/chunk）立即短路，不进日志。
    if (event?.type !== "turn/end") return;
    // 运行时开关：设置页关掉立刻停止落库，不用重启。
    if (typeof cfg.isEnabled === "function" && !cfg.isEnabled()) return;

    const sid = session?.id;
    const slog = Array.isArray(session?.log) ? session.log : null;
    if (!sid) { log.error("turn/end：无 session.id，跳过"); return; }
    if (!slog) { log.error("turn/end：session.log 不是数组，跳过"); return; }

    turnsSeen++;

    try {
      // 会话元信息
      const h = session?.header ?? {};
      db.upsertSession({
        id: sid,
        workspace: h.cwd ?? null,
        source: h.agentPreset ?? null,
        startedAt: typeof h.createdAt === "number" ? h.createdAt / 1000 : null,
      });

      // 增量提取：只处理 seq > lastSeq 的事件
      const last = db.getLastSeq(sid);
      let msgs = extractMessages(slog, { sinceSeq: last, includeReasoning: cfg.getStoreReasoning ? cfg.getStoreReasoning() : cfg.storeReasoning });

      // 上限只用来限制单轮事务规模，**绝不能造成永久丢失**。
      // 两条纪律（2026-09-29 双双踩过）：
      //   1. 必须从头截 slice(0, N)，不能 slice(-N)。取尾部会让 lastSeq 照样停在末尾，
      //      前面的历史永远补不回来 —— 加了下游修复也救不了，因为「剩下的」是 0 条。
      //   2. 截断后 lastSeq 只推进到「已入库的最后一条」，剩下的留给下一轮。
      let truncated = 0;
      const perTurnCap = typeof cfg.getMaxPerTurn === "function" ? cfg.getMaxPerTurn() : cfg.maxPerTurn;
      if (msgs.length > perTurnCap) {
        truncated = msgs.length - perTurnCap;
        msgs = msgs.slice(0, perTurnCap);
        // 必须是 info：log.warn 不进 /var/log/dsh-web.log，这条告警曾因此静默失联，
        // 掩盖了一次 1748 条消息的截断丢失（2026-09-29）。
        log.info(`本轮候选 ${msgs.length + truncated} 条超过上限 ${perTurnCap}，本轮入库前 ${msgs.length} 条，剩余 ${truncated} 条下轮继续`);
      }

      const n = msgs.length ? db.insertMessages(sid, msgs) : 0;
      totalInserted += n;
      // 即使 0 条也记录：用来区分「log 里确实没有新消息」和「提取器漏了」。
      log.info(`turn/end：会话 ${sid} 候选 ${msgs.length} 条 / 入库 ${n} 条（lastSeq=${last}${truncated ? `，截断 ${truncated} 条待续` : ""}）`);

      // 推进 lastSeq。
      // 截断时只走到已入库的最后一条，否则被截掉的部分永远不会再被提取。
      let maxSeq = last;
      if (truncated > 0) {
        for (const m of msgs) if (typeof m?.seq === "number" && m.seq > maxSeq) maxSeq = m.seq;
      } else {
        for (const ev of slog) if (typeof ev?.seq === "number" && ev.seq > maxSeq) maxSeq = ev.seq;
      }
      if (maxSeq > last) db.setLastSeq(sid, maxSeq);

      // 顺手同步会话标题（session/title 事件，从尾部往前找）
      for (let i = slog.length - 1, seen = 0; i >= 0 && seen < 80; i--, seen++) {
        const ev = slog[i];
        if (ev?.type === "session/title" && ev.data?.title) { db.setSessionTitle(sid, String(ev.data.title)); break; }
      }
    } catch (e) {
      log.error(`turn/end 落库失败：${e instanceof Error ? e.message : e}`);
    }
  });

  // ── 工具 1：memory_search ────────────────────────────────────────────
  const searchTool = defineTool({
    name: "memory_search",
    description:
      "检索历史对话记录（本地 SQLite，零 LLM 成本，毫秒级）。用于找回过去说过的内容、决策、细节。\n" +
      "中文英文都支持，内部自动选路（FTS5 trigram / unicode61 / LIKE 子串）。\n" +
      "查询语法（与 FTS5 一致的子集）：空格 = AND，`OR` = 或，`NOT` = 排除，\"引号\" = 短语，`词*` = 前缀。\n" +
      "多词 AND 零命中时会自动放宽成「命中任一词」（结果会标 fts-relaxed）。",
    parameters: {
      query: { type: "string", description: "检索词（中文或英文均可，支持 AND/OR/NOT/短语/前缀）" },
      limit: { type: "number", description: "返回条数，默认 10，最大 50" },
      offset: { type: "number", description: "跳过前 N 条（翻页用，默认 0）" },
      sort: { type: "string", description: "排序：rank（默认，相关度）/ newest / oldest", enum: ["rank", "newest", "oldest"] },
      context: { type: "boolean", description: "true 时每条命中附带前后各一条消息（约 3 倍文本，慎用）" },
      session_id: { type: "string", description: "限定某个会话 id（可选）" },
      role: { type: "string", description: "限定角色：user / assistant / tool（可选）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "number", required: true },
          via: { type: "string", required: true },
          results: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "number", required: true },
                seq: { type: "number", required: true },
                time: { type: "string", required: true },
                role: { type: "string", required: true },
                session_id: { type: "string", required: true },
                snippet: { type: "string", required: true },
                context: { type: "array", description: "前后各一条（仅在 context=true 时返回）",
                  items: {
                    type: "object", additionalProperties: false,
                    properties: {
                      id: { type: "number", required: true },
                      role: { type: "string", required: true },
                      content: { type: "string", required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render(_args, v) {
        if (!v?.results?.length) return [{ type: "text", text: "未找到匹配记录。" }];
        const lines = [
          `找到 ${v.count} 条（检索方式：${v.via}）：`,
          "",
          "（要看某条的上下文，用 memory_read(id=<id>)）",
          "",
        ];
        for (const r of v.results) {
          lines.push(`#[${r.id}] [${r.time}] ${r.role} (${r.session_id})\n  ${r.snippet}`);
          if (r.context?.length) {
            for (const c of r.context) {
              const mark = c.id === r.id ? "→" : " ";
              lines.push(`  ${mark} [#${c.id}] ${c.role}: ${c.content}`);
            }
          }
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args, exec) {
      const q = String(args?.query ?? "").trim();
      const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 50);
      const roles = args?.role ? [String(args.role)] : null;

      /*
       * 语义检索分支（2026-11-21 加）。
       *
       * 只在以下条件**全部**满足时启用：
       *   · semantic.enabled 为真
       *   · 用户没指定 sort=newest/oldest（混合打分必然打乱时间序）
       *   · 没在翻页（offset>0 时混合后的 offset 无意义）
       *   · 嵌入子进程可用
       *
       * 关键词路先取 limit×4 作为候选池，否则向量命中会被这个小池子挤掉。
       */
      /*
       * 惰性判定，不吃启动时的快照：配置是 volatile 的，用户可能在设置页
       * 热开开关。若这里只看启动时算的 semanticReady，勾了「启用」也得重启才生效 ——
       * 而那正是设置页最容易被判成「坏了」的情形。
       */
      const sem = cfg.semantic;
      const wantSemantic = !!sem
        && sem.enabled()
        && ensureVecReady()
        && (args?.sort ?? "rank") === "rank"
        && !(Number(args?.offset) > 0);

      if (wantSemantic) {
        const qv = await sem.embedQuery(q);
        if (qv) {
          const pool = sem.candidatePool();
          const textRows = db.search(q, {
            limit: Math.max(limit * 4, pool),
            offset: 0,
            sort: "rank",
            context: false,
            sessionId: args?.session_id ?? null,
            roles,
          });
          const vecHits = V.queryKnn(db.db, qv, pool);

          // 回声抑制：当前会话的消息不返回 —— 否则检索出来的全是刚说过的话
          let excludeSession = null;
          try { excludeSession = exec?.agent?.sessionId ?? null; } catch { /* 拿不到就不排除 */ }

          const merged = mergeHybrid({
            vecHits,
            textHits: textRows,
            vectorWeight: sem.vectorWeight(),
            minScore: sem.minScore(),
            topK: limit,
            excludeSessionId: excludeSession,
            fetchRows: (ids) => V.getMessagesByIds(db.db, ids),
          });

          if (merged.length > 0) {
            return {
              count: merged.length,
              via: "hybrid(向量+关键词)",
              results: merged.map((r) => ({
                id: r.id,
                seq: r.seq ?? 0,
                time: fmtTime(r.timestamp),
                role: r.role,
                session_id: r.sessionId,
                snippet: clip(r.content, 400),
              })),
            };
          }
          // 混合后零命中 → 落到下面的关键词结果，不吞掉用户本来就有的召回
        }
      }

      const rows = db.search(q, {
        limit,
        offset: Number(args?.offset) || 0,
        sort: args?.sort || "rank",
        context: args?.context === true,
        sessionId: args?.session_id ?? null,
        roles,
      });
      // via 由 db.search() 回报实际走的路径（2026-11-20 修）：
      // 原来这里按「整串长度 ≥3」硬编码，与实际路径不符 —— 短 CJK token 会走 LIKE
      // 却报成 fts5-trigram，排查「为什么这条搜不到」时会被误导。
      const via = rows.length ? rows[0].via : "没有命中任何一路";
      return {
        count: rows.length,
        via,
        results: rows.map((r) => ({
          id: r.id,
          seq: r.seq,
          time: fmtTime(r.timestamp),
          role: r.role,
          session_id: r.session_id,
          snippet: clip(r.snip ?? r.content, 400),
          ...(r.context ? { context: r.context.map((c) => ({
            id: c.id, role: c.role, content: clip(c.content, 300),
          })) } : {}),
        })),
      };
    },
  });

  // ── 工具 2：memory_read ──────────────────────────────────────────────
  // 2026-09-29 补：计划 §4.4 里列了本工具但当时没实现 —— `memory_search` 只返回
  // 400 字片段，看到命中却看不到「它的前因后果」，只能自己写 SQL 戳库。现补齐。
  const readTool = defineTool({
    name: "memory_read",
    description:
      "读某条消息的上下文（同一会话，以它为中心取前后各半）。配合 memory_search 使用：" +
      "search 只给 400 字片段，本工具补上前后文，看清一句话是在什么语境里说的。" +
      "只给 session_id（不给 id / around_seq）时，返回该会话最近的记录。",
    parameters: {
      id: { type: "number", description: "消息 id（memory_search 结果里的 id）—— 以它为锚点" },
      session_id: { type: "string", description: "会话 id（可选；给了 id 会自动推断）" },
      around_seq: { type: "number", description: "中心位置 seq（可选；与 id 二选一）" },
      limit: { type: "number", description: "返回条数，默认 20，最大 200" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          found: { type: "boolean", required: true },
          session_id: { type: "string", required: true },
          count: { type: "number", required: true },
          center_id: { type: "number", required: true },
          messages: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "number", required: true },
                seq: { type: "number", required: true },
                time: { type: "string", required: true },
                role: { type: "string", required: true },
                content: { type: "string", required: true },
              },
            },
          },
        },
      },
      render(_args, v) {
        if (!v?.found) return [{ type: "text", text: "未找到该会话或消息。" }];
        const head = v.center_id
          ? `会话 ${v.session_id} · 以 #${v.center_id} 为中心 · ${v.count} 条`
          : `会话 ${v.session_id} · 最近 ${v.count} 条`;
        const lines = [head, ""];
        for (const m of v.messages) {
          const mark = m.id === v.center_id ? " ←★" : "";
          lines.push(`#[${m.id}] seq=${m.seq} [${m.time}] ${m.role}${mark}`);
          lines.push(`  ${clip(m.content, 1200)}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 200);
      let sessionId = args?.session_id ? String(args.session_id) : null;
      let centerSeq = Number.isFinite(Number(args?.around_seq)) ? Number(args.around_seq) : null;
      let centerId = 0;

      // 给了 id → 自己查出 session_id / seq / 时间，当锚点用
      if (Number.isFinite(Number(args?.id))) {
        const anchor = db.getMessage(Number(args.id));
        if (!anchor) {
          return { found: false, session_id: sessionId ?? "", count: 0, center_id: 0, messages: [] };
        }
        sessionId = anchor.session_id;
        centerSeq = anchor.seq;
        centerId = anchor.id;
      }
      if (!sessionId) {
        return { found: false, session_id: "", count: 0, center_id: 0, messages: [] };
      }

      const rows = db.readAround(sessionId, centerSeq, limit);
      return {
        found: rows.length > 0,
        session_id: sessionId,
        count: rows.length,
        center_id: centerId,
        messages: rows.map((r) => ({
          id: r.id,
          seq: r.seq,
          time: fmtTime(r.timestamp),
          role: r.role,
          content: r.content ?? "",
        })),
      };
    },
  });

  // ── 工具 3：memory_recent ────────────────────────────────────────────
  const recentTool = defineTool({
    name: "memory_recent",
    description: "查看最近的对话记录（按时间倒序，无检索词）。用于快速回顾刚刚说了什么。",
    parameters: {
      limit: { type: "number", description: "返回条数，默认 20，最大 100" },
      session_id: { type: "string", description: "限定某个会话 id（可选）" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          count: { type: "number", required: true },
          results: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                time: { type: "string", required: true },
                role: { type: "string", required: true },
                session_id: { type: "string", required: true },
                snippet: { type: "string", required: true },
              },
            },
          },
        },
      },
      render(_a, v) {
        if (!v?.results?.length) return [{ type: "text", text: "库中还没有消息。" }];
        return [{ type: "text", text: v.results.map((r) => `[${r.time}] ${r.role}: ${r.snippet}`).join("\n") }];
      },
    },
    async execute(args) {
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
      const rows = db.recent(limit, args?.session_id ?? null);
      return {
        count: rows.length,
        results: rows.map((r) => ({ time: fmtTime(r.timestamp), role: r.role, session_id: r.session_id, snippet: clip(r.content, 300) })),
      };
    },
  });

  // ── 工具 4：knowledge_list ───────────────────────────────────────────
  const kListTool = defineTool({
    name: "knowledge_list",
    description: "列出知识页（从 Hindsight 导出的倡议/架构页面，存本地 SQLite）。",
    parameters: {
      query: { type: "string", description: "可选的检索词，留空则列全部" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          count: { type: "number", required: true },
          pages: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                name: { type: "string", required: true },
                folder: { type: "string", required: true },
                snippet: { type: "string", required: true },
              },
            },
          },
        },
      },
      render(_a, v) {
        if (!v?.pages?.length) return [{ type: "text", text: "没有匹配的知识页。" }];
        // id 必须完整输出：knowledge_read 靠它取正文，截断或省略就等于没给。
        return [{ type: "text", text: `${v.count} 个知识页：\n` + v.pages.map((p) => `· ${p.name}\n    id: ${p.id}${p.snippet ? `\n    ${p.snippet}` : ""}`).join("\n") }];
      },
    },
    async execute(args) {
      const q = String(args?.query ?? "").trim();
      if (q) {
        const rows = db.searchKnowledge(q, 20);
        return { count: rows.length, pages: rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder ?? "", snippet: clip(r.snip, 200) })) };
      }
      const rows = db.listKnowledge();
      return { count: rows.length, pages: rows.map((r) => ({ id: r.id, name: r.name, folder: r.folder ?? "", snippet: "" })) };
    },
  });

  // ── 工具 5：knowledge_read ───────────────────────────────────────────
  const kReadTool = defineTool({
    name: "knowledge_read",
    description: "读取一个知识页的完整正文（按 id 或标题）。",
    parameters: {
      id: { type: "string", description: "知识页 id（kp-…）或标题" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          found: { type: "boolean", required: true },
          name: { type: "string", required: true },
          content: { type: "string", required: true },
        },
      },
      render(_a, v) {
        if (!v?.found) return [{ type: "text", text: "未找到该知识页。" }];
        return [{ type: "text", text: `# ${v.name}\n\n${v.content}` }];
      },
    },
    async execute(args) {
      const row = db.readKnowledge(String(args?.id ?? ""));
      if (!row) return { found: false, name: "", content: "" };
      return { found: true, name: row.name, content: row.content ?? "" };
    },
  });

  // ── 工具 6：memory_stats ─────────────────────────────────────────────
  const statsTool = defineTool({
    name: "memory_stats",
    description: "查看本地记忆库的统计信息（消息数、会话数、知识页数、时间跨度）。",
    parameters: {},
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          db_path: { type: "string", required: true },
          sessions: { type: "number", required: true },
          messages: { type: "number", required: true },
          knowledge: { type: "number", required: true },
          oldest: { type: "string", required: true },
          newest: { type: "string", required: true },
          by_role: { type: "string", required: true },
        },
      },
      render(_a, v) {
        return [{ type: "text", text:
          `库: ${v.db_path}\n会话 ${v.sessions} · 消息 ${v.messages} · 知识页 ${v.knowledge}\n` +
          `时间跨度: ${v.oldest} → ${v.newest}\n角色分布: ${v.by_role}` }];
      },
    },
    async execute() {
      const st = db.stats();
      return {
        db_path: st.dbPath,
        sessions: st.sessions,
        messages: st.messages,
        knowledge: st.knowledge,
        oldest: fmtTime(st.oldest),
        newest: fmtTime(st.newest),
        by_role: st.byRole.map((r) => `${r.role}:${r.n}`).join(" "),
      };
    },
  });

  for (const t of [searchTool, readTool, recentTool, kListTool, kReadTool, statsTool]) ctx.tools.register(t);
  log.info(`已注册 6 个工具：memory_search / memory_read / memory_recent / knowledge_list / knowledge_read / memory_stats`);

  ctx.on("dispose", () => {
    try { sync?.dispose(); } catch {}
    log.info(`卸载（本次进程共处理 ${turnsSeen} 个 turn / 写入 ${totalInserted} 条消息）`);
    db.close();
  });

  /*
   * 交给 index.js 的句柄：RPC 要读状态、要暂停/继续，都得拿到同一个实例。
   *
   * ⚠️ 必须用 getter —— 同步器是在 ensureVecReady() 里惰性创建的，
   * 直接 `return { sync }` 会把此刻的 null 快照出去，之后创建的实例永远拿不到。
   */
  return {
    get sync() { return sync; },
    /** 裸连接（已加载 vec0）。语义注入层做 KNN 查询要用，必须是 getter。 */
    get db() { return db.db; },
    ensureVecReady,
    available: () => vecReady,
  };
}
