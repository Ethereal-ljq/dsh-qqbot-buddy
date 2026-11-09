import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, schemaVersion, withTx, all, get, run, metaGet, metaSet, closeDb } from '../lib/core/db.js';

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-v2-'));
  return path.join(dir, name || 'test.db');
}

test('迁移建表并记录 schema 版本', () => {
  const db = openDb(tmpFile());
  assert.ok(schemaVersion(db) >= 1);
  const tables = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  for (const name of ['bots', 'profiles', 'bindings', 'sessions', 'settings', 'memories', 'kb_docs', 'kb_chunks']) {
    assert.ok(tables.includes(name), '缺少表 ' + name);
  }
  closeDb(db);
});

test('meta 读写往返', () => {
  const db = openDb(tmpFile());
  metaSet(db, 'hello', { a: 1 });
  assert.deepEqual(metaGet(db, 'hello'), { a: 1 });
  assert.equal(metaGet(db, 'missing', 'fallback'), 'fallback');
  closeDb(db);
});

test('知识库 FTS5 trigram 中文子串检索命中', () => {
  const db = openDb(tmpFile());
  const now = Date.now();
  withTx(db, () => {
    run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?, ?, ?, ?)', 'b1', '测试', now, now);
    run(db, "INSERT INTO kb_docs(bot_id, source, title, hash, created_at, updated_at) VALUES('b1','doc1','团建通知','h1',?,?)", now, now);
    const docId = get(db, 'SELECT id FROM kb_docs WHERE source = ?', 'doc1').id;
    run(db, 'INSERT INTO kb_chunks(doc_id, ord, text) VALUES(?,?,?)', docId, 0, '本周六下午三点在滨江公园集合，带好外套。');
    run(db, 'INSERT INTO kb_chunks(doc_id, ord, text) VALUES(?,?,?)', docId, 1, '团建费用由部门承担，报名截止周五中午。');
  });
  const hits = all(db, "SELECT rowid, bm25(kb_chunks_fts) AS rank FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ? ORDER BY rank LIMIT 5", '"滨江公园"');
  assert.ok(hits.length >= 1, '中文子串应命中');
  // 更新后 FTS 同步
  withTx(db, () => {
    run(db, "UPDATE kb_chunks SET text = '改到周日下午' WHERE id = (SELECT MIN(id) FROM kb_chunks)");
  });
  const oldHit = all(db, "SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?", '"滨江公园"');
  const newHit = all(db, "SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?", '"周日下午"');
  assert.equal(oldHit.length, 0);
  assert.ok(newHit.length >= 1);
  closeDb(db);
});

test('记忆表 FTS 与 bot 隔离', () => {
  const db = openDb(tmpFile());
  const now = Date.now();
  withTx(db, () => {
    run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', 'b1', 'A', now, now);
    run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', 'b2', 'B', now, now);
    run(db, 'INSERT INTO memories(bot_id, peer, text, created_at, updated_at) VALUES(?,?,?,?,?)', 'b1', 'group:1', '用户喜欢猫', now, now);
    run(db, 'INSERT INTO memories(bot_id, peer, text, created_at, updated_at) VALUES(?,?,?,?,?)', 'b2', 'group:1', '用户喜欢狗', now, now);
  });
  // 注意：trigram 分词器最小 3 字符，2 字中文查询由检索层回退 LIKE（见 kb/store.js 契约）
  const rows = all(db, `SELECT m.id, m.text FROM memories_fts f JOIN memories m ON m.id = f.rowid
    WHERE memories_fts MATCH ? AND m.bot_id = ?`, '"喜欢猫"', 'b1');
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /猫/);
  closeDb(db);
});

test('事务出错回滚', () => {
  const db = openDb(tmpFile());
  const now = Date.now();
  run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', 'b1', 'A', now, now);
  assert.throws(() => withTx(db, () => {
    run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', 'b2', 'B', now, now);
    throw new Error('boom');
  }), /boom/);
  assert.equal(all(db, 'SELECT id FROM bots').length, 1);
  closeDb(db);
});
