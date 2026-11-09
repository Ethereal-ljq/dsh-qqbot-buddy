import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, run } from '../lib/core/db.js';
import { createMemoryStore, DEDUPE_THRESHOLD, textSimilarity } from '../lib/core/memory/store.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-memory-'));
  const db = openDb(path.join(dir, 'test.db'));
  const now = Date.now();
  for (const id of ['bot-a', 'bot-b']) {
    run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', id, id, now, now);
  }
  t.after(() => closeDb(db));
  return { db, memory: createMemoryStore({ db }) };
}

test('save 新建记忆并返回完整实体', (t) => {
  const { memory } = setup(t);
  const saved = memory.save({
    botId: 'bot-a',
    text: '  用户喜欢猫  ',
    peer: 'qq:group:1',
    tags: ['偏好', '宠物'],
    source: 'chat',
  });
  assert.equal(saved.created, true);
  assert.equal(saved.deduped, false);
  assert.ok(saved.id > 0);
  assert.equal(saved.botId, 'bot-a');
  assert.equal(saved.text, '用户喜欢猫');
  assert.equal(saved.kind, 'fact');
  assert.equal(saved.peer, 'qq:group:1');
  assert.equal(saved.source, 'chat');
  assert.deepEqual(saved.tags, ['偏好', '宠物']);
  assert.equal(typeof saved.createdAt, 'number');
  assert.equal(typeof saved.updatedAt, 'number');
  assert.equal(memory.list({ botId: 'bot-a' }).length, 1);
});

test('近似去重：同 bot 下相似文本只保留一条，tags 合并', (t) => {
  const { memory } = setup(t);
  const first = memory.save({ botId: 'bot-a', text: '用户喜欢猫', tags: ['偏好'] });
  const dup = memory.save({ botId: 'bot-a', text: '用户喜欢猫咪。', tags: ['宠物'] });
  assert.equal(dup.deduped, true);
  assert.equal(dup.created, false);
  assert.equal(dup.id, first.id);
  assert.deepEqual(dup.tags.sort(), ['偏好', '宠物']);
  assert.equal(memory.list({ botId: 'bot-a' }).length, 1);

  // 归一化（空白/标点）后完全相同的也去重
  const exact = memory.save({ botId: 'bot-a', text: '  用户喜欢猫。 ' });
  assert.equal(exact.deduped, true);
  assert.equal(memory.list({ botId: 'bot-a' }).length, 1);

  // 不相似的新记忆正常入库
  const other = memory.save({ botId: 'bot-a', text: '用户讨厌下雨天' });
  assert.equal(other.created, true);
  assert.equal(memory.list({ botId: 'bot-a' }).length, 2);

  // 不同 bot 之间不去重
  const anotherBot = memory.save({ botId: 'bot-b', text: '用户喜欢猫' });
  assert.equal(anotherBot.created, true);
  assert.notEqual(anotherBot.id, first.id);
});

test('textSimilarity 纯函数：阈值以上判为同一条', () => {
  assert.equal(textSimilarity('用户喜欢猫', '用户喜欢猫'), 1);
  assert.ok(textSimilarity('用户喜欢猫', '用户喜欢猫咪') >= DEDUPE_THRESHOLD);
  assert.ok(textSimilarity('用户喜欢猫', '今天天气不错') < 0.3);
  assert.equal(textSimilarity('', ''), 0);
  assert.equal(textSimilarity('用户喜欢猫', ''), 0);
});

test('search 契约：2 字回退 LIKE，>=3 字走 FTS，且按 bot 隔离', (t) => {
  const { memory } = setup(t);
  const saved = memory.save({ botId: 'bot-a', text: '用户喜欢猫' });
  memory.save({ botId: 'bot-b', text: '用户喜欢狗' });

  const fts = memory.search({ botId: 'bot-a', query: '喜欢猫' });
  assert.equal(fts.length, 1);
  assert.equal(fts[0].mode, 'fts');
  assert.equal(fts[0].id, saved.id);
  assert.match(fts[0].snippet, /喜欢猫/);
  assert.ok(fts[0].score >= 0);

  const like = memory.search({ botId: 'bot-a', query: '喜欢' });
  assert.equal(like.length, 1);
  assert.equal(like[0].mode, 'like');
  assert.ok(like[0].score > 0);

  assert.equal(memory.search({ botId: 'bot-a', query: '喜欢狗' }).length, 0);
  assert.equal(memory.search({ botId: 'bot-b', query: '喜欢猫' }).length, 0);
  assert.deepEqual(memory.search({ botId: 'bot-a', query: '   ' }), []);
});

test('update 修改 text 后 FTS 同步，两种调用形式都支持', (t) => {
  const { memory } = setup(t);
  const saved = memory.save({ botId: 'bot-a', text: '用户喜欢猫' });

  const updated = memory.update({ id: saved.id, text: '用户喜欢狗', kind: 'preference', tags: ['宠物'] });
  assert.equal(updated.text, '用户喜欢狗');
  assert.equal(updated.kind, 'preference');
  assert.deepEqual(updated.tags, ['宠物']);
  assert.equal(memory.search({ botId: 'bot-a', query: '喜欢猫' }).length, 0, '旧文本 FTS 命中必须消失');
  assert.equal(memory.search({ botId: 'bot-a', query: '喜欢狗' }).length, 1);

  const positional = memory.update(saved.id, { peer: 'qq:group:9' });
  assert.equal(positional.peer, 'qq:group:9');
  assert.equal(memory.update({ id: 99999, text: '不存在' }), null);
});

test('remove / delete 删除记忆并同步 FTS', (t) => {
  const { memory } = setup(t);
  const saved = memory.save({ botId: 'bot-a', text: '临时记忆内容' });

  const removed = memory.delete({ id: saved.id });
  assert.equal(removed.removed, true);
  assert.equal(removed.id, saved.id);
  assert.equal(memory.list({ botId: 'bot-a' }).length, 0);
  assert.equal(memory.search({ botId: 'bot-a', query: '临时记忆' }).length, 0);

  assert.equal(memory.remove({ id: saved.id }).removed, false);
  assert.equal(memory.get(saved.id), null);
});

test('list 过滤/排序/分页', (t) => {
  const { memory } = setup(t);
  const a = memory.save({ botId: 'bot-a', text: '第一条记忆内容甲', kind: 'fact' });
  const b = memory.save({ botId: 'bot-a', text: '第二条记忆内容乙', kind: 'preference', peer: 'qq:group:1' });
  const c = memory.save({ botId: 'bot-a', text: '第三条记忆内容丙', kind: 'fact' });
  memory.save({ botId: 'bot-b', text: '别的 bot 的记忆' });

  const all = memory.list({ botId: 'bot-a' });
  assert.equal(all.length, 3);
  // updated_at DESC, id DESC：同毫秒保存时用 id 打破平局
  assert.deepEqual(all.map((row) => row.id), [c.id, b.id, a.id]);

  assert.equal(memory.list({ botId: 'bot-a', kind: 'preference' }).length, 1);
  assert.equal(memory.list({ botId: 'bot-a', peer: 'qq:group:1' }).length, 1);
  assert.equal(memory.list({ botId: 'bot-a', limit: 1 }).length, 1);
  assert.equal(memory.list({ botId: 'bot-a', limit: 1, offset: 1 })[0].id, b.id);
  assert.equal(memory.list({ botId: 'bot-b' }).length, 1);
  assert.equal(memory.get(b.id).peer, 'qq:group:1');
});

test('tags 支持字符串/数组两种输入并归一化', (t) => {
  const { memory } = setup(t);
  const saved = memory.save({ botId: 'bot-a', text: '标签测试记忆', tags: '偏好, 宠物，日常' });
  assert.deepEqual(saved.tags, ['偏好', '宠物', '日常']);
  const replaced = memory.update({ id: saved.id, tags: '新的标签' });
  assert.deepEqual(replaced.tags, ['新的标签']);
  const cleared = memory.update({ id: saved.id, tags: [] });
  assert.deepEqual(cleared.tags, []);
});

test('参数校验与工厂校验', (t) => {
  const { memory } = setup(t);
  assert.throws(() => createMemoryStore({}), TypeError);
  assert.throws(() => memory.save({ text: '缺少 botId' }), TypeError);
  assert.throws(() => memory.save({ botId: 'bot-a', text: '   ' }), TypeError);
  assert.throws(() => memory.save({ botId: 'bot-a' }), TypeError);
  assert.throws(() => memory.search({ query: 'abc' }), TypeError);
  assert.throws(() => memory.remove({ id: 0 }), TypeError);
  assert.equal(memory.update({ id: 12345, tags: ['x'] }), null);
});
