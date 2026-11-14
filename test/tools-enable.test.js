/**
 * tools-enable —— 元工具 qqbot_enable：点亮被动能力。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEnableTool, ENABLE_TOOL_NAME } from '../lib/tools/enable.js';
import { activationOf } from '../lib/tools/activation.js';

function makeTool(overrides = {}) {
  const runtime = {};
  let refreshed = 0;
  const tool = createEnableTool({
    manager: { findByAgent: () => ({ peer: 'group:1' }) },
    runtime,
    // 2026-11-14：装载前必须校验能力开关，测试默认把 imagegen/workspace 打开
    getSettings: () => ({ tools: { capabilities: { imagegen: true, workspace: true } } }),
    knownTools: () => new Set(['generate_image', 'edit_image', 'qqbot_send_file', 'read']),
    onActivated: async () => { refreshed += 1; },
    logger: { info() {}, warn() {} },
    ...overrides,
  });
  return { tool, runtime, get refreshed() { return refreshed; } };
}

test('qqbot_enable：按能力组点亮，并刷新宿主工具限制', async () => {
  const handle = makeTool();
  const { tool, runtime } = handle;
  assert.equal(tool.name, ENABLE_TOOL_NAME);
  const out = await tool.execute({ capability: 'imagegen' }, { agent: {} });
  assert.equal(out.ok, true);
  assert.deepEqual(out.groups, ['imagegen']);
  assert.equal(handle.refreshed, 1);
  assert.deepEqual(activationOf(runtime, 'group:1').groups, ['imagegen']);
  assert.match(out.message, /下一步可直接调用/);
  // 用法卡：给出准确参数，避免下个 step 靠猜参数再失败一次
  assert.match(out.message, /generate_image\(prompt\)/);
  assert.match(out.message, /edit_image\(prompt, source_path\?\)/);
  const rendered = tool.output.render({}, out);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /已开启：/);
});

test('qqbot_enable：直接点名工具 / 组内工具名归一', async () => {
  const { tool, runtime } = makeTool();
  // 无分组的工具按名字点亮
  assert.equal(await tool.execute({ tools: ['qqbot_send_file'] }, { agent: {} }).then((r) => r.ok), true);
  assert.deepEqual(activationOf(runtime, 'group:1').tools, ['qqbot_send_file']);

  // 传组内工具名等价于点亮整个组
  const byMember = await tool.execute({ capability: 'edit_image' }, { agent: {} });
  assert.equal(byMember.ok, true);
  assert.deepEqual(byMember.groups, ['imagegen']);
  // 有分组的工具按组点亮（read -> workspace）
  const byRead = await tool.execute({ tools: ['read'] }, { agent: {} });
  assert.deepEqual(byRead.groups, ['workspace']);
  assert.deepEqual(activationOf(runtime, 'group:1').groups.sort(), ['imagegen', 'workspace']);
});

test('qqbot_enable：能力未开启时不谎报成功（2026-11-14 契约）', async () => {
  // 线上事故：shell 能力关着，qqbot_enable 仍回「已开启能力：命令执行」，
  // 模型下一步调 bash 得到 unknown tool，然后开始编造执行结果。
  const { tool, runtime } = makeTool();
  const out = await tool.execute({ capability: 'shell' }, { agent: {} });
  assert.equal(out.ok, false);
  assert.deepEqual(out.groups, []);
  assert.deepEqual(activationOf(runtime, 'group:1').groups, []);
  assert.match(out.message, /没有开启任何能力/);
  assert.match(out.message, /未开启/);
  assert.match(out.message, /不要臆造工具名/);
});

test('qqbot_enable：白名单显式放行可越过能力开关（线上回归）', async () => {
  // 现场：能力开关 voice=false（默认拒绝），但 tools.allow 里有 qqbot_speak。
  // 工具页三态按 isToolAllowed 显示「索引中」，而装载校验只看能力开关 → 报「能力未开启」，
  // 模型于是告诉用户「调不了语音」。两边必须同一判定。
  const settings = {
    tools: {
      mode: 'allow',
      allow: ['qqbot_speak', 'qqbot_send_voice'],
      capabilities: { voice: false },
    },
  };
  const handle = makeTool({
    getSettings: () => settings,
    knownTools: () => new Set(['qqbot_speak', 'qqbot_send_voice']),
  });
  const out = await handle.tool.execute({ capability: 'voice' }, { agent: {} });
  assert.equal(out.ok, true, '白名单放行后必须能开启');
  assert.deepEqual(out.groups, ['voice']);
  assert.match(out.message, /qqbot_speak/);
});

test('qqbot_enable：未知工具被拒绝并如实说明；没有找到会话时抛错', async () => {
  const { tool } = makeTool();
  const out = await tool.execute({ capability: 'nope_tool' }, { agent: {} });
  assert.equal(out.ok, false);
  assert.match(out.message, /没有可开启的工具/);
  assert.match(out.message, /nope_tool/);

  const orphan = createEnableTool({
    manager: { findByAgent: () => null },
    runtime: {},
    logger: { info() {}, warn() {} },
  });
  await assert.rejects(() => orphan.execute({ capability: 'imagegen' }, { agent: {} }), /找不到当前 QQ 会话/);
});

test('qqbot_enable：能力组默认参数为空时给出可用组清单', async () => {
  const { tool } = makeTool();
  const out = await tool.execute({}, { agent: {} });
  assert.equal(out.ok, false);
  assert.match(out.message, /imagegen/);
  assert.match(out.message, /voice/);
});
