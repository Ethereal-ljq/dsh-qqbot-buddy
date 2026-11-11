/**
 * test/console-memory-health —— GET /api/memories/health（直读 job_state 的记忆提炼状态）。
 *
 * 覆盖：字段归一（含旧数据缺少 P0 字段）、按 updated_at 倒序、bot 过滤、limit、坏 JSON 降级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness } from './console-helpers.js';

/** 直接往 job_state 写一行（模拟 collector 的持久化结果）。 */
function insertJobState(h, { botId, peer, value, updatedAt, job = 'memory-collect' }) {
  h.db.prepare(
    'INSERT INTO job_state(bot_id, peer, job, value, updated_at) VALUES(?,?,?,?,?)',
  ).run(botId, peer, job, typeof value === 'string' ? value : JSON.stringify(value), updatedAt);
}

test('memories/health：直读 job_state，按 updated_at 倒序并归一字段', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();

  insertJobState(h, {
    botId: 'bot-a',
    peer: 'group:2',
    value: { rounds: 0, lastRunAt: 3000, lastSaved: 2, lastOutcome: 'saved', lastReason: '', lastFacts: 2, failureCount: 0 },
    updatedAt: 2000,
  });
  insertJobState(h, {
    botId: 'bot-a',
    peer: 'group:1',
    value: {
      rounds: 3, lastRunAt: 2000, lastSaved: 0,
      lastOutcome: 'parse-empty', lastReason: '模型未产出可用事实', lastFacts: 0, failureCount: 1,
    },
    updatedAt: 1000,
  });
  // 旧数据：修复前没有 outcome/failureCount 字段
  insertJobState(h, { botId: 'bot-a', peer: 'c2c:1', value: { rounds: 5, lastRunAt: 1500, lastSaved: 0 }, updatedAt: 500 });
  // 干扰项：别的 job、别的 bot
  insertJobState(h, { botId: 'bot-a', peer: '', job: 'sticker-send', value: { count: 1 }, updatedAt: 1900 });
  insertJobState(h, {
    botId: 'bot-b',
    peer: 'group:9',
    value: { rounds: 0, lastRunAt: 4000, lastOutcome: 'llm-error', lastReason: '模型调用超时', failureCount: 2 },
    updatedAt: 1500,
  });

  const res = await h.request('GET', '/api/memories/health?bot=bot-a');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.data.map((row) => row.peer), ['group:2', 'group:1', 'c2c:1']);

  assert.deepEqual(res.data[0], {
    botId: 'bot-a',
    peer: 'group:2',
    rounds: 0,
    lastRunAt: 3000,
    lastSaved: 2,
    lastOutcome: 'saved',
    lastReason: '',
    lastFacts: 2,
    failureCount: 0,
    updatedAt: 2000,
  });

  const failed = res.data[1];
  assert.equal(failed.lastOutcome, 'parse-empty');
  assert.equal(failed.lastReason, '模型未产出可用事实');
  assert.equal(failed.failureCount, 1);
  assert.equal(failed.rounds, 3);

  // 旧数据缺 P0 字段：结局为空、失败清零，但仍能读出轮次/时间
  const legacy = res.data[2];
  assert.equal(legacy.lastOutcome, '');
  assert.equal(legacy.lastReason, '');
  assert.equal(legacy.lastFacts, 0);
  assert.equal(legacy.failureCount, 0);
  assert.equal(legacy.rounds, 5);
  assert.equal(legacy.lastRunAt, 1500);

  // 不传 bot：跨 bot 合并，仍按 updated_at 倒序；sticker-send 不混入
  const all = await h.request('GET', '/api/memories/health');
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(all.data.map((row) => row.peer), ['group:2', 'group:9', 'group:1', 'c2c:1']);

  // limit 生效
  const limited = await h.request('GET', '/api/memories/health?bot=bot-a&limit=2');
  assert.equal(limited.status, 200, limited.text);
  assert.deepEqual(limited.data.map((row) => row.peer), ['group:2', 'group:1']);

  // 无记录时返回空数组（不是 404）
  const empty = await h.request('GET', '/api/memories/health?bot=bot-none');
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.data, []);
});

test('memories/health：坏 JSON / 非对象 value 降级为空状态；未登录 401', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();

  insertJobState(h, { botId: 'bot-a', peer: 'group:bad', value: 'not-json', updatedAt: 300 });
  insertJobState(h, { botId: 'bot-a', peer: 'group:arr', value: '[1,2,3]', updatedAt: 200 });

  const res = await h.request('GET', '/api/memories/health?bot=bot-a');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.length, 2);
  for (const row of res.data) {
    assert.equal(row.lastOutcome, '');
    assert.equal(row.rounds, 0);
    assert.equal(row.lastRunAt, null);
    assert.equal(row.failureCount, 0);
  }

  const unauth = await h.request('GET', '/api/memories/health?bot=bot-a', { auth: false });
  assert.equal(unauth.status, 401);
});
