/**
 * ref-store / 引用作者补全 / 引用图内联。
 *
 * 真实案例（2026-11-11 20:26）：有人引用一张表情包说「把这个换成猪头」，
 * 引用作者渲染成「某位群友」，紧接着上一句是「院：那我要一群男娘」，
 * 模型就把图里的角色认成了院长。两个根因：
 *   1. quoteRef 走 msg_elements 路径时丢掉了作者（本文件前半部分覆盖）；
 *   2. 被引用的图片没有内联给模型，只能看到路径（后半部分覆盖）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInboundHandler } from '../lib/qq/inbound.js';
import { createQuoteEnricher, createRefStore } from '../lib/qq/ref-store.js';
import { resolveQuoteAuthor, renderQuoteBlock } from '../lib/qq/quote-render.js';

test('createRefStore：get/set 与 LRU 淘汰', () => {
  const store = createRefStore({ maxSize: 2 });
  store.set('a', { senderName: '甲' });
  store.set('b', { senderName: '乙' });
  assert.equal(store.get('a').senderName, '甲');
  assert.equal(store.size(), 2);
  store.set('c', { senderName: '丙' });
  assert.equal(store.size(), 2, '超上限应淘汰最旧');
  assert.equal(store.get('a'), undefined);
  assert.equal(store.get('c').senderName, '丙');
});

test('createRefStore：重复 set 同 key 不会撑爆容量', () => {
  const store = createRefStore({ maxSize: 2 });
  store.set('a', { v: 1 });
  store.set('a', { v: 2 });
  assert.equal(store.size(), 1);
  assert.equal(store.get('a').v, 2);
});

test('quoteEnricher：msg_elements 路径下把作者补回来', async () => {
  const refStore = createRefStore();
  refStore.set('idx-1', { senderName: '院', senderId: '66C13BA866464A969A81769F7003F40B', isBot: false });
  const mw = createQuoteEnricher(refStore);
  // 模拟 SDK 走 msg_elements：只有内容，没有 entry
  const ctx = {
    state: { quote: { refKey: 'idx-1', source: 'msg_elements', text: '[image: 88D2.jpg]', attachments: [] } },
    log: { debug() {} },
  };
  await mw(ctx, async () => {});
  assert.ok(ctx.state.quote.entry, '应补出 entry');
  assert.equal(ctx.state.quote.entry.senderName, '院');
  // 补全后作者解析应命中院，而不是「某位群友」
  assert.equal(resolveQuoteAuthor(ctx.state.quote).label, '院');
});

test('quoteEnricher：已有 entry 时不覆盖 SDK 的结果', async () => {
  const refStore = createRefStore();
  refStore.set('idx-2', { senderName: '别人' });
  const mw = createQuoteEnricher(refStore);
  const ctx = { state: { quote: { refKey: 'idx-2', entry: { senderName: '院' } } }, log: { debug() {} } };
  await mw(ctx, async () => {});
  assert.equal(ctx.state.quote.entry.senderName, '院', '不应被 store 里的旧值覆盖');
});

test('quoteEnricher：refKey 未命中 / 无 quote / store 缺失时都不抛', async () => {
  const mw = createQuoteEnricher(createRefStore());
  await mw({ state: { quote: { refKey: 'nope', text: 'x' } }, log: { debug() {} } }, async () => {});
  await mw({ state: {}, log: { debug() {} } }, async () => {});
  await mw({}, async () => {});
  await createQuoteEnricher(null)({ state: { quote: { refKey: 'a' } }, log: { debug() {} } }, async () => {});
});

test('补全后引用块显示真实作者，不再是「某位群友」', async () => {
  const refStore = createRefStore();
  refStore.set('idx-3', { senderName: '院', senderId: '66C13B', isBot: false });
  const quote = { refKey: 'idx-3', source: 'msg_elements', text: '[image: 88D2.jpg]' };
  const ctx = { state: { quote }, log: { debug() {} } };
  await createQuoteEnricher(refStore)(ctx, async () => {});
  const block = renderQuoteBlock(ctx.state.quote);
  assert.match(block, /\[引用 院 的消息\]/);
  assert.doesNotMatch(block, /某位群友/);
});

/* ------------------------------ 引用图片内联 ------------------------------ */

function makeInboundRig({ captured }) {
  const record = {
    peer: 'group:G1',
    agent: { followup: async () => {}, whenIdle: async () => {} },
    turn: { current: null },
  };
  const handler = createInboundHandler({
    config: { appId: 'app1' },
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    manager: { getOrCreate: async () => record },
    settings: {},
    stats: {},
    historyStore: null,
    botId: 'bot-a',
    messages: null,
    buildImageBlocks: async (args) => { captured.push(args); return []; },
  });
  return handler;
}

test('引用消息里的图片也传给 buildImageBlocks（否则模型看不到图）', async () => {
  const captured = [];
  const handler = makeInboundRig({ captured });
  await handler({
    message: { kind: 'group', groupOpenid: 'G1', senderId: 'S1', senderName: '你', content: '把这个换成猪头', messageId: 'm1', msgType: 0 },
    state: {
      downloadedFiles: [{ filename: 'cur.jpg', contentType: 'image', localPath: '/tmp/cur.jpg' }],
      downloadedQuoteFiles: [{ filename: 'quo.jpg', contentType: 'image', localPath: '/tmp/quo.jpg' }],
    },
    replyTarget: { scope: 'group', targetId: 'G1', msgId: 'm1' },
    bot: { sendMarkdown: async () => {} },
  });
  assert.equal(captured.length, 1);
  const paths = captured[0].downloaded.map((f) => f.localPath);
  assert.deepEqual(paths, ['/tmp/cur.jpg', '/tmp/quo.jpg'], '当前消息图 + 引用图都要内联');
});

test('没有引用附件时行为不变（只传当前消息的图）', async () => {
  const captured = [];
  const handler = makeInboundRig({ captured });
  await handler({
    message: { kind: 'group', groupOpenid: 'G1', senderId: 'S1', senderName: '你', content: '看图', messageId: 'm2', msgType: 0 },
    state: { downloadedFiles: [{ filename: 'cur.jpg', contentType: 'image', localPath: '/tmp/cur.jpg' }] },
    replyTarget: { scope: 'group', targetId: 'G1', msgId: 'm2' },
    bot: { sendMarkdown: async () => {} },
  });
  assert.deepEqual(captured[0].downloaded.map((f) => f.localPath), ['/tmp/cur.jpg']);
});