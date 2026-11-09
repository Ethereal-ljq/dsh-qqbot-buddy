/**
 * test/console-actions —— POST /api/actions/:name 错误映射（task-12）。
 *
 * 契约：动作抛普通 Error → 400 {error:{code:err.code || 'action_failed', message:可读}}；
 * actions 未装配 → 501 not_implemented；成功 → 200 裸数据。
 * web-dev 的 task-10 依赖这些 code 做前端文案映射。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness } from './console-helpers.js';

/** 起一个挂载 deps.actions.run 的实例（run 省略 = 不装配 actions）。 */
async function harnessWithActions(run) {
  const h = await createHarness({ deps: run ? { actions: { run } } : {} });
  await h.loginOk();
  return h;
}

test('未知动作：普通 Error → 400 action_failed 且 message 透出', async (t) => {
  const h = await harnessWithActions(() => {
    throw new Error('未知动作: nope');
  });
  t.after(() => h.close());

  const res = await h.request('POST', '/api/actions/nope', { body: { botId: 'b1' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'action_failed');
  assert.match(res.data.error.message, /未知动作/);
});

test('带 code 的错误 → 400 且 code/message 原样透传（如 TIMEOUT）', async (t) => {
  const h = await harnessWithActions(() => {
    const err = new Error('抓取超时（8s）');
    err.code = 'TIMEOUT';
    throw err;
  });
  t.after(() => h.close());

  const res = await h.request('POST', '/api/actions/ingest-url', {
    body: { botId: 'b1', url: 'https://example.com/' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'TIMEOUT');
  assert.match(res.data.error.message, /抓取超时/);
});

test('actions 未装配 → 501 not_implemented', async (t) => {
  const h = await harnessWithActions(null);
  t.after(() => h.close());

  const res = await h.request('POST', '/api/actions/start-bot', { body: { botId: 'b1' } });
  assert.equal(res.status, 501);
  assert.equal(res.data.error.code, 'not_implemented');
});

test('成功路径 → 200 裸数据；返回 undefined 时兜底 {ok:true}', async (t) => {
  let last = null;
  const h = await harnessWithActions((name, body) => {
    last = { name, body };
    return name === 'noop' ? undefined : { ok: true, action: name, botId: body.botId };
  });
  t.after(() => h.close());

  const res = await h.request('POST', '/api/actions/start-bot', { body: { botId: 'b1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true, action: 'start-bot', botId: 'b1' });
  assert.deepEqual(last, { name: 'start-bot', body: { botId: 'b1' } });

  const noop = await h.request('POST', '/api/actions/noop', { body: {} });
  assert.equal(noop.status, 200);
  assert.deepEqual(noop.data, { ok: true });
});
