/**
 * reports-relation —— 关系增量：冷却/周封顶/证据校验/写库与审计。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COOLDOWN_DAYS, MAX_CHANGES, WEEK_CAP, relationBudget, sanitizeChanges, updateRelations, weekStartKey,
} from '../lib/reports/relation.js';

const at = (hour) => {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

const msg = (over = {}) => ({
  senderId: 'U1', senderName: '甲', content: '今天吃啥', createdAt: at(12), ...over,
});

function fakeFlow(messages = []) {
  return { list: () => messages, peers: () => [] };
}

test('relationBudget：7 天冷却 / 每周 ±2 上限', () => {
  const now = Date.now();
  assert.equal(relationBudget({}, now).ok, true);
  const recent = relationBudget({ changedAt: now - 24 * 60 * 60 * 1000 }, now);
  assert.equal(recent.ok, false);
  assert.equal(recent.reason, 'cooldown');
  const old = relationBudget({ changedAt: now - (COOLDOWN_DAYS + 1) * 24 * 60 * 60 * 1000, weekStart: weekStartKey(now), weekDelta: WEEK_CAP }, now);
  assert.equal(old.ok, false);
  assert.equal(old.reason, 'week-cap');
});

test('sanitizeChanges：openid/delta/证据三重校验，并有条数上限', () => {
  const candidates = [
    { openid: 'U1', name: '甲', rows: [msg({ content: '你是我的恩人' })] },
    { openid: 'U2', name: '乙', rows: [msg({ senderId: 'U2', content: '给我滚远点' })] },
  ];
  const parsed = {
    changes: [
      { openid: 'U1', delta: 1, evidence: '你是我的恩人', note: '感恩' },
      { openid: 'U2', delta: -2, evidence: '给我滚远点' },  // delta 越界
      { openid: 'U3', delta: 1, evidence: '编的' },         // 不在候选
      { openid: 'U2', delta: -1, evidence: '没有这句' },    // 证据对不上
      { openid: 'U2', delta: -1, evidence: '给我滚远点', note: '' },
    ],
  };
  const out = sanitizeChanges(parsed, candidates);
  assert.deepEqual(out.map((item) => item.openid), ['U1', 'U2']);
  assert.equal(out[0].delta, 1);
  assert.ok(out.length <= MAX_CHANGES);
});

test('updateRelations：命中证据 → 升一档并写审计；manual 不改；冷却不改', async () => {
  const messages = [
    msg({ content: '你是我的恩人' }),
    msg({ content: '明天也来' }),
    msg({ content: '再聊' }),
    msg({ content: '晚安' }),
    msg({ content: '好耶' }),
  ];
  const upserted = [];
  const audited = [];
  const members = {
    get: ({ openid }) => (openid === 'U1' ? { openid, profileJson: { profileSource: 'auto', affinity: { level: 0, note: '' } } } : null),
    upsert: (input) => { upserted.push(input); return { ok: true }; },
  };
  const config = { audit: (entry) => audited.push(entry) };
  const seenArgs = [];
  const oneShot = {
    generate: async (args) => {
      seenArgs.push(args);
      return {
        ok: true,
        text: JSON.stringify({ changes: [{ openid: 'U1', delta: 1, note: '称助手为恩人', evidence: '你是我的恩人' }] }),
      };
    },
  };
  const result = await updateRelations({
    flow: fakeFlow(messages), members, oneShot, config, botId: 'b1', peer: 'group:G1',
    day: new Date().toISOString().slice(0, 10),
    settings: { relation: { enabled: true }, model: { provider: 'p1', model: 'm1' } },
  });
  assert.equal(seenArgs[0].provider, 'p1');
  assert.equal(seenArgs[0].model, 'm1');
  assert.equal(result.ok, true);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].before, 0);
  assert.equal(result.changes[0].after, 1);
  assert.equal(upserted.length, 1);
  const affinity = upserted[0].profile.affinity;
  assert.equal(affinity.level, 1);
  assert.equal(affinity.note, '称助手为恩人');
  assert.equal(affinity.source, 'auto');
  assert.equal(audited[0].kind, 'member.affinity');
  const detail = JSON.parse(audited[0].detail);
  assert.equal(detail.before, 0);
  assert.equal(detail.after, 1);

  // 同一人同一天再跑一次：冷却期内不候选 → 不再调用模型
  let calls = 0;
  const second = await updateRelations({
    flow: fakeFlow(messages),
    members: { get: () => ({ profileJson: { affinity: { level: 1, changedAt: Date.now() } } }), upsert: () => {} },
    oneShot: { generate: async () => { calls += 1; return { ok: true, text: '{"changes":[]}' }; } },
    config, botId: 'b1', peer: 'group:G1', day: new Date().toISOString().slice(0, 10),
    settings: { relation: { enabled: true } },
  });
  assert.equal(second.skipped, 'no-candidates');
  assert.equal(calls, 0);
});
