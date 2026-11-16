/**
 * kb hygiene —— 知识治理：保护位优先、低置信 + 低召回才归档、归档满 TTL 才真删。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { HYGIENE_DEFAULTS, isProtectedDoc, planHygiene, resolveHygieneSettings } from '../lib/core/kb/hygiene.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 16, 12);
const ago = (days) => NOW - days * DAY;

function doc(patch = {}) {
  return {
    id: 1, title: '文档', source: 'kb:fact:x', kind: 'fact', confidence: 40, authority: 'model',
    pinned: false, recallCount: 0, lastRecalledAt: null, staleAt: null,
    createdAt: ago(60), updatedAt: ago(60), ...patch,
  };
}

test('保护位：pinned / rule / 群友写的 / 历史未分类，一律不参与自动治理', () => {
  assert.equal(isProtectedDoc(doc({ pinned: true })), true);
  assert.equal(isProtectedDoc(doc({ kind: 'rule', pinned: false })), true);
  assert.equal(isProtectedDoc(doc({ authority: 'member' })), true);
  assert.equal(isProtectedDoc(doc({ authority: 'admin' })), true);
  assert.equal(isProtectedDoc(doc({ kind: null })), true, 'v1 迁移的历史数据不自动清理');
  assert.equal(isProtectedDoc(doc({})), false);
});

test('清理计划：置信度低 + 从未召回（超观察期）才软归档；高置信冷门不动', () => {
  const plan = planHygiene({
    docs: [
      doc({ id: 1, confidence: 30, recallCount: 0, updatedAt: ago(30) }),
      doc({ id: 2, confidence: 90, recallCount: 0, updatedAt: ago(400) }),
      doc({ id: 3, kind: 'rule', pinned: false }),
      doc({ id: 4, pinned: true, confidence: 10 }),
      doc({ id: 5, kind: null }),
      doc({ id: 6, confidence: 30, recallCount: 0, updatedAt: ago(1) }),
    ],
    settings: {},
    now: NOW,
  });
  assert.deepEqual(plan.archive.map((item) => item.id), [1]);
  assert.match(plan.archive[0].reason, /置信度/);
  assert.deepEqual(plan.purge, []);
});

test('冷召回：长期未召回且召回 < 2 才归档；归档超过保留天数进清理列表', () => {
  const plan = planHygiene({
    docs: [
      doc({ id: 1, confidence: 45, recallCount: 1, lastRecalledAt: ago(120) }),
      doc({ id: 2, confidence: 45, recallCount: 5, lastRecalledAt: ago(120) }),
      doc({ id: 3, staleAt: ago(1) }),
      doc({ id: 4, staleAt: ago(30) }),
    ],
    settings: {},
    now: NOW,
  });
  assert.deepEqual(plan.archive.map((item) => item.id), [1]);
  assert.deepEqual(plan.purge.map((item) => item.id), [4]);
});

test('阈值可调：配置档 → 知识库 的 kb.* 生效，默认归档保留 7 天', () => {
  const cfg = resolveHygieneSettings({ kb: { confidenceFloor: 70, archiveTtlDays: 3, staleAgeDays: 2 } });
  assert.equal(cfg.confidenceFloor, 70);
  assert.equal(cfg.archiveTtlDays, 3);
  assert.equal(cfg.staleAgeDays, 2);
  const flat = resolveHygieneSettings({ 'kb.confidenceFloor': 10 });
  assert.equal(flat.confidenceFloor, 10);
  assert.equal(HYGIENE_DEFAULTS.archiveTtlDays, 7);
});
