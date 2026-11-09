/**
 * emoji — QQ 表情占位到 Unicode 的兜底转换。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { convertEmojiTokens } from '../lib/qq/emoji.js';

test('convertEmojiTokens：常见占位写法都转成 Unicode', () => {
  assert.equal(convertEmojiTokens('笑死[捂脸]'), '笑死🤦');
  assert.equal(convertEmojiTokens('好耶【表情: 赞】'), '好耶👍');
  assert.equal(convertEmojiTokens('[face: 得意] 这波稳'), '😎 这波稳');
  assert.equal(convertEmojiTokens('普通文本，没有表情'), '普通文本，没有表情');
  assert.equal(convertEmojiTokens('代码 [foo] 不应误伤'), '代码 [foo] 不应误伤');
  assert.equal(convertEmojiTokens(''), '');
});
