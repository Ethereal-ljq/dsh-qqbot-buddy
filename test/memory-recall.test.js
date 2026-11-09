import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, run } from '../lib/core/db.js';
import { createMemoryStore, normalizeMemoryText } from '../lib/core/memory/store.js';
import { charLength } from '../lib/core/kb/text-search.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-recall-'));
  const db = openDb(path.join(dir, 'test.db'));
  const now = Date.now();
  for (const id of ['bot-a', 'bot-b']) {
    run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', id, id, now, now);
  }
  t.after(() => closeDb(db));
  return { db, memory: createMemoryStore({ db }) };
}

test('recallForPrompt 按预算拼装相关记忆', (t) => {
  const { memory } = setup(t);
  memory.save({ botId: 'bot-a', text: '用户喜欢猫' });
  memory.save({ botId: 'bot-a', text: '用户住在杭州' });
  memory.save({ botId: 'bot-a', text: '用户每周三加班' });

  const text = memory.recallForPrompt({ botId: 'bot-a', query: '用户', budgetChars: 1000 });
  assert.ok(text.length > 0);
  assert.ok(text.startsWith('- '), '首行应以 "- " 开头');
  assert.equal(text.split('\n').length, 3, '三条记忆都应在预算内被召回');
  assert.ok(charLength(text) <= 1000);
  for (const line of text.split('\n')) assert.match(line, /^- .+/);
});

test('recallForPrompt 预算不足时截断且不超预算', (t) => {
  const { memory } = setup(t);
  memory.save({ botId: 'bot-a', text: '用户喜欢猫' });
  memory.save({ botId: 'bot-a', text: '用户住在杭州' });

  const small = memory.recallForPrompt({ botId: 'bot-a', query: '用户', budgetChars: 8 });
  assert.ok(charLength(small) <= 8, '实际长度 ' + charLength(small));
  assert.equal(small.split('\n').length, 1, '预算只够第一条');

  const tiny = memory.recallForPrompt({ botId: 'bot-a', query: '用户', budgetChars: 4 });
  assert.ok(charLength(tiny) <= 4);
  assert.match(tiny, /…$/, '超长首行应被截断并加省略号');
});

test('recallForPrompt 无 query 时召回最近记忆，预算 0 返回空串', (t) => {
  const { memory } = setup(t);
  memory.save({ botId: 'bot-a', text: '较早的记忆' });
  memory.save({ botId: 'bot-a', text: '最近的记忆' });
  const recent = memory.recallForPrompt({ botId: 'bot-a', budgetChars: 500 });
  assert.equal(recent.split('\n').length, 2);
  assert.ok(recent.includes('最近的记忆'));

  assert.equal(memory.recallForPrompt({ botId: 'bot-a', query: '记忆', budgetChars: 0 }), '');
  assert.equal(memory.recallForPrompt({ botId: 'bot-a', budgetChars: -10 }), '');
});

test('recallForPrompt 空库返回空串且按 bot 隔离', (t) => {
  const { memory } = setup(t);
  assert.equal(memory.recallForPrompt({ botId: 'bot-a', query: '任意', budgetChars: 500 }), '');

  memory.save({ botId: 'bot-a', text: 'A bot 的私有记忆' });
  memory.save({ botId: 'bot-b', text: 'B bot 的私有记忆' });
  const recallA = memory.recallForPrompt({ botId: 'bot-a', budgetChars: 500 });
  assert.match(recallA, /A bot/);
  assert.doesNotMatch(recallA, /B bot/);
  const recallB = memory.recallForPrompt({ botId: 'bot-b', query: '私有', budgetChars: 500 });
  assert.match(recallB, /B bot/);
  assert.doesNotMatch(recallB, /A bot/);
});

test('recallForPrompt 参数校验', (t) => {
  const { memory } = setup(t);
  assert.throws(() => memory.recallForPrompt({ budgetChars: 100 }), TypeError);
});

test('normalizeMemoryText 折叠空白', () => {
  assert.equal(normalizeMemoryText('  用户\n喜欢   猫  '), '用户 喜欢 猫');
  assert.equal(normalizeMemoryText(null), '');
});
