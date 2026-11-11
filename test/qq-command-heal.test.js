/**
 * /heal 命令 + heal-tools 控制台动作（手动自愈）。
 *
 * 背景：服务重启后部分被 resume 的会话会丢掉插件工具（实测 36 -> 7），
 * 模型于是说「这轮没挂工具」。自动自愈在每轮投递前兜底，
 * 这两个入口让用户能立即手动修复：QQ 里发 /heal，或控制台点按钮。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMAND_CATALOG, handleCommand } from '../lib/qq/commands.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };

function makeManager({ healResult, throws = false, calls = [] } = {}) {
  return {
    calls,
    async healTools(scope, peerId) {
      calls.push([scope, peerId]);
      if (throws) throw new Error('重挂炸了');
      return healResult;
    },
  };
}

test('COMMAND_CATALOG 里有 /heal，且是管理员命令', () => {
  const item = COMMAND_CATALOG.find((entry) => entry.name === 'heal');
  assert.ok(item, '/heal 必须在命令目录里（/help 才能展示）');
  assert.equal(item.usage, '/heal');
  assert.equal(item.adminOnly, true, '会改动会话工具，属管理员命令');
  assert.ok(item.description.length > 0);
});

test('/heal：成功时回显会话数与插件工具数', async () => {
  const calls = [];
  const manager = makeManager({
    calls,
    healResult: {
      ok: true,
      tools: ['qqbot_send_file', 'memory_search', 'read', 'write'],
    },
  });
  const text = await handleCommand({
    name: 'heal', scope: 'group', peerId: 'g1',
    settings: { get: () => ({}) }, manager, stats: {},
  });
  assert.match(text, /已重新挂载工具/);
  assert.match(text, /共 4 个/);
  assert.match(text, /插件工具 2 个/);
  assert.match(text, /qqbot_send_file/);
  assert.deepEqual(calls, [['group', 'g1']], '应带上当前会话的 scope/peerId');
});

test('/heal：重挂后没有插件工具时给出可操作提示', async () => {
  const manager = makeManager({ healResult: { ok: true, tools: ['read', 'write'] } });
  const text = await handleCommand({
    name: 'heal', scope: 'c2c', peerId: 'u1',
    settings: { get: () => ({}) }, manager, stats: {},
  });
  assert.match(text, /没检测到插件工具/);
  assert.match(text, /工具与技能/);
});

test('/heal：后端返回 ok:false 时透出原因', async () => {
  const manager = makeManager({ healResult: { ok: false, reason: '当前会话还没有 agent（先聊一句再试）' } });
  const text = await handleCommand({
    name: 'heal', scope: 'group', peerId: 'g1',
    settings: { get: () => ({}) }, manager, stats: {},
  });
  assert.match(text, /工具重挂未完成/);
  assert.match(text, /先聊一句/);
});

test('/heal：manager 抛错时不冒泡，回可读文本', async () => {
  const manager = makeManager({ throws: true });
  const text = await handleCommand({
    name: 'heal', scope: 'group', peerId: 'g1',
    settings: { get: () => ({}) }, manager, stats: {},
  });
  assert.match(text, /工具重挂失败/);
  assert.match(text, /重挂炸了/);
});

test('/heal：旧版 manager 没有 healTools 时给出提示而不是崩', async () => {
  const text = await handleCommand({
    name: 'heal', scope: 'group', peerId: 'g1',
    settings: { get: () => ({}) }, manager: {}, stats: {},
  });
  assert.match(text, /不支持工具自愈/);
});