/**
 * core/config/store —— Bot / Profile / Binding 与分层设置（SQLite）。
 *
 * 分层模型（从低到高覆盖）：
 *   defaults（代码） → global 层(scope=global) → bot 层(scope=bot) → profile 层(scope=profile)
 * 一个 peer 的生效配置 = 该 bot 下匹配到的 profile（binding 精确 > 类型通配 > 全局）+ bot/global 层。
 * 记忆/知识库/群友库不在这里，它们按 bot 共享（见 core/*)。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { get, all, run, withTx } from '../db.js';
import {
  defaults, normalize, deepMerge, schemaPayload, setPath, getPath,
} from './schema.js';
import { pickBinding, normalizeScope } from '../peer.js';

const LAYER_ALL = ['global', 'bot', 'profile'];

/** 生成短 id。 */
function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

/** 读一层设置（未归一化）。 */
function readLayer(db, botId, key) {
  const row = get(db, 'SELECT value FROM settings WHERE bot_id = ? AND key = ?', botId, key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

/** 写一层设置。 */
function writeLayer(db, botId, key, value) {
  run(db, `INSERT INTO settings(bot_id, key, value) VALUES(?, ?, ?)
    ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value`, botId, key, JSON.stringify(value));
}

/**
 * @param {{db: import('node:sqlite').DatabaseSync, workspaceRoot: string, workspaceSubdir?: string, now?: () => number}} options
 */
export function createConfigStore({ db, workspaceRoot, workspaceSubdir = 'bots', now = Date.now }) {
  if (!db) throw new Error('createConfigStore 需要 db');

  const root = path.resolve(workspaceRoot || process.cwd());

  /** bot 的默认工作目录（必须在 DSH workspace 内）。 */
  function defaultCwd(botId) {
    return path.join(root, workspaceSubdir, botId);
  }

  // ── 设置 ───────────────────────────────────────────────────
  /** 全局层（已归一化）。 */
  function globalLayer() {
    const raw = readLayer(db, '', 'global') || {};
    return normalize(raw, { scopes: ['global'] }).value;
  }

  /** bot 层（已归一化）。 */
  function botLayer(botId) {
    if (!botId) return normalize({}, { scopes: ['bot'] }).value;
    const raw = readLayer(db, botId, 'bot') || {};
    return normalize(raw, { scopes: ['bot'] }).value;
  }

  /** profile 层（已归一化）。 */
  function profileLayer(profile) {
    if (!profile) return normalize({}, { scopes: ['profile'] }).value;
    let raw = {};
    try { raw = JSON.parse(profile.data || '{}'); } catch { raw = {}; }
    return normalize(raw, { scopes: ['profile'] }).value;
  }

  /** 当前 bot 的生效 profile（无 peer 时取 active/default）。 */
  function currentProfile(botId) {
    const rows = all(db, 'SELECT * FROM profiles WHERE bot_id = ? ORDER BY is_default DESC, created_at ASC', botId);
    if (rows.length === 0) return null;
    return rows[0];
  }

  /** 某 peer 的生效 profile（binding 优先，否则 active/default）。 */
  function resolveProfile(botId, peer) {
    const bindings = all(db, `SELECT b.id, b.scope, b.profile_id AS profileId, b.priority, b.created_at AS createdAt,
        p.id AS pId FROM bindings b JOIN profiles p ON p.id = b.profile_id
      WHERE b.bot_id = ?`, botId);
    if (peer) {
      const picked = pickBinding(bindings, peer);
      if (picked) {
        const profile = get(db, 'SELECT * FROM profiles WHERE id = ?', picked.binding.profileId);
        if (profile) return { profile, source: 'binding', scope: picked.binding.scope, level: picked.level };
      }
    }
    const fallback = currentProfile(botId);
    return fallback ? { profile: fallback, source: 'active', scope: '*', level: 1 } : { profile: null, source: 'none', scope: '', level: 0 };
  }

  /** 合成生效设置。 */
  function getEffectiveSettings(botId, peer) {
    const resolved = resolveProfile(botId, peer);
    let out = defaults(LAYER_ALL);
    out = deepMerge(out, globalLayer());
    if (botId) out = deepMerge(out, botLayer(botId));
    if (resolved.profile) out = deepMerge(out, profileLayer(resolved.profile));
    return out;
  }

  /** 控制台读取：bot 级视角（active profile）。 */
  function getSettings(botId) {
    return getEffectiveSettings(botId, null);
  }

  /**
   * 按 scope 自动分流 patch：global 项写全局层，bot 项写 bot 层，profile 项写 active profile。
   * @returns {{settings: object, warnings: string[], profileId: string|null}}
   */
  function patchSettings(botId, patch) {
    if (!patch || typeof patch !== 'object') throw new Error('patch 必须是对象');
    const warnings = [];
    const byScope = { global: {}, bot: {}, profile: {} };
    // 先按 schema 拆分
    const { value: normalizedAll, warnings: normWarnings } = normalize(patch, { scopes: LAYER_ALL });
    warnings.push(...normWarnings);
    // 拆分：只取 patch 里出现过的路径（normalize 会补默认值，这里靠原始 patch 的叶子判断）
    const leaves = [];
    collectLeaves(patch, '', leaves);
    const payload = schemaPayload();
    const touched = new Set();
    for (const leaf of leaves) {
      // 叶子可能是 json 型设置项的子路径（如 tools.capabilities.workspace），按前缀匹配到设置项
      const item = payload.items.find((candidate) => leaf === candidate.key || leaf.startsWith(candidate.key + '.'));
      if (!item || touched.has(item.key)) continue;
      touched.add(item.key);
      const next = getPath(normalizedAll, item.key, undefined);
      if (next === undefined) continue;
      byScope[item.scope] = setPath(byScope[item.scope], item.key, next);
    }
    withTx(db, () => {
      if (Object.keys(byScope.global).length > 0) {
        writeLayer(db, '', 'global', deepMerge(globalLayer(), byScope.global));
      }
      if (botId && Object.keys(byScope.bot).length > 0) {
        writeLayer(db, botId, 'bot', deepMerge(botLayer(botId), byScope.bot));
      }
      if (Object.keys(byScope.profile).length > 0) {
        const profile = currentProfile(botId);
        if (!profile) {
          if (botId) throw new Error('bot 没有配置档，无法写入 profile 级设置');
        } else {
          const merged = deepMerge(profileLayer(profile), byScope.profile);
          run(db, 'UPDATE profiles SET data = ?, updated_at = ? WHERE id = ?', JSON.stringify(merged), now(), profile.id);
        }
      }
    });
    return { settings: getSettings(botId), warnings, profileId: (currentProfile(botId) || {}).id || null };
  }

  /** 重置某层。 */
  function resetSettings(botId, layer) {
    withTx(db, () => {
      if (layer === 'global' || layer === undefined) run(db, "DELETE FROM settings WHERE bot_id = '' AND key = 'global'");
      if ((layer === 'bot' || layer === undefined) && botId) run(db, "DELETE FROM settings WHERE bot_id = ? AND key = 'bot'", botId);
      if ((layer === 'profile' || layer === undefined) && botId) {
        for (const profile of all(db, 'SELECT id FROM profiles WHERE bot_id = ?', botId)) {
          run(db, "UPDATE profiles SET data = '{}', updated_at = ? WHERE id = ?", now(), profile.id);
        }
      }
    });
    return getSettings(botId);
  }

  // ── bots ───────────────────────────────────────────────────
  function listBots() {
    return all(db, 'SELECT id, name, app_id AS appId, enabled, cwd, created_at AS createdAt, updated_at AS updatedAt FROM bots ORDER BY created_at ASC')
      .map((row) => ({ ...row, enabled: row.enabled === 1, hasSecret: hasSecret(row.id) }));
  }

  function hasSecret(botId) {
    const row = get(db, 'SELECT app_secret AS s FROM bots WHERE id = ?', botId);
    return Boolean(row && row.s && String(row.s).length > 0);
  }

  function getBot(botId) {
    const row = get(db, 'SELECT id, name, app_id AS appId, app_secret AS appSecret, enabled, cwd, created_at AS createdAt, updated_at AS updatedAt FROM bots WHERE id = ?', botId);
    if (!row) return null;
    return { ...row, enabled: row.enabled === 1 };
  }

  /** 创建 bot：同时建默认配置档与目录路径（不建目录，文件系统由 host 层负责）。 */
  function createBot({ name, appId = '', appSecret = '', enabled = true, cwd = '' } = {}) {
    const cleanName = String(name || '').trim().slice(0, 80);
    if (cleanName === '') throw new Error('bot 名称不能为空');
    const id = newId('bot');
    const stamp = now();
    const finalCwd = cwd ? path.resolve(cwd) : defaultCwd(id);
    // bot 目录随创建一起落地（控制台/CLI 创建后即可用；已存在则忽略）
    try { fs.mkdirSync(finalCwd, { recursive: true, mode: 0o755 }); } catch { /* 权限问题留给运行时告警 */ }
    withTx(db, () => {
      run(db, 'INSERT INTO bots(id, name, app_id, app_secret, enabled, cwd, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
        id, cleanName, String(appId || ''), String(appSecret || ''), enabled ? 1 : 0, finalCwd, stamp, stamp);
      run(db, 'INSERT INTO profiles(id, bot_id, name, data, is_default, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
        newId('prf'), id, '默认配置', '{}', 1, stamp, stamp);
    });
    return getBot(id);
  }

  function updateBot(botId, patch = {}) {
    const bot = getBot(botId);
    if (!bot) throw new Error('bot 不存在: ' + botId);
    const next = {
      name: patch.name !== undefined ? String(patch.name).trim().slice(0, 80) : bot.name,
      appId: patch.appId !== undefined ? String(patch.appId).trim() : bot.appId,
      appSecret: patch.appSecret !== undefined ? String(patch.appSecret) : bot.appSecret,
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : bot.enabled,
      cwd: patch.cwd !== undefined && String(patch.cwd).trim() !== '' ? path.resolve(String(patch.cwd)) : bot.cwd,
    };
    run(db, 'UPDATE bots SET name=?, app_id=?, app_secret=?, enabled=?, cwd=?, updated_at=? WHERE id=?',
      next.name, next.appId, next.appSecret, next.enabled ? 1 : 0, next.cwd, now(), botId);
    return getBot(botId);
  }

  function deleteBot(botId) {
    run(db, 'DELETE FROM bots WHERE id = ?', botId);
    run(db, 'DELETE FROM settings WHERE bot_id = ?', botId);
    return true;
  }

  // ── profiles ───────────────────────────────────────────────
  function listProfiles(botId) {
    return all(db, 'SELECT * FROM profiles WHERE bot_id = ? ORDER BY is_default DESC, created_at ASC', botId).map(profileView);
  }

  function profileView(row) {
    let data = {};
    try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
    return { id: row.id, botId: row.bot_id, name: row.name, data, isDefault: row.is_default === 1, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  function getProfile(profileId) {
    const row = get(db, 'SELECT * FROM profiles WHERE id = ?', profileId);
    return row ? profileView(row) : null;
  }

  function createProfile(botId, { name = '配置档', data = {} } = {}) {
    const id = newId('prf');
    const stamp = now();
    const normalized = normalize(data, { scopes: ['profile'] }).value;
    run(db, 'INSERT INTO profiles(id, bot_id, name, data, is_default, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
      id, botId, String(name).slice(0, 80), JSON.stringify(normalized), 0, stamp, stamp);
    return getProfile(id);
  }

  function updateProfile(profileId, patch = {}) {
    const profile = getProfile(profileId);
    if (!profile) throw new Error('配置档不存在: ' + profileId);
    const nextName = patch.name !== undefined ? String(patch.name).slice(0, 80) : profile.name;
    let nextData = profile.data;
    if (patch.data && typeof patch.data === 'object') {
      nextData = normalize(deepMerge(profile.data, patch.data), { scopes: ['profile'] }).value;
    }
    const nextDefault = patch.isDefault !== undefined ? Boolean(patch.isDefault) : profile.isDefault;
    withTx(db, () => {
      if (nextDefault) run(db, 'UPDATE profiles SET is_default = 0 WHERE bot_id = ?', profile.botId);
      run(db, 'UPDATE profiles SET name=?, data=?, is_default=?, updated_at=? WHERE id=?',
        nextName, JSON.stringify(nextData), nextDefault ? 1 : 0, now(), profileId);
    });
    return getProfile(profileId);
  }

  /** 激活（设为默认）配置档；绑定仍然优先于它。 */
  function activateProfile(profileId) {
    const profile = getProfile(profileId);
    if (!profile) throw new Error('配置档不存在: ' + profileId);
    withTx(db, () => {
      run(db, 'UPDATE profiles SET is_default = 0 WHERE bot_id = ?', profile.botId);
      run(db, 'UPDATE profiles SET is_default = 1, updated_at = ? WHERE id = ?', now(), profileId);
    });
    return getProfile(profileId);
  }

  function deleteProfile(profileId) {
    const profile = getProfile(profileId);
    if (!profile) return false;
    const count = get(db, 'SELECT COUNT(*) AS n FROM profiles WHERE bot_id = ?', profile.botId).n;
    if (count <= 1) throw new Error('至少保留一个配置档');
    run(db, 'DELETE FROM profiles WHERE id = ?', profileId);
    return true;
  }

  // ── bindings ───────────────────────────────────────────────
  function listBindings(botId) {
    return all(db, `SELECT b.id, b.bot_id AS botId, b.scope, b.profile_id AS profileId, b.priority, b.created_at AS createdAt,
        p.name AS profileName FROM bindings b LEFT JOIN profiles p ON p.id = b.profile_id
      WHERE b.bot_id = ? ORDER BY b.priority DESC, b.created_at ASC`, botId);
  }

  function upsertBinding(botId, scope, profileId, priority = 0) {
    const norm = normalizeScope(scope);
    if (norm === '') throw new Error('非法作用域: ' + scope);
    const profile = getProfile(profileId);
    if (!profile || profile.botId !== botId) throw new Error('配置档不存在或不属于该 bot');
    const stamp = now();
    run(db, `INSERT INTO bindings(bot_id, scope, profile_id, priority, created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(bot_id, scope) DO UPDATE SET profile_id = excluded.profile_id, priority = excluded.priority`,
      botId, norm, profileId, Number(priority) || 0, stamp);
    return listBindings(botId).find((item) => item.scope === norm) || null;
  }

  function deleteBinding(bindingId) {
    run(db, 'DELETE FROM bindings WHERE id = ?', bindingId);
    return true;
  }

  // ── 审计 ───────────────────────────────────────────────────
  function audit({ botId = null, kind = 'misc', detail = '' } = {}) {
    run(db, 'INSERT INTO audit(at, bot_id, kind, detail) VALUES(?,?,?,?)', now(), botId, String(kind).slice(0, 40), String(detail).slice(0, 2000));
  }

  function listAudit({ limit = 100, botId = null } = {}) {
    const size = Math.max(1, Math.min(500, Number(limit) || 100));
    if (botId) return all(db, 'SELECT * FROM audit WHERE bot_id = ? ORDER BY at DESC LIMIT ?', botId, size);
    return all(db, 'SELECT * FROM audit ORDER BY at DESC LIMIT ?', size);
  }

  return {
    // settings
    getSettings, getEffectiveSettings, patchSettings, resetSettings,
    // bots
    listBots, getBot, createBot, updateBot, deleteBot, defaultCwd,
    // profiles
    listProfiles, getProfile, createProfile, updateProfile, activateProfile, deleteProfile, resolveProfile,
    // bindings
    listBindings, upsertBinding, deleteBinding,
    // misc
    schema: schemaPayload, audit, listAudit,
  };
}

/** 收集 patch 的叶子路径。 */
function collectLeaves(obj, prefix, out) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    if (prefix !== '') out.push(prefix);
    return;
  }
  for (const key of Object.keys(obj)) {
    const next = prefix === '' ? key : prefix + '.' + key;
    const value = obj[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) collectLeaves(value, next, out);
    else out.push(next);
  }
}
