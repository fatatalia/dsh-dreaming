/**
 * 记忆注入层 —— 把 MEMORY.md / USER.md 送进 system prompt。
 *
 * 为什么自己注册而不是靠 dsh-agent-instructions：
 * 那个插件的文件名是写死的（AGENTS.md / CLAUDE.md 及其 .local 变体），
 * 不认 MEMORY.md / USER.md，没有配置项。所以只能由本插件注册 section。
 *
 * 为什么 text 写成函数：
 * `assemble()` 每个 step 调一次，函数每次重新读盘 →
 * ① 文件被改了下个 step 就生效，不用重启；
 * ② USER.md 要按当前会话的 cwd 解析（每个工作区一份），静态字符串做不到。
 *
 * 为什么不怕破坏 prefix cache：
 * DeepSeek 的 prefix cache 按**字节前缀**匹配。文件没变 → prompt 字节相同 →
 * cache 照常命中。只有内容真变了的那一次失效，下一步恢复。真实成本 ≈ 每次 0.1ms 读盘。
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

/** 单次注入总量上限。超过就只注入 MEMORY，不注入 USER —— 宁可少注入也别撑爆 prompt。 */
const MAX_TOTAL_BYTES = 10 * 1024;

/** 读文件，失败一律返回空串。
 *  **绝不抛错**：记忆文件坏掉（不存在 / 无权限 / 编码错）不能拖垮整个对话。 */
function readSafe(path) {
  if (!path) return "";
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/**
 * 注册两个 section：memory:curated（MEMORY.md）、memory:user（USER.md）。
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

  let warned = false;

  ctx.effect(() => sp.section({
    name: "memory:curated",
    order: 10100,
    interpolate: false,          // 记忆里可能出现 {{ }} 字面量，不能被当成模板变量
    text: (context) => {
      const mem = readSafe(MEMORY_PATH());
      if (!mem.trim()) return "";

      const cwd = context?.agent?.session?.meta?.cwd;
      const user = readSafe(userPath(cwd));

      const total = Buffer.byteLength(mem, "utf8") + Buffer.byteLength(user, "utf8");
      let useUser = Boolean(user.trim());
      if (useUser && total > MAX_TOTAL_BYTES) {
        useUser = false;
        if (!warned) {
          warned = true;
          log?.info?.(`记忆注入层：MEMORY(${Buffer.byteLength(mem, "utf8")}B) + USER(${Buffer.byteLength(user, "utf8")}B) 超过 ${MAX_TOTAL_BYTES}B，本步只注入 MEMORY`);
        }
      }
      return useUser ? `${mem.trim()}\n\n${user.trim()}` : mem.trim();
    },
  }), "dsh-dreaming: memory:curated section");

  log?.info?.(`记忆注入层已挂载（${MEMORY_PATH()} + <cwd>/USER.md，上限 ${MAX_TOTAL_BYTES}B）`);
  return true;
}
