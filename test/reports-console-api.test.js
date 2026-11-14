/**
 * test/reports-console-api —— 群日报卡片模板 API（列表 / 预览 / 安装 / 删除）。
 *
 * 对应 UI 适配契约 §3：preview 用示例数据渲染自包含 HTML；install 把 base64
 * 文件数组落到 <dataDir>/templates/<name>/；delete 只允许删自定义模板目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { routes as reportRoutes } from '../lib/console/api/reports.js';
import {
  PREVIEW_HEIGHT_SCRIPT, injectPreviewData, injectPreviewScripts,
} from '../lib/reports/preview.js';
import { sampleDailyPayload } from '../lib/reports/sample.js';
import { createHarness } from './console-helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 带插画槽的测试夹具（纯 SVG，无第三方素材）：复制到 harness 的 dataDir/templates/visuals 后应能被发现。
 * 用夹具而不是 custom/ 下的示例模板，测试就不依赖使用者的自定义内容。
 */
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'templates', 'visuals');

/** 安装用的小模板：自己读 window.__CARD_DATA__ 渲染标题。 */
const MINI_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>mini</title></head>'
  + '<body><h1 id="title"></h1><script>var d = window.__CARD_DATA__ || {};'
  + 'document.getElementById("title").textContent = (d.report && d.report.title) || "";</script></body></html>';

/** 字符串 → base64（安装接口 content 字段）。 */
function b64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** 安装包：index.html + 额外文件。 */
function templateFiles(extra = []) {
  return [{ path: 'index.html', content: b64(MINI_HTML) }, ...extra];
}

/** 起 harness 并登录。 */
async function loggedHarness(t) {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();
  return h;
}

/** 把带插画槽的夹具模板复制进 harness 数据目录。 */
function copyVisualsTemplate(h) {
  const target = path.join(h.dataDir, 'templates', 'visuals');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(FIXTURE_DIR, target, { recursive: true });
  return target;
}

test('GET /api/reports/templates：内置 journal/dark 在列表里（回归）', async (t) => {
  const h = await loggedHarness(t);
  const res = await h.request('GET', '/api/reports/templates');
  assert.equal(res.status, 200, res.text);
  const items = res.data.items;
  const names = items.map((item) => item.name);
  assert.ok(names.includes('journal'));
  assert.ok(names.includes('dark'));
  const journal = items.find((item) => item.name === 'journal');
  assert.equal(journal.builtin, true);
  assert.equal(journal.label, '纸刊 · 暖色');
  assert.equal(res.data.dataDir, h.dataDir);
});

test('GET preview：journal 返回自包含 HTML（示例数据 + 高度上报协议）', async (t) => {
  const h = await loggedHarness(t);
  const res = await h.request('GET', '/api/reports/templates/preview?name=journal');
  assert.equal(res.status, 200, res.text);
  const preview = res.data;
  assert.equal(preview.name, 'journal');
  assert.equal(preview.label, '纸刊 · 暖色');
  assert.equal(preview.description, '');
  assert.equal(preview.builtin, true);
  assert.equal(preview.width, 1200);
  // journal 没有声明插画槽：没有氛围，也没有插画切换
  assert.equal(preview.mood, '');
  assert.equal(preview.visuals, null);
  assert.match(preview.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(preview.html.includes('window.__CARD_DATA__'));
  assert.ok(preview.html.includes('qqbot:report-preview'));
  assert.ok(preview.html.includes('data:image/'), '模板自带的 SVG 背景应保持内联');
  assert.doesNotMatch(preview.html, /__FONTS_CSS__/, '字体占位应被清空');
  assert.ok(preview.html.indexOf('window.__CARD_DATA__') < preview.html.indexOf('</head>'));

  const dated = await h.request(
    'GET', '/api/reports/templates/preview?name=journal&mood=night&day=2026-11-13',
  );
  assert.equal(dated.status, 200, dated.text);
  assert.equal(dated.data.mood, '', '没有插画槽的模板忽略 mood');
  assert.equal(dated.data.day, '2026-11-13');
  assert.ok(dated.data.html.includes('"day":"2026-11-13"'));
  assert.notEqual(dated.data.html, preview.html, '换日期后 HTML 应不同');
});

test('GET preview?meta=1：只回元数据（html 为空串），页面用它做错误处理与展示', async (t) => {
  const h = await loggedHarness(t);
  const res = await h.request('GET', '/api/reports/templates/preview?name=journal&meta=1');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.name, 'journal');
  assert.equal(res.data.html, '');
  assert.equal(res.data.width, 1200);
  assert.match(res.data.day, /^\d{4}-\d{2}-\d{2}$/);
});

test('GET preview/html：独立预览文档（自带窄 CSP + SAMEORIGIN，可被同源 iframe 嵌入）', async (t) => {
  const h = await loggedHarness(t);
  const res = await h.request('GET', '/api/reports/templates/preview/html?name=journal');
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.match(String(res.headers.get('content-type')), /text\/html/);
  const csp = String(res.headers.get('content-security-policy') || '');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.match(csp, /img-src data:/);
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  // 控制台页面 CSP 是 script-src 'self'；srcdoc 会继承它把模板脚本拦掉，所以必须走独立文档。
  assert.ok(res.text.includes('window.__CARD_DATA__'));
  assert.ok(res.text.includes('qqbot:report-preview'));

  const missing = await h.request('GET', '/api/reports/templates/preview/html');
  assert.equal(missing.status, 400);
  const absent = await h.request('GET', '/api/reports/templates/preview/html?name=nope');
  assert.equal(absent.status, 404);
});

test('GET preview：缺 name 400、不存在 404、mood 按模板声明校验、day 非法回退今天', async (t) => {
  const h = await loggedHarness(t);
  const missing = await h.request('GET', '/api/reports/templates/preview');
  assert.equal(missing.status, 400);
  assert.match(missing.data.error.message, /缺少 name/);

  const absent = await h.request('GET', '/api/reports/templates/preview?name=not-exist');
  assert.equal(absent.status, 404);
  assert.equal(absent.data.error.code, 'not_found');
  assert.match(absent.data.error.message, /模板不存在/);

  // 没有插画槽的模板不校验 mood（忽略即可）
  const ignoredMood = await h.request('GET', '/api/reports/templates/preview?name=journal&mood=wild');
  assert.equal(ignoredMood.status, 200, ignoredMood.text);
  assert.equal(ignoredMood.data.mood, '');

  // 声明了插画槽的模板：mood 必须在 meta.json 的列表里，非法值 400
  copyVisualsTemplate(h);
  const badMood = await h.request('GET', '/api/reports/templates/preview?name=visuals&mood=wild');
  assert.equal(badMood.status, 400);
  assert.match(badMood.data.error.message, /mood/);

  // mood=random：后端每次从模板声明的氛围里摇一个
  const randomMood = await h.request('GET', '/api/reports/templates/preview?name=visuals&mood=random&meta=1');
  assert.equal(randomMood.status, 200, randomMood.text);
  assert.ok(
    ['lively', 'calm'].includes(randomMood.data.mood),
    'random 必须落在模板声明的氛围里：' + randomMood.data.mood,
  );

  // 不给 mood（模型选择/时段兜底）：示例数据高峰 19 点 → lively
  const autoMood = await h.request('GET', '/api/reports/templates/preview?name=visuals&meta=1');
  assert.equal(autoMood.status, 200, autoMood.text);
  assert.equal(autoMood.data.mood, 'lively');

  const badDay = await h.request('GET', '/api/reports/templates/preview?name=journal&day=not-a-day');
  assert.equal(badDay.status, 200, badDay.text);
  assert.match(badDay.data.day, /^\d{4}-\d{2}-\d{2}$/);
});

test('sampleDailyPayload：与真实 daily payload 同形状（version 1 / 24 项 hours / 3 话题）', () => {
  const payload = sampleDailyPayload({ day: '2026-11-13', mood: 'night' });
  assert.equal(payload.version, 1);
  assert.equal(payload.botId, 'sample-bot');
  assert.equal(payload.peer, 'group:sample');
  assert.equal(payload.day, '2026-11-13');
  assert.equal(payload.meta.digest, 'SAMPLE01');
  assert.equal(payload.stats.total, 186);
  assert.equal(payload.stats.speakers, 23);
  assert.equal(payload.stats.hours.length, 24);
  assert.ok(payload.stats.hours.every((n) => typeof n === 'number'));
  assert.equal(payload.stats.hours.indexOf(Math.max(...payload.stats.hours)), 19, '峰值应在 19 点');
  assert.equal(payload.stats.topSpeakers.length, 8);
  const first = new Date(payload.stats.firstAt);
  const last = new Date(payload.stats.lastAt);
  assert.equal(first.getHours(), 8);
  assert.equal(first.getMinutes(), 12);
  assert.equal(last.getHours(), 23);
  assert.equal(last.getMinutes(), 41);
  assert.equal(payload.report.title, '从一只猫聊到周末的山道');
  assert.equal(payload.report.topics.length, 3);
  assert.equal(payload.report.quotes.length, 3);
  assert.equal(payload.report.visual.mood, 'night');
  assert.ok(payload.report.topics.every((topic) => Array.isArray(topic.quotes) && topic.quotes.length >= 1));

  // 默认不带 visual（模板没插画槽时预览不需要氛围）；传什么 mood 就原样带上，合法性由模板声明决定
  assert.equal(sampleDailyPayload({}).report.visual, undefined);
  assert.equal(sampleDailyPayload({ mood: 'wild' }).report.visual.mood, 'wild');
  assert.match(sampleDailyPayload({}).day, /^\d{4}-\d{2}-\d{2}$/);
});

test('injectPreviewData / 高度脚本：< 转义、注入位置固定', () => {
  const payload = { report: { title: '<script>alert(1)</script>' }, visual: { mood: 'lively' } };
  const html = injectPreviewScripts('<html><head><title>x</title></head><body><p>hi</p></body></html>', payload);
  assert.ok(html.includes('window.__CARD_DATA__'));
  assert.ok(!html.includes('<script>alert(1)'), '示例数据里的 < 必须转义，不能闭合脚本');
  assert.ok(html.includes('\\u003cscript'));
  assert.ok(html.indexOf('window.__CARD_DATA__') < html.indexOf('</head>'));
  assert.ok(html.indexOf(PREVIEW_HEIGHT_SCRIPT) > html.indexOf('<p>hi</p>'));
  assert.ok(html.indexOf(PREVIEW_HEIGHT_SCRIPT) < html.indexOf('</body>'));
  assert.ok(html.includes("type:'qqbot:report-preview'"));
  const dataOnly = injectPreviewData('<html><head></head><body></body></html>', payload);
  assert.ok(!dataOnly.includes('qqbot:report-preview'), 'injectPreviewData 只注入数据脚本');
});

test('自定义模板预览：夹具模板被发现，mood 改变插画（选图变化）', async (t) => {
  const h = await loggedHarness(t);
  copyVisualsTemplate(h);

  const list = await h.request('GET', '/api/reports/templates');
  assert.equal(list.status, 200, list.text);
  const custom = list.data.items.find((item) => item.name === 'visuals');
  assert.ok(custom, 'dataDir/templates/visuals 应被发现');
  assert.equal(custom.builtin, false);
  assert.equal(custom.label, '测试 · 插画槽');
  assert.match(custom.description, /SVG/);
  // 插画槽/氛围由模板 meta.json 声明，列表接口透传给控制台
  assert.deepEqual(custom.visuals.moods.map((item) => item.id), ['lively', 'calm']);
  assert.ok(custom.visuals.slots.includes('hero'));

  const lively = await h.request('GET', '/api/reports/templates/preview?name=visuals&mood=lively');
  const calm = await h.request('GET', '/api/reports/templates/preview?name=visuals&mood=calm');
  assert.equal(lively.status, 200, lively.text);
  assert.equal(calm.status, 200, calm.text);
  assert.equal(lively.data.builtin, false);
  assert.equal(lively.data.label, '测试 · 插画槽');
  assert.equal(lively.data.mood, 'lively');
  assert.equal(calm.data.mood, 'calm');
  assert.equal(lively.data.visuals.defaultMood, 'lively');
  assert.match(lively.data.html, /data:image\/svg\+xml;base64,/, '插画应内联成 data URI');
  assert.doesNotMatch(lively.data.html, /src="assets\//, '不应残留相对资源路径');
  const heroOf = (html) => (/data-slot="hero"[^>]*src="([^"]*)"/.exec(html) || [])[1] || '';
  const livelyHero = heroOf(lively.data.html);
  const calmHero = heroOf(calm.data.html);
  assert.notEqual(livelyHero, '');
  assert.notEqual(calmHero, '');
  assert.notEqual(livelyHero, calmHero, '换氛围应换一张 hero 插画');
  assert.notEqual(lively.data.html, calm.data.html);
  assert.ok(lively.data.html.includes('qqbot:report-preview'));
});

test('install：正常安装（自动 meta.json）→ 列表可见 → 预览可用', async (t) => {
  const h = await loggedHarness(t);
  const css = '.card { color: #123; }';
  const res = await h.request('POST', '/api/reports/templates/install', {
    body: {
      name: 'mini-card',
      label: '我的小卡片',
      description: '安装测试用模板',
      files: templateFiles([{ path: 'assets/style.css', content: b64(css) }]),
    },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.name, 'mini-card');
  assert.equal(res.data.label, '我的小卡片');
  assert.equal(res.data.description, '安装测试用模板');
  assert.equal(res.data.builtin, false);
  assert.equal(res.data.files, 3, 'index.html + assets/style.css + 自动 meta.json');
  const autoMeta = JSON.stringify({ label: '我的小卡片', description: '安装测试用模板' }, null, 2) + '\n';
  assert.equal(res.data.bytes, Buffer.byteLength(MINI_HTML) + Buffer.byteLength(css) + Buffer.byteLength(autoMeta));

  const dir = path.join(h.dataDir, 'templates', 'mini-card');
  assert.ok(fs.existsSync(path.join(dir, 'index.html')));
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'style.css')));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.label, '我的小卡片');
  assert.equal(meta.description, '安装测试用模板');

  const list = await h.request('GET', '/api/reports/templates');
  const installed = list.data.items.find((item) => item.name === 'mini-card');
  assert.ok(installed);
  assert.equal(installed.builtin, false);
  assert.equal(installed.label, '我的小卡片');

  const preview = await h.request('GET', '/api/reports/templates/preview?name=mini-card&mood=calm');
  assert.equal(preview.status, 200, preview.text);
  assert.equal(preview.data.builtin, false);
  assert.equal(preview.data.label, '我的小卡片');
  assert.equal(preview.data.mood, '', '没声明插画槽的模板没有氛围');
  assert.ok(preview.data.html.includes('window.__CARD_DATA__'));
  assert.ok(preview.data.html.includes('qqbot:report-preview'));
});

test('install：同名 409，replace:true 覆盖（带自己的 meta.json、清掉旧文件）', async (t) => {
  const h = await loggedHarness(t);
  const install = (body) => h.request('POST', '/api/reports/templates/install', { body });
  const first = await install({
    name: 'swap-card',
    label: '旧标签',
    files: templateFiles([{ path: 'assets/old.css', content: b64('body { color: red; }') }]),
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.files, 3);
  const dir = path.join(h.dataDir, 'templates', 'swap-card');
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'old.css')));

  const conflict = await install({ name: 'swap-card', files: templateFiles() });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'template_exists');

  const metaJson = JSON.stringify({ label: '覆盖版', description: '覆盖后的说明' });
  const replaced = await install({
    name: 'swap-card',
    replace: true,
    files: templateFiles([{ path: 'meta.json', content: b64(metaJson) }]),
  });
  assert.equal(replaced.status, 200, replaced.text);
  assert.equal(replaced.data.label, '覆盖版');
  assert.equal(replaced.data.description, '覆盖后的说明');
  assert.equal(replaced.data.files, 2, 'index.html + 模板自带 meta.json（不重复自动写）');
  assert.equal(replaced.data.builtin, false);
  assert.equal(fs.existsSync(path.join(dir, 'assets', 'old.css')), false, 'replace 应先删旧目录再写');

  const list = await h.request('GET', '/api/reports/templates');
  assert.equal(list.data.items.find((item) => item.name === 'swap-card').label, '覆盖版');
});

test('install：参数校验矩阵（400/409 错误码）', async (t) => {
  const h = await loggedHarness(t);
  const install = (body) => h.request('POST', '/api/reports/templates/install', { body });
  const cases = [
    ['name 缺失', { files: templateFiles() }, 400, 'invalid_name'],
    ['name 非法字符', { name: 'bad name', files: templateFiles() }, 400, 'invalid_name'],
    ['name 超长', { name: 'a'.repeat(33), files: templateFiles() }, 400, 'invalid_name'],
    ['请求体是数组', [], 400, 'invalid_name'],
    ['files 不是数组', { name: 'x1', files: 'nope' }, 400, 'invalid_files'],
    ['files 为空', { name: 'x1', files: [] }, 400, 'invalid_files'],
    ['缺 index.html', { name: 'x2', files: [{ path: 'meta.json', content: b64('{}') }] }, 400, 'missing_index'],
    ['路径含 ..', {
      name: 'x3',
      files: [...templateFiles(), { path: '../evil.html', content: b64('<html></html>') }],
    }, 400, 'invalid_files'],
    ['绝对路径', {
      name: 'x4',
      files: [...templateFiles(), { path: '/etc/evil.html', content: b64('<html></html>') }],
    }, 400, 'invalid_files'],
    ['Windows 盘符路径', {
      name: 'x5',
      files: [...templateFiles(), { path: 'C:/evil.html', content: b64('<html></html>') }],
    }, 400, 'invalid_files'],
    ['反斜杠路径', {
      name: 'x6',
      files: [...templateFiles(), { path: 'assets\\a.png', content: b64('x') }],
    }, 400, 'invalid_files'],
    ['扩展名不在白名单', {
      name: 'x7',
      files: [...templateFiles(), { path: 'assets/a.exe', content: b64('x') }],
    }, 400, 'invalid_files'],
    ['base64 非法', { name: 'x8', files: [{ path: 'index.html', content: '!!!not-base64!!!' }] }, 400, 'invalid_files'],
    ['内置名 journal', { name: 'journal', files: templateFiles() }, 409, 'template_reserved'],
    ['保留名 dark', { name: 'dark', files: templateFiles() }, 409, 'template_reserved'],
    ['保留名 off', { name: 'off', files: templateFiles() }, 409, 'template_reserved'],
  ];
  for (const [label, body, status, code] of cases) {
    const res = await install(body);
    assert.equal(res.status, status, label + '：' + res.text);
    assert.equal(res.data.error.code, code, label);
    assert.equal(typeof res.data.error.message, 'string', label);
  }
  assert.equal(fs.existsSync(path.join(h.dataDir, 'templates', 'journal')), false, '被拒绝的安装不应落盘');
});

test('install：大 body（> 1MB 默认上限）走 per-route 16MB 上限', async (t) => {
  const h = await loggedHarness(t);
  const route = reportRoutes.find((item) => item.path === '/api/reports/templates/install');
  assert.ok(route);
  assert.equal(route.method, 'POST');
  assert.equal(route.maxBodyBytes, 16 * 1024 * 1024, 'install 路由应声明 16MB 上限');

  const pad = Buffer.alloc(1.5 * 1024 * 1024, 0x41);
  const raw = JSON.stringify({
    name: 'big-card',
    files: templateFiles([{ path: 'assets/pad.webp', content: pad.toString('base64') }]),
  });
  assert.ok(Buffer.byteLength(raw) > 1024 * 1024, '构造的请求体应超过默认 1MB 上限');
  const res = await h.request('POST', '/api/reports/templates/install', { body: raw });
  assert.equal(res.status, 200, res.text.slice(0, 300));
  assert.equal(res.data.files, 2);
  assert.equal(res.data.bytes, pad.length + Buffer.byteLength(MINI_HTML));
  const saved = fs.statSync(path.join(h.dataDir, 'templates', 'big-card', 'assets', 'pad.webp'));
  assert.equal(saved.size, pad.length);
});

test('install：单文件解码后超 8MB → 400 invalid_files', async (t) => {
  const h = await loggedHarness(t);
  const huge = Buffer.alloc(8 * 1024 * 1024 + 1, 0x42);
  const res = await h.request('POST', '/api/reports/templates/install', {
    body: {
      name: 'too-big',
      files: templateFiles([{ path: 'assets/huge.webp', content: huge.toString('base64') }]),
    },
  });
  assert.equal(res.status, 400, res.text.slice(0, 300));
  assert.equal(res.data.error.code, 'invalid_files');
  assert.match(res.data.error.message, /8MB/);
  assert.equal(fs.existsSync(path.join(h.dataDir, 'templates', 'too-big')), false);
});

test('install：文件数超过 64 个 → 400 invalid_files', async (t) => {
  const h = await loggedHarness(t);
  const files = templateFiles();
  for (let i = 0; i < 64; i += 1) {
    files.push({ path: 'assets/p' + i + '.png', content: b64('x') });
  }
  assert.equal(files.length, 65);
  const res = await h.request('POST', '/api/reports/templates/install', { body: { name: 'many', files } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'invalid_files');
});

test('install/delete：数据目录未装配 → 501 not_ready', () => {
  const install = reportRoutes.find((item) => item.path === '/api/reports/templates/install').handler;
  const remove = reportRoutes.find((item) => item.path === '/api/reports/templates/:name').handler;
  const isNotReady = (err) => err.status === 501 && err.code === 'not_ready';
  assert.throws(() => install({ deps: { paths: {} }, body: { name: 'x', files: templateFiles() } }), isNotReady);
  assert.throws(() => remove({ deps: { paths: {} }, params: { name: 'x' } }), isNotReady);
});

test('install：未登录 → 401 且不落盘', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const res = await h.request('POST', '/api/reports/templates/install', {
    body: { name: 'anon', files: templateFiles() },
    auth: false,
    csrf: false,
  });
  assert.equal(res.status, 401);
  assert.equal(res.data.error.code, 'unauthorized');
  assert.equal(fs.existsSync(path.join(h.dataDir, 'templates', 'anon')), false);
});

test('DELETE：删除自定义模板 → 列表/预览消失；内置/不存在/非法名报错', async (t) => {
  const h = await loggedHarness(t);
  const installed = await h.request('POST', '/api/reports/templates/install', {
    body: { name: 'del-card', label: '待删除', files: templateFiles() },
  });
  assert.equal(installed.status, 200, installed.text);
  const dir = path.join(h.dataDir, 'templates', 'del-card');
  assert.ok(fs.existsSync(dir));

  const deleted = await h.request('DELETE', '/api/reports/templates/del-card');
  assert.equal(deleted.status, 200, deleted.text);
  assert.deepEqual(deleted.data, { ok: true, name: 'del-card' });
  assert.equal(fs.existsSync(dir), false);

  const list = await h.request('GET', '/api/reports/templates');
  assert.equal(list.data.items.some((item) => item.name === 'del-card'), false);
  const preview = await h.request('GET', '/api/reports/templates/preview?name=del-card');
  assert.equal(preview.status, 404);

  const builtin = await h.request('DELETE', '/api/reports/templates/dark');
  assert.equal(builtin.status, 400);
  assert.equal(builtin.data.error.code, 'template_reserved');
  const reservedOff = await h.request('DELETE', '/api/reports/templates/off');
  assert.equal(reservedOff.status, 400);
  assert.equal(reservedOff.data.error.code, 'template_reserved');
  const absent = await h.request('DELETE', '/api/reports/templates/not-exist');
  assert.equal(absent.status, 404);
  assert.equal(absent.data.error.code, 'not_found');
  const invalid = await h.request('DELETE', '/api/reports/templates/bad%20name');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, 'invalid_name');
});
