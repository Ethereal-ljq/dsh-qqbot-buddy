/**
 * test/adaptive-gate.test.js —— adaptive 回复模式的 decide 决策用例（追加需求 2026-10-26 晚）。
 *
 * 覆盖：adaptive 非强制触发返回 buffer=true 且不触发、不累计 pending、不走 minGap；
 * @/回复机器人/关键词/命令仍立即触发；总开关/群聊关闭/私聊行为不变；其它模式不受影响。
 * 只依赖 lib/qq/gate.js（纯函数）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGateState, decide, pendingSnapshot, recordSkip } from '../lib/qq/gate.js';

const NOW = 1_700_000_000_000;

/** 构造完整 Settings（默认对齐 resolveDefaults，独立于它避免耦合）。 */
function makeSettings(overrides = {}) {
  const reply = Object.assign({
    enabled: true,
    groupEnabled: true,
    groupMode: 'adaptive',
    countThreshold: 3,
    flushAfterSeconds: 0,
    intervalSeconds: 90,
    probability: 0.25,
    minGapSeconds: 0,
    c2cEnabled: true,
    adaptive: {
      debounceSeconds: 4,
      cooldownSeconds: 12,
      maxWaitSeconds: 20,
      requireRelevance: true,
    },
  }, overrides.reply || {});
  const triggers = Object.assign({
    onMention: true,
    onReplyToBot: true,
    keywords: [],
  }, overrides.triggers || {});
  return { version: 1, reply, triggers, persona: {}, memory: {}, behavior: {} };
}

function decideGroup(args = {}) {
  const { settings, ...rest } = args;
  return decide(Object.assign({
    settings: settings || makeSettings(),
    peerKey: 'group:g1',
    scope: 'group',
    content: '随便聊聊',
    now: NOW,
    state: createGateState(),
  }, rest));
}

test('adaptive：非强制触发返回 buffer=true、不 trigger、不累计 pending', () => {
  const state = createGateState();
  const d = decideGroup({ state });
  assert.equal(d.trigger, false);
  assert.equal(d.buffer, true);
  assert.equal(d.reason, 'adaptive');
  assert.equal(d.forced, false);
  assert.equal(d.resetPending, false);
  assert.deepEqual(pendingSnapshot(state, NOW), [], 'adaptive 不应写入 gate pending');
  assert.equal(state.peers.size, 0);
});

test('adaptive：@ 机器人仍立即触发（mention，buffer=false）', () => {
  const d = decideGroup({ wasMentioned: true });
  assert.equal(d.trigger, true);
  assert.equal(d.buffer, false);
  assert.equal(d.reason, 'mention');
  assert.equal(d.forced, true);
  assert.equal(d.resetPending, true);
});

test('adaptive：回复机器人消息仍立即触发（reply）', () => {
  const d = decideGroup({ isReplyToBot: true });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'reply');
  assert.equal(d.forced, true);
});

test('adaptive：关键词命中仍立即触发（keyword）；未命中走 buffer', () => {
  const settings = makeSettings({ triggers: { keywords: ['紧急'] } });
  const hit = decideGroup({ settings, content: '这是紧急情况' });
  assert.equal(hit.trigger, true);
  assert.equal(hit.reason, 'keyword');
  assert.equal(hit.forced, true);
  const miss = decideGroup({ settings, content: '今天天气不错' });
  assert.equal(miss.trigger, false);
  assert.equal(miss.buffer, true);
  assert.equal(miss.reason, 'adaptive');
});

test('adaptive：命令消息兜底仍立即触发（command）', () => {
  const d = decideGroup({ isCommand: true, content: '/status' });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'command');
  assert.equal(d.forced, true);
});

test('adaptive：总开关/群聊关闭时 skip disabled，不进入 buffer', () => {
  const disabled = decideGroup({ settings: makeSettings({ reply: { enabled: false } }) });
  assert.deepEqual(disabled, { trigger: false, buffer: false, reason: 'disabled', forced: false, resetPending: false });
  const groupOff = decideGroup({ settings: makeSettings({ reply: { groupEnabled: false } }) });
  assert.equal(groupOff.reason, 'disabled');
  assert.equal(groupOff.buffer, false);
});

test('adaptive：私聊行为不变（c2cEnabled 打开必回，关闭 disabled）', () => {
  const settings = makeSettings();
  const on = decide({ settings, scope: 'c2c', peerKey: 'c2c:u1', content: '在吗', now: NOW, state: createGateState() });
  assert.equal(on.trigger, true);
  assert.equal(on.reason, 'c2c');
  assert.equal(on.forced, true);
  const off = decide({
    settings: makeSettings({ reply: { c2cEnabled: false } }),
    scope: 'c2c', peerKey: 'c2c:u1', content: '在吗', now: NOW, state: createGateState(),
  });
  assert.equal(off.trigger, false);
  assert.equal(off.reason, 'disabled');
});

test('adaptive：不走 minGap（冷却期间也返回 buffer，而不是 cooldown）', () => {
  const settings = makeSettings({ reply: { minGapSeconds: 3600 } });
  const state = createGateState();
  const d = decideGroup({ settings, state, lastReplyAt: NOW - 1000 });
  assert.equal(d.reason, 'adaptive');
  assert.equal(d.buffer, true);
  assert.equal(d.trigger, false);
});

test('adaptive：空文本也 buffer（图片/媒体消息同样交给 scheduler）', () => {
  const d = decideGroup({ content: '   ' });
  assert.equal(d.buffer, true);
  assert.equal(d.reason, 'adaptive');
});

test('adaptive：强制触发开关关闭时退化为 buffer', () => {
  const settings = makeSettings({ triggers: { onMention: false, onReplyToBot: false } });
  const mention = decideGroup({ settings, wasMentioned: true });
  assert.equal(mention.buffer, true);
  assert.equal(mention.reason, 'adaptive');
  const reply = decideGroup({ settings, isReplyToBot: true });
  assert.equal(reply.buffer, true);
});

test('其它模式不受 adaptive 影响：count 仍 skip/trigger、buffer=false', () => {
  const countSettings = makeSettings({ reply: { groupMode: 'count', countThreshold: 2 } });
  const state = createGateState();
  const first = decideGroup({ settings: countSettings, state, content: '一' });
  assert.equal(first.trigger, false);
  assert.equal(first.buffer, false);
  assert.equal(first.reason, 'mode');
  recordSkip(state, 'group:g1', NOW + 1000);
  const second = decideGroup({ settings: countSettings, state, content: '二', now: NOW + 1000 });
  assert.equal(second.trigger, true);
  assert.equal(second.buffer, false);
});