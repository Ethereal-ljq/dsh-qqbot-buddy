/**
 * members-store 单测：群友库（openid 稳定 id、visit 轻量 upsert、群聚合、召回权重）。
 * 全程隔离临时目录，不触碰真实工作区。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createMemberStore, memberId, MEMBER_DEFAULTS } from '../lib/members/store.js';

const QUIET_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

function makeBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-members-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function makeSettings(initial = {}) {
  let snapshot = initial;
  return {
    get: () => snapshot,
    patch(part) {
      snapshot = { ...snapshot, ...part };
    },
  };
}

function makeStore(t, dir) {
  const base = dir ?? makeBase(t);
  const membersDir = dir ?? path.join(base, 'members');
  const settings = makeSettings({ members: { dir: membersDir } });
  const store = createMemberStore({ settings, logger: QUIET_LOGGER });
  // t.after LIFO：先 flush 清掉延迟写定时器，再让 makeBase 注册的清理删目录
  t.after(() => { try { store.flush(); } catch { /* 清理失败忽略 */ } });
  return { store, settings, dir: membersDir, base };
}

/** 与实现一致的派生算法 */
function expectedId(openid) {
  return `m_${createHash('sha1').update(openid, 'utf8').digest('hex').slice(0, 16)}`;
}

test('memberId：由 openid 稳定派生 m_<sha1 前 16 位>', (t) => {
  assert.equal(memberId('openid-1'), expectedId('openid-1'));
  assert.match(memberId('openid-1'), /^m_[0-9a-f]{16}$/);
  assert.equal(memberId('openid-1'), memberId('openid-1'));
  assert.notEqual(memberId('openid-1'), memberId('openid-2'));
  assert.equal(memberId(''), '');
  assert.equal(memberId('  wanted  '), memberId('wanted'), 'trim 后派生');

  const { store } = makeStore(t);
  assert.equal(store.idFor('openid-1'), memberId('openid-1'));
  assert.equal(store.kind(), 'member');
});

test('visit：新建成员、重复 visit 累加 messageCount 且不产生重复条目', (t) => {
  const { store, dir } = makeStore(t);
  const first = store.visit({
    groupId: 'g1',
    groupName: '测试群',
    openid: 'u1',
    name: '小明',
    at: '2026-10-01T10:00:00.000Z',
  });
  assert.equal(first.id, expectedId('u1'));
  assert.equal(first.kind, 'member');
  assert.equal(first.title, '小明');
  assert.equal(first.scope, 'global');
  assert.equal(first.meta.openid, 'u1');
  assert.deepEqual(first.meta.groups.g1, {
    name: '测试群',
    firstSeenAt: '2026-10-01T10:00:00.000Z',
    lastSeenAt: '2026-10-01T10:00:00.000Z',
    messageCount: 1,
  });

  const second = store.visit({ groupId: 'g1', openid: 'u1', name: '小明', at: '2026-10-02T10:00:00.000Z' });
  assert.equal(second.id, first.id);
  assert.equal(second.meta.groups.g1.messageCount, 2);
  assert.equal(second.meta.groups.g1.firstSeenAt, '2026-10-01T10:00:00.000Z');
  assert.equal(second.meta.groups.g1.lastSeenAt, '2026-10-02T10:00:00.000Z');
  assert.equal(second.meta.groups.g1.name, '测试群', '未提供群名时保留旧群名');

  // 50 次 visit 仍然只有 1 个成员文件
  for (let i = 0; i < 50; i += 1) store.visit({ groupId: 'g1', openid: 'u1' });
  assert.equal(fs.readdirSync(path.join(dir, 'entries')).length, 1);
  assert.equal(store.get(first.id).meta.groups.g1.messageCount, 52);

  // 昵称更新会同步到标题；缺省时不覆盖
  const renamed = store.visit({ groupId: 'g1', openid: 'u1', name: '小明（新昵称）' });
  assert.equal(renamed.title, '小明（新昵称）');
  assert.equal(store.visit({ groupId: 'g1', openid: 'u1' }).title, '小明（新昵称）');

  // 无群消息（私聊）也能记录
  const privateVisit = store.visit({ openid: 'u9', name: '私聊用户' });
  assert.deepEqual(privateVisit.meta.groups, {});
  assert.equal(privateVisit.meta.openid, 'u9');
  assert.equal(store.getByOpenid('u9').title, '私聊用户');
  assert.equal(store.getByOpenid('missing-openid'), null);
});

test('visit：多群画像 + 群聚合 + list 群过滤', (t) => {
  const { store } = makeStore(t);
  store.visit({ groupId: 'g1', groupName: '一群', openid: 'u1', name: '小明', at: '2026-10-01T10:00:00.000Z' });
  store.visit({ groupId: 'g1', groupName: '一群', openid: 'u1', name: '小明', at: '2026-10-01T10:01:00.000Z' });
  store.visit({ groupId: 'g2', groupName: '二群', openid: 'u1', name: '小明', at: '2026-10-01T10:02:00.000Z' });
  store.visit({ groupId: 'g2', groupName: '二群', openid: 'u2', name: '小红', at: '2026-10-01T10:03:00.000Z' });
  store.visit({ groupId: 'g2', groupName: '二群', openid: 'u2', name: '小红', at: '2026-10-01T10:04:00.000Z' });
  store.visit({ groupId: 'g2', groupName: '二群', openid: 'u2', name: '小红', at: '2026-10-01T10:05:00.000Z' });

  const u1 = store.getByOpenid('u1');
  assert.deepEqual(Object.keys(u1.meta.groups).sort(), ['g1', 'g2']);
  assert.equal(u1.meta.groups.g1.messageCount, 2);
  assert.equal(u1.meta.groups.g2.messageCount, 1);

  assert.equal(store.list({ groupId: 'g1' }).total, 1);
  const g2 = store.list({ groupId: 'g2' });
  assert.equal(g2.total, 2);
  assert.equal(g2.items[0].name, '小红', '按最近活跃倒序');
  assert.equal(g2.items[0].messageCount, 3, 'messageCount 是跨群总数');
  assert.equal(g2.items[1].name, '小明');
  assert.equal(g2.items[1].messageCount, 3, '小明：一群 2 条 + 二群 1 条');
  assert.equal(g2.items[1].groups.find((group) => group.groupId === 'g2').messageCount, 1, '按群统计应只算该群');
  assert.equal(store.list({}).total, 2);

  assert.deepEqual(store.groups().map((item) => [item.groupId, item.count, item.name]), [
    ['g2', 2, '二群'],
    ['g1', 1, '一群'],
  ]);

  const item = store.item(u1.id);
  assert.equal(item.openid, 'u1');
  assert.equal(item.groups.length, 2);
  assert.equal(store.item('m_missing'), null);
});

test('list：按名字/别名/备注搜索、tag 过滤、limit 与 offset', (t) => {
  const { store } = makeStore(t);
  const a = store.visit({ groupId: 'g1', openid: 'u1', name: '小明' });
  store.visit({ groupId: 'g1', openid: 'u2', name: '小红' });
  store.visit({ groupId: 'g1', openid: 'u3', name: '阿强' });
  store.save({ id: a.id, tags: ['程序员'], notes: '喜欢喝美式咖啡，养了一只猫', aliases: ['明明'] });

  assert.deepEqual(store.list({ q: '小红' }).items.map((item) => item.name), ['小红']);
  assert.deepEqual(store.list({ q: '明明' }).items.map((item) => item.id), [a.id], '别名可检索');
  assert.deepEqual(store.list({ q: '咖啡' }).items.map((item) => item.id), [a.id], '备注可检索');
  assert.deepEqual(store.list({ q: '不存在的词' }).total, 0);
  assert.deepEqual(store.list({ tag: '程序员' }).items.map((item) => item.id), [a.id]);

  assert.equal(store.list({ limit: 2 }).items.length, 2);
  assert.equal(store.list({ limit: 2, offset: 2 }).items.length, 1);
  assert.equal(store.list({ limit: 2 }).total, 3);
});

test('recallAlly：群内成员召回、发言人本人最高权重、query 过滤、limit', (t) => {
  const { store } = makeStore(t);
  store.visit({ groupId: 'g1', groupName: '一群', openid: 'u1', name: '小明' });
  store.visit({ groupId: 'g1', groupName: '一群', openid: 'u2', name: '小红' });
  store.visit({ groupId: 'g1', groupName: '一群', openid: 'u2', name: '小红' });
  store.visit({ groupId: 'g1', groupName: '一群', openid: 'u2', name: '小红' });
  store.visit({ groupId: 'g2', groupName: '二群', openid: 'u3', name: '小刚' });

  // 发言人本人最高权重（即使其它人更活跃）
  const bySender = store.recallAlly({ groupId: 'g1', senderId: 'u1' });
  assert.equal(bySender[0].title, '小明');
  assert.equal(bySender[0].meta.openid, 'u1');
  assert.ok(bySender[0].score > bySender[1].score);
  assert.equal(bySender[0].group.groupId, 'g1');
  assert.ok(bySender.every((item) => item.group && item.group.groupId === 'g1'), '只召回当前群成员');
  assert.equal(bySender.some((item) => item.title === '小刚'), false, '其它群成员不返回');

  // query 命中名字
  const byName = store.recallAlly({ groupId: 'g1', query: '小红' });
  assert.equal(byName[0].title, '小红');
  // 群内无此人时，query 不回退到其它群
  assert.deepEqual(store.recallAlly({ groupId: 'g1', query: '小刚' }), []);

  // 私聊（无 groupId）：不按群过滤
  const all = store.recallAlly({ query: '小刚' });
  assert.equal(all[0].title, '小刚');
  assert.equal(all[0].group, null);

  // limit
  assert.equal(store.recallAlly({ groupId: 'g1', limit: 1 }).length, 1);
  assert.equal(store.recallAlly({ groupId: 'g1', limit: 999 }).length, 2);
});

test('save：编辑备注 / 标签 / 重要度 / 别名；按 openid 新建；错误入参', (t) => {
  const { store } = makeStore(t);
  const visited = store.visit({ groupId: 'g1', openid: 'u1', name: '小明' });
  const saved = store.save({
    id: visited.id,
    name: '小明同学',
    tags: ['老群友', '程序员'],
    notes: '负责群活动组织',
    aliases: ['明明'],
    importance: 3,
  });
  assert.equal(saved.id, visited.id);
  assert.equal(saved.title, '小明同学');
  assert.deepEqual(saved.tags, ['老群友', '程序员']);
  assert.equal(saved.body, '负责群活动组织');
  assert.equal(saved.importance, 3);
  assert.deepEqual(saved.meta.aliases, ['明明']);
  assert.equal(saved.meta.groups.g1.messageCount, 1, '编辑画像不影响发言统计');

  const loaded = store.get(visited.id);
  assert.equal(loaded.body, '负责群活动组织');
  assert.equal(store.item(visited.id).note, '负责群活动组织');

  // 按 openid 手工新建
  const created = store.save({ openid: 'u-new', name: '新朋友', notes: '刚进群' });
  assert.equal(created.id, expectedId('u-new'));
  assert.equal(created.meta.openid, 'u-new');

  // Web 路由风格：{ title, body } 等同 { name, notes }
  const viaRoute = store.save({
    id: visited.id,
    title: '路由改名',
    body: '路由写入的备注',
    tags: ['api'],
    importance: 1,
  });
  assert.equal(viaRoute.title, '路由改名');
  assert.equal(store.get(visited.id).body, '路由写入的备注');
  assert.deepEqual(store.get(visited.id).tags, ['api']);

  // 非法入参
  assert.throws(() => store.save({}), /需要 id 或 openid/);
  assert.throws(() => store.save({ id: 'm_missing' }), /成员不存在/);
  assert.throws(() => store.visit({}), /openid 不能为空/);
});

test('visit：at 支持毫秒数（inbound 传 Date.now()）', (t) => {
  const { store } = makeStore(t);
  const at = Date.parse('2026-10-05T12:00:00.000Z');
  const entry = store.visit({ groupId: 'g1', openid: 'u1', name: '小明', at });
  assert.equal(entry.meta.groups.g1.lastSeenAt, '2026-10-05T12:00:00.000Z');
  assert.equal(entry.meta.groups.g1.firstSeenAt, '2026-10-05T12:00:00.000Z');
  store.flush();
});

test('remove / stats：删除成员并从聚合中消失', (t) => {
  const { store } = makeStore(t);
  store.visit({ groupId: 'g1', groupName: '一群', openid: 'u1', name: '小明' });
  store.visit({ groupId: 'g2', groupName: '二群', openid: 'u2', name: '小红' });
  store.save({ openid: 'u1', importance: 3, notes: '重要成员' });

  const stats = store.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.groups, 2);
  assert.equal(stats.messages, 2);
  assert.deepEqual(stats.byImportance, { high: 1, normal: 1 });
  assert.ok(Array.isArray(stats.tags), 'GET /members 会读 stats.tags');
  assert.ok(Number.isFinite(Date.parse(stats.lastSeenAt)));

  assert.deepEqual(store.remove(expectedId('u1')), { ok: true, id: expectedId('u1'), removed: true });
  assert.equal(store.getByOpenid('u1'), null);
  assert.equal(store.list({}).total, 1);
  assert.deepEqual(store.groups().map((item) => item.groupId), ['g2']);
  assert.deepEqual(store.remove(expectedId('u1')), { ok: true, id: expectedId('u1'), removed: false });
  assert.throws(() => store.remove(''), /id 不能为空/);
});

test('延迟索引：visit 后保留 .index-dirty，flush 落盘并清除；新实例可直接读到成员', (t) => {
  const { store, dir, settings } = makeStore(t);
  const visited = store.visit({ groupId: 'g1', openid: 'u1', name: '小明' });
  const dirty = path.join(dir, '.index-dirty');
  assert.equal(fs.existsSync(dirty), true, 'visit 走延迟索引，应留下 dirty 标记');

  // 模拟进程重启：新实例从成员文件恢复（不依赖 index.json）
  const fresh = createMemberStore({ settings, logger: QUIET_LOGGER });
  assert.equal(fresh.list({ groupId: 'g1' }).total, 1);
  assert.equal(fresh.getByOpenid('u1').title, '小明');

  // flush 后索引落盘、标记清除
  assert.deepEqual(fresh.flush(), { ok: true, flushed: false }, '新实例尚无内存索引，flush 为空操作');
  const storeFlush = store.flush();
  assert.equal(storeFlush.ok, true);
  assert.equal(fs.existsSync(dirty), false);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.kind, 'member');
  assert.ok(index.entries.some((row) => row.id === visited.id));

  // 收尾：确保没有遗留定时器在测试清理目录后再写盘
  store.flush();
});

test('config：settings.members 缺省值 / 钳制 / 热改目录；ensure 建目录', (t) => {
  const base = makeBase(t);
  const dirA = path.join(base, 'a');
  const dirB = path.join(base, 'b');
  const settings = makeSettings({ members: { dir: dirA, maxPerTurn: 99, maxChars: 1 } });
  const store = createMemberStore({ settings, logger: QUIET_LOGGER });
  const cfg = store.config();
  assert.deepEqual(cfg, {
    enabled: true,
    dir: path.resolve(dirA),
    autoRecord: true,
    injectSender: true,
    maxPerTurn: 20,
    maxChars: 1,
  });
  assert.deepEqual(MEMBER_DEFAULTS, { enabled: true, autoRecord: true, injectSender: true, maxPerTurn: 3, maxChars: 800 });
  assert.deepEqual(store.ensure(), { ok: true, created: true });
  assert.equal(fs.existsSync(path.join(dirA, 'entries')), true);

  settings.patch({ members: { dir: dirB, enabled: false, autoRecord: false, injectSender: false } });
  assert.equal(store.dir(), path.resolve(dirB));
  const saved = store.save({ openid: 'u1', name: '跨目录' });
  assert.equal(fs.existsSync(path.join(dirB, 'entries', `${saved.id}.md`)), true);
  assert.equal(store.config().enabled, false);
  assert.equal(store.config().autoRecord, false);
  assert.equal(store.config().injectSender, false);
  assert.equal(store.getByOpenid('u1').title, '跨目录');
});

test('settings 读取抛错：容错默认值并可正常工作', (t) => {
  const base = makeBase(t);
  const warnings = [];
  const store = createMemberStore({
    settings: { get: () => { throw new Error('boom'); } },
    dir: path.join(base, 'members'),
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  assert.equal(store.config().maxPerTurn, 3);
  const entry = store.visit({ groupId: 'g1', openid: 'u1', name: 'x' });
  assert.equal(store.get(entry.id).title, 'x');
  assert.ok(warnings.some((line) => line.includes('读取 settings.members 失败')));
  store.flush();
});
