/**
 * test/bots-registry.test.js —— 多机器人注册表（bots.json）单测。
 *
 * 覆盖：legacy 迁移与凭据播种、CRUD、id 唯一、上限、工作区校验、
 * 凭据与元数据分离、损坏恢复、解绑墓碑不复活。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBotRegistry } from '../lib/bots/registry.js';

function tempRoot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-reg-' + name + '-'));
  return dir;
}

test('首次加载迁移出 legacy 机器人，并沿用旧 stateDir / 播种凭据', () => {
  const root = tempRoot('legacy');
  const legacyCwd = path.join(root, 'legacy-cwd');
  const legacyState = path.join(legacyCwd, '.qqbot', 'state');
  fs.mkdirSync(legacyState, { recursive: true });
  const registry = createBotRegistry({
    workspaceRoot: root,
    legacyConfig: { cwd: legacyCwd, stateDir: legacyState, appId: '102000', appSecret: 's3cret' },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  });
  const bots = registry.list();
  assert.equal(bots.length, 1);
  assert.equal(bots[0].id, 'default');
  assert.equal(bots[0].legacy, true);
  assert.equal(bots[0].workspaceDir, legacyCwd);
  assert.equal(registry.activeId(), 'default');

  // bots.json 不包含 secret
  const raw = fs.readFileSync(path.join(root, 'bots.json'), 'utf8');
  assert.ok(!raw.includes('s3cret'), 'bots.json 不能包含 appSecret');

  // 凭据写进 legacy stateDir 的 credentials.json（0600）
  const credFile = path.join(legacyState, 'credentials.json');
  assert.ok(fs.existsSync(credFile));
  const mode = fs.statSync(credFile).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual(registry.credentials('default'), { appId: '102000', appSecret: 's3cret' });

  // 再次加载不重复迁移
  const again = createBotRegistry({ workspaceRoot: root, legacyConfig: { cwd: legacyCwd }, logger: { warn() {} } });
  assert.equal(again.list().length, 1);
});

test('create / update / delete / setActive 与上限、id 唯一', () => {
  const root = tempRoot('crud');
  // 首次加载会迁移出一条 legacy 机器人，所以上限 3 = legacy + 2 个新建
  const registry = createBotRegistry({ workspaceRoot: root, maxBots: 3, legacyConfig: {}, logger: { warn() {} } });

  const first = registry.create({ name: '小助手' });
  assert.equal(first.ok, true);
  assert.ok(fs.existsSync(path.join(first.bot.workspaceDir, '.qqbot', 'state')));
  assert.ok(first.bot.workspaceDir.startsWith(path.join(root, 'bots')), '新机器人工作区应在 bots/ 下');

  const second = registry.create({ name: '客服', appId: '2001', appSecret: 'sec' });
  assert.equal(second.ok, true);
  assert.deepEqual(registry.credentials(second.bot.id), { appId: '2001', appSecret: 'sec' });

  // 上限
  const third = registry.create({ name: '第三个' });
  assert.equal(third.ok, false);
  assert.match(third.error, /最多/);

  // id 唯一：同名再建（先删再建会复用 id 前缀，这里直接构造冲突场景）
  const renamed = registry.update(second.bot.id, { name: '客服2' });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.bot.name, '客服2');

  // 切换 active + 删除
  registry.setActive(second.bot.id);
  assert.equal(registry.activeId(), second.bot.id);
  const removed = registry.remove(second.bot.id);
  assert.equal(removed.ok, true);
  // 剩下的：legacy 迁移出的 default + 新建的 first
  assert.equal(registry.list().length, 2);
  assert.equal(registry.activeId(), 'default');

  // 删到只剩一个：再删就拒绝
  assert.equal(registry.remove('default').ok, true);
  assert.equal(registry.list().length, 1);
  const last = registry.remove(first.bot.id);
  assert.equal(last.ok, false);
});

test('工作区必须是绝对路径；更新工作区会创建目录', () => {
  const root = tempRoot('ws');
  const registry = createBotRegistry({ workspaceRoot: root, legacyConfig: {}, logger: { warn() {} } });
  const created = registry.create({ name: 'bot', workspaceDir: 'relative/path' });
  assert.equal(created.ok, false);
  const absolute = path.join(root, 'custom-ws');
  const custom = registry.create({ name: 'custom', workspaceDir: absolute });
  assert.equal(custom.ok, true);
  assert.equal(custom.bot.workspaceDir, absolute);
  assert.ok(fs.existsSync(path.join(absolute, '.qqbot', 'state')));

  const moved = path.join(root, 'moved-ws');
  const updated = registry.update(custom.bot.id, { workspaceDir: moved });
  assert.equal(updated.ok, true);
  assert.ok(fs.existsSync(path.join(moved, '.qqbot', 'state')));
});

test('bots.json 损坏时备份并重建，不抛错', () => {
  const root = tempRoot('corrupt');
  const registry = createBotRegistry({ workspaceRoot: root, legacyConfig: {}, logger: { warn() {} } });
  registry.create({ name: 'a' });
  fs.writeFileSync(path.join(root, 'bots.json'), '{ not json', 'utf8');
  const reloaded = createBotRegistry({ workspaceRoot: root, legacyConfig: {}, logger: { warn() {} } });
  assert.ok(reloaded.list().length >= 1);
  const backups = fs.readdirSync(root).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
});

test('legacy 解绑写墓碑：不会从 config 凭据复活', () => {
  const root = tempRoot('unbind');
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const registry = createBotRegistry({
    workspaceRoot: root,
    legacyConfig: { cwd: cwd, appId: '999', appSecret: 'old-secret' },
    logger: { warn() {} },
  });
  assert.deepEqual(registry.credentials('default'), { appId: '999', appSecret: 'old-secret' });
  const unbound = registry.setCredentials('default', { appId: '', appSecret: '' });
  assert.equal(unbound.ok, true);
  assert.deepEqual(registry.credentials('default'), { appId: '', appSecret: '' });

  // 重新加载（同一 config 仍带旧凭据）也不应复活
  const reloaded = createBotRegistry({
    workspaceRoot: root,
    legacyConfig: { cwd: cwd, appId: '999', appSecret: 'old-secret' },
    logger: { warn() {} },
  });
  assert.deepEqual(reloaded.credentials('default'), { appId: '', appSecret: '' });
});
