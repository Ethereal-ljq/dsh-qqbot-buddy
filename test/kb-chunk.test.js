import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_CHARS,
  DEFAULT_OVERLAP,
  chunkMarkdown,
  splitMarkdownSections,
  slideByCodePoints,
} from '../lib/core/kb/chunk.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('Markdown 标题优先分节，chunk 携带 heading', () => {
  const md = ['# 团建', '本周六集合。', '', '## 报名', '截止周五中午。', '', '### 备注', '带外套。'].join('\n');
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.heading), ['团建', '报名', '备注']);
  assert.equal(chunks[0].text, '本周六集合。');
  assert.equal(chunks[1].text, '截止周五中午。');
  assert.equal(chunks[2].text, '带外套。');
});

test('第一个标题之前的内容作为前言段（heading 为空）', () => {
  const md = '前言内容。\n\n# 标题\n正文。';
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.heading), ['', '标题']);
  assert.equal(chunks[0].text, '前言内容。');
  assert.equal(chunks[1].text, '正文。');
});

test('围栏代码块内的 # 不作为 Markdown 标题', () => {
  const md = ['```js', '# 这不是标题', 'console.log(1);', '```', '', '# 真标题', '正文。'].join('\n');
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, '');
  assert.match(chunks[0].text, /# 这不是标题/);
  assert.equal(chunks[1].heading, '真标题');
  assert.equal(chunks[1].text, '正文。');
});

test('splitMarkdownSections 保留标题级别', () => {
  const sections = splitMarkdownSections('# 一级\nA\n## 二级\nB');
  assert.deepEqual(sections.map((section) => [section.heading, section.level]), [['', 0], ['一级', 1], ['二级', 2]]);
  assert.equal(sections[1].text, 'A');
  assert.equal(sections[2].text, 'B');
});

test('默认 maxChars=800 / overlap=80 滑窗切分', () => {
  assert.equal(DEFAULT_MAX_CHARS, 800);
  assert.equal(DEFAULT_OVERLAP, 80);
  const text = '知'.repeat(1000);
  const chunks = chunkMarkdown(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text.length, 800);
  assert.equal(chunks[1].text.length, 280);
  // 相邻窗口重叠 80 个字符
  assert.equal(chunks[1].text.slice(0, 80), chunks[0].text.slice(-80));
});

test('overlap=0 时窗口首尾相接、无重复无遗漏', () => {
  const chars = Array.from({ length: 25 }, (unused, index) => String.fromCharCode(0x4e00 + index));
  const text = chars.join('');
  const chunks = chunkMarkdown(text, { maxChars: 10, overlap: 0 });
  assert.deepEqual(chunks.map((chunk) => chunk.text), [text.slice(0, 10), text.slice(10, 20), text.slice(20)]);
  assert.equal(chunks.map((chunk) => chunk.text).join(''), text);
});

test('overlap 的单位是字符：跨窗口精确重叠 2 个字符', () => {
  const chars = Array.from({ length: 21 }, (unused, index) => String.fromCharCode(0x4e00 + index));
  const text = chars.join('');
  const chunks = chunkMarkdown(text, { maxChars: 10, overlap: 2 });
  assert.deepEqual(chunks.map((chunk) => chunk.text), [text.slice(0, 10), text.slice(8, 18), text.slice(16)]);
  assert.equal(chunks[1].text.slice(0, 2), chunks[0].text.slice(-2));
  assert.equal(chunks[2].text.slice(0, 2), chunks[1].text.slice(-2));
});

test('滑窗不切断 UTF-16 代理对（emoji）', () => {
  const emoji = '\u{1F600}';
  const text = emoji.repeat(9);
  const chunks = chunkMarkdown(text, { maxChars: 4, overlap: 1 });
  assert.deepEqual(chunks.map((chunk) => chunk.text), [emoji.repeat(4), emoji.repeat(4), emoji.repeat(3)]);
  for (const chunk of chunks) {
    assert.ok(!LONE_SURROGATE.test(chunk.text), 'chunk 不应包含孤立代理项: ' + chunk.text);
    assert.ok([...chunk.text].length <= 4, '按码点计算不应超过 maxChars');
  }
});

test('滑窗参数非法时抛 RangeError', () => {
  assert.throws(() => chunkMarkdown('abc', { maxChars: 0 }), RangeError);
  assert.throws(() => chunkMarkdown('abc', { maxChars: 10, overlap: 10 }), RangeError);
  assert.throws(() => chunkMarkdown('abc', { maxChars: 10, overlap: -1 }), RangeError);
  assert.throws(() => slideByCodePoints('abc', 0, 0), RangeError);
  assert.throws(() => slideByCodePoints('abc', 10, 10), RangeError);
});

test('未显式给 overlap 时自动收敛到 maxChars-1，不报错', () => {
  const chunks = chunkMarkdown('甲乙丙丁', { maxChars: 3 });
  // step = 3 - 2 = 1：窗口 [0,3) 与 [1,4)
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['甲乙丙', '乙丙丁']);
  for (const chunk of chunks) assert.ok([...chunk.text].length <= 3);
});

test('空文本 / 纯空白返回空数组', () => {
  assert.deepEqual(chunkMarkdown(''), []);
  assert.deepEqual(chunkMarkdown(null), []);
  assert.deepEqual(chunkMarkdown('   \n\n'), []);
  assert.deepEqual(slideByCodePoints('   '), []);
});

test('CRLF 换行归一化后分节正确', () => {
  const chunks = chunkMarkdown('第一行\r\n# 标题\r\n正文\r\n');
  assert.deepEqual(chunks.map((chunk) => chunk.heading), ['', '标题']);
  assert.equal(chunks[0].text, '第一行');
  assert.equal(chunks[1].text, '正文');
});

test('长节内滑窗不跨标题合并', () => {
  const longBody = '甲'.repeat(1200);
  const md = '# A\n' + longBody + '\n# B\n短正文。';
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.filter((chunk) => chunk.heading === 'A').length, 2);
  assert.equal(chunks.filter((chunk) => chunk.heading === 'B').length, 1);
  assert.ok(chunks.every((chunk) => !chunk.text.includes('# ')));
});
