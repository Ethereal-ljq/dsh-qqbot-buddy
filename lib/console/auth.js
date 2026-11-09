/**
 * console/auth —— 控制台鉴权内核：token（scrypt）、会话（sha256(sid) 入库）、CSRF、登录限速。
 *
 * 设计契约（DESIGN-v2 §0.1 / §3）：
 * - 首次启动生成 128bit token：明文写 <dataDir>/console-token.txt（0600，可用 tokenFile 覆盖路径），
 *   DB console_tokens 只存 scrypt 哈希；部署 config 传入的 token 优先，重复启动不覆盖已有明文文件。
 * - 登录成功换 HttpOnly + SameSite=Strict 会话 cookie，DB console_sessions 存 sha256(sid)
 *   （即使数据库泄露也无法直接重放 cookie）。
 * - 非 GET 写操作要求 X-QQBot-CSRF: 1（自定义头跨站无法伪造）。
 * - 登录失败 5 次/5 分钟/IP 限速（进程内内存，控制台只跑在本机）。
 *
 * 本模块只依赖 node 内置模块与 core/db，不碰 HTTP 服务，便于单测。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { all, get, run } from '../core/db.js';

/** 会话 cookie 名。 */
export const COOKIE_NAME = 'qqbot_console_sid';
/** token 明文文件名（位于 dataDir 下；可用 tokenFile 覆盖完整路径）。 */
export const TOKEN_FILE_NAME = 'console-token.txt';
/** 默认会话有效期：7 天。 */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 默认登录失败限速：5 次 / 5 分钟 / IP。 */
export const DEFAULT_RATE_LIMIT = { maxFailures: 5, windowMs: 5 * 60 * 1000 };

const TOKEN_ROW_ID = 'console';
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 32;
const SALT_LEN = 16;
/** 32 字节随机数的 base64url 长度固定 43。 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** 同一会话 last_seen 最多每 60s 写一次库，避免每个请求都 WAL 落盘。 */
const LAST_SEEN_THROTTLE_MS = 60 * 1000;

/** sha256 十六进制（会话 sid 只以它的形式入库）。 */
export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** 生成 128bit 随机 token（base64url，22 字符）。 */
export function generateToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/** 生成会话 id（256bit 随机，base64url）。 */
export function generateSessionId() {
  return crypto.randomBytes(32).toString('base64url');
}

/** 会话 id → 入库哈希。 */
export function hashSessionId(sid) {
  return sha256(sid);
}

function scryptKey(secret, salt, { N, r, p }) {
  return crypto.scryptSync(Buffer.from(String(secret), 'utf8'), salt, KEY_LEN, {
    N, r, p, maxmem: Math.max(SCRYPT.maxmem, 128 * N * r * 2),
  });
}

/** token → scrypt$N$r$p$salt$hash（salt/hash 为 base64url）。 */
export function hashToken(secret) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = scryptKey(secret, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** 常量时间校验 scrypt 哈希；格式非法/异常一律 false。 */
export function verifyTokenHash(secret, stored) {
  if (typeof stored !== 'string' || stored === '') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 1024 || r < 1 || p < 1) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(Buffer.from(String(secret), 'utf8'), salt, expected.length, {
      N, r, p, maxmem: Math.max(SCRYPT.maxmem, 128 * N * r * 2),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 解析 Cookie 头为对象。 */
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (name === '') continue;
    const raw = part.slice(idx + 1).trim();
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  }
  return out;
}

/** 构造会话 Set-Cookie；本地 HTTP 默认不加 Secure（HTTPS 反代场景由调用方传 secure=true）。 */
export function sessionCookie(sid, { maxAgeMs = DEFAULT_SESSION_TTL_MS, secure = false } = {}) {
  const parts = [
    COOKIE_NAME + '=' + sid,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + Math.max(0, Math.floor(maxAgeMs / 1000)),
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 注销用 Set-Cookie（立即过期）。 */
export function clearSessionCookie() {
  return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

/** CSRF 校验：只认 X-QQBot-CSRF: 1。 */
export function isCsrfValid(req) {
  return req?.headers?.['x-qqbot-csrf'] === '1';
}

/**
 * 创建鉴权服务。
 * @param {object} options
 * @param {object} options.db DatabaseSync（必需）
 * @param {string} options.dataDir token 文件默认目录（必需）
 * @param {string} [options.tokenFile] token 明文完整路径（默认 dataDir/console-token.txt）
 * @param {string} [options.token] 部署配置里预置的 token（空串/未传时自动生成）
 * @param {{debug?:Function,info?:Function,warn?:Function,error?:Function}} [options.logger]
 * @param {() => number} [options.now] 时间源（测试注入）
 * @param {number} [options.sessionTtlMs] 会话有效期
 * @param {{maxFailures?:number, windowMs?:number}} [options.rateLimit]
 */
export function createConsoleAuth({
  db,
  dataDir,
  tokenFile = null,
  token: configuredToken = '',
  logger = null,
  now = Date.now,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  rateLimit = {},
} = {}) {
  if (!db) throw new Error('createConsoleAuth 需要 db');
  if (!dataDir) throw new Error('createConsoleAuth 需要 dataDir');

  const tokenPath = tokenFile ? path.resolve(tokenFile) : path.join(dataDir, TOKEN_FILE_NAME);
  const maxFailures = Math.max(1, Number(rateLimit.maxFailures ?? DEFAULT_RATE_LIMIT.maxFailures) || DEFAULT_RATE_LIMIT.maxFailures);
  const windowMs = Math.max(1000, Number(rateLimit.windowMs ?? DEFAULT_RATE_LIMIT.windowMs) || DEFAULT_RATE_LIMIT.windowMs);
  const configured = typeof configuredToken === 'string' ? configuredToken.trim() : '';
  /** ip → { count, firstAt }；仅内存，控制台重启后清零。 */
  const failures = new Map();
  let cachedToken = null;

  function log(level, message) {
    try { logger?.[level]?.(message); } catch { /* 日志失败不影响鉴权 */ }
  }

  function ensureDataDir() {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dataDir, 0o700); } catch { /* 非 POSIX 环境忽略 */ }
  }

  function readTokenFile() {
    try {
      const text = fs.readFileSync(tokenPath, 'utf8').trim();
      return text === '' ? null : text;
    } catch {
      return null;
    }
  }

  function writeTokenFile(token) {
    ensureDataDir();
    fs.writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600, flag: 'w' });
    try { fs.chmodSync(tokenPath, 0o600); } catch { /* 非 POSIX 环境忽略 */ }
  }

  function tokenRow() {
    return get(db, 'SELECT id, hash, created_at AS createdAt FROM console_tokens WHERE id = ?', TOKEN_ROW_ID);
  }

  function upsertTokenHash(token) {
    const stamp = now();
    if (tokenRow()) {
      run(db, 'UPDATE console_tokens SET hash = ?, created_at = ? WHERE id = ?', hashToken(token), stamp, TOKEN_ROW_ID);
    } else {
      run(db, 'INSERT INTO console_tokens(id, label, hash, created_at) VALUES(?,?,?,?)',
        TOKEN_ROW_ID, '控制台登录 token', hashToken(token), stamp);
    }
  }

  /** 明文文件与 DB 哈希是否都认可当前 token。 */
  function tokenMatches(token) {
    if (typeof token !== 'string' || token === '') return false;
    const row = tokenRow();
    return Boolean(row && verifyTokenHash(token, row.hash));
  }

  /** 部署配置传入 token 时：以它为准（变更则更新哈希、注销旧会话、同步明文文件）。 */
  function adoptConfiguredToken() {
    const fileToken = readTokenFile();
    const row = tokenRow();
    if (!row || !verifyTokenHash(configured, row.hash)) {
      upsertTokenHash(configured);
      destroyAllSessions();
      log('info', '[console] 已采用部署配置中的控制台 token（旧 token/会话已失效）');
    }
    if (fileToken !== configured) {
      writeTokenFile(configured);
      log('info', '[console] 已把部署配置 token 写入 ' + tokenPath);
    } else {
      try { fs.chmodSync(tokenPath, 0o600); } catch { /* ignore */ }
    }
    cachedToken = configured;
    return { token: configured, created: false, rotated: false, source: 'config' };
  }

  /**
   * 初始化 token（幂等）：
   * - 部署配置传了 token → 以配置为准；
   * - 明文文件与 DB 都在 → 直接复用，不覆盖文件；
   * - DB 有哈希、文件丢失 → 无法恢复明文，轮换 token 并注销全部会话；
   * - 只有文件（如重建 db）→ 采纳文件 token 并补哈希；
   * - 都没有 → 生成新 token 并写文件。
   * @returns {{token:string, created:boolean, rotated:boolean, source?:string}}
   */
  function ensureToken() {
    if (configured !== '') return adoptConfiguredToken();
    const fileToken = readTokenFile();
    const row = tokenRow();
    if (fileToken !== null && row) {
      cachedToken = fileToken;
      try { fs.chmodSync(tokenPath, 0o600); } catch { /* ignore */ }
      return { token: fileToken, created: false, rotated: false };
    }
    if (row && fileToken === null) {
      const token = generateToken();
      upsertTokenHash(token);
      writeTokenFile(token);
      destroyAllSessions();
      cachedToken = token;
      log('warn', '[console] token 明文文件丢失，已重新生成 token 并注销全部控制台会话');
      return { token, created: false, rotated: true };
    }
    if (!row && fileToken !== null) {
      upsertTokenHash(fileToken);
      cachedToken = fileToken;
      log('info', '[console] 采纳已有 token 文件并写入数据库哈希');
      return { token: fileToken, created: false, rotated: false };
    }
    const token = generateToken();
    upsertTokenHash(token);
    writeTokenFile(token);
    cachedToken = token;
    log('info', '[console] 已生成控制台登录 token，明文见 ' + tokenPath);
    return { token, created: true, rotated: false };
  }

  /** 读取当前 token 明文（供宿主设置页复制；读不到返回 null）。 */
  function readToken() {
    if (cachedToken === null) cachedToken = readTokenFile();
    return cachedToken;
  }

  /** 重置 token：生成新的、写文件、注销全部会话；返回新明文。 */
  function resetToken() {
    const token = generateToken();
    upsertTokenHash(token);
    writeTokenFile(token);
    destroyAllSessions();
    cachedToken = token;
    log('info', '[console] 控制台 token 已重置，全部会话已注销');
    return token;
  }

  /** 校验 token；命中时更新 last_used。 */
  function verifyToken(token) {
    if (typeof token !== 'string' || token.trim() === '') return false;
    let rows = [];
    try { rows = all(db, 'SELECT id, hash FROM console_tokens'); } catch { return false; }
    const clean = token.trim();
    let matched = null;
    for (const row of rows) {
      if (verifyTokenHash(clean, row.hash)) { matched = row; break; }
    }
    if (matched === null) return false;
    try { run(db, 'UPDATE console_tokens SET last_used = ? WHERE id = ?', now(), matched.id); } catch { /* ignore */ }
    return true;
  }

  /** 新建会话；返回原始 sid（只在这里出现，入库的是 sha256）。 */
  function createSession({ ip = '', userAgent = '' } = {}) {
    const sid = generateSessionId();
    const stamp = now();
    const expiresAt = stamp + sessionTtlMs;
    run(db, 'INSERT INTO console_sessions(sid, created_at, expires_at, last_seen, user_agent, ip) VALUES(?,?,?,?,?,?)',
      hashSessionId(sid), stamp, expiresAt, stamp, String(userAgent).slice(0, 500), String(ip).slice(0, 64));
    return { sid, createdAt: stamp, expiresAt };
  }

  /** 校验会话；过期自动删除；返回 null 表示未登录/已过期。 */
  function getSession(sid) {
    if (typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) return null;
    let row;
    try { row = get(db, 'SELECT * FROM console_sessions WHERE sid = ?', hashSessionId(sid)); } catch { return null; }
    if (!row) return null;
    const stamp = now();
    if (Number(row.expires_at) <= stamp) {
      try { run(db, 'DELETE FROM console_sessions WHERE sid = ?', row.sid); } catch { /* ignore */ }
      return null;
    }
    let lastSeen = Number(row.last_seen) || Number(row.created_at) || stamp;
    if (stamp - lastSeen > LAST_SEEN_THROTTLE_MS) {
      try { run(db, 'UPDATE console_sessions SET last_seen = ? WHERE sid = ?', stamp, row.sid); } catch { /* ignore */ }
      lastSeen = stamp;
    }
    return {
      createdAt: Number(row.created_at) || 0,
      expiresAt: Number(row.expires_at) || 0,
      lastSeen,
      ip: row.ip || '',
      userAgent: row.user_agent || '',
    };
  }

  /** 删除单个会话。 */
  function destroySession(sid) {
    if (typeof sid !== 'string' || sid === '') return false;
    const result = run(db, 'DELETE FROM console_sessions WHERE sid = ?', hashSessionId(sid));
    return Number(result?.changes || 0) > 0;
  }

  /** 删除全部会话（token 轮换/重置时用）。 */
  function destroyAllSessions() {
    try { run(db, 'DELETE FROM console_sessions'); } catch { /* ignore */ }
  }

  /** 清理过期会话（启动时调用）。 */
  function cleanupExpired() {
    try { run(db, 'DELETE FROM console_sessions WHERE expires_at <= ?', now()); } catch { /* ignore */ }
  }

  /** 登录限速检查（不写状态）。 */
  function checkRateLimit(ip) {
    const key = String(ip || 'unknown');
    const entry = failures.get(key);
    if (!entry) return { allowed: true, retryAfterMs: 0 };
    const stamp = now();
    if (stamp - entry.firstAt >= windowMs) {
      failures.delete(key);
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry.count >= maxFailures) {
      return { allowed: false, retryAfterMs: Math.max(0, windowMs - (stamp - entry.firstAt)) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** 记录一次登录失败。 */
  function recordFailure(ip) {
    const key = String(ip || 'unknown');
    const stamp = now();
    const entry = failures.get(key);
    if (!entry || stamp - entry.firstAt >= windowMs) {
      failures.set(key, { count: 1, firstAt: stamp });
    } else {
      entry.count += 1;
    }
  }

  /** 登录成功清零失败计数。 */
  function clearFailures(ip) {
    failures.delete(String(ip || 'unknown'));
  }

  return {
    tokenPath,
    sessionTtlMs,
    ensureToken,
    readToken,
    resetToken,
    verifyToken,
    tokenMatches,
    createSession,
    getSession,
    destroySession,
    destroyAllSessions,
    cleanupExpired,
    checkRateLimit,
    recordFailure,
    clearFailures,
  };
}
