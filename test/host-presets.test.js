/**
 * host-presets —— 装配期 preset：定义形状、幂等注册、失败回落。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  presetKeyFor, presetIdFor, presetDefinitionFor, ensurePreset, isOwnPreset,
} from '../lib/host/presets.js';
import { activeMountPlan } from '../lib/host/tool-mounts.js';

const SETTINGS = { tools: { capabilities: { workspace: true, web: true, skills: true, shell: true, imagegen: true } } };

function fakeCtx(service) {
  return {
    get(name) { return name === 'agentPresets' ? service : undefined; },
  };
}

test('preset 定义：包含压缩组 + 只装配常驻档宿主工具插件', () => {
  const def = presetDefinitionFor(SETTINGS, 'qqbot-buddy-test');
  assert.equal(def.id, 'qqbot-buddy-test');
  assert.ok(def.plugins.some((row) => row.name === 'cordis:group'), '压缩策略必须随 preset 一起走');
  const names = def.plugins.map((row) => row.name).filter(Boolean);
  assert.ok(names.includes('@deepseek-ai/dsh-tool-web'), 'web 是常驻档');
  assert.ok(names.includes('@deepseek-ai/dsh-tool-skill'), 'skill 是常驻档');
  // 文件/命令是被动档：装配期不声明，等 qqbot_enable 点亮
  assert.ok(!names.includes('@deepseek-ai/dsh-tool-fs'), '被动档 fs 不该进 preset');
  assert.ok(!names.includes('@deepseek-ai/dsh-tool-fs-search'), '被动档 fs-search 不该进 preset');
  assert.ok(!names.includes('@deepseek-ai/dsh-tool-bash'), '被动档 bash 不该进 preset');
});

test('preset key：只由能力组合决定，与 per-peer 无关；能力变化才换 key', () => {
  const a = presetKeyFor(SETTINGS);
  const b = presetKeyFor(JSON.parse(JSON.stringify(SETTINGS)));
  assert.equal(a, b, '同样配置必须得到同一个 preset（否则每次都注册新定义）');
  const off = presetKeyFor({ tools: { capabilities: { web: false, skill: false } } });
  assert.notEqual(a, off, '能力变了要换 preset，新 agent 才会用新装配');
  assert.equal(presetIdFor(SETTINGS), 'qqbot-buddy-' + a);
  // 没有常驻档模块时也要有稳定 id（web 默认开，必须显式关掉才会空）
  assert.equal(presetKeyFor({ tools: { capabilities: { web: false, skills: false } } }), 'core');
});

test('ensurePreset：幂等注册，返回我们自己的 id', async () => {
  let registrations = 0;
  const service = { async register(def) { registrations += 1; assert.ok(def && def.id); return async () => {}; } };
  const ctx = fakeCtx(service);
  const first = await ensurePreset({ ctx, settings: SETTINGS });
  const second = await ensurePreset({ ctx, settings: SETTINGS });
  assert.equal(first.own, true);
  assert.equal(second.id, first.id);
  assert.equal(registrations, 1, '同一 key 只注册一次');
  assert.equal(isOwnPreset(ctx, first.id), true);
  assert.equal(isOwnPreset(ctx, 'someone-else'), false);
});

test('ensurePreset：服务缺失/注册失败都返回空 id（调用方回落动态挂载）', async () => {
  const none = await ensurePreset({ ctx: {}, settings: SETTINGS });
  assert.deepEqual(none.id, '');
  assert.equal(none.own, false);

  const broken = await ensurePreset({
    ctx: fakeCtx({ async register() { throw new Error('boom'); } }),
    settings: SETTINGS,
    logger: { debug() {}, warn() {} },
  });
  assert.equal(broken.id, '');
  assert.match(broken.reason, /boom/);
});

test('activeMountPlan：与 preset 定义保持一致（同一份装配计划）', () => {
  const plan = activeMountPlan(SETTINGS).map((item) => item.moduleName);
  const def = presetDefinitionFor(SETTINGS, 'x');
  const rows = def.plugins.map((row) => row.name).filter((name) => name && name !== 'cordis:group');
  assert.deepEqual(rows.sort(), plan.sort());
});
