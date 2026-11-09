/**
 * host/llm 的 one-shot 契约：文本 / 多模态 / 失败降级。
 * 用假 llm 服务（llm.stream 返回异步块）验证入参形状，不依赖真实模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createOneShot } from '../lib/host/llm.js';

function fakeCtx({ chunks = null, error = null } = {}) {
  const calls = [];
  const llm = {
    stream(options) {
      calls.push(options);
      if (error) throw error;
      return (async function* gen() {
        // dsh-llm 的真实块形状：{type:'text-delta', index, text} + 可选的 finish
        for (const chunk of chunks || [{ type: 'text-delta', index: 0, text: '你好' }]) yield chunk;
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  return { calls, ctx: { get: (name) => (name === 'llm' ? llm : undefined) } };
}

test('纯文本生成：返回拼接后的文本', async () => {
  const { ctx, calls } = fakeCtx({
    chunks: [{ type: 'text-delta', index: 0, text: '第一段' }, { type: 'text-delta', index: 0, text: '第二段' }],
  });
  const one = createOneShot({ ctx });
  const result = await one.generate({ prompt: '写点什么', maxTokens: 64 });
  assert.equal(result.ok, true);
  assert.equal(result.text, '第一段第二段');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxTokens, 64);
  const content = calls[0].messages[0].content;
  assert.equal(content.length, 1);
  assert.equal(content[0].type, 'text');
});

test('多模态生成：images 变成 image block 且在文本前', async () => {
  const { ctx, calls } = fakeCtx();
  const one = createOneShot({ ctx });
  const ref = { id: 'att_1', mediaType: 'image/png' };
  const result = await one.generate({ prompt: '描述这张图', images: [ref], system: '你是视觉助手' });
  assert.equal(result.ok, true);
  const content = calls[0].messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.deepEqual(content[0].attachment, ref);
  assert.equal(content[1].type, 'text');
  assert.match(content[1].text, /你是视觉助手/);
  assert.match(content[1].text, /描述这张图/);
});

test('system 折叠进提示词、空 prompt 直接失败', async () => {
  const { ctx, calls } = fakeCtx();
  const one = createOneShot({ ctx });
  const empty = await one.generate({ prompt: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(calls.length, 0);
});

test('llm 服务缺失与流错误都降级为 ok:false', async () => {
  const missing = createOneShot({ ctx: { get: () => undefined } });
  const a = await missing.generate({ prompt: 'x' });
  assert.equal(a.ok, false);
  assert.match(a.error, /llm/);

  const { ctx } = fakeCtx({ error: new Error('boom') });
  const one = createOneShot({ ctx });
  const b = await one.generate({ prompt: 'x' });
  assert.equal(b.ok, false);
  assert.match(b.error, /boom/);
});
