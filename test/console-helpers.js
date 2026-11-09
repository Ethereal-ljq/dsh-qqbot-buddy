/**
 * test/console-helpers —— 控制台测试夹具（临时 DB + config store + 真实 HTTP 服务）。
 *
 * 注意：文件名不以 .test.js 结尾，不会被 node --test 当成测试文件直接执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { openDb, closeDb } from '../lib/core/db.js';
import { createConfigStore } from '../lib/core/config/store.js';
import { createConsoleServer } from '../lib/console/server.js';

/** 测试期静默日志。 */
export const QUIET_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

/** 建临时目录。 */
export function tempDir(prefix = 'qqbot-console-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 起一个完整的控制台测试实例。
 * @param {{webDist?: string, deps?: object, server?: object}} [options]
 */
export async function createHarness(options = {}) {
  const dir = tempDir();
  const db = openDb(path.join(dir, 'buddy.db'));
  const workspaceRoot = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const config = createConfigStore({ db, workspaceRoot });
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const dataDir = path.join(dir, 'data');
  const webDist = options.webDist || path.join(dir, 'web-dist');
  const deps = {
    db,
    config,
    events,
    paths: { dataDir, webDist },
    logger: QUIET_LOGGER,
  };
  // 允许测试用已打开的 db 构造真实服务（如 createKbStore({db})）
  if (typeof options.depsFactory === 'function') {
    Object.assign(deps, options.depsFactory({ db, config, events, dataDir, webDist }));
  }
  Object.assign(deps, options.deps || {});
  const server = createConsoleServer({
    deps,
    host: '127.0.0.1',
    port: 0,
    logger: QUIET_LOGGER,
    ...(options.server || {}),
  });
  await server.start();
  const address = server.address();
  const baseUrl = address.url;
  const tokenPath = path.join(dataDir, 'console-token.txt');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  let cookie = null;

  function readSetCookies(response) {
    if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
    const single = response.headers.get('set-cookie');
    return single ? [single] : [];
  }

  function absorbCookies(response) {
    for (const value of readSetCookies(response)) {
      const match = /qqbot_console_sid=([^;]*)/.exec(value);
      if (!match) continue;
      cookie = match[1] === '' ? null : 'qqbot_console_sid=' + match[1];
    }
  }

  /**
   * 发请求。
   * @param {string} method
   * @param {string} apiPath
   * @param {{body?: any, headers?: object, auth?: boolean, csrf?: boolean}} [opts]
   */
  async function request(method, apiPath, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    let body;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    if (opts.auth !== false && cookie) headers.Cookie = cookie;
    if (opts.csrf !== false && method !== 'GET' && method !== 'HEAD' && cookie) {
      headers['X-QQBot-CSRF'] = '1';
    }
    const response = await fetch(baseUrl + apiPath, { method, headers, body, redirect: 'manual' });
    const text = await response.text();
    let data = null;
    if (text !== '') {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    absorbCookies(response);
    return {
      status: response.status,
      headers: response.headers,
      data,
      text,
      setCookies: readSetCookies(response),
    };
  }

  /** 登录（默认用 token 文件里的 token）。 */
  function login(customToken = token) {
    return request('POST', '/api/auth/login', { body: { token: customToken }, auth: false });
  }

  /** 登录并断言成功，返回响应。 */
  async function loginOk(customToken = token) {
    const res = await login(customToken);
    if (res.status !== 200) throw new Error('测试登录失败: ' + res.status + ' ' + res.text);
    return res;
  }

  async function close() {
    try { await server.stop(); } catch { /* ignore */ }
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return {
    dir,
    db,
    config,
    events,
    server,
    address,
    baseUrl,
    token,
    tokenPath,
    dataDir,
    webDist,
    request,
    login,
    loginOk,
    close,
    get cookie() { return cookie; },
  };
}

/** 轮询等待条件成立（测试 SSE 等异步事件）。 */
export async function waitFor(check, timeoutMs = 2000, label = '条件') {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待超时: ' + label);
}
