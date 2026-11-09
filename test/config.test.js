import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../lib/core/db.js';
import { createConfigStore } from '../lib/core/config/store.js';
import { normalize, defaults, deepMerge } from '../lib/core/config/schema.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-cfg-'));
  const db = openDb(path.join(dir, 'test.db'));
  const store = createConfigStore({ db, workspaceRoot: dir });
  return { db, store, dir };
}

test('schema 归一化：未知键告警、类型纠正、边界截断', () => {
  const { value, warnings } = normalize({ reply: { mode: 'nope', probability: 5, keywords: ['x', 'x', 3] }, bogus: 1 }, { scopes: ['profile'] });
  assert.equal(value.reply.mode, 'adaptive');
  assert.equal(value.reply.probability, 1);
  assert.deepEqual(value.reply.keywords, ['x']);
  assert.ok(warnings.some((w) => w.includes('reply.mode')));
  assert.ok(warnings.some((w) => w.includes('bogus')));
});

test('创建 bot 自动建默认配置档与 cwd', () => {
  const { store, dir } = setup();
  const bot = store.createBot({ name: '主号', appId: '123' });
  assert.match(bot.id, /^bot_/);
  assert.equal(bot.name, '主号');
  assert.equal(bot.cwd, path.join(dir, 'bots', bot.id));
  const profiles = store.listProfiles(bot.id);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].isDefault, true);
  assert.equal(store.getSettings(bot.id).reply.mode, 'adaptive');
  assert.equal(store.listBots().length, 1);
});

test('分层覆盖：bot < profile < binding', () => {
  const { store } = setup();
  const bot = store.createBot({ name: 'A' });
  // bot 层
  store.patchSettings(bot.id, { admin: { enabled: true, openids: ['u1'] } });
  assert.equal(store.getSettings(bot.id).admin.enabled, true);
  // profile 层
  store.patchSettings(bot.id, { reply: { mode: 'always' } });
  assert.equal(store.getSettings(bot.id).reply.mode, 'always');
  // 新建一个 profile 并绑定到群 123，覆盖 reply
  const vip = store.createProfile(bot.id, { name: '热闹群', data: { reply: { mode: 'probability' } } });
  store.upsertBinding(bot.id, 'qq:group:123', vip.id, 0);
  assert.equal(store.getEffectiveSettings(bot.id, 'group:123').reply.mode, 'probability');
  // 未绑定 peer 仍用 active profile
  assert.equal(store.getEffectiveSettings(bot.id, 'group:999').reply.mode, 'always');
  // 匹配结果带来源
  const resolved = store.resolveProfile(bot.id, 'group:123');
  assert.equal(resolved.source, 'binding');
  assert.equal(resolved.scope, 'qq:group:123');
  // bot 层不受 profile 影响
  assert.equal(store.getEffectiveSettings(bot.id, 'group:123').admin.enabled, true);
});

test('绑定匹配：精确 > 类型通配 > 平台通配', () => {
  const { store } = setup();
  const bot = store.createBot({ name: 'A' });
  const p1 = store.createProfile(bot.id, { name: 'p1', data: { reply: { mode: 'always' } } });
  const p2 = store.createProfile(bot.id, { name: 'p2', data: { reply: { mode: 'mention' } } });
  const p3 = store.createProfile(bot.id, { name: 'p3', data: { reply: { mode: 'interval' } } });
  store.upsertBinding(bot.id, 'qq:group:*', p1.id);
  store.upsertBinding(bot.id, 'qq:group:42', p2.id);
  store.upsertBinding(bot.id, '*', p3.id);
  assert.equal(store.getEffectiveSettings(bot.id, 'group:42').reply.mode, 'mention');
  assert.equal(store.getEffectiveSettings(bot.id, 'group:43').reply.mode, 'always');
  assert.equal(store.getEffectiveSettings(bot.id, 'c2c:u1').reply.mode, 'interval');
});

test('配置档至少保留一个 + 激活语义', () => {
  const { store } = setup();
  const bot = store.createBot({ name: 'A' });
  const only = store.listProfiles(bot.id)[0];
  assert.throws(() => store.deleteProfile(only.id), /至少保留一个配置档/);
  const extra = store.createProfile(bot.id, { name: '第二套' });
  store.activateProfile(extra.id);
  assert.equal(store.listProfiles(bot.id).find((p) => p.isDefault).id, extra.id);
  assert.equal(store.deleteProfile(extra.id), true);
});

test('patchSettings 支持 json 型设置项的子路径', () => {
  const { store } = setup();
  const bot = store.createBot({ name: 'A' });
  store.patchSettings(bot.id, { tools: { capabilities: { workspace: false, web: true } } });
  const caps = store.getSettings(bot.id).tools.capabilities;
  assert.equal(caps.workspace, false);
  assert.equal(caps.web, true);
});

test('删除 bot 级联清理', () => {
  const { store } = setup();
  const bot = store.createBot({ name: 'A' });
  store.createProfile(bot.id, { name: 'p2' });
  store.deleteBot(bot.id);
  assert.equal(store.listBots().length, 0);
  assert.equal(store.listProfiles(bot.id).length, 0);
});

test('deepMerge 数组替换、对象递归', () => {
  const out = deepMerge({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { y: 3 }, list: [9] });
  assert.deepEqual(out, { a: { x: 1, y: 3 }, list: [9] });
  assert.deepEqual(defaults(['profile']).reply.mode, 'adaptive');
});
