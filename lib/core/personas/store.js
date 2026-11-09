/**
 * core/personas/store —— 人格卡（bot 级）+ 生效卡同步到 <bot cwd>/persona.md。
 *
 * 契约（DESIGN-v2 §0.4 / §3）：
 * - 同一 bot 任意时刻只有一张 active 卡：activate 在事务内先清零再置一，天然互斥；
 * - 激活后原子写 <bots.cwd>/persona.md（同目录写 tmp 再 rename，避免读到半截文件）；
 * - 文件写失败只 logger.warn，不抛错、不回滚 DB（控制台仍能看到 active 卡）；
 * - 编辑 active 卡内容时也同步 persona.md，避免文件与 DB 不一致。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { all, get, run, withTx } from '../db.js';

const MAX_NAME = 80;
/** 正文上限 200KB，防止控制台误贴超大文本把 DB 撑爆。 */
const MAX_CONTENT = 200_000;
const PERSONA_FILE = 'persona.md';

const PERSONA_COLUMNS = [
  'id',
  'bot_id AS botId',
  'name',
  'content',
  'active',
  'created_at AS createdAt',
  'updated_at AS updatedAt',
].join(', ');

/** 短 id。 */
function newId() {
  return 'psn_' + crypto.randomBytes(6).toString('hex');
}

function requireBotId(botId) {
  const value = String(botId === undefined || botId === null ? '' : botId).trim();
  if (value === '') throw new TypeError('personas store: botId 不能为空');
  return value;
}

function requireId(id) {
  const value = String(id === undefined || id === null ? '' : id).trim();
  if (value === '') throw new TypeError('personas store: id 不能为空');
  return value;
}

function cleanName(name) {
  const text = String(name === undefined || name === null ? '' : name).trim();
  if (text === '') throw new TypeError('personas store: name 不能为空');
  return text.slice(0, MAX_NAME);
}

function cleanContent(content) {
  if (content === undefined || content === null) return '';
  return String(content).slice(0, MAX_CONTENT);
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    content: row.content === undefined || row.content === null ? '' : row.content,
    active: Number(row.active) === 1,
    createdAt: Number(row.createdAt) || 0,
    updatedAt: Number(row.updatedAt) || 0,
  };
}

/**
 * 创建人格卡 store。
 * @param {{db: import('node:sqlite').DatabaseSync, logger?: object, now?: () => number}} options
 */
export function createPersonasStore({ db, logger = null, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createPersonasStore: 需要由 lib/core/db.js 的 openDb() 打开的 db');
  }

  function logWarn(message) {
    try { logger?.warn?.(message); } catch { /* 日志失败不影响主流程 */ }
  }

  /** 取 bot 的工作目录（config.createBot 时已写入绝对路径）。 */
  function botCwd(botId) {
    const row = get(db, 'SELECT cwd FROM bots WHERE id = ?', botId);
    return row && row.cwd ? String(row.cwd) : '';
  }

  /**
   * 原子写 persona.md：tmp 与目标同目录，rename 在 POSIX 下是原子替换。
   * 失败只 warn（目录不存在会尝试 mkdir；权限/只读等错误不阻断激活）。
   * @returns {boolean} 是否写入成功
   */
  function writePersonaFile(botId, content) {
    let tmpPath = '';
    try {
      const cwd = botCwd(botId);
      if (cwd === '') {
        logWarn('[personas] bot ' + botId + ' 没有 cwd，跳过 persona.md 同步');
        return false;
      }
      fs.mkdirSync(cwd, { recursive: true });
      const target = path.join(cwd, PERSONA_FILE);
      tmpPath = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
      fs.writeFileSync(tmpPath, content === undefined || content === null ? '' : String(content), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, target);
      return true;
    } catch (err) {
      logWarn('[personas] 写 persona.md 失败（bot=' + botId + '）：' + String(err && err.message ? err.message : err));
      if (tmpPath !== '') {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      }
      return false;
    }
  }

  /** 列表：active 优先，其次最近更新。 */
  function list({ botId } = {}) {
    const owner = requireBotId(botId);
    const rows = all(db,
      'SELECT ' + PERSONA_COLUMNS + ' FROM personas WHERE bot_id = ? ORDER BY active DESC, updated_at DESC, created_at ASC',
      owner);
    return rows.map(mapRow);
  }

  /** 取单卡；不存在或不属于该 bot 返回 null。 */
  function getOne({ botId, id } = {}) {
    const owner = requireBotId(botId);
    const target = requireId(id);
    return mapRow(get(db, 'SELECT ' + PERSONA_COLUMNS + ' FROM personas WHERE bot_id = ? AND id = ?', owner, target));
  }

  /** 当前生效卡（没有 active 返回 null）。 */
  function active({ botId } = {}) {
    const owner = requireBotId(botId);
    return mapRow(get(db,
      'SELECT ' + PERSONA_COLUMNS + ' FROM personas WHERE bot_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1',
      owner));
  }

  /** 新建（默认不激活）。 */
  function create({ botId, name, content = '' } = {}) {
    const owner = requireBotId(botId);
    const cleanPersonaName = cleanName(name);
    const id = newId();
    const stamp = now();
    run(db,
      'INSERT INTO personas(id, bot_id, name, content, active, created_at, updated_at) VALUES(?,?,?,?,0,?,?)',
      id, owner, cleanPersonaName, cleanContent(content), stamp, stamp);
    return getOne({ botId: owner, id });
  }

  /** 更新名称/正文；正文变更且该卡为 active 时同步 persona.md。 */
  function update({ botId, id, name, content } = {}) {
    const owner = requireBotId(botId);
    const target = requireId(id);
    const existing = getOne({ botId: owner, id: target });
    if (!existing) return null;
    const nextName = name === undefined || name === null || String(name).trim() === '' ? existing.name : cleanName(name);
    const nextContent = content === undefined || content === null ? existing.content : cleanContent(content);
    run(db, 'UPDATE personas SET name = ?, content = ?, updated_at = ? WHERE bot_id = ? AND id = ?',
      nextName, nextContent, now(), owner, target);
    const updated = getOne({ botId: owner, id: target });
    // 生效卡被编辑：同步文件，保证 QQ 侧读到的 persona.md 与 DB 一致
    if (updated && updated.active) writePersonaFile(owner, updated.content);
    return updated;
  }

  /** 删除；不主动删 persona.md（文件可能是用户手改的，保留更安全）。 */
  function remove({ botId, id } = {}) {
    const owner = requireBotId(botId);
    const target = requireId(id);
    const existing = getOne({ botId: owner, id: target });
    if (!existing) return { removed: false, id: target };
    run(db, 'DELETE FROM personas WHERE bot_id = ? AND id = ?', owner, target);
    return { removed: true, id: target };
  }

  /**
   * 激活：事务内互斥（同 bot 只留一张 active），提交后原子写 persona.md。
   * @returns 激活后的实体；卡不存在返回 null
   */
  function activate({ botId, id } = {}) {
    const owner = requireBotId(botId);
    const target = requireId(id);
    const existing = getOne({ botId: owner, id: target });
    if (!existing) return null;
    const stamp = now();
    withTx(db, () => {
      run(db, 'UPDATE personas SET active = 0 WHERE bot_id = ?', owner);
      run(db, 'UPDATE personas SET active = 1, updated_at = ? WHERE bot_id = ? AND id = ?', stamp, owner, target);
    });
    const activated = getOne({ botId: owner, id: target });
    if (activated) writePersonaFile(owner, activated.content);
    return activated;
  }

  return { list, get: getOne, active, create, update, remove, activate };
}
