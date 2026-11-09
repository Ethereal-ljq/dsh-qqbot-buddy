/**
 * test/console-server —— 控制台 HTTP 集成测试：health/鉴权/CSRF/state/错误/静态占位/SSE。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createHarness, waitFor } from './console-helpers.js';

test('health 无鉴权 200，并回显 X-Request-Id', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const res = await h.request('GET', '/api/health', { headers: { 'x-request-id': 'req-fixed-1' } });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(typeof res.data.version, 'string');
  assert.ok(res.data.version.length > 0);
  assert.equal(typeof res.data.startedAt, 'number');
  assert.ok(res.data.uptimeMs >= 0);
  assert.equal(res.data.online, false);
  assert.equal(res.headers.get('x-request-id'), 'req-fixed-1');

  const generated = await h.request('GET', '/api/health');
  assert.match(String(generated.headers.get('x-request-id')), /^[0-9a-f-]{36}$/);
});

test('未登录访问受保护接口返回 401 统一错误', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  for (const [method, endpoint] of [
    ['GET', '/api/state'],
    ['GET', '/api/bots'],
    ['GET', '/api/profiles'],
    ['GET', '/api/settings'],
    ['GET', '/api/auth/session'],
    ['GET', '/api/events'],
  ]) {
    const res = await h.request(method, endpoint, { auth: false });
    assert.equal(res.status, 401, endpoint + ' 应 401');
    assert.equal(res.data.error.code, 'unauthorized', endpoint + ' 错误码');
    assert.equal(typeof res.data.error.message, 'string');
    assert.ok(res.data.error.requestId, endpoint + ' 错误应带 requestId');
  }
});

test('登录失败 401；成功换 HttpOnly + SameSite=Strict 会话 cookie', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const bad = await h.login('wrong-token');
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error.code, 'invalid_token');
  assert.equal(bad.setCookies.length, 0);

  const empty = await h.login('');
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error.code, 'invalid_token');

  const ok = await h.login();
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  assert.equal(typeof ok.data.expiresAt, 'number');
  const setCookie = ok.setCookies.join(';');
  assert.match(setCookie, /qqbot_console_sid=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);

  const session = await h.request('GET', '/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.data.authenticated, true);
  assert.ok(session.data.expiresAt > 0);
  assert.equal(typeof session.data.createdAt, 'number');
});

test('state 快照：bots/profiles/bindings/console/runtime 形状', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();

  const created = await h.request('POST', '/api/bots', { body: { name: '测试机器人', appId: '10001' } });
  assert.equal(created.status, 200);
  const bot = created.data;

  const state = await h.request('GET', '/api/state');
  assert.equal(state.status, 200);
  const data = state.data;
  assert.equal(typeof data.version, 'string');
  assert.equal(data.console.host, '127.0.0.1');
  assert.equal(data.console.port, h.address.port);
  assert.ok(data.console.uptimeMs >= 0);
  assert.equal(data.uptime, data.console.uptimeMs);
  assert.ok(Array.isArray(data.bots));
  assert.equal(data.bots.length, 1);
  assert.equal(data.bots[0].id, bot.id);
  assert.equal(data.bots[0].appSecret, '');
  assert.ok(Array.isArray(data.profiles));
  assert.equal(data.profiles.length, 1);
  assert.equal(data.profiles[0].isDefault, true);
  assert.equal(data.activeProfiles[bot.id], data.profiles[0].id);
  assert.deepEqual(data.bindings, []);
  assert.equal(typeof data.runtime.online, 'boolean');
  assert.equal(data.runtime.online, false);
  assert.deepEqual(data.runtime.bots, {});
});

test('非 GET 缺 X-QQBot-CSRF 返回 403，带上后成功', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();

  const noCsrf = await h.request('POST', '/api/bots', { body: { name: '缺CSRF' }, csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.error.code, 'csrf_required');

  const wrongValue = await h.request('POST', '/api/bots', {
    body: { name: '错CSRF' },
    csrf: false,
    headers: { 'x-qqbot-csrf': '0' },
  });
  assert.equal(wrongValue.status, 403);

  const ok = await h.request('POST', '/api/bots', { body: { name: '带CSRF' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.id);
});

test('注销后 cookie 失效', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();

  const out = await h.request('POST', '/api/auth/logout', { body: {} });
  assert.equal(out.status, 200);
  assert.equal(out.data.ok, true);
  assert.ok(out.setCookies.some((value) => /Max-Age=0/.test(value)));
  assert.equal(h.cookie, null);

  const state = await h.request('GET', '/api/state', { auth: false });
  assert.equal(state.status, 401);
});

test('未知接口 404 / 方法不匹配 405，错误格式统一', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();

  const notFound = await h.request('GET', '/api/not-exist');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.data.error.code, 'not_found');

  const wrongMethod = await h.request('DELETE', '/api/health');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.data.error.code, 'method_not_allowed');
  assert.match(String(wrongMethod.headers.get('allow')), /GET/);

  const badJson = await h.request('POST', '/api/bots', {
    body: '{not-json',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.data.error.code, 'invalid_json');
});

test('静态占位页：web/dist 未构建时提示 npm run console:build', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const root = await h.request('GET', '/', { auth: false });
  assert.equal(root.status, 200);
  assert.match(String(root.headers.get('content-type')), /text\/html/);
  assert.match(root.text, /console:build/);

  const spa = await h.request('GET', '/dashboard', { auth: false });
  assert.equal(spa.status, 200);
  assert.match(spa.text, /前端尚未构建/);

  const post = await h.request('POST', '/some/page', { body: {}, auth: false, csrf: false });
  assert.equal(post.status, 405);
  assert.equal(post.data.error.code, 'method_not_allowed');
});

test('Host 头校验：非本机主机名 403（防 DNS rebinding）', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const target = new URL(h.baseUrl);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: '/api/health',
      headers: { host: 'evil.example.com' },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('SSE：登录后收到 hello 并转发事件，断开后服务仍正常', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const anon = await fetch(h.baseUrl + '/api/events');
  assert.equal(anon.status, 401);
  await anon.text();

  await h.loginOk();
  const target = new URL(h.baseUrl);
  const chunks = [];
  let response = null;
  const req = http.get({
    hostname: target.hostname,
    port: target.port,
    path: '/api/events',
    headers: { cookie: h.cookie },
  }, (res) => {
    response = res;
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
    res.setEncoding('utf8');
    res.on('data', (chunk) => chunks.push(chunk));
  });
  req.on('error', () => {});
  t.after(() => { try { req.destroy(); } catch { /* ignore */ } });

  await waitFor(() => chunks.join('').includes('event: hello'), 3000, 'SSE hello');
  h.events.emit('log', { level: 'info', message: '集成测试日志' });
  await waitFor(() => chunks.join('').includes('event: log'), 3000, 'SSE log');
  assert.match(chunks.join(''), /集成测试日志/);

  req.destroy();
  if (response) response.destroy();
  // 给服务端一点时间处理断连，再确认服务未受影响
  await new Promise((resolve) => setTimeout(resolve, 50));
  const health = await h.request('GET', '/api/health');
  assert.equal(health.status, 200);
});

test('并发请求 + 两个 SSE 断开后事件监听数无泄漏', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();

  const baselineLog = h.events.listenerCount('log');
  const baselineStatus = h.events.listenerCount('bot/status');
  assert.equal(baselineLog, 1, 'hub 创建后应只有一个 log 监听');
  assert.equal(baselineStatus, 1);

  const target = new URL(h.baseUrl);
  const responses = [];
  let connected = 0;
  for (let i = 0; i < 2; i += 1) {
    const req = http.get({
      hostname: target.hostname,
      port: target.port,
      path: '/api/events',
      headers: { cookie: h.cookie },
    }, (res) => {
      connected += 1;
      res.resume();
      responses.push(res);
    });
    req.on('error', () => {});
    t.after(() => { try { req.destroy(); } catch { /* ignore */ } });
  }
  await waitFor(() => connected === 2, 3000, '两个 SSE 连接建立');

  const results = await Promise.all(Array.from({ length: 20 }, () => h.request('GET', '/api/state')));
  for (const res of results) {
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.bots));
  }

  for (const res of responses) res.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(h.events.listenerCount('log'), baselineLog, 'SSE 断开后 log 监听数应回到基线');
  assert.equal(h.events.listenerCount('bot/status'), baselineStatus, 'SSE 断开后 bot/status 监听数应回到基线');
  h.events.emit('log', { message: '断开后广播不应抛错' });
  const state = await h.request('GET', '/api/state');
  assert.equal(state.status, 200);
});
