/**
 * reports-cards —— 卡片渲染适配层（模板解析/字体注入/渲染器调用/JSON 解析）。
 *
 * 真实截图依赖 Chromium，单测用假 spawn 覆盖协议；模板本身的视觉由人工验收。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TEMPLATES, buildHtml, findRenderer, inlineAssets, parseRenderOutput, renderCard, templatePath,
} from '../lib/reports/cards.js';
import { resolveTemplate } from '../lib/reports/template-registry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 带插画槽的测试夹具：test/fixtures/templates/visuals（纯 SVG 素材）。
 *
 * 刻意不用 custom/ 下的示例模板：那是使用者自己的内容，可能带第三方版权素材，
 * 测试不应该依赖它；夹具放仓库里、随时可改，覆盖的契约（槽位/氛围/内联）完全一样。
 */
const FIXTURE_TEMPLATE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures');
const visualsTemplate = () => templatePath('visuals', { dataDir: FIXTURE_TEMPLATE_ROOT });
/** 模板自带的插画槽声明（meta.json → visuals）。 */
const visualsOf = () => (resolveTemplate('visuals', { dataDir: FIXTURE_TEMPLATE_ROOT, env: {} }) || {}).visuals || null;

/** 假 spawn：按 --out 参数写一个占位文件，再回一行 JSON。 */
function fakeSpawn({ exitCode = 0, json = null, create = true } = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    const outIndex = args.indexOf('--out');
    const out = outIndex >= 0 ? args[outIndex + 1] : '';
    if (create && out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, 'fake-jpeg');
    }
    const emitter = new EventEmitter();
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    emitter.kill = () => {};
    setTimeout(() => {
      if (json) emitter.stdout.emit('data', JSON.stringify(json) + '\n');
      emitter.emit('close', exitCode);
    }, 0);
    return emitter;
  };
  fn.calls = calls;
  return fn;
}

test('templatePath：内置 + dataDir 下的自定义模板，未知/缺失返回 null', () => {
  assert.ok(templatePath('journal'));
  assert.ok(templatePath('dark'));
  assert.equal(templatePath('nope'), null);
  assert.equal(templatePath('journal', { exists: () => false }), null);
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ['dark', 'journal']);
  const visuals = visualsTemplate();
  assert.ok(visuals, 'test/fixtures/templates/visuals 应能被发现');
  assert.ok(visuals.endsWith(path.join('visuals', 'index.html')));
  // 不给 dataDir 时不去猜用户目录
  assert.equal(templatePath('visuals', { env: {} }), null);
  assert.equal(templatePath('visuals', { dataDir: FIXTURE_TEMPLATE_ROOT, env: {} }), visuals);
});

test('findRenderer：按环境变量/工作区/用户目录顺序找 render.mjs', () => {
  const hit = '/ws/.dsh/skills/summary-card/scripts/render.mjs';
  const exists = (p) => p === hit;
  assert.equal(findRenderer({ workspaceRoot: '/ws', home: '/home/u', env: {}, exists }), hit);
  assert.equal(findRenderer({ workspaceRoot: '/ws', home: '/home/u', env: {}, exists: () => false }), '');
  const explicit = '/custom/render.mjs';
  assert.equal(findRenderer({ env: { QQBOT_CARD_RENDERER: explicit }, exists: (p) => p === explicit }), explicit);
});

test('buildHtml：__FONTS_CSS__ 替换为技能字体样式表（存在时）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-card-skill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const renderer = path.join(dir, 'scripts', 'render.mjs');
  fs.mkdirSync(path.dirname(renderer), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(renderer, '// fake');
  fs.writeFileSync(path.join(dir, 'assets', 'fonts.css'), '/* fonts */');
  const html = buildHtml(templatePath('journal'), { renderer });
  assert.match(html, /<link rel="stylesheet" href="file:\/\//);
  assert.match(html, /fonts\.css/);
  assert.doesNotMatch(html, /__FONTS_CSS__/);
  // 没有字体文件时留空，不阻塞渲染
  const bare = buildHtml(templatePath('journal'), { renderer: '/none/skill/scripts/render.mjs' });
  assert.doesNotMatch(bare, /__FONTS_CSS__/);
});

test('buildHtml：自定义模板的插画内联成 data URI，不残留相对路径', () => {
  const html = buildHtml(visualsTemplate(), { renderer: '/none/skill/scripts/render.mjs' });
  assert.match(html, /data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(html, /src="assets\//);
  assert.match(html, /data-slot="hero"[^>]*src="data:image\/svg\+xml/);
  assert.match(html, /data-slot="peek"[^>]*src="data:image\/svg\+xml/);
  assert.match(html, /data-slot="rhythm"[^>]*src="data:image\/svg\+xml/);
});

test('buildHtml：selection 把 data-slot 换成对应插画，非法 id 保持默认', () => {
  const visuals = visualsOf();
  assert.ok(visuals, 'visuals 模板应声明 visuals 插画槽');
  const chosen = buildHtml(visualsTemplate(), {
    inline: (html) => html,
    visuals,
    selection: { hero: 'hero-b', peek: 'peek-a', rhythm: 'rhythm-a' },
  });
  assert.match(chosen, /data-slot="hero"[^>]*src="assets\/hero-b\.svg"/);
  assert.match(chosen, /data-slot="peek"[^>]*src="assets\/peek-a\.svg"/);
  assert.match(chosen, /data-slot="rhythm"[^>]*src="assets\/rhythm-a\.svg"/);
  const fallback = buildHtml(visualsTemplate(), { inline: (html) => html, visuals, selection: { hero: 'nope' } });
  assert.match(fallback, /data-slot="hero"[^>]*src="assets\/hero-a\.svg"/);
});

test('inlineAssets：缺图或越界路径保持原样', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-card-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'a.webp'), Buffer.from([1, 2, 3]));
  const html = inlineAssets([
    '<img src="assets/a.webp">',
    '<img src="assets/missing.png">',
    '<img src="assets/../../escape.png">',
  ].join(''), { templateDir: dir });
  assert.match(html, /src="data:image\/webp;base64,AQID"/);
  assert.match(html, /src="assets\/missing.png"/);
  assert.match(html, /src="assets\/\.\.\/\.\.\/escape.png"/);
});

test('parseRenderOutput：取最后一行 JSON，忽略日志', () => {
  const out = 'warn: x\n{"ok":true,"width":1080}\n';
  assert.deepEqual(parseRenderOutput(out), { ok: true, width: 1080 });
  assert.equal(parseRenderOutput('no json'), null);
});

test('renderCard：成功时返回图片与体检结果，参数完整', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-card-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outPath = path.join(dir, 'out.jpg');
  const spawn = fakeSpawn({ json: { ok: true, width: 1080, height: 1600, px: '2160x3200', warnings: [{ code: 'small-font' }] } });
  const res = await renderCard({
    payload: { day: '2026-11-13', stats: { total: 3 }, report: { title: 't' } },
    template: 'journal',
    outPath,
    resolveRenderer: () => '/fake/render.mjs',
    spawn,
  });
  assert.equal(res.ok, true);
  assert.equal(res.path, outPath);
  assert.equal(res.px, '2160x3200');
  assert.deepEqual(res.warnings.map((w) => w.code), ['small-font']);
  const args = spawn.calls[0].args;
  assert.ok(args.includes('--html'));
  assert.ok(args.includes('--data'));
  assert.ok(args.includes('jpeg'));
  assert.ok(args.includes('--json'));
  assert.ok(fs.existsSync(outPath));
});

test('renderCard：自定义模板从 dataDir/templates 解析并出图', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-card-custom-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outPath = path.join(dir, 'out.jpg');
  const spawn = fakeSpawn({ json: { ok: true, width: 1020, height: 1800 } });
  const res = await renderCard({
    payload: { day: '2026-11-14', stats: { hours: [] }, report: { title: 't' } },
    template: 'visuals',
    dataDir: FIXTURE_TEMPLATE_ROOT,
    outPath,
    resolveRenderer: () => '/fake/render.mjs',
    spawn,
  });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(outPath));
  assert.ok(String(spawn.calls[0].args[0]).includes('render.mjs'));
});

test('renderCard：渲染器缺失 / 模板未知 / 进程失败都返回结构化 reason', async () => {
  const noRenderer = await renderCard({ payload: {}, outPath: '/tmp/x.jpg', resolveRenderer: () => '', spawn: fakeSpawn() });
  assert.equal(noRenderer.ok, false);
  assert.equal(noRenderer.reason, 'no-renderer');

  const noTemplate = await renderCard({ payload: {}, template: 'off', outPath: '/tmp/x.jpg', resolveRenderer: () => '/r', spawn: fakeSpawn() });
  assert.equal(noTemplate.ok, false);
  assert.equal(noTemplate.reason, 'no-template');

  const failed = await renderCard({
    payload: {}, outPath: '/tmp/qqbot-missing-dir-not-created.jpg',
    resolveRenderer: () => '/r', spawn: fakeSpawn({ create: false }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'render-failed');
});
