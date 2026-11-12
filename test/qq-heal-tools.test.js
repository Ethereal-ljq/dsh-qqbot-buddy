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

test('healTools：会话不存在时自动建一个（重启后第一条就是 /heal 的场景）', async () => {
  const botRuntime = makeBotRuntime({});
  const created = [];
  botRuntime.getOrCreate = async (peer) => {
    created.push(peer);
    const agent = {};
    const record = { peer, agent };
    botRuntime.sessions.set(peer, record);
    // 真实 createSession 里 buildSetup 会写 promptRefs；工具因此可见，无需再 force 补挂
    botRuntime.promptRefs.set(peer, {
      agentCtx: { tools: { view: () => ({ visible: new Map([['qqbot_send_file', 1], ['memory_search', 1]]) }) } },
      agent,
    });
    return record;
  };
  const adapter = createSessionAdapter({ botRuntime, logger: silentLogger });
  const result = await adapter.healTools('group', 'nope');
  assert.equal(result.ok, true, '应自动建会话而不是让用户先聊一句');
  assert.equal(result.created, true);
  assert.deepEqual(created, ['group:nope']);
  assert.equal(botRuntime.calls.length, 0, '新建时 setup 已挂过，不该重复 force 挂载');
});

test('healTools：建会话失败时给出可读原因', async () => {
  const botRuntime = makeBotRuntime({});
  botRuntime.getOrCreate = async () => { throw new Error('宿主未就绪'); };
  const adapter = createSessionAdapter({ botRuntime, logger: silentLogger });
  const result = await adapter.healTools('group', 'nope');
  assert.equal(result.ok, false);
  assert.match(result.reason, /创建会话失败/);
});

test('healTools：新建后仍看不到工具时强制补挂一次兜底', async () => {
  const botRuntime = makeBotRuntime({});
  botRuntime.getOrCreate = async (peer) => {
    const record = { peer, agent: {} };
    botRuntime.sessions.set(peer, record);
    return record;
  };
  const adapter = createSessionAdapter({ botRuntime, logger: silentLogger });
  const result = await adapter.healTools('group', 'empty');
  assert.equal(result.ok, true);
  assert.equal(botRuntime.calls.length, 1, '看不到工具时应 force 补挂兜底');
  assert.deepEqual(botRuntime.calls[0][1], { force: true });
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