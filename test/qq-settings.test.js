/**
 * qq-settings —— v2 设置（core/config/schema.js）到 v1 协议设置形状的映射，
 * 以及 session-adapter 的会话反查/重置语义。
 *
 * 这些是「移植后唯一的新接线层」，必须锁住，避免以后改 v2 schema 时协议层静默失效。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { toProtocolSettings, createSettingsView } from '../lib/qq/settings.js';
import { createSessionAdapter } from '../lib/qq/session-adapter.js';

test('默认值：v2 空设置 -> 协议层完整形状（adaptive 模式）', () => {
  const cfg = toProtocolSettings({});
  assert.equal(cfg.reply.enabled, true);
  assert.equal(cfg.reply.groupMode, 'adaptive');
  assert.equal(cfg.reply.adaptive.debounceSeconds, 2, 'debounceMs=1500 -> 2s（四舍五入）');
  assert.equal(cfg.reply.adaptive.cooldownSeconds, 8);
  assert.equal(cfg.reply.adaptive.maxWaitSeconds, 12);
  assert.equal(cfg.reply.bubbleSplit, 'auto');
  assert.equal(cfg.reply.maxBubbles, 4);
  assert.deepEqual(cfg.triggers.keywords, []);
  assert.equal(cfg.admin.enabled, false);
  assert.equal(cfg.vision.inlineImages, true);
  assert.equal(cfg.vision.inlineMaxImages, 4);
});

test('reply.mode -> reply.groupMode：always/mention/probability/interval/adaptive', () => {
  assert.equal(toProtocolSettings({ reply: { mode: 'always' } }).reply.groupMode, 'all');
  assert.equal(toProtocolSettings({ reply: { mode: 'probability', probability: 0.5 } }).reply.groupMode, 'probability');
  assert.equal(toProtocolSettings({ reply: { mode: 'probability', probability: 0.5 } }).reply.probability, 0.5);
  assert.equal(toProtocolSettings({ reply: { mode: 'interval', intervalMs: 90000 } }).reply.groupMode, 'interval');
  assert.equal(toProtocolSettings({ reply: { mode: 'interval', intervalMs: 90000 } }).reply.intervalSeconds, 90);
  assert.equal(toProtocolSettings({ reply: { mode: 'adaptive' } }).reply.groupMode, 'adaptive');
  // 未知 mode 回落到 adaptive（与 schema 默认一致）
  assert.equal(toProtocolSettings({ reply: { mode: 'nope' } }).reply.groupMode, 'adaptive');
});

test('reply.mode=mention：用 count 极大阈值实现「非 @/引用/关键词一律不回」', () => {
  const cfg = toProtocolSettings({ reply: { mode: 'mention' } });
  assert.equal(cfg.reply.groupMode, 'mention');
  assert.ok(cfg.reply.countThreshold > 1e6, '阈值必须大到永不累计触发');
  assert.equal(cfg.reply.flushAfterSeconds, 0, '不允许 flush 兜底回复');
});

test('triggers：mentionAlways/quoteAlways/keywordsAlways 控制强制触发', () => {
  const on = toProtocolSettings({
    reply: { mentionAlways: true, quoteAlways: true, keywordsAlways: true, keywords: ['报时', '   ', '帮助'] },
  });
  assert.equal(on.triggers.onMention, true);
  assert.equal(on.triggers.onReplyToBot, true);
  assert.deepEqual(on.triggers.keywords, ['报时', '帮助'], '空白关键词应被过滤');

  const off = toProtocolSettings({
    reply: { mentionAlways: false, quoteAlways: false, keywordsAlways: false, keywords: ['报时'] },
  });
  assert.equal(off.triggers.onMention, false);
  assert.equal(off.triggers.onReplyToBot, false);
  assert.deepEqual(off.triggers.keywords, [], 'keywordsAlways=false 时关键词不生效');
});

test('气泡拆分与管理员/愿景映射', () => {
  const cfg = toProtocolSettings({
    reply: { splitBubbles: false, maxBubbles: 2 },
    admin: { enabled: true, openids: ['OU_1', ' ', 'OU_2'] },
    vision: { inlineImages: false, inlineMaxImages: 2, inlineMaxBytes: 1024 * 1024 },
  });
  assert.equal(cfg.reply.bubbleSplit, 'off');
  assert.equal(cfg.reply.maxBubbles, 2);
  assert.deepEqual(cfg.admin.openids, ['OU_1', 'OU_2']);
  assert.equal(cfg.admin.enabled, true);
  assert.equal(cfg.vision.inlineImages, false);
  assert.equal(cfg.vision.inlineMaxImages, 2);
  assert.equal(cfg.vision.inlineMaxBytes, 1024 * 1024);
});

test('createSettingsView：按 peer 现读（作用域绑定生效），get() 读 bot 级默认', () => {
  const seen = [];
  const view = createSettingsView({
    botRuntime: {
      settingsFor(peer) {
        seen.push(peer);
        if (peer === 'group:G1') return { reply: { mode: 'always' } };
        if (peer === 'c2c:U1') return { reply: { enabled: false } };
        return { reply: { mode: 'mention' } };
      },
    },
  });
  assert.equal(view.forPeer('group:G1').reply.groupMode, 'all');
  assert.equal(view.forPeer('c2c:U1').reply.enabled, false);
  assert.equal(view.get().reply.groupMode, 'mention');
  assert.equal(seen[0], 'group:G1');

  const store = view.forPeerAsStore('group:G1');
  assert.equal(store.get().reply.groupMode, 'all', 'forPeerAsStore 只认 get() 的旧模块也应拿到 peer 设置');
});

test('createSettingsView：settingsFor 抛错时回落默认值，不影响聊天', () => {
  const view = createSettingsView({ botRuntime: { settingsFor() { throw new Error('db down'); } } });
  const cfg = view.forPeer('group:G1');
  assert.equal(cfg.reply.groupMode, 'adaptive');
  assert.equal(cfg.reply.enabled, true);
});

// ── session-adapter ──────────────────────────────────────
function createAdapterRig() {
  const sessions = new Map();
  const disposed = [];
  const indexed = new Map();
  const host = {
    ctx: { marker: 'ctx' },
    sessionIndex: indexed,
    findSession(sessionId) {
      for (const record of sessions.values()) {
        if (String(record.sessionId) === String(sessionId)) return { botId: 'bot-1', peer: record.peer, runtime: botRuntime };
      }
      return null;
    },
  };
  const botRuntime = {
    id: 'bot-1',
    host,
    sessions,
    settingsFor: () => ({ model: { provider: 'p', model: 'm' } }),
    async getOrCreate(peer) {
      let record = sessions.get(peer);
      if (!record) {
        record = { peer, sessionId: 'sid-' + peer, agent: {}, handle: { dispose: async () => { disposed.push(peer); } }, settings: {} };
        sessions.set(peer, record);
        indexed.set(record.sessionId, { botId: 'bot-1', peer, runtime: botRuntime });
      }
      return record;
    },
  };
  return { host, botRuntime, sessions, disposed, adapter: createSessionAdapter({ botRuntime }) };
}

test('session-adapter：scope/peerId -> peer，getOrCreate/getSessionRecord/findBySessionId 闭环', async () => {
  const { adapter } = createAdapterRig();
  assert.equal(adapter.size, 0);
  assert.equal(adapter.getSessionRecord('group', 'G1'), null);

  const record = await adapter.getOrCreate('group', 'G1');
  assert.equal(record.peer, 'group:G1');
  assert.equal(adapter.size, 1);
  assert.equal(adapter.getSessionRecord('group', 'G1'), record);
  assert.equal(adapter.findBySessionId('sid-group:G1'), record);
  assert.equal(adapter.findBySessionId('nope'), null);
  assert.equal(adapter.ctx.marker, 'ctx');
});

test('session-adapter：reset 释放 handle 并移除映射；resolveModelRouteFor 读 settings', async () => {
  const { adapter, sessions, disposed, host } = createAdapterRig();
  const record = await adapter.getOrCreate('c2c', 'U1');
  sessions.get('c2c:U1').settings = { model: { provider: 'deepseek', model: 'chat' } };
  host.sessionIndex.set('sid-c2c:U1', { botId: 'bot-1', peer: 'c2c:U1', runtime: { sessions } });

  const route = adapter.resolveModelRouteFor(record);
  assert.deepEqual(route.route, { provider: 'deepseek', model: 'chat' });

  const result = await adapter.reset('c2c', 'U1');
  assert.deepEqual(result, { resumable: 0 });
  assert.deepEqual(disposed, ['c2c:U1']);
  assert.equal(adapter.getSessionRecord('c2c', 'U1'), null);
  assert.equal(adapter.findBySessionId('sid-c2c:U1'), null);
});
test('session-adapter.reset 走 host BotRuntime.reset：epoch 轮换的结果原样透出（/new 真清空）', async () => {
  const { adapter, botRuntime, sessions } = createAdapterRig();
  const record = await adapter.getOrCreate('group', 'G1');
  const calls = [];
  botRuntime.reset = async (peer) => {
    calls.push(peer);
    sessions.delete(peer);
    return { ok: true, epoch: 3, oldSessionId: 'sid-old', newSessionId: 'sid-new' };
  };
  const result = await adapter.reset('group', 'G1');
  assert.deepEqual(calls, ['group:G1']);
  assert.deepEqual(result, { resumable: 0, ok: true, epoch: 3, oldSessionId: 'sid-old', newSessionId: 'sid-new' });
  assert.equal(adapter.getSessionRecord('group', 'G1'), null);
  void record;
});

test('session-adapter.reset：host 未提供 reset 时退化为只释放当前会话', async () => {
  const { adapter, sessions, disposed } = createAdapterRig();
  await adapter.getOrCreate('c2c', 'U2');
  const result = await adapter.reset('c2c', 'U2');
  assert.deepEqual(result, { resumable: 0 });
  assert.deepEqual(disposed, ['c2c:U2']);
  assert.equal(sessions.size, 0);
});
