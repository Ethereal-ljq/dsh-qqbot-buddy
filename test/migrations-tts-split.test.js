/**
 * migrations-tts-split —— v7：MiMo 的「默认 / 克隆 / 文字设计」从 mimo+model 拆成独立 kind。
 *
 * 直接对临时库跑 v1..v6，再插入旧数据，最后用 migrate() 应用 v7，断言 kind/config 迁移结果。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../lib/core/migrations.js';
import { migrate, schemaVersion } from '../lib/core/db.js';

/** 建一个到 v6 的临时库并返回 { db, dir }。 */
function dbAtV6() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-migrate-tts-'));
  const db = new DatabaseSync(path.join(dir, 'buddy.db'));
  db.exec('PRAGMA journal_mode = WAL');
  for (const migration of MIGRATIONS.filter((item) => item.version <= 6).sort((a, b) => a.version - b.version)) {
    db.exec(migration.sql);
  }
  db.exec('PRAGMA user_version = 6');
  return { db, dir };
}

function insertProvider(db, id, kind, config) {
  db.prepare('INSERT INTO tts_providers(id, name, kind, enabled, config, secret, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, id, kind, 1, JSON.stringify(config), 'key', 1, 1);
}

test('v7：mimo + voicedesign → mimo-design（描述取旧 style，丢弃 samplePath）', () => {
  const { db, dir } = dbAtV6();
  try {
    insertProvider(db, 'tts_design', 'mimo', {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-tts-voicedesign',
      voice: 'mimo_default',
      style: '18 岁女生，清亮偏软，语速偏快',
      samplePath: '/tmp/leftover.mp3',
    });
    migrate(db);
    assert.equal(schemaVersion(db), Math.max(...MIGRATIONS.map((item) => item.version)));
    const row = db.prepare('SELECT kind, config FROM tts_providers WHERE id = ?').get('tts_design');
    assert.equal(row.kind, 'mimo-design');
    assert.deepEqual(JSON.parse(row.config), {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      description: '18 岁女生，清亮偏软，语速偏快',
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v7：mimo + voiceclone → mimo-clone（保留 samplePath / style，补 baseUrl）', () => {
  const { db, dir } = dbAtV6();
  try {
    insertProvider(db, 'tts_clone', 'mimo', {
      model: 'mimo-v2.5-tts-voiceclone',
      samplePath: '/home/qiqi/project/qqbot/sample.wav',
      style: '温柔一点',
    });
    migrate(db);
    const row = db.prepare('SELECT kind, config FROM tts_providers WHERE id = ?').get('tts_clone');
    assert.equal(row.kind, 'mimo-clone');
    assert.deepEqual(JSON.parse(row.config), {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      samplePath: '/home/qiqi/project/qqbot/sample.wav',
      style: '温柔一点',
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v7：其余 mimo 归一到默认音色配置，其它 kind 不受影响', () => {
  const { db, dir } = dbAtV6();
  try {
    insertProvider(db, 'tts_default', 'mimo', { model: 'mimo-v2.5-tts', voice: '冰糖' });
    insertProvider(db, 'tts_edge', 'edge', { voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' });
    migrate(db);
    const mimo = db.prepare('SELECT kind, config FROM tts_providers WHERE id = ?').get('tts_default');
    assert.equal(mimo.kind, 'mimo');
    assert.deepEqual(JSON.parse(mimo.config), {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      voice: '冰糖',
      style: '',
    });
    const edge = db.prepare('SELECT kind, config FROM tts_providers WHERE id = ?').get('tts_edge');
    assert.equal(edge.kind, 'edge');
    assert.deepEqual(JSON.parse(edge.config), { voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
