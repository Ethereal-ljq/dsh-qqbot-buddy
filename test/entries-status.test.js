/**
 * test/entries-status.test.js —— 条目审核状态（pending / approved）行为。
 *
 * 覆盖：默认 approved、pending 不参与 search/recall、list 支持 status 过滤、
 * 旧文件（无 status 字段）自动按 approved 读取、pending→approved 的保存。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEntryStore } from '../lib/entries/store.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function tempStore(kind = 'knowledge') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-status-'));
  const store = createEntryStore({ dir: dir, kind: kind, logger: quiet });
  store.ensure();
  return { dir, store };
}

test('默认 approved；可显式保存 pending', () => {
  const { store } = tempStore();
  const approved = store.save({ title: '群规', body: '禁止广告', tags: ['群规'] });
  assert.equal(approved.status, 'approved');
  const pending = store.save({ title: '待确认活动', body: '周六开黑', status: 'pending' });
  assert.equal(pending.status, 'pending');
  const listed = store.list({});
  assert.equal(listed.total, 2);
  const onlyPending = store.list({ status: 'pending' });
  assert.equal(onlyPending.total, 1);
  assert.equal(onlyPending.items[0].title, '待确认活动');
});

test('pending 不参与 search / recall（未确认内容不影响回答）', () => {
  const { store } = tempStore();
  store.save({ title: '周六开黑', body: '每周六晚八点', tags: ['活动'] });
  store.save({ title: '周六桌游', body: '桌游活动待定', status: 'pending' });
  const search = store.search('周六');
  assert.equal(search.length, 1);
  assert.equal(search[0].title, '周六开黑');
  const recall = store.recall({ query: '周六要不要开黑？' });
  assert.equal(recall.length, 1);
  assert.equal(recall[0].title, '周六开黑');
});

test('pending 采纳后进入检索；手动条目不会被降级', () => {
  const { store } = tempStore();
  const saved = store.save({ title: '新约定', body: '周五交周报', status: 'pending' });
  assert.equal(store.recall({ query: '周报' }).length, 0);
  store.save({ id: saved.id, status: 'approved' });
  assert.equal(store.recall({ query: '周报' }).length, 1);
  const manual = store.save({ title: '群规', body: '禁止广告' });
  assert.equal(manual.status, 'approved');
  store.save({ id: manual.id, title: '群规（改）' });
  assert.equal(store.get(manual.id).status, 'approved');
});

test('旧条目 / 旧索引没有 status 字段时按 approved 读取', () => {
  // 模拟 v0.16.0 升级上来的 workspace：条目文件与 index.json 都没有 status 字段
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-status-legacy-'));
  fs.mkdirSync(path.join(dir, 'entries'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'entries', 'k_legacy.md'), [
    '---',
    'id: k_legacy',
    'kind: knowledge',
    'title: 旧条目',
    'tags: []',
    'scope: global',
    'importance: 1',
    'source: manual',
    '---',
    '',
    '旧版本写入的正文',
    '',
  ].join('\n'), 'utf8');
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    version: 1,
    kind: 'knowledge',
    updatedAt: nowIso,
    entries: [{
      id: 'k_legacy',
      title: '旧条目',
      tags: [],
      scope: 'global',
      groupId: '',
      groupName: '',
      importance: 1,
      source: 'manual',
      createdAt: nowIso,
      updatedAt: nowIso,
      hits: 0,
      lastHitAt: '',
      summary: '旧版本写入的正文',
    }],
  }), 'utf8');
  const store = createEntryStore({ dir: dir, kind: 'knowledge', logger: quiet });
  store.ensure();
  const entry = store.get('k_legacy');
  assert.ok(entry, '应能读到旧条目');
  assert.equal(entry.status, 'approved');
  const listed = store.list({});
  assert.equal(listed.total, 1);
  assert.equal(store.recall({ query: '旧版本' }).length, 1);
});

test('stats 暴露 pending 数量', () => {
  const { store } = tempStore();
  store.save({ title: 'a', body: 'aa' });
  store.save({ title: 'b', body: 'bb', status: 'pending' });
  const stats = store.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.pending, 1);
});
