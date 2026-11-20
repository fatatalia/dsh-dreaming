/**
 * 门控层（P5）—— 挡住不该进 MEMORY.md 的东西。
 *
 * 为什么需要它：
 * 梦境从 2026-10 起就在**无人值守**地往 MEMORY.md 追加（已连续 25 段），
 * 预算上限 128 KB 等于没有上限。没有门控的提炼 = 没有校对员的印刷厂。
 *
 * 门控只管「能不能写进去」，不管「写得对不对」—— 后者是提炼 prompt 的职责。
 * 四条都是**代码能查的硬事实**，不依赖模型自觉：
 *
 *   ① 体积：单条 + 总量硬上限
 *   ② 易腐烂：日期戳 / 票据号 / PR 号 / 版本号 —— 半年后必然误导
 *   ③ 否定断言：「X 不可用 / 没生效 / 已废弃」—— 最危险的一类，
 *      因为世界变了它不会跟着变，而未来的我会拿它当事实
 *   ④ 动作流水：「修复了 / 部署了 / 查了」—— 这是日记内容，不是认知
 *
 * 被拦下的条目**不静默丢弃**：写进 memory/archive/curation-log.md，可追溯。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** 单条认知上限（字符）。超过基本就是流水账。 */
export const MAX_INSIGHT_CHARS = 160;
/** MEMORY.md 总量硬上限（字节）。与注入层 MAX_TOTAL_BYTES 对齐，留出 USER.md 的余量。 */
export const MAX_MEMORY_BYTES = 10 * 1024;

/**
 * ② 易腐烂信息 —— 只拦**文件路径里的日期**和**「某日发生了某事」**。
 *
 * ⚠️ 2026-11-20 第一版还拦「任何日期」「任何版本号」「任何数字编号」，回放真实数据时全误杀：
 *   「紫紫和白白是同胞兄弟（2018年8月出生）」        → 生日是永久事实
 *   「跑 open-xiaoai-bridge 的是 2017 款 MacBookPro14,1」→ 硬件规格，`7660U` 被当成票据号
 *   「CVE-2026-98432 是 Linux IPv4 TCP 竞态…」       → CVE 编号是稳定标识
 * 教训：**正则判不了「这条信息会不会过期」，只能判「它的形状对不对」。**
 * 所以规则收到只剩两种形状明确会腐烂的：
 *   - 指向具体每日文件的路径（文件会被归档、被删）
 *   - 「YYYY-MM-DD 公布/发布/上线/改完」这类**事件时间戳**（事件本身不是认知）
 * 宁可漏放也不误杀：每晚最多晋升 5 条，拦错 1 条就少了 20% 的收获。
 */
const ROTTING_PATTERNS = [
  { re: /memory\/(?:daily|archive)\/\d{4}-\d{2}-\d{2}/, why: "指向每日记忆文件路径（会归档）" },
  { re: /\b\d{4}-\d{2}-\d{2}\s*(?:公布|发布|上线|改完|修复|完成|出生)/, why: "事件时间戳（事件不是认知）" },
  { re: /(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2})\s*(?:起|之后|以后|开始|以后)/, why: "以日期为界的时效性结论" },
];

/**
 * ③ 状态腐烂断言 —— 只拦「某物曾经有、现在没了」这类**描述当前状态**的句子。
 *
 * ⚠️ 2026-11-20 第一版一刀切拦所有否定词，回放真实数据时误杀了真教训：
 *   「贴壁电容式水位检测在不锈钢容器上物理失效」→ 物理规律，永远不会腐烂
 *   「YAML 平台实体没有 config_entry，device_info 不生效，要挂到设备页必须做成 config_entry 集成」
 *   「在 turn/end 回调里同步调用 followup 会撞重入锁，重试永不生效」
 * 这些是**技术教训**：讲的是原理和后果，不是「现在这个世界长什么样」。
 *
 * 判据改成：
 *   - 「已废弃 / 已停用 / 已下线 / 已移除 / 已删除」→ 直接拦（描述状态，状态会变）
 *   - 「不生效 / 失效 / 不可用」→ **只有不带解法时才拦**（带「要/应/需/改成」的是教训）
 */
const ROTTING_STATE = [
  /(?:已|被)(?:废弃|停用|下线|移除|删除)(?:了|掉)?/,
  /(?:不再|已经不用|改用了|换成了)(?:旧|原来的)/,
];
/** 带这些词说明句子在给解法/原理 ⇒ 是教训，不是状态快照。 */
const HAS_SOLUTION = /要|应|需|得|必须|改成|换成|改为|先|除非|否则|因为|由于|原理|物理|机制|导致/;
const SOFT_NEGATIVE = /不可用|不能用|用不了|失效|不生效|未生效|没生效|不起作用|没起作用|被禁用|无法加载|加载失败/;

/**
 * ④ 动作流水：第一人称/助手视角做过什么。日记该记，认知不该。
 *
 * 只认**句首**的动作动词 —— 句中出现的「已修复」可能是教训的一部分
 * （「重试永不生效」里的「生效」就不该被拦）。
 */
const ACTION_LOG = [
  /^(?:今天|昨天|刚刚|刚才|本次|这一轮)?\s*(?:我|助手|已)?\s*(?:修复了|改好了|部署了|装好了|删除了|清理了|重启了|更新了|升级了|写入了|记下了)/,
  /^(?:将|把).{0,40}(?:写入|记入|记到|归档到)/,
];

/** 纯过程性废话。 */
const NOISE = [/^\s*$/, /^(?:暂无|无|空|N\/A|test|测试)$/i];

/**
 * 检查一条认知能不能进 MEMORY.md。
 * @param {{content?: string, type?: string}} insight
 * @returns {{ok: boolean, why?: string}}
 */
export function checkInsight(insight) {
  const raw = String(insight?.content ?? "").replace(/\s+/g, " ").trim();

  if (!raw) return { ok: false, why: "内容为空" };
  for (const re of NOISE) if (re.test(raw)) return { ok: false, why: "无实质内容" };
  if (raw.length > MAX_INSIGHT_CHARS) {
    return { ok: false, why: `过长（${raw.length} > ${MAX_INSIGHT_CHARS} 字符）` };
  }

  for (const { re, why } of ROTTING_PATTERNS) {
    if (re.test(raw)) return { ok: false, why: `${why}（半年后必然过期）` };
  }
  for (const re of ROTTING_STATE) {
    if (re.test(raw)) return { ok: false, why: "状态腐烂断言（描述「现在没这个」，世界变回来就错）" };
  }
  if (SOFT_NEGATIVE.test(raw) && !HAS_SOLUTION.test(raw)) {
    return { ok: false, why: "否定断言且无解法（纯状态抱怨，半年后误导）" };
  }
  for (const re of ACTION_LOG) {
    if (re.test(raw)) return { ok: false, why: "动作流水（属于日记，不是认知）" };
  }
  return { ok: true };
}

/**
 * 批量过门：返回放行的和被拦的。
 * @param {Array<{content?: string, type?: string}>} insights
 * @returns {{passed: Array, rejected: Array<{content: string, why: string}>}}
 */
export function gateInsights(insights) {
  const passed = [];
  const rejected = [];
  for (const ins of Array.isArray(insights) ? insights : []) {
    const verdict = checkInsight(ins);
    if (verdict.ok) passed.push(ins);
    else rejected.push({ content: String(ins?.content ?? "").slice(0, 120), why: verdict.why });
  }
  return { passed, rejected };
}

/**
 * 把被拦的条目记进 curation-log.md（可追溯，不静默丢弃）。
 * 失败不抛 —— 日志写不进去不该阻止梦境继续。
 */
export async function logRejections(archiveDir, date, rejected, log) {
  if (!rejected?.length) return;
  try {
    await mkdir(archiveDir, { recursive: true });
    const lines = [
      `\n## ${date} — 门控拦截 ${rejected.length} 条\n`,
      ...rejected.map((r) => `- [${r.why}] ${r.content}`),
      "",
    ];
    await appendFile(join(archiveDir, "curation-log.md"), lines.join("\n"), "utf8");
  } catch (e) {
    log?.info?.(`门控：拦截日志写入失败 ${e instanceof Error ? e.message : e}`);
  }
}
