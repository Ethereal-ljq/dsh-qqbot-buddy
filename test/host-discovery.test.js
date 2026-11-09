import test from 'node:test';
import assert from 'node:assert/strict';

import { createDiscovery } from '../lib/host/discovery.js';
import { PLUGIN_TOOL_NAMES } from '../lib/tools/catalog.js';

function fakeCtx(globalTools = []) {
  const visible = new Map(globalTools.map((name) => [name, { name, description: 'd' }]));
  return {
    get: (name) => (name === 'tools'
      ? { view: () => ({ visible, knownNames: new Set(visible.keys()), restrictableNames: new Set(visible.keys()) }) }
      : (name === 'skills' ? { list: async () => ({ skills: [{ name: 'bili-get', description: 'B站' }] }) } : undefined)),
  };
}

function fakeRuntime(settingsForProfile) {
  return {
    config: {
      getSettingsForProfile: (id) => settingsForProfile(id),
      getSettings: () => settingsForProfile('default'),
    },
  };
}

test('发现全集：插件工具 + 能力挂载的宿主工具 + 全局视图', () => {
  const discovery = createDiscovery({ ctx: fakeCtx(['mcp__fs__read']), runtime: fakeRuntime(() => ({})) });
  const items = discovery.list();
  const names = items.map((item) => item.name);
  for (const name of PLUGIN_TOOL_NAMES) assert.ok(names.includes(name), '缺插件工具 ' + name);
  assert.ok(names.includes('read'), '缺能力挂载的 fs 工具');
  assert.ok(names.includes('web_search'), '缺 web 工具');
  assert.ok(names.includes('mcp__fs__read'), '缺全局视图工具');
  const byName = Object.fromEntries(items.map((item) => [item.name, item]));
  assert.equal(byName.read.source, 'host');
  assert.equal(byName.read.control, 'capability');
  assert.equal(byName.qqbot_send_file.source, 'qqbot');
  assert.equal(byName.qqbot_send_file.control, 'policy');
  assert.equal(byName.mcp__fs__read.control, 'global');
});

test('可见性：能力关掉后对应工具不可见，插件工具按 deny/allow/能力判定', () => {
  const discovery = createDiscovery({ ctx: fakeCtx([]), runtime: fakeRuntime(() => ({
    tools: { capabilities: { workspace: false, web: true, memory: false, stickers: false, vision: false, skills: false, shell: false }, deny: ['qqbot_send_sticker'] },
  })) });
  const visible = discovery.visibleNames({ profileId: 'p1' });
  assert.ok(!visible.includes('read'), 'workspace 关闭后 read 不可见');
  assert.ok(visible.includes('web_search'), 'web 开启应可见');
  assert.ok(!visible.includes('memory_save'), 'memory 关闭后不可见');
  assert.ok(!visible.includes('qqbot_send_sticker'), '显式 deny 优先');
});

test('技能快照：refresh 后可同步读取', async () => {
  const discovery = createDiscovery({ ctx: fakeCtx([]), runtime: fakeRuntime(() => ({})) });
  assert.deepEqual(discovery.listSkills(), []);
  await discovery.refresh();
  assert.deepEqual(discovery.listSkills().map((item) => item.name), ['bili-get']);
});
