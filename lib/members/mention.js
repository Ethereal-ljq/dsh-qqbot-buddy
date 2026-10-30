/**
 * members/mention —— 群友提及匹配（懒加载用）。
 *
 * 只做纯计算：把「当前这条消息里出现了哪些群友的昵称/别名/常见称呼」解析出来，
 * 供 prompt 只加载被提到的人，而不是把所有群友画像塞进上下文。
 */
const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const strOf = (value) => (typeof value === 'string' ? value.trim() : '');

export function normalizeMentionText(text) {
  return strOf(text).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** 成员可被提及的所有称呼（昵称/别名/画像里的常见称呼）。 */
export function aliasesOf(member) {
  const item = isObj(member) ? member : {};
  const profile = isObj(item.profile) ? item.profile : {};
  const list = [
    strOf(item.name),
    strOf(item.title),
    ...(Array.isArray(item.aliases) ? item.aliases.map(strOf) : []),
    ...(Array.isArray(profile.nicknames) ? profile.nicknames.map(strOf) : []),
  ];
  const seen = new Set();
  const out = [];
  for (const alias of list) {
    if (alias.length < 2) continue;
    const key = normalizeMentionText(alias);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

/**
 * 从文本里解析被提到的成员（最长匹配优先，避免「老周」命中「老周年」这类）。
 * @param {string} text
 * @param {Array<object>} members memberStore.list().items 或 recall 结果
 * @param {{limit?:number}} [options]
 * @returns {Array<{member:object, alias:string, at:number}>}
 */
export function resolveMentionedMembers(text, members, options = {}) {
  const normalizedText = normalizeMentionText(text);
  if (normalizedText === '') return [];
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 3;
  const rows = [];
  for (const member of Array.isArray(members) ? members : []) {
    if (!isObj(member)) continue;
    const aliases = aliasesOf(member);
    let best = null;
    for (const alias of aliases) {
      const key = normalizeMentionText(alias);
      const at = normalizedText.indexOf(key);
      if (at < 0) continue;
      if (best === null || key.length > best.alias.length) best = { alias: alias, at: at };
    }
    if (best !== null) rows.push({ member: member, alias: best.alias, at: best.at });
  }
  rows.sort((a, b) => b.alias.length - a.alias.length || a.at - b.at);
  return rows.slice(0, limit);
}

/** 画像 → 给 prompt 的一行摘要（懒加载时每个被提到的人一行，严格控制长度）。 */
export function memberPromptLine(member, options = {}) {
  const item = isObj(member) ? member : {};
  const profile = isObj(item.profile) ? item.profile : {};
  const name = strOf(item.name) || strOf(item.title) || '群友';
  const nicknames = Array.isArray(profile.nicknames) ? profile.nicknames.filter((value) => strOf(value) !== '').slice(0, 4) : [];
  const personality = Array.isArray(profile.personality) ? profile.personality.filter((value) => strOf(value) !== '').slice(0, 3) : [];
  const deeds = Array.isArray(profile.deeds) ? profile.deeds.filter((value) => strOf(value) !== '').slice(0, 3) : [];
  const affinity = isObj(profile.affinity) ? profile.affinity : {};
  const level = Number.isFinite(Number(affinity.level)) ? Math.max(-2, Math.min(2, Math.round(Number(affinity.level)))) : 0;
  const affinityLabel = ['警惕', '一般', '普通', '亲近', '很亲近'][level + 2];
  const bits = [];
  if (nicknames.length > 0) bits.push('称呼 ' + nicknames.join('、'));
  if (personality.length > 0) bits.push('性格 ' + personality.join('、'));
  if (deeds.length > 0) bits.push('事迹 ' + deeds.join('；'));
  if (level !== 0 || strOf(affinity.note) !== '') {
    bits.push('关系 ' + affinityLabel + (strOf(affinity.note) !== '' ? '（' + strOf(affinity.note).slice(0, 40) + '）' : ''));
  }
  if (options.isSender === true) bits.push('就是当前发言人');
  return '- 群友 ' + name + (bits.length > 0 ? '：' + bits.join('；') : '');
}

export default { normalizeMentionText, aliasesOf, resolveMentionedMembers, memberPromptLine };
