import test from 'node:test';
import assert from 'node:assert/strict';

import { formatMemoryRecall, formatKnowledgeRecall, recallForPeer } from '../lib/host/recall.js';
import { mountPlan, CAPABILITY_MOUNTS } from '../lib/host/tool-mounts.js';

test('记忆召回：按预算拼行，超预算截断', () => {
  const rows = [{ text: '用户喜欢猫' }, { text: '用户住杭州' }, { text: '用户是前端工程师' }];
  const text = formatMemoryRecall(rows, 20);
  assert.match(text, /【长期记忆】/);
  assert.match(text, /用户喜欢猫/);
  assert.ok(text.length <= 40);
  assert.equal(formatMemoryRecall([], 100), '');
});

test('知识召回：带标题、限条数、空结果为空串', () => {
  const results = [
    { title: '团建', text: '周六下午三点滨江公园集合' },
    { title: 'FAQ', text: '人工审核 1-3 个工作日' },
  ];
  const text = formatKnowledgeRecall(results, 500, 5);
  assert.match(text, /【知识库】/);
  assert.match(text, /《团建》/);
  assert.match(text, /人工审核/);
  assert.equal(formatKnowledgeRecall([], 500), '');
  const limited = formatKnowledgeRecall(results, 500, 1);
  assert.ok(!limited.includes('人工审核'));
});

test('recallForPeer：设置关闭/空 query 时不召回', async () => {
  const memory = { search: () => { throw new Error('不应调用'); } };
  const knowledge = { search: () => { throw new Error('不应调用'); } };
  const off = await recallForPeer({ memory, knowledge, settings: { memory: { enabled: false }, kb: { enabled: false } }, botId: 'b', query: 'x' });
  assert.deepEqual(off, { memoryText: '', knowledgeText: '' });
  const empty = await recallForPeer({ memory, knowledge, settings: {}, botId: 'b', query: '   ' });
  assert.deepEqual(empty, { memoryText: '', knowledgeText: '' });
});

test('recallForPeer：正常召回 + store 抛错降级', async () => {
  const memory = { search: ({ query }) => [{ text: '记得' + query }] };
  const knowledge = { search: () => [{ title: 't', text: 'k' }] };
  const out = await recallForPeer({ memory, knowledge, settings: { memory: { enabled: true }, kb: { enabled: true } }, botId: 'b', query: '猫' });
  assert.match(out.memoryText, /记得猫/);
  assert.match(out.knowledgeText, /k/);

  const broken = await recallForPeer({
    memory: { search: () => { throw new Error('boom'); } },
    knowledge: { search: () => { throw new Error('boom'); } },
    settings: {}, botId: 'b', query: '猫',
  });
  assert.deepEqual(broken, { memoryText: '', knowledgeText: '' });
});

test('工具挂载计划：能力开关决定挂哪些宿主插件', () => {
  const base = mountPlan({});
  assert.ok(base.some((m) => m.moduleName === '@deepseek-ai/dsh-tool-fs'), '默认应挂 fs');
  assert.ok(base.some((m) => m.moduleName === '@deepseek-ai/dsh-tool-web'), '默认应挂 web');
  assert.ok(!base.some((m) => m.capability === 'shell'), 'shell 默认关，不挂 bash');
  const shell = mountPlan({ tools: { capabilities: { shell: true } } });
  assert.ok(shell.some((m) => m.capability === 'shell' && m.moduleName === '@deepseek-ai/dsh-tool-bash'));
  const minimal = mountPlan({ tools: { capabilities: { workspace: false, web: false, skills: false, shell: false } } });
  assert.deepEqual(minimal, []);
  assert.ok(CAPABILITY_MOUNTS.workspace.length > 0);
});
