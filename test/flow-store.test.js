/**
 * flow-store —— 全量群消息流水（L0-flow）的写入/查询/清理。
 *
 * 与 messages 的区别是「粒度」：这里记群里每条消息，含没触发回复的旁观发言。
 * 测试重点：
 *   - (bot_id, peer, message_id) 幂等；空 messageId 不去重；
 *   - 时间窗口查询（分析/日报按天取数）；
 *   - 保留期清理不误删新数据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDb, migrate, openDb, schemaVersion } from '../lib/core/db.js';
import { DEFAULT_RETAIN_DAYS, MAX_CONTENT_CHARS, createFlowStore } from '../lib/core/messages/flow.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-flow-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  t.after(() => closeDb(db));
  return { db, store: createFlowStore({ db }) };
}

const row = (over = {}) => ({
  botId: 'bot-a',
  peer: 'group:G1',
  messageId: 'm1',
  senderId: 'S1',
  senderName: '朝咱',
  msgType: 0,
  content: '这泡馍店也太会做生意了',
  createdAt: 1_700_000_000_000,
  ...over,
});

test('迁移：flow_messages 表已建立（schema 版本含 v9）', (t) => {
  const { db } = setup(t);
  assert.ok(schemaVersion(db) >= 9);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='flow_messages'").get();
  assert.ok(table);
});

test('写入：首次 created=true，重复 messageId 幂等', (t) => {
  const { store } = setup(t);
  const first = store.append(row());
  assert.equal(first.created, true);
  const again = store.append(row({ content: '内容变了但 id 相同' }));
  assert.equal(again.created, false);
  const list = store.list({ botId: 'bot-a', peer: 'group:G1' });
  assert.equal(list.length, 1);
  assert.equal(list[0].content, '这泡馍店也太会做生意了');
});

test('写入：空 messageId 不去重（多条都保留）', (t) => {
  const { store } = setup(t);
  assert.equal(store.append(row({ messageId: '', content: '甲' })).created, true);
  assert.equal(store.append(row({ messageId: '', content: '乙' })).created, true);
  assert.equal(store.list({ botId: 'bot-a', peer: 'group:G1' }).length, 2);
});

test('写入：正文按码点截断到上限；空正文拒绝', (t) => {
  const { store } = setup(t);
  store.append(row({ messageId: 'long', content: '鱼'.repeat(MAX_CONTENT_CHARS + 50) }));
  const one = store.list({ botId: 'bot-a', peer: 'group:G1' })[0];
  assert.equal(Array.from(one.content).length, MAX_CONTENT_CHARS);
  assert.equal(store.append(row({ messageId: 'empty', content: '   ' })).ok, false);
});

test('必填校验：botId / peer 不能为空', (t) => {
  const { store } = setup(t);
  assert.throws(() => store.append(row({ botId: '' })), /botId/);
  assert.throws(() => store.append(row({ peer: '' })), /peer/);
});

test('查询：时间窗口 + 正序 + 分页', (t) => {
  const { store } = setup(t);
  const base = 1_700_000_000_000;
  for (let i = 0; i < 5; i += 1) {
    store.append(row({ messageId: 'm' + i, content: '第' + i + '条', createdAt: base + i * 1000 }));
  }
  const all = store.list({ botId: 'bot-a', peer: 'group:G1' });
  assert.deepEqual(all.map((item) => item.content), ['第0条', '第1条', '第2条', '第3条', '第4条']);
  const windowed = store.list({ botId: 'bot-a', peer: 'group:G1', since: base + 1000, until: base + 3000 });
  assert.deepEqual(windowed.map((item) => item.content), ['第1条', '第2条', '第3条']);
  const paged = store.list({ botId: 'bot-a', peer: 'group:G1', limit: 2, offset: 3 });
  assert.deepEqual(paged.map((item) => item.content), ['第3条', '第4条']);
});

test('recent：取最近 N 条，但仍按时间正序返回', (t) => {
  const { store } = setup(t);
  const base = 1_700_000_000_000;
  for (let i = 0; i < 4; i += 1) {
    store.append(row({ messageId: 'r' + i, content: 'r' + i, createdAt: base + i * 1000 }));
  }
  const recent = store.recent({ botId: 'bot-a', peer: 'group:G1', limit: 2 });
  assert.deepEqual(recent.map((item) => item.content), ['r2', 'r3']);
});

test('统计：条数与首尾时间；清理按保留期删旧', (t) => {
  const now = Date.now();
  const { store } = setup(t);
  store.append(row({ messageId: 'old', content: '旧', createdAt: now - 20 * 86400_000 }));
  store.append(row({ messageId: 'new', content: '新', createdAt: now }));
  const stats = store.stats({ botId: 'bot-a', peer: 'group:G1' });
  assert.equal(stats.count, 2);
  assert.equal(store.count({ botId: 'bot-a' }), 2);
  const cleaned = store.cleanup({ retainDays: DEFAULT_RETAIN_DAYS });
  assert.equal(cleaned.removed, 1);
  assert.deepEqual(store.list({ botId: 'bot-a', peer: 'group:G1' }).map((item) => item.content), ['新']);
});
