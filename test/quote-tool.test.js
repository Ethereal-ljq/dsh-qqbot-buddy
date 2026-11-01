/**
 * quote-tool —— qqbot_quote_reply：模型自选引用回复（设置本轮 record.quoteNext）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { QUOTE_REPLY_TOOL_NAME, registerQuoteReplyTool } from '../lib/tools/quote-reply.js';

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function setup({ record } = {}) {
  const registered = [];
  const ctx = {
    get(name) {
      if (name !== 'tools') return undefined;
      return { register(definition) { registered.push(definition); return () => {}; } };
    },
  };
  const manager = {
    findByAgent: (agent) => (record && agent ? record : undefined),
  };
  registerQuoteReplyTool({ ctx, manager, logger: noopLogger });
  return { registered, definition: registered[0], manager };
}

test('注册：工具名与无参数 schema', () => {
  const { definition } = setup();
  assert.equal(definition.name, QUOTE_REPLY_TOOL_NAME);
  assert.deepEqual(definition.parameters.properties, {});
  assert.deepEqual(definition.parameters.required, []);
});

test('execute：设置当前会话 record.quoteNext，并返回目标', async () => {
  const record = { replyTarget: { scope: 'group', targetId: 'g1', msgId: 'm1' } };
  const { definition } = setup({ record });
  const value = await definition.execute({}, { agent: { id: 'a1' } });
  assert.equal(record.quoteNext, true);
  assert.deepEqual(value, { quoted: true, target: 'group:g1' });
});

test('execute：找不到会话/管理器不可用时抛可读错误', async () => {
  const { definition } = setup({ record: null });
  await assert.rejects(() => definition.execute({}, { agent: { id: 'a1' } }), /找不到当前 QQ 会话/);

  const registered = [];
  const ctx = { get: () => ({ register: (def) => { registered.push(def); return () => {}; } }) };
  registerQuoteReplyTool({ ctx, manager: null, logger: noopLogger });
  await assert.rejects(() => registered[0].execute({}, {}), /会话管理器不可用/);
});
