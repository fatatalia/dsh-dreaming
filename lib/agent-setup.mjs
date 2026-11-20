/**
 * agent 组合工具 —— 给 dream-engine 之外的模块（nudge）复用。
 *
 * 为什么不直接改 dream-engine 里的 composeSetup 方法：那是梦境的核心路径，
 * 每天都在生产跑。把它抽成公共函数会让核心路径多一层间接，收益不值这个风险。
 * 这里的实现与它逐行等价，新模块用这份，dream-engine 保持不动。
 */
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

/** 合法思考等级（与 provider 的 reasoningEfforts 映射同名）。 */
export const REASONING_EFFORTS = ["off", "low", "medium", "high", "max"];

/**
 * 规整思考等级：空串/非法 → undefined（= 不显式指定，交 provider 默认）。
 * 注意 installModelSelection 会剥掉继承值，只认 selection 里显式带的
 * reasoningEffort —— 所以这里返回 undefined 时是真的"不指定"，不是"继承"。
 */
export function normalizeEffort(value) {
  const v = typeof value === "string" ? value.trim() : "";
  return REASONING_EFFORTS.includes(v) ? ReasoningEffortId(v) : void 0;
}

/**
 * 依据 agent-presets 组合出 web 兼容的 agent setup。
 *
 * @param services  { agentPresets, defaultModel } —— 从 ctx.get() 拿到的服务对象
 * @param presetId  preset 标识（如 "memory-curator"）
 * @param override  { provider?, model?, reasoningEffort? } 为空则用全局默认
 * @returns { agentPreset?: string, setup: (agentCtx) => Promise<void> }
 */
export async function composeAgentSetup(services, presetId, override) {
  const { agentPresets: presets, defaultModel } = services;
  const baseSel = defaultModel.currentSelection();
  const effort = normalizeEffort(override?.reasoningEffort);
  const selection = override
    ? {
        provider: override.provider || baseSel.provider,
        model: override.model || baseSel.model,
        ...(effort === void 0 ? {} : { reasoningEffort: effort }),
      }
    : baseSel;

  // 没有 preset 服务时退化为"只装模型选择" —— 仍然能跑，只是没有人格。
  if (presets === void 0) {
    return {
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: void 0 });
        return Promise.resolve();
      },
    };
  }

  const resolvedId = (await presets.resolve(presetId)).id;
  return {
    agentPreset: resolvedId,
    setup: async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: void 0 });
      await presets.mount(agentCtx, resolvedId);
    },
  };
}

/** 取指定 seq 之后最后一条 assistant 文本（工具调用块被忽略）。 */
export function lastAssistantText(events, firstSeq) {
  let text = "";
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data.message.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
  }
  return text;
}

/** 本地日期 YYYY-MM-DD（Asia/Shanghai）。 */
export function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

/**
 * 从 LLM 回复里剥出 JSON 数组。
 * 容忍 markdown 代码围栏与前后废话（模型经常加"好的，这是结果："）。
 * @returns 解析成功返回数组，失败返回 null（调用方要区分"空数组"与"解析失败"）
 */
export function extractJsonArray(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const start = unfenced.indexOf("[");
  const end = unfenced.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(unfenced.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}
