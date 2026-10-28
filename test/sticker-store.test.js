/**
 * sticker-store 单测：隔离临时目录，不触碰真实工作区/网络。
 * 覆盖：空库/ensure、list 合并历史文件、catalog、get/read、saveBuffer 默认命名与重名、
 *       magic bytes/大小/非法文件名拒绝、内容 hash 去重（含历史文件补算）、
 *       每日配额 countAddedSince/collectQuota、importFile、update（改元数据+renameTo）、
 *       delete、index.json 原子写&权限&损坏恢复。
 * 只 import 本仓库模块与 node: 内置模块（不依赖任何 @deepseek-ai 包）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStickerStore } from '../lib/stickers/store.js';

const QUIET_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

// 最小 magic bytes 样本（store 只嗅探文件头，不要求完整图片）
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body', 'latin1')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body', 'latin1')]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from('gif-body', 'latin1')]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.from('webp-body', 'latin1')]);

/** 在图片尾部追加标记：magic bytes 不变但内容 hash 不同，用于构造「不同」的表情 */
function variant(buffer, marker) {
  return Buffer.concat([buffer, Buffer.from('#' + marker, 'utf8')]);
}

/** 与 store 一致的 hash（sha256 前 16 位） */
function sha16(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

/** 建一个隔离的 store；t.after 负责清理临时目录 */
function makeStore(t, overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sticker-'));
  t.after(() => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
  });
  const dir = overrides.dir ?? path.join(base, 'stickers');
  const stickers = { dir, collectEnabled: true, maxMB: 8, ...overrides };
  const settings = { get: () => ({ stickers }) };
  const store = createStickerStore({ settings, logger: QUIET_LOGGER });
  return { store, dir, base, stickers };
}

test('空库：ensure 建目录，list/catalog/index 为空', (t) => {
  const { store, dir } = makeStore(t);
  assert.equal(store.dir(), path.resolve(dir));
  assert.equal(fs.existsSync(dir), false);

  assert.deepEqual(store.ensure(), { ok: true, created: true });
  assert.equal(fs.existsSync(dir), true);
  assert.deepEqual(store.ensure(), { ok: true, created: false });

  assert.deepEqual(store.list(), []);
  assert.equal(store.catalog(), '');
  assert.equal(store.catalog(0), '');
  assert.deepEqual(store.index(), { version: 1, items: {} });
  assert.equal(store.get('nope.png'), undefined);
});

test('list 合并历史图片与 index 元数据，忽略非图片/隐藏文件/子目录', (t) => {
  const { store, dir } = makeStore(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'laugh.png'), variant(PNG, 'legacy-laugh'));
  fs.writeFileSync(path.join(dir, 'cry.jpg'), variant(JPEG, 'legacy-cry'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an image');
  fs.writeFileSync(path.join(dir, '.tmp-1.png'), variant(PNG, 'tmp')); // 原子写残留：隐藏文件必须忽略
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'inner.png'), variant(PNG, 'inner'));

  const saved = store.saveBuffer(PNG, { name: 'hehe.png', emotion: '开心', tags: ['搞笑', '日常'], note: '常用', source: 'tool' });
  assert.equal(saved.ok, true);
  assert.equal(saved.created, true);

  const items = store.list();
  assert.deepEqual(items.map((i) => i.name), ['cry.jpg', 'hehe.png', 'laugh.png']);

  const laugh = items.find((i) => i.name === 'laugh.png');
  assert.equal(laugh.emotion, 'laugh', '历史文件 emotion = 文件名去扩展名');
  assert.deepEqual(laugh.tags, []);
  assert.equal(laugh.note, '');
  assert.equal(laugh.source, 'legacy');
  assert.equal(laugh.path, path.join(dir, 'laugh.png'));
  assert.equal(laugh.size, fs.statSync(path.join(dir, 'laugh.png')).size);
  assert.equal(typeof laugh.mtime, 'number');
  assert.equal(typeof laugh.addedAt, 'number');
  assert.ok(laugh.addedAt > 0);
  assert.equal(laugh.hash, sha16(variant(PNG, 'legacy-laugh')));

  const hehe = items.find((i) => i.name === 'hehe.png');
  assert.equal(hehe.emotion, '开心');
  assert.deepEqual(hehe.tags, ['搞笑', '日常']);
  assert.equal(hehe.note, '常用');
  assert.equal(hehe.source, 'tool');
  assert.equal(hehe.hash, sha16(PNG));

  assert.equal(items.some((i) => i.name === 'notes.txt' || i.name === '.tmp-1.png'), false);
  assert.equal(items.length, 3, '子目录里的图片不递归展示');

  assert.equal(store.catalog(), 'cry.jpg=cry, hehe.png=开心, laugh.png=laugh');
  assert.equal(store.catalog(2), 'cry.jpg=cry, hehe.png=开心');
  assert.equal(store.catalog('x'), store.catalog()); // 非法 maxItems 回退默认
});

test('get/read：返回展示对象（含 hash）与二进制；非法名/不存在按契约处理', (t) => {
  const { store } = makeStore(t);
  const saved = store.saveBuffer(PNG, { name: 'a.png', emotion: '大笑' });
  assert.equal(saved.ok, true);

  const item = store.get('a.png');
  assert.equal(item.name, 'a.png');
  assert.equal(item.emotion, '大笑');
  assert.equal(item.size, PNG.length);
  assert.equal(item.hash, sha16(PNG));

  assert.equal(store.get('../a.png'), undefined);
  assert.equal(store.get('a.txt'), undefined);
  assert.equal(store.get('missing.png'), undefined);

  assert.deepEqual(store.read('a.png'), PNG);
  assert.throws(() => store.read('missing.png'), (err) => err && err.code === 'ENOENT');
  assert.throws(() => store.read('a.txt'), (err) => err && err.code === 'EINVAL');
  assert.throws(() => store.read('../a.png'), (err) => err && err.code === 'EINVAL');
  assert.throws(() => store.read('.hidden.png'), (err) => err && err.code === 'EINVAL');
});

test('saveBuffer 默认命名/显式命名/重名后缀/无扩展名自动补', (t) => {
  const { store, dir } = makeStore(t);

  const first = store.saveBuffer(PNG, { emotion: '大笑' });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.match(first.name, /^大笑-\d+-[0-9a-f]{4}\.png$/);
  assert.equal(first.item.name, first.name);

  const fallback = store.saveBuffer(variant(PNG, 'fallback'), {});
  assert.match(fallback.name, /^sticker-\d+-[0-9a-f]{4}\.png$/);

  const named = store.saveBuffer(JPEG, { name: 'cat.jpg' });
  assert.equal(named.name, 'cat.jpg');
  assert.equal(store.saveBuffer(variant(JPEG, 'cat2'), { name: 'cat.jpg' }).name, 'cat-2.jpg');
  assert.equal(store.saveBuffer(variant(JPEG, 'cat3'), { name: 'cat.jpg' }).name, 'cat-3.jpg');

  // 显式 name 不带扩展名：补 magic 嗅探出的规范扩展名
  assert.equal(store.saveBuffer(variant(PNG, 'naked'), { name: 'naked' }).name, 'naked.png');
  assert.equal(store.saveBuffer(GIF, { name: 'g' }).name, 'g.gif');
  assert.equal(store.saveBuffer(WEBP, { name: 'w' }).name, 'w.webp');

  // 扩展名与真实内容不符 → 拒绝（防止 .gif 里塞 png）
  const mismatch = store.saveBuffer(variant(PNG, 'mismatch'), { name: 'bad.gif' });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /扩展名与图片内容不符/);

  assert.equal(fs.existsSync(path.join(dir, 'cat-2.jpg')), true);
});

test('内容去重：相同图片二次 save 返回 duplicate，不新增文件/条目且不改 index', (t) => {
  const { store, dir } = makeStore(t);
  const indexPath = path.join(dir, 'index.json');

  const first = store.saveBuffer(PNG, { name: 'dup.png', emotion: '开心', tags: ['a'] });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  const indexBefore = fs.readFileSync(indexPath, 'utf8');
  const listBefore = store.list();

  // 即使传了不同 name/emotion，相同内容也命中已有条目
  const second = store.saveBuffer(PNG, { name: 'another.png', emotion: '难过' });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.created, false);
  assert.equal(second.name, 'dup.png');
  assert.equal(second.item.name, 'dup.png');
  assert.equal(second.item.emotion, '开心', '命中已有条目时元数据不变');
  assert.deepEqual(second.item.tags, ['a']);
  assert.equal(second.item.hash, sha16(PNG));

  assert.equal(fs.readFileSync(indexPath, 'utf8'), indexBefore, 'duplicate 不应改写 index');
  assert.deepEqual(store.list().map((i) => i.name), ['dup.png']);
  assert.deepEqual(store.list(), listBefore);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.png')), ['dup.png']);

  // 内容不同的同名保存仍走 -2 后缀
  const third = store.saveBuffer(variant(PNG, 'other'), { name: 'dup.png' });
  assert.equal(third.ok, true);
  assert.equal(third.duplicate, false);
  assert.equal(third.name, 'dup-2.png');
  assert.equal(store.list().length, 2);
});

test('hash：写入 index、list/get 暴露、rename 后保留', (t) => {
  const { store } = makeStore(t);
  const expected = sha16(PNG);
  const saved = store.saveBuffer(PNG, { name: 'h.png', emotion: 'x' });
  assert.equal(saved.item.hash, expected);
  assert.equal(store.index().items['h.png'].hash, expected);
  assert.equal(store.get('h.png').hash, expected);
  assert.equal(store.list()[0].hash, expected);

  const renamed = store.update('h.png', { renameTo: 'h2.png', emotion: 'y' });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.item.name, 'h2.png');
  assert.equal(renamed.item.hash, expected, 'rename 不能丢掉内容指纹');
  assert.equal(store.index().items['h2.png'].hash, expected);
});

test('历史文件 hash 补算后可去重（补算只缓存，不为此改 index）', (t) => {
  const { store, dir } = makeStore(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'legacy.png'), PNG);

  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].hash, sha16(PNG), '历史文件 list 时按需补算 hash');
  assert.equal(items[0].source, 'legacy');
  assert.deepEqual(store.index(), { version: 1, items: {} }, 'list 只缓存 hash，不写 index');

  const dup = store.saveBuffer(PNG, { name: 'copy.png' });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.name, 'legacy.png');
  assert.deepEqual(store.index(), { version: 1, items: {} }, 'duplicate 不改 index');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.png')), ['legacy.png']);

  // 新内容仍可正常保存，且历史文件继续参与后续去重
  const fresh = store.saveBuffer(variant(PNG, 'fresh'), { name: 'fresh.png' });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.duplicate, false);
  assert.equal(store.list().length, 2);
  assert.equal(store.saveBuffer(PNG, {}).duplicate, true);
});

test('saveBuffer 校验：空内容/非图片/超限/非法文件名/非法入参', (t) => {
  const { store } = makeStore(t, { maxMB: 1 });

  assert.equal(store.saveBuffer(Buffer.alloc(0)).ok, false);
  const text = store.saveBuffer(Buffer.from('hello world, definitely not an image'));
  assert.equal(text.ok, false);
  assert.match(text.error, /不是支持的图片格式/);
  assert.equal(store.saveBuffer('not a buffer').ok, false);

  const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
  assert.ok(big.length > 1024 * 1024);
  const over = store.saveBuffer(big);
  assert.equal(over.ok, false);
  assert.match(over.error, /大小上限 1MB/);

  // 恰好等于上限允许
  const exact = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 - PNG.length)]);
  assert.equal(exact.length, 1024 * 1024);
  assert.equal(store.saveBuffer(exact, { name: 'exact.png' }).ok, true);

  // Uint8Array 入参也接受
  const u8 = new Uint8Array([...PNG]);
  assert.equal(store.saveBuffer(u8, { name: 'u8.png' }).ok, true);

  // 'png'（无扩展名）是合法输入：会补成 png.png；name 为空串等同未提供（走默认命名），都不是拒绝项
  const badNames = ['../evil.png', 'a/b.png', 'a\\\\b.png', 'x.txt', '.hidden.png', 'a\u0001.png', '..png'];
  for (const name of badNames) {
    const result = store.saveBuffer(PNG, { name });
    assert.equal(result.ok, false, '应拒绝文件名: ' + JSON.stringify(name));
  }
  // name 为空串/空白等同未提供 → 走默认命名（用不同内容避免命中已有 hash）
  assert.match(store.saveBuffer(variant(PNG, 'ws'), { name: '   ' }).name, /^sticker-\d+-[0-9a-f]{4}\.png$/);
  // 目录里不应因为失败留下文件（exact + u8 + 默认命名三次成功）
  const names = store.list().map((i) => i.name);
  assert.equal(names.filter((n) => n === 'exact.png' || n === 'u8.png').length, 2);
  assert.equal(names.length, 3);
  assert.equal(names.filter((n) => n.startsWith('sticker-')).length, 1);
});

test('importFile：复制外部文件并登记；缺失/目录/非图片/超限返回错误', (t) => {
  const { store, dir, base } = makeStore(t);
  const downloads = path.join(base, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  // QQ 附件下载到本地后可能没有扩展名：靠 magic bytes 识别
  const src = path.join(downloads, 'attachment');
  fs.writeFileSync(src, PNG);

  const result = store.importFile(src, { name: 'mine.png', emotion: '开心' });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.name, 'mine.png');
  assert.equal(result.item.emotion, '开心');
  assert.equal(result.item.source, 'manual');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'mine.png')), PNG);
  assert.equal(fs.existsSync(src), true, '收藏是复制，不移动原文件');
  assert.deepEqual(store.read('mine.png'), PNG);

  // 相同内容再导入 → duplicate，不新增
  const dup = store.importFile(src, { emotion: '重复' });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.name, 'mine.png');
  assert.equal(store.list().length, 1);

  // 不同内容 → 默认命名 + source=tool
  const src2 = path.join(downloads, 'attachment2');
  fs.writeFileSync(src2, variant(PNG, 'second'));
  const auto = store.importFile(src2, { emotion: '哭', source: 'tool' });
  assert.equal(auto.ok, true);
  assert.match(auto.name, /^哭-\d+-[0-9a-f]{4}\.png$/);
  assert.equal(auto.item.source, 'tool');

  assert.equal(store.importFile('', {}).ok, false);
  const missing = store.importFile(path.join(base, 'nope.png'), {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /文件不存在/);
  const notFile = store.importFile(downloads, {});
  assert.equal(notFile.ok, false);
  assert.match(notFile.error, /不是普通文件/);

  const txt = path.join(downloads, 'a.txt');
  fs.writeFileSync(txt, 'hi');
  const notImage = store.importFile(txt, {});
  assert.equal(notImage.ok, false);
  assert.match(notImage.error, /不是支持的图片格式/);

  // 超限：source 大小在读取前就被拦下
  const small = makeStore(t, { maxMB: 1 });
  const big = path.join(base, 'big.png');
  fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]));
  const tooBig = small.store.importFile(big, {});
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /大小上限 1MB/);
});

test('update：改元数据 + renameTo；非法/冲突/格式不符/不存在拒绝', (t) => {
  const { store, dir } = makeStore(t);
  const saved = store.saveBuffer(PNG, { name: 'a.png' });
  assert.equal(saved.ok, true);

  const updated = store.update('a.png', {
    emotion: '大笑',
    tags: ['开心', '开心', 123],
    note: '好笑时用',
    renameTo: 'b.png',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.item.name, 'b.png');
  assert.equal(updated.item.emotion, '大笑');
  assert.deepEqual(updated.item.tags, ['开心']);
  assert.equal(updated.item.note, '好笑时用');
  assert.equal(updated.item.addedAt, saved.item.addedAt);
  assert.equal(updated.item.source, 'manual');
  assert.equal(updated.item.hash, sha16(PNG));

  assert.equal(fs.existsSync(path.join(dir, 'a.png')), false);
  assert.equal(fs.existsSync(path.join(dir, 'b.png')), true);
  assert.equal(store.get('a.png'), undefined);
  assert.equal(store.index().items['a.png'], undefined);
  assert.equal(store.get('b.png').emotion, '大笑');

  // 只改元数据不动文件名
  const onlyMeta = store.update('b.png', { note: '仅改备注' });
  assert.equal(onlyMeta.ok, true);
  assert.equal(onlyMeta.item.name, 'b.png');
  assert.equal(onlyMeta.item.emotion, '大笑');

  // 目标已存在（不同内容）
  store.saveBuffer(variant(PNG, 'c'), { name: 'c.png' });
  const conflict = store.update('b.png', { renameTo: 'c.png' });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /已存在/);

  // 非法 renameTo
  assert.equal(store.update('b.png', { renameTo: '../evil.png' }).ok, false);
  assert.equal(store.update('b.png', { renameTo: 'evil.txt' }).ok, false);
  assert.equal(store.update('b.png', { renameTo: 'evil.gif' }).ok, false, 'png 内容不能改成 .gif 名字');

  // .jpg <-> .jpeg 同组允许
  store.saveBuffer(JPEG, { name: 'd.jpg' });
  const jpegRenamed = store.update('d.jpg', { renameTo: 'd.jpeg' });
  assert.equal(jpegRenamed.ok, true);
  assert.equal(jpegRenamed.item.name, 'd.jpeg');

  assert.equal(store.update('missing.png', { emotion: 'x' }).ok, false);
  assert.equal(store.update('../b.png', { emotion: 'x' }).ok, false);
});

test('delete：删文件+同步索引；不存在幂等；非法名拒绝', (t) => {
  const { store, dir } = makeStore(t);
  store.saveBuffer(PNG, { name: 'gone.png', emotion: 'x' });
  assert.ok(store.index().items['gone.png']);

  assert.deepEqual(store.delete('gone.png'), { ok: true, removed: true });
  assert.equal(fs.existsSync(path.join(dir, 'gone.png')), false);
  assert.equal(store.index().items['gone.png'], undefined);
  assert.deepEqual(store.list(), []);

  assert.deepEqual(store.delete('gone.png'), { ok: true, removed: false });
  assert.equal(store.delete('../gone.png').ok, false);
  assert.equal(store.delete('index.json').ok, false);
  assert.equal(store.delete('').ok, false);

  // 历史文件（无 index 元数据）也能删
  fs.writeFileSync(path.join(dir, 'legacy.png'), PNG);
  assert.deepEqual(store.delete('legacy.png'), { ok: true, removed: true });
  assert.equal(fs.existsSync(path.join(dir, 'legacy.png')), false);
  // 删除后相同内容可重新收藏
  const reAdd = store.saveBuffer(PNG, { name: 'legacy.png' });
  assert.equal(reAdd.ok, true);
  assert.equal(reAdd.duplicate, false);
});

test('countAddedSince/collectQuota：24h 窗口与 dailyLimit（默认 10）', (t) => {
  const { store } = makeStore(t, { dailyLimit: 2 });
  assert.deepEqual(store.collectQuota(), { todayCount: 0, dailyLimit: 2, allowed: true });

  store.saveBuffer(variant(PNG, 'q1'), { name: 'q1.png', source: 'tool' });
  store.saveBuffer(variant(PNG, 'q2'), { name: 'q2.png', source: 'tool' });
  const quota = store.collectQuota();
  assert.equal(quota.todayCount, 2);
  assert.equal(quota.dailyLimit, 2);
  assert.equal(quota.allowed, false);
  assert.equal(store.countAddedSince(Date.now() - 60 * 1000), 2);
  assert.equal(store.countAddedSince(Date.now() + 60 * 1000), 0);

  // 25 小时前的旧条目不计入 24h 窗口
  const aged = makeStore(t, { dailyLimit: 1 });
  fs.mkdirSync(aged.dir, { recursive: true });
  fs.writeFileSync(path.join(aged.dir, 'old.png'), variant(PNG, 'old'));
  fs.writeFileSync(path.join(aged.dir, 'index.json'), JSON.stringify({
    version: 1,
    items: {
      'old.png': { emotion: '旧', tags: [], note: '', addedAt: Date.now() - 25 * 60 * 60 * 1000, source: 'legacy' },
    },
  }));
  assert.equal(aged.store.countAddedSince(Date.now() - 24 * 60 * 60 * 1000), 0);
  assert.deepEqual(aged.store.collectQuota(), { todayCount: 0, dailyLimit: 1, allowed: true });

  // 未配置 dailyLimit 时默认 10
  const defaults = makeStore(t);
  assert.equal(defaults.store.collectQuota().dailyLimit, 10);
  assert.equal(defaults.store.collectQuota().allowed, true);
});

test('index 原子写：0600、无临时残留、损坏自动备份并回退空索引', (t) => {
  const { store, dir } = makeStore(t);
  store.saveBuffer(PNG, { name: 'a.png', emotion: '开心' });

  const indexPath = path.join(dir, 'index.json');
  assert.equal(fs.existsSync(indexPath), true);
  const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(parsed.version, 1);
  assert.deepEqual(Object.keys(parsed.items), ['a.png']);
  assert.deepEqual(parsed.items['a.png'], {
    emotion: '开心',
    tags: [],
    note: '',
    addedAt: parsed.items['a.png'].addedAt,
    source: 'manual',
    hash: sha16(PNG),
  });
  assert.equal(typeof parsed.items['a.png'].addedAt, 'number');
  assert.ok(parsed.items['a.png'].addedAt > 0);

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600, 'index.json 权限 0600');
    assert.equal(fs.statSync(path.join(dir, 'a.png')).mode & 0o777, 0o600, '图片文件权限 0600');
  }

  const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('.') && name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '原子写不能留下临时文件');

  // 损坏 index：备份 .corrupt-<ts> + 回退空索引，list 仍把图片当历史文件
  fs.writeFileSync(indexPath, 'not-json{{{');
  assert.deepEqual(store.index(), { version: 1, items: {} });
  const corrupts = fs.readdirSync(dir).filter((name) => name.startsWith('index.json.corrupt-'));
  assert.equal(corrupts.length, 1);
  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'a.png');
  assert.equal(items[0].emotion, 'a');
  assert.equal(items[0].hash, sha16(PNG), '损坏 index 后历史文件仍能补算 hash');

  // 损坏后仍可继续保存（索引重建）；同内容此时会被去重
  assert.equal(store.saveBuffer(PNG, { name: 'again.png' }).duplicate, true);
  assert.equal(store.saveBuffer(JPEG, { name: 'b.jpg' }).ok, true);
  assert.deepEqual(Object.keys(store.index().items), ['b.jpg']);
});

test('settings 读取失败时回退默认目录且不抛', () => {
  const store = createStickerStore({
    settings: { get() { throw new Error('boom'); } },
    logger: QUIET_LOGGER,
  });
  assert.equal(store.dir(), path.join(process.cwd(), 'stickers'));
  assert.ok(Array.isArray(store.list()));
  assert.equal(typeof store.catalog(), 'string');
  assert.deepEqual(store.collectQuota(), { todayCount: 0, dailyLimit: 10, allowed: true });
});