/**
 * console-sessions —— 会话诊断接口：激活组/点名工具/声明工具/提示词字符。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, QUIET_LOGGER } from './console-helpers.js';

async function setupBot(h) {
  const bot = h.config.createBot({ name: '会话诊断机器人' });
  return bot;
}

test('GET /api/tools/sessions：缺 bot 400；无宿主时返回空集与说明', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();
  assert.equal((await h.request('GET', '/api/tools/sessions')).status, 400);
  const empty = await h.request('GET', '/api/tools/sessions?bot=bot-x');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.items, []);
  assert.equal(empty.data.count, 0);
  assert.match(String(empty.data.note), /没有运行中的会话|没有/);
});

test('GET /api/tools/sessions：按 peer 汇总激活状态（无 systemPrompt 时声明工具为空）', async (t) => {
  const fakeHost = {
    runtimeOf: () => ({
      sessions: new Map([
        ['group:1', { sessionId: 'qqbot-1', agent: {} }],
        ['c2c:2', { sessionId: 'qqbot-2', agent: {} }],
      ]),
      activation: new Map([
        ['group:1', { groups: new Set(['imagegen', 'voice']), tools: new Set(['read']) }],
      ]),
    }),
  };
  const h = await createHarness({ deps: { getHost: () => fakeHost, logger: QUIET_LOGGER } });
  t.after(() => h.close());
  await h.loginOk();
  const bot = await setupBot(h);
  const res = await h.request('GET', '/api/tools/sessions?bot=' + bot.id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.count, 2);
  const first = res.data.items.find((item) => item.peer === 'group:1');
  assert.deepEqual(first.groups, ['imagegen', 'voice']);
  assert.deepEqual(first.tools, ['read']);
  assert.equal(first.sessionId, 'qqbot-1');
  assert.equal(first.promptChars, 0, '没有 systemPrompt 服务时只给激活信息');
  const second = res.data.items.find((item) => item.peer === 'c2c:2');
  assert.deepEqual(second.groups, [], '没有激活记录的空会话');
});

test('GET /api/tools?bot=：按 bot 解析默认配置档（概览页用）', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();
  const bot = await setupBot(h);
  const res = await h.request('GET', '/api/tools?bot=' + bot.id);
  assert.equal(res.status, 200, res.text);
  assert.ok(res.data.profileId, '应解析出默认配置档');
  assert.ok(Array.isArray(res.data.items));
  assert.ok(Array.isArray(res.data.groups));
});
