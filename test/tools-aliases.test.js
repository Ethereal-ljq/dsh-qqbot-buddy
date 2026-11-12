/**
 * tools-aliases —— 工具兼容别名：模型按兄弟工具命名习惯猜名字时也能一次成功。
 *
 * 背景：线上模型把 qqbot_speak 猜成 qqbot_send_voice，返回 unknown tool 后还向用户
 * 编造成功。这里用「真实可用的别名」兜底，并在工具指引里写死反臆造规则。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOOL_ALIASES, TOOL_ALIAS_NAMES, aliasesForTarget, createAliasDefinition, expandAliasedDefinitions,
} from '../lib/tools/aliases.js';
import { PLUGIN_TOOL_CAPABILITIES, isPluginToolEnabled, enabledPluginTools } from '../lib/tools/catalog.js';
import { buildToolGuide } from '../lib/host/tools.js';

test('别名表：目标必须存在、能力归属与目标一致', () => {
  assert.ok(TOOL_ALIAS_NAMES.length >= 1);
  for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
    assert.ok(Object.prototype.hasOwnProperty.call(PLUGIN_TOOL_CAPABILITIES, target), '别名目标未注册: ' + target);
    assert.equal(PLUGIN_TOOL_CAPABILITIES[alias], PLUGIN_TOOL_CAPABILITIES[target], alias + ' 能力归属应与 ' + target + ' 一致');
  }
  assert.deepEqual(aliasesForTarget('qqbot_speak'), ['qqbot_send_voice']);
  assert.deepEqual(aliasesForTarget('qqbot_send_file'), ['qqbot_send_image']);
});

test('expandAliasedDefinitions：克隆别名、复用 execute/parameters、描述引导用正名', async () => {
  const calls = [];
  const speak = {
    name: 'qqbot_speak',
    description: 'Synthesize speech.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    output: { schema: { type: 'object' } },
    async execute(args) { calls.push(args); return { ok: true, text: args.text }; },
  };
  const other = { name: 'read', description: 'read file', parameters: { type: 'object' }, async execute() {} };
  const expanded = expandAliasedDefinitions([speak, other]);
  const names = expanded.map((item) => item.name);
  assert.ok(names.includes('qqbot_speak'));
  assert.ok(names.includes('qqbot_send_voice'));
  assert.ok(names.includes('read'));
  assert.ok(!names.includes('qqbot_send_image'), '没有目标 qqbot_send_file 时不应凭空产生别名');

  const alias = expanded.find((item) => item.name === 'qqbot_send_voice');
  assert.equal(alias.execute, speak.execute, '别名必须复用正名 execute（同一实现）');
  assert.equal(alias.parameters, speak.parameters);
  assert.match(alias.description, /兼容别名/);
  assert.match(alias.description, /qqbot_speak/);
  const value = await alias.execute({ text: 'hi' });
  assert.deepEqual(value, { ok: true, text: 'hi' });
  assert.equal(calls.length, 1);
});

test('别名跟随能力开关：voice/stickers 关闭时别名也不注册（allow 列表同样生效）', () => {
  const defaultOff = { tools: { capabilities: { voice: false, stickers: false, vision: true } } };
  assert.equal(isPluginToolEnabled({ settings: defaultOff, name: 'qqbot_send_voice' }), false);
  assert.equal(isPluginToolEnabled({ settings: defaultOff, name: 'qqbot_send_image' }), false);
  const voiceOn = { tools: { capabilities: { voice: true } } };
  assert.equal(isPluginToolEnabled({ settings: voiceOn, name: 'qqbot_send_voice' }), true);
  const allowList = { tools: { mode: 'allow', allow: ['qqbot_send_image'], capabilities: { stickers: false } } };
  assert.equal(isPluginToolEnabled({ settings: allowList, name: 'qqbot_send_image' }), true, '显式 allow 可越过能力开关');
  // 别名与正名共享 allow/deny：线上配置档的白名单里只写了正名
  const targetOnlyAllow = { tools: { mode: 'allow', allow: ['qqbot_speak'], capabilities: { voice: true } } };
  assert.equal(isPluginToolEnabled({ settings: targetOnlyAllow, name: 'qqbot_send_voice' }), true, 'allow 只写正名时别名也放行');
  const aliasDeny = { tools: { mode: 'allow', allow: ['qqbot_speak'], deny: ['qqbot_send_voice'], capabilities: { voice: true } } };
  assert.equal(isPluginToolEnabled({ settings: aliasDeny, name: 'qqbot_speak' }), false, 'deny 别名时正名同样拒绝');
  assert.ok(enabledPluginTools(voiceOn).includes('qqbot_send_voice'));
});

test('工具指引：反臆造规则常驻，语音可见时点名 qqbot_speak 与兼容别名', () => {
  const guide = buildToolGuide([{ name: 'qqbot_send_file' }, { name: 'memory_save' }]);
  assert.match(guide, /【工具调用规则】/);
  assert.match(guide, /不要臆造或改写工具名/);
  assert.match(guide, /如实告诉用户失败原因/);
  assert.doesNotMatch(guide, /qqbot_send_voice/, '语音工具不可见时不应出现语音别名说明');

  const voiceGuide = buildToolGuide([{ name: 'qqbot_speak' }]);
  assert.match(voiceGuide, /qqbot_speak/);
  assert.match(voiceGuide, /qqbot_send_voice 只是兼容别名/);
  // 空清单仍然返回空串（不注入任何提示）
  assert.equal(buildToolGuide([]), '');
});

test('createAliasDefinition：不修改原定义（浅拷贝）', () => {
  const original = { name: 'qqbot_send_file', description: 'x', parameters: { type: 'object' }, async execute() {} };
  const alias = createAliasDefinition(original, 'qqbot_send_image');
  assert.equal(original.name, 'qqbot_send_file', '原定义 name 不能被改写');
  assert.equal(alias.name, 'qqbot_send_image');
});
