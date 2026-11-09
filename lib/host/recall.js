/**
 * host/recall —— 每轮对话前把「长期记忆 + 知识库」召回成 prompt 段文本。
 *
 * 契约（DESIGN §0.3）：prompt 段只渲染变量，数据在这里按当前用户消息 query 现算；
 * 召回失败只 warn，绝不影响正常对话。
 */
const DEFAULT_MEMORY_BUDGET = 1200;
const DEFAULT_KB_BUDGET = 1500;

/** 按字符预算拼记忆行。 */
export function formatMemoryRecall(rows, budgetChars = DEFAULT_MEMORY_BUDGET) {
  const budget = Number(budgetChars) > 0 ? Number(budgetChars) : DEFAULT_MEMORY_BUDGET;
  const lines = [];
  let used = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = typeof row === 'string' ? row.trim() : String(row && row.text ? row.text : '').trim();
    if (text === '') continue;
    const line = '- ' + text;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length === 0 ? '' : '【长期记忆】\n' + lines.join('\n');
}

/** 按字符预算拼知识片段。 */
export function formatKnowledgeRecall(results, budgetChars = DEFAULT_KB_BUDGET, maxItems = 5) {
  const budget = Number(budgetChars) > 0 ? Number(budgetChars) : DEFAULT_KB_BUDGET;
  const limit = Number(maxItems) > 0 ? Number(maxItems) : 5;
  const parts = [];
  let used = 0;
  let count = 0;
  for (const item of Array.isArray(results) ? results : []) {
    if (count >= limit) break;
    const text = String(item && item.text ? item.text : '').trim();
    if (text === '') continue;
    const title = String(item && item.title ? item.title : '').trim();
    const block = (title !== '' ? '《' + title + '》' : '') + text;
    if (used + block.length > budget) continue;
    parts.push(block);
    used += block.length + 1;
    count += 1;
  }
  return parts.length === 0 ? '' : '【知识库】\n' + parts.join('\n');
}

/**
 * 召回某 bot + peer 的记忆与知识。
 * @param {{memory: object|null, knowledge: object|null, settings: object, botId: string, query: string}} args
 * @returns {Promise<{memoryText: string, knowledgeText: string}>}
 */
export async function recallForPeer({ memory, knowledge, settings, botId, query } = {}) {
  const cfg = settings && typeof settings === 'object' ? settings : {};
  const text = typeof query === 'string' ? query.trim() : '';
  const out = { memoryText: '', knowledgeText: '' };
  if (text === '' || !botId) return out;

  if (cfg.memory && cfg.memory.enabled !== false && memory) {
    try {
      const topK = Number(cfg.memory.recallTopK) > 0 ? Number(cfg.memory.recallTopK) : 6;
      const rows = typeof memory.recallForPrompt === 'function'
        ? memory.recallForPrompt({ botId, query: text, budgetChars: Number(cfg.memory.recallChars) || DEFAULT_MEMORY_BUDGET, topK })
        : (typeof memory.search === 'function' ? memory.search({ botId, query: text, limit: topK }) : []);
      // recallForPrompt 可能直接返回字符串
      out.memoryText = typeof rows === 'string' ? rows : formatMemoryRecall(rows, Number(cfg.memory.recallChars) || DEFAULT_MEMORY_BUDGET);
    } catch (err) {
      out.memoryText = '';
    }
  }

  if (cfg.kb && cfg.kb.enabled !== false && knowledge && typeof knowledge.search === 'function') {
    try {
      const topK = Number(cfg.kb.topK) > 0 ? Number(cfg.kb.topK) : 5;
      const results = knowledge.search({ botId, query: text, limit: topK });
      out.knowledgeText = formatKnowledgeRecall(results, Number(cfg.kb.maxChars) || DEFAULT_KB_BUDGET, topK);
    } catch (err) {
      out.knowledgeText = '';
    }
  }
  return out;
}
