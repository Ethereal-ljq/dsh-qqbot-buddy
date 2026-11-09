/**
 * test/console-auth —— 鉴权内核单测：token 文件/哈希、会话、CSRF、限速。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { openDb, closeDb, all, get, run } from '../lib/core/db.js';
import {
  createConsoleAuth, hashSessionId, parseCookies, sessionCookie, clearSessionCookie,
  isCsrfValid, COOKIE_NAME,
} from '../lib/console/auth.js';
import { tempDir } from './console-helpers.js';

function setup(overrides = {}) {
  const dir = tempDir('qqbot-auth-');
  const db = openDb(path.join(dir, 'auth.db'));
  const dataDir = path.join(dir, 'data');
  const clock = { now: 1_000_000 };
  const auth = createConsoleAuth({ db, dataDir, now: () => clock.now, ...overrides });
  return {
    dir,
    db,
    dataDir,
    auth,
    clock,
    tokenPath: path.join(dataDir, 'console-token.txt'),
    cleanup() {
      closeDb(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('首次初始化生成 token：明文 0600、DB 只存 scrypt 哈希', () => {
  const ctx = setup();
  try {
    const info = ctx.auth.ensureToken();
    assert.equal(info.created, true);
    assert.ok(info.token.length >= 20);

    const fileToken = fs.readFileSync(ctx.tokenPath, 'utf8').trim();
    assert.equal(fileToken, info.token);
    assert.equal(fs.statSync(ctx.tokenPath).mode & 0o777, 0o600);

    const row = get(ctx.db, "SELECT hash FROM console_tokens WHERE id = 'console'");
    assert.ok(row);
    assert.match(row.hash, /^scrypt\$/);
    assert.ok(!row.hash.includes(info.token), 'DB 不应出现 token 明文');
    assert.equal(ctx.auth.verifyToken(info.token), true);
    assert.equal(ctx.auth.verifyToken('wrong-token'), false);
    assert.equal(ctx.auth.readToken(), info.token);
  } finally {
    ctx.cleanup();
  }
});

test('重复 ensureToken 不轮换、不覆盖已有 token 文件', () => {
  const ctx = setup();
  try {
    const first = ctx.auth.ensureToken();
    const statBefore = fs.statSync(ctx.tokenPath);
    const second = createConsoleAuth({ db: ctx.db, dataDir: ctx.dataDir });
    const info = second.ensureToken();
    assert.equal(info.token, first.token);
    assert.equal(info.created, false);
    assert.equal(fs.readFileSync(ctx.tokenPath, 'utf8').trim(), first.token);
    assert.equal(fs.statSync(ctx.tokenPath).mtimeMs, statBefore.mtimeMs, '已有 token 文件不应被重写');
  } finally {
    ctx.cleanup();
  }
});

test('部署配置传入 token：以配置为准并同步文件', () => {
  const ctx = setup({ token: 'deploy-configured-token' });
  try {
    const info = ctx.auth.ensureToken();
    assert.equal(info.token, 'deploy-configured-token');
    assert.equal(info.source, 'config');
    assert.equal(fs.readFileSync(ctx.tokenPath, 'utf8'), 'deploy-configured-token');
    assert.equal(fs.statSync(ctx.tokenPath).mode & 0o777, 0o600);
    assert.equal(ctx.auth.verifyToken('deploy-configured-token'), true);

    const before = fs.statSync(ctx.tokenPath).mtimeMs;
    createConsoleAuth({ db: ctx.db, dataDir: ctx.dataDir, token: 'deploy-configured-token' }).ensureToken();
    assert.equal(fs.statSync(ctx.tokenPath).mtimeMs, before, '重复启动不应覆盖明文文件');
  } finally {
    ctx.cleanup();
  }
});

test('token 文件丢失时轮换 token 并注销全部会话', () => {
  const ctx = setup();
  try {
    const first = ctx.auth.ensureToken();
    const session = ctx.auth.createSession({ ip: '127.0.0.1', userAgent: 'test' });
    assert.ok(ctx.auth.getSession(session.sid));

    fs.rmSync(ctx.tokenPath);
    const second = ctx.auth.ensureToken();
    assert.equal(second.rotated, true);
    assert.notEqual(second.token, first.token);
    assert.equal(ctx.auth.verifyToken(first.token), false);
    assert.equal(ctx.auth.verifyToken(second.token), true);
    assert.ok(fs.existsSync(ctx.tokenPath));
    assert.equal(ctx.auth.getSession(session.sid), null, '轮换后旧会话应失效');
  } finally {
    ctx.cleanup();
  }
});

test('会话只存 sha256(sid)，过期自动删除', () => {
  const ctx = setup({ sessionTtlMs: 1000 });
  try {
    ctx.auth.ensureToken();
    const session = ctx.auth.createSession({ ip: '10.0.0.1', userAgent: 'ua/1' });
    assert.equal(session.sid.length, 43);
    const row = get(ctx.db, 'SELECT * FROM console_sessions WHERE sid = ?', hashSessionId(session.sid));
    assert.ok(row, '应按 sha256(sid) 命中');
    const raw = all(ctx.db, 'SELECT sid FROM console_sessions');
    assert.equal(raw.length, 1);
    assert.notEqual(raw[0].sid, session.sid, 'DB 不应出现原始 sid');

    const found = ctx.auth.getSession(session.sid);
    assert.equal(found.ip, '10.0.0.1');
    assert.equal(found.userAgent, 'ua/1');
    assert.equal(ctx.auth.getSession('x'.repeat(43)), null);
    assert.equal(ctx.auth.getSession('bad'), null);

    ctx.clock.now += 1001;
    assert.equal(ctx.auth.getSession(session.sid), null, '过期会话应失效');
    assert.equal(all(ctx.db, 'SELECT sid FROM console_sessions').length, 0, '过期行应被删除');

    const destroyed = ctx.auth.createSession();
    assert.equal(ctx.auth.destroySession(destroyed.sid), true);
    assert.equal(ctx.auth.getSession(destroyed.sid), null);
  } finally {
    ctx.cleanup();
  }
});

test('登录失败限速 5 次/窗口，窗口过后恢复', () => {
  const ctx = setup({ rateLimit: { maxFailures: 5, windowMs: 60_000 } });
  try {
    for (let i = 0; i < 5; i += 1) {
      assert.equal(ctx.auth.checkRateLimit('1.2.3.4').allowed, true);
      ctx.auth.recordFailure('1.2.3.4');
    }
    const blocked = ctx.auth.checkRateLimit('1.2.3.4');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
    assert.equal(ctx.auth.checkRateLimit('5.6.7.8').allowed, true, '不同 IP 互不影响');

    ctx.clock.now += 60_001;
    assert.equal(ctx.auth.checkRateLimit('1.2.3.4').allowed, true, '窗口过后应恢复');

    ctx.auth.recordFailure('9.9.9.9');
    ctx.auth.clearFailures('9.9.9.9');
    assert.equal(ctx.auth.checkRateLimit('9.9.9.9').allowed, true, '登录成功应清零失败计数');
  } finally {
    ctx.cleanup();
  }
});

test('CSRF 判定与 Cookie 序列化', () => {
  assert.equal(isCsrfValid({ headers: { 'x-qqbot-csrf': '1' } }), true);
  assert.equal(isCsrfValid({ headers: { 'x-qqbot-csrf': '0' } }), false);
  assert.equal(isCsrfValid({ headers: {} }), false);

  const cookie = sessionCookie('abc123', { maxAgeMs: 7_200_000 });
  assert.match(cookie, new RegExp('^' + COOKIE_NAME + '=abc123'));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=7200/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.match(clearSessionCookie(), /Max-Age=0/);

  const parsed = parseCookies('a=1; ' + COOKIE_NAME + '=xyz; b=hello%20world');
  assert.equal(parsed.a, '1');
  assert.equal(parsed[COOKIE_NAME], 'xyz');
  assert.equal(parsed.b, 'hello world');
  assert.deepEqual(parseCookies(undefined), {});
});
