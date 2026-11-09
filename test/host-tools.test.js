import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_TOOLS, DEFAULT_CAPABILITIES, collectDiscovered, computePolicy, buildToolGuide,
} from '../lib/host/tools.js';
import { botCwdOf, sessionIdFor } from '../lib/host/agent.js';

function viewOf(names, restrictable) {
  return {
    visible: new Map(names.map((name) => [name, { name, description: name + ' 描述' }])),
    knownNames: new Set(names),
    restrictableNames: new Set(restrictable || names),
  };
}

test('工具发现：来源推断与排序', () => {
  const view = viewOf(['read', 'qqbot_send_file', 'skill', 'mcp__fs__read'], ['read', 'skill', 'mcp__fs__read']);
  const found = collectDiscovered(view);
  assert.deepEqual(found.map((item) => item.name), ['mcp__fs__read', 'qqbot_send_file', 'read', 'skill']);
  const byName = Object.fromEntries(found.map((item) => [item.name, item]));
  assert.equal(byName.read.source, 'host');
  assert.equal(byName.qqbot_send_file.source, 'qqbot');
  assert.equal(byName.qqbot_send_file.restrictable, false);
  assert.equal(byName.mcp__fs__read.source, 'mcp');
});

test('默认能力：workspace/web/memory/stickers/vision 开，skills/imagegen 关', () => {
  const view = viewOf(['read', 'write', 'web_search', 'memory_save', 'skill', 'generate_image', 'qqbot_send_file']);
  const discovered = collectDiscovered(view);
  const plan = computePolicy({ settings: {}, discovered });
  assert.equal(plan.mode, 'allow');
  assert.ok(plan.allowSet.has('read'));
  assert.ok(plan.allowSet.has('web_search'));
  assert.ok(plan.allowSet.has('memory_save'));
  assert.ok(!plan.allowSet.has('skill'), '技能默认关闭');
  assert.ok(!plan.allowSet.has('generate_image'), '生图默认关闭');
  assert.ok(!plan.allowSet.has('bash'), '命令执行(shell)默认关闭');
});

test('能力开关：关 workspace 后文件工具全部不可见', () => {
  const view = viewOf(['read', 'write', 'web_search', 'memory_save']);
  const discovered = collectDiscovered(view);
  const plan = computePolicy({ settings: { tools: { capabilities: { workspace: false, web: true, memory: false } } }, discovered });
  assert.deepEqual(plan.allow, ['web_search']);
});

test('deny 模式：默认放行，显式 deny 优先', () => {
  const view = viewOf(['read', 'write', 'web_search']);
  const discovered = collectDiscovered(view);
  const plan = computePolicy({ settings: { tools: { mode: 'deny', deny: ['write'], capabilities: { workspace: true, web: true } } }, discovered });
  assert.ok(plan.allowSet.has('read'));
  assert.ok(!plan.allowSet.has('write'));
  assert.ok(plan.allowSet.has('web_search'));
});

test('工具指引只列可见工具', () => {
  const guide = buildToolGuide([{ name: 'qqbot_send_file' }, { name: 'memory_save' }]);
  assert.match(guide, /qqbot_send_file/);
  assert.match(guide, /memory_save/);
  assert.doesNotMatch(guide, /web_search/);
  assert.equal(buildToolGuide([]), '');
  // 数据类工具在场时要明确「SQLite 权威，别翻 v1 json」
  const dataGuide = buildToolGuide([{ name: 'member_lookup' }]);
  assert.match(dataGuide, /SQLite/);
  assert.match(dataGuide, /member_lookup/);
});

test('sessionId/cwd 确定性', () => {
  const a = sessionIdFor('bot_1', 'group:123');
  const b = sessionIdFor('bot_1', 'group:123');
  assert.equal(String(a), String(b));
  assert.notEqual(String(a), String(sessionIdFor('bot_2', 'group:123')));
  assert.equal(botCwdOf('/ws', 'bot_1'), '/ws/bots/bot_1');
});

test('CAPABILITY_TOOLS 与 DEFAULT_CAPABILITIES 键一致', () => {
  assert.deepEqual(Object.keys(CAPABILITY_TOOLS).sort(), Object.keys(DEFAULT_CAPABILITIES).sort());
});