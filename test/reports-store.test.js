/**
 * reports-store —— 日报存储（daily_reports）的写入/查询/幂等。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDb, migrate, openDb, schemaVersion } from '../lib/core/db.js';
import { createReportStore } from '../lib/core/reports/store.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-reports-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  t.after(() => closeDb(db));
  return { db, store: createReportStore({ db }) };
}

test('迁移：daily_reports 表已建立（schema 含 v10）', (t) => {
  const { db } = setup(t);
  assert.ok(schemaVersion(db) >= 10);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_reports'").get());
});

test('写入/读取：同一天重复 save 是覆盖更新', (t) => {
  const { store } = setup(t);
  const first = store.save({
    botId: 'b1', peer: 'group:G1', day: '2026-11-13', status: 'done',
    payload: { version: 1, report: { title: '第一版' } }, text: '旧', messageCount: 10, speakerCount: 3,
  });
  assert.equal(first.status, 'done');
  assert.equal(first.payload.report.title, '第一版');
  const again = store.save({
    botId: 'b1', peer: 'group:G1', day: '2026-11-13', status: 'done',
    payload: { version: 1, report: { title: '第二版' } }, text: '新', messageCount: 12, speakerCount: 4,
  });
  assert.equal(again.payload.report.title, '第二版');
  assert.equal(again.messageCount, 12);
  assert.equal(store.list({ botId: 'b1' }).length, 1);
});

test('卡片图路径：save 可写入，setImage 可更新', (t) => {
  const { store } = setup(t);
  store.save({ botId: 'b1', peer: 'group:G1', day: '2026-11-13', payload: {}, text: 't', imagePath: '/tmp/a.jpg' });
  assert.equal(store.get({ botId: 'b1', peer: 'group:G1', day: '2026-11-13' }).imagePath, '/tmp/a.jpg');
  store.setImage({ botId: 'b1', peer: 'group:G1', day: '2026-11-13', imagePath: '/tmp/b.jpg' });
  assert.equal(store.get({ botId: 'b1', peer: 'group:G1', day: '2026-11-13' }).imagePath, '/tmp/b.jpg');
});

test('标记投递 + latest + 列表按日期倒序', (t) => {
  const { store } = setup(t);
  store.save({ botId: 'b1', peer: 'group:G1', day: '2026-11-12', payload: {}, text: 'a' });
  store.save({ botId: 'b1', peer: 'group:G1', day: '2026-11-13', payload: {}, text: 'b' });
  store.markDelivered({ botId: 'b1', peer: 'group:G1', day: '2026-11-13', delivered: true });
  const latest = store.latest({ botId: 'b1', peer: 'group:G1' });
  assert.equal(latest.day, '2026-11-13');
  assert.equal(latest.delivered, true);
  const items = store.list({ botId: 'b1', peer: 'group:G1' });
  assert.deepEqual(items.map((item) => item.day), ['2026-11-13', '2026-11-12']);
});
