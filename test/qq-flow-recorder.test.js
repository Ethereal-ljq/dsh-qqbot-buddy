/**
 * qq/flow-recorder —— 全量群消息落库中间件。
 *
 * 位置（门控之前）决定了它能看见「没 @ bot 的消息」；这里用假 flow + 假 assemble
 * 验证开关、过滤与异常兜底，再用真实 assemble 验证正文口径（图片占位）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDb, migrate, openDb } from '../lib/core/db.js';
import { createFlowStore } from '../lib/core/messages/flow.js';
import { createFlowRecorder } from '../lib/qq/flow-recorder.js';

/** 记录所有 append 调用的假 store。 */
function fakeFlow() {
  const rows = [];
  return {
    rows,
    append(input) { rows.push(input); return { ok: true, created: true }; },
    list: () => rows,
  };
}

const settingsFor = (messages = {}) => ({ forPeer: () => ({ messages }) });

/** 构造最小 ctx（字段与 SDK 消息一致）。 */
const ctxOf = (over = {}, state = {}) => ({
  message: {
    kind: 'group',
    groupOpenid: 'G1',
    senderId: 'S1',
    senderName: '朝咱',
    messageId: 'm1',
    msgType: 0,
    content: '这泡馍店也太会做生意了',
    timestamp: '2026-11-12T12:00:00+08:00',
    ...over,
  },
  state,
});

/** 跑一次中间件，返回 next 是否被调用。 */
async function run(mw, ctx) {
  let nexted = false;
  await mw(ctx, async () => { nexted = true; });
  return nexted;
}

const noopLogger = { warn: () => {}, info: () => {}, debug: () => {} };

test('依赖缺失返回 null（flow/botId/assemble 任一缺失）', () => {
  assert.equal(createFlowRecorder({ flow: fakeFlow(), botId: '', logger: noopLogger }), null);
  assert.equal(createFlowRecorder({ flow: null, botId: 'b1', logger: noopLogger }), null);
  assert.equal(createFlowRecorder({ flow: { append() {} }, botId: 'b1', assemble: null, logger: noopLogger }), null);
});

test('群消息：先落库再 next，字段齐全', async () => {
  const flow = fakeFlow();
  const mw = createFlowRecorder({
    flow, botId: 'b1', settings: settingsFor(), sentTracker: { hasId: () => false },
    logger: noopLogger, assemble: () => '正文',
  });
  assert.ok(mw);
  const order = [];
  const ctx = ctxOf();
  await mw(ctx, async () => { order.push('next'); });
  order.unshift('append');
  assert.deepEqual(order, ['append', 'next']);
  assert.equal(flow.rows.length, 1);
  const row = flow.rows[0];
  assert.equal(row.botId, 'b1');
  assert.equal(row.peer, 'group:G1');
  assert.equal(row.messageId, 'm1');
  assert.equal(row.senderId, 'S1');
  assert.equal(row.senderName, '朝咱');
  assert.equal(row.content, '正文');
  assert.equal(row.createdAt, Date.parse('2026-11-12T12:00:00+08:00'));
});

test('真实正文口径：图片消息落成 [图片] 占位（无历史块/发言人前缀）', async () => {
  const flow = fakeFlow();
  const mw = createFlowRecorder({
    flow, botId: 'b1', settings: settingsFor(), sentTracker: { hasId: () => false }, logger: noopLogger,
  });
  const ctx = ctxOf({ content: '', attachments: [{ content_type: 'image/png', filename: 'a.png', url: 'https://cdn/a.png' }] });
  await run(mw, ctx);
  assert.equal(flow.rows.length, 1);
  assert.match(flow.rows[0].content, /\[图片\]/);
  assert.doesNotMatch(flow.rows[0].content, /Chat history/);
  assert.doesNotMatch(flow.rows[0].content, /\[朝咱 \(S1\)\]/);
});

test('空正文不落库（如只有 @ 没有内容）', async () => {
  const flow = fakeFlow();
  const mw = createFlowRecorder({
    flow, botId: 'b1', settings: settingsFor(), sentTracker: { hasId: () => false },
    logger: noopLogger, assemble: () => '',
  });
  assert.equal(await run(mw, ctxOf()), true);
  assert.equal(flow.rows.length, 0);
});

test('私聊不记（只做群流水）', async () => {
  const flow = fakeFlow();
  const mw = createFlowRecorder({
    flow, botId: 'b1', settings: settingsFor(), sentTracker: { hasId: () => false },
    logger: noopLogger, assemble: () => '正文',
  });
  await run(mw, ctxOf({ kind: 'c2c', groupOpenid: undefined }));
  assert.equal(flow.rows.length, 0);
});

test('机器人回声：senderIsBot / sentTracker 命中都不记', async () => {
  const flow = fakeFlow();
  const mw = createFlowRecorder({
    flow, botId: 'b1', settings: settingsFor(), sentTracker: { hasId: (id) => id === 'sent-1' },
    logger: noopLogger, assemble: () => '正文',
  });
  await run(mw, ctxOf({ senderIsBot: true }));
  await run(mw, ctxOf({ messageId: 'sent-1' }));
  assert.equal(flow.rows.length, 0);
});

test('开关：messages.enabled=false 或 captureFlow=false 都不记', async () => {
  const enabledOff = createFlowRecorder({
    flow: fakeFlow(), botId: 'b1', settings: settingsFor({ enabled: false }),
    sentTracker: { hasId: () => false }, logger: noopLogger, assemble: () => '正文',
  });
  const flow = fakeFlow();
  const captureOff = createFlowRecorder({
    flow, botId: 'b1', settings: settingsFor({ captureFlow: false }),
    sentTracker: { hasId: () => false }, logger: noopLogger, assemble: () => '正文',
  });
  await run(enabledOff, ctxOf());
  await run(captureOff, ctxOf());
  assert.equal(flow.rows.length, 0);
});

test('设置读取异常时按默认（记录）处理', async () => {
  const flow = fakeFlow();
  const mw = createFlowRecorder({
    flow, botId: 'b1',
    settings: { forPeer: () => { throw new Error('boom'); } },
    sentTracker: { hasId: () => false }, logger: noopLogger, assemble: () => '正文',
  });
  await run(mw, ctxOf());
  assert.equal(flow.rows.length, 1);
});

test('真实 store：落库后可按 peer/时间查回来', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-flow-rec-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  t.after(() => { closeDb(db); fs.rmSync(dir, { recursive: true, force: true }); });
  const flow = createFlowStore({ db });
  const mw = createFlowRecorder({
    flow, botId: 'b1', settings: settingsFor(), sentTracker: { hasId: () => false }, logger: noopLogger,
  });
  await run(mw, ctxOf());
  const rows = flow.list({ botId: 'b1', peer: 'group:G1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '这泡馍店也太会做生意了');
  assert.equal(rows[0].senderName, '朝咱');
  // 同一条消息重投：store 侧幂等，不产生重复行
  await run(mw, ctxOf());
  assert.equal(flow.list({ botId: 'b1', peer: 'group:G1' }).length, 1);
});

test('落库异常被吞掉，仍继续 next', async () => {
  const mw = createFlowRecorder({
    flow: { append: () => { throw new Error('db down'); } }, botId: 'b1',
    settings: settingsFor(), sentTracker: { hasId: () => false },
    logger: noopLogger, assemble: () => '正文',
  });
  assert.equal(await run(mw, ctxOf()), true);
});
