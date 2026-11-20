/**
 * 记忆注入层 —— 把 MEMORY.md / USER.md 送进 system prompt。
 *
 * 为什么自己注册而不是靠 dsh-agent-instructions：
 * 那个插件的文件名是写死的（AGENTS.md / CLAUDE.md 及其 .local 变体），
 * 不认 MEMORY.md / USER.md，没有配置项。所以只能由本插件注册 section。
 *
 * ── 冻结策略（2026-11-20 改，代码东拍板）──────────────────────────
 *
 * 曾经的实现是「每轮都读盘」，理由是「文件改了下个 step 就生效，反正读盘 0.1ms」。
 * 那个理由只算了一半成本：读盘确实便宜，但**内容一变，system prompt 就变**——
 * 而 system prompt 是整条前缀的最前面，它一变，后面**整段对话历史全部 prefix
 * cache miss**。MEMORY.md 每天凌晨被梦境重写一次，于是每天必吃一次全量重算。
 *
 * 现在的做法（方案 C）：同一个会话只读一次盘，之后返回缓存 → 整个会话期间
 * system prompt 字节恒定 → cache 全程命中。压缩结束（compaction/end）时作废
 * 缓存，下一次模型调用重新读盘 —— 那一轮压缩本来就把历史重写成了 summary，
 * prefix 必然失效，**在免费窗口里换版本，不额外花钱**。
 *
 * 代价：本会话看不到中途新写的记忆，要等压缩后或新会话。可接受 ——
 * 我们的记忆只在凌晨 02:00–04:30 由梦境更新，那时没有活跃会话。
 *
 * 注意：缓存键必须含 cwd。不同工作区的 USER.md 不同，只按 sessionId 缓存会串味。
 *
 * order 放 10100（personaSuffix 是 10200 之前）：
 * 记忆变了只影响它之后的部分，不会从 persona 那里就断掉整条缓存。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 公共环境事实：四个工作区共用一份，固定位置 —— 不跟工作区走。 */
const MEMORY_PATH = () => join(homedir(), ".dsh", "MEMORY.md");

/** 个人事实：跟工作区走，每个工作区一份。 */
const userPath = (cwd) => (typeof cwd === "string" && cwd.startsWith("/") ? join(cwd, "USER.md") : null);

/** 单次注入总量上限。 */
const MAX_TOTAL_BYTES = 10 * 1024;

/** 缓存条目上限。超过就丢最老的（Map 保持插入顺序）。防长跑进程攒内存。 */
const MAX_CACHE_ENTRIES = 200;

/** 读文件，失败一律返回空串。
 *  **绝不抛错**：记忆文件坏掉（不存在 / 无权限 / 编码错）不能拖垮整个对话。 */
function readSafe(path) {
  if (!path) return "";
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/** 按字节上限截断，且不切坏 UTF-8 多字节字符。
 *  用于 USER.md 超预算时保头部，而不是像以前那样整段丢弃 —— 丢整段太粗暴，
 *  而且日志只打 info，等于静默消失。 */
function truncateUtf8(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = Math.max(0, maxBytes);
  // 0b10xxxxxx 是 UTF-8 续字节，不能作为切点 —— 一路回退到字符起点
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/**
 * 注册记忆 section。
 * @param {object} ctx cordis 上下文
 * @param {object} log 日志
 * @returns {boolean} 是否注册成功
 */
export function applyPromptInjection(ctx, log) {
  const sp = ctx.systemPrompt;
  if (!sp || typeof sp.section !== "function") {
    log?.info?.("记忆注入层：systemPrompt 服务不可用，跳过（不影响其他功能）");
    return false;
  }

  /** sessionId|cwd → 拼好的文本。压缩结束或会话结束就作废。 */
  const frozen = new Map();
  let overBudgetWarned = false;

  const cacheGet = (key) => {
    if (!frozen.has(key)) return undefined;
    const v = frozen.get(key);
    // LRU 触碰：重新插入以刷新顺序
    frozen.delete(key);
    frozen.set(key, v);
    return v;
  };

  const cacheSet = (key, value) => {
    frozen.set(key, value);
    while (frozen.size > MAX_CACHE_ENTRIES) {
      const oldest = frozen.keys().next().value;
      if (oldest === undefined) break;
      frozen.delete(oldest);
    }
  };

  ctx.effect(() => sp.section({
    name: "memory:curated",
    order: 10100,
    interpolate: false,          // 记忆里可能出现 {{ }} 字面量，不能被当成模板变量
    text: (context) => {
      const session = context?.agent?.session;
      // 工作区目录：持久化 header 里是权威来源（memory.mjs 落库也用 header.cwd），
      // meta 只在 agents.create 建会话时用 —— 两处都试，别赌哪一个一定有。
      const cwd = session?.header?.cwd ?? session?.meta?.cwd;
      const sid = typeof session?.id === "string" ? session.id : "";
      const key = `${sid}|${typeof cwd === "string" ? cwd : ""}`;

      const cached = cacheGet(key);
      if (cached !== undefined) return cached;

      const mem = readSafe(MEMORY_PATH()).trim();
      if (!mem) { cacheSet(key, ""); return ""; }

      const user = readSafe(userPath(cwd)).trim();
      let out = mem;

      if (user) {
        const budget = MAX_TOTAL_BYTES - Buffer.byteLength(mem, "utf8") - 2; // 2 = 拼接的 \n\n
        if (Buffer.byteLength(user, "utf8") <= budget) {
          out = `${mem}\n\n${user}`;
        } else if (budget > 0) {
          // 只截断 USER，不再整段丢弃 —— 丢整段等于代码东的个人信息从全部
          // 会话里无声消失，且日志只打 info，根本看不见。
          const kept = truncateUtf8(user, budget);
          out = `${mem}\n\n${kept}`;
          if (!overBudgetWarned) {
            overBudgetWarned = true;
            log?.warn?.(
              `记忆注入层：MEMORY(${Buffer.byteLength(mem, "utf8")}B) + USER(${Buffer.byteLength(user, "utf8")}B) ` +
              `超过 ${MAX_TOTAL_BYTES}B，USER 截断到 ${Buffer.byteLength(kept, "utf8")}B。请压缩记忆文件。`,
            );
          }
        } else {
          // MEMORY 自己就吃满了预算，USER 一点也放不下
          if (!overBudgetWarned) {
            overBudgetWarned = true;
            log?.warn?.(
              `记忆注入层：MEMORY 单个文件 ${Buffer.byteLength(mem, "utf8")}B 已超 ${MAX_TOTAL_BYTES}B 预算，` +
              `USER.md 无法注入。必须压缩 MEMORY.md。`,
            );
          }
        }
      }

      // 每个会话首次注入打一行：cwd 有没有拿到、USER.md 有没有读到，全在这。
      // 之前 cwd 取的是 session.meta.cwd（很可能恒为 undefined），USER.md 是否
      // 真的注入过完全无从判断 —— 没有日志，等于没验证。
      if (sid) {
        log?.info?.(
          `记忆注入层：会话 ${sid} 首次注入 MEMORY ${Buffer.byteLength(mem, "utf8")}B + USER ${Buffer.byteLength(user, "utf8")}B` +
          `（cwd=${typeof cwd === "string" ? cwd : "undefined"}）`,
        );
      }

      cacheSet(key, out);
      return out;
    },
  }), "dsh-dreaming: memory:curated section");

  // 压缩结束 → 作废本会话缓存，下一轮重新读盘。
  // 选 compaction/end 而不是 start：压缩失败时不该换版本，保持原样更安全。
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "compaction/end") return;
    // 失败路径也发同一个事件，只是多带一个 error 字段。压缩失败时历史没被重写，
    // prefix 仍然有效 —— 此时换版本反而白白全量重算一次，所以跳过。
    if (event?.data?.error !== undefined) return;
    const sid = session?.id;
    if (typeof sid !== "string") return;
    let dropped = 0;
    for (const key of frozen.keys()) {
      if (key.startsWith(`${sid}|`)) { frozen.delete(key); dropped += 1; }
    }
    if (dropped > 0) log?.info?.(`记忆注入层：压缩结束，本会话记忆缓存已作废（${dropped} 条），下一轮重新读盘`);
  });

  log?.info?.(`记忆注入层已挂载（${MEMORY_PATH()} + <cwd>/USER.md，上限 ${MAX_TOTAL_BYTES}B，会话级冻结）`);
  return true;
}
