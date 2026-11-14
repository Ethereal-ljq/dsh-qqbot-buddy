/**
 * migrations-admin-profile —— v8：管理员门控从 bot 层迁到 profile 层。
 *
 * 旧库的 settings(bot_id=<bot>, key='bot') = {admin:{...}}，同一个 bot 的每个配置档都吃这份配置。
 * v8 把它复制进该 bot 的所有配置档（配置档自己已有的 admin 优先），再从 bot 层移除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../lib/core/migrations.js';
import { migrate, schemaVersion } from '../lib/core/db.js';

/** 建一个到 v7 的临时库并返回 { db, dir }。 */
function dbAtV7() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-migrate-admin-'));
  const db = new DatabaseSync(path.join(dir, 'buddy.db'));
  db.exec('PRAGMA journal_mode = WAL');
  for (const migration of MIGRATIONS.filter((item) => item.version <= 7).sort((a, b) => a.version - b.version)) {
    db.exec(migration.sql);
  }
  db.exec('PRAGMA user_version = 7');
  return { db, dir };
}

function seed(db) {
  db.prepare('INSERT INTO bots(id, name, app_id, app_secret, enabled, cwd, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('bot_a', 'A', '', '', 1, '/tmp/a', 1, 1);
  db.prepare('INSERT INTO bots(id, name, app_id, app_secret, enabled, cwd, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('bot_b', 'B', '', '', 1, '/tmp/b', 1, 1);
  // bot_a：默认档 + 群档，bot 层有 admin，群里那条档自己还配过一个 admin（应保留自己的）
  db.prepare('INSERT INTO profiles(id, bot_id, name, data, is_default, created_at, updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('prf_a1', 'bot_a', '默认配置', '{"reply":{"mode":"always"}}', 1, 1, 1);
  db.prepare('INSERT INTO profiles(id, bot_id, name, data, is_default, created_at, updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('prf_a2', 'bot_a', '群档', '{"admin":{"enabled":false,"openids":["u-own"]}}', 0, 2, 2);
  // bot_b：没有 admin 配置
  db.prepare('INSERT INTO profiles(id, bot_id, name, data, is_default, created_at, updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('prf_b1', 'bot_b', '默认配置', '{}', 1, 3, 3);
  // settings：bot_a 的 bot 层有 admin + 别的遗留键
  db.prepare('INSERT INTO settings(bot_id, key, value) VALUES(?,?,?)')
    .run('bot_a', 'bot', JSON.stringify({ admin: { enabled: true, openids: ['u-a'] }, leftover: 1 }));
  db.prepare('INSERT INTO settings(bot_id, key, value) VALUES(?,?,?)')
    .run('bot_b', 'bot', JSON.stringify({ admin: { enabled: true, openids: ['u-b'] } }));
}

function profileData(db, id) {
  return JSON.parse(db.prepare('SELECT data FROM profiles WHERE id = ?').get(id).data);
}

test('v8：bot 层 admin 复制进该 bot 的所有配置档，再从 bot 层移除', () => {
  const { db, dir } = dbAtV7();
  try {
    seed(db);
    migrate(db);
    // 迁移是最新版本即可（不写死 8，后续版本追加不应让这条测试失效）
    assert.equal(schemaVersion(db), Math.max(...MIGRATIONS.map((item) => item.version)));

    // 没有自带 admin 的档：继承 bot 层
    assert.deepEqual(profileData(db, 'prf_a1').admin, { enabled: true, openids: ['u-a'] });
    assert.deepEqual(profileData(db, 'prf_a1').reply, { mode: 'always' });
    // 自带 admin 的档：保留自己的
    assert.deepEqual(profileData(db, 'prf_a2').admin, { enabled: false, openids: ['u-own'] });
    // 另一个 bot 的档拿自己 bot 的 admin
    assert.deepEqual(profileData(db, 'prf_b1').admin, { enabled: true, openids: ['u-b'] });

    // bot 层里的 admin 已移除，其它遗留键保留
    const rowA = JSON.parse(db.prepare("SELECT value FROM settings WHERE bot_id = 'bot_a' AND key = 'bot'").get().value);
    assert.deepEqual(rowA, { leftover: 1 });
    // bot_b 的 bot 层只剩空对象 → 整行删除
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE bot_id = 'bot_b' AND key = 'bot'").get().n, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v8：没有 admin 的 bot 层不受影响', () => {
  const { db, dir } = dbAtV7();
  try {
    db.prepare('INSERT INTO bots(id, name, app_id, app_secret, enabled, cwd, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('bot_c', 'C', '', '', 1, '/tmp/c', 1, 1);
    db.prepare('INSERT INTO profiles(id, bot_id, name, data, is_default, created_at, updated_at) VALUES(?,?,?,?,?,?,?)')
      .run('prf_c1', 'bot_c', '默认配置', '{"reply":{"mode":"mention"}}', 1, 1, 1);
    migrate(db);
    assert.deepEqual(profileData(db, 'prf_c1'), { reply: { mode: 'mention' } });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
