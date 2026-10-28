/**
 * outbound-final —— 一个 turn 里只发送最终回复，避免「先说话再调工具」导致重复气泡。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createOutboundHandler } from '../lib/qq/outbound.js';

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
