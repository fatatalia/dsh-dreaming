/**
 * dream-render.mjs — dream_latest 工具结果的文本渲染（纯函数，可单测）。
 *
 * 2026-08-25 事故修复：此前 render 只输出"最近梦境 N 条"，把 dreams 数组的
 * 真实内容吞掉，导致早安心跳 agent 只看到条数、判定"无内容"跳过梦境分享。
 * 教训：defineTool 的 output.render 决定模型能看到的内容，必须把关键数据
 * 渲染进 text——本模块让该逻辑可被单元测试覆盖，防止回归。
 */

/** 把梦境列表渲染成给模型看的文本。空列表返回明确的"无记录"文案。 */
export function renderDreams(dreams) {
  const list = Array.isArray(dreams) ? dreams : [];
  if (list.length === 0) {
    return "最近没有梦境记录";
  }
  const lines = list.map((d) => `【${d.date}】\n${d.content}`);
  return `最近梦境 ${list.length} 条\n\n${lines.join("\n\n")}`;
}
