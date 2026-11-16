/**
 * console tool states —— 工具页三态（已装载 / 已声明 / 索引中）。
 *
 * 这三列回答的是不同问题，不能合并：
 *   已装载 = 插件注册到会话（可被调用/可被点亮）；
 *   已声明 = 进本次请求的 tools schema（占 token）；
 *   索引中 = 只在提示词索引里出现名字，装载后下一步进 schema。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanupToolsPolicy, disabledReasonOf, stalePolicyEntries, toolStateOf } from '../lib/console/api/tools.js';

const CAPS = (patch = {}) => ({
  tools: {
    capabilities: { workspace: true, web: true, stickers: true, voice: true, imagegen: true, ...patch },
  },
});

test('已声明：常驻档插件工具（qqbot_send_file）', () => {
  const state = toolStateOf({ settings: CAPS(), name: 'qqbot_send_file', source: 'qqbot' });
  assert.equal(state.state, 'declared');
  assert.equal(state.loaded, true);
  assert.equal(state.declared, true);
  assert.equal(state.indexed, false);
});

test('索引中：被动档插件工具（qqbot_speak），装载但未声明', () => {
  const state = toolStateOf({
    settings: CAPS(), name: 'qqbot_speak', source: 'qqbot', capability: 'voice', tier: 'passive', group: 'voice',
  });
  assert.equal(state.state, 'indexed');
  assert.equal(state.loaded, true, '插件工具在 agent 启动时就注册了');
  assert.equal(state.declared, false);
  assert.equal(state.indexed, true);
  assert.match(state.reason, /装载后/);
});

test('已声明：宿主常驻档工具（web_search，模块在装配计划里）', () => {
  const state = toolStateOf({
    settings: CAPS(),
    name: 'web_search',
    source: 'host',
    tier: 'active',
    group: null,
    mountedCapabilities: new Set(['web']),
  });
  assert.equal(state.state, 'declared');
  assert.equal(state.loaded, true);
  assert.equal(state.declared, true);
});

test('索引中：宿主被动档工具（read），所属模块不在装配计划里', () => {
  const state = toolStateOf({
    settings: CAPS(),
    name: 'read',
    source: 'host',
    tier: 'passive',
    mountedCapabilities: new Set(['web']),
  });
  assert.equal(state.state, 'indexed');
  assert.equal(state.loaded, false, 'fs 模块没有常驻档工具 → 装配期不挂载');
  assert.equal(state.declared, false);
  assert.equal(state.indexed, true, '但它在【按需能力】索引里，可以 qqbot_enable 点亮');
  assert.match(state.reason, /未装配/);
});

test('已声明：被动档被覆盖成常驻后，随模块一起装配', () => {
  const state = toolStateOf({
    settings: CAPS(),
    name: 'read',
    source: 'host',
    tier: 'active',
    mountedCapabilities: new Set(['workspace']),
  });
  assert.equal(state.state, 'declared');
  assert.equal(state.loaded, true);
  assert.equal(state.declared, true);
});

test('不可用：能力关闭 / 黑名单 / 白名单外', () => {
  const off = toolStateOf({ settings: CAPS({ imagegen: false }), name: 'generate_image', source: 'host' });
  assert.equal(off.state, 'disabled');
  assert.equal(off.loaded, false);
  assert.match(off.reason, /能力「imagegen」未开启/);

  const denied = toolStateOf({ settings: { tools: { deny: ['web_search'] } }, name: 'web_search', source: 'host' });
  assert.equal(denied.state, 'disabled');
  assert.match(denied.reason, /黑名单/);

  const notAllowed = toolStateOf({
    settings: { tools: { mode: 'allow', allow: ['qqbot_send_file'] } },
    name: 'web_search',
    source: 'host',
  });
  assert.equal(notAllowed.state, 'disabled');
  assert.match(notAllowed.reason, /不在白名单/);
});

test('全局工具（画布/工作目录）：按需档 → 待唤醒；没有分组 → 不可用；常驻档才每轮发送', () => {
  const indexed = toolStateOf({
    settings: CAPS(), name: 'canvas_state', source: 'host', tier: 'passive', group: 'canvas', restrictable: true,
  });
  assert.equal(indexed.state, 'indexed', '画布工具不在 schema 里，不能标每轮发送');
  assert.equal(indexed.declared, false);
  assert.equal(indexed.indexed, true);

  const noGroup = toolStateOf({
    settings: CAPS(), name: 'working_directory', source: 'host', tier: 'passive', group: null, restrictable: true,
  });
  assert.equal(noGroup.state, 'disabled');
  assert.match(noGroup.reason, /常驻/);

  const active = toolStateOf({
    settings: CAPS(), name: 'canvas_state', source: 'host', tier: 'active', group: 'canvas', restrictable: true,
  });
  assert.equal(active.state, 'declared');

  const scopeLocal = toolStateOf({
    settings: CAPS(), name: 'some_plugin_tool', source: 'plugin', tier: 'passive', restrictable: false,
  });
  assert.equal(scopeLocal.state, 'declared', 'agent scope 自带工具不受 restrict 影响');
});

test('qqbot_enable：force 注册，不在白名单也算每轮发送；显式 deny 才屏蔽', () => {
  const allowMode = { tools: { mode: 'allow', allow: ['qqbot_send_file'] } };
  const meta = toolStateOf({ settings: allowMode, name: 'qqbot_enable', source: 'qqbot', tier: 'active' });
  assert.equal(meta.state, 'declared');

  const denied = toolStateOf({ settings: { tools: { deny: ['qqbot_enable'] } }, name: 'qqbot_enable', source: 'qqbot', tier: 'active' });
  assert.equal(denied.state, 'disabled');
  assert.match(denied.reason, /黑名单/);

  const team = toolStateOf({ settings: allowMode, name: 'team_task_create', source: 'host', tier: 'active' });
  assert.equal(team.state, 'disabled', '普通工具仍按白名单判定');
});

test('没有配置档时三态都是 unknown（控制台不瞎标）', () => {
  const state = toolStateOf({ settings: null, name: 'read', source: 'host' });
  assert.equal(state.state, 'unknown');
  assert.equal(state.loaded, null);
  assert.equal(state.declared, null);
  assert.equal(state.indexed, null);
});

test('失效条目：策略里指向已不存在的工具/分组才报（别名 / 能力 key 不算）', () => {
  const discovered = ['qqbot_send_file', 'qqbot_speak', 'read', 'web_search', 'bash'];
  const stale = stalePolicyEntries({
    allow: ['qqbot_send_file', 'qqbot_send_voice', 'ghost_tool', 'imagegen'],
    deny: ['dead_tool'],
    tiers: { bash: 'active', workspace: 'passive', shell: 'passive', ghost: 'active' },
  }, discovered);
  // qqbot_send_voice 是兼容别名（目标 qqbot_speak 存在）→ 不算失效
  // imagegen 是分组 id、workspace/shell 是分组、bash 是分组 → 不算失效
  assert.deepEqual(stale.map((item) => item.where + ':' + item.name), [
    'allow:ghost_tool',
    'deny:dead_tool',
    'tiers:ghost',
  ]);
  assert.deepEqual(stalePolicyEntries({ allow: [], deny: [], tiers: {} }, discovered), []);
});

test('清理失效工具：只删「当前环境不存在」的条目，tiers 用 null 覆盖', () => {
  const policy = {
    mode: 'allow',
    allow: ['qqbot_send_file', 'ghost_tool'],
    deny: ['dead_tool', 'other_tool'],
    tiers: { qqbot_send_file: 'active', ghost_tier: 'passive', shell: 'passive' },
  };
  const { next, removed } = cleanupToolsPolicy({
    policy,
    discoveredNames: ['qqbot_send_file', 'other_tool'],
  });
  assert.deepEqual(removed.map((item) => item.where + ':' + item.name), ['allow:ghost_tool', 'deny:dead_tool', 'tiers:ghost_tier']);
  assert.deepEqual(next.allow, ['qqbot_send_file']);
  assert.deepEqual(next.deny, ['other_tool']);
  assert.equal(next.tiers.ghost_tier, null, 'tiers 对象键无法从 deepMerge 删除，用 null 覆盖让读取层丢弃');
  assert.equal(next.tiers.qqbot_send_file, 'active');
  assert.equal(next.tiers.shell, 'passive', '分组 id 永远合法，不能被清掉');
  // 没东西可清时不改任何值
  const clean = cleanupToolsPolicy({ policy: { mode: 'allow', allow: [], deny: [], tiers: {} }, discoveredNames: ['x'] });
  assert.deepEqual(clean.removed, []);
});

test('disabledReasonOf：无能力归属的工具默认放行', () => {
  assert.equal(disabledReasonOf({ tools: {} }, 'some_mcp_tool'), '被工具策略过滤');
});
