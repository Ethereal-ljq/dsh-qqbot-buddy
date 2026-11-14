/**
 * reports-service —— 定时触发 / 主动投递 / 幂等。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDb, migrate, openDb } from '../lib/core/db.js';
import { createReportStore } from '../lib/core/reports/store.js';
import { createDailyService, normalizePeer, parseTimeOfDay, plannedMood } from '../lib/reports/service.js';
import { localDay } from '../lib/reports/daily.js';

const goodJson = JSON.stringify({
  title: '今天的群', lead: '聊吃的',
  topics: [{ title: '吃啥', summary: '从火锅到寿司', quotes: [{ name: '甲', text: '今天吃啥' }] }],
  quotes: [],
});

function dayMessages(day, count = 25) {
  const base = new Date(day + 'T10:00:00').getTime();
  return Array.from({ length: count }, (_, i) => ({
    senderId: 'U' + (i % 3), senderName: '甲' + (i % 3),
    content: '消息' + i, createdAt: base + i * 60 * 1000,
  }));
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-svc-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  t.after(() => closeDb(db));
  return createReportStore({ db });
}

test('plannedMood：auto 不强制 / random 随机 / fixed 校验', () => {
  const visualConfig = { moods: [{ id: 'lively' }, { id: 'calm' }, { id: 'night' }] };
  assert.equal(plannedMood({ daily: { visualMode: 'auto' } }, visualConfig), '');
  assert.equal(plannedMood({}, visualConfig), '');
  assert.equal(plannedMood({ daily: { visualMode: 'fixed', visualMood: 'night' } }, visualConfig), 'night');
  assert.equal(plannedMood({ daily: { visualMode: 'fixed', visualMood: 'nope' } }, visualConfig), '');
  assert.equal(plannedMood({ daily: { visualMode: 'fixed', visualMood: '' } }, visualConfig), '');
  const random = plannedMood({ daily: { visualMode: 'random' } }, visualConfig);
  assert.ok(['lively', 'calm', 'night'].includes(random));
  // 没有声明插画槽的模板：无论什么模式都不强制
  assert.equal(plannedMood({ daily: { visualMode: 'random' } }, null), '');
  assert.equal(plannedMood({ daily: { visualMode: 'fixed', visualMood: 'night' } }, { moods: [] }), '');
});

test('parseTimeOfDay / normalizePeer', () => {
  assert.equal(parseTimeOfDay('23:30'), (23 * 60 + 30) * 60 * 1000);
  assert.equal(parseTimeOfDay('9:05'), (9 * 60 + 5) * 60 * 1000);
  assert.equal(parseTimeOfDay('24:00'), null);
  assert.equal(parseTimeOfDay('abc'), null);
  assert.equal(normalizePeer('ABC'), 'group:ABC');
  assert.equal(normalizePeer('group:ABC'), 'group:ABC');
  assert.equal(normalizePeer(''), '');
});

test('tick：到点生成并主动投递；第二次 tick 不重复', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const sent = [];
  let llmCalls = 0;
  const service = createDailyService({
    config: {
      listBots: () => [{ id: 'b1', enabled: true }],
      getEffectiveSettings: () => ({
        daily: { enabled: true, time: '23:30', catchUp: true, delivery: 'proactive', minMessages: 20, maxMessages: 300, peers: [] },
        relation: { enabled: false },
      }),
    },
    flow: { peers: () => [{ peer: 'group:G1', last: Date.now() }], list: () => dayMessages(day) },
    reports,
    oneShot: { generate: async () => { llmCalls += 1; return { ok: true, text: goodJson }; } },
    members: {},
    host: {
      runtimeOf: () => ({
        transport: { messageSender: { sendProactive: async (target, text) => { sent.push({ target, text }); return { ok: true }; } } },
      }),
    },
    logger: { info: () => {}, warn: () => {} },
    now: () => new Date(day + 'T23:31:00').getTime(),
  });
  await service.tick();
  const saved = reports.get({ botId: 'b1', peer: 'group:G1', day });
  assert.equal(saved.status, 'done');
  assert.equal(saved.delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target.targetId, 'G1');
  assert.match(sent[0].text, /群日报/);

  await service.tick();
  assert.equal(sent.length, 1, '同一天不应重复投递');
  assert.equal(llmCalls, 1);
});

test('tick：delivery=off 时 done 未投递也算完成，不重复生成', async (t) => {
  const reports = setup(t);
  const day = localDay();
  reports.save({ botId: 'b1', peer: 'group:G1', day, status: 'done', delivered: false, payload: { report: { title: '保留' } }, text: 'x' });
  let calls = 0;
  const service = createDailyService({
    config: {
      listBots: () => [{ id: 'b1', enabled: true }],
      getEffectiveSettings: () => ({
        daily: { enabled: true, time: '23:30', delivery: 'off', minMessages: 1 },
        relation: { enabled: false },
      }),
    },
    flow: { peers: () => [{ peer: 'group:G1' }], list: () => dayMessages(day) },
    reports,
    oneShot: { generate: async () => { calls += 1; return { ok: true, text: goodJson }; } },
    members: {},
    host: { runtimeOf: () => ({ transport: {} }) },
    logger: { info: () => {}, warn: () => {} },
    now: () => new Date(day + 'T23:31:00').getTime(),
  });
  await service.tick();
  assert.equal(calls, 0, 'delivery=off 时不应为了投递反复重跑模型');
});

test('tick：已生成但未投递的日报会补生成并补投', async (t) => {
  const reports = setup(t);
  const day = localDay();
  reports.save({
    botId: 'b1', peer: 'group:G1', day, status: 'done', delivered: false,
    payload: { version: 1, day, report: { title: '午间预览' } }, text: '旧文本',
  });
  const sentImages = [];
  const service = createDailyService({
    config: {
      listBots: () => [{ id: 'b1', enabled: true }],
      getEffectiveSettings: () => ({
        daily: { enabled: true, time: '23:30', delivery: 'proactive', minMessages: 1, template: 'journal' },
        relation: { enabled: false },
      }),
    },
    flow: { peers: () => [{ peer: 'group:G1' }], list: () => dayMessages(day) },
    reports,
    oneShot: { generate: async () => ({ ok: true, text: goodJson }) },
    members: {},
    host: {
      runtimeOf: () => ({
        transport: {
          messageSender: { sendProactive: async () => ({ ok: true }) },
          mediaSender: { sendImage: async (target, file) => { sentImages.push(file); return { ok: true }; } },
        },
      }),
    },
    dataDir: '/tmp/qqbot-report-cards-test',
    render: async ({ outPath }) => ({ ok: true, path: outPath }),
    logger: { info: () => {}, warn: () => {} },
    now: () => new Date(day + 'T23:31:00').getTime(),
  });
  await service.tick();
  const row = reports.get({ botId: 'b1', peer: 'group:G1', day });
  assert.equal(row.status, 'done');
  assert.equal(row.delivered, true, '未投递的报告应在补跑时投递');
  assert.equal(sentImages.length, 1);
  assert.notEqual(row.payload.report.title, '午间预览', '应重新生成而不是复用午间预览');
});

test('tick：delivery=off 只生成不发送', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const sent = [];
  const service = createDailyService({
    config: {
      listBots: () => [{ id: 'b1', enabled: true }],
      getEffectiveSettings: () => ({
        daily: { enabled: true, time: '23:30', delivery: 'off', minMessages: 20, maxMessages: 300, peers: ['group:G1'] },
        relation: { enabled: false },
      }),
    },
    flow: { peers: () => [{ peer: 'group:G1', last: Date.now() }], list: () => dayMessages(day) },
    reports,
    oneShot: { generate: async () => ({ ok: true, text: goodJson }) },
    members: {},
    host: { runtimeOf: () => ({ transport: { messageSender: { sendProactive: async (target, text) => { sent.push(text); return { ok: true }; } } } }) },
    logger: { info: () => {}, warn: () => {} },
    now: () => new Date(day + 'T23:31:00').getTime(),
  });
  await service.tick();
  assert.equal(reports.get({ botId: 'b1', peer: 'group:G1', day }).status, 'done');
  assert.equal(sent.length, 0);
});

test('generateNow：渲染卡片并优先发图，imagePath 写回报告', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const sentImages = [];
  const sentTexts = [];
  const service = createDailyService({
    config: {
      listBots: () => [],
      getEffectiveSettings: () => ({
        daily: { template: 'journal', minMessages: 1 },
        relation: { enabled: false },
      }),
    },
    flow: { peers: () => [], list: () => dayMessages(day) },
    reports,
    oneShot: { generate: async () => ({ ok: true, text: goodJson }) },
    members: {},
    host: {
      runtimeOf: () => ({
        transport: {
          messageSender: { sendProactive: async (target, text) => { sentTexts.push(text); return { ok: true }; } },
          mediaSender: { sendImage: async (target, source) => { sentImages.push({ target, source }); return { ok: true }; } },
        },
      }),
    },
    dataDir: '/tmp/qqbot-report-cards-test',
    render: async ({ outPath }) => ({ ok: true, path: outPath }),
    logger: { info: () => {}, warn: () => {} },
    now: () => new Date(day + 'T23:00:00').getTime(),
  });
  const res = await service.generateNow({ botId: 'b1', peer: 'group:G1', send: true, force: true });
  assert.equal(res.ok, true);
  assert.equal(sentImages.length, 1, '有卡片时应发图而不是长文本');
  assert.equal(sentTexts.length, 0);
  assert.match(sentImages[0].source.localPath, /reports\/group-G1-\d{4}-\d{2}-\d{2}\.jpg$/);
  assert.equal(reports.get({ botId: 'b1', peer: 'group:G1', day }).imagePath, sentImages[0].source.localPath);
});

test('tick：daily.peers 过滤 + 未到点不触发', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const service = createDailyService({
    config: {
      listBots: () => [{ id: 'b1', enabled: true }],
      getEffectiveSettings: (_botId, peer) => ({
        daily: { enabled: true, time: '23:30', delivery: 'off', minMessages: 1, peers: [peer === 'group:G1' ? 'group:G1' : 'group:OTHER'] },
        relation: { enabled: false },
      }),
    },
    flow: {
      peers: () => [{ peer: 'group:G1' }, { peer: 'group:G2' }],
      list: ({ peer }) => (peer === 'group:G1' ? dayMessages(day) : dayMessages(day)),
    },
    reports,
    oneShot: { generate: async () => ({ ok: true, text: goodJson }) },
    members: {},
    host: { runtimeOf: () => null },
    logger: { info: () => {}, warn: () => {} },
    now: () => new Date(day + 'T22:00:00').getTime(),
  });
  await service.tick();
  assert.equal(reports.get({ botId: 'b1', peer: 'group:G1', day }), null, '未到点不应生成');
});
