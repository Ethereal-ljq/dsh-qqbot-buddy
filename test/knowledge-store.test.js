/**
 * knowledge-store 单测：知识库设置解析 + 通用条目库特化。
 * 覆盖：默认目录/config 默认与钳制、settings 热改目录、显式 dir 覆盖、
 *       CRUD / 检索 / 召回 / stats / groups、settings 读取容错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeStore, KNOWLEDGE_DEFAULTS } from '../lib/knowledge/store.js';

function makeBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-knowledge-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** settings 用可变闭包模拟设置页热改 */
function makeSettings(initial = {}) {
  let snapshot = initial;
  return {
    get: () => snapshot,
    set(next) {
      snapshot = next;
    },
    patch(part) {
      snapshot = { ...snapshot, ...part };
    },
  };
}

test('config：settings 缺省时用内置默认（§2.3）', (t) => {
  const base = makeBase(t);
  const oldCwd = process.cwd();
  process.chdir(base);
  t.after(() => process.chdir(oldCwd));

  const store = createKnowledgeStore({ settings: makeSettings({}), logger: { warn() {} } });
  const cfg = store.config();
  assert.deepEqual(cfg, {
    enabled: true,
    dir: path.join(process.cwd(), 'knowledge'),
    injectMaxChars: 2500,
    maxPerTurn: 4,
    autoExtract: { enabled: false, everyRounds: 6, maxEntries: 3, minConfidence: 0.8, provider: '', model: '' },
  });
  assert.equal(KNOWLEDGE_DEFAULTS.autoExtract.enabled, false);
  assert.equal(KNOWLEDGE_DEFAULTS.autoExtract.everyRounds, 6);
  assert.equal(KNOWLEDGE_DEFAULTS.autoExtract.maxEntries, 3);
  assert.equal(KNOWLEDGE_DEFAULTS.autoExtract.minConfidence, 0.8);
  assert.equal(store.kind(), 'knowledge');
});

test('config：读取 settings.knowledge.dir，数值越界会被钳制', (t) => {
  const base = makeBase(t);
  const dir = path.join(base, 'kb');
  const settings = makeSettings({
    knowledge: { enabled: false, dir, injectMaxChars: 999_999, maxPerTurn: 0, autoExtract: true },
  });
  const store = createKnowledgeStore({ settings, logger: { warn() {} } });
  const cfg = store.config();
  assert.equal(cfg.dir, path.resolve(dir));
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.injectMaxChars, 20_000);
  assert.equal(cfg.maxPerTurn, 0, '0 = 关闭注入，不应被抬成 1');
  assert.equal(cfg.autoExtract.enabled, true, 'autoExtract: true 兼容成对象');
  assert.equal(cfg.autoExtract.everyRounds, 6);
  assert.equal(cfg.autoExtract.minConfidence, 0.8);
  assert.equal(store.dir(), path.resolve(dir));
});

test('settings 热改目录立即生效；已有数据留在旧目录', (t) => {
  const base = makeBase(t);
  const dirA = path.join(base, 'a');
  const dirB = path.join(base, 'b');
  const settings = makeSettings({ knowledge: { dir: dirA } });
  const store = createKnowledgeStore({ settings, logger: { warn() {} } });

  const first = store.save({ title: 'A 目录知识', body: '正文 a' });
  assert.equal(fs.existsSync(path.join(dirA, 'entries', `${first.id}.md`)), true);

  settings.patch({ knowledge: { dir: dirB } });
  assert.equal(store.dir(), path.resolve(dirB));
  const second = store.save({ title: 'B 目录知识', body: '正文 b' });
  assert.equal(fs.existsSync(path.join(dirB, 'entries', `${second.id}.md`)), true);
  assert.equal(store.get(first.id), null, '切目录后旧目录数据不再可见');
  assert.deepEqual(store.list({}).items.map((item) => item.id), [second.id]);
});

test('显式 dir 参数优先于 settings（测试 / 多实例隔离用）', (t) => {
  const base = makeBase(t);
  const explicit = path.join(base, 'explicit');
  const settings = makeSettings({ knowledge: { dir: path.join(base, 'from-settings') } });
  const store = createKnowledgeStore({ settings, dir: explicit, logger: { warn() {} } });
  assert.equal(store.dir(), path.resolve(explicit));
  store.ensure();
  assert.equal(fs.existsSync(path.join(explicit, 'entries')), true);
  assert.equal(fs.existsSync(path.join(base, 'from-settings')), false);
});

test('CRUD + 检索 + 召回：kind 固定 knowledge，save 传入 kind 会被忽略', (t) => {
  const base = makeBase(t);
  const settings = makeSettings({ knowledge: { dir: path.join(base, 'kb') } });
  const store = createKnowledgeStore({ settings, logger: { warn() {} } });
  store.ensure();

  const rule = store.save({
    kind: 'member', // 应被强制成 knowledge
    title: '本群群规',
    body: '禁止广告，禁止刷屏',
    tags: ['群规'],
    scope: 'group',
    groupId: 'g1',
    importance: 2,
  });
  const global = store.save({ title: '机器人说明', body: '本机器人支持知识库', tags: ['说明'] });
  assert.equal(rule.kind, 'knowledge');

  assert.equal(store.get(rule.id).title, '本群群规');
  assert.equal(store.search('群规')[0].id, rule.id);
  assert.equal(store.search('知识库')[0].id, global.id);
  assert.deepEqual(store.list({ scope: 'global' }).items.map((item) => item.id), [global.id]);
  assert.equal(store.list({ groupId: 'g1' }).total, 2);

  const recalled = store.recall({ query: '广告', groupId: 'g1' });
  assert.equal(recalled[0].id, rule.id);
  // emergence 传 scope='group' + groupId 时，global 条目仍参与召回
  const scoped = store.recall({ query: '群规', scope: 'group', groupId: 'g1' });
  assert.ok(scoped.some((item) => item.id === rule.id));
  assert.equal(store.recall({ query: '广告', groupId: 'g2' }).length, 0);

  assert.equal(store.stats().total, 2);
  assert.deepEqual(store.stats().byScope, { global: 1, group: 1, c2c: 0 });
  assert.deepEqual(store.groups(), [{ groupId: 'g1', count: 1, name: '' }]);

  // 更新与删除
  const updated = store.save({ id: rule.id, title: '本群群规（修订）', body: '禁止广告、刷屏与人身攻击' });
  assert.equal(updated.createdAt, rule.createdAt);
  assert.equal(updated.importance, rule.importance, '未传字段保留旧值');
  assert.deepEqual(store.remove(rule.id), { ok: true, id: rule.id, removed: true });
  assert.equal(store.get(rule.id), null);
  assert.equal(store.stats().total, 1);
});

test('settings 读取抛错 / 返回非对象：容错为默认值并 warn', (t) => {
  const base = makeBase(t);
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args.join(' ')) };
  const throwing = { get: () => { throw new Error('boom'); } };
  const store = createKnowledgeStore({ settings: throwing, dir: path.join(base, 'kb'), logger });
  store.ensure();
  const cfg = store.config();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.injectMaxChars, 2500);
  assert.ok(warnings.some((line) => line.includes('读取 settings.knowledge 失败')));
  // 仍能正常读写
  const entry = store.save({ title: '容错', body: 'x' });
  assert.equal(store.get(entry.id).title, '容错');

  const weird = { get: () => ({ knowledge: 'not-an-object' }) };
  const store2 = createKnowledgeStore({ settings: weird, dir: path.join(base, 'kb2'), logger });
  assert.equal(store2.config().maxPerTurn, 4);
});

test('ensure / flush / rebuild / reload 暴露完整', (t) => {
  const base = makeBase(t);
  const dir = path.join(base, 'kb');
  const store = createKnowledgeStore({ settings: makeSettings({ knowledge: { dir } }), logger: { warn() {} } });
  assert.deepEqual(store.ensure(), { ok: true, created: true });
  store.save({ title: 'a', body: 'b' }, { deferIndex: true });
  // save 支持第二个参数透传（延迟索引）
  assert.equal(fs.existsSync(path.join(dir, '.index-dirty')), true);
  assert.deepEqual(store.flush(), { ok: true, flushed: true });
  assert.equal(fs.existsSync(path.join(dir, '.index-dirty')), false);
  assert.equal(store.rebuild().entries.length, 1);
  assert.deepEqual(store.reload(), { ok: true });
  assert.equal(store.list({}).total, 1);
  assert.equal(store.all().length, 1);
});
