/**
 * 宿主工具与被动激活的接线：refreshToolPolicy 按 activation 重放 restrict。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBotHost } from '../lib/host/agent.js';
import { setActivation, matchGroups } from '../lib/tools/activation.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };

async function makeHost() {
  const runtime = {
    paths: { workspaceRoot: '/tmp/qqbot-test-ws' },
    config: {
      listBots: () => [{ id: 'bot-a', enabled: true, appId: '1' }],
      getBot: () => ({ id: 'bot-a', enabled: true, appId: '1' }),
      getEffectiveSettings: () => ({ tools: { capabilities: { workspace: true, shell: true, web: true } } }),
    },
    logger: silentLogger,
  };
  return await createBotHost({ ctx: {}, runtime, config: {}, logger: silentLogger });
}

function viewOf() {
  return {
    visible: new Map([
      ['bash', { name: 'bash', description: '命令' }],
      ['read', { name: 'read', description: '读' }],
      ['web_search', { name: 'web_search', description: '搜' }],
    ]),
    knownNames: new Set(['bash', 'read', 'web_search']),
    restrictableNames: new Set(['bash', 'read', 'web_search']),
  };
}

test('refreshToolPolicy：被动宿主工具按激活集放进 allow，未激活只保留主动工具', async () => {
  const host = await makeHost();
  const inst = host.ensureRuntime('bot-a');
  const agent = {};
  const calls = [];
  const agentCtx = {
    tools: {
      view: viewOf,
      restrict: (filter) => { calls.push(filter.allow.slice()); return () => {}; },
    },
  };
  inst.promptRefs.set('group:G1', { agentCtx, agent });
  inst.sessions.set('group:G1', { peer: 'group:G1', agent, sessionId: 's' });

  const cold = await inst.refreshToolPolicy(agent);
  assert.deepEqual(cold.allow, ['web_search'], '冷启动只声明主动工具（web_search），被动工具不花 schema');

  // 路由命中「跑一下命令」→ shell 组
  const groups = matchGroups('跑一下命令看看磁盘', { tools: { capabilities: { shell: true } } });
  assert.deepEqual(groups, ['shell']);
  setActivation(inst, 'group:G1', { groups });
  const warm = await inst.refreshToolPolicy(agent);
  assert.deepEqual(warm.allow.slice().sort(), ['bash', 'web_search'], '激活后 bash 进入 allow');
  assert.equal(calls.length >= 2, true);
});

test('refreshToolPolicy：找不到会话时安静返回', async () => {
  const host = await makeHost();
  const inst = host.ensureRuntime('bot-a');
  const out = await inst.refreshToolPolicy({});
  assert.equal(out.applied, false);
  assert.deepEqual(out.allow, []);
});
