/**
 * test/console-kb-integration —— 控制台 API 与真实 kb/memory store 的对接测试。
 *
 * 目的：kb-dev 的 store 一旦签名漂移（如 removeDoc 选择器、search 返回字段）能立刻暴露，
 * 不必等到 Lead 在 lib/index.js 装配后才发现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createKbStore } from '../lib/core/kb/store.js';
import { createMemoryStore } from '../lib/core/memory/store.js';
import { createHarness } from './console-helpers.js';

async function setupBot(h, name) {
  await h.loginOk();
  const res = await h.request('POST', '/api/bots', { body: { name } });
  assert.equal(res.status, 200, res.text);
  return res.data;
}

test('真实 kb store：ingest → docs → search → remove 全链路', async (t) => {
  const h = await createHarness({ depsFactory: ({ db }) => ({ kb: createKbStore({ db }) }) });
  t.after(() => h.close());
  const bot = await setupBot(h, '知识库 bot');
  const text = '# 团建通知\n\n本周六下午三点在滨江公园集合，带好外套。\n\n## 费用\n\n团建费用由部门承担，报名截止周五中午。';

  const ingest = await h.request('POST', '/api/kb/ingest', {
    body: { botId: bot.id, source: 'notice.md', title: '团建通知', text },
  });
  assert.equal(ingest.status, 200, ingest.text);
  assert.equal(ingest.data.changed, true);
  assert.ok(ingest.data.chunks >= 1);
  assert.equal(ingest.data.doc.source, 'notice.md');
  const docId = ingest.data.docId;
  assert.ok(docId > 0);

  // 幂等重入：同 source 同内容不重复建文档
  const again = await h.request('POST', '/api/kb/ingest', {
    body: { botId: bot.id, source: 'notice.md', title: '团建通知', text },
  });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.data.changed, false);
  assert.equal(again.data.docId, docId);
  assert.equal(again.data.chunks, ingest.data.chunks);

  const docs = await h.request('GET', '/api/kb/docs?bot=' + bot.id);
  assert.equal(docs.status, 200);
  assert.equal(docs.data.length, 1);
  assert.equal(docs.data[0].id, docId);
  assert.equal(docs.data[0].chunkCount, ingest.data.chunks);

  // DESIGN §2：≥3 字符走 FTS，<3 字符回退 LIKE
  const fts = await h.request('POST', '/api/kb/search', { body: { botId: bot.id, query: '滨江公园' } });
  assert.equal(fts.status, 200, fts.text);
  assert.ok(fts.data.length >= 1);
  assert.equal(fts.data[0].mode, 'fts');
  assert.match(fts.data[0].text, /滨江公园/);

  const like = await h.request('POST', '/api/kb/search', { body: { botId: bot.id, query: '公园' } });
  assert.equal(like.status, 200, like.text);
  assert.ok(like.data.length >= 1);
  assert.equal(like.data[0].mode, 'like');

  const remove = await h.request('DELETE', '/api/kb/docs/' + docId + '?bot=' + bot.id);
  assert.equal(remove.status, 200, remove.text);
  assert.equal(remove.data.removed, true);
  assert.deepEqual((await h.request('GET', '/api/kb/docs?bot=' + bot.id)).data, []);
  const searchAfter = await h.request('POST', '/api/kb/search', { body: { botId: bot.id, query: '滨江公园' } });
  assert.equal(searchAfter.status, 200);
  assert.deepEqual(searchAfter.data, [], '删除后不应再检索到（FTS 同步清理）');
});

test('真实 memory store：save → list → search → remove 全链路', async (t) => {
  const h = await createHarness({ depsFactory: ({ db }) => ({ memory: createMemoryStore({ db }) }) });
  t.after(() => h.close());
  const bot = await setupBot(h, '记忆 bot');

  const saved = await h.request('POST', '/api/memories', {
    body: { botId: bot.id, text: '用户喜欢猫', tags: ['偏好'], source: 'chat' },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.data.text, '用户喜欢猫');
  assert.deepEqual(saved.data.tags, ['偏好']);
  assert.equal(saved.data.created, true);
  const id = saved.data.id;
  assert.ok(id > 0);

  // 近似去重：完全相同的文本命中同一条
  const dup = await h.request('POST', '/api/memories', { body: { botId: bot.id, text: '用户喜欢猫', tags: ['偏好'] } });
  assert.equal(dup.status, 200, dup.text);
  assert.equal(dup.data.id, id);
  assert.equal(dup.data.deduped, true);

  const list = await h.request('GET', '/api/memories?bot=' + bot.id);
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].id, id);
  assert.equal(list.data[0].botId, bot.id);

  const fts = await h.request('POST', '/api/memories/search', { body: { botId: bot.id, query: '喜欢猫' } });
  assert.equal(fts.status, 200, fts.text);
  assert.equal(fts.data[0].mode, 'fts');
  const like = await h.request('POST', '/api/memories/search', { body: { botId: bot.id, query: '猫' } });
  assert.equal(like.status, 200, like.text);
  assert.equal(like.data[0].mode, 'like');

  const removed = await h.request('DELETE', '/api/memories/' + id);
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.data.removed, true);
  assert.deepEqual((await h.request('GET', '/api/memories?bot=' + bot.id)).data, []);
});

test('真实 kb+memory 同时装配：state 与页面数据互不影响', async (t) => {
  const h = await createHarness({
    depsFactory: ({ db }) => ({ kb: createKbStore({ db }), memory: createMemoryStore({ db }) }),
  });
  t.after(() => h.close());
  const bot = await setupBot(h, '综合 bot');

  await h.request('POST', '/api/kb/ingest', { body: { botId: bot.id, source: 'a.md', text: '知识库内容：本周六团建。' } });
  await h.request('POST', '/api/memories', { body: { botId: bot.id, text: '用户喜欢周末团建' } });

  const docs = await h.request('GET', '/api/kb/docs?bot=' + bot.id);
  assert.equal(docs.data.length, 1);
  const memories = await h.request('GET', '/api/memories?bot=' + bot.id);
  assert.equal(memories.data.length, 1);
  const state = await h.request('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.data.bots.length, 1);
});
