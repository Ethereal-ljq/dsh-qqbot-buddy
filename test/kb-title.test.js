import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDb, closeDb, all, get, run, schemaVersion } from '../lib/core/db.js';
import { MIGRATIONS } from '../lib/core/migrations.js';
import { createKbStore } from '../lib/core/kb/store.js';
import { normalizeRelevance } from '../lib/core/kb/text-search.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-kb-title-'));
  const db = openDb(path.join(dir, 'test.db'));
  const now = Date.now();
  for (const id of ['bot-a', 'bot-b']) {
    run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', id, id, now, now);
  }
  t.after(() => closeDb(db));
  return { db, kb: createKbStore({ db }), dir };
}

test('迁移 v4：kb_chunks 增加 title 列，FTS 重建为多列 (title,text)，三个触发器齐全', (t) => {
  const { db } = setup(t);
  assert.equal(schemaVersion(db), 6);
  const columns = all(db, 'PRAGMA table_info(kb_chunks)').map((row) => row.name);
  assert.ok(columns.includes('title'), 'kb_chunks 应有 title 列');
  const ddl = get(db, "SELECT sql FROM sqlite_master WHERE name = 'kb_chunks_fts'").sql;
  assert.match(ddl, /title/);
  assert.match(ddl, /text/);
  assert.match(ddl, /content='kb_chunks'/);
  assert.match(ddl, /tokenize='trigram'/);
  const triggers = all(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'kb_chunks%'")
    .map((row) => row.name).sort();
  assert.deepEqual(triggers, ['kb_chunks_ad', 'kb_chunks_ai', 'kb_chunks_au']);
});

test('标题词检索：标题命中并排在正文命中之前（bm25 title 权重）', (t) => {
  const { kb } = setup(t);
  kb.ingest({ botId: 'bot-a', source: 'refund.md', title: '退款政策', text: '人工审核后三个工作日到账。' });
  kb.ingest({ botId: 'bot-a', source: 'faq.md', title: '常见问题', text: '退款政策说明：人工审核通过后原路退回。' });

  const hits = kb.search({ botId: 'bot-a', query: '退款政策' });
  assert.ok(hits.length >= 2, '标题与正文命中都应返回');
  assert.equal(hits[0].title, '退款政策');
  assert.equal(hits[0].titleHit, true);
  assert.equal(hits[0].mode, 'fts');
  assert.equal(hits[0].score, 1);
  assert.ok(hits[0].rawRank > 0);
  assert.equal(hits[0].snippet, '【标题】退款政策', '标题单独命中时 snippet 用标题并标注来源');

  const bodyHit = hits.find((hit) => hit.titleHit === false);
  assert.ok(bodyHit, '正文命中不应被标题命中挤掉');
  assert.ok(hits[0].score > bodyHit.score, '标题命中应排在正文命中之前');
  assert.match(bodyHit.snippet, /退款政策/);

  // 正文词仍能检索
  const body = kb.search({ botId: 'bot-a', query: '人工审核' });
  assert.ok(body.length >= 2);
  for (const hit of body) assert.equal(hit.titleHit, false);
});

test('<3 字标题词回退 LIKE，同时匹配 title/text 且标题命中排前', (t) => {
  const { kb } = setup(t);
  kb.ingest({ botId: 'bot-a', source: 'refund.md', title: '退款政策', text: '人工审核后三个工作日到账。' });
  kb.ingest({ botId: 'bot-a', source: 'faq.md', title: '常见问题', text: '比如退款怎么操作。' });

  const hits = kb.search({ botId: 'bot-a', query: '退款' }); // 2 字必须走 LIKE
  assert.ok(hits.length >= 2);
  for (const hit of hits) assert.equal(hit.mode, 'like');
  assert.equal(hits[0].titleHit, true);
  assert.equal(hits[0].title, '退款政策');
  assert.equal(hits[0].snippet, '【标题】退款政策');
  assert.equal(hits[0].score, 1);
  for (let i = 1; i < hits.length; i += 1) {
    assert.ok(hits[i - 1].score >= hits[i].score, 'LIKE 结果应按 score 倒序');
    assert.ok(hits[i].score >= 0 && hits[i].score <= 1);
  }

  const single = kb.search({ botId: 'bot-a', query: '款' }); // 1 字
  assert.ok(single.length >= 1);
  assert.equal(single[0].mode, 'like');
  assert.ok(single.some((hit) => hit.titleHit));
});

test('正文命中时 snippet 取正文，不误用标题', (t) => {
  const { kb } = setup(t);
  kb.ingest({ botId: 'bot-a', source: 'refund.md', title: '退款政策', text: '人工审核后三个工作日到账。' });
  const hits = kb.search({ botId: 'bot-a', query: '人工审核' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].titleHit, false);
  assert.doesNotMatch(hits[0].snippet, /^【标题】/);
  assert.match(hits[0].snippet, /人工审核/);
});

test('ingest 更新标题后旧标题词不再命中，新标题可检索', (t) => {
  const { kb } = setup(t);
  const first = kb.ingest({ botId: 'bot-a', source: 'policy.md', title: '退款政策', text: '正文固定内容。' });
  assert.equal(kb.search({ botId: 'bot-a', query: '退款政策' }).length, 1);

  const updated = kb.ingest({ botId: 'bot-a', source: 'policy.md', title: '换货政策', text: '正文固定内容。' });
  assert.equal(updated.changed, true);
  assert.equal(updated.docId, first.docId);
  assert.equal(kb.search({ botId: 'bot-a', query: '退款政策' }).length, 0, '旧标题词应从 FTS 移除');
  const hits = kb.search({ botId: 'bot-a', query: '换货政策' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].titleHit, true);
  assert.equal(hits[0].snippet, '【标题】换货政策');
  // 同 source + 同标题 + 同内容仍幂等
  assert.equal(
    kb.ingest({ botId: 'bot-a', source: 'policy.md', title: '换货政策', text: '正文固定内容。' }).changed,
    false,
  );
});

test('存量 v1 库升级到 v4：回填 title + rebuild 后标题词可检索且数据不丢', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-kb-upgrade-'));
  const file = path.join(dir, 'legacy.db');

  // 1) 只用迁移 v1 的 SQL 造一个 v1 老库（kb_chunks 无 title 列、单列 FTS、旧触发器）
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec(MIGRATIONS.find((migration) => migration.version === 1).sql);
  raw.exec('PRAGMA user_version = 1');
  const now = Date.now();
  raw.prepare('INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)').run('bot-a', 'A', now, now);
  raw.prepare('INSERT INTO kb_docs(bot_id, source, title, hash, created_at, updated_at) VALUES(?,?,?,?,?,?)')
    .run('bot-a', 'refund.md', '退款政策', 'legacy-hash', now, now);
  const docId = raw.prepare('SELECT id FROM kb_docs').get().id;
  raw.prepare('INSERT INTO kb_chunks(doc_id, ord, text) VALUES(?,?,?)').run(docId, 0, '人工审核后三个工作日到账。');
  raw.prepare('INSERT INTO kb_chunks(doc_id, ord, text) VALUES(?,?,?)').run(docId, 1, '换货请先联系客服。');
  raw.close();

  // 2) openDb 依次升级 v2/v3/v4
  const db = openDb(file);
  t.after(() => closeDb(db));
  assert.equal(schemaVersion(db), 6);

  // 3) title 已从 kb_docs.title 回填，FTS 索引行数 = chunks 行数（rebuild 成功）
  assert.deepEqual(
    all(db, 'SELECT title FROM kb_chunks ORDER BY id').map((row) => row.title),
    ['退款政策', '退款政策'],
  );
  assert.equal(
    get(db, 'SELECT COUNT(*) AS c FROM kb_chunks_fts').c,
    get(db, 'SELECT COUNT(*) AS c FROM kb_chunks').c,
  );

  // 4) 升级后标题词、正文词、<3 字标题词都能检索
  const kb = createKbStore({ db });
  const titleHits = kb.search({ botId: 'bot-a', query: '退款政策' });
  assert.ok(titleHits.length >= 1, '升级后存量标题词应可检索');
  assert.equal(titleHits[0].titleHit, true);
  assert.equal(titleHits[0].snippet, '【标题】退款政策');
  const bodyHits = kb.search({ botId: 'bot-a', query: '人工审核' });
  assert.equal(bodyHits.length, 1);
  assert.equal(bodyHits[0].titleHit, false);
  assert.ok(kb.search({ botId: 'bot-a', query: '退款' }).some((hit) => hit.titleHit));

  // 5) 升级后触发器仍正常：新 ingest / 删除都能同步 FTS
  kb.ingest({ botId: 'bot-a', source: 'new.md', title: '发票政策', text: '发票在控制台下载。' });
  const newHits = kb.search({ botId: 'bot-a', query: '发票政策' });
  assert.equal(newHits.length, 1);
  assert.equal(newHits[0].titleHit, true);
  assert.equal(
    get(db, 'SELECT COUNT(*) AS c FROM kb_chunks_fts').c,
    get(db, 'SELECT COUNT(*) AS c FROM kb_chunks').c,
  );
  kb.removeDoc({ botId: 'bot-a', source: 'new.md' });
  assert.equal(kb.search({ botId: 'bot-a', query: '发票政策' }).length, 0);
  assert.equal(
    get(db, 'SELECT COUNT(*) AS c FROM kb_chunks_fts').c,
    get(db, 'SELECT COUNT(*) AS c FROM kb_chunks').c,
  );
});

test('标题检索按 bot 隔离', (t) => {
  const { kb } = setup(t);
  kb.ingest({ botId: 'bot-a', source: 'refund.md', title: '退款政策', text: 'A bot 的正文。' });
  kb.ingest({ botId: 'bot-b', source: 'refund.md', title: '退款政策', text: 'B bot 的正文。' });
  const hits = kb.search({ botId: 'bot-a', query: '退款政策' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].docId, kb.listDocs({ botId: 'bot-a' })[0].id);
  assert.equal(kb.search({ botId: 'bot-b', query: '退款政策' })[0].docId, kb.listDocs({ botId: 'bot-b' })[0].id);
});

test('normalizeRelevance：min-max 归一到 [0,1]，单条/全等给 1', () => {
  assert.deepEqual(
    normalizeRelevance([{ rawRank: 5 }, { rawRank: 3 }, { rawRank: 1 }]).map((item) => item.score),
    [1, 0.5, 0],
  );
  assert.deepEqual(normalizeRelevance([{ rawRank: 2.5 }]).map((item) => item.score), [1]);
  assert.deepEqual(
    normalizeRelevance([{ rawRank: 3 }, { rawRank: 3 }]).map((item) => item.score),
    [1, 1],
  );
  assert.deepEqual(normalizeRelevance([]), []);
  // 保留原有字段（rawRank / 自定义字段）
  const normalized = normalizeRelevance([{ rawRank: 1, mode: 'fts', extra: 'x' }]);
  assert.equal(normalized[0].mode, 'fts');
  assert.equal(normalized[0].extra, 'x');
  assert.equal(normalized[0].rawRank, 1);
});
