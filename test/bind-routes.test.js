/**
 * test/bind-routes.test.js —— 扫码绑定 4 条 HTTP 路由的单测（假 binding service，不联网）。
 *
 * 覆盖：GET bind/state（bound/unbound/无服务）、POST refresh、manual 成功/校验失败/后端失败、
 * unbind 成功/失败、方法不允许 405、Origin 跨源 403、body 上限 413、secret 不回显、dispose。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  registerBindRoutes,
  BIND_STATE_PATH,
  BIND_REFRESH_PATH,
  BIND_MANUAL_PATH,
  BIND_UNBIND_PATH,
} from '../lib/web/bind-routes.js';
import { createFakeCtx } from './helpers/fake-ctx.js';

const HOST = '127.0.0.1:3099';

/** 假 binding service：记录调用次数，便于断言路由确实驱动了状态机。 */
function makeBinding(overrides = {}) {
  const calls = { wireState: 0, refresh: 0, manual: [], unbind: 0, isBound: 0 };
  const state = {
    phase: 'waiting',
    appId: '',
    url: 'https://q.qq.com/qqbot/connect?token=abc',
    qrSvg: 'data:image/svg+xml;base64,PHN2Zy8+',
    issuedAt: 1761300000000,
    // 故意塞一个 secret，验证路由层白名单投影不会回显
    appSecret: 'SECRET-SHOULD-NOT-LEAK',
  };
  const binding = {
    wireState() {
      calls.wireState += 1;
      return { ...state };
    },
    refresh() {
      calls.refresh += 1;
      state.phase = 'waiting';
    },
    async manual(appId, appSecret) {
      calls.manual.push({ appId, appSecret });
      return { ok: true, message: '凭据已保存' };
    },
    async unbind() {
      calls.unbind += 1;
      return { ok: true, message: '已解绑' };
    },
    isBound() {
      calls.isBound += 1;
      return false;
    },
  };
  const patch = typeof overrides === 'function' ? overrides(binding, state, calls) : overrides;
  Object.assign(binding, patch || {});
  return { binding, calls, state };
}

/** 极简 EventEmitter 风格 req + 记录型 res。 */
function makeReqRes({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers: { host: HOST, ...headers },
    resumed: false,
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return req;
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) listener(...args);
    },
    resume() {
      req.resumed = true;
    },
  };
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    headersSent: false,
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value;
    },
    writeHead(code, extra) {
      res.statusCode = code;
      res.headersSent = true;
      for (const [name, value] of Object.entries(extra || {})) res.setHeader(name, value);
      return res;
    },
    end(payload) {
      if (payload !== undefined) chunks.push(String(payload));
      res.writableEnded = true;
      return res;
    },
    get text() {
      return chunks.join('');
    },
    get json() {
      try {
        return JSON.parse(chunks.join('') || '{}');
      } catch {
        return null;
      }
    },
  };
  return { req, res, body };
}

/** 注册路由 + 提供 call(method, path, opts) 帮助函数。 */
function makeApp({ binding = null, runtime } = {}) {
  const ctx = createFakeCtx({});
  // 与真实 Cordis 一致：webServer 既是 ctx.webServer 也可以通过 ctx.get('webServer') 取得。
  ctx.set('webServer', ctx.webServer);
  const logger = ctx.logger;
  const dispose = registerBindRoutes(ctx, { binding, runtime: runtime || { logger } });
  const call = async (method, path, options = {}) => {
    const route = ctx.webServer.routes.find((item) => item.kind === 'exact' && item.path === path);
    assert.ok(route, '路由未注册: ' + path);
    const { req, res } = makeReqRes({ method, url: path, headers: options.headers, body: options.body });
    const pending = route.handler(req, res);
    if (options.rawBody !== undefined) {
      req.emit('data', Buffer.from(options.rawBody));
      req.emit('end');
    } else if (options.body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(options.body)));
      req.emit('end');
    }
    await pending;
    return res;
  };
  return {
    ctx,
    dispose,
    /** 动态读取（dispose 后应为空）。 */
    get routes() {
      return ctx.webServer.routes;
    },
    call,
    logger,
  };
}

const JSON_HEADERS = (res) => {
  assert.match(String(res.headers['content-type'] || ''), /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
};

test('注册：4 条 exact 路由，dispose 幂等且清理路由', () => {
  const app = makeApp({ binding: makeBinding().binding });
  const paths = app.routes.map((route) => route.path).sort();
  assert.deepEqual(paths, [BIND_STATE_PATH, BIND_MANUAL_PATH, BIND_REFRESH_PATH, BIND_UNBIND_PATH].sort());
  app.dispose();
  assert.equal(app.routes.length, 0);
  assert.doesNotThrow(() => app.dispose());
});

test('GET bind/state：未绑定态返回 wireState 投影，且 secret 不回显', async () => {
  const { binding, calls } = makeBinding();
  const app = makeApp({ binding });
  const res = await app.call('GET', BIND_STATE_PATH);
  assert.equal(res.statusCode, 200);
  JSON_HEADERS(res);
  assert.equal(calls.isBound, 1);
  assert.ok(calls.wireState >= 1);
  const body = res.json;
  assert.equal(body.ok, true);
  assert.equal(body.phase, 'waiting');
  assert.equal(body.appId, '');
  assert.equal(body.url, 'https://q.qq.com/qqbot/connect?token=abc');
  assert.equal(body.qrSvg, 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(body.issuedAt, 1761300000000);
  assert.equal('appSecret' in body, false, 'appSecret 绝不能出现在响应里');
  assert.equal(res.text.includes('SECRET-SHOULD-NOT-LEAK'), false);
});

test('GET bind/state：已绑定强制 phase=bound 并回显 appId', async () => {
  const { binding } = makeBinding((_b, _state, _calls) => ({
    isBound: () => true,
    wireState: () => ({ phase: 'bound', appId: '1904000123', appSecret: 'SECRET-SHOULD-NOT-LEAK' }),
  }));
  const app = makeApp({ binding });
  const res = await app.call('GET', BIND_STATE_PATH);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.phase, 'bound');
  assert.equal(res.json.appId, '1904000123');
  assert.equal('appSecret' in res.json, false);
  assert.equal(res.text.includes('SECRET-SHOULD-NOT-LEAK'), false);
});

test('GET bind/state：无 binding 服务时返回 idle，不报错', async () => {
  const app = makeApp({ binding: null });
  const res = await app.call('GET', BIND_STATE_PATH);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json, { ok: true, phase: 'idle' });
});

test('GET bind/state：isBound 抛错时兜底 500 JSON，不抛回宿主', async () => {
  const { binding } = makeBinding(() => ({
    isBound() {
      throw new Error('patch 读取失败');
    },
  }));
  const app = makeApp({ binding });
  const res = await app.call('GET', BIND_STATE_PATH);
  assert.equal(res.statusCode, 500);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /patch 读取失败/);
});

test('POST bind/refresh：调用 refresh 并返回 ok，无 binding 时 503', async () => {
  const { binding, calls } = makeBinding();
  const app = makeApp({ binding });
  const res = await app.call('POST', BIND_REFRESH_PATH);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json, { ok: true });
  assert.equal(calls.refresh, 1);

  const noService = makeApp({ binding: null });
  const res503 = await noService.call('POST', BIND_REFRESH_PATH);
  assert.equal(res503.statusCode, 503);
  assert.equal(res503.json.ok, false);
});

test('POST bind/refresh：refresh 抛错时 500 JSON', async () => {
  const { binding } = makeBinding(() => ({
    refresh() {
      throw new Error('二维码生成失败');
    },
  }));
  const app = makeApp({ binding });
  const res = await app.call('POST', BIND_REFRESH_PATH);
  assert.equal(res.statusCode, 500);
  assert.match(res.json.error, /二维码生成失败/);
});

test('POST bind/manual：成功时把 trim 后的凭据交给 binding', async () => {
  const { binding, calls } = makeBinding();
  const app = makeApp({ binding });
  const res = await app.call('POST', BIND_MANUAL_PATH, {
    body: { appId: '  1904000123  ', appSecret: '  s3cret  ' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json, { ok: true, message: '凭据已保存' });
  assert.deepEqual(calls.manual, [{ appId: '1904000123', appSecret: 's3cret' }]);
});

test('POST bind/manual：缺字段/超长 → 400，且不调用 binding.manual', async () => {
  const { binding, calls } = makeBinding();
  const app = makeApp({ binding });
  const cases = [
    {},
    { appId: '1904' },
    { appSecret: 's' },
    { appId: 'x'.repeat(129), appSecret: 's' },
    { appId: '124', appSecret: 's'.repeat(257) },
    { appId: 123, appSecret: 's' },
  ];
  for (const body of cases) {
    const res = await app.call('POST', BIND_MANUAL_PATH, { body });
    assert.equal(res.statusCode, 400, '应拒绝: ' + JSON.stringify(body));
    assert.equal(res.json.ok, false);
    assert.equal(typeof res.json.error, 'string');
  }
  assert.deepEqual(calls.manual, []);
});

test('POST bind/manual：非法 JSON → 400；超过 8KB → 413', async () => {
  const { binding } = makeBinding();
  const app = makeApp({ binding });
  const bad = await app.call('POST', BIND_MANUAL_PATH, { rawBody: '{not-json' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json.ok, false);

  const huge = await app.call('POST', BIND_MANUAL_PATH, {
    rawBody: JSON.stringify({ appId: '1', appSecret: 's'.repeat(9 * 1024) }),
  });
  assert.equal(huge.statusCode, 413);
  assert.equal(huge.json.ok, false);
});

test('POST bind/manual：binding 返回失败时按类型映射 400/500，不泄漏 secret', async () => {
  const { binding } = makeBinding(() => ({
    async manual() {
      return { ok: false, error: 'appSecret 过长' };
    },
  }));
  const app = makeApp({ binding });
  const res = await app.call('POST', BIND_MANUAL_PATH, { body: { appId: '124', appSecret: 's' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);

  const failing = makeBinding(() => ({
    async manual() {
      return { ok: false, error: '写 profile 失败' };
    },
  }));
  const app2 = makeApp({ binding: failing.binding });
  const res2 = await app2.call('POST', BIND_MANUAL_PATH, { body: { appId: '124', appSecret: 's3cret-value' } });
  assert.equal(res2.statusCode, 500);
  assert.equal(res2.text.includes('s3cret-value'), false, '响应体不得回显 appSecret');

  const throwing = makeBinding(() => ({
    async manual() {
      throw new Error('磁盘只读');
    },
  }));
  const app3 = makeApp({ binding: throwing.binding });
  const res3 = await app3.call('POST', BIND_MANUAL_PATH, { body: { appId: '124', appSecret: 's' } });
  assert.equal(res3.statusCode, 500);
  assert.match(res3.json.error, /磁盘只读/);
});

test('POST bind/unbind：成功调用 unbind；失败/抛错有 JSON 兜底', async () => {
  const ok = makeBinding();
  const app = makeApp({ binding: ok.binding });
  const res = await app.call('POST', BIND_UNBIND_PATH);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(ok.calls.unbind, 1);

  const fail = makeBinding(() => ({
    async unbind() {
      return { ok: false, error: '删除凭据失败' };
    },
  }));
  const app2 = makeApp({ binding: fail.binding });
  const res2 = await app2.call('POST', BIND_UNBIND_PATH);
  assert.equal(res2.statusCode, 500);
  assert.equal(res2.json.ok, false);

  const noService = makeApp({ binding: null });
  const res3 = await noService.call('POST', BIND_UNBIND_PATH);
  assert.equal(res3.statusCode, 503);
});

test('方法不允许：GET 访问 POST 接口 → 405 且带 Allow 头', async () => {
  const app = makeApp({ binding: makeBinding().binding });
  for (const path of [BIND_REFRESH_PATH, BIND_MANUAL_PATH, BIND_UNBIND_PATH]) {
    const res = await app.call('GET', path);
    assert.equal(res.statusCode, 405, path + ' GET 应 405');
    assert.equal(res.json.ok, false);
    assert.equal(res.headers.allow, 'POST');
  }
  // 反向：POST /bind/state → 405
  const stateRes = await app.call('POST', BIND_STATE_PATH);
  assert.equal(stateRes.statusCode, 405);
  assert.equal(stateRes.headers.allow, 'GET');
});

test('Origin 跨源 → 403（所有 4 条路由）；同源 Origin 放行', async () => {
  const app = makeApp({ binding: makeBinding().binding });
  const evil = { host: HOST, origin: 'http://evil.example' };
  for (const [method, path] of [
    ['GET', BIND_STATE_PATH],
    ['POST', BIND_REFRESH_PATH],
    ['POST', BIND_MANUAL_PATH],
    ['POST', BIND_UNBIND_PATH],
  ]) {
    const res = await app.call(method, path, { headers: evil, body: { appId: '124', appSecret: 's' } });
    assert.equal(res.statusCode, 403, path + ' 跨源应 403');
    assert.deepEqual(res.json, { ok: false, error: 'forbidden' });
  }
  const sameOrigin = { host: HOST, origin: 'http://' + HOST };
  const ok = await app.call('GET', BIND_STATE_PATH, { headers: sameOrigin });
  assert.equal(ok.statusCode, 200);
  // 非法 Origin 字符串同样拒绝
  const bad = await app.call('GET', BIND_STATE_PATH, { headers: { host: HOST, origin: 'not a url' } });
  assert.equal(bad.statusCode, 403);
});

test('HEAD bind/state 按 GET 处理；响应 no-store', async () => {
  const app = makeApp({ binding: makeBinding().binding });
  const res = await app.call('HEAD', BIND_STATE_PATH);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
});