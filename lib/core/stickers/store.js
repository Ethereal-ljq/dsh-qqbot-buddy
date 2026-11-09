/**
 * core/stickers/store —— 表情包库（bot 级，按 (bot_id, hash) 去重）+ 当日发送配额计数。
 *
 * 职责：
 * - add：hash 非空时按 (bot_id, hash) 去重，已存在直接返回 created:false（不重复落库）；
 * - remove：先删 DB 行，再尽力删文件（文件不存在忽略；其他失败只 warn，不影响删除结果）；
 * - quota/recordSend：当日发送量存 job_state（bot_id=bot, peer='', job='sticker-send'），
 *   value = {"day":"YYYY-MM-DD","count":N}；跨天自动归零，重启不丢。
 */
import fs from 'node:fs';

import { all, get, run } from '../db.js';

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const QUOTA_JOB = 'sticker-send';
const QUOTA_PEER = '';
const MAX_NAME = 80;

const STICKER_COLUMNS = [
  'id',
  'bot_id AS botId',
  'name',
  'file',
  'emotion',
  'hash',
  'created_at AS createdAt',
].join(', ');

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地自然日键（配额按当地时间天）。 */
export function stickerDayKey(stamp = Date.now()) {
  const date = new Date(Number(stamp) || Date.now());
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function requireBotId(botId) {
  const value = String(botId === undefined || botId === null ? '' : botId).trim();
  if (value === '') throw new TypeError('stickers store: botId 不能为空');
  return value;
}

function toId(id) {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    botId: row.botId,
    name: row.name,
    file: row.file,
    emotion: row.emotion === undefined ? null : row.emotion,
    hash: row.hash === undefined ? null : row.hash,
    createdAt: Number(row.createdAt) || 0,
  };
}

/**
 * 创建表情包 store。
 * @param {{db: import('node:sqlite').DatabaseSync, logger?: object, now?: () => number}} options
 */
export function createStickersStore({ db, logger = null, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createStickersStore: 需要由 lib/core/db.js 的 openDb() 打开的 db');
  }

  function logWarn(message) {
    try { logger?.warn?.(message); } catch { /* ignore */ }
  }

  function getById(botId, id) {
    return mapRow(get(db, 'SELECT ' + STICKER_COLUMNS + ' FROM stickers WHERE bot_id = ? AND id = ?', botId, id));
  }

  /**
   * 新增表情包；hash 非空时按 (bot_id, hash) 去重。
   * @returns 表情包实体 + {created:boolean}
   */
  function add({ botId, name, file, emotion = '', hash = '' } = {}) {
    const owner = requireBotId(botId);
    const cleanStickerName = String(name === undefined || name === null ? '' : name).trim().slice(0, MAX_NAME);
    if (cleanStickerName === '') throw new TypeError('stickers store: name 不能为空');
    const cleanFile = String(file === undefined || file === null ? '' : file).trim();
    if (cleanFile === '') throw new TypeError('stickers store: file 不能为空');
    const cleanHash = String(hash === undefined || hash === null ? '' : hash).trim();
    if (cleanHash !== '') {
      const existing = mapRow(get(db,
        'SELECT ' + STICKER_COLUMNS + ' FROM stickers WHERE bot_id = ? AND hash = ? ORDER BY id ASC LIMIT 1',
        owner, cleanHash));
      if (existing) return { ...existing, created: false };
    }
    const stamp = now();
    const info = run(db,
      'INSERT INTO stickers(bot_id, name, file, emotion, hash, created_at) VALUES(?,?,?,?,?,?)',
      owner, cleanStickerName, cleanFile,
      String(emotion === undefined || emotion === null ? '' : emotion).trim() || null,
      cleanHash === '' ? null : cleanHash,
      stamp);
    return { ...getById(owner, Number(info.lastInsertRowid)), created: true };
  }

  /** 列表：最近收藏优先。 */
  function list({ botId, limit = DEFAULT_LIST_LIMIT, offset = 0, emotion } = {}) {
    const owner = requireBotId(botId);
    const size = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(Number(limit)) || DEFAULT_LIST_LIMIT));
    const skip = Math.max(0, Math.floor(Number(offset)) || 0);
    const filter = emotion === undefined || emotion === null || String(emotion).trim() === '' ? null : String(emotion).trim();
    const rows = filter === null
      ? all(db, 'SELECT ' + STICKER_COLUMNS + ' FROM stickers WHERE bot_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', owner, size, skip)
      : all(db, 'SELECT ' + STICKER_COLUMNS + ' FROM stickers WHERE bot_id = ? AND emotion = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', owner, filter, size, skip);
    return rows.map(mapRow);
  }

  /** 按 id 取单个；不存在返回 null。 */
  function getSticker({ botId, id } = {}) {
    const owner = requireBotId(botId);
    const target = toId(id);
    return target === null ? null : getById(owner, target);
  }

  /** 删除 DB 行并尽力删除文件；文件不存在忽略。 */
  function remove({ botId, id } = {}) {
    const owner = requireBotId(botId);
    const target = toId(id);
    if (target === null) return { removed: false, id: null };
    const existing = getById(owner, target);
    if (!existing) return { removed: false, id: target };
    const result = run(db, 'DELETE FROM stickers WHERE id = ? AND bot_id = ?', target, owner);
    const removed = Number(result && result.changes ? result.changes : 0) > 0;
    if (removed && existing.file) {
      try {
        fs.rmSync(existing.file, { force: true });
      } catch (err) {
        logWarn('[stickers] 删除表情包文件失败（' + existing.file + '）：' + String(err && err.message ? err.message : err));
      }
    }
    return { removed, id: target, file: existing.file };
  }

  /** 读当日计数（跨天视为 0）。 */
  function quota({ botId } = {}) {
    const owner = requireBotId(botId);
    const day = stickerDayKey(now());
    const row = get(db, 'SELECT value FROM job_state WHERE bot_id = ? AND peer = ? AND job = ?', owner, QUOTA_PEER, QUOTA_JOB);
    let stored = null;
    if (row) {
      try { stored = JSON.parse(row.value); } catch { stored = null; }
    }
    const storedDay = stored && typeof stored.day === 'string' ? stored.day : null;
    const storedCount = stored && Number.isFinite(Number(stored.count)) ? Math.max(0, Math.floor(Number(stored.count))) : 0;
    return { day, count: storedDay === day ? storedCount : 0 };
  }

  /** 记录一次发送，返回 {day,count}（供 QQ 出站层调用）。 */
  function recordSend({ botId } = {}) {
    const owner = requireBotId(botId);
    const day = stickerDayKey(now());
    const current = quota({ botId: owner });
    const count = (current.day === day ? current.count : 0) + 1;
    run(db,
      'INSERT INTO job_state(bot_id, peer, job, value, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(bot_id, peer, job) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      owner, QUOTA_PEER, QUOTA_JOB, JSON.stringify({ day, count }), now());
    return { day, count };
  }

  return { add, list, get: getSticker, remove, quota, recordSend };
}
