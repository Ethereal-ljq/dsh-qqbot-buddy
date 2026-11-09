import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, run } from '../lib/core/db.js';
import { createKbStore } from '../lib/core/kb/store.js';
import { ingestFile, DEFAULT_MAX_BYTES } from '../lib/core/kb/ingest.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-kb-file-'));
  const db = openDb(path.join(dir, 'test.db'));
  const now = Date.now();
  run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', 'bot-a', 'A', now, now);
  t.after(() => closeDb(db));
  return { db, kb: createKbStore({ db }), dir };
}

test('ingestFile 读取本地 Markdown 并入库，source/title 有缺省值', (t) => {
  const { kb, dir } = setup(t);
  const filePath = path.join(dir, 'faq.md');
  fs.writeFileSync(filePath, '# 退款\n退款需要七个工作日。\n\n# 发票\n发票可在控制台下载。', 'utf8');

  const result = ingestFile(kb, { botId: 'bot-a', filePath });
  assert.equal(result.changed, true);
  assert.equal(result.doc.source, 'faq.md');
  assert.equal(result.doc.title, 'faq');
  assert.equal(result.doc.meta.filePath, filePath);
  assert.ok(result.doc.chunkCount >= 2);

  const hits = kb.search({ botId: 'bot-a', query: '退款需要' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].mode, 'fts');
});

test('同一文件重复 ingest 幂等；改文件后重新 ingest 会替换', (t) => {
  const { kb, dir } = setup(t);
  const filePath = path.join(dir, 'notice.md');
  fs.writeFileSync(filePath, '原始内容：周五下午三点开会。', 'utf8');
  const first = ingestFile(kb, { botId: 'bot-a', filePath, source: 'notice.md' });
  const second = ingestFile(kb, { botId: 'bot-a', filePath, source: 'notice.md' });
  assert.equal(second.changed, false);
  assert.equal(second.docId, first.docId);

  fs.writeFileSync(filePath, '更新内容：会议改到周一上午十点。', 'utf8');
  const third = ingestFile(kb, { botId: 'bot-a', filePath, source: 'notice.md' });
  assert.equal(third.changed, true);
  assert.equal(kb.search({ botId: 'bot-a', query: '会议改到' }).length, 1);
  assert.equal(kb.search({ botId: 'bot-a', query: '周五下午' }).length, 0);
});

test('自定义 source/title/meta 优先生效', (t) => {
  const { kb, dir } = setup(t);
  const filePath = path.join(dir, 'raw.txt');
  fs.writeFileSync(filePath, '自定义来源的内容。', 'utf8');
  const result = ingestFile(kb, {
    botId: 'bot-a',
    filePath,
    source: 'docs/custom-source',
    title: '自定义标题',
    meta: { origin: 'unit-test' },
  });
  assert.equal(result.doc.source, 'docs/custom-source');
  assert.equal(result.doc.title, '自定义标题');
  assert.deepEqual(result.doc.meta, { origin: 'unit-test' });
});

test('ingestFile 参数/文件校验', (t) => {
  const { kb, dir } = setup(t);
  assert.throws(() => ingestFile(null, { botId: 'bot-a', filePath: 'x' }), TypeError);
  assert.throws(() => ingestFile(kb, { filePath: 'x' }), TypeError);
  assert.throws(() => ingestFile(kb, { botId: 'bot-a' }), TypeError);
  const missing = path.join(dir, 'missing.md');
  assert.throws(() => ingestFile(kb, { botId: 'bot-a', filePath: missing }), /ENOENT/);
  const big = path.join(dir, 'big.md');
  fs.writeFileSync(big, 'x'.repeat(100), 'utf8');
  assert.throws(() => ingestFile(kb, { botId: 'bot-a', filePath: big, maxBytes: 10 }), RangeError);
  assert.equal(DEFAULT_MAX_BYTES, 2 * 1024 * 1024);
});
