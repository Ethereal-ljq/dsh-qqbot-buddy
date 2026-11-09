/**
 * test/stickers-store —— 表情包 store：(bot_id,hash) 去重、文件删除、当日配额计数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, all, get, run } from '../lib/core/db.js';
import { createStickersStore, stickerDayKey } from '../lib/core/stickers/store.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setup({ now } = {}) {
  const dir = tempDir('qqbot-stickers-');
  const db = openDb(path.join(dir, 'stickers.db'));
  const stamp = Date.now();
  const insertBot = db.prepare('INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)');
  insertBot.run('b1', '机器人一', stamp, stamp);
  insertBot.run('b2', '机器人二', stamp, stamp);
  const clock = { now: now === undefined ? stamp : now };
  const store = createStickersStore({ db, now: () => clock.now });
  return {
    dir,
    db,
    store,
    clock,
    cleanup() {
      closeDb(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeFile(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'GIF89a');
  return file;
}

test('add 按 (bot_id, hash) 去重，不同 bot 可重复', () => {
  const ctx = setup();
  try {
    const file = makeFile(ctx.dir, 'a.gif');
    const first = ctx.store.add({ botId: 'b1', name: '猫猫', file, emotion: '开心', hash: 'hash-1' });
    assert.equal(first.created, true);
    assert.equal(first.name, '猫猫');
    assert.equal(first.emotion, '开心');
    assert.equal(first.hash, 'hash-1');

    const dup = ctx.store.add({ botId: 'b1', name: '猫猫别名', file, emotion: '开心', hash: 'hash-1' });
    assert.equal(dup.created, false);
    assert.equal(dup.id, first.id, '同 bot 同 hash 应返回已有记录');
    assert.equal(all(ctx.db, 'SELECT id FROM stickers WHERE bot_id = ?', 'b1').length, 1);

    const otherBot = ctx.store.add({ botId: 'b2', name: '猫猫', file, hash: 'hash-1' });
    assert.equal(otherBot.created, true, '不同 bot 相同 hash 允许');

    // hash 为空时不去重
    const noHash1 = ctx.store.add({ botId: 'b1', name: '无 hash', file });
    const noHash2 = ctx.store.add({ botId: 'b1', name: '无 hash', file });
    assert.equal(noHash1.created, true);
    assert.equal(noHash2.created, true);
    assert.notEqual(noHash1.id, noHash2.id);

    assert.throws(() => ctx.store.add({ botId: 'b1', name: '', file }), /name/);
    assert.throws(() => ctx.store.add({ botId: 'b1', name: 'x', file: '' }), /file/);
  } finally {
    ctx.cleanup();
  }
});

test('list 按 bot 隔离、emotion 过滤', () => {
  const ctx = setup();
  try {
    const file = makeFile(ctx.dir, 'a.gif');
    ctx.store.add({ botId: 'b1', name: '开心', file, emotion: 'happy', hash: 'h1' });
    ctx.store.add({ botId: 'b1', name: '难过', file, emotion: 'sad', hash: 'h2' });
    ctx.store.add({ botId: 'b2', name: '别的 bot', file, hash: 'h3' });

    assert.equal(ctx.store.list({ botId: 'b1' }).length, 2);
    assert.equal(ctx.store.list({ botId: 'b2' }).length, 1);
    assert.equal(ctx.store.list({ botId: 'b1', emotion: 'happy' }).length, 1);
    assert.equal(ctx.store.list({ botId: 'b1', emotion: 'happy' })[0].name, '开心');
    assert.equal(ctx.store.get({ botId: 'b1', id: 9999 }), null);
  } finally {
    ctx.cleanup();
  }
});

test('remove 删除 DB 行并尽力删文件（文件不存在忽略）', () => {
  const ctx = setup();
  try {
    const file = makeFile(ctx.dir, 'to-delete.gif');
    const sticker = ctx.store.add({ botId: 'b1', name: '待删', file, hash: 'h1' });
    const removed = ctx.store.remove({ botId: 'b1', id: sticker.id });
    assert.equal(removed.removed, true);
    assert.equal(fs.existsSync(file), false, '文件应被删除');
    assert.equal(ctx.store.remove({ botId: 'b1', id: sticker.id }).removed, false, '重复删除返回 false');

    // 文件不存在也不报错
    const ghost = ctx.store.add({ botId: 'b1', name: '幽灵', file: path.join(ctx.dir, 'missing.gif'), hash: 'h2' });
    const removedGhost = ctx.store.remove({ botId: 'b1', id: ghost.id });
    assert.equal(removedGhost.removed, true);
  } finally {
    ctx.cleanup();
  }
});

test('quota/recordSend：当日计数落 job_state，跨天归零', () => {
  const fixed = new Date(2026, 0, 15, 10, 30, 0).getTime();
  const ctx = setup({ now: fixed });
  try {
    const day1 = stickerDayKey(fixed);
    assert.deepEqual(ctx.store.quota({ botId: 'b1' }), { day: day1, count: 0 });

    assert.deepEqual(ctx.store.recordSend({ botId: 'b1' }), { day: day1, count: 1 });
    assert.deepEqual(ctx.store.recordSend({ botId: 'b1' }), { day: day1, count: 2 });
    assert.deepEqual(ctx.store.quota({ botId: 'b1' }), { day: day1, count: 2 });

    const row = get(ctx.db, "SELECT value FROM job_state WHERE bot_id = 'b1' AND peer = '' AND job = 'sticker-send'");
    assert.ok(row, 'job_state 应有 sticker-send 行');
    assert.deepEqual(JSON.parse(row.value), { day: day1, count: 2 });

    // 跨天：计数归零，再发从 1 开始
    ctx.clock.now = new Date(2026, 0, 16, 9, 0, 0).getTime();
    const day2 = stickerDayKey(ctx.clock.now);
    assert.deepEqual(ctx.store.quota({ botId: 'b1' }), { day: day2, count: 0 });
    assert.deepEqual(ctx.store.recordSend({ botId: 'b1' }), { day: day2, count: 1 });

    // 不同 bot 互不影响
    assert.equal(ctx.store.quota({ botId: 'b2' }).count, 0);
  } finally {
    ctx.cleanup();
  }
});
