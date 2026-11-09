/**
 * host/recall —— 每轮对话前把「长期记忆 + 知识库 + 群友库」召回成 prompt 段文本。
 *
 * 契约（DESIGN §0.3）：prompt 段只渲染变量，数据在这里按当前用户消息 query 现算；
 * 召回失败只 warn，绝不影响正常对话。
 *
 * 关键点：query 必须是「本轮用户原话」，不能是拼了 Chat history 的整包 body——
 * 否则 trigram FTS 检索整段长文本基本零命中（v2 早期就是这么丢记忆的）。
 */
const DEFAULT_MEMORY_BUDGET = 1200;
const DEFAULT_KB_BUDGET = 1500;
const DEFAULT_MEMBER_BUDGET = 800;
const DEFAULT_MEMBER_MAX = 3;
const DEFAULT_KB_ITEMS = 5;
const DEFAULT_MEMBER_CANDIDATES = 200;

const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const strOf = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * 把一句话拆成检索词：FTS 是整串 phrase 匹配，整句 query 基本零命中，
 * 所以按空白/标点切开，单个词分别检索后合并（"hollow 吃什么？鱼鱼" → hollow / 吃什么 / 鱼鱼）。
 */
export function queryTerms(text) {
  const norm = strOf(text).normalize('NFKC');
  if (norm === '') return [];
  const parts = norm.split(/[^\p{L}\p{N}]+/u).map((part) => part.trim()).filter((part) => part.length >= 2);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
    if (out.length >= 8) break;
  }
  return out;
}

/** 多词检索：整句优先，空结果时逐词召回并去重（最多 limit 条）。 */
function searchWithFallback({ store, botId, text, limit, keyOf = (row) => row && row.id }) {
  const size = Number(limit) > 0 ? Number(limit) : DEFAULT_KB_ITEMS;
  const first = typeof store.search === 'function' ? store.search({ botId, query: text, limit: size }) : [];
  if (Array.isArray(first) && first.length > 0) return first;
  const terms = queryTerms(text);
  if (terms.length <= 1) return [];
  const merged = [];
  const seen = new Set();
  for (const term of terms) {
    let rows = [];
    try { rows = typeof store.search === 'function' ? store.search({ botId, query: term, limit: size }) : []; } catch { rows = []; }
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = keyOf(row);
      if (key === undefined || key === null || seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
      if (merged.length >= size) return merged;
    }
  }
  return merged;
}

/** 按字符预算拼记忆行。 */
export function formatMemoryRecall(rows, budgetChars = DEFAULT_MEMORY_BUDGET) {
  const budget = Number(budgetChars) > 0 ? Number(budgetChars) : DEFAULT_MEMORY_BUDGET;
  const lines = [];
  let used = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const text = typeof row === 'string' ? row.trim() : strOf(row && row.text);
    if (text === '') continue;
    const line = '- ' + text;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length === 0 ? '' : '【长期记忆】\n' + lines.join('\n');
}

/** 按字符预算拼知识片段。 */
export function formatKnowledgeRecall(results, budgetChars = DEFAULT_KB_BUDGET, maxItems = DEFAULT_KB_ITEMS) {
  const budget = Number(budgetChars) > 0 ? Number(budgetChars) : DEFAULT_KB_BUDGET;
  const limit = Number(maxItems) > 0 ? Number(maxItems) : DEFAULT_KB_ITEMS;
  const parts = [];
  let used = 0;
  let count = 0;
  for (const item of Array.isArray(results) ? results : []) {
    if (count >= limit) break;
    const text = strOf(item && item.text);
    if (text === '') continue;
    const title = strOf(item && item.title);
    const block = (title !== '' ? '《' + title + '》' : '') + text;
    if (used + block.length > budget) continue;
    parts.push(block);
    used += block.length + 1;
    count += 1;
  }
  return parts.length === 0 ? '' : '【知识库】\n' + parts.join('\n');
}

/* ------------------------------ 群友库（懒加载） ------------------------------ */

/** 归一化用于提及匹配：NFKC + 小写 + 去空白。 */
export function normalizeMentionText(text) {
  return strOf(text).normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

/** 成员可被提及的所有称呼（昵称/画像别名/备注名）。 */
export function aliasesOf(member) {
  const item = isObj(member) ? member : {};
  const profile = isObj(item.profileJson) ? item.profileJson : (isObj(item.profile) ? item.profile : {});
  const list = [strOf(item.nickname), strOf(item.name), strOf(item.title)];
  for (const key of ['nicknames', 'aliases']) {
    const values = profile[key];
    if (Array.isArray(values)) for (const value of values) list.push(strOf(value));
  }
  const seen = new Set();
  const out = [];
  for (const alias of list) {
    if (alias.length < 2) continue;
    const norm = normalizeMentionText(alias);
    if (norm === '' || seen.has(norm)) continue;
    seen.add(norm);
    out.push(alias);
  }
  return out;
}

/** 从文本里解析被提到的成员（最长称呼优先，避免「老周」命中「老周年」）。 */
export function resolveMentionedMembers(text, members, { limit = DEFAULT_MEMBER_MAX } = {}) {
  const normalizedText = normalizeMentionText(text);
  if (normalizedText === '') return [];
  const max = Number(limit) > 0 ? Number(limit) : DEFAULT_MEMBER_MAX;
  const rows = [];
  for (const member of Array.isArray(members) ? members : []) {
    if (!isObj(member)) continue;
    let best = null;
    for (const alias of aliasesOf(member)) {
      const key = normalizeMentionText(alias);
      const at = normalizedText.indexOf(key);
      if (at < 0) continue;
      if (best === null || key.length > best.alias.length) best = { alias, at };
    }
    if (best) rows.push({ member, alias: best.alias, at: best.at });
  }
  rows.sort((a, b) => b.alias.length - a.alias.length || a.at - b.at);
  return rows.slice(0, max);
}

/** 画像 → prompt 一行摘要（每人一行，严格限长）。 */
export function memberPromptLine(member, { isSender = false } = {}) {
  const item = isObj(member) ? member : {};
  const profile = isObj(item.profileJson) ? item.profileJson : (isObj(item.profile) ? item.profile : {});
  const name = strOf(item.nickname) || strOf(item.name) || '群友';
  const bits = [];
  const nicknames = Array.isArray(profile.nicknames) ? profile.nicknames.map(strOf).filter(Boolean).slice(0, 4) : [];
  if (nicknames.length > 0) bits.push('称呼 ' + nicknames.join('、'));
  const personality = Array.isArray(profile.personality) ? profile.personality.map(strOf).filter(Boolean).slice(0, 3) : [];
  if (personality.length > 0) bits.push('性格 ' + personality.join('、'));
  const deeds = Array.isArray(profile.deeds) ? profile.deeds.map(strOf).filter(Boolean).slice(0, 3) : [];
  if (deeds.length > 0) bits.push('事迹 ' + deeds.join('；'));
  const affinity = isObj(profile.affinity) ? profile.affinity : {};
  const level = Number.isFinite(Number(affinity.level)) ? Math.max(-2, Math.min(2, Math.round(Number(affinity.level)))) : 0;
  const affinityLabel = ['警惕', '一般', '普通', '亲近', '很亲近'][level + 2];
  if (level !== 0 || strOf(affinity.note) !== '') {
    bits.push('关系 ' + affinityLabel + (strOf(affinity.note) !== '' ? '（' + strOf(affinity.note).slice(0, 40) + '）' : ''));
  }
  const tags = Array.isArray(profile.tags) ? profile.tags.map(strOf).filter(Boolean).slice(0, 4) : [];
  if (tags.length > 0) bits.push('标签 ' + tags.join('、'));
  if (strOf(item.note) !== '') bits.push(strOf(item.note).slice(0, 80));
  if (isSender) bits.push('就是当前发言人');
  return '- 群友 ' + name + (bits.length > 0 ? '：' + bits.join('；').slice(0, 300) : '');
}

/** 拼群友段（含预算截断）。 */
export function formatMemberRecall(lines, budgetChars = DEFAULT_MEMBER_BUDGET) {
  const budget = Number(budgetChars) > 0 ? Number(budgetChars) : DEFAULT_MEMBER_BUDGET;
  const rows = [];
  let used = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const text = strOf(line);
    if (text === '') continue;
    if (used + text.length > budget) break;
    rows.push(text);
    used += text.length + 1;
  }
  return rows.length === 0 ? '' : '【群友】\n' + rows.join('\n');
}

/**
 * 召回某 bot + peer 的记忆 / 知识 / 群友。
 * @param {{memory: object|null, knowledge: object|null, members: object|null,
 *   settings: object, botId: string, query: string, senderId?: string}} args
 * @returns {Promise<{memoryText: string, knowledgeText: string, memberText: string}>}
 */
export async function recallForPeer({ memory, knowledge, members, settings, botId, query, senderId } = {}) {
  const cfg = settings && typeof settings === 'object' ? settings : {};
  const text = strOf(query);
  const out = { memoryText: '', knowledgeText: '', memberText: '' };
  if (text === '' || !botId) return out;

  if (cfg.memory && cfg.memory.enabled !== false && memory) {
    try {
      const topK = Number(cfg.memory.recallTopK) > 0 ? Number(cfg.memory.recallTopK) : 6;
      const budget = Number(cfg.memory.recallChars) || DEFAULT_MEMORY_BUDGET;
      if (typeof memory.recallForPrompt === 'function') {
        let recalled = memory.recallForPrompt({ botId, query: text, budgetChars: budget, topK });
        // 整句零命中时逐词召回（FTS phrase 匹配对长句不友好）
        if ((typeof recalled !== 'string' || recalled.trim() === '') && queryTerms(text).length > 1) {
          const seen = new Set();
          const lines = [];
          for (const term of queryTerms(text)) {
            const part = memory.recallForPrompt({ botId, query: term, budgetChars: budget, topK });
            for (const line of String(part || '').split('\n')) {
              const key = line.trim();
              if (key === '' || key === '【长期记忆】' || seen.has(key)) continue;
              seen.add(key);
              lines.push(key);
            }
            if (lines.length >= topK) break;
          }
          recalled = lines.length === 0 ? '' : '【长期记忆】\n' + lines.slice(0, topK).join('\n');
        }
        out.memoryText = typeof recalled === 'string' ? recalled : formatMemoryRecall(recalled, budget);
      } else if (typeof memory.search === 'function') {
        const rows = searchWithFallback({ store: memory, botId, text, limit: topK });
        out.memoryText = formatMemoryRecall(rows, budget);
      }
    } catch {
      out.memoryText = '';
    }
  }

  if (cfg.kb && cfg.kb.enabled !== false && knowledge && typeof knowledge.search === 'function') {
    try {
      const topK = Number(cfg.kb.topK) > 0 ? Number(cfg.kb.topK) : DEFAULT_KB_ITEMS;
      const results = searchWithFallback({
        store: knowledge, botId, text, limit: topK,
        keyOf: (row) => (row && (row.docId || row.doc_id || row.id)) ?? (row && row.text ? row.text.slice(0, 40) : null),
      });
      out.knowledgeText = formatKnowledgeRecall(results, Number(cfg.kb.maxChars) || DEFAULT_KB_BUDGET, topK);
    } catch {
      out.knowledgeText = '';
    }
  }

  // 群友库：懒加载——只注入当前发言人 + 本条消息里被提到的人，绝不整库灌 prompt
  const memberCfg = isObj(cfg.members) ? cfg.members : {};
  if (memberCfg.enabled !== false && members && typeof members.list === 'function') {
    try {
      const maxPerTurn = Number(memberCfg.maxPerTurn) > 0 ? Math.min(6, Math.floor(Number(memberCfg.maxPerTurn))) : DEFAULT_MEMBER_MAX;
      const candidates = members.list({ botId, limit: DEFAULT_MEMBER_CANDIDATES });
      const list = Array.isArray(candidates) ? candidates : [];
      const ordered = [];
      const seen = new Set();
      const add = (item, isSender) => {
        if (!isObj(item) || seen.has(item.id)) return;
        seen.add(item.id);
        ordered.push({ item, isSender });
      };
      const sender = strOf(senderId) !== ''
        ? list.find((item) => strOf(item.openid) === strOf(senderId))
        : null;
      if (sender && memberCfg.injectSender !== false) add(sender, true);
      for (const row of resolveMentionedMembers(text, list, { limit: maxPerTurn })) add(row.member, false);
      const lines = ordered.slice(0, maxPerTurn).map((entry) => memberPromptLine(entry.item, { isSender: entry.isSender }));
      out.memberText = formatMemberRecall(lines, Number(memberCfg.maxChars) || DEFAULT_MEMBER_BUDGET);
    } catch {
      out.memberText = '';
    }
  }
  return out;
}
