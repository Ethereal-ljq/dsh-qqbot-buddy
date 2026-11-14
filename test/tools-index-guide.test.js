/**
 * tools-index-guide —— 按需能力索引 / 用法卡（2026-11-14 渐进披露的静态层）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIVATION_GROUPS, TOOL_USAGE } from '../lib/tools/catalog.js';
import { TOOL_ALIASES } from '../lib/tools/aliases.js';
import {
  buildToolIndexLines, groupLabels, usageLinesForGroups,
} from '../lib/tools/index-guide.js';

const SETTINGS = {
  tools: { capabilities: { workspace: true, web: true, shell: true, vision: true, imagegen: true, voice: false } },
};

test('索引：只列能力已开启、且未被装载的组', () => {
  const lines = buildToolIndexLines({ settings: SETTINGS });
  const text = lines.join('\n');
  assert.match(text, /生图\/改图（imagegen）/);
  assert.match(text, /文件读写（workspace）/);
  // voice 能力关着 → 不进索引
  assert.doesNotMatch(text, /语音（voice）/);
  // 已装载的组不该再出现
  const loaded = buildToolIndexLines({ settings: SETTINGS, activeNames: ['read', 'write', 'edit', 'apply_patch', 'glob', 'grep'] });
  assert.ok(!loaded.join('\n').includes('文件读写（workspace）'), '整组都装载后应从索引移除');
});

test('索引：只列正名，不重复列兼容别名', () => {
  const text = buildToolIndexLines({ settings: SETTINGS }).join('\n');
  for (const alias of Object.keys(TOOL_ALIASES)) {
    assert.ok(!text.includes(alias), '索引不该出现别名 ' + alias);
  }
});

test('索引：本机没装该组工具时不承诺（knownNames 过滤）', () => {
  const text = buildToolIndexLines({
    settings: SETTINGS,
    knownNames: new Set(['read', 'write', 'generate_image']),
  }).join('\n');
  assert.match(text, /文件读写（workspace）/);
  assert.match(text, /生图\/改图（imagegen）/);
  assert.doesNotMatch(text, /命令执行（shell）/, 'bash/jobs 不在已知清单里就不列');
});

test('用法卡：装载后给出准确签名，未知工具跳过', () => {
  const lines = usageLinesForGroups(['imagegen']);
  const text = lines.join('\n');
  assert.match(text, /generate_image\(prompt\)/);
  assert.match(text, /edit_image\(prompt, source_path\?\)/);
  assert.equal(usageLinesForGroups(['nope']).length, 0);
  // 只列实际可用的工具
  const partial = usageLinesForGroups(['imagegen'], { names: ['generate_image'] }).join('\n');
  assert.match(partial, /generate_image/);
  assert.doesNotMatch(partial, /edit_image/);
});

test('用法卡覆盖：每个可装载工具都有登记（防止索引承诺了却没有用法）', () => {
  const missing = [];
  for (const group of Object.values(ACTIVATION_GROUPS)) {
    for (const name of group.tools || []) {
      if (TOOL_ALIASES[name] !== undefined) continue;
      if (!TOOL_USAGE[name]) missing.push(name);
    }
  }
  assert.deepEqual(missing, [], '这些工具缺用法卡: ' + missing.join(', '));
});

test('groupLabels：组 id → 中文标签', () => {
  assert.deepEqual(groupLabels(['imagegen', 'voice', 'nope']), ['生图/改图', '语音', 'nope']);
});
