/**
 * 文本切分 —— 把一条消息切成若干段，每段单独嵌入。
 *
 * ⚠️ 为什么必须切：embeddinggemma-300m 上下文有限，实测本机 2400 字符可过、
 *    3000 会报 "Input is longer than the context size"。而一条 dreaming 提炼
 *    消息能到 8000+ 字 —— 一批 30 条里只要 1 条超限，整批就全废，水位线永远推不动。
 *
 * 与 openclaw 的差别：它按 UTF-8 字节硬切（2048 字节 ≈ 682 中文字，浪费了三成能力，
 * 且不管语义边界）。这里按「段落 → 换行 → 句号 → 硬切」逐级降级，尽量在语义边界断开。
 */

/** 目标段长：攒到这个长度就断开。 */
const TARGET = 1200;
/** 硬上限：超过就必须切，与 vec-embed-child 的 MAX_CHARS 一致。 */
const MAX = 1500;
/** 尾部剩余不足这个长度就并进上一段，避免产生大量碎块。 */
const MIN_TAIL = 200;

/**
 * 按分隔符把文本切成片段，保留分隔符在片段末尾。
 * @param {string} text
 * @param {RegExp} sep 带捕获组的正则
 * @returns {string[]}
 */
function splitKeep(text, sep) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(sep)) {
    const end = m.index + m[0].length;
    parts.push(text.slice(last, end));
    last = end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.filter((s) => s.length > 0);
}

/**
 * 把一段超长文本降级切分，直到每片都 <= MAX。
 * @param {string} text
 * @returns {string[]}
 */
function hardSplit(text) {
  if (text.length <= MAX) return [text];

  // 降级顺序：空行 → 换行 → 句末标点 → 硬切
  const levels = [/\n{2,}/g, /\n/g, /(?<=[。！？；.!?;])\s*/g];
  for (const sep of levels) {
    const parts = splitKeep(text, sep);
    if (parts.length > 1) {
      const out = [];
      for (const p of parts) out.push(...hardSplit(p));
      return out;
    }
  }

  // 全都没有分隔符 —— 只能按长度硬切
  const out = [];
  for (let i = 0; i < text.length; i += MAX) out.push(text.slice(i, i + MAX));
  return out;
}

/**
 * 把一条消息的正文切成若干段。
 *
 * @param {string} input 原始正文
 * @param {object} [opts]
 * @param {number} [opts.target] 目标段长
 * @param {number} [opts.max] 硬上限
 * @returns {string[]} 至少一段；空内容返回空数组
 */
export function chunkText(input, opts = {}) {
  const target = opts.target ?? TARGET;
  const max = opts.max ?? MAX;

  const text = String(input ?? "").replace(/\r\n/g, "\n");
  if (!text.trim()) return [];
  if (text.length <= max) return [text];

  // 先按空行切成「自然段」，再逐段降级
  const out = [];
  let buf = "";

  const flush = () => {
    if (buf.trim()) out.push(buf);
    buf = "";
  };

  for (const para of splitKeep(text, /\n{2,}/g)) {
    for (const piece of hardSplit(para)) {
      // 当前缓冲 + 这一片仍在目标内 → 继续攒
      if (buf.length + piece.length <= target) {
        buf += piece;
        continue;
      }
      flush();
      if (piece.length <= target) {
        buf = piece;
      } else {
        // 单片就超目标（但已 <= max）→ 单独成段
        out.push(piece);
      }
    }
  }
  flush();

  // 尾巴太短就并回上一段（只要不超 max）
  if (out.length >= 2) {
    const last = out[out.length - 1];
    if (last.length < MIN_TAIL && out[out.length - 2].length + last.length <= max) {
      out[out.length - 2] += last;
      out.pop();
    }
  }

  return out.length > 0 ? out : [text];
}

/** 一条消息最多允许多少段 —— chunk_id = msg_id * 100 + seq，超过会串号。 */
export const MAX_CHUNKS_PER_MSG = 100;

/**
 * 由消息 id 和段序号算出 chunk_id。
 *
 * 为什么不用 AUTOINCREMENT：这样是幂等的 —— 同一条消息重算得到同一批 id，
 * 重跑不会写重，也不需要维护序列。
 */
export function chunkIdFor(msgId, seq) {
  return Number(msgId) * 100 + Math.min(seq, MAX_CHUNKS_PER_MSG - 1);
}
