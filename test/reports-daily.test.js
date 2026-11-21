/**
 * reports-daily —— 群日报：统计 / 抽样 / 引文校验 / 生成状态机。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDb, migrate, openDb } from '../lib/core/db.js';
import { createReportStore } from '../lib/core/reports/store.js';
import {
  REPORT_MAX_TOKENS, REPORT_MAX_TOKENS_RETRY,
  buildPrompt, buildStats, buildTranscript, dayBounds, extractJson, generateDaily, localDay,
  renderText, sanitizeReport, selectSample,
} from '../lib/reports/daily.js';

const at = (hour, minute = 0, dayOffset = 0) => {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d.getTime();
};

const msg = (over = {}) => ({
  senderId: 'U1', senderName: '甲', content: '今天吃啥', createdAt: at(12), ...over,
});

function fakeFlow(messages = []) {
  return { list: () => messages, peers: () => [] };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-daily-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  t.after(() => closeDb(db));
  return createReportStore({ db });
}

const goodJson = (title = '今天的群') => JSON.stringify({
  title,
  lead: '今天群里在聊吃的',
  topics: [{ title: '吃啥', summary: '从火锅聊到寿司', quotes: [{ name: '甲', text: '今天吃啥' }] }],
  quotes: [{ name: '乙', text: '我不吃辣', why: '挑食现场' }],
});

test('本地日期与当天边界', () => {
  const d = new Date(2026, 10, 13, 9, 30);
  assert.equal(localDay(d), '2026-11-13');
  const { start, end, day } = dayBounds('2026-11-13');
  assert.equal(day, '2026-11-13');
  assert.equal(new Date(start).getHours(), 0);
  assert.equal(end - start, 24 * 60 * 60 * 1000);
});

test('统计：总数/人数/Top/小时分布', () => {
  const stats = buildStats([
    msg({ senderId: 'A', senderName: '甲', createdAt: at(10) }),
    msg({ senderId: 'A', senderName: '甲', content: '火锅', createdAt: at(10, 5) }),
    msg({ senderId: 'B', senderName: '乙', createdAt: at(23) }),
  ]);
  assert.equal(stats.total, 3);
  assert.equal(stats.speakers, 2);
  assert.deepEqual(stats.topSpeakers[0], { name: '甲', count: 2 });
  assert.equal(stats.hours[10], 2);
  assert.equal(stats.hours[23], 1);
});

test('抽样：过滤命令/空消息，超过上限时按步长抽', () => {
  const rows = [];
  for (let i = 0; i < 50; i += 1) rows.push(msg({ messageId: 'm' + i, content: '消息' + i, createdAt: at(10, i) }));
  rows.push(msg({ content: '/new' }));
  rows.push(msg({ content: '   ' }));
  const sample = selectSample(rows, 10);
  assert.equal(sample.length, 10);
  assert.ok(!sample.some((row) => row.content === '/new'));
});

test('transcript：带时间/昵称，受字符预算限制', () => {
  const text = buildTranscript([msg({ content: '你好' })], 1000);
  assert.match(text, /^\[\d{2}:\d{2} 甲\] 你好$/);
  const clipped = buildTranscript([msg({ content: 'x'.repeat(500) })], 100);
  assert.ok(clipped.length <= 100);
});

test('extractJson：容忍代码围栏与前后废话', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson('没有 json'), null);
});

test('sanitizeReport：丢对不上原文的引文，保留能对上的', () => {
  const messages = [msg({ content: '今天吃啥' }), msg({ senderId: 'U2', senderName: '乙', content: '我不吃辣' })];
  const parsed = {
    title: 't', lead: 'l',
    topics: [{ title: 'x', summary: 'y', quotes: [{ name: '甲', text: '今天吃啥' }, { name: '乙', text: '编的' }] }],
    quotes: [{ name: '乙', text: '我不吃辣', why: 'z' }],
  };
  // 标题：去「群聊日报：」前缀；纯日期标题视为无效（模板会回退「今日群聊」）
  assert.equal(sanitizeReport({ ...parsed, title: '群聊日报：影刃开黑' }, messages).title, '影刃开黑');
  assert.equal(sanitizeReport({ ...parsed, title: '2026-11-13' }, messages).title, '');
  const clean = sanitizeReport(parsed, messages);
  assert.deepEqual(clean.topics[0].quotes.map((q) => q.text), ['今天吃啥']);
  assert.deepEqual(clean.quotes.map((q) => q.text), ['我不吃辣']);
  assert.equal(sanitizeReport({ topics: [{ quotes: [{ text: '编的' }] }], quotes: [{ text: '也编的' }] }, messages), null);
});

test('buildPrompt：模板声明了插画槽才带 visual 目录', () => {
  const visualConfig = {
    slots: ['hero', 'peek', 'rhythm'],
    moods: [{ id: 'lively', label: '热闹' }, { id: 'night', label: '深夜' }],
    defaultMood: 'lively',
    items: {
      'hero-cheer': { slot: 'hero', file: 'a.webp', label: '挥旗' },
      'peek-sleepy': { slot: 'peek', file: 'b.webp', label: '困倦' },
      'rhythm-night': { slot: 'rhythm', file: 'c.webp', label: '夜巡' },
    },
    presets: {}, fallback: { hero: 'hero-cheer', peek: 'peek-sleepy', rhythm: 'rhythm-night' },
  };
  const prompt = buildPrompt({ day: '2026-11-13', transcript: '[20:00 甲] 在吗', stats: buildStats([msg()]), visualConfig });
  assert.match(prompt, /"visual"/);
  assert.match(prompt, /hero-cheer 挥旗/);
  assert.match(prompt, /peek-sleepy 困倦/);
  assert.match(prompt, /lively 热闹/);
  // 没声明插画槽的模板：提示词不出现 visual，模型也不用浪费 token
  const plain = buildPrompt({ day: '2026-11-13', transcript: '[20:00 甲] 在吗', stats: buildStats([msg()]) });
  assert.doesNotMatch(plain, /"visual"/);
  assert.doesNotMatch(plain, /可选插画/);
});

test('sanitizeReport：保留合法 visual，丢弃非法项', () => {
  const messages = [msg({ content: '今天吃啥' })];
  const visualConfig = {
    slots: ['hero', 'peek', 'rhythm'],
    moods: [{ id: 'night' }],
    defaultMood: 'night',
    items: {
      'hero-night': { slot: 'hero', file: 'a.webp', label: '犯困' },
      'peek-x': { slot: 'peek', file: 'b.webp', label: 'x' },
    },
    presets: {}, fallback: { hero: 'hero-night', peek: 'peek-x' },
  };
  const parsed = {
    title: 't', lead: 'l',
    topics: [{ title: 'x', summary: 'y', quotes: [{ name: '甲', text: '今天吃啥' }] }],
    quotes: [],
    visual: { mood: 'night', hero: 'hero-night', peek: 'nope', rhythm: 'hero-night' },
  };
  const clean = sanitizeReport(parsed, messages, { visualConfig });
  assert.deepEqual(clean.visual, { mood: 'night', hero: 'hero-night' });
  assert.equal(sanitizeReport({ ...parsed, visual: { mood: 'nope' } }, messages, { visualConfig }).visual, undefined);
  // 没传配置（模板没有插画槽）时 visual 一律丢弃
  assert.equal(sanitizeReport(parsed, messages).visual, undefined);
});

test('renderText：包含日期/统计/标题/话题/金句', () => {
  const text = renderText({ title: 'T', lead: 'L', topics: [{ title: '话题', summary: 'S', quotes: [{ name: '甲', text: '原话' }] }], quotes: [{ name: '乙', text: '金句', why: 'W' }] }, buildStats([msg(), msg()]), { day: '2026-11-13' });
  assert.match(text, /群日报 · 2026-11-13/);
  assert.match(text, /共 2 条消息/);
  assert.match(text, /T/);
  assert.match(text, /【今日话题】/);
  assert.match(text, /【群聊金句】/);
});

test('generateDaily：低于阈值 → skipped；成功 → done + 文本；重复调用复用', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const flow = fakeFlow([msg(), msg()]);
  let calls = 0;
  const seen = [];
  const oneShot = { generate: async (args) => { calls += 1; seen.push(args); return { ok: true, text: goodJson() }; } };

  const skipped = await generateDaily({ flow, reports, oneShot, botId: 'b1', peer: 'group:G1', day, settings: { daily: { minMessages: 20 } } });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'below-threshold');
  assert.equal(reports.get({ botId: 'b1', peer: 'group:G1', day }).status, 'skipped');

  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(msg({ messageId: 'm' + i, content: '消息' + i, createdAt: at(10, i) }));
  rows.push(msg({ senderId: 'U2', senderName: '乙', content: '我不吃辣', createdAt: at(11) }));
  const flow2 = fakeFlow(rows);
  const done = await generateDaily({
    flow: flow2, reports, oneShot, botId: 'b1', peer: 'group:G1', day,
    settings: { daily: { minMessages: 20 }, model: { provider: 'p1', model: 'm1' } },
  });
  assert.equal(seen[0].provider, 'p1', '必须把 profile 的 provider 传给旁路模型，否则 NO_ADAPTER');
  assert.equal(seen[0].model, 'm1');
  assert.equal(done.ok, true);
  assert.match(done.text, /今天的群/);
  assert.equal(done.payload.stats.total, 26);
  assert.ok(done.payload.report.topics.length >= 1);
  assert.equal(calls, 1);

  const reused = await generateDaily({ flow: flow2, reports, oneShot, botId: 'b1', peer: 'group:G1', day, settings: { daily: { minMessages: 20 } } });
  assert.equal(reused.reused, true);
  assert.equal(calls, 1, '已有 done 报告时不应重复调用模型');
});

test('generateDaily：模型只思考不产出（推理吃满预算）时自动加大预算重试', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(msg({ messageId: 'm' + i, content: '消息' + i, createdAt: at(10, i) }));
  const seen = [];
  const warns = [];
  const oneShot = {
    generate: async (args) => {
      seen.push(args);
      if (seen.length === 1) return { ok: false, text: '', error: '模型未返回文本' };
      return { ok: true, text: goodJson('重试成功') };
    },
  };
  const result = await generateDaily({
    flow: fakeFlow(rows), reports, oneShot, botId: 'b1', peer: 'group:G1', day,
    settings: { daily: { minMessages: 20 } }, logger: { warn: (m) => warns.push(m) },
  });
  assert.equal(seen.length, 2, '无正文时要重试一次');
  assert.equal(seen[0].maxTokens, REPORT_MAX_TOKENS);
  assert.equal(seen[1].maxTokens, REPORT_MAX_TOKENS_RETRY);
  assert.ok(seen[1].maxTokens > seen[0].maxTokens, '重试预算必须更大（推理会继续吃满）');
  assert.equal(result.ok, true);
  assert.match(result.text, /重试成功/);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /没有正文/);
});

test('generateDaily：非「无正文」类失败不重试，并写 warn 日志（不再静默）', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(msg({ messageId: 'm' + i, content: '消息' + i, createdAt: at(10, i) }));
  const seen = [];
  const warns = [];
  const oneShot = { generate: async (args) => { seen.push(args); return { ok: false, text: '', error: '模型调用失败: 401' }; } };
  const result = await generateDaily({
    flow: fakeFlow(rows), reports, oneShot, botId: 'b1', peer: 'group:G1', day,
    settings: { daily: { minMessages: 20 } }, logger: { warn: (m) => warns.push(m) },
  });
  assert.equal(seen.length, 1, '鉴权类错误重试无用，不应再打一次模型');
  assert.equal(result.ok, false);
  assert.equal(reports.get({ botId: 'b1', peer: 'group:G1', day }).status, 'failed');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /群日报生成失败/);
});

test('generateDaily：forcedMood 覆盖模型 mood，非法值忽略', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(msg({ messageId: 'fm' + i, content: '消息' + i, createdAt: at(10, i) }));
  const flow = fakeFlow(rows);
  const visualConfig = {
    slots: ['hero'],
    moods: [{ id: 'lively' }, { id: 'night' }],
    defaultMood: 'lively',
    items: { 'hero-a': { slot: 'hero', file: 'a.webp', label: 'A' } },
    presets: {},
    fallback: { hero: 'hero-a' },
  };
  const reportJson = JSON.stringify({
    title: 't', lead: 'l',
    topics: [{ title: 'x', summary: 'y', quotes: [{ name: '甲', text: '消息1' }] }],
    quotes: [],
    visual: { mood: 'lively' },
  });
  const oneShot = { generate: async () => ({ ok: true, text: reportJson }) };

  const forced = await generateDaily({
    flow, reports, oneShot, botId: 'b1', peer: 'group:G1', day,
    settings: { daily: { minMessages: 20 } }, visualConfig, forcedMood: 'night',
  });
  assert.equal(forced.ok, true);
  assert.equal(forced.payload.report.visual.mood, 'night', '配置强制氛围应覆盖模型的 lively');

  const ignored = await generateDaily({
    flow, reports, oneShot, botId: 'b1', peer: 'group:G1', day, force: true,
    settings: { daily: { minMessages: 20 } }, visualConfig, forcedMood: 'nope',
  });
  assert.equal(ignored.payload.report.visual.mood, 'lively', '非法 forcedMood 不改模型选择');

  const noConfig = await generateDaily({
    flow, reports, oneShot, botId: 'b1', peer: 'group:G1', day, force: true,
    settings: { daily: { minMessages: 20 } }, forcedMood: 'night',
  });
  assert.equal(noConfig.payload.report.visual, undefined, '模板没有插画槽时 forcedMood 不生效');
});

test('generateDaily：强制重跑失败/低阈值时保留已有 done 报告', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(msg({ messageId: 'm' + i, content: '消息' + i, createdAt: at(10, i) }));
  const settings = { daily: { minMessages: 20 } };
  const flow = fakeFlow(rows);
  const first = await generateDaily({
    flow, reports, oneShot: { generate: async () => ({ ok: true, text: goodJson('保留我') }) },
    botId: 'b1', peer: 'group:G1', day, settings,
  });
  assert.equal(first.ok, true);

  const failed = await generateDaily({
    flow, reports, botId: 'b1', peer: 'group:G1', day, force: true, settings,
    oneShot: { generate: async () => ({ ok: false, text: '', error: 'ETIMEDOUT' }) },
  });
  assert.equal(failed.reason, 'llm-failed');
  let row = reports.get({ botId: 'b1', peer: 'group:G1', day });
  assert.equal(row.status, 'done', '失败重跑不能把 done 冲成 failed');
  assert.equal(row.payload.report.title, '保留我');
  assert.match(row.error, /ETIMEDOUT/);

  const few = await generateDaily({
    flow: fakeFlow([msg()]), reports, botId: 'b1', peer: 'group:G1', day, force: true, settings,
    oneShot: { generate: async () => ({ ok: true, text: goodJson('不该出现') }) },
  });
  assert.equal(few.reason, 'below-threshold');
  row = reports.get({ botId: 'b1', peer: 'group:G1', day });
  assert.equal(row.status, 'done');
  assert.equal(row.payload.report.title, '保留我', '低阈值重跑也不能冲掉已有报告');
});

test('generateDaily：模型失败 → failed；输出全是幻觉引文 → failed', async (t) => {
  const reports = setup(t);
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(msg({ messageId: 'm' + i, content: '消息' + i, createdAt: at(10, i) }));
  const flow = fakeFlow(rows);
  const day = localDay();

  const failedLlm = await generateDaily({
    flow, reports, botId: 'b1', peer: 'group:G1', day, settings: { daily: { minMessages: 20 } },
    oneShot: { generate: async () => ({ ok: false, text: '', error: 'timeout' }) },
  });
  assert.equal(failedLlm.reason, 'llm-failed');
  assert.equal(reports.get({ botId: 'b1', peer: 'group:G1', day }).status, 'failed');

  const badOutput = await generateDaily({
    flow, reports, botId: 'b1', peer: 'group:G1', day, force: true, settings: { daily: { minMessages: 20 } },
    oneShot: { generate: async () => ({ ok: true, text: JSON.stringify({ title: 't', topics: [{ quotes: [{ name: '甲', text: '不存在的话' }] }], quotes: [] }) }) },
  });
  assert.equal(badOutput.reason, 'bad-output');
});

test('generateDaily：预算来自配置（daily.maxTokens / retryMaxTokens），并打开始/完成日志', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(msg({ messageId: 'm' + i, content: '消息' + i, createdAt: at(10, i) }));
  const seen = [];
  const info = [];
  const warns = [];
  const oneShot = {
    generate: async (args) => {
      seen.push(args);
      if (seen.length === 1) return { ok: false, text: '', error: '模型未返回文本' };
      return { ok: true, text: goodJson('自定义预算') };
    },
  };
  const result = await generateDaily({
    flow: fakeFlow(rows), reports, oneShot, botId: 'b1', peer: 'group:G1', day,
    settings: { daily: { minMessages: 20, maxTokens: 2048, retryMaxTokens: 3072 } },
    logger: { info: (m) => info.push(m), warn: (m) => warns.push(m) },
  });
  assert.deepEqual(seen.map((s) => s.maxTokens), [2048, 3072], '预算必须来自配置，且重试用更大的那个');
  assert.equal(result.ok, true);
  assert.ok(info.some((m) => /群日报开始/.test(m) && /预算 2048→3072/.test(m)), '开始日志要带预算');
  assert.ok(info.some((m) => /群日报完成/.test(m)), '完成日志要有');
});

test('generateDaily：retry 预算 ≤ 首次预算 = 不重试', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(msg({ messageId: 'm' + i, content: '消息' + i, createdAt: at(10, i) }));
  const seen = [];
  const warns = [];
  const oneShot = { generate: async (args) => { seen.push(args); return { ok: false, text: '', error: '模型未返回文本' }; } };
  const result = await generateDaily({
    flow: fakeFlow(rows), reports, oneShot, botId: 'b1', peer: 'group:G1', day,
    settings: { daily: { minMessages: 20, maxTokens: 4096, retryMaxTokens: 4096 } },
    logger: { info: () => {}, warn: (m) => warns.push(m) },
  });
  assert.equal(seen.length, 1, '重试预算不大于首次预算时不应该重试');
  assert.equal(result.ok, false);
  assert.ok(warns.some((m) => /群日报生成失败/.test(m)), '失败必须 warn');
});

test('generateDaily：logRuns=false 时不打 info，但失败仍然 warn', async (t) => {
  const reports = setup(t);
  const day = localDay();
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(msg({ messageId: 'm' + i, content: '消息' + i, createdAt: at(10, i) }));
  const info = [];
  const warns = [];
  const oneShot = { generate: async () => ({ ok: false, text: '', error: '模型调用失败: 401' }) };
  await generateDaily({
    flow: fakeFlow(rows), reports, oneShot, botId: 'b1', peer: 'group:G1', day,
    settings: { daily: { minMessages: 20, logRuns: false } },
    logger: { info: (m) => info.push(m), warn: (m) => warns.push(m) },
  });
  assert.equal(info.length, 0, 'logRuns=false 关闭常规日志');
  assert.equal(warns.length, 1, '失败日志不受开关影响');
  assert.match(warns[0], /群日报生成失败/);
});