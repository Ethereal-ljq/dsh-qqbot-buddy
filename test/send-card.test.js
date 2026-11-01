/**
 * send-card —— qqbot_send_card 工具：字段校验、目标解析、发送结果映射。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEND_CARD_TOOL_NAME,
  normalizeCardArgs,
  registerSendCardTool,
} from '../lib/tools/send-card.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function setup({ senderImpl, replyTarget } = {}) {
  const calls = [];
  const sender = {
    async sendCard(target, card, opts) {
      calls.push({ target, card, opts });
      if (senderImpl) return senderImpl(target, card, opts);
      return { ok: true, mode: 'passive', degraded: false, result: { id: 'card-1' } };
    },
  };
  const manager = {
    findByAgent: (agent) => (replyTarget && agent ? { replyTarget } : undefined),
  };
  const registered = [];
  const ctx = {
    get(name) {
      if (name !== 'tools') return undefined;
      return {
        register(definition) {
          registered.push(definition);
          return () => {};
        },
      };
    },
  };
  const dispose = registerSendCardTool({ ctx, sender, manager, logger: noopLogger });
  return { calls, registered, definition: registered[0], dispose, manager };
}

test('注册：工具名与参数 schema', () => {
  const { definition } = setup();
  assert.equal(definition.name, SEND_CARD_TOOL_NAME);
  assert.deepEqual(definition.parameters.required, ['title', 'description', 'url']);
  assert.equal(typeof definition.execute, 'function');
});

test('字段校验：title/description 长度、url 必须 https', () => {
  assert.deepEqual(
    normalizeCardArgs({ title: '标题', description: '摘要', url: 'https://a.com/x' }),
    { title: '标题', description: '摘要', url: 'https://a.com/x' },
  );
  assert.throws(() => normalizeCardArgs({ title: '', description: 'x', url: 'https://a.com' }), /title/);
  assert.throws(() => normalizeCardArgs({ title: 'x'.repeat(51), description: 'x', url: 'https://a.com' }), /title/);
  assert.throws(() => normalizeCardArgs({ title: 'x', description: '', url: 'https://a.com' }), /description/);
  assert.throws(() => normalizeCardArgs({ title: 'x', description: 'y', url: 'http://a.com' }), /https/);
  assert.throws(() => normalizeCardArgs({ title: 'x', description: 'y', url: 'https://a.com', pic_url: 'http://a.com/p.png' }), /pic_url/);
});

test('execute：从当前 agent 反查 replyTarget 并发送', async () => {
  const replyTarget = { scope: 'group', targetId: 'g1', msgId: 'm1' };
  const { definition, calls } = setup({ replyTarget });
  const value = await definition.execute(
    { title: '推荐', description: '值得一看', url: 'https://example.com/a', pic_url: 'https://example.com/a.png' },
    { agent: { id: 'a1' } },
  );
  assert.deepEqual(calls[0].target, replyTarget);
  assert.equal(calls[0].card.title, '推荐');
  assert.deepEqual(value, {
    title: '推荐',
    target: 'group:g1',
    mode: 'passive',
    degraded: false,
    messageId: 'card-1',
  });
});

test('execute：显式 target 覆盖当前会话', async () => {
  const { definition, calls } = setup();
  await definition.execute(
    { title: 'x', description: 'y', url: 'https://a.com', target: 'c2c:openid-1' },
    {},
  );
  assert.deepEqual(calls[0].target, { scope: 'c2c', targetId: 'openid-1' });
});

test('execute：无法确定目标 / 发送失败时抛可读错误', async () => {
  const noTarget = setup();
  await assert.rejects(
    () => noTarget.definition.execute({ title: 'x', description: 'y', url: 'https://a.com' }, {}),
    /无法确定发送目标/,
  );

  const failing = setup({ replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm2' }, senderImpl: async () => ({ ok: false, code: '304061', error: '内容无效' }) });
  await assert.rejects(
    () => failing.definition.execute({ title: 'x', description: 'y', url: 'https://a.com' }, { agent: {} }),
    /304061/,
  );
});

test('execute：降级纯文本时 output 仍成功并标记 degraded', async () => {
  const { definition } = setup({
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm3' },
    senderImpl: async () => ({ ok: true, mode: 'passive', degraded: true, result: { id: 'plain-1' } }),
  });
  const value = await definition.execute({ title: 'x', description: 'y', url: 'https://a.com' }, { agent: {} });
  assert.equal(value.degraded, true);
  assert.equal(value.messageId, 'plain-1');
});
