/**
 * inbound-card —— 入站组装的三项新增：ARK 卡片解析、引用 refIdx、兜底提示走统一 sender。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleAgentBody, createInboundHandler } from '../lib/qq/inbound.js';
import { createFakeLogger } from './helpers/fake-ctx.js';

/** 卡片消息：SDK 把事件体放在 msg.raw 里，ark_data 也在 raw 中。 */
function cardMessage({ fields = {}, ark = {}, extra = {} } = {}) {
  return {
    kind: 'c2c',
    content: '',
    messageId: 'm-card',
    senderId: 'U-CARD-1',
    msgType: 3,
    raw: { ark_data: { ark_type: 37, prompt: '', fields: fields, ...ark } },
    ...extra,
  };
}

const userText = (message) => message && message.content && message.content[0] && message.content[0].text;

/**
 * 入站处理器测试夹具。
 * @param {object} [options]
 * @param {boolean} [options.withSender] 是否注入 getSender（默认不注入，走旧 bot.sendMarkdown）
 * @param {object} [options.manager] 覆盖 manager（触发兜底提示）
 */
function makeRig({ withSender = false, manager, settings } = {}) {
  const created = [];
  const follows = [];
  const botSend = [];
  const senderSend = [];
  const log = createFakeLogger();
  const record = {
    agent: {
      followup: async (message) => { follows.push(message); },
      whenIdle: async () => {},
    },
    turn: { current: null },
  };
  const mgr = manager || {
    getOrCreate: async (scope, peerId, senderId, replyTarget) => {
      created.push({ scope, peerId, senderId, replyTarget });
      return record;
    },
  };
  const bot = {
    sendMarkdown: async (target, text) => {
      botSend.push({ target, text });
      return { id: 'b1' };
    },
  };
  const sender = {
    sendMarkdown: async (target, text, opts) => {
      senderSend.push({ target, text, opts });
      return { ok: true };
    },
    sendProactive: async () => ({ ok: true }),
  };
  const handler = createInboundHandler({
    config: { appId: 'app-1' },
    logger: log,
    manager: mgr,
    settings: settings || { get: () => ({ members: { autoRecord: false } }) },
    stats: {},
    historyStore: { clear() {} },
    botId: 'bot-1',
    getSender: withSender ? () => sender : undefined,
  });
  return {
    handler, bot, sender, created, follows, botSend, senderSend, log, record,
    run: (message, state = {}) => handler({ message, state, bot }),
  };
}

test('ARK 卡片：标题/来源/摘要/链接拼成一行 [卡片]', () => {
  const body = assembleAgentBody({
    message: cardMessage({
      fields: {
        title: '标题',
        source: '哔哩哔哩',
        tag: '小程序',
        desc: '摘要',
        jump_url: 'https://example.com/a',
        preview: 'https://example.com/p.png',
      },
    }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(body, '[卡片] 标题｜哔哩哔哩｜摘要｜https://example.com/a');
});

test('ARK 卡片：来源可退到 tag，摘要可退到 prompt', () => {
  const body = assembleAgentBody({
    message: cardMessage({
      fields: { tag: '小程序' },
      ark: { prompt: '[QQ小程序]哔哩哔哩' },
    }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(body, '[卡片] 小程序｜[QQ小程序]哔哩哔哩');
});

test('ARK 卡片：只有 prompt / preview 时也能出内容', () => {
  const promptOnly = assembleAgentBody({
    message: cardMessage({ fields: {}, ark: { prompt: '[QQ小程序]哔哩哔哩' } }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(promptOnly, '[卡片] [QQ小程序]哔哩哔哩');

  const previewOnly = assembleAgentBody({
    message: cardMessage({ fields: { preview: 'https://example.com/p.png' } }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(previewOnly, '[卡片] https://example.com/p.png');
});

test('只有卡片、content 为空的消息不会被当成空消息丢弃', () => {
  const body = assembleAgentBody({ message: cardMessage({ fields: { title: '只看我' } }), state: {}, scope: 'c2c' });
  assert.equal(body, '[卡片] 只看我');
});

test('卡片完全没有内容字段时用 ark_name 兜底；连卡片体都没有也给 [卡片] 占位', () => {
  const templateOnly = assembleAgentBody({
    message: cardMessage({ fields: {}, ark: { ark_name: '小程序' } }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(templateOnly, '[卡片] 小程序');

  const bare = { kind: 'c2c', content: '', messageId: 'm2', senderId: 'U2', msgType: 3 };
  assert.equal(assembleAgentBody({ message: bare, state: {}, scope: 'c2c' }), '[卡片]');
});

test('卡片 + 正文同时存在：卡片在前、正文在后', () => {
  const message = cardMessage({ fields: { title: '卡片标题' }, extra: { content: '附带一句' } });
  assert.equal(assembleAgentBody({ message, state: {}, scope: 'c2c' }), '[卡片] 卡片标题\n附带一句');
});

test('普通文本消息不受卡片解析影响', () => {
  const message = { kind: 'c2c', content: '你好呀', messageId: 'm3', senderId: 'U3' };
  assert.equal(assembleAgentBody({ message, state: {}, scope: 'c2c' }), '你好呀');
});

test('群聊卡片消息带发送者标签，且不会被当成空消息', () => {
  const message = cardMessage({
    fields: { title: '群里的卡片' },
    extra: { kind: 'group', groupOpenid: 'G-1', senderId: 'M-1', senderName: '阿岚' },
  });
  const body = assembleAgentBody({ message, state: {}, scope: 'group' });
  assert.equal(body, '[阿岚 (M-1)] [卡片] 群里的卡片');
});

test('只有卡片的消息会真的投递给 agent（不被入站处理器丢弃）', async () => {
  const rig = makeRig();
  await rig.run(cardMessage({ fields: { title: '投递给我' } }));
  assert.equal(rig.follows.length, 1);
  assert.equal(userText(rig.follows[0]), '[卡片] 投递给我');
});

test('replyTarget 附带 msgIdx 作为 refIdx（引用回复用）', async () => {
  const rig = makeRig();
  await rig.run({ kind: 'c2c', content: '引用我', messageId: 'm-ref', msgIdx: '9001', senderId: 'U9' });
  assert.equal(rig.created.length, 1);
  assert.deepEqual(rig.created[0].replyTarget, { scope: 'c2c', targetId: 'U9', msgId: 'm-ref', refIdx: '9001' });
});

test('没有 msgIdx 时 refIdx 为 undefined（不伪造引用）', async () => {
  const rig = makeRig();
  await rig.run({ kind: 'c2c', content: '普通消息', messageId: 'm-plain', senderId: 'U9' });
  assert.equal(rig.created[0].replyTarget.refIdx, undefined);
  assert.equal(rig.created[0].replyTarget.msgId, 'm-plain');
});

test('兜底提示优先走 getSender().sendMarkdown(target, text, {quote:false})', async () => {
  const rig = makeRig({
    withSender: true,
    manager: { getOrCreate: async () => { throw new Error('boom'); } },
  });
  await rig.run({ kind: 'c2c', content: 'hi', messageId: 'm-e', senderId: 'U-ERR' });
  assert.equal(rig.senderSend.length, 1);
  assert.equal(rig.senderSend[0].target.scope, 'c2c');
  assert.equal(rig.senderSend[0].opts.quote, false);
  assert.ok(rig.senderSend[0].text.includes('异常'));
  assert.equal(rig.botSend.length, 0, '有 sender 时不走 bot.sendMarkdown');
});

test('没有 getSender 时兜底提示保持旧行为 bot.sendMarkdown', async () => {
  const rig = makeRig({
    manager: { getOrCreate: async () => { throw new Error('boom'); } },
  });
  await rig.run({ kind: 'c2c', content: 'hi', messageId: 'm-e2', senderId: 'U-ERR' });
  assert.equal(rig.botSend.length, 1);
  assert.ok(rig.botSend[0].text.includes('异常'));
  assert.equal(rig.senderSend.length, 0);
});

test('sender 返回 ok:false 只记日志，不抛错也不重复发', async () => {
  const rig = makeRig({ manager: { getOrCreate: async () => { throw new Error('boom'); } } });
  const handler = createInboundHandler({
    config: {},
    logger: rig.log,
    manager: { getOrCreate: async () => { throw new Error('boom'); } },
    settings: { get: () => ({}) },
    stats: {},
    historyStore: { clear() {} },
    getSender: () => ({ sendMarkdown: async () => ({ ok: false, code: 'PASSIVE_EXHAUSTED' }) }),
  });
  await handler({ message: { kind: 'c2c', content: 'hi', messageId: 'm-f', senderId: 'U-F' }, state: {}, bot: rig.bot });
  assert.equal(rig.botSend.length, 0);
  assert.ok(rig.log.byLevel('warn').some((args) => String(args[0]).includes('PASSIVE_EXHAUSTED')));
});

test('getSender 抛异常时降级 bot.sendMarkdown，不让兜底提示整体失败', async () => {
  const rig = makeRig();
  const handler = createInboundHandler({
    config: {},
    logger: rig.log,
    manager: { getOrCreate: async () => { throw new Error('boom'); } },
    settings: { get: () => ({}) },
    stats: {},
    historyStore: { clear() {} },
    getSender: () => { throw new Error('sender broken'); },
  });
  await handler({ message: { kind: 'c2c', content: 'hi', messageId: 'm-g', senderId: 'U-G' }, state: {}, bot: rig.bot });
  assert.equal(rig.botSend.length, 1);
});
