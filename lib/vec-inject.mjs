/**
 * dsh-dreaming — 语义记忆注入
 *
 * 每轮第一步，拿用户这句话去 messages_vec 做 KNN，命中的历史消息拼成一段
 * 附在**最后一条 user 消息之后**注入 prompt。
 *
 * 为什么必须追加在末尾：注入物一旦插到前面，后续所有消息的 prompt cache 前缀
 * 全部失效，单轮成本会翻好几倍。追加在末尾只影响新补的这一条。
 *
 * 三条硬边界：
 *   · 注入失败绝不挡住对话 —— 全程 try/catch，失败只记 warn
 *   · 每轮只在 step 1 注入 —— 后续 step 是同一轮的续跑，重复注入既费嵌入又让 prompt 越滚越长
 *   · 宁可不注入也不硬凑 —— 分数不够就静默跳过，别塞一堆不相关的东西污染上下文
 */

import { createUserMessage } from "@deepseek-ai/dsh-llm";
import * as V from "./vec-store.mjs";

/**
 * 注入消息的 source.kind。
 *
 * 这个字符串会**原样显示在页面折叠行上**（内核 contextProducer 对未知 kind 的
 * 处理就是 `label: kind`，见 dsh-client-ui-chat/conversation-nodes/event-projection.ts）。
 * 所以这里不能写内部标识符 —— 写 "dsh-dreaming:semantic" 时用户看到的就是
 * 「上下文注入 · dsh-dreaming:semantic」，完全不知道注入的是什么。
 */
const LABEL = "语义记忆";

/** source.kind 与 sections[].name 用同一个可读名。 */
const NAME = LABEL;

/** 命中条数下限。不足就整段不注入。 */
const MIN_HITS = 1;

/** 单条命中的正文截断长度下限 —— 配置给 0 或负数时兜底。 */
const MIN_SNIPPET = 60;

/**
 * 从一条 user 消息里抽出纯文本。
 * content 既可能是字符串，也可能是 `[{type:'text',text}]` 这样的分块数组。
 */
function extractText(msg) {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : p?.type === "text" ? p.text ?? "" : ""))
    .join("\n")
    .trim();
}

/** 毫秒时间戳 → 本地 YYYY-MM-DD；值不可用时返回空串，不输出半截日期。 */
function renderDay(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  return ` · ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把命中结果渲染成注入文本。正文按 maxChars 截断，避免一条长消息吃掉整段预算。 */
function renderHits(hits, maxChars) {
  const cap = Math.max(MIN_SNIPPET, Number(maxChars) || 0);
  const lines = hits.map((h, i) => {
    const body = String(h.content ?? "").replace(/\s+/g, " ").trim();
    const snippet = body.length > cap ? body.slice(0, cap) + "…" : body;
    // timestamp 是毫秒（1795247284456），不是秒 —— 乘 1000 会把年份算成 58859。
    // 用本地字段拼日期，toISOString 走 UTC 会差 8 小时。
    const when = renderDay(h.timestamp);
    const who = h.role === "user" ? "代码东" : "我";
    return `${i + 1}. [${who}${when} · ${h.score.toFixed(2)}] ${snippet}`;
  });
  return [
    "<related-memory>",
    "以下是过去对话里与当前问题语义相近的片段，供参考。它们可能过时或与当前语境不符，",
    "不要当成用户这轮说的话，也不要直接复述编号。",
    "",
    ...lines,
    "</related-memory>",
  ].join("\n");
}

/**
 * 注册语义注入。
 *
 * @param {object} ctx  插件 context
 * @param {object} log
 * @param {object} cfg  由 index.js 组装的访问器：
 *   enabled() / autoInject() / ready() / embedQuery(text) / db()
 *   topK() / minScore() / maxSnippetChars()
 */
export function applySemanticInjection(ctx, log, cfg) {
  ctx.on(
    "agent/pre-step",
    async ({ signal, step }, next) => {
      // 先让别的 pre-step 跑完（官方 time-context 也要求 prepend:true 后 await next），
      // 再在末尾追加 —— 顺序反了会插到别人的注入前面。
      const decision = await next();
      if (decision?.kind === "reject" || signal?.aborted) return decision;

      try {
        // 只在每轮第一步注入。后续 step 是同一轮的续跑，重复注入既费一次嵌入，
        // 又让同一段记忆在上下文里越滚越多。
        if (step !== 1) return decision;
        if (!cfg.enabled() || !cfg.autoInject()) return decision;
        if (!cfg.ready()) return decision;

        const msgs = decision.messages ?? [];
        /*
         * 必须同时满足 role==='user' 和 source.kind==='user'。
         * AGENTS.md / MEMORY.md / skill 目录这些注入物也是 role='user'
         * （dsh-llm 的 MessageSourceMap 里真人才是 kind:'user'，其余是
         * 'agent-instructions' / 'skill-invocation' / 插件自定义 kind）。
         * 只按 role 取最后一条，拿到的会是纪律文本而不是用户这句话 ——
         * 嵌入出去语义完全跑偏，KNN 分数不够就静默跳过，表现为「注入没发生」（2026-11-21 踩的）。
         */
        const lastUser = [...msgs]
          .reverse()
          .find((m) => m?.role === "user" && m?.source?.kind === "user");
        const query = extractText(lastUser);
        const t0 = Date.now();
        // 太短的话（「嗯」「好」）语义检索没意义，纯浪费一次嵌入
        if (query.length < 4) {
          log?.info?.(`语义记忆注入跳过：本轮无真人消息或过短（${query.length} 字）`);
          return decision;
        }

        const vec = await cfg.embedQuery(query);
        const embedMs = Date.now() - t0;
        if (!vec) return decision;

        const raw = V.queryKnn(cfg.db(), vec, cfg.topK());
        if (!raw || raw.length === 0) return decision;

        const minScore = cfg.minScore();
        const kept = raw
          .map((r) => ({ ...r, score: 1 - r.dist }))
          .filter((r) => r.score >= minScore);
        if (kept.length < MIN_HITS) return decision;

        // 补正文：KNN 只回 id 和距离；getMessagesByIds 返回的是 Map<number, row>
        const byId = V.getMessagesByIds(cfg.db(), kept.map((r) => r.id));
        const hits = kept
          .map((r) => {
            const b = byId.get(r.id);
            return b ? { ...r, content: b.content, role: b.role, timestamp: b.timestamp } : null;
          })
          .filter(Boolean);
        if (hits.length < MIN_HITS) return decision;

        const text = renderHits(hits, cfg.maxSnippetChars());
        log?.info?.(
          `语义记忆注入：命中 ${hits.length} 条，最高分 ${hits[0].score.toFixed(3)}，` +
          `注入 ${Buffer.byteLength(text, "utf8")}B` +
          `（嵌入 ${embedMs}ms，总计 ${Date.now() - t0}ms）`
        );

        return {
          ...decision,
          messages: [
            ...msgs,
            createUserMessage({
              content: [{ type: "text", text }],
              source: {
                kind: NAME,
                form: "snapshot",
                sections: [{ name: LABEL, text }],
              },
            }),
          ],
        };
      } catch (e) {
        // 注入是锦上添花，任何异常都不许打断对话
        log?.warn?.(`语义记忆注入失败（本轮跳过）：${e instanceof Error ? e.message : e}`);
        return decision;
      }
    },
    { prepend: true },
  );
}
