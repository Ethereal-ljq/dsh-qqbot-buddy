import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatMemoryRecall, formatKnowledgeRecall, recallForPeer,
  resolveMentionedMembers, formatMemberRecall, memberPromptLine, queryTerms,
} from '../lib/host/recall.js';
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
  assert.deepEqual(off, { memoryText: '', knowledgeText: '', memberText: '' });
  const empty = await recallForPeer({ memory, knowledge, settings: {}, botId: 'b', query: '   ' });
  assert.deepEqual(empty, { memoryText: '', knowledgeText: '', memberText: '' });
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
  assert.deepEqual(broken, { memoryText: '', knowledgeText: '', memberText: '' });
});

test('queryTerms：按空白/标点拆检索词，去重限长', () => {
  assert.deepEqual(queryTerms('hollow 吃什么？鱼鱼'), ['hollow', '吃什么', '鱼鱼']);
  assert.deepEqual(queryTerms('   '), []);
  assert.deepEqual(queryTerms('！？。'), []);
  // 长中文串按连接词/句首功能词再拆：直接问"对神棍老师和戴佳伟的印象"也能命中实体词
  const terms = queryTerms('对神棍老师和戴佳伟的印象');
  assert.ok(terms.includes('神棍老师'), '应拆出 神棍老师: ' + JSON.stringify(terms));
  assert.ok(terms.includes('戴佳伟'), '应拆出 戴佳伟: ' + JSON.stringify(terms));
});

test('多词回退：整句 FTS 零命中时逐词召回（记忆+知识）', async () => {
  const memory = {
    recallForPrompt: ({ query }) => (query === '吃什么' ? '【长期记忆】\n- 有人问吃什么就回豆瓣番茄疙瘩面' : ''),
  };
  const knowledge = {
    search: ({ query }) => (query === '吃什么' ? [{ docId: 1, title: '约定', text: '吃什么→豆瓣番茄疙瘩面' }] : []),
  };
  const out = await recallForPeer({
    memory, knowledge, settings: { memory: { enabled: true }, kb: { enabled: true } },
    botId: 'b', query: 'hollow 吃什么？鱼鱼',
  });
  assert.match(out.memoryText, /豆瓣番茄疙瘩面/);
  assert.match(out.knowledgeText, /豆瓣番茄疙瘩面/);
});

test('群友召回：只注入发言人 + 被提到的人（懒加载，不整库）', async () => {
  const members = {
    list: () => [
      { id: 1, openid: 'U1', nickname: '阿岚', profileJson: { personality: ['直爽'], deeds: ['帮鱼鱼写代码'], affinity: { level: 1, note: '老熟人' } } },
      { id: 2, openid: 'U2', nickname: 'hollow', profileJson: { nicknames: ['hollow猫'], tags: ['写代码'] } },
      { id: 3, openid: 'U3', nickname: '红烧鱼', profileJson: {} },
    ],
  };
  const out = await recallForPeer({
    members, settings: { members: { enabled: true, injectSender: true, maxPerTurn: 3 } },
    botId: 'b', query: '阿岚 hollow猫 在吗', senderId: 'U1',
  });
  assert.match(out.memberText, /【群友】/);
  assert.match(out.memberText, /阿岚/);
  assert.match(out.memberText, /就是当前发言人/);
  assert.match(out.memberText, /hollow/);
  assert.ok(!out.memberText.includes('红烧鱼'), '未被提到的群友不应注入');

  const off = await recallForPeer({ members, settings: { members: { enabled: false } }, botId: 'b', query: '阿岚', senderId: 'U1' });
  assert.equal(off.memberText, '');
});

test('群友提及：最长称呼优先，短别名不误伤', () => {
  const candidates = [
    { id: 1, nickname: '老周' },
    { id: 2, nickname: '老周年' },
  ];
  const hits = resolveMentionedMembers('老周年今天来了', candidates, { limit: 3 });
  assert.equal(hits.length, 2, '两个都命中，但按 alias 长度排序');
  assert.equal(hits[0].member.id, 2);
});

test('群友段：预算截断与单行摘要', () => {
  const line = memberPromptLine({ nickname: '阿岚', profileJson: { personality: ['直爽'], deeds: ['写码'] } }, { isSender: true });
  assert.match(line, /^- 群友 阿岚：/);
  assert.match(line, /就是当前发言人/);
  const text = formatMemberRecall([line, '- 群友 X：' + 'y'.repeat(600)], 120);
  assert.match(text, /【群友】/);
  assert.ok(text.length <= 140);
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
