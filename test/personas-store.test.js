/**
 * test/personas-store —— 人格卡 store：CRUD、active 互斥、persona.md 原子落盘、写失败降级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, all, run } from '../lib/core/db.js';
import { createPersonasStore } from '../lib/core/personas/store.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setup() {
  const dir = tempDir('qqbot-personas-');
  const db = openDb(path.join(dir, 'personas.db'));
  const stamp = Date.now();
  const cwd1 = path.join(dir, 'bots', 'b1');
  const cwd2 = path.join(dir, 'bots', 'b2');
  const insertBot = db.prepare('INSERT INTO bots(id, name, cwd, created_at, updated_at) VALUES(?,?,?,?,?)');
  insertBot.run('b1', '机器人一', cwd1, stamp, stamp);
  insertBot.run('b2', '机器人二', cwd2, stamp, stamp);
  const warnings = [];
  const logger = { warn: (message) => warnings.push(String(message)) };
  const store = createPersonasStore({ db, logger });
  return {
    dir,
    db,
    store,
    cwd1,
    cwd2,
    warnings,
    cleanup() {
      closeDb(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function activeRows(db, botId) {
  return all(db, 'SELECT id FROM personas WHERE bot_id = ? AND active = 1', botId);
}

test('CRUD 与 bot 隔离', () => {
  const ctx = setup();
  try {
    const p1 = ctx.store.create({ botId: 'b1', name: '温柔助手', content: '# 温柔' });
    assert.equal(p1.active, false);
    assert.equal(p1.name, '温柔助手');
    assert.match(p1.id, /^psn_/);
    const p2 = ctx.store.create({ botId: 'b1', name: '毒舌助手', content: '# 毒舌' });
    const other = ctx.store.create({ botId: 'b2', name: '另一个 bot' });
    assert.notEqual(p1.id, p2.id);

    assert.equal(ctx.store.list({ botId: 'b1' }).length, 2);
    assert.equal(ctx.store.list({ botId: 'b2' }).length, 1);
    assert.equal(ctx.store.get({ botId: 'b1', id: p1.id }).name, '温柔助手');
    assert.equal(ctx.store.get({ botId: 'b2', id: p1.id }), null, '不能跨 bot 读');
    assert.equal(ctx.store.get({ botId: 'b2', id: other.id }).name, '另一个 bot');

    const updated = ctx.store.update({ botId: 'b1', id: p1.id, name: '温柔助手2', content: '# 温柔2' });
    assert.equal(updated.name, '温柔助手2');
    assert.equal(updated.content, '# 温柔2');
    assert.equal(ctx.store.update({ botId: 'b1', id: 'psn_nope', name: 'x' }), null);

    assert.equal(ctx.store.remove({ botId: 'b1', id: p2.id }).removed, true);
    assert.equal(ctx.store.get({ botId: 'b1', id: p2.id }), null);
    assert.equal(ctx.store.list({ botId: 'b1' }).length, 1);
    assert.throws(() => ctx.store.create({ botId: 'b1', name: '   ' }), /name/);
  } finally {
    ctx.cleanup();
  }
});

test('activate：同 bot 唯一 active，并原子写 persona.md', () => {
  const ctx = setup();
  try {
    const p1 = ctx.store.create({ botId: 'b1', name: '温柔', content: '# 温柔人设' });
    const p2 = ctx.store.create({ botId: 'b1', name: '毒舌', content: '# 毒舌人设' });

    const active1 = ctx.store.activate({ botId: 'b1', id: p1.id });
    assert.equal(active1.active, true);
    assert.equal(ctx.store.active({ botId: 'b1' }).id, p1.id);
    assert.equal(activeRows(ctx.db, 'b1').length, 1);

    const personaFile = path.join(ctx.cwd1, 'persona.md');
    assert.equal(fs.readFileSync(personaFile, 'utf8'), '# 温柔人设');
    const leftovers = fs.readdirSync(ctx.cwd1).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '原子写不应残留 tmp 文件');
    assert.equal((fs.statSync(personaFile).mode & 0o777), 0o600);

    // 激活第二张：旧卡自动取消激活，文件同步替换
    const active2 = ctx.store.activate({ botId: 'b1', id: p2.id });
    assert.equal(active2.active, true);
    assert.equal(ctx.store.get({ botId: 'b1', id: p1.id }).active, false);
    assert.equal(activeRows(ctx.db, 'b1').length, 1);
    assert.equal(fs.readFileSync(personaFile, 'utf8'), '# 毒舌人设');
    assert.equal(ctx.store.list({ botId: 'b1' })[0].id, p2.id, 'list 中 active 排第一');

    assert.equal(ctx.store.activate({ botId: 'b1', id: 'psn_nope' }), null);
  } finally {
    ctx.cleanup();
  }
});

test('编辑 active 卡内容时同步 persona.md', () => {
  const ctx = setup();
  try {
    const persona = ctx.store.create({ botId: 'b1', name: '人设', content: 'v1' });
    ctx.store.activate({ botId: 'b1', id: persona.id });
    const personaFile = path.join(ctx.cwd1, 'persona.md');
    assert.equal(fs.readFileSync(personaFile, 'utf8'), 'v1');

    ctx.store.update({ botId: 'b1', id: persona.id, content: 'v2' });
    assert.equal(fs.readFileSync(personaFile, 'utf8'), 'v2');

    // 非 active 卡编辑不碰文件
    const inactive = ctx.store.create({ botId: 'b1', name: '备用', content: 'x' });
    ctx.store.update({ botId: 'b1', id: inactive.id, content: 'y' });
    assert.equal(fs.readFileSync(personaFile, 'utf8'), 'v2');
  } finally {
    ctx.cleanup();
  }
});

test('写 persona.md 失败只 warn：DB 激活仍然成功', () => {
  const ctx = setup();
  try {
    // 让 cwd 的父路径是个普通文件 → mkdir 必失败
    const blocked = path.join(ctx.dir, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');
    const stamp = Date.now();
    run(ctx.db, 'INSERT INTO bots(id, name, cwd, created_at, updated_at) VALUES(?,?,?,?,?)',
      'b-broken', '坏 cwd', path.join(blocked, 'sub'), stamp, stamp);
    const persona = ctx.store.create({ botId: 'b-broken', name: '人设', content: '内容' });
    const active = ctx.store.activate({ botId: 'b-broken', id: persona.id });
    assert.equal(active.active, true, '写文件失败不应影响激活');
    assert.equal(ctx.store.active({ botId: 'b-broken' }).id, persona.id);
    assert.ok(ctx.warnings.some((message) => message.includes('persona.md')), '应记录 warn');
  } finally {
    ctx.cleanup();
  }
});

test('bot 没有 cwd 时跳过 persona.md 但激活成功', () => {
  const ctx = setup();
  try {
    const stamp = Date.now();
    run(ctx.db, 'INSERT INTO bots(id, name, cwd, created_at, updated_at) VALUES(?,?,NULL,?,?)',
      'b-nocwd', '无 cwd', stamp, stamp);
    const persona = ctx.store.create({ botId: 'b-nocwd', name: '人设', content: '内容' });
    const active = ctx.store.activate({ botId: 'b-nocwd', id: persona.id });
    assert.equal(active.active, true);
    assert.ok(ctx.warnings.some((message) => message.includes('没有 cwd')));
  } finally {
    ctx.cleanup();
  }
});
