/**
 * test/members-store —— 群友库 store：openid 合并语义、备注上限、LIKE 检索、bot 隔离。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, all, get, run } from '../lib/core/db.js';
import { createMembersStore } from '../lib/core/members/store.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setup() {
  const dir = tempDir('qqbot-members-');
  const db = openDb(path.join(dir, 'members.db'));
  const stamp = Date.now();
  const insertBot = db.prepare('INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)');
  insertBot.run('b1', '机器人一', stamp, stamp);
  insertBot.run('b2', '机器人二', stamp, stamp);
  const store = createMembersStore({ db });
  return {
    dir,
    db,
    store,
    cleanup() {
      closeDb(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('upsert 新建并按 openid 合并：空值不冲掉已有昵称/备注', () => {
  const ctx = setup();
  try {
    const first = ctx.store.upsert({ botId: 'b1', openid: 'u1', nickname: '小明', note: '老备注', profileJson: { a: 1 } });
    assert.equal(first.created, true);
    assert.equal(first.openid, 'u1');
    assert.equal(first.nickname, '小明');
    assert.equal(first.note, '老备注');
    assert.deepEqual(first.profileJson, { a: 1 });
    assert.ok(first.id > 0);

    // 空串/空值：不应覆盖已有字段
    const merged = ctx.store.upsert({ botId: 'b1', openid: 'u1', nickname: '', note: '' });
    assert.equal(merged.created, false);
    assert.equal(merged.id, first.id);
    assert.equal(merged.nickname, '小明');
    assert.equal(merged.note, '老备注');

    // 非空值才覆盖
    const updated = ctx.store.upsert({ botId: 'b1', openid: 'u1', note: '新备注' });
    assert.equal(updated.note, '新备注');
    assert.equal(updated.nickname, '小明');

    // profile 对象浅合并；显式 null 清空
    const withProfile = ctx.store.upsert({ botId: 'b1', openid: 'u1', profileJson: { b: 2 } });
    assert.deepEqual(withProfile.profileJson, { a: 1, b: 2 });
    const cleared = ctx.store.upsert({ botId: 'b1', openid: 'u1', profileJson: null });
    assert.equal(cleared.profileJson, null);

    assert.equal(all(ctx.db, 'SELECT id FROM members WHERE bot_id = ?', 'b1').length, 1);
  } finally {
    ctx.cleanup();
  }
});

test('备注长度上限 2000 字', () => {
  const ctx = setup();
  try {
    const member = ctx.store.upsert({ botId: 'b1', openid: 'u1', note: '备'.repeat(3000) });
    assert.equal(member.note.length, 2000);
  } finally {
    ctx.cleanup();
  }
});

test('list/search：按 bot 隔离、q 命中昵称与备注、LIKE 通配符被转义', () => {
  const ctx = setup();
  try {
    ctx.store.upsert({ botId: 'b1', openid: 'u1', nickname: '阿猫', note: '喜欢钓鱼' });
    ctx.store.upsert({ botId: 'b1', openid: 'u2', nickname: '100%纯路人', note: '普通群友' });
    ctx.store.upsert({ botId: 'b2', openid: 'u1', nickname: '另一个 bot 的群友' });

    const allB1 = ctx.store.list({ botId: 'b1' });
    assert.equal(allB1.length, 2);
    assert.equal(ctx.store.list({ botId: 'b2' }).length, 1);
    assert.equal(ctx.store.count({ botId: 'b1' }), 2);
    assert.equal(ctx.store.count({ botId: 'b2' }), 1);

    assert.equal(ctx.store.list({ botId: 'b1', query: '钓' }).length, 1, '备注 LIKE');
    assert.equal(ctx.store.list({ botId: 'b1', query: '阿猫' })[0].openid, 'u1', '昵称 LIKE');
    // % 应按字面量匹配：只有昵称含 100% 的人命中，而不是全部
    const percent = ctx.store.list({ botId: 'b1', query: '100%' });
    assert.equal(percent.length, 1);
    assert.equal(percent[0].openid, 'u2');

    assert.deepEqual(ctx.store.search({ botId: 'b2', query: '不存在' }), []);
  } finally {
    ctx.cleanup();
  }
});

test('get/update/remove：按 id 操作且校验 bot 归属', () => {
  const ctx = setup();
  try {
    const member = ctx.store.upsert({ botId: 'b1', openid: 'u1', nickname: '小明', note: '备注' });
    assert.equal(ctx.store.get({ botId: 'b1', id: member.id }).openid, 'u1');
    assert.equal(ctx.store.get({ botId: 'b1', openid: 'u1' }).id, member.id);
    assert.equal(ctx.store.get({ botId: 'b2', id: member.id }), null, '其他 bot 不应读到');

    const updated = ctx.store.update({ botId: 'b1', id: member.id, nickname: '小红', note: '' });
    assert.equal(updated.nickname, '小红');
    assert.equal(updated.note, '备注', 'PATCH 空 note 也不冲掉');

    assert.equal(ctx.store.update({ botId: 'b1', id: 9999, nickname: 'x' }), null);

    const removed = ctx.store.remove({ botId: 'b1', id: member.id });
    assert.equal(removed.removed, true);
    assert.equal(ctx.store.get({ botId: 'b1', id: member.id }), null);
    assert.equal(ctx.store.remove({ botId: 'b1', id: member.id }).removed, false);

    // bot 参数缺失属于编程错误
    assert.throws(() => ctx.store.list({ botId: '' }), /botId/);
  } finally {
    ctx.cleanup();
  }
});
