/**
 * bots/registry —— 多机器人注册表（<workspaceRoot>/bots.json）。
 *
 * 设计要点：
 * - bots.json 只存**非敏感**元数据（id/名称/appId/工作区/启用状态），appSecret 单独放在
 *   每个机器人 stateDir 下的 credentials.json（0600，不返回给前端、不进日志）；
 * - 首次加载（文件不存在/损坏）自动迁移出 legacy 机器人：沿用 config.cwd + config.stateDir，
 *   旧数据原地可读；只有凭据文件不存在时才用 config.appId/config.appSecret 播种；
 * - 原子写（tmp + rename），损坏文件备份为 .corrupt-<ts> 后重建；
 * - 任何读写失败都只 warn 不抛（由调用方决定降级），但会返回 {ok:false,error}。
 */
import fs from 'node:fs';
import path from 'node:path';

import { defaultBotWorkspace, ensureBotDirs, resolveBotPaths } from './paths.js';

const FILE_NAME = 'bots.json';
const VERSION = 1;
const MAX_NAME = 40;
const MAX_ID = 40;
const MAX_APPID = 200;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const textOf = (v) => (typeof v === 'string' ? v.trim() : '');
const now = () => Date.now();
function errText(err) { return err instanceof Error ? err.message : String(err); }

/** 原子写 JSON（0600）。 */
function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid + '-' + Date.now());
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 从名称生成稳定 slug（中文等非 ASCII 名称回退 bot）。 */
function slugOf(name) {
  const ascii = textOf(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii !== '' ? ascii.slice(0, MAX_ID) : 'bot';
}

/**
 * @param {object} options
 * @param {string} options.workspaceRoot 工作区根（绝对路径）
 * @param {object} [options.legacyConfig] 插件部署配置（legacy 迁移用）
 * @param {number} [options.maxBots] 最多机器人数量
 * @param {object} [options.logger]
 */
export function createBotRegistry({ workspaceRoot, legacyConfig = {}, maxBots = 8, logger } = {}) {
  const log = logger || console;
  const root = path.resolve(String(workspaceRoot || '').trim() || process.cwd());
  const cfg = isObj(legacyConfig) ? legacyConfig : {};
  const limit = Number.isFinite(Number(maxBots)) ? Math.max(1, Math.min(32, Math.round(Number(maxBots)))) : 8;
  const file = path.join(root, FILE_NAME);
  let state = load();

  /** 严格化磁盘上的记录；非法条目丢弃。 */
  function sanitizeRecord(raw) {
    if (!isObj(raw)) return null;
    const id = textOf(raw.id).replace(/[^A-Za-z0-9_-]/g, '');
    if (id === '' || id.length > MAX_ID) return null;
    const workspaceDir = textOf(raw.workspaceDir);
    if (workspaceDir === '' || !path.isAbsolute(workspaceDir)) return null;
    return {
      id: id,
      name: textOf(raw.name).slice(0, MAX_NAME) || id,
      appId: textOf(raw.appId).slice(0, MAX_APPID),
      enabled: raw.enabled !== false,
      legacy: raw.legacy === true,
      workspaceDir: path.resolve(workspaceDir),
      createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : now(),
      updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : now(),
    };
  }

  function normalizeState(raw) {
    const src = isObj(raw) ? raw : {};
    const seen = new Set();
    const bots = [];
    for (const item of Array.isArray(src.bots) ? src.bots : []) {
      const record = sanitizeRecord(item);
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      bots.push(record);
    }
    let activeBotId = textOf(src.activeBotId);
    if (!seen.has(activeBotId)) activeBotId = bots.length > 0 ? bots[0].id : '';
    return { version: VERSION, activeBotId: activeBotId, bots: bots };
  }

  /** 旧版单机器人 → legacy 记录（沿用 config 里的 cwd/stateDir/settingsFile）。 */
  function migrateLegacy() {
    const legacyWs = path.resolve(textOf(cfg.cwd) || root);
    const record = {
      id: 'default',
      name: '默认机器人',
      appId: textOf(cfg.appId).slice(0, MAX_APPID),
      enabled: true,
      legacy: true,
      workspaceDir: legacyWs,
      createdAt: now(),
      updatedAt: now(),
    };
    // 只有凭据文件不存在时才播种，避免覆盖用户后来在设置页绑定的新凭据。
    const credFile = resolveBotPaths({ workspaceDir: legacyWs, config: cfg, record: record }).credentialsFile;
    if (!fs.existsSync(credFile)) {
      const appId = textOf(cfg.appId);
      const appSecret = textOf(cfg.appSecret);
      if (appId !== '' && appSecret !== '') {
        try {
          writeJsonAtomic(credFile, { appId: appId, appSecret: appSecret, updatedAt: now() });
        } catch (err) {
          log.warn?.('[bots] 播种 legacy 凭据失败: ' + errText(err));
        }
      }
    }
    return { version: VERSION, activeBotId: 'default', bots: [record] };
  }

  function load() {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') log.warn?.('[bots] 读取 bots.json 失败，按迁移处理: ' + errText(err));
      const seed = migrateLegacy();
      try { writeJsonAtomic(file, seed); } catch (err2) { log.warn?.('[bots] 写入 bots.json 失败: ' + errText(err2)); }
      return seed;
    }
    try {
      const parsed = JSON.parse(raw);
      const normalized = normalizeState(parsed);
      if (normalized.bots.length === 0) throw new Error('bots 为空');
      return normalized;
    } catch (err) {
      try {
        const backup = file + '.corrupt-' + now();
        fs.renameSync(file, backup);
        log.warn?.('[bots] bots.json 损坏，已备份到 ' + backup + '，重新迁移: ' + errText(err));
      } catch {
        /* 备份失败继续 */
      }
      const seed = migrateLegacy();
      try { writeJsonAtomic(file, seed); } catch (err2) { log.warn?.('[bots] 重建 bots.json 失败: ' + errText(err2)); }
      return seed;
    }
  }

  function save() {
    try {
      writeJsonAtomic(file, state);
      return { ok: true };
    } catch (err) {
      log.error?.('[bots] 写入 bots.json 失败: ' + errText(err));
      return { ok: false, error: errText(err) };
    }
  }

  function clone(record) {
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  function list() { return state.bots.map(clone); }
  function get(id) {
    const key = textOf(id);
    return clone(state.bots.find((item) => item.id === key) || null);
  }
  function activeId() { return state.activeBotId; }
  function active() { return get(state.activeBotId) || (state.bots[0] ? clone(state.bots[0]) : null); }
  function setActive(id) {
    const key = textOf(id);
    if (!state.bots.some((item) => item.id === key)) return { ok: false, error: '机器人不存在: ' + key };
    state.activeBotId = key;
    return Object.assign({ ok: true, activeBotId: key }, save());
  }

  function pathsOf(idOrRecord) {
    const record = typeof idOrRecord === 'string' ? get(idOrRecord) : idOrRecord;
    if (!record) return null;
    return resolveBotPaths({ workspaceDir: record.workspaceDir, config: cfg, record: record });
  }

  function credentialsOf(idOrRecord) {
    const record = typeof idOrRecord === 'string' ? get(idOrRecord) : idOrRecord;
    if (!record) return { appId: '', appSecret: '' };
    const paths = pathsOf(record);
    let fromFile = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(paths.credentialsFile, 'utf8'));
      if (isObj(parsed)) fromFile = { appId: textOf(parsed.appId), appSecret: textOf(parsed.appSecret) };
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) log.warn?.('[bots] 读取凭据失败（按未绑定处理）: ' + errText(err));
    }
    if (fromFile) return fromFile;
    // legacy 兜底：旧部署把凭据写在 cordis patch 里（仅在从未有过凭据文件时生效）
    if (record.legacy) return { appId: textOf(cfg.appId), appSecret: textOf(cfg.appSecret) };
    return { appId: record.appId, appSecret: '' };
  }

  function setCredentials(id, credentials) {
    const record = get(id);
    if (!record) return { ok: false, error: '机器人不存在: ' + id };
    const appId = textOf(credentials && credentials.appId).slice(0, MAX_APPID);
    const appSecret = textOf(credentials && credentials.appSecret).slice(0, 400);
    const paths = pathsOf(record);
    try {
      if (appId === '' && appSecret === '') {
        // 解绑：写墓碑（而不是删文件），避免 legacy 机器人下次启动又从 config 的
        // appId/appSecret 播种回来。
        writeJsonAtomic(paths.credentialsFile, { appId: '', appSecret: '', unboundAt: now() });
      } else {
        writeJsonAtomic(paths.credentialsFile, { appId: appId, appSecret: appSecret, updatedAt: now() });
      }
    } catch (err) {
      return { ok: false, error: '保存凭据失败: ' + errText(err) };
    }
    record.appId = appId;
    record.updatedAt = now();
    save();
    return { ok: true, appId: appId, bound: appId !== '' && appSecret !== '' };
  }

  function uniqueId(base) {
    const seed = slugOf(base);
    let candidate = seed;
    let n = 2;
    const used = new Set(state.bots.map((item) => item.id));
    while (used.has(candidate)) {
      candidate = (seed + '-' + n).slice(0, MAX_ID);
      n += 1;
    }
    return candidate;
  }

  function create({ name, appId, appSecret, workspaceDir, enabled } = {}) {
    if (state.bots.length >= limit) {
      return { ok: false, error: '最多只能配置 ' + limit + ' 个机器人' };
    }
    const id = uniqueId(name || 'bot');
    const wsRaw = textOf(workspaceDir);
    const ws = wsRaw === ''
      ? defaultBotWorkspace(root, id)
      : (path.isAbsolute(wsRaw) ? path.resolve(wsRaw) : '');
    if (ws === '') return { ok: false, error: '工作区必须是绝对路径' };
    const record = {
      id: id,
      name: textOf(name).slice(0, MAX_NAME) || ('机器人 ' + (state.bots.length + 1)),
      appId: textOf(appId).slice(0, MAX_APPID),
      enabled: enabled !== false,
      legacy: false,
      workspaceDir: ws,
      createdAt: now(),
      updatedAt: now(),
    };
    try {
      ensureBotDirs(pathsOf(record));
    } catch (err) {
      return { ok: false, error: '创建工作区目录失败: ' + errText(err) };
    }
    state.bots.push(record);
    if (state.bots.length === 1) state.activeBotId = record.id;
    const saved = save();
    if (!saved.ok) { state.bots.pop(); return saved; }
    if (textOf(appSecret) !== '') {
      const cred = setCredentials(record.id, { appId: record.appId, appSecret: appSecret });
      if (!cred.ok) return { ok: false, error: cred.error, bot: clone(record) };
    }
    return { ok: true, bot: clone(record) };
  }

  function update(id, patch) {
    const record = state.bots.find((item) => item.id === textOf(id));
    if (!record) return { ok: false, error: '机器人不存在: ' + id };
    const src = isObj(patch) ? patch : {};
    if (src.name !== undefined) {
      const name = textOf(src.name).slice(0, MAX_NAME);
      if (name === '') return { ok: false, error: '名称不能为空' };
      record.name = name;
    }
    if (src.enabled !== undefined) record.enabled = src.enabled !== false;
    if (src.workspaceDir !== undefined) {
      const raw = textOf(src.workspaceDir);
      if (raw === '' || !path.isAbsolute(raw)) return { ok: false, error: '工作区必须是绝对路径' };
      record.workspaceDir = path.resolve(raw);
      try { ensureBotDirs(pathsOf(record)); } catch (err) { return { ok: false, error: errText(err) }; }
    }
    if (src.appId !== undefined) record.appId = textOf(src.appId).slice(0, MAX_APPID);
    record.updatedAt = now();
    const saved = save();
    if (!saved.ok) return saved;
    if (src.appSecret !== undefined) {
      const cred = setCredentials(record.id, { appId: record.appId, appSecret: src.appSecret });
      if (!cred.ok) return { ok: false, error: cred.error };
    }
    return { ok: true, bot: clone(record) };
  }

  function remove(id) {
    const key = textOf(id);
    if (state.bots.length <= 1) return { ok: false, error: '至少保留一个机器人' };
    const index = state.bots.findIndex((item) => item.id === key);
    if (index < 0) return { ok: false, error: '机器人不存在: ' + key };
    const [removed] = state.bots.splice(index, 1);
    if (state.activeBotId === key) state.activeBotId = state.bots[0].id;
    const saved = save();
    if (!saved.ok) { state.bots.splice(index, 0, removed); return saved; }
    return { ok: true, deleted: clone(removed) };
  }

  return {
    get workspaceRoot() { return root; },
    get file() { return file; },
    get maxBots() { return limit; },
    list: list,
    get: get,
    activeId: activeId,
    active: active,
    setActive: setActive,
    pathsOf: pathsOf,
    credentials: credentialsOf,
    setCredentials: setCredentials,
    create: create,
    update: update,
    remove: remove,
    /** 仅供诊断/测试：重新从磁盘加载。 */
    reload() { state = load(); return list(); },
  };
}

export default createBotRegistry;
