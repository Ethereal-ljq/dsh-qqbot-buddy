/**
 * test/members-profile-extract.test.js —— 群友画像自动提炼（专用提示词）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemberStore } from '../lib/members/store.js';
import { createMemberProfileExtractor, parseProfileResult } from '../lib/members/profile-extract.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function makeEnv(profileExtract) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-profile-ex-'));
  const store = createMemberStore({
    dir: path.join(dir, 'members'),
    settings: { get: () => ({ members: { enabled: true, dir: path.join(dir, 'members') } }) },
    logger: quiet,
  });
  store.ensure();
  const settings = {
    get: () => ({
      members: {
        enabled: true,
        dir: path.join(dir, 'members'),
        profileExtract: Object.assign({
          enabled: true,
          everyRounds: 10,
          maxMembers: 2,
          minConfidence: 0.7,
          perMemberHours: 6,
          provider: 'p',
          model: 'm',
        }, profileExtract || {}),
      },
    }),
  };
  return { store, settings };
}

function makeExtractor({ store, settings, reply }) {
  return createMemberProfileExtractor({
    ctx: null,
    settings: settings,
    members: store,
    logger: quiet,
    callModel: async () => reply,
  });
}

const REPLY = JSON.stringify({
  members: [
    {
      openid: 'U1',
      name: '阿岚',
      nicknames: ['岚岚'],
      personality: ['直爽', '爱开黑'],
      deeds: ['组织周六开黑'],
      affinity: { level: 1, note: '常一起打游戏' },
      tags: ['活跃'],
      confidence: 0.92,
    },
  ],
});

test('parseProfileResult：解析 JSON、裁剪字段、去重', () => {
  const parsed = parseProfileResult(REPLY);
  assert.equal(parsed.members.length, 1);
  const row = parsed.members[0];
  assert.equal(row.openid, 'U1');
  assert.deepEqual(row.nicknames, ['岚岚']);
  assert.deepEqual(row.personality, ['直爽', '爱开黑']);
  assert.equal(row.affinity.level, 1);
  assert.equal(row.confidence, 0.92);
  assert.equal(parseProfileResult('not json'), null);
});

test('提炼：按 openid 匹配已知群友并合并结构化画像', async () => {
  const { store, settings } = makeEnv();
  store.visit({ groupId: 'g1', groupName: '读书会', openid: 'U1', name: '阿岚' });
  const extractor = makeExtractor({ store, settings, reply: REPLY });
  const result = await extractor.extractNow(null, { transcript: '[阿岚 (U1)] 我周末都在线，喜欢原神', groupId: 'g1' });
  assert.equal(result.ok, true);
  assert.equal(result.updated.length, 1);
  const member = store.getByOpenid('U1');
  assert.deepEqual(member.meta.profile.nicknames, ['岚岚']);
  assert.deepEqual(member.meta.profile.personality, ['直爽', '爱开黑']);
  assert.deepEqual(member.meta.profile.deeds, ['组织周六开黑']);
  assert.equal(member.meta.profile.affinity.level, 1);
  assert.equal(member.meta.profileSource, 'auto');
  assert.ok(member.tags.includes('活跃'));
});

test('提炼：低置信跳过；人工画像不被覆盖（只做并集）', async () => {
  const { store, settings } = makeEnv({ perMemberHours: 0 });
  store.visit({ groupId: 'g1', openid: 'U1', name: '阿岚' });
  const member = store.getByOpenid('U1');
  store.save({ id: member.id, name: '阿岚', profile: { personality: ['人工性格'], affinity: { level: 2, note: '老朋友' } } });

  // 低置信（0.5 < 0.7）
  let extractor = makeExtractor({ store, settings, reply: JSON.stringify({ members: [{ openid: 'U1', name: '阿岚', personality: ['低置信'], confidence: 0.5 }] }) });
  let result = await extractor.extractNow(null, { transcript: '阿岚 U1 说话', groupId: 'g1' });
  assert.equal(result.updated.length, 0);
  assert.ok(result.skipped.some((row) => row.reason === 'low-confidence'));

  // 正常更新
  extractor = makeExtractor({ store, settings, reply: REPLY });
  result = await extractor.extractNow(null, { transcript: '阿岚 U1 说话', groupId: 'g1' });
  assert.equal(result.updated.length, 1);
  const after = store.get(member.id);
  assert.ok(after.meta.profile.personality.includes('人工性格'), '人工画像不应被删');
  assert.ok(after.meta.profile.personality.includes('直爽'), '自动画像应做并集');
  assert.equal(after.meta.profile.affinity.note, '常一起打游戏', '自动更新关系备注');
});

test('提炼：同一人 perMemberHours 内节流', async () => {
  const { store, settings } = makeEnv({ perMemberHours: 6 });
  store.visit({ groupId: 'g1', openid: 'U1', name: '阿岚' });
  const extractor = makeExtractor({ store, settings, reply: REPLY });
  const first = await extractor.extractNow(null, { transcript: '阿岚 U1 说话', groupId: 'g1' });
  assert.equal(first.updated.length, 1);
  const again = await extractor.extractNow(null, { transcript: '阿岚 U1 说话', groupId: 'g1' });
  assert.equal(again.updated.length, 0);
  assert.ok(again.skipped.some((row) => row.reason === 'throttled'));
});

test('提炼：unknown openid 跳过，不新建成员', async () => {
  const { store, settings } = makeEnv();
  store.visit({ groupId: 'g1', openid: 'U1', name: '阿岚' });
  const extractor = makeExtractor({
    store,
    settings,
    reply: JSON.stringify({ members: [{ openid: 'UNKNOWN', name: '陌生人', personality: ['x'], confidence: 0.9 }] }),
  });
  const result = await extractor.extractNow(null, { transcript: '阿岚 陌生人 UNKNOWN', groupId: 'g1' });
  assert.equal(result.updated.length, 0);
  assert.ok(result.skipped.some((row) => row.reason === 'not-found'));
  assert.equal(store.list({}).total, 1);
});
