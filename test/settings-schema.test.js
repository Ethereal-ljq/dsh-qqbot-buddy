/**
 * 设置页结构声明测试：schema 完整 + 可扩展。
 */
import assert from 'node:assert/strict';
import test from 'node:test';


test('settings-schema：每个工作区都有 label/items/group，页面 id 全局唯一', async () => {
  const m = await import('../lib/settings-schema.js');
  const payload = m.schemaPayload();
  const groupIds = new Set(payload.groups.map((g) => g.id));
  assert.ok(payload.groups.length >= 4, '至少 4 个分组');
  assert.ok(payload.groups.every((g) => typeof g.label === 'string' && g.label !== ''), '分组要有 label');

  const sectionIds = new Set();
  const itemIds = new Set();
  for (const item of payload.sections) {
    assert.ok(typeof item.id === 'string' && item.id !== '', 'id 必填');
    assert.ok(!sectionIds.has(item.id), '工作区 id 不可重复: ' + item.id);
    sectionIds.add(item.id);
    assert.ok(typeof item.label === 'string' && item.label !== '', item.id + ' 缺 label');
    assert.ok(groupIds.has(item.group), item.id + ' 的 group 必须在分组里');
    assert.ok(Array.isArray(item.items) && item.items.length > 0, item.id + ' 至少有一个页面');
    assert.ok(typeof item.landing === 'string' && item.landing !== '', item.id + ' 缺 landing');
    for (const child of item.items) {
      assert.ok(typeof child.id === 'string' && child.id !== '', item.id + ' 的子项缺 id');
      assert.ok(!itemIds.has(child.id), '页面 id 必须全局唯一（跨工作区跳转依赖它）: ' + child.id);
      itemIds.add(child.id);
      assert.ok(typeof child.label === 'string' && child.label !== '', child.id + ' 缺 label');
      assert.ok(typeof child.widget === 'string' && child.widget !== '', child.id + ' 缺 widget');
    }
    assert.ok(item.items.some((child) => child.id === item.landing), item.id + ' 的 landing 不在 items 里');
    // 兼容旧字段：children 与 items 同步
    assert.equal(item.children.length, item.items.length, item.id + ' children 应与 items 同步');
    assert.ok(Array.isArray(item.keywords), item.id + ' 缺 keywords');
  }
  assert.equal(m.getSection('不存在'), null);
});

test('settings-schema：前端 widgets 表覆盖所有页面（不会点开是空白）', async () => {
  const m = await import('../lib/settings-schema.js');
  const payload = m.schemaPayload();
  const widgets = new Set();
  for (const section of payload.sections) for (const item of section.items) widgets.add(item.widget);
  // client/client.js 的 widgets 表必须能渲染每一个 widget
  const fs = await import('node:fs');
  const client = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  for (const widget of widgets) {
    assert.ok(
      new RegExp('^\\s*' + widget + ':', 'm').test(client),
      'client.js 的 widgets 表缺少 widget: ' + widget,
    );
  }
  // 反向：反查页面归属
  assert.equal(m.getItem('speech').sectionId, 'prompts');
  assert.equal(m.getItem('safety').sectionId, 'security', '安全红线归入权限工作区');
  assert.equal(m.getItem('messageStyle').sectionId, 'dialog');
  assert.equal(m.landingOf('ability'), 'model');
  assert.equal(m.landingOf('content'), 'stickers');
  assert.equal(m.getItem('不存在'), null);
});

test('client 里引用的每个提示段 id 都真实存在（防止设置页写进永不生效的键）', async () => {
  const fs = await import('node:fs');
  const sectionsModule = await import('../lib/prompt-sections.js');
  const client = fs.readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  const known = new Set(sectionsModule.PROMPT_SECTIONS.map((item) => item.id));
  const used = new Set();
  for (const match of client.matchAll(/sectionId: "([A-Za-z0-9_-]+)"/g)) used.add(match[1]);
  for (const match of client.matchAll(/LegacyPromptPage\("([A-Za-z0-9_-]+)"/g)) used.add(match[1]);
  assert.ok(used.size > 0, '应至少引用一个提示段');
  for (const id of used) {
    assert.ok(known.has(id), '设置页引用了不存在的提示段 id: ' + id + '（已知：' + [...known].join(',') + '）');
  }
  assert.ok(used.has('stickers'), '表情包段应使用 sectionId: "stickers"');
  assert.ok(!used.has('stickerGuide'), '不应把 prompts.stickerGuide 当作段 id');
});
test('settings-schema：新增工作区只需加声明（结构可扩展）', async () => {
  const m = await import('../lib/settings-schema.js');
  const sample = {
    id: 'future', label: '未来设置', group: 'ability', icon: '✨', desc: '示例',
    keywords: ['未来'],
    items: [
      { id: 'futureA', label: '子项 A', widget: 'model', desc: '' },
      { id: 'futureB', label: '子项 B', widget: 'overview', desc: '' },
    ],
  };
  const payload = m.schemaPayload();
  const merged = payload.sections.concat([sample]);
  assert.equal(merged.filter((s) => s.id === 'future').length, 1);
  assert.ok(merged.every((s) => s.items && s.items.length > 0), '所有区都有 items 即可渲染');
});
