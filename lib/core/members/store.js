/**
 * core/members/store —— 群友库（bot 级，按 (bot_id, openid) 唯一）。
 *
 * 职责：
 * - upsert：以 openid 为自然键合并写入；nickname/note/profile 的“空值”不会冲掉已有值
 *   （QQ 侧经常只拿到 openid 或昵称，不能把人工备注抹掉）；note 上限 2000 字；
 * - list/search：按 bot 隔离，支持昵称/备注 LIKE 检索（ESCAPE '!' 防止 % _ 被当通配符）；
 * - get/remove/count：控制台管理面使用。
 */
import { all, get, run } from '../db.js';

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
/** 备注长度上限（控制台语义）。 */
const MAX_NOTE = 2000;
const MAX_NICKNAME = 80;
const MAX_OPENID = 128;

const MEMBER_COLUMNS = `
  id,
  bot_id AS botId,
  openid,
  nickname,
  note,
  profile_json AS profileJson,
  updated_at AS updatedAt
`;

/** 必填 botId。 */
function requireBotId(botId) {
  const value = String(botId === undefined || botId === null ? '' : botId).trim();
  if (value === '') throw new TypeError('members store: botId 不能为空');
  return value;
}

/** 必填 openid。 */
function requireOpenid(openid) {
  const value = String(openid === undefined || openid === null ? '' : openid).trim();
  if (value === '') throw new TypeError('members store: openid 不能为空');
  if (value.length > MAX_OPENID) throw new TypeError('members store: openid 过长');
  return value;
}

/** 正整数 id；非法返回 null。 */
function toId(id) {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

/** 文本归一化：undefined/null/空白 一律视为“未提供”（合并时保留旧值）。 */
function cleanText(value, max) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (text === '') return undefined;
  return text.slice(0, max);
}

/** JSON 对象解析；非对象返回 null。 */
function parseObject(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 入参 profile/profileJson → 对象 | null（清空）| undefined（未提供）。 */
function parseProfile(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return parseObject(value);
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    botId: row.botId,
    openid: row.openid,
    nickname: row.nickname === undefined ? null : row.nickname,
    note: row.note === undefined ? null : row.note,
    profileJson: parseObject(row.profileJson),
    updatedAt: Number(row.updatedAt) || 0,
  };
}

/**
 * 创建群友库 store。
 * @param {{db: import('node:sqlite').DatabaseSync, now?: () => number}} options
 */
export function createMembersStore({ db, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createMembersStore: 需要由 lib/core/db.js 的 openDb() 打开的 db');
  }

  function getByOpenid(botId, openid) {
    return mapRow(get(db, 'SELECT ' + MEMBER_COLUMNS + ' FROM members WHERE bot_id = ? AND openid = ?', botId, openid));
  }

  function getById(botId, id) {
    return mapRow(get(db, 'SELECT ' + MEMBER_COLUMNS + ' FROM members WHERE bot_id = ? AND id = ?', botId, id));
  }

  /** 合并规则：新值非空才覆盖；profile 对象浅合并，显式 null/'' 清空。 */
  function mergeFields(existing, input) {
    const nickname = cleanText(input.nickname, MAX_NICKNAME);
    const note = cleanText(input.note, MAX_NOTE);
    const profile = parseProfile(input.profileJson !== undefined ? input.profileJson : input.profile);
    const next = {
      nickname: nickname !== undefined ? nickname : existing.nickname,
      note: note !== undefined ? note : existing.note,
      profileJson: existing.profileJson,
    };
    if (profile === null) {
      next.profileJson = null;
    } else if (profile !== undefined) {
      const base = existing.profileJson && typeof existing.profileJson === 'object' ? existing.profileJson : {};
      next.profileJson = { ...base, ...profile };
    }
    return next;
  }

  /**
   * 按 (botId, openid) 合并写入。
   * @returns 成员实体 + {created:boolean}
   */
  function upsert(input = {}) {
    const botId = requireBotId(input.botId);
    const openid = requireOpenid(input.openid);
    const existing = getByOpenid(botId, openid);
    const stamp = now();
    if (!existing) {
      const nickname = cleanText(input.nickname, MAX_NICKNAME);
      const note = cleanText(input.note, MAX_NOTE);
      const profile = parseProfile(input.profileJson !== undefined ? input.profileJson : input.profile);
      run(db,
        'INSERT INTO members(bot_id, openid, nickname, note, profile_json, updated_at) VALUES(?,?,?,?,?,?)',
        botId, openid,
        nickname === undefined ? null : nickname,
        note === undefined ? null : note,
        profile === undefined || profile === null ? null : JSON.stringify(profile),
        stamp);
      return { ...getByOpenid(botId, openid), created: true };
    }
    const next = mergeFields(existing, input);
    run(db,
      'UPDATE members SET nickname = ?, note = ?, profile_json = ?, updated_at = ? WHERE bot_id = ? AND openid = ?',
      next.nickname === undefined ? null : next.nickname,
      next.note === undefined ? null : next.note,
      next.profileJson === null ? null : JSON.stringify(next.profileJson),
      stamp, botId, openid);
    return { ...getByOpenid(botId, openid), created: false };
  }

  /** 按 id 更新（控制台 PATCH）：字段合并规则同 upsert，找不到返回 null。 */
  function update(input = {}) {
    const botId = requireBotId(input.botId);
    const id = toId(input.id);
    if (id === null) throw new TypeError('members store: id 非法');
    const existing = getById(botId, id);
    if (!existing) return null;
    const next = mergeFields(existing, input);
    run(db,
      'UPDATE members SET nickname = ?, note = ?, profile_json = ?, updated_at = ? WHERE id = ? AND bot_id = ?',
      next.nickname === undefined ? null : next.nickname,
      next.note === undefined ? null : next.note,
      next.profileJson === null ? null : JSON.stringify(next.profileJson),
      now(), id, botId);
    return getById(botId, id);
  }

  /** LIKE 模式转义（ESCAPE '!'）。 */
  function likePattern(text) {
    const escaped = String(text).replace(/[!%_]/g, (ch) => '!' + ch);
    return '%' + escaped + '%';
  }

  /** 列表；query 命中 nickname 或 note。 */
  function list({ botId, limit = DEFAULT_LIST_LIMIT, offset = 0, query = '' } = {}) {
    const owner = requireBotId(botId);
    const size = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(Number(limit)) || DEFAULT_LIST_LIMIT));
    const skip = Math.max(0, Math.floor(Number(offset)) || 0);
    const keyword = String(query === undefined || query === null ? '' : query).trim();
    const rows = keyword === ''
      ? all(db, 'SELECT ' + MEMBER_COLUMNS + ' FROM members WHERE bot_id = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?', owner, size, skip)
      : all(db,
        'SELECT ' + MEMBER_COLUMNS + ' FROM members WHERE bot_id = ? AND (nickname LIKE ? ESCAPE \'!\' OR note LIKE ? ESCAPE \'!\') ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?',
        owner, likePattern(keyword), likePattern(keyword), size, skip);
    return rows.map(mapRow);
  }

  /** 按 id 或 openid 取单个成员。 */
  function getMember(selector = {}) {
    const botId = requireBotId(selector.botId);
    if (selector.id !== undefined) {
      const id = toId(selector.id);
      return id === null ? null : getById(botId, id);
    }
    if (selector.openid !== undefined) return getByOpenid(botId, requireOpenid(selector.openid));
    return null;
  }

  /** 删除；返回 {removed,id}。 */
  function remove({ botId, id } = {}) {
    const owner = requireBotId(botId);
    const target = toId(id);
    if (target === null) return { removed: false, id: null };
    const result = run(db, 'DELETE FROM members WHERE id = ? AND bot_id = ?', target, owner);
    return { removed: Number(result && result.changes ? result.changes : 0) > 0, id: target };
  }

  /** 该 bot 的群友数。 */
  function count({ botId } = {}) {
    const owner = requireBotId(botId);
    const row = get(db, 'SELECT COUNT(*) AS count FROM members WHERE bot_id = ?', owner);
    return Number(row && row.count ? row.count : 0);
  }

  return { upsert, update, list, search: list, get: getMember, remove, count };
}
