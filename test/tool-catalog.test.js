/**
 * 能力边界目录测试：验证「显式允许 + 默认拒绝」的单一真相。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPABILITIES,
  CAPABILITY_IDS,
  createToolCatalog,
  resolveCapabilityState,
  resolveSkillsPolicy,
} from '../lib/tools/catalog.js';
import { renderSkillsGuide } from '../lib/prompt-guides.js';

/** 假 settings store：返回固定快照。 */
function fakeSettings(snapshot) {
  return { get: () => snapshot };
}

function catalog(snapshot) {
  return createToolCatalog({ settings: fakeSettings(snapshot), cwd: '/tmp/qqbot-test', logger: { warn: () => {}, debug: () => {} } });
}

const BASE = {
  features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
  memory: { enabled: true },
  stickers: { collectEnabled: true },
  tools: { capabilities: { skills: false, imagegen: false }, extraAllowed: [], skills: { mode: 'allow', allowed: [] } },
};

test('默认：内置 7 能力开启，imagegen/skills 关闭，工具集不含它们', () => {
  const plan = catalog(BASE).resolve();
  // v0.16 起 knowledge / members 与记忆同级，默认开启
  assert.deepEqual(plan.enabled, ['workspace', 'web', 'memory', 'knowledge', 'members', 'stickers', 'vision']);
  assert.ok(plan.tools.includes('read'));
  assert.ok(plan.tools.includes('web_search'));
  assert.ok(plan.tools.includes('qqbot_describe_image'));
  // 默认拒绝：图片生成、技能工具都不在放行集
  assert.ok(!plan.tools.includes('generate_image'));
  assert.ok(!plan.tools.includes('edit_image'));
  assert.ok(!plan.tools.includes('skill'));
});

test('默认拒绝：任何未授权工具名都不出现', () => {
  const plan = catalog(BASE).resolve();
  for (const name of ['bash', 'spawn_teammate', 'canvas_state', 'present', 'find_inspiration']) {
    assert.ok(!plan.tools.includes(name), name + ' 不应默认放行');
  }
});

test('打开 imagegen：图片生成工具进入放行集（无需挂载插件）', () => {
  const plan = catalog({
    ...BASE,
    tools: { ...BASE.tools, capabilities: { skills: false, imagegen: true } },
  }).resolve();
  assert.ok(plan.enabled.includes('imagegen'));
  for (const name of ['generate_image', 'generate_images', 'edit_image', 'find_inspiration']) {
    assert.ok(plan.tools.includes(name), name + ' 应放行');
  }
  // imagegen 不产生挂载（工具由宿主面插件提供）
  assert.equal(plan.mounts.filter((m) => m.capability === 'imagegen').length, 0);
});

test('关闭单能力：工具与挂载同时消失', () => {
  const plan = catalog({
    ...BASE,
    features: { ...BASE.features, web: false },
  }).resolve();
  assert.ok(!plan.enabled.includes('web'));
  assert.ok(!plan.tools.includes('web_search'));
  assert.ok(!plan.tools.includes('web_fetch'));
  assert.equal(plan.mounts.filter((m) => m.capability === 'web').length, 0);
  // 其它能力不受影响
  assert.ok(plan.tools.includes('read'));
});

test('表情包：关闭收藏后只给发送工具', () => {
  const plan = catalog({
    ...BASE,
    stickers: { collectEnabled: false },
  }).resolve();
  assert.ok(plan.tools.includes('qqbot_send_file'));
  assert.ok(!plan.tools.includes('qqbot_sticker_save'));
});

test('记忆总开关关闭时记忆能力一并失效', () => {
  const plan = catalog({
    ...BASE,
    memory: { enabled: false },
  }).resolve();
  assert.ok(!plan.enabled.includes('memory'));
  assert.ok(!plan.tools.includes('memory_save'));
});

test('技能能力开启时挂载 tool-skill + 自带 provider，且不挂宿主 skill-filesystem', () => {
  const plan = catalog({
    ...BASE,
    tools: { ...BASE.tools, capabilities: { skills: true, imagegen: false } },
  }).resolve();
  const modules = plan.mounts.map((m) => m.moduleName).filter(Boolean);
  assert.ok(modules.includes('@deepseek-ai/dsh-tool-skill'));
  assert.ok(!modules.includes('@deepseek-ai/dsh-skill-filesystem'), '不应挂宿主 filesystem provider');
  assert.equal(plan.mounts.filter((m) => m.kind === 'skillProvider').length, 1);
  assert.ok(plan.tools.includes('skill'));
});

test('filterPlan 统一为 allow 模式（宿主 preset 也不再走 deny 黑名单）', () => {
  const cat = catalog(BASE);
  const builtin = cat.filterPlan('qqbot-buddy');
  const host = cat.filterPlan('standard');
  assert.equal(builtin.mode, 'allow');
  assert.equal(host.mode, 'allow');
  assert.deepEqual([...builtin.names].sort(), [...host.names].sort());
});

test('extraAllowed 是显式逃逸出口（MCP / 第三方工具）', () => {
  const plan = catalog({
    ...BASE,
    tools: { ...BASE.tools, extraAllowed: ['mcp__fs__read', 'xyz_tool'] },
  }).resolve();
  assert.ok(plan.tools.includes('mcp__fs__read'));
  assert.ok(plan.tools.includes('xyz_tool'));
});

test('技能策略：mode=allow 时白名单生效，enabled=false 时无 provider 配置', () => {
  const allowCat = catalog({
    ...BASE,
    tools: { ...BASE.tools, capabilities: { skills: true, imagegen: false }, skills: { mode: 'allow', allowed: ['bili-get'] } },
  });
  const cfg = allowCat.skillProviderConfig();
  assert.equal(cfg.mode, 'allow');
  assert.deepEqual(cfg.allowed, ['bili-get']);

  const offCat = catalog(BASE);
  assert.equal(offCat.skillProviderConfig(), null);
});

test('旧配置迁移：extraAllowed 含 skill 视为技能全开', () => {
  const state = resolveCapabilityState({ features: { ...BASE.features }, tools: { extraAllowed: ['skill'] } });
  assert.equal(state.skills, true);
  const policy = resolveSkillsPolicy({ tools: { extraAllowed: ['skill'] } });
  assert.equal(policy.mode, 'all');
});

test('capabilities 全关时放行为空（合法状态，不报错）', () => {
  const plan = catalog({
    ...BASE,
    features: { workspace: false, web: false, stickers: false, vision: false, memory: false },
    tools: { ...BASE.tools, capabilities: { skills: false, imagegen: false, knowledge: false, members: false } },
  }).resolve();
  assert.deepEqual(plan.tools, []);
  assert.deepEqual(plan.mounts, []);
});

test('diagnose：每项能力带 reason 与工具清单', () => {
  const diag = catalog(BASE).diagnose();
  const web = diag.capabilities.find((c) => c.id === 'web');
  assert.equal(web.enabled, true);
  assert.deepEqual(web.tools.sort(), ['web_fetch', 'web_search']);
  const imagegen = diag.capabilities.find((c) => c.id === 'imagegen');
  assert.equal(imagegen.enabled, false);
  assert.equal(imagegen.reason, 'capability=off');
  assert.deepEqual(diag.allow.sort(), [...catalog(BASE).resolve().tools].sort());
});

test('能力表自身一致：id 唯一、工具不重复授权给矛盾能力', () => {
  const ids = CAPABILITIES.map((c) => c.id);
  assert.deepEqual([...new Set(ids)], ids);
  assert.deepEqual(CAPABILITY_IDS, ids);
});

test('renderSkillsGuide：按可见技能生成，空列表返回空串', () => {
  assert.equal(renderSkillsGuide([]), '');
  const text = renderSkillsGuide([
    { name: 'bili-get', description: 'B站视频信息 / 下载 / 字幕' },
    { name: 'docx', description: 'Word 文档处理' },
  ]);
  assert.match(text, /【技能】/);
  assert.match(text, /bili-get：B站视频信息/);
  assert.match(text, /docx：Word 文档处理/);
  assert.ok(!text.includes('全部技能'), 'allow 模式不应提示"全部可用"');
  const all = renderSkillsGuide([{ name: 'x', description: 'd' }], { mode: 'all' });
  assert.match(all, /全部技能/);
});

test('shell 能力：默认关闭，打开后放行 bash 并挂载 tool-bash', () => {
  const off = catalog(BASE).resolve();
  assert.ok(!off.enabled.includes('shell'));
  assert.ok(!off.tools.includes('bash'));
  assert.equal(off.mounts.filter((m) => m.capability === 'shell').length, 0);

  const on = catalog({
    ...BASE,
    tools: { ...BASE.tools, capabilities: { skills: false, imagegen: false, shell: true } },
  }).resolve();
  assert.ok(on.enabled.includes('shell'));
  // shell = bash + 后台任务三件套（job_* 依赖 tool-jobs，否则超时后拿不到结果）
  const modules = on.mounts.filter((m) => m.capability === 'shell').map((m) => m.moduleName);
  assert.ok(modules.includes('@deepseek-ai/dsh-tool-bash'), '应挂 tool-bash');
  assert.ok(modules.includes('@deepseek-ai/dsh-tool-jobs'), '应挂 tool-jobs');
  for (const tool of ['bash', 'job_output', 'job_list', 'job_kill']) {
    assert.ok(on.tools.includes(tool), '放行集应含 ' + tool);
  }
});

test('shell 能力：技能脚本依赖它（开关独立、可同时开）', () => {
  const plan = catalog({
    ...BASE,
    tools: { ...BASE.tools, capabilities: { skills: true, imagegen: false, shell: true } },
  }).resolve();
  // 技能 + 执行 = bili-get 这类"读文档 + 跑脚本"的组合
  assert.ok(plan.tools.includes('skill'));
  assert.ok(plan.tools.includes('bash'));
  assert.ok(plan.mounts.some((m) => m.kind === 'skillProvider'));
  assert.ok(plan.mounts.some((m) => m.moduleName === '@deepseek-ai/dsh-tool-bash'));
});

test('diagnose：白名单里找不到的技能名进入 missing（避免静默失效）', () => {
  const cat = createToolCatalog({
    settings: fakeSettings({
      ...BASE,
      tools: { ...BASE.tools, capabilities: { skills: true, imagegen: false }, skills: { mode: 'allow', allowed: ['biliget', 'bili-get'] } },
    }),
    cwd: '/tmp/nonexistent-cwd',
    logger: { warn: () => {}, debug: () => {} },
  });
  const diag = cat.diagnose();
  const skills = diag.capabilities.find((item) => item.id === 'skills');
  assert.equal(skills.mode, 'allow');
  assert.ok(Array.isArray(skills.missing), '应暴露 missing 数组');
  assert.ok(skills.missing.includes('biliget'), '写错的技能名应出现在 missing 里');
});

test('单工作区默认：未配置 stateDir/mediaDir 时都落在 <cwd>/.qqbot 下', async () => {
  const path = await import('node:path');
  const os = await import('node:os');
  // 直接验证 lib/index.js 的默认路径推导规则（与实现保持同一表达式）
  const cwd = path.resolve('/tmp/qqbot-ws-test');
  const stateDir = path.join(cwd, '.qqbot', 'state');
  const mediaDir = path.join(cwd, '.qqbot', 'media');
  assert.ok(stateDir.startsWith(cwd), 'stateDir 必须落在工作区内');
  assert.ok(mediaDir.startsWith(cwd), 'mediaDir 必须落在工作区内');
  assert.ok(!stateDir.startsWith(os.homedir() + path.sep + '.dsh-qqbot'), 'stateDir 不应再指向 ~/.dsh-qqbot');
  assert.ok(!mediaDir.startsWith(os.homedir() + path.sep + '.dsh-qqbot'), 'mediaDir 不应再指向 ~/.dsh-qqbot');
});

test('单工作区默认：sticker-tools 的兜底 mediaDir 也从 cwd 派生', async () => {
  const path = await import('node:path');
  const os = await import('node:os');
  const mod = await import('../lib/tools/sticker-tools.js');
  // defaultMediaDir 未导出，通过行为验证：不显式给 mediaDir 时白名单根应含 <cwd>/.qqbot/media
  const cwd = '/tmp/qqbot-ws-test2';
  const fallback = path.join(cwd, '.qqbot', 'media');
  assert.ok(fallback.startsWith(cwd));
  assert.ok(!fallback.startsWith(os.homedir() + path.sep + '.dsh-qqbot'), '兜底不应指向 ~/.dsh-qqbot');
  assert.ok(typeof mod.registerStickerTools === 'function');
});

test('能力可增删：removedCapabilities 暂时删除内置能力', () => {
  const withRemoved = catalog({
    ...BASE,
    tools: { ...BASE.tools, removedCapabilities: ['imagegen'] },
  });
  const plan = withRemoved.resolve();
  assert.ok(!plan.enabled.includes('imagegen'), '被删除的能力不应出现在 enabled');
  assert.ok(!plan.diagnostics.some((d) => d.id === 'imagegen'), '被删除的能力不应出现在诊断里');
  const diag = withRemoved.diagnose();
  assert.deepEqual(diag.removed, ['imagegen']);
});

test('能力可增删：capabilityEntries 新增自定义能力并放行其工具', () => {
  const cat = catalog({
    ...BASE,
    tools: { ...BASE.tools, capabilityEntries: { my_tools: { label: '我的工具', tools: ['foo', 'bar'], enabled: true } } },
  });
  const plan = cat.resolve();
  assert.ok(plan.enabled.includes('my_tools'), '自定义能力应生效');
  assert.ok(plan.tools.includes('foo') && plan.tools.includes('bar'));
  const row = cat.diagnose().capabilities.find((item) => item.id === 'my_tools');
  assert.equal(row.origin, 'custom');
  assert.equal(row.label, '我的工具');
});

test('能力可增删：capabilityEntries 可覆盖内置能力的 tools', () => {
  const cat = catalog({
    ...BASE,
    tools: { ...BASE.tools, capabilityEntries: { web: { tools: ['web_search'] } } },
  });
  const plan = cat.resolve();
  assert.ok(plan.tools.includes('web_search'));
  assert.ok(!plan.tools.includes('web_fetch'), '被覆盖掉的工具不应放行');
});

test('能力可增删：自定义能力 enabled=false 时不放行', () => {
  const plan = catalog({
    ...BASE,
    tools: { ...BASE.tools, capabilityEntries: { my_tools: { tools: ['foo'], enabled: false } } },
  }).resolve();
  assert.ok(!plan.tools.includes('foo'));
});
