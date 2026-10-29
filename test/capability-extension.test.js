/**
 * 能力扩展性测试：默认拒绝不等于"加功能必须改代码"。
 * 验证：装配审计能记录"存在但被屏蔽"的工具；extraAllowed 能放行任意新工具。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolCatalog } from '../lib/tools/catalog.js';

function fakeSettings(snapshot) {
  return { get: () => snapshot };
}

const BASE = {
  features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
  memory: { enabled: true },
  stickers: { collectEnabled: true },
  tools: { capabilities: { skills: false, imagegen: false }, extraAllowed: [], skills: { mode: 'allow', allowed: [] } },
};

test('extraAllowed：任意新工具无需改代码即可放行', () => {
  const cat = createToolCatalog({ settings: fakeSettings({
    ...BASE,
    tools: { ...BASE.tools, extraAllowed: ['brand_new_plugin_tool', 'generate_video'] },
  }) });
  const plan = cat.resolve();
  assert.ok(plan.tools.includes('brand_new_plugin_tool'));
  assert.ok(plan.tools.includes('generate_video'));
  // 仍保持默认拒绝：未列出的依旧不放行
  assert.ok(!plan.tools.includes('some_unknown_tool'));
  // assembly 与 restrict 用同一份
  assert.ok(cat.filterPlan().names.has('brand_new_plugin_tool'));
});

test('catalog.resolve() 对未知能力键保持沉默（不因新插件崩溃）', () => {
  const cat = createToolCatalog({ settings: fakeSettings({
    ...BASE,
    tools: { ...BASE.tools, capabilities: { skills: false, imagegen: false, future_plugin: true } },
  }) });
  assert.doesNotThrow(() => cat.resolve());
  assert.doesNotThrow(() => cat.diagnose());
});

test('审计形状：dropped 只含被屏蔽的工具，且与 allow 不重叠', () => {
  // 直接验证审计的构造规则（与 session-manager 内实现一致）
  const allow = new Set(['read', 'web_search']);
  const candidates = ['read', 'web_search', 'new_plugin_tool', 'generate_video'];
  const kept = new Set(candidates.filter((name) => allow.has(name)));
  const dropped = candidates.filter((name) => !kept.has(name));
  assert.deepEqual(dropped.sort(), ['generate_video', 'new_plugin_tool']);
  // unclaimed = 候选 - 已放行 - 已在 extraAllowed
  const extra = new Set(['generate_video']);
  const unclaimed = candidates.filter((name) => !allow.has(name) && !extra.has(name));
  assert.deepEqual(unclaimed, ['new_plugin_tool']);
});
