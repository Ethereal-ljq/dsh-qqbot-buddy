/**
 * reports-template-registry —— 内置模板 + 用户自定义模板发现（模板选择插槽）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUILTIN_NAMES, TEMPLATE_NAME_RE, listTemplates, resolveTemplate, templateDirs,
} from '../lib/reports/template-registry.js';

function makeRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-tpl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function addTemplate(root, name, { meta = null, html = '<html></html>' } = {}) {
  const dir = path.join(root, 'templates', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  if (meta) fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
}

test('listTemplates：内置两套 + dataDir 下带 index.html 的自定义模板', (t) => {
  const root = makeRoot(t);
  addTemplate(root, 'demo', { meta: { label: '演示模板', description: 'demo' } });
  fs.mkdirSync(path.join(root, 'templates', 'empty'), { recursive: true }); // 没有 index.html
  addTemplate(root, 'journal'); // 与内置同名，应被忽略
  addTemplate(root, 'bad name!'); // 非法名字，应被忽略

  const list = listTemplates({ dataDir: root, env: {} });
  assert.deepEqual(list.map((item) => item.name), [...BUILTIN_NAMES, 'demo']);
  const demo = list.find((item) => item.name === 'demo');
  assert.equal(demo.label, '演示模板');
  assert.equal(demo.builtin, false);
  assert.equal(demo.file, path.join(root, 'templates', 'demo', 'index.html'));
  assert.equal(list.find((item) => item.name === 'journal').builtin, true);
});

test('listTemplates：meta.json 的 visuals 会被解析并透传（插画槽插槽）', (t) => {
  const root = makeRoot(t);
  addTemplate(root, 'art', {
    meta: {
      label: '插画模板',
      visuals: {
        slots: ['hero'],
        moods: [{ id: 'lively', label: '热闹', hours: [12] }],
        items: { 'hero-a': { slot: 'hero', file: 'assets/a.webp', label: 'A' } },
        presets: { lively: { hero: 'hero-a' } },
      },
    },
  });
  const entry = resolveTemplate('art', { dataDir: root, env: {} });
  assert.equal(entry.visuals.slots[0], 'hero');
  assert.equal(entry.visuals.items['hero-a'].file, 'assets/a.webp');
  assert.equal(entry.visuals.defaultMood, 'lively');
  assert.equal(resolveTemplate('journal', { env: {} }).visuals, null, '内置模板没有插画槽');
});

test('resolveTemplate：未知 / off 返回 null，自定义可解析', (t) => {
  const root = makeRoot(t);
  addTemplate(root, 'demo');
  assert.equal(resolveTemplate('demo', { dataDir: root, env: {} }).name, 'demo');
  assert.equal(resolveTemplate('demo', { dataDir: root, env: {} }).label, 'demo');
  assert.equal(resolveTemplate('off', { dataDir: root, env: {} }), null);
  assert.equal(resolveTemplate('missing', { dataDir: root, env: {} }), null);
});

test('带插画槽的夹具模板：每个素材至少出现在一个氛围预设里', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entry = resolveTemplate('visuals', { dataDir: path.join(repoRoot, 'test', 'fixtures'), env: {} });
  assert.ok(entry && entry.visuals, 'visuals 夹具模板应带 visuals');
  const used = new Set();
  for (const preset of Object.values(entry.visuals.presets)) {
    for (const id of Object.values(preset)) used.add(id);
  }
  const missing = Object.keys(entry.visuals.items).filter((id) => !used.has(id));
  assert.deepEqual(missing, [], '每个素材都应至少出现在一个氛围预设里，不能有“死素材”');
  // 每个氛围都必须齐全覆盖三个槽位
  for (const mood of entry.visuals.moods) {
    const preset = entry.visuals.presets[mood.id] || {};
    assert.deepEqual(Object.keys(preset).sort(), [...entry.visuals.slots].sort(), mood.id + ' 的预设缺槽位');
  }
});

test('templateDirs：QQBOT_TEMPLATE_DIRS 在前，dataDir 在后', () => {
  const dirs = templateDirs({ dataDir: '/data', env: { QQBOT_TEMPLATE_DIRS: ['/a', '/b'].join(path.delimiter) } });
  assert.deepEqual(dirs, ['/a', '/b', path.join('/data', 'templates')]);
  assert.deepEqual(templateDirs({ dataDir: '', env: {} }), []);
  assert.equal(TEMPLATE_NAME_RE.test('二次元'), false);
  assert.equal(TEMPLATE_NAME_RE.test('../evil'), false);
  assert.equal(TEMPLATE_NAME_RE.test('visuals_2'), true);
});
