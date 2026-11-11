/**
 * core/tts/store —— TTS 供应商表（tts_providers）读写。
 *
 * 契约见 docs/MODELS-CENTER.md §5：
 * - config 是非敏感 JSON，字段由 core/tts/providers.js 的 kind 元数据约束；
 * - secret 只写不读：save 返回 providerView（脱敏），内部 list/get 才带 secret；
 * - 更新时 secret 缺省 / 空串 = 保留原值（清空密钥请删除供应商重建）；
 * - 校验/归一化全部走 providers.js normalizeProviderInput，错误信息可直接给用户。
 *
 * 本模块不 import 任何网络/UI 模块，engine 与 console API 共用。
 */
import crypto from 'node:crypto';

import { all, get, run } from '../db.js';
import { normalizeProviderInput, providerView } from './providers.js';

const ID_PREFIX = 'tts_';

/** 生成供应商 id：tts_ + 12 位 hex（契约 §3）。 */
function newId() {
  return ID_PREFIX + crypto.randomBytes(6).toString('hex');
}

/** 解析 DB 里的 config JSON；损坏/非对象一律当空对象，避免单个坏行拖垮整个列表。 */
function parseConfig(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return value;
  } catch {
    return {};
  }
}

/** DB 行 → 内部行（含 secret；适配器/engine 用）。 */
function mapRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || ''),
    name: String(row.name || ''),
    kind: String(row.kind || ''),
    enabled: Number(row.enabled) === 1 || row.enabled === true,
    config: parseConfig(row.config),
    secret: typeof row.secret === 'string' ? row.secret : '',
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

/** 供应商不存在错误（engine/console 可直接转 404/400）。 */
function notFoundError(id) {
  const err = new Error('TTS 供应商不存在: ' + id);
  err.code = 'TTS_PROVIDER_NOT_FOUND';
  return err;
}

/**
 * 创建 TTS 供应商 store。
 * @param {{db: import('node:sqlite').DatabaseSync, now?: () => number}} options
 */
export function createTtsProviderStore({ db, now = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createTtsProviderStore: 需要由 lib/core/db.js 的 openDb() 打开的 db');
  }

  /** 内部行列表（含 secret），按 created_at ASC（同秒按 id 保证稳定）。 */
  function list() {
    return all(db, 'SELECT * FROM tts_providers ORDER BY created_at ASC, id ASC').map(mapRow);
  }

  /** 对外视图列表（secret 脱敏）。 */
  function listPublic() {
    return list().map((row) => providerView(row));
  }

  /** 内部行；不存在返回 null。 */
  function getRow(id) {
    const target = String(id === undefined || id === null ? '' : id).trim();
    if (target === '') return null;
    return mapRow(get(db, 'SELECT * FROM tts_providers WHERE id = ?', target));
  }

  /** 对外视图；不存在返回 null。 */
  function getPublic(id) {
    return providerView(getRow(id));
  }

  /**
   * 新增（无 id）/ 更新（有 id）。
   * @param {{id?:string,name?:string,kind?:string,enabled?:boolean,config?:object,secret?:string}} input
   * @returns {object} providerView
   * @throws {Error} 校验失败（消息中文可读）
   */
  function save(input) {
    const src = input && typeof input === 'object' ? input : {};
    const id = typeof src.id === 'string' ? src.id.trim() : '';
    if (id === '') {
      const { value } = normalizeProviderInput(src, { existing: null });
      const stamp = now();
      const nextId = newId();
      run(db,
        'INSERT INTO tts_providers(id, name, kind, enabled, config, secret, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
        nextId, value.name, value.kind, value.enabled ? 1 : 0,
        JSON.stringify(value.config), typeof value.secret === 'string' ? value.secret : '', stamp, stamp);
      return providerView(getRow(nextId));
    }
    const existing = getRow(id);
    if (!existing) throw notFoundError(id);
    const { value } = normalizeProviderInput(src, { existing });
    // secret 缺省/空串 = 保留原值（契约 §3：只写不读，不支持通过空串清空）
    const secret = typeof value.secret === 'string' && value.secret !== '' ? value.secret : existing.secret;
    run(db,
      'UPDATE tts_providers SET name = ?, kind = ?, enabled = ?, config = ?, secret = ?, updated_at = ? WHERE id = ?',
      value.name, value.kind, value.enabled ? 1 : 0, JSON.stringify(value.config), secret, now(), id);
    return providerView(getRow(id));
  }

  /** 删除；返回是否真的删掉了一行。 */
  function remove(id) {
    const target = String(id === undefined || id === null ? '' : id).trim();
    if (target === '') return false;
    const result = run(db, 'DELETE FROM tts_providers WHERE id = ?', target);
    return Number(result && result.changes ? result.changes : 0) > 0;
  }

  /** 第一个启用的供应商（默认供应商回退用）；没有返回 null。 */
  function firstEnabled() {
    return mapRow(get(db, 'SELECT * FROM tts_providers WHERE enabled = 1 ORDER BY created_at ASC, id ASC LIMIT 1'));
  }

  return { list, listPublic, get: getRow, getPublic, save, remove, firstEnabled };
}

export default createTtsProviderStore;
