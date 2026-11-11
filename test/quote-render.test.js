/**
 * quote-render —— 引用消息的作者归属与结构。
 *
 * 真实案例：群友「院」引用机器人自己刚说的话（「院长当然算，而且算这群里最像人的那种。」）
 * 然后回 ✌️。旧渲染没有作者归属，模型看不出「引用了自己的话」，
 * 也就理解不了「认同」这层意思；而且 [Current message] 重复出现。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleAgentBody } from '../lib/qq/inbound.js';
import { createSentTracker } from '../lib/qq/outbound.js';
import { quoteText, renderQuoteBlock, resolveQuoteAuthor } from '../lib/qq/quote-render.js';

const BOT_TEXT = '院长当然算，而且算这群里最像人的那种。';
const GROUP_MSG = {
  kind: 'group', groupOpenid: 'G1',
  senderId: '66C13BA866464A969A81769F7003F40B', senderName: '院',
  content: '✌️', messageId: 'm1', msgType: 0,
};

/** 机器人发过某句话的 sentTracker。 */
function trackerWith(text) {
  const tracker = createSentTracker();
  tracker.record('msg-id-1', text);
  return tracker;
}

test('引用机器人自己的话：识别为「你(助手)」', () => {
  // 引用机器人消息时 quoteRef 的 store 里没有（机器人消息不过入站），只有 msg_elements
  const quote = { refKey: 'r1', source: 'msg_elements', rawContent: BOT_TEXT, text: BOT_TEXT };
  const author = resolveQuoteAuthor(quote, { sentTracker: trackerWith(BOT_TEXT) });
  assert.equal(author.label, '你(助手)');
  assert.equal(author.isSelf, true);
});

test('引用别人的话：用 entry 里的昵称', () => {
  const quote = { refKey: 'r2', source: 'store', text: '那我们晚上吃啥', entry: { senderName: '代理人', senderId: 'C017CD3E' } };
  const author = resolveQuoteAuthor(quote);
  assert.equal(author.label, '代理人');
  assert.equal(author.isSelf, false);
});

test('entry.isBot 为真时直接认作机器人自己', () => {
  const quote = { refKey: 'r3', source: 'store', text: '随便一句', entry: { isBot: true } };
  assert.equal(resolveQuoteAuthor(quote).label, '你(助手)');
});

test('只有 openid 时降级显示前 8 位', () => {
  const quote = { refKey: 'r4', source: 'store', text: '某句话', entry: { senderId: '66C13BA866464A969A81769F7003F40B' } };
  assert.equal(resolveQuoteAuthor(quote).label, '66C13BA8');
});

test('完全认不出作者时标注「某位群友」，不瞎猜', () => {
  const quote = { refKey: 'r5', source: 'msg_elements', text: '一句来源不明的话' };
  assert.equal(resolveQuoteAuthor(quote).label, '某位群友');
  assert.equal(resolveQuoteAuthor(quote, { sentTracker: trackerWith('完全不同的另一句话啊啊') }).label, '某位群友');
});

test('引用块不再输出重复的 [Current message]', () => {
  const quote = { refKey: 'r1', text: BOT_TEXT };
  const block = renderQuoteBlock(quote, { sentTracker: trackerWith(BOT_TEXT) });
  assert.doesNotMatch(block, /\[Current message\]/, '引用块自己不该写 [Current message]');
  assert.match(block, /\[引用 你\(助手\) 说的话\]/);
});

test('无内容引用返回空串（不产生空引用段）', () => {
  assert.equal(renderQuoteBlock(null), '');
  assert.equal(renderQuoteBlock({ text: '' }), '');
  assert.equal(renderQuoteBlock({ text: '[empty message]' }), '', 'SDK 的空占位要当无内容处理');
});

test('长/多行引用用块状渲染并标注结束', () => {
  const long = '第一行内容\n第二行内容';
  const block = renderQuoteBlock({ text: long }, { sentTracker: null });
  assert.match(block, /^\[引用 某位群友 的消息\]\n/);
  assert.match(block, /\[引用结束\]$/);
});

test('quoteText 兼容 text / rawContent / entry.content', () => {
  assert.equal(quoteText({ text: 'a' }), 'a');
  assert.equal(quoteText({ rawContent: 'b' }), 'b');
  assert.equal(quoteText({ entry: { content: 'c' } }), 'c');
  assert.equal(quoteText({}), '');
});

test('端到端：群聊里引用机器人消息，当前消息带 @you 且结构清晰', () => {
  const quote = { refKey: 'r1', source: 'msg_elements', rawContent: BOT_TEXT, text: BOT_TEXT };
  const body = assembleAgentBody({
    message: GROUP_MSG,
    state: { quote, mention: { wasMentioned: true } },
    scope: 'group',
    sentTracker: trackerWith(BOT_TEXT),
  });
  assert.match(body, /\[引用 你\(助手\) 说的话\] 院长当然算/);
  assert.match(body, /\[院 \(66C13BA866464A969A81769F7003F40B\)\] ✌️ \(@you\)/);
  // 引用块与当前消息分行，模型能区分
  assert.equal(body.split('\n').filter((l) => l.startsWith('[引用 ')).length, 1);
});

test('没有 sentTracker 时不会把别人的话误判成自己的', () => {
  const quote = { refKey: 'r9', text: BOT_TEXT };
  assert.equal(resolveQuoteAuthor(quote).label, '某位群友', '无 sentTracker 时应保守判为他人');
});