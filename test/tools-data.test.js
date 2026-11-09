/**
 * tools-data —— memory_* / knowledge_* / member_* 工具：v2 store 适配与降级。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataTools } from '../lib/tools/data-tools.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const manager = { findByAgent: () => ({ peer: 'c2c:U1' }) };

function byName(defs, name) {
  const def = defs.find((item) => item.name === name);
  assert.ok(def, '缺少工具: ' + name);
  return def;
}

test('数据工具：store 未装配时全部降级（返回空数组）', () => {
  assert.deepEqual(createDataTools({ botId: 'bot-1', manager, logger: silentLogger }), []);
  assert.deepEqual(createDataTools({ memory: {}, kb: {}, members: {}, botId: 'bot-1', manager, logger: silentLogger }), []);
});

test('memory_*：按 botId/peer 读写 v2 memory store', async () => {
  const saved = [];
  const memory = {
    save(input) { saved.push(input); return { id: 7, created: true, deduped: false }; },
    search({ botId, query, limit }) {
      assert.equal(botId, 'bot-1');
      assert.equal(query, '蓝色');
      assert.equal(limit, 6);
      return [{ id: 7, text: '用户喜欢蓝色', kind: 'preference', score: 1.2 }];
    },
    list() { return [{ id: 7, text: '用户喜欢蓝色', kind: 'preference' }]; },
    get() { return { id: 7, text: '用户喜欢蓝色', kind: 'preference' }; },
  };
  const defs = createDataTools({ memory, botId: 'bot-1', manager, logger: silentLogger });
  const save = byName(defs, 'memory_save');
  const value = await save.execute({ content: '用户喜欢蓝色', kind: 'preference', tags: ['偏好'] }, { agent: {} });
  assert.equal(value.ok, true);
  assert.equal(value.created, true);
  assert.deepEqual(saved[0], { botId: 'bot-1', peer: 'c2c:U1', kind: 'preference', text: '用户喜欢蓝色', tags: ['偏好'], source: 'tool' });

  const search = byName(defs, 'memory_search');
  const found = await search.execute({ query: '蓝色' }, {});
  assert.deepEqual(found.results, [{ id: 7, text: '用户喜欢蓝色', kind: 'preference', score: 1.2 }]);
  await assert.rejects(() => search.execute({ query: '  ' }, {}), /query 不能为空/);

  const list = byName(defs, 'memory_list');
  assert.equal((await list.execute({}, {})).results.length, 1);
  const read = byName(defs, 'memory_read');
  assert.equal((await read.execute({ id: 7 }, {})).found, true);
});

test('knowledge_*：knowledge_save 幂等入库 / knowledge_search / knowledge_read', async () => {
  const ingested = [];
  const kb = {
    ingest(input) { ingested.push(input); return { docId: 3, chunks: 2, changed: true }; },
    search({ botId, query }) {
      assert.equal(botId, 'bot-1');
      return [{ title: '群规', text: '禁止刷屏', score: 0.9, mode: 'fts' }];
    },
    getDoc() { return { title: '群规', chunkCount: 2 }; },
  };
  const defs = createDataTools({ kb, botId: 'bot-1', manager, logger: silentLogger });
  const saved = await byName(defs, 'knowledge_save').execute({ title: '群规', content: '禁止刷屏' }, {});
  assert.equal(saved.docId, 3);
  assert.deepEqual(ingested[0], { botId: 'bot-1', source: 'tool:群规', title: '群规', text: '禁止刷屏' });
  await assert.rejects(() => byName(defs, 'knowledge_save').execute({ title: '', content: 'x' }, {}), /title\/content/);
  const found = await byName(defs, 'knowledge_search').execute({ query: '刷屏' }, {});
  assert.equal(found.results[0].title, '群规');
  const doc = await byName(defs, 'knowledge_read').execute({ id: 3 }, {});
  assert.deepEqual(doc, { found: true, title: '群规', chunks: 2 });
});

test('knowledge_search：多关键词拆开分别搜 + 无参列文档标题', async () => {
  const docs = [{ id: 2, title: '炉石传说：常见主播、梗与天梯术语', chunkCount: 4 }];
  const kb = {
    search({ query }) {
      if (query === '神棍老师 戴佳伟') return [];
      if (query === '神棍老师' || query === '戴佳伟') {
        return [{ title: '炉石传说：常见主播、梗与天梯术语', text: '主播 - **神棍老师**：… - **戴佳伟**：…', score: 0.9, mode: 'fts' }];
      }
      return [];
    },
    ingest() { return { docId: 1, chunks: 1, changed: true }; },
    listDocs() { return docs; },
    count() { return 295; },
  };
  const defs = createDataTools({ kb, botId: 'bot-1', manager, logger: silentLogger });
  const search = byName(defs, 'knowledge_search');
  const miss = await search.execute({ query: '神棍老师 戴佳伟' }, {});
  assert.equal(miss.results.length, 1, '整串零命中应回退到逐词搜索');
  assert.match(miss.results[0].text, /神棍老师/);
  assert.deepEqual(search.output.schema.required, undefined, 'list 模式返回 docs，schema 不能强制 required results');
  assert.ok(search.output.schema.properties.docs, 'schema 必须声明 docs');
  const list = await search.execute({}, {});
  assert.equal(list.docs.length, 1);
  assert.equal(list.docs[0].title, '炉石传说：常见主播、梗与天梯术语');
  assert.equal(list.total, 295, '列名单要带总篇数，避免"5 篇"误导');
});

test('member_*：lookup 按 openid/昵称，note 合并写入 members store', async () => {
  const upserts = [];
  const members = {
    get({ botId, openid }) {
      assert.equal(botId, 'bot-1');
      return openid === 'U1' ? { openid: 'U1', nickname: '阿岚', note: '老朋友' } : null;
    },
    list({ query }) { return query === '阿' || query === '' ? [{ openid: 'U1', nickname: '阿岚', note: '' }] : []; },
    count() { return 1; },
    upsert(input) { upserts.push(input); return { created: true }; },
  };
  const defs = createDataTools({ members, botId: 'bot-1', manager, logger: silentLogger });
  const lookup = byName(defs, 'member_lookup');
  const one = await lookup.execute({ openid: 'U1' }, {});
  assert.deepEqual(one.results, [{ openid: 'U1', nickname: '阿岚', note: '老朋友', tags: [] }]);
  const byNick = await lookup.execute({ nickname: '阿' }, {});
  assert.equal(byNick.results.length, 1);
  // 不传参 = 列出群友库名单（模型问"群友库里有哪些人"时用）
  const roster = await lookup.execute({}, {});
  assert.ok(Array.isArray(roster.results) && roster.results.length >= 1);
  assert.equal(roster.total, 1);
  const note = await byName(defs, 'member_note').execute({ openid: 'U1', note: '喜欢猫' }, {});
  assert.equal(note.created, true);
  assert.deepEqual(upserts[0], { botId: 'bot-1', openid: 'U1', note: '喜欢猫' });
  await assert.rejects(() => byName(defs, 'member_note').execute({}, {}), /openid 不能为空/);
});
