/**
 * test/members-memory-backfill.test.js —— 升级后把长期记忆回填成群友备注（一次性）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemberStore } from '../lib/members/store.js';
import { backfillMemberNotesFromMemory } from '../lib/members/memory-backfill.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-mem-backfill-'));
  const store = createMemberStore({
    dir: path.join(dir, 'members'),
    settings: { get: () => ({ members: { enabled: true, dir: path.join(dir, 'members') } }) },
    logger: quiet,
  });
  store.ensure();
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return { dir, store, stateDir };
}

function makeMemory(facts) {
  return { index: () => ({ version: 2, facts: facts }) };
}

test('回填：按昵称匹配记忆事实，空备注写正文，并写 marker', () => {
  const { store, stateDir } = makeEnv();
  store.visit({ groupId: 'g1', openid: 'U1', name: '阿岚' });
  const memory = makeMemory([
    { text: '阿岚喜欢原神，周末常在线。', tags: ['偏好'], at: '2026-10-20T10:00:00.000Z' },
    { text: '阿岚不吃香菜。', tags: ['偏好'], at: '2026-10-21T10:00:00.000Z' },
    { text: '不相关的事实。', tags: [], at: '2026-10-22T10:00:00.000Z' },
  ]);
  const result = backfillMemberNotesFromMemory({ memory, members: store, stateDir, logger: quiet });
  assert.equal(result.updated, 1);
  assert.equal(result.matchedFacts, 2);
  const member = store.getByOpenid('U1');
  assert.match(member.body, /原神/);
  assert.match(member.body, /香菜/);
  assert.equal(member.meta.notesSource, 'auto');
  assert.ok(fs.existsSync(path.join(stateDir, 'memory-backfill-v1.json')));

  // 幂等：第二次直接跳过
  const second = backfillMemberNotesFromMemory({ memory, members: store, stateDir, logger: quiet });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already-done');
});

test('回填：人工备注不被覆盖，只追加自动补充', () => {
  const { store, stateDir } = makeEnv();
  store.visit({ groupId: 'g1', openid: 'U2', name: '老周' });
  const member = store.getByOpenid('U2');
  store.save({ id: member.id, name: '老周', notes: '人工：群主' });
  const memory = makeMemory([
    { text: '老周负责活动报名。', tags: ['群成员'], at: '2026-10-20T10:00:00.000Z' },
  ]);
  const result = backfillMemberNotesFromMemory({ memory, members: store, stateDir, logger: quiet });
  assert.equal(result.updated, 1);
  const after = store.get(member.id);
  assert.equal(after.body, '人工：群主');
  assert.equal(after.meta.autoNotes.length, 1);
  assert.match(after.meta.autoNotes[0].text, /活动报名/);
});

test('回填：没有匹配事实的成员不动，marker 仍写（只跑一次）', () => {
  const { store, stateDir } = makeEnv();
  store.visit({ groupId: 'g1', openid: 'U3', name: '小满' });
  const memory = makeMemory([{ text: '完全无关。', tags: [], at: '2026-10-20T10:00:00.000Z' }]);
  const result = backfillMemberNotesFromMemory({ memory, members: store, stateDir, logger: quiet });
  assert.equal(result.updated, 0);
  assert.equal(store.getByOpenid('U3').body, '');
  assert.ok(fs.existsSync(path.join(stateDir, 'memory-backfill-v1.json')));
});
