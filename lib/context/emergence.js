/**
 * context/emergence —— “必要时涌现”：按当前这一轮消息，从记忆 / 知识库 / 群友库里
 * 只挑相关的内容拼成一小段背景，交给 prompt 的 recall 段注入。
 *
 * 设计约束：
 * - 纯同步、只读：prompt 组装阶段调用，不能阻塞、不能抛错；
 * - 三个来源都可能缺失（模块未加载/被用户关闭），任何一路失败只跳过该路；
 * - 输出有硬上限（条数 + 字符数），避免把 prompt 撑爆；无相关内容时返回空串，不注入。
 * - 只做“提示”，不替模型下结论：文本里明确写“仅供参考”。
 */
import { resolveMentionedMembers, memberPromptLine } from '../members/mention.js';

const MAX_BLOCK_CHARS = 4000;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOf = (v) => (typeof v === 'string' ? v.trim() : '');

/** 按码点安全截断。 */
function clamp(text, max) {
  if (!Number.isFinite(max) || max <= 0) return '';
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return [...s].slice(0, max).join('') + '…';
}

/** openid 短码（隐私友好；prompt 里不需要完整 openid）。 */
export function shortId(openid) {
  const raw = strOf(openid);
  if (raw === '') return '';
  return raw.length <= 10 ? raw : raw.slice(0, 8) + '…';
}

/** 从条目里取一段最适合放进 prompt 的摘要文本。 */
function summaryOf(entry) {
  const body = strOf(entry && entry.body) || strOf(entry && entry.notes) || strOf(entry && entry.snippet);
  const firstLine = body.split('\n').map((line) => line.trim()).find((line) => line !== '') || '';
  return firstLine;
}

/**
 * @param {object} options
 * @param {object} options.settings settings store
 * @param {object} [options.memory] createMemoryStore 返回值
 * @param {object} [options.knowledge] createKnowledgeStore 返回值
 * @param {object} [options.members] createMemberStore 返回值
 * @param {object} [options.logger]
 */
export function createEmergence({ settings, memory, knowledge, members, logger } = {}) {
  const log = logger || console;

  function cfg() {
    try {
      const value = typeof settings?.get === 'function' ? settings.get() : {};
      return isObj(value) ? value : {};
    } catch (err) {
      log.warn?.('[emergence] 读取设置失败: ' + (err && err.message));
      return {};
    }
  }

  function safe(fn, fallback) {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch (err) {
      log.warn?.('[emergence] 检索失败: ' + (err && err.message));
      return fallback;
    }
  }

  /**
   * 取本轮相关背景。
   * @param {object} turn {text, scope, groupId, senderId, senderName}
   * @returns {{text:string, counts:{memory:number,knowledge:number,members:number},
   *   items:Array<{kind:string,id:string,title:string,score:number}>}}
   */
  function recallForTurn(turn) {
    const empty = { text: '', counts: { memory: 0, knowledge: 0, members: 0 }, items: [] };
    const t = isObj(turn) ? turn : {};
    const query = strOf(t.text);
    if (query === '') return empty;
    const c = cfg();
    const scope = t.scope === 'c2c' || t.scope === 'direct' ? 'c2c' : (t.scope === 'group' ? 'group' : '');
    const groupId = scope === 'group' ? strOf(t.groupId) : '';
    const senderId = strOf(t.senderId);
    const senderName = strOf(t.senderName);

    const items = [];
    const blocks = [];
    const counts = { memory: 0, knowledge: 0, members: 0 };

    // ── 1. 群友库：懒加载——只注入当前发言人 + 本条消息里被提到的成员 ──
    // 不把整个群友库塞进 prompt：先按昵称/别名/常见称呼做提及匹配，再补最多几条相关成员。
    const memberCfg = isObj(c.members) ? c.members : {};
    const memberMax = Math.max(1, Math.min(6, Math.round(Number(memberCfg.maxPerTurn) || 3)));
    if (memberCfg.enabled !== false && memberMax > 0 && members && typeof members.list === 'function') {
      const candidates = safe(() => members.list({ groupId: groupId, limit: 200 }).items, []);
      const ordered = [];
      const seenIds = new Set();
      const add = (item, isSender) => {
        if (!isObj(item) || strOf(item.id) === '' || seenIds.has(item.id)) return;
        seenIds.add(item.id);
        ordered.push({ item: item, isSender: isSender === true });
      };
      // 发言人本人（最相关）
      const sender = (Array.isArray(candidates) ? candidates : []).find((item) => {
        if (!isObj(item)) return false;
        const openid = strOf(item.openid) || strOf(item.meta && item.meta.openid);
        return senderId !== '' && openid === senderId;
      });
      add(sender, true);
      // 本条消息里明确提到的群友
      for (const row of resolveMentionedMembers(query, candidates, { limit: memberMax })) add(row.member, false);
      // 再补按文本相关度召回的人（仍限当前群）
      const matched = safe(() => members.list({ q: query, groupId: groupId, limit: memberMax }).items, []);
      for (const item of Array.isArray(matched) ? matched : []) add(item, false);

      const lines = [];
      for (const entry of ordered) {
        if (counts.members >= memberMax) break;
        lines.push(memberPromptLine(entry.item, { isSender: entry.isSender }));
        items.push({ kind: 'member', id: strOf(entry.item.id), title: strOf(entry.item.name) || strOf(entry.item.title), score: entry.isSender ? 100 : 10 });
        counts.members += 1;
      }
      if (lines.length > 0) blocks.push('【群友】\n' + lines.join('\n'));
    }

    // ── 2. 知识库：当前群 + 全局相关条目 ──
    const knowledgeCfg = isObj(c.knowledge) ? c.knowledge : {};
    if (knowledgeCfg.enabled !== false && knowledgeCfg.maxPerTurn > 0 && knowledge && typeof knowledge.recall === 'function') {
      const rows = safe(() => knowledge.recall({
        query: query,
        scope: scope || 'group',
        groupId: groupId,
        limit: Math.max(1, Math.min(10, Math.round(Number(knowledgeCfg.maxPerTurn) || 4))),
      }), []);
      const lines = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row) continue;
        const title = strOf(row.title) || '(无标题)';
        const body = summaryOf(row);
        lines.push('- 知识《' + title + '》' + (body !== '' ? '：' + clamp(body, 200) : ''));
        items.push({ kind: 'knowledge', id: strOf(row.id), title: title, score: Number(row.score) || 0 });
        counts.knowledge += 1;
        if (counts.knowledge >= Math.max(1, Number(knowledgeCfg.maxPerTurn) || 4)) break;
      }
      if (lines.length > 0) blocks.push('【知识】\n' + lines.join('\n'));
    }

    // ── 3. 长期记忆：相关事实 ──
    const recallCfg = isObj(c.memory) && isObj(c.memory.recall) ? c.memory.recall : {};
    if (c.memory && c.memory.enabled !== false && recallCfg.enabled !== false
      && memory && typeof memory.recall === 'function') {
      const rows = safe(() => memory.recall(query, {
        limit: Math.max(1, Math.min(20, Math.round(Number(recallCfg.maxItems) || 6))),
        groupId: groupId,
      }), []);
      const lines = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row) continue;
        const text = strOf(row.text);
        if (text === '') continue;
        lines.push('- ' + clamp(text, 260));
        items.push({ kind: 'memory', id: '', title: clamp(text, 40), score: Number(row.score) || 0 });
        counts.memory += 1;
        if (counts.memory >= Math.max(1, Number(recallCfg.maxItems) || 6)) break;
      }
      if (lines.length > 0) blocks.push('【记忆】\n' + lines.join('\n'));
    }

    if (blocks.length === 0) return { text: '', counts: counts, items: items };

    const header = '【本轮相关背景】下面是从记忆/知识库/群友库里按当前这句话检索到的内容，'
      + '仅供参考：和当前话题无关就忽略，不要主动复述来源，也不要把它当成用户刚说的话。';
    const budget = MAX_BLOCK_CHARS;
    let text = header + '\n' + blocks.join('\n');
    if (text.length > budget) text = text.slice(0, budget) + '…';
    return { text: text, counts: counts, items: items };
  }

  return {
    recallForTurn: recallForTurn,
    /** 设置页「立即预览」用：同一套检索，但返回结构化产物。 */
    preview: recallForTurn,
  };
}

export default createEmergence;
