/**
 * test/tts-store —— TTS 供应商 store：CRUD / secret 保留 / 脱敏 / 排序 / firstEnabled。
 *
 * 临时 SQLite（真实 migration v6），不联网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, run } from '../lib/core/db.js';
import { createTtsProviderStore } from '../lib/core/tts/store.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setup() {
  const dir = tempDir('qqbot-tts-store-');
  const db = openDb(path.join(dir, 'tts.db'));
  const ctx = { clock: 1_700_000_000_000 };
  const store = createTtsProviderStore({ db, now: () => ctx.clock });
  return {
    dir,
    db,
    store,
    ctx,
    tick(ms = 1) { ctx.clock += ms; return ctx.clock; },
    cleanup() {
      closeDb(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('新增/列表/查询：id 形态、secret 只进内部行、按 created_at ASC 排序', () => {
  const h = setup();
  try {
    const edge = h.store.save({ name: 'Edge A', kind: 'edge', config: { voice: 'zh-CN-YunxiNeural' } });
    assert.match(edge.id, /^tts_[0-9a-f]{12}$/);
    assert.equal(edge.kind, 'edge');
    assert.equal(edge.hasSecret, false);
    assert.equal('secret' in edge, false);
    assert.equal(edge.createdAt, h.ctx.clock);

    h.tick(5);
    const openai = h.store.save({ name: 'OpenAI', kind: 'openai', secret: '  sk-abc  ' });
    assert.equal(openai.hasSecret, true);
    assert.equal('secret' in openai, false);
    assert.equal(openai.createdAt, h.ctx.clock);
    // 新增未传 config：应落默认配置（openai 默认 baseUrl/model/voice 等）
    assert.equal(openai.config.model, 'gpt-4o-mini-tts');

    const rows = h.store.list();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, edge.id, 'list 按 created_at ASC');
    assert.equal(rows[1].id, openai.id);
    assert.equal(rows[0].secret, '', '内部行无 secret 时为空串');
    assert.equal(rows[1].secret, 'sk-abc', '内部行 secret 已裁剪空白');
    assert.deepEqual(rows[1].config, openai.config);
    assert.equal(typeof rows[0].created_at, 'number');

    assert.equal(h.store.listPublic().length, 2);
    assert.equal(h.store.listPublic().every((view) => !('secret' in view)), true);

    assert.equal(h.store.get(edge.id).kind, 'edge');
    assert.equal(h.store.getPublic(edge.id).name, 'Edge A');
    assert.equal(h.store.get(''), null);
    assert.equal(h.store.get('tts_nope'), null);
    assert.equal(h.store.getPublic('tts_nope'), null);
    assert.equal(h.store.get(undefined), null);
  } finally {
    h.cleanup();
  }
});

test('更新：secret 缺省/空串保留原值，非空覆盖；配置合并不丢字段', () => {
  const h = setup();
  try {
    const created = h.store.save({
      name: 'OpenAI',
      kind: 'openai',
      secret: 'sk-orig',
      config: { baseUrl: 'https://api.example.com/v1', model: 'tts-1', voice: 'alloy' },
    });
    h.tick(10);

    const renamed = h.store.save({ id: created.id, name: 'OpenAI 改' });
    assert.equal(renamed.name, 'OpenAI 改');
    assert.equal(renamed.hasSecret, true, '不传 secret 应保留');
    assert.equal(h.store.get(created.id).secret, 'sk-orig');
    assert.equal(renamed.config.baseUrl, 'https://api.example.com/v1', '不传 config 应保留');
    assert.equal(renamed.updatedAt, h.ctx.clock);

    const emptySecret = h.store.save({ id: created.id, secret: '' });
    assert.equal(emptySecret.hasSecret, true, '空串 secret = 保留原值');
    assert.equal(h.store.get(created.id).secret, 'sk-orig');

    const replaced = h.store.save({ id: created.id, secret: 'sk-new', config: { voice: 'nova' } });
    assert.equal(replaced.hasSecret, true);
    assert.equal(h.store.get(created.id).secret, 'sk-new');
    assert.equal(replaced.config.voice, 'nova');
    assert.equal(replaced.config.model, 'tts-1', '提交部分 config 时其余字段保留');

    const disabled = h.store.save({ id: created.id, enabled: false });
    assert.equal(disabled.enabled, false);
    // providerView 返回的是拷贝：改它不影响库里的行
    disabled.config.voice = 'hacked';
    assert.equal(h.store.get(created.id).config.voice, 'nova');

    assert.throws(
      () => h.store.save({ id: 'tts_nope', name: 'x' }),
      (err) => err.code === 'TTS_PROVIDER_NOT_FOUND' && /不存在/.test(err.message),
    );
    assert.throws(() => h.store.save({ kind: 'nope' }), /未知的 TTS 供应商类型/);
    assert.throws(() => h.store.save({ kind: 'custom' }), /custom\.url/);
  } finally {
    h.cleanup();
  }
});

test('删除：返回是否删掉，重复删除 / 空 id 安全', () => {
  const h = setup();
  try {
    const saved = h.store.save({ name: 'Edge', kind: 'edge' });
    assert.equal(h.store.remove(saved.id), true);
    assert.equal(h.store.get(saved.id), null);
    assert.equal(h.store.remove(saved.id), false);
    assert.equal(h.store.remove(''), false);
    assert.equal(h.store.remove(undefined), false);
    assert.equal(h.store.list().length, 0);
  } finally {
    h.cleanup();
  }
});

test('firstEnabled：跳过停用项、按创建顺序取第一个启用项', () => {
  const h = setup();
  try {
    assert.equal(h.store.firstEnabled(), null);
    h.store.save({ name: '停用', kind: 'edge', enabled: false });
    assert.equal(h.store.firstEnabled(), null, '全部停用返回 null');

    h.tick();
    const first = h.store.save({ name: '启用 1', kind: 'edge' });
    h.tick();
    const second = h.store.save({ name: '启用 2', kind: 'edge' });
    assert.equal(h.store.firstEnabled().id, first.id);

    h.store.save({ id: first.id, enabled: false });
    assert.equal(h.store.firstEnabled().id, second.id);

    // listPublic 不过滤停用项（控制台要能看到并重新启用）
    assert.equal(h.store.listPublic().length, 3);
  } finally {
    h.cleanup();
  }
});

test('坏数据容错：config 非 JSON 时按空对象处理，不拖垮列表', () => {
  const h = setup();
  try {
    h.store.save({ name: '好的', kind: 'edge' });
    const stamp = h.ctx.clock + 1;
    run(h.db,
      'INSERT INTO tts_providers(id, name, kind, enabled, config, secret, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
      'tts_badconfig', '坏行', 'edge', 1, 'not-json', '', stamp, stamp);
    const rows = h.store.list();
    assert.equal(rows.length, 2);
    const bad = rows.find((row) => row.id === 'tts_badconfig');
    assert.deepEqual(bad.config, {});
    assert.equal(bad.enabled, true);
    assert.equal(h.store.listPublic().length, 2);
  } finally {
    h.cleanup();
  }
});

test('createTtsProviderStore：缺少 db 时给出明确 TypeError', () => {
  assert.throws(() => createTtsProviderStore({}), /需要由 lib\/core\/db\.js 的 openDb\(\) 打开的 db/);
  assert.throws(() => createTtsProviderStore(), TypeError);
});
