/**
 * 回归：session-adapter.getOrCreate 必须把 replyTarget 挂到 record 上。
 * 背景：v2 曾经丢掉这个字段 → 出站拿不到 msgId → 退化为主动消息，
 * 表现为「私聊能发、群聊发不出去」（群主动消息权限/W 窗口限制）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionAdapter } from '../lib/qq/session-adapter.js';

function fakeBotRuntime() {
  const sessions = new Map();
  return {
    sessions,
    host: { findSession: () => null, sessionIndex: new Map() },
    async getOrCreate(peer) {
      if (!sessions.has(peer)) sessions.set(peer, { peer, sessionId: 'sid-' + peer, sessions });
      return sessions.get(peer);
    },
    reset: async () => ({ ok: true }),
    settingsFor: () => ({}),
  };
}

test('getOrCreate 保存 replyTarget / senderId（出站被动回复依赖）', async () => {
  const botRuntime = fakeBotRuntime();
  const adapter = createSessionAdapter({ botRuntime });
  const replyTarget = { scope: 'group', targetId: 'GROUP_OPENID', msgId: 'MSG_ID_1', refIdx: 2 };
  const record = await adapter.getOrCreate('group', 'GROUP_OPENID', 'SENDER_OPENID', replyTarget);
  assert.equal(record.replyTarget, replyTarget, 'replyTarget 必须挂到 record 上');
  assert.equal(record.senderId, 'SENDER_OPENID');
});

test('后续消息刷新 replyTarget（不沿用上一条的 msgId）', async () => {
  const botRuntime = fakeBotRuntime();
  const adapter = createSessionAdapter({ botRuntime });
  await adapter.getOrCreate('c2c', 'USER_OPENID', 'USER_OPENID', { scope: 'c2c', targetId: 'USER_OPENID', msgId: 'OLD' });
  const record = await adapter.getOrCreate('c2c', 'USER_OPENID', 'USER_OPENID', { scope: 'c2c', targetId: 'USER_OPENID', msgId: 'NEW' });
  assert.equal(record.replyTarget.msgId, 'NEW');
});
