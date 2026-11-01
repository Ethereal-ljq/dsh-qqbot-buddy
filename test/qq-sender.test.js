/**
 * qq-sender —— 统一发送器：被动预算、错误码分类、markdown 降级、主动频控、引用回复。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSender, nextMsgSeq } from '../lib/qq/sender.js';
import { classifySendError, bizCodeOf, SEND_ERROR } from '../lib/qq/error-codes.js';

const noopLogger = { warn() {}, error() {}, debug() {}, info() {} };

function makeSettings(overrides = {}) {
  const value = {
    reply: { quoteReply: true, proactiveFallback: true },
    ...overrides,
  };
  return { get: () => value };
}

function apiError(code, message) {
  return Object.assign(new Error(message || ('biz error ' + code)), { bizCode: code, httpStatus: 400 });
}

function makeBot(handler) {
  const calls = [];
  return {
    calls,
    async send(opts) {
      calls.push(opts);
      if (handler) return handler(opts, calls.length - 1);
      return { id: 'm' + calls.length, ext_info: {} };
    },
  };
}

function setup(options = {}) {
  const bot = options.bot || makeBot(options.handler);
  const sender = createSender({
    getBot: () => bot,
    settings: options.settings || makeSettings(),
    budgets: options.budgets,
    limits: options.limits,
    proactive: options.proactive,
    logger: noopLogger,
  });
  return { bot, sender };
}

test('单聊被动回复 4 次用满后直接走主动（不再白撞一次）', async () => {
  const { bot, sender } = setup();
  const target = { scope: 'c2c', targetId: 'u1', msgId: 'msg-1' };
  for (let i = 0; i < 5; i += 1) {
    const res = await sender.sendMarkdown(target, 'hi ' + i);
    assert.equal(res.ok, true, '第 ' + (i + 1) + ' 条应成功');
  }
  assert.equal(bot.calls.length, 5);
  for (let i = 0; i < 4; i += 1) assert.equal(bot.calls[i].target.msgId, 'msg-1');
  assert.equal(bot.calls[4].target.msgId, undefined, '第 5 条应去掉 msgId 走主动');
  const status = sender.status();
  assert.equal(status.counters.passive, 4);
  assert.equal(status.counters.proactive, 1);
});

test('群聊被动回复 5 次用满后走主动', async () => {
  const { bot, sender } = setup();
  const target = { scope: 'group', targetId: 'g1', msgId: 'msg-g' };
  for (let i = 0; i < 6; i += 1) await sender.sendMarkdown(target, 'x' + i);
  assert.equal(bot.calls.length, 6);
  assert.equal(bot.calls[4].target.msgId, 'msg-g');
  assert.equal(bot.calls[5].target.msgId, undefined);
});

test('被动窗口过期（40034128）自动降级主动，且后续同 msgId 不再试被动', async () => {
  let passiveAttempts = 0;
  const bot = makeBot((opts) => {
    if (opts.target.msgId) {
      passiveAttempts += 1;
      throw apiError(40034128);
    }
    return { id: 'proactive-ok' };
  });
  const { sender } = setup({ bot });
  const target = { scope: 'c2c', targetId: 'u1', msgId: 'msg-2' };
  const first = await sender.sendMarkdown(target, 'hello');
  assert.equal(first.ok, true);
  assert.equal(first.mode, 'proactive');
  assert.equal(passiveAttempts, 1);
  const second = await sender.sendMarkdown(target, 'world');
  assert.equal(second.ok, true);
  assert.equal(second.mode, 'proactive');
  assert.equal(passiveAttempts, 1, '同一 msgId 已被标记失效，不应再次尝试被动');
});

test('markdown 权限错误（40034127）降级纯文本，之后保持纯文本', async () => {
  const bot = makeBot((opts) => {
    if (opts.msgType === 2) throw apiError(40034127);
    return { id: 'plain-ok' };
  });
  const { sender } = setup({ bot });
  const target = { scope: 'c2c', targetId: 'u1', msgId: 'msg-3' };
  const res = await sender.sendMarkdown(target, '**hi**');
  assert.equal(res.ok, true);
  assert.equal(res.degraded, true);
  assert.equal(bot.calls[1].msgType, 0);
  assert.equal(bot.calls[1].content, '**hi**');
  assert.equal(sender.status().markdownUsable, false);

  await sender.sendMarkdown(target, 'again');
  assert.equal(bot.calls[2].msgType, 0, 'markdown 已标记不可用，后续直接纯文本');
});

test('消息被去重（40054005）换 msg_seq 重试一次', async () => {
  const bot = makeBot((opts) => {
    if (!opts.extra || opts.extra.msg_seq === undefined) throw apiError(40054005);
    return { id: 'dedupe-ok' };
  });
  const { sender } = setup({ bot });
  const res = await sender.sendMarkdown({ scope: 'group', targetId: 'g1', msgId: 'm1' }, 'hi');
  assert.equal(res.ok, true);
  assert.equal(res.dedupeRetry, true);
  assert.equal(typeof bot.calls[1].extra.msg_seq, 'number');
  assert.ok(bot.calls[1].extra.msg_seq >= 1 && bot.calls[1].extra.msg_seq <= 65535);
});

test('永久错误（40034006 内容违规）不重试、不降级主动', async () => {
  const bot = makeBot(() => { throw apiError(40034006); });
  const { sender } = setup({ bot });
  const res = await sender.sendMarkdown({ scope: 'c2c', targetId: 'u1', msgId: 'm4' }, 'bad');
  assert.equal(res.ok, false);
  assert.equal(res.code, '40034006');
  assert.equal(bot.calls.length, 1);
});

test('主动兜底关闭时，被动失败直接返回失败', async () => {
  const bot = makeBot(() => { throw apiError(40034005); });
  const settings = makeSettings({ reply: { quoteReply: true, proactiveFallback: false } });
  const { sender } = setup({ bot, settings });
  const res = await sender.sendMarkdown({ scope: 'c2c', targetId: 'u1', msgId: 'm5' }, 'hi');
  assert.equal(res.ok, false);
  assert.equal(res.code, '40034005');
  assert.equal(bot.calls.length, 1);
});

test('引用回复：被动首条带 message_reference，主动消息不带', async () => {
  const { bot, sender } = setup();
  const target = { scope: 'group', targetId: 'g1', msgId: 'm6', refIdx: 'REFIDX_abc==' };
  await sender.sendMarkdown(target, 'quoted', { quote: true });
  assert.equal(bot.calls[0].messageReference.message_id, 'REFIDX_abc==');

  const proactive = await sender.sendMarkdown({ scope: 'group', targetId: 'g1' }, 'active', { quote: true });
  assert.equal(proactive.mode, 'proactive');
  assert.equal(bot.calls[1].messageReference, undefined);
});

test('引用本身被拒（格式错误）时去掉 message_reference 重试', async () => {
  const bot = makeBot((opts) => {
    if (opts.messageReference) throw apiError(40034124);
    return { id: 'no-ref-ok' };
  });
  const { sender } = setup({ bot });
  const res = await sender.sendMarkdown(
    { scope: 'group', targetId: 'g1', msgId: 'm8', refIdx: 'REFIDX_y' },
    'hi',
    { quote: true },
  );
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'passive');
  assert.equal(bot.calls.length, 2);
  assert.equal(bot.calls[1].messageReference, undefined);
});

test('引用由调用方 opts.quote 决定：不传则不引用（模型自选）', async () => {
  const { bot, sender } = setup();
  await sender.sendMarkdown({ scope: 'c2c', targetId: 'u1', msgId: 'm7', refIdx: 'REFIDX_x' }, 'hi');
  assert.equal(bot.calls[0].messageReference, undefined);
});

test('主动消息限速：超过单关系每分钟上限时排队超时并返回失败', async () => {
  const { sender } = setup({
    proactive: { perTargetPerMinute: 2, perTargetPerDay: 100, botPerSecond: 100, maxWaitMs: 40 },
  });
  const target = { scope: 'c2c', targetId: 'slow-user' };
  assert.equal((await sender.sendProactive(target, '1')).ok, true);
  assert.equal((await sender.sendProactive(target, '2')).ok, true);
  const blocked = await sender.sendProactive(target, '3');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'RATE_WAIT_TIMEOUT');
});

test('事件被动回复（event_id）与 msg_id 互斥', async () => {
  const { bot, sender } = setup();
  const res = await sender.sendEvent({ scope: 'c2c', targetId: 'u1' }, 'evt-1', 'welcome', { mode: 'plain' });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'passive');
  assert.equal(bot.calls[0].extra.event_id, 'evt-1');
  assert.equal(bot.calls[0].target.msgId, undefined);
});

test('错误码分类覆盖窗口/格式/去重/频控/永久/网络/未知', () => {
  assert.equal(classifySendError(apiError(40034128)).category, SEND_ERROR.WINDOW);
  assert.equal(classifySendError(apiError(40034127)).category, SEND_ERROR.FORMAT);
  assert.equal(classifySendError(apiError(40054005)).category, SEND_ERROR.DEDUPE);
  assert.equal(classifySendError(apiError(40034100)).category, SEND_ERROR.RATE_LIMIT);
  assert.equal(classifySendError(apiError(40034006)).category, SEND_ERROR.PERMANENT);
  assert.equal(classifySendError(Object.assign(new Error('down'), { code: 'ECONNRESET' })).category, SEND_ERROR.NETWORK);
  assert.equal(classifySendError(new Error('boom')).category, SEND_ERROR.UNKNOWN);
  assert.equal(bizCodeOf(apiError(40034005)), 40034005);
});

test('图文卡片：msg_type=8 + tuwen 结构，被动优先', async () => {
  const { bot, sender } = setup();
  const card = {
    title: '今日推荐',
    description: '一篇值得看的文章',
    url: 'https://example.com/a',
    pic_url: 'https://example.com/a.png',
  };
  const res = await sender.sendCard({ scope: 'group', targetId: 'g1', msgId: 'm-card' }, card);
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'passive');
  assert.equal(bot.calls[0].msgType, 8);
  assert.equal(bot.calls[0].extra.card.type, 'tuwen');
  assert.deepEqual(bot.calls[0].extra.card.content, {
    title: '今日推荐',
    description: '一篇值得看的文章',
    url: 'https://example.com/a',
    pic_url: 'https://example.com/a.png',
  });
  assert.equal(bot.calls[0].target.msgId, 'm-card');
});

test('图文卡片：模拟 SDK send() 的字段裁剪，card 必须经 extra 进入请求体', async () => {
  // QQBot.send() 只认 content/markdown/ark/embed/media/keyboard/messageReference/extra，
  // card 不在白名单里：如果走 opts.card 会被静默丢弃，线上就只剩 msg_type=8 → 22006/304061。
  const bodies = [];
  const bot = {
    calls: [],
    async send(opts) {
      this.calls.push(opts);
      const body = {};
      if (opts.target.msgId) body.msg_id = opts.target.msgId;
      if (opts.msgType !== undefined) body.msg_type = opts.msgType;
      if (opts.content !== undefined) body.content = opts.content;
      if (opts.markdown) body.markdown = opts.markdown;
      if (opts.extra) Object.assign(body, opts.extra);
      bodies.push(body);
      return { id: 'wire-1' };
    },
  };
  const { sender } = setup({ bot });
  const res = await sender.sendCard(
    { scope: 'c2c', targetId: 'u1', msgId: 'm9' },
    { title: '标题', description: '摘要', url: 'https://example.com/c' },
  );
  assert.equal(res.ok, true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].msg_type, 8);
  assert.ok(bodies[0].card, 'card 字段必须出现在最终请求体里');
  assert.equal(bodies[0].card.type, 'tuwen');
  assert.equal(bodies[0].card.content.url, 'https://example.com/c');
});

test('图文卡片：卡片参数不完整时返回 INVALID_CARD', async () => {
  const { bot, sender } = setup();
  const res = await sender.sendCard({ scope: 'c2c', targetId: 'u1', msgId: 'm1' }, { title: '只有标题' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'INVALID_CARD');
  assert.equal(bot.calls.length, 0);
});

test('图文卡片：发送被拒（304061）时降级为纯文本（标题+摘要+链接）', async () => {
  const bot = makeBot((opts) => {
    if (opts.msgType === 8) throw apiError(304061);
    return { id: 'plain-card-ok' };
  });
  const { sender } = setup({ bot });
  const res = await sender.sendCard(
    { scope: 'c2c', targetId: 'u1', msgId: 'm2' },
    { title: '标题', description: '摘要', url: 'https://example.com/b' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.degraded, true);
  assert.equal(res.degradedReason, '304061');
  assert.equal(bot.calls.length, 2);
  assert.equal(bot.calls[1].msgType, 0);
  assert.equal(bot.calls[1].content, '标题\n摘要\nhttps://example.com/b');
});

test('nextMsgSeq 在合法范围且两次不同', () => {
  const a = nextMsgSeq();
  const b = nextMsgSeq();
  assert.ok(a >= 1 && a <= 65535);
  assert.ok(b >= 1 && b <= 65535);
  assert.notEqual(a, b);
});
