/**
 * members/memory-backfill —— 升级后一次性把长期记忆里与群友相关的事实回填成群友备注。
 *
 * 背景：v0.16+ 才有群友库，老版本只把事实写在 MEMORY.md；升级后群友条目只有名字没有备注，
 * 看起来像「库里什么都没记」。这里在首次启动时做一次幂等回填：
 *   - 按成员昵称/别名匹配记忆事实（纯文本包含，宁缺毋滥）；
 *   - 每位成员最多取最近 N 条，用「- 事实」拼成备注；
 *   - 走 members.applyAutoNote：空正文写正文、自动正文可更新、人工备注只追加 meta.autoNotes；
 *   - 写 marker 文件（state 目录）保证只跑一次。
 */
import fs from 'node:fs';
import path from 'node:path';

const MARKER_NAME = 'memory-backfill-v1.json';
const MAX_FACTS_PER_MEMBER = 5;
const MAX_NOTE_CHARS = 480;
const MIN_NAME_LENGTH = 2;

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function pickTime(fact) {
  const raw = asString(fact && fact.at) || asString(fact && fact.date);
  return raw;
}

function writeMarker(file, payload) {
  if (file === '') return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    // marker 写失败只影响「是否重复」，不该影响主流程
  }
}

/**
 * @param {object} args
 * @param {object} args.memory 长期记忆 store（需 index()）
 * @param {object} args.members 群友库 store（需 list()/applyAutoNote()）
 * @param {string} args.stateDir 插件状态目录（marker 放这里）
 * @param {object} [args.logger]
 * @param {number} [args.maxPerMember]
 * @returns {{skipped?:boolean, reason?:string, updated?:number, matchedFacts?:number, total?:number}}
 */
export function backfillMemberNotesFromMemory({ memory, members, stateDir, logger, maxPerMember = MAX_FACTS_PER_MEMBER } = {}) {
  const log = logger || console;
  if (!memory || memory.available === false || typeof memory.index !== 'function') {
    return { skipped: true, reason: 'memory-unavailable' };
  }
  if (!members || members.available === false || typeof members.list !== 'function' || typeof members.applyAutoNote !== 'function') {
    return { skipped: true, reason: 'members-unavailable' };
  }
  const dir = asString(stateDir);
  const markerFile = dir === '' ? '' : path.join(dir, MARKER_NAME);
  if (markerFile !== '' && fs.existsSync(markerFile)) return { skipped: true, reason: 'already-done' };

  let facts = [];
  try {
    const index = memory.index();
    facts = Array.isArray(index && index.facts) ? index.facts : [];
  } catch (error) {
    log.warn?.('memory-backfill: 读取长期记忆失败: ' + (error && error.message ? error.message : String(error)));
    return { skipped: true, reason: 'index-failed' };
  }

  let items = [];
  try {
    const listed = members.list({ limit: 200 });
    items = listed && Array.isArray(listed.items) ? listed.items : [];
  } catch (error) {
    log.warn?.('memory-backfill: 读取群友库失败: ' + (error && error.message ? error.message : String(error)));
    return { skipped: true, reason: 'members-list-failed' };
  }

  let updated = 0;
  let matchedFacts = 0;
  const limit = Math.max(1, Number.isInteger(maxPerMember) ? maxPerMember : MAX_FACTS_PER_MEMBER);
  for (const item of items) {
    const names = [asString(item && item.name), ...(Array.isArray(item && item.aliases) ? item.aliases.map((alias) => asString(alias)) : [])]
      .map((name) => name.trim())
      .filter((name) => name.length >= MIN_NAME_LENGTH);
    if (names.length === 0) continue;
    const hits = facts.filter((fact) => {
      const text = asString(fact && fact.text);
      if (text === '') return false;
      return names.some((name) => text.includes(name));
    });
    if (hits.length === 0) continue;
    hits.sort((a, b) => pickTime(b).localeCompare(pickTime(a)));
    const picked = hits.slice(0, limit);
    const note = picked
      .map((fact) => asString(fact.text).trim().replace(/^[-•·]\s*/, ''))
      .filter((text) => text !== '')
      .join('；')
      .slice(0, MAX_NOTE_CHARS);
    if (note === '') continue;
    try {
      const result = members.applyAutoNote({
        id: asString(item.id),
        note: note,
        tags: [],
        confidence: 0.9,
        at: new Date().toISOString(),
      });
      if (result && result.ok === true && result.mode !== 'skipped') {
        updated += 1;
        matchedFacts += picked.length;
      }
    } catch (error) {
      log.warn?.('memory-backfill: 写入群友备注失败 ' + asString(item.id) + ': ' + (error && error.message ? error.message : String(error)));
    }
  }

  writeMarker(markerFile, {
    at: new Date().toISOString(),
    updated,
    matchedFacts,
    totalMembers: items.length,
    totalFacts: facts.length,
  });
  return { updated, matchedFacts, total: items.length };
}

export default backfillMemberNotesFromMemory;
