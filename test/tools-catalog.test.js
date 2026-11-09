/**
 * tools-catalog —— 能力→工具映射的唯一真相：与主配置 schema、host/tools.js 保持一致。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPABILITY_TOOLS,
  DEFAULT_CAPABILITIES,
  PLUGIN_TOOL_CAPABILITIES,
  PLUGIN_TOOL_NAMES,
  resolveCapabilities,
  isPluginToolEnabled,
  enabledPluginTools,
} from '../lib/tools/catalog.js';
import { CAPABILITY_TOOLS as HOST_CAPABILITY_TOOLS, DEFAULT_CAPABILITIES as HOST_DEFAULTS } from '../lib/host/tools.js';
import { SETTINGS } from '../lib/core/config/schema.js';

test('catalog 的 CAPABILITY_TOOLS 与 host/tools.js 是同一份（host 改为 import，无漂移）', () => {
  assert.equal(HOST_CAPABILITY_TOOLS, CAPABILITY_TOOLS, 'host 应直接 re-export catalog 的同一引用');
  assert.equal(HOST_DEFAULTS, DEFAULT_CAPABILITIES);
});

test('能力 key 与主配置 schema 的 tools.capabilities 文档一致', () => {
  const item = SETTINGS.find((entry) => entry.key === 'tools.capabilities');
  assert.ok(item, 'schema 应有 tools.capabilities');
  assert.equal(item.type, 'json');
  assert.deepEqual(Object.keys(CAPABILITY_TOOLS).sort(), Object.keys(DEFAULT_CAPABILITIES).sort(), '映射与默认值必须覆盖同一集合');
  // schema 的 help 里列出了可用能力 id：catalog 必须全部覆盖，避免控制台显示的能力没有实现
  for (const capability of Object.keys(CAPABILITY_TOOLS)) {
    assert.ok(String(item.help).includes('"' + capability + '"'), 'schema help 缺少能力描述: ' + capability);
  }
});

test('插件工具能力归属齐全（发送/表情/看图）', () => {
  for (const name of PLUGIN_TOOL_NAMES) {
    assert.ok(Object.prototype.hasOwnProperty.call(PLUGIN_TOOL_CAPABILITIES, name));
  }
  assert.equal(PLUGIN_TOOL_CAPABILITIES.qqbot_send_file, 'stickers');
  assert.equal(PLUGIN_TOOL_CAPABILITIES.qqbot_sticker_save, 'stickers');
  assert.equal(PLUGIN_TOOL_CAPABILITIES.qqbot_send_sticker, 'stickers');
  assert.equal(PLUGIN_TOOL_CAPABILITIES.qqbot_describe_image, 'vision');
  assert.equal(PLUGIN_TOOL_CAPABILITIES.qqbot_send_card, null, '卡片工具与能力开关无关');
  assert.equal(PLUGIN_TOOL_CAPABILITIES.qqbot_quote_reply, null);
});

test('resolveCapabilities：默认值 + 局部覆盖，非法值忽略', () => {
  assert.deepEqual(resolveCapabilities({}), DEFAULT_CAPABILITIES);
  const caps = resolveCapabilities({ tools: { capabilities: { vision: false, stickers: true, imagegen: 'yes' } } });
  assert.equal(caps.vision, false);
  assert.equal(caps.stickers, true);
  assert.equal(caps.imagegen, false, '非布尔值应被忽略并回落默认');
  assert.equal(caps.workspace, true);
});

test('isPluginToolEnabled：allow 非空时只放行列表内；空 allow 回退能力开关；deny 优先', () => {
  const whitelist = { tools: { capabilities: { stickers: false, vision: true, memory: false }, deny: ['qqbot_send_card'], allow: ['qqbot_sticker_save'] } };
  assert.equal(isPluginToolEnabled({ settings: whitelist, name: 'qqbot_sticker_save' }), true, '显式 allow 可越过能力开关');
  assert.equal(isPluginToolEnabled({ settings: whitelist, name: 'qqbot_send_file' }), false, '不在白名单 -> 不注册');
  assert.equal(isPluginToolEnabled({ settings: whitelist, name: 'qqbot_send_card' }), false, 'deny 永远优先');
  assert.equal(isPluginToolEnabled({ settings: whitelist, name: 'qqbot_describe_image' }), false, '白名单外的工具即使能力开启也隐藏');
  assert.deepEqual(enabledPluginTools(whitelist), ['qqbot_sticker_save'], '白名单非空时插件工具也只留列表内');

  const capabilityOnly = { tools: { capabilities: { stickers: false, vision: true, memory: false }, deny: ['qqbot_send_card'] } };
  assert.equal(isPluginToolEnabled({ settings: capabilityOnly, name: 'qqbot_sticker_save' }), false);
  assert.equal(isPluginToolEnabled({ settings: capabilityOnly, name: 'qqbot_describe_image' }), true, 'vision 开启');
  assert.deepEqual(
    enabledPluginTools(capabilityOnly).sort(),
    [
      'qqbot_describe_image', 'qqbot_quote_reply',
      'knowledge_read', 'knowledge_save', 'knowledge_search', 'member_lookup', 'member_note',
    ].sort(),
    '空 allow 回退能力开关：memory 能力关闭 -> memory_* 跳过；knowledge/member 无独立能力开关 -> 保留',
  );
});
