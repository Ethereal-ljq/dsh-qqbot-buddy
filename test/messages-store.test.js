/**
 * messages-store —— 消息流水（L0）的写入 / 检索 / 转录 / 清理。
 *
 * 这套东西是「记忆之外的原始记录层」：记忆是提炼后的结论，消息是原话。
 * 测试重点：
 *   - (bot_id, message_id) 幂等：QQ 会重推，重复写不能产生重复行；
 *   - 检索：<3 字符走 LIKE、>=3 字符走 FTS（trigram），两者都要能命中；
 *   - 按会话/发言人/时间过滤；
 *   - transcript 给记忆提炼用（时间正序、带发言人名）；
 *   - cleanup 按保留天数删旧，不误删新的。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDb, migrate, openDb } from '../lib/core/db.js';
import { DEFAULT_RETAIN_DAYS, createMessagesStore } from '../lib/core/messages/store.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-messages-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  t.after(() => closeDb(db));
  return { db, store: createMessagesStore({ db }) };
}

const msg = (over = {}) => ({
  botId: 'bot-a',
  peer: 'group:G1',
  scope: 'group',
  senderId: 'S1',
  senderName: '朝咱',
  role: 'user',
  content: '这泡馍店也太会做生意了',
  msgType: 0,
  messageId: 'm1',
  ...over,
});

test('写入：首次 created=true，重复 messageId 幂等且 id 相同', (t) => {
  const { store } = setup(t);
  const first = store.save(msg());
  const again = store.save(msg({ content: '内容变了但 id 相同' }));
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(first.id, again.id, '同一 messageId 必须复用同一行');
  assert.equal(store.stats({ botId: 'bot-a' }).count, 1, '幂等写入不应产生第二行');
});

test('写入：messageId 为空时退化为普通插入（部分事件没有 id）', (t) => {
  const { store } = setup(t);
  store.save(msg({ messageId: '', content: '第一条' }));
  store.save(msg({ messageId: '', content: '第二条' }));
  assert.equal(store.stats({ botId: 'bot-a' }).count, 2);
});

test('写入：peer 为空抛错，超长正文被截断', (t) => {
  const { store } = setup(t);
  assert.throws(() => store.save(msg({ peer: '' })), /peer/);
  store.save(msg({ content: 'x'.repeat(20000) }));
  const rows = store.search({ botId: 'bot-a' });
  assert.ok(rows[0].content.length <= 8000, '正文必须被截断到上限');
});

test('检索：>=3 字符走 FTS，<3 字符走 LIKE', (t) => {
  const { store } = setup(t);
  store.save(msg({ messageId: 'm1', content: '这个泡馍店也太会做生意了糖蒜还要钱' }));
  store.save(msg({ messageId: 'm2', content: '完全无关的一句话' }));

  const fts = store.search({ botId: 'bot-a', query: '泡馍店' });
  assert.equal(fts.length, 1);
  assert.equal(fts[0].mode, 'fts', '3 字符以上应走 FTS');

  const like = store.search({ botId: 'bot-a', query: '糖蒜' });
  assert.equal(like.length, 1);
  assert.equal(like[0].mode, 'like', '2 字符走 LIKE（trigram 无法命中）');
});

test('检索：按会话 / 发言人 / 时间过滤', (t) => {
  const { store } = setup(t);
  const now = Date.now();
  store.save(msg({ messageId: 'm1', peer: 'group:G1', senderId: 'S1', content: '甲说的话' }));
  store.save(msg({ messageId: 'm2', peer: 'group:G2', senderId: 'S1', content: '乙说的话' }));
  store.save(msg({ messageId: 'm3', peer: 'group:G1', senderId: 'S2', content: '丙说的话', createdAt: now - 10 * 86400000 }));

  assert.equal(store.search({ botId: 'bot-a', peer: 'group:G1' }).length, 2, '限定会话');
  assert.equal(store.search({ botId: 'bot-a', senderId: 'S1' }).length, 2, '限定发言人');
  const recent = store.search({ botId: 'bot-a', since: now - 86400000 });
  assert.equal(recent.length, 2, '时间窗口内只应剩两条新的');
});

test('检索：结果按时间倒序（最新的在前）', (t) => {
  const { store } = setup(t);
  const base = Date.now();
  store.save(msg({ messageId: 'm1', content: '最早', createdAt: base - 3000 }));
  store.save(msg({ messageId: 'm2', content: '中间', createdAt: base - 2000 }));
  store.save(msg({ messageId: 'm3', content: '最新', createdAt: base - 1000 }));
  const rows = store.search({ botId: 'bot-a' });
  assert.deepEqual(rows.map((r) => r.content), ['最新', '中间', '最早']);
});

test('检索：bot 之间隔离', (t) => {
  const { store } = setup(t);
  store.save(msg({ botId: 'bot-a', messageId: 'm1', content: '属于 A 的消息' }));
  store.save(msg({ botId: 'bot-b', messageId: 'm1', content: '属于 B 的消息' }));
  assert.equal(store.search({ botId: 'bot-a' })[0].content, '属于 A 的消息');
  assert.equal(store.search({ botId: 'bot-b' })[0].content, '属于 B 的消息');
});

test('transcript：给记忆提炼用，时间正序且带发言人', (t) => {
  const { store } = setup(t);
  const base = Date.now();
  store.save(msg({ messageId: 'm1', senderName: '朝咱', content: '第一句', createdAt: base - 2000 }));
  store.save(msg({ messageId: 'm2', senderName: '院', content: '第二句', createdAt: base - 1000 }));
  store.save(msg({ messageId: 'm3', role: 'assistant', senderName: '', content: '我回一句', createdAt: base }));
  const text = store.transcript({ botId: 'bot-a', peer: 'group:G1' });
  assert.equal(text, '朝咱: 第一句\n院: 第二句\n助手: 我回一句');
});

test('cleanup：按保留天数删旧，不误删新的；默认两周', (t) => {
  const { store } = setup(t);
  const now = Date.now();
  store.save(msg({ messageId: 'old', content: '二十天前', createdAt: now - 20 * 86400000 }));
  store.save(msg({ messageId: 'edge', content: '十天前', createdAt: now - 10 * 86400000 }));
  store.save(msg({ messageId: 'new', content: '刚刚', createdAt: now }));

  assert.equal(DEFAULT_RETAIN_DAYS, 14, '默认保留期必须是两周');
  const result = store.cleanup({ retainDays: 14 });
  assert.equal(result.removed, 1, '只删超过 14 天的');
  const left = store.search({ botId: 'bot-a' }).map((r) => r.content);
  assert.deepEqual(left, ['刚刚', '十天前']);

  assert.equal(store.cleanup({ retainDays: 0 }).removed, 0, 'retainDays<=0 表示不清理');
});

test('peers：按会话聚合条数与最新时间', (t) => {
  const { store } = setup(t);
  const base = Date.now();
  store.save(msg({ messageId: 'm1', peer: 'group:G1', createdAt: base - 2000 }));
  store.save(msg({ messageId: 'm2', peer: 'group:G1', createdAt: base - 1000 }));
  store.save(msg({ messageId: 'm3', peer: 'c2c:U1', createdAt: base }));
  const peers = store.peers({ botId: 'bot-a' });
  assert.equal(peers.length, 2);
  assert.equal(peers[0].peer, 'c2c:U1', '最新活跃的排前面');
  assert.equal(peers[1].count, 2);
});
