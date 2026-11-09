/**
 * gate 单测 —— 覆盖 4 种 mode、强制触发（mention/reply/keyword/c2c/command）、
 * minGap cooldown、count flush、interval、probability 0/1、disabled、空消息、
 * pending 快照与清空。
 *
 * 只依赖 lib/qq/gate.js（纯函数，无 IO / 无定时器 / 无第三方依赖）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createGateState,
  decide,
  recordTrigger,
  recordSkip,
  pendingSnapshot,
  clearPending,
} from '../lib/qq/gate.js';

/** 固定基准时间，避免 Date.now() 抖动影响边界断言。 */
const NOW = 1_700_000_000_000;

/** 构造完整 Settings（默认值对齐 settings-store.resolveDefaults，但独立于它，避免测试耦合）。 */
function makeSettings(overrides = {}) {
  const reply = Object.assign({
    enabled: true,
    groupEnabled: true,
    groupMode: 'count',
    countThreshold: 3,
    flushAfterSeconds: 120,
    intervalSeconds: 90,
    probability: 0.25,
    minGapSeconds: 0,
    c2cEnabled: true,
  }, overrides.reply || {});
  const triggers = Object.assign({
    onMention: true,
    onReplyToBot: true,
    keywords: [],
  }, overrides.triggers || {});
  return { version: 1, reply, triggers, persona: {}, memory: {}, behavior: {} };
}

/** decide 的默认参数封装：群聊 + 固定 now + 全新 state。 */
function decideGroup(args = {}) {
  const settings = args.settings || makeSettings();
  const { settings: ignored, ...rest } = args;
  return decide(Object.assign({
    settings,
    peerKey: 'group:g1',
    scope: 'group',
    now: NOW,
    state: createGateState(),
  }, rest));
}

// ── 1. all 模式 ─────────────────────────────────────────────
test('all 模式：群聊每条消息都触发（非强制，reason=mode）', () => {
  const settings = makeSettings({ reply: { groupMode: 'all' } });
  const d = decideGroup({ settings, content: '随便聊聊' });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'mode');
  assert.equal(d.forced, false);
  assert.equal(d.resetPending, true);
});

// ── 2. count 模式 ───────────────────────────────────────────
test('count 模式：累计到阈值才触发，触发后清空 pending', () => {
  const settings = makeSettings({ reply: { countThreshold: 3, flushAfterSeconds: 0 } });
  const state = createGateState();

  let d = decide({ settings, peerKey: 'group:g1', content: '第一条', now: NOW, state });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'mode');
  recordSkip(state, 'group:g1', NOW);

  d = decide({ settings, peerKey: 'group:g1', content: '第二条', now: NOW + 1000, state });
  assert.equal(d.trigger, false);
  recordSkip(state, 'group:g1', NOW + 1000);

  d = decide({ settings, peerKey: 'group:g1', content: '第三条', now: NOW + 2000, state });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'mode');
  assert.equal(d.forced, false);

  recordTrigger(state, 'group:g1', NOW + 2000, d.reason);
  assert.deepEqual(pendingSnapshot(state, NOW + 2000), []);
  assert.equal(state.lastReplyAt, NOW + 2000);
  assert.equal(state.lastTriggerReason, 'mode');
});

test('count 模式：threshold=1 时每条都触发', () => {
  const settings = makeSettings({ reply: { countThreshold: 1 } });
  const d = decideGroup({ settings, content: 'hi' });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'mode');
});

test('count 模式 flush：pending 最早一条等待超过 flushAfterSeconds 就回复', () => {
  const settings = makeSettings({ reply: { countThreshold: 10, flushAfterSeconds: 60 } });
  const state = createGateState();
  recordSkip(state, 'group:g1', NOW);
  recordSkip(state, 'group:g1', NOW + 1000);

  // 才过 30s，不到 flush 阈值，且总数不够 -> 跳过
  let d = decide({ settings, peerKey: 'group:g1', content: 'x', now: NOW + 30000, state });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'mode');

  // 过 61s，flush 触发
  d = decide({ settings, peerKey: 'group:g1', content: 'x', now: NOW + 61000, state });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'flush');
  assert.equal(d.forced, false);
});

test('count 模式 flushAfterSeconds=0 表示关闭，不 flush', () => {
  const settings = makeSettings({ reply: { countThreshold: 10, flushAfterSeconds: 0 } });
  const state = createGateState();
  recordSkip(state, 'group:g1', NOW);
  const d = decide({ settings, peerKey: 'group:g1', content: 'x', now: NOW + 999_999, state });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'mode');
});

// ── 3. interval 模式 ────────────────────────────────────────
test('interval 模式：距上次回复不足间隔则跳过，超过间隔触发', () => {
  const settings = makeSettings({ reply: { groupMode: 'interval', intervalSeconds: 90 } });

  let d = decideGroup({ settings, content: 'hi', lastReplyAt: NOW - 10_000 });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'mode');

  d = decideGroup({ settings, content: 'hi', lastReplyAt: NOW - 90_000 });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'mode');
  assert.equal(d.forced, false);

  // 从未回复过 -> 首次必回
  d = decideGroup({ settings, content: 'hi', lastReplyAt: 0 });
  assert.equal(d.trigger, true);
});

test('interval 模式：lastReplyAt 缺省时读 state.lastReplyAt', () => {
  const settings = makeSettings({ reply: { groupMode: 'interval', intervalSeconds: 90 } });
  const state = createGateState();
  state.lastReplyAt = NOW - 5_000;
  const d = decide({ settings, peerKey: 'group:g1', content: 'hi', now: NOW, state });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'mode');
});

// ── 4. probability 模式 ─────────────────────────────────────
test('probability 模式：0 永不触发、1 必触发、0.5 按注入随机数决策', () => {
  const p0 = makeSettings({ reply: { groupMode: 'probability', probability: 0 } });
  let d = decideGroup({ settings: p0, content: 'hi' });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'mode');

  const p1 = makeSettings({ reply: { groupMode: 'probability', probability: 1 } });
  d = decideGroup({ settings: p1, content: 'hi' });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'mode');

  const pHalf = makeSettings({ reply: { groupMode: 'probability', probability: 0.5 } });
  d = decideGroup({ settings: pHalf, content: 'hi', random: () => 0.1 });
  assert.equal(d.trigger, true);
  d = decideGroup({ settings: pHalf, content: 'hi', random: () => 0.9 });
  assert.equal(d.trigger, false);
});

// ── 5. 强制触发 ─────────────────────────────────────────────
test('强制触发：@ 机器人（不依赖模式阈值）', () => {
  const settings = makeSettings({ reply: { groupMode: 'count', countThreshold: 100 } });
  const d = decideGroup({ settings, content: '在吗', wasMentioned: true });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'mention');
  assert.equal(d.forced, true);
});

test('强制触发：回复机器人消息', () => {
  const settings = makeSettings({ reply: { groupMode: 'count', countThreshold: 100 } });
  const d = decideGroup({ settings, content: '继续', isReplyToBot: true });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'reply');
  assert.equal(d.forced, true);
});

test('强制触发：命中关键词（英文忽略大小写）', () => {
  const settings = makeSettings({
    reply: { groupMode: 'count', countThreshold: 100 },
    triggers: { keywords: ['帮助', 'Help'] },
  });
  let d = decideGroup({ settings, content: '需要帮助' });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'keyword');

  d = decideGroup({ settings, content: 'please HELP me' });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'keyword');

  d = decideGroup({ settings, content: '无关内容' });
  assert.equal(d.trigger, false);
});

test('强制触发开关关闭后，@ / 回复 / 关键词不再强制（回落到模式决策）', () => {
  const settings = makeSettings({
    reply: { groupMode: 'count', countThreshold: 100 },
    triggers: { onMention: false, onReplyToBot: false, keywords: ['帮助'] },
  });
  let d = decideGroup({ settings, content: '在吗', wasMentioned: true });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'mode');

  d = decideGroup({ settings, content: '继续', isReplyToBot: true });
  assert.equal(d.trigger, false);

  // keywords 仍打开，所以关键词继续强制（关键词没有独立开关）
  d = decideGroup({ settings, content: '帮助我' });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'keyword');
});

test('强制触发优先于 minGap（强制回复不受最小间隔限制）', () => {
  const settings = makeSettings({ reply: { minGapSeconds: 60, groupMode: 'all' } });
  const d = decideGroup({ settings, content: '在吗', wasMentioned: true, lastReplyAt: NOW - 1000 });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'mention');
});

// ── 6. c2c / command ────────────────────────────────────────
test('私聊：c2cEnabled 打开时必回（reason=c2c, forced）', () => {
  const settings = makeSettings();
  const d = decide({ settings, scope: 'c2c', peerKey: 'c2c:u1', content: '你好', now: NOW, state: createGateState() });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'c2c');
  assert.equal(d.forced, true);
});

test('私聊：c2cEnabled 关闭时不回', () => {
  const settings = makeSettings({ reply: { c2cEnabled: false } });
  const d = decide({ settings, scope: 'c2c', peerKey: 'c2c:u1', content: '你好', now: NOW, state: createGateState() });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'disabled');
});

test('命令消息：即使总开关关闭也触发（reason=command）', () => {
  const settings = makeSettings({ reply: { enabled: false } });
  const d = decideGroup({ settings, content: '/status', isCommand: true });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'command');
  assert.equal(d.forced, true);
});

// ── 7. disabled / empty ─────────────────────────────────────
test('总开关关闭：@ 机器人也不回（commands 除外）', () => {
  const settings = makeSettings({ reply: { enabled: false } });
  const d = decideGroup({ settings, content: '在吗', wasMentioned: true });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'disabled');
});

test('群聊开关关闭：群消息不回，私聊不受影响', () => {
  const settings = makeSettings({ reply: { groupEnabled: false } });
  const g = decideGroup({ settings, content: '在吗', wasMentioned: true });
  assert.equal(g.trigger, false);
  assert.equal(g.reason, 'disabled');

  const c = decide({ settings, scope: 'c2c', peerKey: 'c2c:u1', content: '你好', now: NOW, state: createGateState() });
  assert.equal(c.trigger, true);
  assert.equal(c.reason, 'c2c');
});

test('空消息（无文本）且未触发：reason=empty；all 模式下仍按模式触发', () => {
  const countSettings = makeSettings({ reply: { countThreshold: 10 } });
  let d = decideGroup({ settings: countSettings, content: '   ' });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'empty');

  // 空文本但被 @ -> 仍强制触发（图片/表情包消息也常无文本）
  d = decideGroup({ settings: countSettings, content: '', wasMentioned: true });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'mention');

  const allSettings = makeSettings({ reply: { groupMode: 'all' } });
  d = decideGroup({ settings: allSettings, content: '' });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'mode');
});

// ── 8. minGap cooldown ──────────────────────────────────────
test('minGapSeconds：非强制触发被冷却拦下（reason=cooldown），超过间隔后放行', () => {
  const settings = makeSettings({ reply: { minGapSeconds: 60, groupMode: 'all' } });

  let d = decideGroup({ settings, content: 'hi', lastReplyAt: NOW - 10_000 });
  assert.equal(d.trigger, false);
  assert.equal(d.reason, 'cooldown');

  d = decideGroup({ settings, content: 'hi', lastReplyAt: NOW - 61_000 });
  assert.equal(d.trigger, true);
  assert.equal(d.reason, 'mode');

  // 从未回复过不触发冷却
  d = decideGroup({ settings, content: 'hi', lastReplyAt: 0 });
  assert.equal(d.trigger, true);

  // minGap=0 表示关闭
  const noGap = makeSettings({ reply: { minGapSeconds: 0, groupMode: 'all' } });
  d = decideGroup({ settings: noGap, content: 'hi', lastReplyAt: NOW - 1000 });
  assert.equal(d.trigger, true);
});

// ── 9. pending 快照 / 清理 ──────────────────────────────────
test('pendingSnapshot：按等待时间倒序，count / scope / peerId 正确；clearPending 清空', () => {
  const state = createGateState();
  const now = NOW + 10_000;
  recordSkip(state, 'group:g1', NOW);
  recordSkip(state, 'group:g1', NOW + 2000);
  recordSkip(state, 'c2c:u1', NOW + 9000);

  const snap = pendingSnapshot(state, now);
  assert.equal(snap.length, 2);
  assert.equal(snap[0].peerKey, 'group:g1');
  assert.equal(snap[0].scope, 'group');
  assert.equal(snap[0].peerId, 'g1');
  assert.equal(snap[0].count, 2);
  assert.equal(snap[0].waitingMs, 10_000);
  assert.equal(snap[1].peerKey, 'c2c:u1');
  assert.equal(snap[1].count, 1);
  assert.equal(snap[1].waitingMs, 1000);

  clearPending(state);
  assert.deepEqual(pendingSnapshot(state, now), []);
});

test('recordTrigger 清空该 peer pending，但不影响其它 peer', () => {
  const state = createGateState();
  recordSkip(state, 'group:g1', NOW);
  recordSkip(state, 'group:g2', NOW);
  recordTrigger(state, 'group:g1', NOW + 1, 'mention');
  const snap = pendingSnapshot(state, NOW + 2);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].peerKey, 'group:g2');
});

test('recordSkip 对同一 peer 连续累积，超过上限时裁剪最旧的', () => {
  const state = createGateState();
  for (let i = 0; i < 250; i += 1) recordSkip(state, 'group:g1', NOW + i);
  const snap = pendingSnapshot(state, NOW + 300);
  assert.equal(snap[0].count, 200);
  assert.equal(state.totalSkips, 250);
});
