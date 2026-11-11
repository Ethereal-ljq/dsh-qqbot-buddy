/**
 * 工具自愈：重启后 resume 的会话可能丢插件工具（实测 36 -> 7）。
 *
 * 这里只测 ensureAgentTools 这一层：有标记就跳过、没标记就补挂、
 * 缺 toolFactory / agentCtx 时安静返回，绝不影响回复链路。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBotHost } from '../lib/host/agent.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };

async function makeHost(t) {
  const runtime = {
    paths: { workspaceRoot: '/tmp/qqbot-test-ws' },
    config: {
      listBots: () => [{ id: 'bot-a', enabled: true, appId: '1' }],
      getBot: () => ({ id: 'bot-a', enabled: true, appId: '1' }),
      getEffectiveSettings: () => ({}),
    },
    logger: silentLogger,
  };
  // createBotHost 是 async：必须 await，否则拿到的是 Promise 而不是 host
  return await createBotHost({ ctx: {}, runtime, config: {}, logger: silentLogger });
}

test('ensureAgentTools：没有标记时补挂一次并打标记', async (t) => {
  const host = await makeHost(t);
  const calls = [];
  host.setToolFactory(async (args) => { calls.push(args); });
  const inst = host.ensureRuntime('bot-a');
  const agentCtx = { tools: { register() {} } };
  inst.promptRefs.set('group:G1', { agentCtx, agent: {} });
  const agent = {};
  const record = { peer: 'group:G1', agent };

  const first = await inst.ensureAgentTools(record);
  assert.equal(first, true, '首次应补挂');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].peer, 'group:G1');

  const second = await inst.ensureAgentTools(record);
  assert.equal(second, false, '打过标记后不应重复补挂');
  assert.equal(calls.length, 1);
});

test('ensureAgentTools：缺 toolFactory / agentCtx / agent 时安静返回 false', async (t) => {
  const host = await makeHost(t);
  const inst = host.ensureRuntime('bot-a');
  // 没有 toolFactory
  assert.equal(await inst.ensureAgentTools({ peer: 'p', agent: {} }), false);
  // 有 toolFactory 但没有 agentCtx（promptRefs 未登记）
  host.setToolFactory(async () => {});
  assert.equal(await inst.ensureAgentTools({ peer: 'p', agent: {} }), false);
  // agent 缺失
  assert.equal(await inst.ensureAgentTools({ peer: 'p' }), false);
  assert.equal(await inst.ensureAgentTools(null), false);
});

test('ensureAgentTools：toolFactory 抛错时吞掉并返回 false（不影响回复）', async (t) => {
  const host = await makeHost(t);
  host.setToolFactory(async () => { throw new Error('挂载炸了'); });
  const inst = host.ensureRuntime('bot-a');
  inst.promptRefs.set('p', { agentCtx: { tools: {} }, agent: {} });
  assert.equal(await inst.ensureAgentTools({ peer: 'p', agent: {} }), false);
});

test('ensureAgentTools：补挂成功后同一个 agent 不会重复补挂', async (t) => {
  const host = await makeHost(t);
  let n = 0;
  host.setToolFactory(async () => { n += 1; });
  const inst = host.ensureRuntime('bot-a');
  inst.promptRefs.set('p', { agentCtx: { tools: {} }, agent: {} });
  const agent = {};
  await inst.ensureAgentTools({ peer: 'p', agent });
  await inst.ensureAgentTools({ peer: 'p', agent });
  await inst.ensureAgentTools({ peer: 'p', agent });
  assert.equal(n, 1);
});