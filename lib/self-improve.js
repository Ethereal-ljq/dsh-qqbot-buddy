/**
 * self-improve —— 「自我改进」提示词单独成篇，与 persona 分开。
 *
 * - DEFAULT_SELF_IMPROVE_PROMPT：注入聊天 system prompt 的学习规则（可被 settings.memory.selfImprovePrompt 覆盖）；
 * - DEFAULT_COLLECTOR_PROMPT / buildCollectorPrompt：自动记忆提炼器的独立 prompt（可被 settings.memory.collectorPrompt 覆盖）。
 * persona.md 只负责人设/语气，不承载学习规则；两者在 prompt 组装时是独立段落。
 */

export const DEFAULT_SELF_IMPROVE_PROMPT = [
  '你不是被动问答，还要从聊天里慢慢学：',
  '- 对方纠正你、明确表达偏好/禁忌、约定长期做法、给出重要事实时，用 memory_save 记下来；下次遇到同类场景按记忆调整。',
  '- 只记长期有效的东西：不记寒暄、一次性玩笑、临时状态、工具调用细节；拿不准就先不记。',
  '- 记忆冲突时以对方最新说法为准；发现记错了要纠正/更新，而不是继续沿用。',
  '- 记忆是辅助，不要为了显得聪明而复述记忆内容，自然地用。',
].join('\n');

export const DEFAULT_COLLECTOR_PROMPT = [
  '你是长期记忆提炼器。请从下面的对话摘录中提取值得长期记住的事实。',
  '重点：用户身份与称呼、偏好与禁忌、长期约定、重要事件、需要记住的结论。',
  '忽略：寒暄、一次性闲聊、工具调用过程、与用户无关的闲聊内容。',
  '最多输出 {{maxFacts}} 条事实，每条不超过 {{maxFactChars}} 个字符。',
  '严格只输出一个 JSON 对象，不要解释、不要 markdown 代码块：',
  '{"facts":[{"text":"...","tags":["..."],"importance":"normal"}]}',
  'importance 只能是 "normal" 或 "high"；tags 为最多 3 个简短关键词；没有可记事实时输出 {"facts":[]}。',
].join('\n');

/** 组装提炼 prompt：自定义文本可按 {{maxFacts}} / {{maxFactChars}} 占位。 */
export function buildCollectorPrompt({ transcript, maxFacts, maxFactChars, override } = {}) {
  const custom = typeof override === 'string' ? override.trim() : '';
  const template = custom !== '' ? custom : DEFAULT_COLLECTOR_PROMPT;
  const head = template
    .replaceAll('{{maxFacts}}', String(maxFacts))
    .replaceAll('{{maxFactChars}}', String(maxFactChars));
  return head + '\n\n【对话摘录】\n' + String(transcript || '');
}
