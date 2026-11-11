/**
 * session-adapter.healTools（/heal 与控制台按钮共用）。
 *
 * 必须是 force 语义：即使 agent 上有「已挂载」标记也要重挂，
 * 否则手动自愈会变成空操作——这正是用户最需要它的时候。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionAdapter } from '../lib/qq/session-adapter.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };

function makeBotRuntime({ record, ensureImpl } = {}) {
  const sessions = new Map();
  if (record) sessions.set(record.peer, record);
  const calls = [];
  return {
    calls,
    sessions,
    promptRefs: new Map(),
    async ensureAgentTools(rec, options) {
      calls.push([rec, options]);
      if (ensureImpl) return ensureImpl(rec, options);
      return true;
    },
  };
}

test('healTools：强制重挂（force=true），忽略已挂载标记', async () => {
  const record = { peer: 'group:g1', agent: {} };
  const botRuntime = makeBotRuntime({ record });
  const adapter = createSessionAdapter({ botRuntime, logger: silentLogger });
  const result = await adapter.healTools('group', 'g1');
  assert.equal(result.ok, true);
  assert.equal(botRuntime.calls.length, 1);
  assert.deepEqual(botRuntime.calls[0][1], { force: true }, '手动自愈必须是 force 语义');
});

test('healTools：会话不存在时给出可读原因而不是抛错', async () => {
  const botRuntime = makeBotRuntime({});
  const adapter = createSessionAdapter({ botRuntime, logger: silentLogger });
  const result = await adapter.healTools('group', 'nope');
  assert.equal(result.ok, false);
  assert.match(result.reason, /先聊一句/);
  assert.equal(botRuntime.calls.length, 0);
});

test('healTools：非法会话标识直接拒绝', async () => {
  const botRuntime = makeBotRuntime({});
  const adapter = createSessionAdapter({ botRuntime, logger: silentLogger });
  const result = await adapter.healTools('', '');
  assert.equal(result.ok, false);
  assert.match(result.reason, /非法会话/);
});

test('healTools：旧 BotRuntime 没有 ensureAgentTools 时降级提示', async () => {
  const record = { peer: 'group:g1', agent: {} };
  const botRuntime = { sessions: new Map([['group:g1', record]]), promptRefs: new Map() };
  const adapter = createSessionAdapter({ botRuntime, logger: silentLogger });
  const result = await adapter.healTools('group', 'g1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /不支持/);
});

test('healTools：重挂未执行时返回 ok:false 而不是假成功', async () => {
  const record = { peer: 'group:g1', agent: {} };
  const botRuntime = makeBotRuntime({ record, ensureImpl: async () => false });
  const adapter = createSessionAdapter({ botRuntime, logger: silentLogger });
  const result = await adapter.healTools('group', 'g1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /不可用/);
});