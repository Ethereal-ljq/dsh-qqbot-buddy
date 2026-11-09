import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, get, run } from '../lib/core/db.js';
import { createKbStore, FTS_MIN_CHARS, MODE_FTS, MODE_LIKE } from '../lib/core/kb/store.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-kb-'));
  const db = openDb(path.join(dir, 'test.db'));
  const now = Date.now();
  for (const id of ['bot-a', 'bot-b']) {
    run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', id, id, now, now);
  }
  t.after(() => closeDb(db));
  return { db, kb: createKbStore({ db }) };
}

test('ingest 新建文档：返回 doc/chunks/changed，source 幂等', (t) => {
  const { kb } = setup(t);
  const text = '# 退款\n退款需要七天。\n\n# 发货\n发货需要三天。';
  const first = kb.ingest({ botId: 'bot-a', source: 'faq.md', title: '常见问题', text });
  assert.equal(first.changed, true);
  assert.ok(first.docId > 0);
  assert.equal(first.chunks, 2);
  assert.equal(first.doc.id, first.docId);
  assert.equal(first.doc.source, 'faq.md');
  assert.equal(first.doc.title, '常见问题');
  assert.equal(first.doc.chunkCount, 2);

  const again = kb.ingest({ botId: 'bot-a', source: 'faq.md', title: '常见问题', text });
  assert.equal(again.changed, false, '相同 source + 相同内容必须幂等');
  assert.equal(again.docId, first.docId);
  assert.equal(again.chunks, 2);
  assert.equal(kb.listDocs({ botId: 'bot-a' }).length, 1);
});

test('内容变更时事务内替换 chunks，FTS 同步更新', (t) => {
  const { kb } = setup(t);
  kb.ingest({ botId: 'bot-a', source: 'policy.md', text: '退款需要七个工作日。' });
  const changed = kb.ingest({ botId: 'bot-a', source: 'policy.md', text: '换货需要十五个工作日。' });
  assert.equal(changed.changed, true);
  assert.equal(changed.chunks, 1);
  assert.equal(kb.search({ botId: 'bot-a', query: '退款' }).length, 0, '旧 chunks 的 FTS 命中必须消失');
  assert.equal(kb.search({ botId: 'bot-a', query: '换货需要' }).length, 1, '新 chunks 应可检索');
  assert.equal(kb.listDocs({ botId: 'bot-a' })[0].chunkCount, 1);
});

test('search 契约：<3 字符回退 LIKE(mode:like)，>=3 字符走 bm25(mode:fts)', (t) => {
  assert.equal(FTS_MIN_CHARS, 3);
  const { kb } = setup(t);
  kb.ingest({ botId: 'bot-a', source: 'notice.md', title: '团建通知', text: '本周六下午三点在滨江公园集合。团建费用由部门承担。' });

  const twoChar = kb.search({ botId: 'bot-a', query: '公园' });
  assert.equal(twoChar.length, 1);
  assert.equal(twoChar[0].mode, MODE_LIKE);
  assert.equal(twoChar[0].title, '团建通知');
  assert.ok(twoChar[0].score > 0 && twoChar[0].score <= 1);
  assert.equal(typeof twoChar[0].snippet, 'string');
  assert.match(twoChar[0].snippet, /公园/);

  const oneChar = kb.search({ botId: 'bot-a', query: '园' });
  assert.equal(oneChar[0].mode, MODE_LIKE, '1 字符也必须回退 LIKE');

  const threeChar = kb.search({ botId: 'bot-a', query: '滨江公' });
  assert.equal(threeChar.length, 1);
  assert.equal(threeChar[0].mode, MODE_FTS);
  assert.equal(threeChar[0].docId, twoChar[0].docId);
  // score 统一归一化到 [0,1]：单条命中给 1；rawRank 保留原始 -bm25 便于调试
  assert.ok(threeChar[0].score >= 0 && threeChar[0].score <= 1);
  assert.equal(threeChar[0].score, 1);
  assert.ok(Number.isFinite(threeChar[0].rawRank) && threeChar[0].rawRank >= 0);
  assert.equal(threeChar[0].titleHit, false);
  assert.ok(typeof threeChar[0].chunkId === 'number');
  assert.match(threeChar[0].snippet, /滨江公园/);
});

test('英文查询同样遵守 3 字符规则', (t) => {
  const { kb } = setup(t);
  kb.ingest({ botId: 'bot-a', source: 'en.md', text: 'The quarterly budget meeting is scheduled on Friday afternoon.' });
  const fts = kb.search({ botId: 'bot-a', query: 'budget' });
  assert.equal(fts.length, 1);
  assert.equal(fts[0].mode, MODE_FTS);
  const like = kb.search({ botId: 'bot-a', query: 'bu' });
  assert.equal(like.length, 1);
  assert.equal(like[0].mode, MODE_LIKE);
});

test('bot 隔离：检索与文档列表互不串数据', (t) => {
  const { kb } = setup(t);
  kb.ingest({ botId: 'bot-a', source: 'shared.md', text: '苹果是红色的水果。' });
  kb.ingest({ botId: 'bot-b', source: 'shared.md', text: '香蕉是黄色的水果。' });
  assert.equal(kb.search({ botId: 'bot-a', query: '苹果是' }).length, 1);
  assert.equal(kb.search({ botId: 'bot-b', query: '苹果是' }).length, 0);
  assert.equal(kb.search({ botId: 'bot-b', query: '香蕉是' }).length, 1);
  // LIKE 回退也隔离
  assert.equal(kb.search({ botId: 'bot-a', query: '苹果' }).length, 1);
  assert.equal(kb.search({ botId: 'bot-b', query: '苹果' }).length, 0);
  // 同一 source 两个 bot 各自一份 doc
  const docA = kb.listDocs({ botId: 'bot-a' });
  const docB = kb.listDocs({ botId: 'bot-b' });
  assert.equal(docA.length, 1);
  assert.equal(docB.length, 1);
  assert.notEqual(docA[0].id, docB[0].id);
});

test('search limit 生效，结果字段完整', (t) => {
  const { kb } = setup(t);
  const text = '# 甲\n性能测试甲。\n# 乙\n性能测试乙。\n# 丙\n性能测试丙。';
  kb.ingest({ botId: 'bot-a', source: 'multi.md', text });
  const hits = kb.search({ botId: 'bot-a', query: '性能测试', limit: 2 });
  assert.equal(hits.length, 2);
  for (const hit of hits) {
    assert.deepEqual(
      Object.keys(hit).sort(),
      ['chunkId', 'docId', 'mode', 'rawRank', 'score', 'snippet', 'text', 'title', 'titleHit'].sort(),
    );
    assert.ok(hit.score >= 0 && hit.score <= 1, 'score 必须归一化到 [0,1]');
    // 结果集内最大 score=1；min-max 有跨度时最小为 0，全等时统一 1
    const scores = hits.map((row) => row.score);
    assert.equal(Math.max(...scores), 1);
    assert.ok(Math.min(...scores) === 0 || new Set(scores).size === 1);
  }
});

test('removeDoc 删除文档 + chunks，FTS 影子行同步清理', (t) => {
  const { db, kb } = setup(t);
  const { docId } = kb.ingest({ botId: 'bot-a', source: 'temp.md', text: '临时知识：周报模板在共享盘。' });
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM kb_chunks_fts').count, 1);

  const removed = kb.removeDoc({ id: docId, botId: 'bot-a' });
  assert.equal(removed.removed, true);
  assert.equal(removed.docId, docId);
  assert.equal(removed.chunks, 1);
  assert.equal(kb.search({ botId: 'bot-a', query: '周报模板' }).length, 0);
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM kb_chunks_fts').count, 0, 'FTS 影子行必须清理');
  assert.equal(get(db, 'SELECT COUNT(*) AS count FROM kb_chunks').count, 0);
  // 重复删除返回 removed:false
  assert.equal(kb.removeDoc({ id: docId, botId: 'bot-a' }).removed, false);
  // 按 source 删
  kb.ingest({ botId: 'bot-a', source: 'by-source.md', text: '另一份临时文档内容。' });
  assert.equal(kb.removeDoc({ botId: 'bot-a', source: 'by-source.md' }).removed, true);
  assert.equal(kb.listDocs({ botId: 'bot-a' }).length, 0);
});

test('meta / title 归一化与 getDoc', (t) => {
  const { kb } = setup(t);
  const result = kb.ingest({
    botId: 'bot-a',
    source: 'no-title.md',
    text: '正文内容。',
    meta: { url: 'https://example.com/doc', author: 'kb-dev' },
  });
  assert.equal(result.doc.title, 'no-title.md', '缺省 title 用 source');
  const listed = kb.listDocs({ botId: 'bot-a' })[0];
  assert.deepEqual(listed.meta, { url: 'https://example.com/doc', author: 'kb-dev' });
  const byId = kb.getDoc({ botId: 'bot-a', docId: result.docId });
  assert.equal(byId.source, 'no-title.md');
  assert.equal(kb.getDoc({ botId: 'bot-a', source: 'no-title.md' }).id, result.docId);
  assert.equal(kb.getDoc({ botId: 'bot-a' }), null);
});

test('空文本文档可入库但没有 chunks 与检索命中', (t) => {
  const { kb } = setup(t);
  const result = kb.ingest({ botId: 'bot-a', source: 'empty.md', text: '' });
  assert.equal(result.chunks, 0);
  assert.equal(result.changed, true);
  assert.equal(kb.listDocs({ botId: 'bot-a' })[0].chunkCount, 0);
  assert.equal(kb.search({ botId: 'bot-a', query: '空' }).length, 0);
});

test('默认分块参数：2000 字正文得到 3 块（800/80）', (t) => {
  const { kb } = setup(t);
  const text = '知'.repeat(2000);
  const result = kb.ingest({ botId: 'bot-a', source: 'long.md', text });
  assert.equal(result.chunks, 3);
  assert.equal(result.doc.chunkCount, 3);
});

test('参数校验：botId 必填，空 query 返回 []', (t) => {
  const { kb } = setup(t);
  assert.throws(() => kb.ingest({ source: 'a.md', text: 'x' }), TypeError);
  assert.throws(() => kb.search({ query: 'abc' }), TypeError);
  assert.deepEqual(kb.search({ botId: 'bot-a', query: '   ' }), []);
  assert.throws(() => createKbStore({}), TypeError);
});

test('source 缺省时由 title / 内容 hash 派生，匿名 ingest 仍幂等', (t) => {
  const { kb } = setup(t);
  const first = kb.ingest({ botId: 'bot-a', text: '匿名粘贴的内容。' });
  assert.equal(first.changed, true);
  assert.match(first.doc.source, /^inline:/);
  const second = kb.ingest({ botId: 'bot-a', text: '匿名粘贴的内容。' });
  assert.equal(second.changed, false, '同样内容重复提交必须幂等');
  assert.equal(second.docId, first.docId);

  const titled = kb.ingest({ botId: 'bot-a', title: '显式标题', text: '匿名粘贴的内容。' });
  assert.equal(titled.changed, true);
  assert.equal(titled.doc.source, '显式标题');
  assert.equal(titled.doc.title, '显式标题');
});

test('LIKE 回退时通配符按字面匹配（% 与 _ 被转义）', (t) => {
  const { kb } = setup(t);
  kb.ingest({ botId: 'bot-a', source: 'pct.md', text: '折扣 100% 的活动说明。' });
  kb.ingest({ botId: 'bot-a', source: 'plain.md', text: '折扣 1000 的活动说明。' });
  const percent = kb.search({ botId: 'bot-a', query: '%' });
  assert.equal(percent.length, 1);
  assert.equal(percent[0].mode, MODE_LIKE);
  assert.match(percent[0].text, /100%/);

  kb.ingest({ botId: 'bot-a', source: 'under.md', text: '文件名 a_b 的说明。' });
  kb.ingest({ botId: 'bot-a', source: 'under2.md', text: '文件名 axb 的说明。' });
  const underscore = kb.search({ botId: 'bot-a', query: '_' });
  assert.equal(underscore.length, 1);
  assert.match(underscore[0].text, /a_b/);
});
