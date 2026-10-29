/**
 * 提示词分段组装测试：独立存储/开关 + 按重要性排布（重要放首尾）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROMPT_SECTIONS,
  orderSections,
  readSectionOverride,
  sectionDefaults,
  getSection,
} from '../lib/prompt-sections.js';

test('orderSections：最重要的在最前，次重要的在最后（规避 lost-in-the-middle）', () => {
  const ordered = orderSections(PROMPT_SECTIONS);
  assert.equal(ordered[0].id, 'identity', '人设应排第一');
  assert.equal(ordered[ordered.length - 1].id, 'safety', '安全红线应排最后');
  // 首尾都应是高优先级（>=80），中段是低优先级
  assert.ok(ordered[0].priority >= 80);
  assert.ok(ordered[ordered.length - 1].priority >= 80);
  // 中段应是相对次要的段：不含最高的两段（identity=100 / safety=95）
  const middle = ordered.slice(2, -2).map((item) => item.priority);
  assert.ok(middle.every((p) => p < 95), '最高优先级的两段不应落在中间');
  assert.ok(Math.max(...middle) <= 85, '中间段优先级不应超过能力边界');
});

test('orderSections：不修改入参，且段数不变', () => {
  const input = PROMPT_SECTIONS.slice();
  const before = input.map((item) => item.id);
  const ordered = orderSections(input);
  assert.deepEqual(input.map((item) => item.id), before, '不应修改入参');
  assert.equal(ordered.length, input.length);
  assert.deepEqual(ordered.map((i) => i.id).sort(), before.slice().sort(), '不丢段');
});

test('orderSections：优先级相同时顺序稳定（不抖动）', () => {
  const a = orderSections(PROMPT_SECTIONS);
  const b = orderSections(PROMPT_SECTIONS);
  assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id));
});

test('readSectionOverride：默认启用、无自定义文本；可关闭/覆盖', () => {
  assert.deepEqual(readSectionOverride({}, 'identity'), { enabled: true, text: '' });
  const cfg = { prompts: { sections: { identity: { enabled: false, text: '自定义身份' } } } };
  assert.deepEqual(readSectionOverride(cfg, 'identity'), { enabled: false, text: '自定义身份' });
});

test('sectionDefaults/getSection：元数据可用于设置页', () => {
  const list = sectionDefaults();
  assert.equal(list.length, PROMPT_SECTIONS.length);
  for (const item of list) {
    assert.ok(typeof item.id === 'string' && item.id !== '');
    assert.ok(typeof item.label === 'string' && item.label !== '');
    assert.ok(typeof item.priority === 'number');
    assert.ok(typeof item.storage === 'string');
  }
  assert.equal(getSection('identity').priority, 100);
  assert.equal(getSection('不存在'), null);
});

test('每段都有独立存储位置声明（可单独编辑）', () => {
  const storages = new Set(PROMPT_SECTIONS.map((item) => item.storage));
  // 人设/行为/提示词/记忆/动态 各有归属，不应全部挤在一个字段
  for (const expected of ['persona', 'prompts.toolGuide', 'prompts.sendGuide', 'memory', 'dynamic']) {
    assert.ok(storages.has(expected), '应存在存储位置 ' + expected);
  }
});
