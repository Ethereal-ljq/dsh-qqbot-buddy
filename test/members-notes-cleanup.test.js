/**
 * test/members-notes-cleanup.test.js —— 清理 0.18.2 记忆回填遗留的群友备注。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemberStore } from '../lib/members/store.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-notes-clean-'));
  const store = createMemberStore({
    dir: path.join(dir, 'members'),
    settings: { get: () => ({ members: { enabled: true, dir: path.join(dir, 'members') } }) },
    logger: quiet,
  });
  store.ensure();
  return { store, dir };
}

test('清理群友备注：只保留与本人相关的句子', () => {
  const { store } = makeStore();
  store.visit({ groupId: 'g1', openid: 'U1', name: '浮沉' });
  store.visit({ groupId: 'g1', openid: 'U2', name: '院' });
  store.visit({ groupId: 'g1', openid: 'U3', name: '朝咱' });
  const fushen = store.getByOpenid('U1');
  store.save({
    id: fushen.id,
    name: '浮沉',
    notes: [
      '浮沉喜欢开玩笑，常找机器人聊天。',
      '群内称呼表：院=院长，代理人=猛男，浮沉=浮沉，朝咱=群友。',
      '用户（浮沉）曾要求机器人改成卑躬屈膝的人格，另有人（院）反对，机器人保持原样。',
      '院最近在忙项目。',
    ].join('；'),
  });
  const result = store.cleanupLegacyNotes();
  assert.equal(result.ok, true);
  assert.ok(result.cleaned >= 1);
  const after = store.get(fushen.id);
  assert.match(after.body, /浮沉喜欢开玩笑/);
  assert.doesNotMatch(after.body, /称呼表/, '群称呼表应被移除');
  assert.doesNotMatch(after.body, /院最近在忙项目/, '完全与本人无关的句子应被移除');
  // 提到本人 + 另一个人的互动保留
  assert.match(after.body, /用户（浮沉）曾要求/);
});

test('清理群友备注：dryRun 不改文件', () => {
  const { store } = makeStore();
  store.visit({ groupId: 'g1', openid: 'U1', name: '阿岚' });
  const member = store.getByOpenid('U1');
  store.save({ id: member.id, name: '阿岚', notes: '阿岚喜欢原神；院在忙；群内称呼表：阿岚=岚岚，院=院长。' });
  const result = store.cleanupLegacyNotes({ dryRun: true });
  assert.ok(result.cleaned >= 1);
  assert.match(store.get(member.id).body, /称呼表/, 'dryRun 不应修改正文');
});
