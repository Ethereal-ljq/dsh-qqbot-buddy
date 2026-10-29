/**
 * test/members-auto-extract.test.js —— 群友备注自动提炼（阶段二）。
 *
 * 覆盖：
 * - members store：applyAutoNote 在「空正文 / 自动正文 / 人工正文」三种情况下的行为；
 * - adoptAutoNote：把自动补充采纳进人工备注并移除；
 * - 提炼器：members.autoExtract 开启时更新群友备注（openid / 同名匹配），人工备注不被覆盖，
 *   低置信跳过，知识关闭时仍可只提炼群友。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemberStore } from '../lib/members/store.js';
import { createKnowledgeStore } from '../lib/knowledge/store.js';
import { createKnowledgeExtractor } from '../lib/knowledge/auto-extract.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMemberStore(dir) {
  const store = createMemberStore({
    dir: dir,
    settings: { get: () => ({ members: { enabled: true, dir: dir } }) },
    logger: quiet,
  });
  store.ensure();
  return store;
}

test('applyAutoNote：空正文直接写入并标记 auto', () => {
  const dir = tempDir('qqbot-member-note-');
  const store = makeMemberStore(dir);
  store.visit({ groupId: 'g1', groupName: '读书会', openid: 'U1', name: '阿岚' });
  const member = store.getByOpenid('U1');
  const result = store.applyAutoNote({ id: member.id, note: '喜欢原神，周末常在线', tags: ['活跃'], confidence: 0.9 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'body');
  const updated = store.get(member.id);
  assert.equal(updated.body, '喜欢原神，周末常在线');
  assert.equal(updated.meta.notesSource, 'auto');
  assert.deepEqual(updated.tags, ['活跃']);
});

test('applyAutoNote：自动写的正文可被更新；人工正文只进 autoNotes', () => {
  const dir = tempDir('qqbot-member-note2-');
  const store = makeMemberStore(dir);
  store.visit({ groupId: 'g1', groupName: '读书会', openid: 'U2', name: '老周' });
  const member = store.getByOpenid('U2');

  // 自动正文 → 可替换
  store.applyAutoNote({ id: member.id, note: '群主', confidence: 0.9 });
  store.applyAutoNote({ id: member.id, note: '群主，负责活动报名', confidence: 0.9 });
  assert.equal(store.get(member.id).body, '群主，负责活动报名');

  // 人工备注 → 不覆盖，只追加 autoNotes
  store.save({ id: member.id, name: '老周', notes: '这是人工写的备注', tags: ['群主'] });
  const before = store.get(member.id);
  assert.equal(before.meta.notesSource, 'manual');
  const applied = store.applyAutoNote({ id: member.id, note: '负责活动报名', confidence: 0.9 });
  assert.equal(applied.mode, 'autoNotes');
  const after = store.get(member.id);
  assert.equal(after.body, '这是人工写的备注', '人工备注不允许被覆盖');
  assert.equal(after.meta.autoNotes.length, 1);
  assert.equal(after.meta.autoNotes[0].text, '负责活动报名');
  // 重复补充去重
  store.applyAutoNote({ id: member.id, note: '负责活动报名', confidence: 0.9 });
  assert.equal(store.get(member.id).meta.autoNotes.length, 1);
  // 人工备注已包含的信息不再追加
  store.applyAutoNote({ id: member.id, note: '这是人工写的备注', confidence: 0.9 });
  assert.equal(store.get(member.id).meta.autoNotes.length, 1);
});

test('adoptAutoNote：采纳后写入正文并移除自动补充', () => {
  const dir = tempDir('qqbot-member-note3-');
  const store = makeMemberStore(dir);
  store.visit({ groupId: 'g1', openid: 'U3', name: '小满' });
  const member = store.getByOpenid('U3');
  store.save({ id: member.id, name: '小满', notes: '人工备注' });
  store.applyAutoNote({ id: member.id, note: '会画表情包', confidence: 0.9 });
  const result = store.adoptAutoNote({ id: member.id, index: 0 });
  assert.equal(result.ok, true);
  const updated = store.get(member.id);
  assert.match(updated.body, /人工备注/);
  assert.match(updated.body, /会画表情包/);
  assert.equal(updated.meta.notesSource, 'manual');
  assert.equal((updated.meta.autoNotes || []).length, 0);
});

function makeExtractor({ dir, reply, membersAutoExtract, knowledgeAutoExtract }) {
  const membersDir = path.join(dir, 'members');
  const knowledgeDir = path.join(dir, 'knowledge');
  const settings = {
    get: () => ({
      knowledge: {
        enabled: true,
        dir: knowledgeDir,
        autoExtract: Object.assign({ enabled: false, everyRounds: 6, maxEntries: 3, minConfidence: 0.8, provider: 'p', model: 'm' }, knowledgeAutoExtract || {}),
      },
      members: {
        enabled: true,
        dir: membersDir,
        autoExtract: Object.assign({ enabled: true, maxNotes: 2, minConfidence: 0.8 }, membersAutoExtract || {}),
      },
    }),
  };
  const knowledge = createKnowledgeStore({ settings: settings, logger: quiet });
  knowledge.ensure();
  const members = createMemberStore({ settings: settings, logger: quiet });
  members.ensure();
  const extractor = createKnowledgeExtractor({
    ctx: null,
    settings: settings,
    knowledge: knowledge,
    members: members,
    logger: quiet,
    callModel: async () => reply,
  });
  return { extractor, knowledge, members };
}

test('提炼器：members 输出按 openid 匹配并写备注；人工备注不被覆盖', async () => {
  const dir = tempDir('qqbot-member-ex-');
  const first = makeExtractor({
    dir: dir,
    reply: JSON.stringify({ knowledge: [], members: [{ name: '阿岚', openid: 'U1', tags: ['活跃'], note: '喜欢原神，周末常在线', confidence: 0.9 }] }),
  });
  // 预置一个只有活跃度、没有备注的成员
  first.members.visit({ groupId: 'g1', groupName: '读书会', openid: 'U1', name: '阿岚' });
  const record = { scope: 'group', peerId: 'g1', session: { events: [] } };
  const result = await first.extractor.extractNow(record, { transcript: '[阿岚 (U1)] 我周末都在线，喜欢原神', groupHint: '读书会' });
  assert.equal(result.ok, true);
  assert.equal(result.membersUpdated.length, 1);
  assert.equal(result.membersUpdated[0].mode, 'body');
  const member = first.members.getByOpenid('U1');
  assert.equal(member.body, '喜欢原神，周末常在线');
  assert.ok(member.tags.includes('活跃'));

  // 人工改备注后，再次自动提炼只能进 autoNotes
  first.members.save({ id: member.id, name: '阿岚', notes: '人工：游戏搭子' });
  const second = await first.extractor.extractNow(record, {
    transcript: '[阿岚 (U1)] 我主要玩排位',
    groupHint: '读书会',
  });
  assert.equal(second.ok, true);
  const after = first.members.getByOpenid('U1');
  assert.equal(after.body, '人工：游戏搭子');
  assert.equal(after.meta.autoNotes.length, 1);
});

test('提炼器：低置信跳过；只开群友时知识关闭也能跑', async () => {
  const dir = tempDir('qqbot-member-ex2-');
  const { extractor, members, knowledge } = makeExtractor({
    dir: dir,
    knowledgeAutoExtract: { enabled: false },
    membersAutoExtract: { enabled: true, minConfidence: 0.9 },
    reply: JSON.stringify({
      knowledge: [{ title: '不该写入', body: '知识已关闭', confidence: 0.99 }],
      members: [
        { name: '小满', openid: 'U2', note: '会画表情包', confidence: 0.5 },
        { name: '小满', openid: 'U2', note: '', confidence: 0.9 },
      ],
    }),
  });
  members.visit({ groupId: 'g1', openid: 'U2', name: '小满' });
  const result = await extractor.extractNow({ scope: 'group', peerId: 'g1', session: { events: [] } }, {
    transcript: '[小满 (U2)] 我会画表情包',
  });
  assert.equal(result.ok, true);
  assert.equal(result.membersUpdated.length, 0, '低置信/空备注应跳过');
  assert.ok(result.membersSkipped.some((item) => item.reason === 'low-confidence'));
  assert.equal(knowledge.list({}).total, 0, '知识关闭时不应写入知识');
});
