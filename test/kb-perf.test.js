import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, run, withTx } from '../lib/core/db.js';
import { createKbStore } from '../lib/core/kb/store.js';

/** 插入的 chunk 数量（设计验收线：10k 条）。 */
const CHUNK_COUNT = 10000;
/** 契约目标是 <20ms，测试放宽到 50ms 以抵消并行测试/CI 抖动。 */
const MEDIAN_LIMIT_MS = 50;

function medianMs(fn, runs = 15) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    const end = process.hrtime.bigint();
    samples.push(Number(end - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

test('10k chunks 检索性能：bm25 与 LIKE 回退中位耗时 < 50ms', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-kb-perf-'));
  const db = openDb(path.join(dir, 'perf.db'));
  t.after(() => closeDb(db));

  const now = Date.now();
  run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', 'perf-bot', 'perf', now, now);
  run(db,
    'INSERT INTO kb_docs(bot_id, source, title, hash, created_at, updated_at) VALUES(?,?,?,?,?,?)',
    'perf-bot', 'perf.md', '性能样本', 'perf-hash', now, now);
  const docId = Number(db.prepare('SELECT id FROM kb_docs WHERE source = ?').get('perf.md').id);

  // 10k 条分块：每块含“团队协作/知识检索”高频词 + “模块 N 号”选择性词，模拟真实知识库规模
  withTx(db, () => {
    const insert = db.prepare('INSERT INTO kb_chunks(doc_id, ord, text) VALUES(?, ?, ?)');
    for (let i = 0; i < CHUNK_COUNT; i += 1) {
      const moduleId = i % 100;
      insert.run(docId, i,
        '第' + i + '条：团队协作与知识检索的填充文本，所属模块' + moduleId + '号，用于性能压测。');
    }
  });

  const kb = createKbStore({ db });
  // 预热：让 FTS 索引页进入 OS/SQLite 缓存
  for (let i = 0; i < 3; i += 1) kb.search({ botId: 'perf-bot', query: '模块42' });

  const selective = kb.search({ botId: 'perf-bot', query: '模块42' });
  assert.ok(selective.length > 0, '选择性查询应有命中');
  assert.equal(selective[0].mode, 'fts');

  const ftsMedian = medianMs(() => kb.search({ botId: 'perf-bot', query: '模块42' }));
  const likeMedian = medianMs(() => kb.search({ botId: 'perf-bot', query: '模块' }));
  const frequent = kb.search({ botId: 'perf-bot', query: '团队协作' });
  assert.ok(frequent.length >= 10, '高频词查询应命中多条');

  console.log('[perf] 10k chunks search median: fts=' + ftsMedian.toFixed(2)
    + 'ms, like=' + likeMedian.toFixed(2) + 'ms');

  assert.ok(ftsMedian < MEDIAN_LIMIT_MS,
    'bm25 检索中位耗时应 < ' + MEDIAN_LIMIT_MS + 'ms，实际 ' + ftsMedian.toFixed(2) + 'ms');
  assert.ok(likeMedian < MEDIAN_LIMIT_MS,
    'LIKE 回退中位耗时应 < ' + MEDIAN_LIMIT_MS + 'ms，实际 ' + likeMedian.toFixed(2) + 'ms');
});
