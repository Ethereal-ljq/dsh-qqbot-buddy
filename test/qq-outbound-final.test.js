/**
 * outbound-final —— 一个 turn 里只发送最终回复，避免「先说话再调工具」导致重复气泡。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createOutboundHandler, createSentTracker } from '../lib/qq/outbound.js';
import { createSender } from '../lib/qq/sender.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeRig() {
  const sent = [];
  const record = { replyTarget: { scope: 'group', targetId: 'g1' } };
  const sessions = new Map([['s1', record]]);
  const manager = { findBySessionId: (id) => sessions.get(id) };
  const stats = { replies: 0, lastReplyAt: 0 };
  const bot = {
    sendMarkdown: async (target, chunk) => {
      sent.push(chunk);
      return { id: 'm' + sent.length };
    },
  };
  const handler = createOutboundHandler({
    config: {},
    logger: { warn() {}, error() {}, debug() {} },
    manager,
    stats,
    getBot: () => bot,
  });
  return { sent, stats, handler };
}

test('sentTracker 同时记录消息 id 与引用 ref_idx', () => {
  const tracker = createSentTracker();
  tracker.record({ id: 'ROBOT1.0_msg', ext_info: { ref_idx: 'REFIDX_abc==' } }, 'hello world');
  assert.equal(tracker.hasId('ROBOT1.0_msg'), true);
  assert.equal(tracker.hasId('REFIDX_abc=='), true, 'ref_idx 也应能被 replyProbe 命中');
  assert.equal(tracker.hasText('hello world'), true);
});

const assistant = (text, withToolCall) => ({
  type: 'assistant/message',
  data: {
    message: {
      content: withToolCall
        ? [{ type: 'text', text }, { type: 'tool-call', name: 'memory_save' }]
        : [{ type: 'text', text }],
    },
  },
});
const turnEnd = (kind = 'completed') => ({ type: 'turn/end', data: { reason: { kind } } });

test('助手先说话再调工具：只发工具回来后的最终回复', async () => {
  const { sent, stats, handler } = makeRig();
  handler({ header: { id: 's1' } }, assistant('中间话术', true));
  await tick();
  assert.deepEqual(sent, [], '中间话术不立即发送');
  handler({ header: { id: 's1' } }, assistant('最终回复'));
  handler({ header: { id: 's1' } }, turnEnd());
  await tick();
  assert.deepEqual(sent, ['最终回复']);
  assert.equal(stats.replies, 1);
  assert.ok(stats.lastReplyAt > 0);
});

test('同一 turn 多个 assistant 文本：只发最后一个', async () => {
  const { sent, handler } = makeRig();
  handler({ header: { id: 's1' } }, assistant('第一版'));
  handler({ header: { id: 's1' } }, assistant('第二版'));
  handler({ header: { id: 's1' } }, turnEnd());
  await tick();
  assert.deepEqual(sent, ['第二版']);
});

test('最终文本仍按空行拆成多条气泡', async () => {
  const { sent, handler } = makeRig();
  handler({ header: { id: 's1' } }, assistant('第一句\n\n第二句'));
  handler({ header: { id: 's1' } }, turnEnd());
  await tick();
  assert.deepEqual(sent, ['第一句', '第二句']);
});

test('异常/中止的 turn 不发残留文本；异常只发提示', async () => {
  const { sent, stats, handler } = makeRig();
  handler({ header: { id: 's1' } }, assistant('半截话'));
  handler({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'E_TEST', message: 'boom' } } } });
  await tick();
  assert.deepEqual(sent, ['⚠️ 本轮异常结束\n**E_TEST**: boom']);
  assert.equal(stats.replies, 0);

  const aborted = makeRig();
  aborted.handler({ header: { id: 's1' } }, assistant('半截话'));
  aborted.handler({ header: { id: 's1' } }, turnEnd('aborted'));
  await tick();
  assert.deepEqual(aborted.sent, []);
});

test('turn 没有文本时不发送', async () => {
  const { sent, handler } = makeRig();
  handler({ header: { id: 's1' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '' }] } } });
  handler({ header: { id: 's1' } }, turnEnd());
  await tick();
  assert.deepEqual(sent, []);
});


test('bubbleSplit=marker：空行不再拆，只认 [[msg]]', async () => {
  const sent = [];
  const record = { replyTarget: { scope: 'group', targetId: 'g1' } };
  const settings = { get: () => ({ reply: { bubbleSplit: 'marker' } }) };
  const handler = createOutboundHandler({
    config: {}, logger: { warn() {}, error() {}, debug() {} },
    manager: { findBySessionId: () => record }, stats: { replies: 0, lastReplyAt: 0 },
    getBot: () => ({ sendMarkdown: async (_t, chunk) => { sent.push(chunk); return { id: 'm' + sent.length }; } }),
    settings,
  });
  handler({ header: { id: 's1' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一句\n\n第二句' }] } } });
  handler({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await tick();
  assert.deepEqual(sent, ['第一句\n\n第二句']);

  sent.length = 0;
  handler({ header: { id: 's1' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一句[[msg]]第二句' }] } } });
  handler({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await tick();
  assert.deepEqual(sent, ['第一句', '第二句']);
});

test('bubbleSplit=off：永不拆（[[msg]] 也不拆）', async () => {
  const sent = [];
  const record = { replyTarget: { scope: 'group', targetId: 'g1' } };
  const settings = { get: () => ({ reply: { bubbleSplit: 'off' } }) };
  const handler = createOutboundHandler({
    config: {}, logger: { warn() {}, error() {}, debug() {} },
    manager: { findBySessionId: () => record }, stats: { replies: 0, lastReplyAt: 0 },
    getBot: () => ({ sendMarkdown: async (_t, chunk) => { sent.push(chunk); return { id: 'm' + sent.length }; } }),
    settings,
  });
  handler({ header: { id: 's1' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一句\n\n第二句[[msg]]第三句' }] } } });
  handler({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await tick();
  assert.deepEqual(sent, ['第一句\n\n第二句[[msg]]第三句']);
});

test('注入 sender 时走统一发送器，模型标记引用时只加在首条气泡', async () => {
  const sent = [];
  const record = { replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1', refIdx: 'REFIDX_x' }, quoteNext: true };
  const sender = {
    async sendMarkdown(target, text, opts) {
      sent.push({ text, quote: opts && opts.quote, target });
      return { ok: true, result: { id: 's' + sent.length } };
    },
  };
  const handler = createOutboundHandler({
    config: {}, logger: { warn() {}, error() {}, debug() {} },
    manager: { findBySessionId: () => record }, stats: { replies: 0, lastReplyAt: 0 },
    getBot: () => ({ sendMarkdown: async () => ({ id: 'legacy' }) }),
    getSender: () => sender,
  });
  handler({ header: { id: 's1' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一段\n\n第二段' }] } } });
  handler({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent.map((item) => item.text), ['第一段', '第二段']);
  assert.equal(sent[0].quote, true, '模型标记引用后，首条应引用');
  assert.equal(sent[1].quote, false, '后续气泡不重复引用');
  assert.equal(record.quoteNext, false, '引用标记发送后应清零');
});

test('模型没有调用 qqbot_quote_reply 时默认不引用', async () => {
  const sent = [];
  const record = { replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1', refIdx: 'REFIDX_x' } };
  const handler = createOutboundHandler({
    config: {}, logger: { warn() {}, error() {}, debug() {} },
    manager: { findBySessionId: () => record }, stats: { replies: 0, lastReplyAt: 0 },
    getBot: () => ({ sendMarkdown: async () => ({ id: 'legacy' }) }),
    getSender: () => ({ async sendMarkdown(_t, text, opts) { sent.push({ text, quote: opts && opts.quote }); return { ok: true, result: { id: 'x' } }; } }),
  });
  handler({ header: { id: 's1' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '普通回复' }] } } });
  handler({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent[0].quote, false);
});

test('sender 发送失败时不统计为已回复', async () => {
  const record = { replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } };
  const stats = { replies: 0, lastReplyAt: 0 };
  const handler = createOutboundHandler({
    config: {}, logger: { warn() {}, error() {}, debug() {} },
    manager: { findBySessionId: () => record }, stats,
    getBot: () => ({ sendMarkdown: async () => ({ id: 'legacy' }) }),
    getSender: () => ({ async sendMarkdown() { return { ok: false, code: '40034006' }; } }),
  });
  handler({ header: { id: 's1' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } });
  handler({ header: { id: 's1' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stats.replies, 0);
});



// ── 长回复送达（现场回归）──────────────────────────────────────
// 2026-11-01 22:48–22:57 的 QQ 群会话里，684/443/419 字的多段回复群里没收到，
// 同会话 ≤63 字的单行回复全部正常；根因是长度超限（40054007/40054018）被当成
// 永久错误直接放弃、整条丢弃。这里端到端锁住「拆条必达」。

test('长回复被平台以长度超限拒绝时：拆成多条送达，并按已回复统计', async () => {
  const PLATFORM_LIMIT = 120;
  const sent = [];
  const bot = {
    async send(opts) {
      const text = opts.markdown ? opts.markdown.content : String(opts.content ?? '');
      if (text.length > PLATFORM_LIMIT) {
        const err = new Error('消息长度超限');
        err.bizCode = 40054007;
        err.httpStatus = 400;
        throw err;
      }
      sent.push(text);
      return { id: 'm' + sent.length, ext_info: {} };
    },
    // outbound 只在 bot 有 sendMarkdown 时才认为机器人可用；实际发送走注入的 sender。
    async sendMarkdown() {
      throw new Error('should not be used: sender injected');
    },
  };
  const sender = createSender({
    getBot: () => bot,
    settings: { get: () => ({ reply: { proactiveFallback: true, bubbleSplit: 'auto' } }) },
    logger: { warn() {}, error() {}, debug() {}, info() {} },
  });
  const record = { replyTarget: { scope: 'group', targetId: 'g1', msgId: 'm-long' } };
  const stats = { replies: 0, lastReplyAt: 0 };
  const handler = createOutboundHandler({
    config: {},
    logger: { warn() {}, error() {}, debug() {} },
    manager: { findBySessionId: () => record },
    stats,
    getBot: () => bot,
    getSender: () => sender,
  });
  const longText = '新版重置技能树用洞察点解锁，节点一级一级往上点，'
    + '旁边的公主面板显示等级、经验、体力、疲劳、音乐、嗅觉、死盾CD、骑乘CD、抗伤这些数值；'
    + '背刺在 120 度范围内没有其他玩家时必定成功，触发优先级低于冰冻和睡眠；'
    + '榕猫帽靠喂肉和料理升级，BOSS 战给夜视效果，黑夜额外加移速。';
  handler({ header: { id: 's1' } }, assistant(longText));
  handler({ header: { id: 's1' } }, turnEnd());
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(sent.length >= 2, '长回复应拆成多条发出（实际 ' + sent.length + ' 条）');
  for (const part of sent) assert.ok(part.length <= PLATFORM_LIMIT);
  assert.equal(sent.join('').replace(/\s+/g, ''), longText.replace(/\s+/g, ''), '拆条后不能丢字');
  assert.equal(stats.replies, 1, '送达后应计一次回复');
  assert.ok(stats.lastReplyAt > 0);
});

test('同一 turn 的多条气泡共用同一个 replyTarget（不抢占下一轮的 msg_id）', async () => {
  const record = { replyTarget: { scope: 'group', targetId: 'g1', msgId: 'm-first' } };
  const seen = [];
  const sender = {
    async sendMarkdown(target, text) {
      seen.push({ text, msgId: target.msgId });
      // 第一条还在发送时，新入站消息覆盖了 record.replyTarget（turn2 出站与 turn3 入站同秒的真实现场）
      record.replyTarget = { scope: 'group', targetId: 'g1', msgId: 'm-second' };
      return { ok: true, result: { id: 's' + seen.length } };
    },
  };
  const handler = createOutboundHandler({
    config: {},
    logger: { warn() {}, error() {}, debug() {} },
    manager: { findBySessionId: () => record },
    stats: { replies: 0, lastReplyAt: 0 },
    getBot: () => ({ async sendMarkdown() { return { id: 'legacy' }; } }),
    getSender: () => sender,
  });
  handler({ header: { id: 's1' } }, assistant('第一段\n\n第二段'));
  handler({ header: { id: 's1' } }, turnEnd());
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(seen.map((item) => item.text), ['第一段', '第二段']);
  assert.deepEqual(seen.map((item) => item.msgId), ['m-first', 'm-first'], '本轮气泡不应改用下一轮的 msg_id');
});
