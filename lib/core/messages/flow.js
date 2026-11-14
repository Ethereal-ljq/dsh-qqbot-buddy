/**
 * core/messages/flow —— 全量群消息流水（L0-flow）。
 *
 * 与 messages 的区别：
 *   - messages：只记「触发回复的那条 + 助手回复」，供记忆提炼/历史检索；
 *   - flow_messages：记群里「每条消息」（含没 @ bot 的旁观发言），供群分析/日报/关系提取。
 *
 * 约定：
 * - (bot_id, peer, message_id) 幂等：QQ 会重推，重复写不能产生重复行（空 messageId 不去重）；
 * - 只存文本，附件只留占位行（图片/语音由 qq/inbound 的组装逻辑生成）；
 * - 正文上限与 messages 一致（8000 码点），防止超长转发撑爆库；
 * - 保留期由 settings.messages.flowRetainDays 控制（默认 14 天），由 message-cleaner 清理。
 */
import { all, get, run } from '../db.js';

/** 单条正文上限（码点），与 messages store 保持一致。 */
export const MAX_CONTENT_CHARS = 8000;
/** 默认保留天数：两周。 */
export const DEFAULT_RETAIN_DAYS = 14;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

const COLUMNS = `
  id,
  bot_id AS botId,
  peer,
  message_id AS messageId,
  sender_id AS senderId,
  sender_name AS senderName,
  msg_type AS msgType,
  content,
  created_at AS createdAt
`;

/** 必填 botId。 */
function requireBotId(botId) {
  const value = String(botId === undefined || botId === null ? '' : botId).trim();
  if (value === '') throw new TypeError('flow store: botId 不能为空');
  return value;
}

/** 必填 peer（'group:xxx'）。 */
function requirePeer(peer) {
  const value = String(peer === undefined || peer === null ? '' : peer).trim();
  if (value === '') throw new TypeError('flow store: peer 不能为空');
  return value;
}

/** 文本裁剪：超长按码点截断。 */
function clip(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value === '') return '';
  const chars = Array.from(value);
  return chars.length <= MAX_CONTENT_CHARS ? value : chars.slice(0, MAX_CONTENT_CHARS).join('');
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    botId: row.botId,
    peer: row.peer,
    messageId: row.messageId || '',
    senderId: row.senderId || '',
    senderName: row.senderName || '',
    msgType: Number(row.msgType) || 0,
    content: row.content || '',
    createdAt: Number(row.createdAt) || 0,
  };
}

/**
 * 创建全量群消息流水 store。
 * @param {{db: import('node:sqlite').DatabaseSync, now?: () => number}} options
 */
export function createFlowStore({ db, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createFlowStore: 需要由 lib/core/db.js 的 openDb() 打开的 db');
  }

  /**
   * 追加一条群消息。
   * @returns {{ok:boolean, created?:boolean, reason?:string}}
   */
  function append(input = {}) {
    const botId = requireBotId(input.botId);
    const peer = requirePeer(input.peer);
    const content = clip(input.content);
    if (content.trim() === '') return { ok: false, reason: 'empty' };
    const createdAt = Number.isFinite(Number(input.createdAt)) && Number(input.createdAt) > 0
      ? Math.floor(Number(input.createdAt))
      : now();
    const info = run(db,
      'INSERT OR IGNORE INTO flow_messages(bot_id, peer, message_id, sender_id, sender_name, msg_type, content, created_at)'
      + ' VALUES(?,?,?,?,?,?,?,?)',
      botId, peer,
      String(input.messageId ?? ''),
      String(input.senderId ?? ''),
      String(input.senderName ?? ''),
      Number(input.msgType) || 0,
      content,
      createdAt);
    return { ok: true, created: Number(info && info.changes ? info.changes : 0) > 0 };
  }

  /**
   * 按时间正序取一段流水（分析/日报用）。
   * @param {{botId:string, peer:string, since?:number, until?:number, limit?:number, offset?:number}} input
   */
  function list(input = {}) {
    const botId = requireBotId(input.botId);
    const peer = requirePeer(input.peer);
    const limit = clampInt(input.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const offset = Math.max(0, clampInt(input.offset, 0, 0, 1e9));
    const since = Number(input.since) > 0 ? Math.floor(Number(input.since)) : 0;
    const until = Number(input.until) > 0 ? Math.floor(Number(input.until)) : 0;
    const clauses = ['bot_id = ?', 'peer = ?'];
    const params = [botId, peer];
    if (since > 0) { clauses.push('created_at >= ?'); params.push(since); }
    if (until > 0) { clauses.push('created_at <= ?'); params.push(until); }
    params.push(limit, offset);
    return all(db,
      'SELECT ' + COLUMNS + ' FROM flow_messages WHERE ' + clauses.join(' AND ')
      + ' ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?',
      ...params).map(mapRow);
  }

  /** 最近 N 条（时间正序返回，便于直接拼上下文）。 */
  function recent(input = {}) {
    const botId = requireBotId(input.botId);
    const peer = requirePeer(input.peer);
    const limit = clampInt(input.limit, 50, 1, MAX_LIST_LIMIT);
    return all(db,
      'SELECT ' + COLUMNS + ' FROM flow_messages WHERE bot_id = ? AND peer = ?'
      + ' ORDER BY created_at DESC, id DESC LIMIT ?',
      botId, peer, limit).map(mapRow).reverse();
  }

  /** 条数与时间范围。 */
  function stats(input = {}) {
    const botId = requireBotId(input.botId);
    const peer = requirePeer(input.peer);
    const row = get(db,
      'SELECT COUNT(*) AS count, MIN(created_at) AS first, MAX(created_at) AS last'
      + ' FROM flow_messages WHERE bot_id = ? AND peer = ?',
      botId, peer);
    return {
      count: Number(row && row.count ? row.count : 0),
      first: Number(row && row.first ? row.first : 0),
      last: Number(row && row.last ? row.last : 0),
    };
  }

  /** 去重后的 peer 列表（分析/日报发现“最近活跃的群”用）。 */
  function peers({ botId, since = 0, limit = 200 } = {}) {
    const owner = requireBotId(botId);
    const from = Number(since) > 0 ? Math.floor(Number(since)) : 0;
    const size = clampInt(limit, 200, 1, 1000);
    const rows = from > 0
      ? all(db, 'SELECT peer, MAX(created_at) AS last FROM flow_messages WHERE bot_id = ? AND created_at >= ? GROUP BY peer ORDER BY last DESC LIMIT ?', owner, from, size)
      : all(db, 'SELECT peer, MAX(created_at) AS last FROM flow_messages WHERE bot_id = ? GROUP BY peer ORDER BY last DESC LIMIT ?', owner, size);
    return rows.map((row) => ({ peer: row.peer, last: Number(row.last) || 0 }));
  }

  /** 该 bot 的流水总条数（可选按 peer）。 */
  function count({ botId, peer = '' } = {}) {
    const owner = requireBotId(botId);
    const key = String(peer || '').trim();
    const row = key === ''
      ? get(db, 'SELECT COUNT(*) AS count FROM flow_messages WHERE bot_id = ?', owner)
      : get(db, 'SELECT COUNT(*) AS count FROM flow_messages WHERE bot_id = ? AND peer = ?', owner, key);
    return Number(row && row.count ? row.count : 0);
  }

  /** 删除早于 cutoff 的行；返回删除条数。 */
  function purgeBefore(cutoff) {
    const at = Number(cutoff);
    if (!Number.isFinite(at) || at <= 0) return { removed: 0, cutoff: 0 };
    const info = run(db, 'DELETE FROM flow_messages WHERE created_at < ?', Math.floor(at));
    return { removed: Number(info && info.changes ? info.changes : 0), cutoff: Math.floor(at) };
  }

  /** 按保留天数清理旧流水。 */
  function cleanup({ retainDays = DEFAULT_RETAIN_DAYS } = {}) {
    const days = clampInt(retainDays, DEFAULT_RETAIN_DAYS, 0, 3650);
    if (days <= 0) return { removed: 0, cutoff: 0 };
    const cutoff = now() - days * 24 * 60 * 60 * 1000;
    return purgeBefore(cutoff);
  }

  return { append, list, recent, peers, stats, count, purgeBefore, cleanup };
}

export default createFlowStore;
