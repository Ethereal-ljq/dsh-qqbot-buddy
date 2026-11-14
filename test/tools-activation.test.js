/**
 * tools-activation —— 被动工具的确定性路由与激活状态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  matchGroups, setActivation, addActivation, clearActivation, activationOf,
  isToolActive, listGroups, capabilityEnabled, groupAvailable,
} from '../lib/tools/activation.js';

test('matchGroups：只认用户原话里的触发词', () => {
  // 能力默认关闭时组不可点亮（生图/语音默认关），测试显式打开
  const on = { tools: { capabilities: { imagegen: true, voice: true } } };
  assert.deepEqual(matchGroups('帮我画一张猫', on), ['imagegen']);
  assert.deepEqual(matchGroups('发条语音给我', on), ['voice']);
  assert.deepEqual(matchGroups('今天中午吃什么', on), []);
  assert.deepEqual(matchGroups('', on), []);
  assert.deepEqual(matchGroups(null, on), []);
  assert.deepEqual(matchGroups('帮我画一张猫', {}), [], '能力关闭时不要点亮');
  // 一句话命中多个组
  const both = matchGroups('生成一张图然后发个语音', { tools: { capabilities: { imagegen: true, voice: true } } });
  assert.ok(both.includes('imagegen'));
  assert.ok(both.includes('voice'));
});

test('matchGroups：能力关闭的组不会被点亮', () => {
  const off = { tools: { capabilities: { imagegen: false } } };
  assert.deepEqual(matchGroups('画一张猫', off), []);
  assert.equal(capabilityEnabled(off, 'imagegen'), false);
  assert.equal(capabilityEnabled(off, null), true, '没有能力归属的组恒可用');
});

test('isToolActive：主动恒真，被动看激活集合，异常不抛', () => {
  const runtime = {};
  const settings = { tools: { capabilities: { imagegen: true, workspace: true } } };
  assert.equal(isToolActive({ runtime, peer: 'g:1', name: 'qqbot_send_file', settings }), true, '主动工具恒可用');
  assert.equal(isToolActive({ runtime, peer: 'g:1', name: 'generate_image', settings }), false, '被动工具默认不可用');
  setActivation(runtime, 'g:1', { groups: ['imagegen'] });
  assert.equal(isToolActive({ runtime, peer: 'g:1', name: 'generate_image', settings }), true);
  assert.equal(isToolActive({ runtime, peer: 'g:2', name: 'generate_image', settings }), false, '激活按 peer 隔离');
  addActivation(runtime, 'g:1', { tools: ['read'] });
  assert.equal(isToolActive({ runtime, peer: 'g:1', name: 'read', settings }), true, '点名工具也能亮');
  clearActivation(runtime, 'g:1');
  assert.equal(isToolActive({ runtime, peer: 'g:1', name: 'generate_image', settings }), false);
  // 容错：runtime 缺失 / 设置畸形都不能抛
  assert.equal(isToolActive({ runtime: null, peer: 'g:1', name: 'generate_image' }), false);
  assert.equal(isToolActive({}), false);
});

test('setActivation 覆盖、addActivation 累加，activationOf 返回快照', () => {
  const runtime = {};
  setActivation(runtime, 'p', { groups: ['voice'], tools: ['read'] });
  assert.deepEqual(activationOf(runtime, 'p'), { groups: ['voice'], tools: ['read'] });
  setActivation(runtime, 'p', { groups: ['card'], tools: [] });
  assert.deepEqual(activationOf(runtime, 'p'), { groups: ['card'], tools: [] }, '每轮覆盖，不残留上一轮');
  addActivation(runtime, 'p', { groups: ['voice'] });
  assert.deepEqual(activationOf(runtime, 'p').groups, ['card', 'voice']);
  assert.deepEqual(activationOf({}, 'p'), { groups: [], tools: [] }, '未知 runtime 返回空快照');
});

test('策略判定：白名单显式放行可越过能力开关（2026-11-14 修复）', () => {
  // 默认拒绝 + 白名单放行 = 可用；激活路由/分组可用性必须与 isToolAllowed 一致
  const override = { tools: { mode: 'allow', allow: ['qqbot_speak', 'qqbot_send_voice'], capabilities: { voice: false } } };
  assert.equal(groupAvailable({ settings: override, groupId: 'voice' }), true, '白名单越过能力开关');
  assert.deepEqual(matchGroups('用语音说一句', override), ['voice'], '触发词也要能点亮它');
  // 能力开但白名单没放行 → 不可用（白名单模式下以列表为准）
  const denied = { tools: { mode: 'allow', allow: ['qqbot_send_file'], capabilities: { voice: true } } };
  assert.equal(groupAvailable({ settings: denied, groupId: 'voice' }), false, '不在白名单就是不可用');
  // 能力关 + 白名单为空 → 仍按能力开关拒绝
  assert.equal(groupAvailable({ settings: { tools: { capabilities: { voice: false } } }, groupId: 'voice' }), false);
});

test('粘滞激活（2026-11-14）：会话内只增不减，只有重置才清空', () => {
  // 线上 63% 的 unknown tool 是「刚才还能用、下一步消失」造成的：
  // 模型按对话记忆继续调用，但声明面已经把它收回去了。
  const runtime = {};
  addActivation(runtime, 'p', { groups: ['imagegen'] });
  addActivation(runtime, 'p', { groups: ['voice'] });
  addActivation(runtime, 'p', { groups: ['imagegen'] });
  assert.deepEqual(activationOf(runtime, 'p').groups, ['imagegen', 'voice'], '已装载的组不回收');
  clearActivation(runtime, 'p');
  assert.deepEqual(activationOf(runtime, 'p').groups, [], '/new 或会话释放才清空');
});

test('listGroups：按能力开关算可用性', () => {
  const groups = listGroups({ tools: { capabilities: { imagegen: false, voice: true } } });
  const byId = Object.fromEntries(groups.map((item) => [item.id, item]));
  assert.equal(byId.imagegen.available, false);
  assert.equal(byId.voice.available, true);
  assert.ok(byId.imagegen.tools.includes('generate_image'));
  assert.equal(byId.card.capability, null, '卡片没有独立能力开关');
});
