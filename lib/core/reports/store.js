/**
 * core/reports/store —— 群日报存储（daily_reports）。
 *
 * 唯一键 (bot_id, peer, day)：同一天重复生成是「覆盖更新」，天然幂等；
 * payload_json 是稳定契约，text 是纯文本版，后续卡片模板只读 payload，不需要改库。
 */
import { all, get as dbGet, run } from '../db.js';

const COLUMNS = `
  id,
  bot_id AS botId,
  peer,
  day,
  status,
  payload_json AS payloadJson,
  text,
  message_count AS messageCount,
  speaker_count AS speakerCount,
  error,
  delivered,
  image_path AS imagePath,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function requireValue(name, value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text === '') throw new TypeError('daily report: ' + name + ' 不能为空');
  return text;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    botId: row.botId,
    peer: row.peer,
    day: row.day,
    status: row.status,
    payload: parseObject(row.payloadJson),
    text: row.text || '',
    messageCount: Number(row.messageCount) || 0,
    speakerCount: Number(row.speakerCount) || 0,
    error: row.error || '',
    delivered: Number(row.delivered) === 1,
    imagePath: row.imagePath || '',
    createdAt: Number(row.createdAt) || 0,
    updatedAt: Number(row.updatedAt) || 0,
  };
}

function parseObject(value) {
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function createReportStore({ db, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createReportStore: 需要由 lib/core/db.js 的 openDb() 打开的 db');
  }

  /** 新建或覆盖某天某群的报告。 */
  function save(input = {}) {
    const botId = requireValue('botId', input.botId);
    const peer = requireValue('peer', input.peer);
    const day = requireValue('day', input.day);
    const stamp = now();
    const payloadJson = JSON.stringify(input.payload && typeof input.payload === 'object' ? input.payload : {});
    const existing = readRow(botId, peer, day);
    if (!existing) {
      run(db,
        'INSERT INTO daily_reports(bot_id, peer, day, status, payload_json, text, message_count, speaker_count, error, delivered, image_path, created_at, updated_at)'
        + ' VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        botId, peer, day,
        String(input.status || 'done'),
        payloadJson,
        String(input.text || ''),
        Number(input.messageCount) || 0,
        Number(input.speakerCount) || 0,
        String(input.error || ''),
        input.delivered === true ? 1 : 0,
        String(input.imagePath || ''),
        stamp, stamp);
    } else {
      run(db,
        'UPDATE daily_reports SET status = ?, payload_json = ?, text = ?, message_count = ?, speaker_count = ?,'
        + ' error = ?, delivered = ?, image_path = ?, updated_at = ? WHERE bot_id = ? AND peer = ? AND day = ?',
        String(input.status || 'done'), payloadJson, String(input.text || ''),
        Number(input.messageCount) || 0, Number(input.speakerCount) || 0,
        String(input.error || ''), input.delivered === true ? 1 : 0,
        String(input.imagePath || ''),
        stamp, botId, peer, day);
    }
    return readRow(botId, peer, day);
  }

  /** 只更新卡片图路径（渲染发生在 save 之后）。 */
  function setImage({ botId, peer, day, imagePath = '' } = {}) {
    const owner = requireValue('botId', botId);
    const key = requireValue('peer', peer);
    const date = requireValue('day', day);
    run(db, 'UPDATE daily_reports SET image_path = ?, updated_at = ? WHERE bot_id = ? AND peer = ? AND day = ?',
      String(imagePath || ''), now(), owner, key, date);
    return readRow(owner, key, date);
  }

  /** 记录投递失败原因（保留报告内容，只更新 error）。 */
  function setError({ botId, peer, day, error = '' } = {}) {
    const owner = requireValue('botId', botId);
    const key = requireValue('peer', peer);
    const date = requireValue('day', day);
    run(db, 'UPDATE daily_reports SET error = ?, updated_at = ? WHERE bot_id = ? AND peer = ? AND day = ?',
      String(error || '').slice(0, 300), now(), owner, key, date);
    return readRow(owner, key, date);
  }

  /** 标记投递成功/失败（避免整行重写）。 */
  function markDelivered({ botId, peer, day, delivered = true } = {}) {
    const owner = requireValue('botId', botId);
    const key = requireValue('peer', peer);
    const date = requireValue('day', day);
    run(db, 'UPDATE daily_reports SET delivered = ?, updated_at = ? WHERE bot_id = ? AND peer = ? AND day = ?',
      delivered === true ? 1 : 0, now(), owner, key, date);
    return readRow(owner, key, date);
  }

  function readRow(botId, peer, day) {
    return mapRow(dbGet(db,
      'SELECT ' + COLUMNS + ' FROM daily_reports WHERE bot_id = ? AND peer = ? AND day = ?',
      botId, peer, day));
  }

  /** 取某天的报告。 */
  function get({ botId, peer, day } = {}) {
    return readRow(requireValue('botId', botId), requireValue('peer', peer), requireValue('day', day));
  }

  /** 列表：按日期倒序。 */
  function list({ botId, peer = '', limit = 30, offset = 0 } = {}) {
    const owner = requireValue('botId', botId);
    const size = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 30));
    const skip = Math.max(0, Math.floor(Number(offset)) || 0);
    const key = String(peer || '').trim();
    const rows = key === ''
      ? all(db, 'SELECT ' + COLUMNS + ' FROM daily_reports WHERE bot_id = ? ORDER BY day DESC LIMIT ? OFFSET ?', owner, size, skip)
      : all(db, 'SELECT ' + COLUMNS + ' FROM daily_reports WHERE bot_id = ? AND peer = ? ORDER BY day DESC LIMIT ? OFFSET ?', owner, key, size, skip);
    return rows.map(mapRow);
  }

  /** 最近一份（给预览/调试用）。 */
  function latest({ botId, peer } = {}) {
    const owner = requireValue('botId', botId);
    const key = requireValue('peer', peer);
    return mapRow(dbGet(db,
      'SELECT ' + COLUMNS + ' FROM daily_reports WHERE bot_id = ? AND peer = ? ORDER BY day DESC LIMIT 1',
      owner, key));
  }

  return { save, markDelivered, setImage, setError, get, list, latest };
}

export default createReportStore;
