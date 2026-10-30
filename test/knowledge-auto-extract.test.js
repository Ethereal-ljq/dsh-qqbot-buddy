/**
 * test/knowledge-auto-extract.test.js —— 知识库自动提炼（阶段一）。
 *
 * 覆盖：高置信直接入库 / 低置信进入 pending（不参与召回）/ 查重合并 /
 * 无可用模型与坏 JSON 的失败分支 / everyRounds 触发计数 / 关闭时不触发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeStore } from '../lib/knowledge/store.js';
import { createKnowledgeExtractor, parseExtractedKnowledge } from '../lib/knowledge/auto-extract.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makeSettings(dir, autoExtract) {
  return {
    get: () => ({
      knowledge: {
        enabled: true,
        dir: dir,
        autoExtract: Object.assign({
          enabled: true, everyRounds: 2, maxEntries: 3, minConfidence: 0.8, provider: 'test-provider', model: 'test-model',
        }, autoExtract || {}),
      },
      members: { enabled: true, dir: path.join(dir, '..', 'members') },
    }),
  };
}

function makeExtractor({ dir, autoExtract, reply }) {
  const settings = makeSettings(dir, autoExtract);
  const knowledge = createKnowledgeStore({ settings: settings, logger: quiet });
  knowledge.ensure();
  const calls = [];
  const extractor = createKnowledgeExtractor({
    ctx: null,
    settings: settings,
    knowledge: knowledge,
    logger: quiet,
    callModel: async (args) => {
      calls.push(args);
      if (typeof reply === 'function') return reply(args);
      return typeof reply === 'string' ? reply : '';
    },
  });
  return { extractor, knowledge, calls };
}

function tempKnowledgeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-auto-extract-'));
}

test('parseExtractedKnowledge：解析 fenced JSON、过滤非法与超量', () => {
  const rows = parseExtractedKnowledge('前缀\n\u0060\u0060\u0060json\n' + JSON.stringify({
    knowledge: [
      { title: '群规', body: '禁止广告', tags: ['群规', '管理'], importance: 3, confidence: 0.9 },
      { title: '', body: 'x' },
      { title: '空正文', body: '' },
      { title: '群规', body: '重复标题', confidence: 0.5 },
    ],
  }) + '\n\u0060\u0060\u0060', { maxEntries: 3 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '群规');
  assert.equal(rows[0].importance, 3);
  assert.equal(rows[0].confidence, 0.9);
  assert.deepEqual(rows[0].tags, ['群规', '管理']);
  assert.equal(parseExtractedKnowledge('not json'), null);
});

test('高置信入库、低置信 pending（pending 不参与召回）', async () => {
  const dir = tempKnowledgeDir();
  const { extractor, knowledge } = makeExtractor({
    dir: dir,
    reply: JSON.stringify({
      knowledge: [
        { title: '周六开黑', body: '每周六晚八点群语音开黑', tags: ['活动'], importance: 2, confidence: 0.9 },
        { title: '临时话题', body: '有人想去露营', tags: [], importance: 0, confidence: 0.2 },
      ],
    }),
  });
  const result = await extractor.extractNow(null, { transcript: '用户: 周六开黑吗\n助手: 每周六晚八点', groupHint: '读书会' });
  assert.equal(result.ok, true);
  assert.equal(result.added.length, 1);
  assert.equal(result.pending.length, 1);
  assert.equal(knowledge.list({}).total, 2);
  assert.equal(knowledge.list({ status: 'pending' }).total, 1);
  const recall = knowledge.recall({ query: '周六开黑' });
  assert.equal(recall.length, 1);
  assert.equal(recall[0].title, '周六开黑');
  assert.equal(recall[0].status, 'approved');
  assert.ok(!recall.some((item) => item.title === '临时话题'), 'pending 不应被召回');
});

test('同标题重复提炼：合并而不是新建', async () => {
  const dir = tempKnowledgeDir();
  const reply = JSON.stringify({ knowledge: [{ title: '群规', body: '禁止广告', tags: ['群规'], importance: 2, confidence: 0.9 }] });
  const { extractor, knowledge } = makeExtractor({ dir: dir, reply });
  await extractor.extractNow(null, { transcript: '用户: 群规是禁止广告' });
  const second = await extractor.extractNow(null, { transcript: '用户: 群规还是禁止广告' });
  assert.equal(second.ok, true);
  assert.equal(second.merged.length, 1);
  assert.equal(second.added.length, 0);
  assert.equal(knowledge.list({}).total, 1, '不应产生重复条目');
});

test('没有可用模型时返回可读错误', async () => {
  const dir = tempKnowledgeDir();
  const { extractor } = makeExtractor({ dir: dir, autoExtract: { provider: '', model: '' }, reply: '' });
  const result = await extractor.extractNow(null, { transcript: '用户: x\n助手: y' });
  assert.equal(result.ok, false);
  assert.match(result.error, /未配置可用的提炼模型/);
});

test('模型返回坏 JSON 时失败且不写库', async () => {
  const dir = tempKnowledgeDir();
  const { extractor, knowledge } = makeExtractor({ dir: dir, reply: '这不是 JSON' });
  const result = await extractor.extractNow(null, { transcript: '用户: x\n助手: y' });
  assert.equal(result.ok, false);
  assert.match(result.error, /JSON/);
  assert.equal(knowledge.list({}).total, 0);
});

test('noteTurnEnd：达到 everyRounds 才后台触发，关闭时不触发', async () => {
  const dir = tempKnowledgeDir();
  const { extractor, calls } = makeExtractor({
    dir: dir,
    autoExtract: { everyRounds: 2 },
    reply: JSON.stringify({ knowledge: [] }),
  });
  const record = {
    scope: 'group',
    peerId: 'g1',
    session: { events: [
      { type: 'user/message', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant/message', message: { content: [{ type: 'text', text: 'b' }] } },
      { type: 'user/message', message: { content: [{ type: 'text', text: 'c' }] } },
      { type: 'assistant/message', message: { content: [{ type: 'text', text: 'd' }] } },
    ] },
  };
  extractor.noteTurnEnd(record);
  assert.equal(calls.length, 0, '第 1 轮不触发');
  extractor.noteTurnEnd(record);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 1, '第 2 轮触发一次');

  const dir2 = tempKnowledgeDir();
  const disabled = makeExtractor({ dir: dir2, autoExtract: { enabled: false } });
  disabled.extractor.noteTurnEnd(record);
  disabled.extractor.noteTurnEnd(record);
  assert.equal(disabled.calls.length, 0, '关闭时永不触发');
});

test('群聊提炼带 groupId，私聊落 c2c 作用域', async () => {
  const dir = tempKnowledgeDir();
  const { extractor, knowledge } = makeExtractor({
    dir: dir,
    reply: JSON.stringify({ knowledge: [{ title: '群约定', body: '周五交周报', tags: [], importance: 1, confidence: 0.95 }] }),
  });
  await extractor.extractNow({ scope: 'group', peerId: 'g_9', session: { events: [] } }, {
    transcript: '用户: 周五交周报\n助手: 好的',
    groupHint: '读书会',
  });
  const rows = knowledge.list({});
  assert.equal(rows.total, 1);
  const entry = knowledge.get(rows.items[0].id);
  assert.equal(entry.scope, 'group');
  assert.equal(entry.groupId, 'g_9');
  assert.equal(entry.groupName, '读书会');
  assert.equal(entry.source, 'auto');
});

test('知识提炼手动留空：退回最近一次会话的消息', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-ke-'));
  const settings = {
    get: () => ({
      knowledge: {
        enabled: true,
        dir: path.join(dir, 'k'),
        autoExtract: { enabled: true, everyRounds: 100, maxEntries: 3, minConfidence: 0.8, provider: 'p', model: 'm' },
      },
    }),
  };
  const knowledge = createKnowledgeStore({ settings, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  knowledge.ensure();
  const extractor = createKnowledgeExtractor({
    ctx: null,
    settings,
    knowledge,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    callModel: async () => JSON.stringify({ knowledge: [{ title: '周六开黑', body: '每周六晚八点开黑', confidence: 0.95 }] }),
  });
  const record = {
    scope: 'group',
    peerId: 'g1',
    session: {
      events: [
        { type: 'user/message', message: { content: [{ type: 'text', text: '[阿岚 (U1)] 每周六晚八点开黑' }] } },
        { type: 'assistant/message', message: { content: [{ type: 'text', text: '好的' }] } },
        { type: 'user/message', message: { content: [{ type: 'text', text: '[老周 (U2)] 收到' }] } },
        { type: 'assistant/message', message: { content: [{ type: 'text', text: '嗯' }] } },
      ],
    },
  };
  extractor.noteTurnEnd(record);
  const result = await extractor.extractNow(null, { groupHint: '读书会' });
  assert.equal(result.ok, true);
  assert.equal(result.scannedMessages, 4);
  assert.equal(knowledge.list({}).total, 1);
});
