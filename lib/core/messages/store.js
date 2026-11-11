/**
 * core/messages/store —— 消息流水（L0）的写入 / 检索 / 清理。
 *
 * 为什么需要：
 *   SDK 的 historyBuffer 只把最近 20 条放在内存里，进程一重启就没了，模型也看不到
 *   更早的对话。记忆提炼器同样拿不到足够素材（实测 auto-collect 长期 0 入库）。
 *   这里把每条消息落 SQLite，作为「原始层」：
 *     L0 messages  ← 本模块（原始流水，默认保留 14 天）
 *     L1 memories  ← 从 L0 提炼出的稳定事实
 *
 * 设计：
 * - (bot_id, message_id) 唯一：QQ 会重推事件，重复写入必须幂等（INSERT OR IGNORE）；
 * - peer 与 memories.peer 同构（'group:xxx' / 'c2c:xxx'），便于按会话检索；
 * - 全文检索复用 kb/text-search.js 的约定：<3 字符走 LIKE，≥3 字符走 FTS5 trigram；
 * - 只存文本，不存附件二进制（附件在 media 目录，由 media-cleaner 单独管）。
 */
import { all, get, run } from '../db.js';
import {
  FTS_MIN_CHARS,
  MODE_FTS,
  MODE_LIKE,
  buildSnippet,
  charLength,
  ftsPhrase,
  likePattern,
  normalizeQuery,
  shouldFallbackLike,
} from '../kb/text-search.js';

export { FTS_MIN_CHARS, MODE_FTS, MODE_LIKE };

/** 单条消息内容上限（码点）：防止超长转发把库撑爆。 */
export const MAX_CONTENT_CHARS = 8000;
/** 默认保留天数：两周。 */
export const DEFAULT_RETAIN_DAYS = 14;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const LIKE_SCAN_LIMIT = 500;

/** 行 -> 实体 的列清单（无表别名，单表查询用）。 */
const MESSAGE_COLUMNS = `
  id,
  bot_id AS botId,
  peer,
  scope,
  sender_id AS senderId,
  sender_name AS senderName,
  role,
  content,
  msg_type AS msgType,
  message_id AS messageId,
  created_at AS createdAt
`;

/** 同上，但带 m. 表别名（JOIN FTS 时用）。 */
const MESSAGE_COLUMNS_M = `
  m.id AS id,
  m.bot_id AS botId,
  m.peer AS peer,
  m.scope AS scope,
  m.sender_id AS senderId,
  m.sender_name AS senderName,
  m.role AS role,
  m.content AS content,
  m.msg_type AS msgType,
  m.message_id AS messageId,
  m.created_at AS createdAt
`;

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function requireBotId(botId) {
  const value = String(botId ?? '').trim();
  if (value === '') throw new TypeError('messages store: botId 不能为空');
  return value;
}

function clipContent(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text === '') return '';
  const chars = Array.from(text);
  return chars.length <= MAX_CONTENT_CHARS ? text : chars.slice(0, MAX_CONTENT_CHARS).join('');
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    botId: row.botId,
    peer: row.peer,
    scope: row.scope,
    senderId: row.senderId,
    senderName: row.senderName,
    role: row.role,
    content: row.content,
    msgType: Number(row.msgType) || 0,
    messageId: row.messageId,
    createdAt: Number(row.createdAt) || 0,
  };
}

/**
 * 创建消息流水 store。
 * @param {{db: import('node:sqlite').DatabaseSync, now?: () => number}} options
 */
export function createMessagesStore({ db, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createMessagesStore: 需要由 lib/core/db.js 的 openDb() 打开的 db');
  }
  const clock = typeof now === 'function' ? now : Date.now;

  /**
   * 写入一条消息（幂等）。
   * @returns {{id:number, created:boolean}}
   */
  function save(input = {}) {
    const botId = requireBotId(input.botId);
    const messageId = String(input.messageId ?? '').trim();
    const peer = String(input.peer ?? '').trim();
    if (peer === '') throw new TypeError('messages store: peer 不能为空');
    const content = clipContent(input.content);
    const stamp = Number(input.createdAt) > 0 ? Number(input.createdAt) : clock();

    // messageId 为空时无法幂等去重（部分事件没有 id），退化成普通插入
    if (messageId === '') {
      const info = run(db,
        'INSERT INTO messages(bot_id, peer, scope, sender_id, sender_name, role, content, msg_type, message_id, created_at)'
        + ' VALUES(?,?,?,?,?,?,?,?,?,?)',
        botId, peer, String(input.scope ?? ''), String(input.senderId ?? ''),
        String(input.senderName ?? ''), String(input.role ?? 'user'), content,
        Number(input.msgType) || 0, '', stamp);
      return { id: Number(info.lastInsertRowid), created: true };
    }

    const existing = get(db, 'SELECT id FROM messages WHERE bot_id = ? AND message_id = ?', botId, messageId);
    if (existing) return { id: Number(existing.id), created: false };
    const info = run(db,
      'INSERT INTO messages(bot_id, peer, scope, sender_id, sender_name, role, content, msg_type, message_id, created_at)'
      + ' VALUES(?,?,?,?,?,?,?,?,?,?)',
      botId, peer, String(input.scope ?? ''), String(input.senderId ?? ''),
      String(input.senderName ?? ''), String(input.role ?? 'user'), content,
      Number(input.msgType) || 0, messageId, stamp);
    return { id: Number(info.lastInsertRowid), created: true };
  }

  /**
   * 检索消息。
   * @param {object} input
   * @param {string} input.botId
   * @param {string} [input.peer] 限定会话；空=跨会话
   * @param {string} [input.query] 关键词；空=按时间倒序列出
   * @param {string} [input.senderId] 限定发言人
   * @param {number} [input.limit]
   * @param {number} [input.since] 起始时间戳（含）
   * @returns {Array<object>}
   */
  function search(input = {}) {
    const botId = requireBotId(input.botId);
    const peer = String(input.peer ?? '').trim();
    const senderId = String(input.senderId ?? '').trim();
    const limit = clampInt(input.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const since = Number(input.since) > 0 ? Number(input.since) : 0;
    const keyword = normalizeQuery(input.query);

    const filters = ['m.bot_id = ?'];
    const params = [botId];
    if (peer !== '') { filters.push('m.peer = ?'); params.push(peer); }
    if (senderId !== '') { filters.push('m.sender_id = ?'); params.push(senderId); }
    if (since > 0) { filters.push('m.created_at >= ?'); params.push(since); }
    const where = filters.join(' AND ');

    if (keyword === '') {
      return all(db,
        'SELECT ' + MESSAGE_COLUMNS_M + ' FROM messages m WHERE ' + where + ' ORDER BY m.created_at DESC LIMIT ?',
        ...params, limit).map(mapRow);
    }

    // <3 字符：trigram FTS 无法命中，退回 LIKE
    if (shouldFallbackLike(keyword)) {
      const rows = all(db,
        'SELECT ' + MESSAGE_COLUMNS_M
        + ' FROM messages m WHERE ' + where + " AND m.content LIKE ? ESCAPE '!'"
        + ' ORDER BY m.created_at DESC LIMIT ?',
        ...params, likePattern(keyword), Math.min(limit, LIKE_SCAN_LIMIT)).map(mapRow);
      return rows.map((row) => ({ ...row, mode: MODE_LIKE, snippet: buildSnippet(row.content, keyword) }));
    }

    // ≥3 字符：FTS5 trigram + bm25
    const ftsRows = all(db,
      'SELECT ' + MESSAGE_COLUMNS_M
      + ', bm25(messages_fts) AS rank'
      + ' FROM messages m JOIN messages_fts ON messages_fts.rowid = m.id'
      + ' WHERE ' + where + ' AND messages_fts MATCH ?'
      + ' ORDER BY rank LIMIT ?',
      ...params, ftsPhrase(keyword), limit).map(mapRow);
    if (ftsRows.length > 0) {
      return ftsRows.map((row) => {
        const { rank, ...rest } = row;
        return { ...rest, mode: MODE_FTS, snippet: buildSnippet(rest.content, keyword) };
      });
    }
    // FTS 有结果集为空时也兜一层 LIKE（分词不匹配但字面存在）
    const rows = all(db,
      'SELECT ' + MESSAGE_COLUMNS_M
      + ' FROM messages m WHERE ' + where + " AND m.content LIKE ? ESCAPE '!'"
      + ' ORDER BY m.created_at DESC LIMIT ?',
      ...params, likePattern(keyword), limit).map(mapRow);
    return rows.map((row) => ({ ...row, mode: MODE_LIKE, snippet: buildSnippet(row.content, keyword) }));
  }

  /** 按会话列最近消息（时间倒序）。 */
  function list(input = {}) {
    return search({ ...input, query: '' });
  }

  /** 某个 peer 在时间窗口内的转录文本（记忆提炼用）。 */
  function transcript(input = {}) {
    const botId = requireBotId(input.botId);
    const peer = String(input.peer ?? '').trim();
    if (peer === '') return '';
    const limit = clampInt(input.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const rows = all(db,
      'SELECT ' + MESSAGE_COLUMNS + ' FROM messages WHERE bot_id = ? AND peer = ?'
      + ' ORDER BY created_at DESC LIMIT ?',
      botId, peer, limit).map(mapRow);
    return rows.reverse().map((row) => {
      const who = row.senderName !== '' ? row.senderName : (row.senderId || '').slice(0, 8);
      return row.role === 'assistant' ? '助手: ' + row.content : (who !== '' ? who + ': ' : '') + row.content;
    }).join('\n');
  }

  /** 清理超过保留期的消息，返回删除条数。 */
  function cleanup({ retainDays = DEFAULT_RETAIN_DAYS } = {}) {
    const days = clampInt(retainDays, DEFAULT_RETAIN_DAYS, 0, 3650);
    if (days <= 0) return { removed: 0, cutoff: 0 };
    const cutoff = clock() - days * 24 * 60 * 60 * 1000;
    const info = run(db, 'DELETE FROM messages WHERE created_at < ?', cutoff);
    return { removed: Number(info && info.changes ? info.changes : 0), cutoff };
  }

  /** 该 bot 的消息条数与时间范围。 */
  function stats({ botId } = {}) {
    const owner = requireBotId(botId);
    const row = get(db,
      'SELECT COUNT(*) AS count, MIN(created_at) AS first, MAX(created_at) AS last FROM messages WHERE bot_id = ?',
      owner);
    return {
      count: Number(row && row.count ? row.count : 0),
      firstAt: Number(row && row.first ? row.first : 0),
      lastAt: Number(row && row.last ? row.last : 0),
    };
  }

  /** 列出有消息的会话（peer）及其最新时间。 */
  function peers({ botId, limit = 50 } = {}) {
    const owner = requireBotId(botId);
    const size = clampInt(limit, 50, 1, MAX_LIST_LIMIT);
    return all(db,
      'SELECT peer, COUNT(*) AS count, MAX(created_at) AS lastAt FROM messages'
      + ' WHERE bot_id = ? GROUP BY peer ORDER BY lastAt DESC LIMIT ?',
      owner, size).map((row) => ({
        peer: row.peer,
        count: Number(row.count) || 0,
        lastAt: Number(row.lastAt) || 0,
      }));
  }

  return { save, search, list, transcript, cleanup, stats, peers };
}

export default createMessagesStore;
