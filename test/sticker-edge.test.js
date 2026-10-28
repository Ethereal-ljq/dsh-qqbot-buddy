/**
 * test/sticker-edge.test.js —— 表情包文件层的边界用例（QA 补充；主体用例见 sticker-dev 的 test/sticker-store.test.js）。
 *
 * 覆盖：index.json 损坏回退、renameTo 路径穿越/扩展名欺骗、连续 save 重名自动加后缀、
 * magic bytes 校验、大小上限、delete 幂等、legacy 文件元数据、catalog 格式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStickerStore } from '../lib/stickers/store.js';
import { registerStickerTools } from '../lib/tools/sticker-tools.js';
import { createFakeLogger } from './helpers/fake-ctx.js';

/** 1x1 透明 PNG（70 字节，CRC 合法）。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');
/** 最小 JPEG 头（仅 magic bytes，足够嗅探；不要求可解码）。 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

/** 尾部追加标记：magic bytes 不变但内容 hash 不同（去重上线后，测试里"多张不同图"必须用不同内容）。 */
function variant(buffer, marker) {
  return Buffer.concat([buffer, Buffer.from('#' + marker, 'utf8')]);
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sticker-edge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeStore(t, overrides = {}) {
  const dir = tempDir(t);
  const stickersDir = path.join(dir, 'stickers');
  fs.mkdirSync(stickersDir, { recursive: true });
  const state = {
    stickers: { dir: stickersDir, collectEnabled: true, maxMB: 8 },
    ...overrides,
  };
  const store = createStickerStore({ settings: { get: () => JSON.parse(JSON.stringify(state)) }, logger: createFakeLogger() });
  return { dir, stickersDir, state, store };
}

function writeIndex(stickersDir, value) {
  fs.writeFileSync(path.join(stickersDir, 'index.json'), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

test('index.json 损坏：回退空索引 + .corrupt 备份，磁盘图片按 legacy 展示，之后 save 重建索引', (t) => {
  const { store, stickersDir } = makeStore(t);
  fs.writeFileSync(path.join(stickersDir, 'legacy.png'), PNG);
  writeIndex(stickersDir, '{ this is not json');
  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'legacy.png');
  assert.equal(items[0].emotion, 'legacy', '无元数据时 emotion 应为文件名去扩展名');
  assert.equal(items[0].source, 'legacy');
  const corrupt = fs.readdirSync(stickersDir).filter((name) => name.startsWith('index.json.corrupt-'));
  assert.equal(corrupt.length, 1, '损坏索引应被改名备份');
  // 索引为空但文件仍可读
  assert.deepEqual(store.index(), { version: 1, items: {} });
  assert.ok(Buffer.isBuffer(store.read('legacy.png')));

  const saved = store.saveBuffer(variant(PNG, 'new'), { name: 'new.png', emotion: '新表情' });
  assert.equal(saved.ok, true);
  const index = store.index();
  assert.ok(index.items['new.png']);
  assert.equal(index.items['new.png'].emotion, '新表情');
});

test('saveBuffer：连续同名保存自动加 -2/-3 后缀，全部可列出且互不覆盖', (t) => {
  const { store, stickersDir } = makeStore(t);
  const first = store.saveBuffer(variant(PNG, '1'), { name: 'laugh.png', emotion: '大笑' });
  const second = store.saveBuffer(variant(PNG, '2'), { name: 'laugh.png', emotion: '大笑2' });
  const third = store.saveBuffer(variant(PNG, '3'), { name: 'laugh.png', emotion: '大笑3' });
  assert.deepEqual([first.name, second.name, third.name], ['laugh.png', 'laugh-2.png', 'laugh-3.png']);
  const names = store.list().map((item) => item.name).sort();
  assert.deepEqual(names, ['laugh-2.png', 'laugh-3.png', 'laugh.png']);
  assert.equal(fs.readFileSync(path.join(stickersDir, 'laugh-2.png')).length > 0, true);
  // 默认命名（无 name）包含 emotion 前缀 + 时间戳 + 随机后缀，且不重名
  const auto1 = store.saveBuffer(variant(PNG, '4'), { emotion: '开心' });
  const auto2 = store.saveBuffer(variant(PNG, '5'), { emotion: '开心' });
  assert.equal(auto1.ok, true);
  assert.equal(auto2.ok, true);
  assert.notEqual(auto1.name, auto2.name);
  assert.match(auto1.name, /^开心-\d+-[0-9a-f]{4}\.png$/);
});

test('update renameTo：路径穿越/隐藏名/不可解析扩展名一律拒绝且不改动原文件', (t) => {
  const { store, stickersDir } = makeStore(t);
  store.saveBuffer(PNG, { name: 'laugh.png', emotion: '大笑' });
  const badTargets = ['../evil.png', '../../evil.png', '/tmp/evil.png', 'sub/evil.png', '..\\evil.png', '.hidden.png', 'evil.txt', 'evil'];
  for (const renameTo of badTargets) {
    const result = store.update('laugh.png', { renameTo });
    assert.equal(result.ok, false, 'renameTo=' + JSON.stringify(renameTo) + ' 应被拒绝');
  }
  assert.equal(fs.existsSync(path.join(stickersDir, 'laugh.png')), true, '原文件不应被移动/删除');
  // 扩展名与真实格式不符（png 改成 gif）同样拒绝
  const mismatch = store.update('laugh.png', { renameTo: 'laugh.gif' });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /扩展名与图片内容不符/);
  // 目标已存在时拒绝
  store.saveBuffer(variant(PNG, 'other'), { name: 'other.png' });
  const exists = store.update('laugh.png', { renameTo: 'other.png' });
  assert.equal(exists.ok, false);
  assert.match(exists.error, /已存在/);
  // 合法 rename 成功且 index/list 同步
  const ok = store.update('laugh.png', { renameTo: 'laugh2.png', emotion: '改名后' });
  assert.equal(ok.ok, true);
  assert.equal(ok.item.name, 'laugh2.png');
  assert.equal(ok.item.emotion, '改名后');
  assert.deepEqual(store.list().map((item) => item.name).sort(), ['laugh2.png', 'other.png']);
  assert.equal(fs.existsSync(path.join(stickersDir, 'laugh.png')), false);
});

test('saveBuffer：magic bytes 与扩展名不符拒绝；非图片内容拒绝', (t) => {
  const { store } = makeStore(t);
  // PNG 内容但显式 name 用 .gif → 拒绝
  const mismatch = store.saveBuffer(PNG, { name: 'fake.gif' });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /扩展名与图片内容不符/);
  // 非图片内容
  const notImage = store.saveBuffer(Buffer.from('hello world, not an image'), { name: 'x.png' });
  assert.equal(notImage.ok, false);
  assert.match(notImage.error, /不是支持的图片格式/);
  // 空 buffer
  assert.equal(store.saveBuffer(Buffer.alloc(0), { name: 'empty.png' }).ok, false);
  // JPEG 内容保存为 .png → 拒绝；保存为 .jpg → 成功
  assert.equal(store.saveBuffer(JPEG, { name: 'j.png' }).ok, false);
  assert.equal(store.saveBuffer(JPEG, { name: 'j.jpg' }).ok, true);
});

test('saveBuffer：超过 maxMB 上限拒绝（1MB 配置）', (t) => {
  const { store, stickersDir } = makeStore(t, {
    stickers: { dir: path.join(tempDir(t), 'stickers'), collectEnabled: true, maxMB: 1 },
  });
  fs.mkdirSync(path.dirname(store.dir()), { recursive: true });
  const big = Buffer.alloc(1024 * 1024 + 1);
  PNG.copy(big, 0);
  const result = store.saveBuffer(big, { name: 'big.png' });
  assert.equal(result.ok, false);
  assert.match(result.error, /大小上限/);
  assert.equal(fs.existsSync(path.join(store.dir(), 'big.png')), false);
});

test('delete：不存在时幂等成功、非法名拒绝、删除后 index 同步清理', (t) => {
  const { store } = makeStore(t);
  store.saveBuffer(PNG, { name: 'laugh.png', emotion: '大笑' });
  assert.equal(store.delete('laugh.png').ok, true);
  assert.equal(store.list().length, 0);
  assert.equal(Object.keys(store.index().items).length, 0);
  const again = store.delete('laugh.png');
  assert.deepEqual(again, { ok: true, removed: false });
  for (const bad of ['../x.png', '/etc/passwd', '.hidden.png', 'x.txt', '']) {
    const result = store.delete(bad);
    assert.equal(result.ok, false, 'delete ' + JSON.stringify(bad) + ' 应被拒绝');
  }
});

test('read/get：越界/不存在/非法名安全失败；catalog 输出 name=emotion', (t) => {
  const { store } = makeStore(t);
  assert.equal(store.get('../x.png'), undefined);
  assert.throws(() => store.read('../x.png'), /basename|只允许/);
  assert.throws(() => store.read('missing.png'), /不存在/);
  store.saveBuffer(PNG, { name: 'laugh.png', emotion: '大笑' });
  store.saveBuffer(variant(PNG, 'hehe'), { name: 'hehe.png', emotion: '开心' });
  assert.equal(store.catalog(), 'hehe.png=开心, laugh.png=大笑');
  assert.equal(store.catalog(1), 'hehe.png=开心');
  assert.equal(store.get('laugh.png').emotion, '大笑');
});

test('update：元数据 trim/截断且空 name 非法；delete 不误删 index.json', (t) => {
  const { store } = makeStore(t);
  store.saveBuffer(PNG, { name: 'laugh.png', emotion: '大笑' });
  const updated = store.update('laugh.png', {
    emotion: '  开心   ',
    tags: ['#a', 'a', '  ', 123, 'tag2'],
    note: 'x'.repeat(400),
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.item.emotion, '开心');
  assert.deepEqual(updated.item.tags, ['a', 'tag2']);
  assert.equal(updated.item.note.length, 300);
  // 删除表情不应把 index.json 当表情删掉
  store.delete('laugh.png');
  assert.equal(fs.existsSync(path.join(store.dir(), 'index.json')), true);
});
