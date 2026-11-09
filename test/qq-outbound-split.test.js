/**
 * outbound-split —— 出站分条：显式 [[msg]] 与「空行自动拆条」兜底。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { splitSegments, splitBlankLineSegments } from '../lib/qq/outbound.js';

test('splitSegments：显式 [[msg]] 拆条（大小写/空白不敏感）', () => {
  assert.deepEqual(splitSegments('第一句[[msg]]第二句'), ['第一句', '第二句']);
  assert.deepEqual(splitSegments('a [[ MSG ]] b'), ['a', 'b']);
  assert.deepEqual(splitSegments('没有标记的一段'), ['没有标记的一段']);
  assert.deepEqual(splitSegments(''), ['']);
});

test('splitBlankLineSegments：空行分段自动拆成多条', () => {
  assert.deepEqual(splitBlankLineSegments('在的\n\n刚那条没看懂'), ['在的', '刚那条没看懂']);
  assert.deepEqual(
    splitBlankLineSegments('第一段\n\n第二段\n\n第三段'),
    ['第一段', '第二段', '第三段'],
  );
});

test('splitBlankLineSegments：单个换行不拆', () => {
  const text = '第一行\n第二行';
  assert.deepEqual(splitBlankLineSegments(text), [text]);
});

test('splitBlankLineSegments：代码块/表格/清单保持整段', () => {
  const code = '说明一下\n\n' + String.fromCharCode(96).repeat(3) + 'js\nconsole.log(1)\n\nconsole.log(2)\n' + String.fromCharCode(96).repeat(3);
  assert.deepEqual(splitBlankLineSegments(code), [code]);
  const list = '- 一\n- 二\n- 三';
  assert.deepEqual(splitBlankLineSegments(list), [list]);
});

test('splitBlankLineSegments：超过 4 段或太长时不自动拆', () => {
  const many = 'a\n\nb\n\nc\n\nd\n\ne';
  assert.deepEqual(splitBlankLineSegments(many), [many]);
  const long = 'x'.repeat(500) + '\n\n' + 'y'.repeat(500);
  assert.deepEqual(splitBlankLineSegments(long), [long]);
});

test('splitBlankLineSegments：空行很多/首尾空行时正常分段并 trim', () => {
  assert.deepEqual(splitBlankLineSegments('\n\n一\n\n\n二\n\n'), ['一', '二']);
});
