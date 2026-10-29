/**
 * entries-store 单测：隔离临时目录，不触碰真实工作区/网络。
 * 覆盖：CRUD / frontmatter 自解析 / 索引增量与重建 / 作用域检索 / 中文 2-gram / 英文 /
 *       损坏恢复 / id 越界 / 大小上限 / 原子写 0600 / 延迟写标记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEntryStore, tokenize, matchScore } from '../lib/entries/store.js';

const QUIET_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

/** 建隔离临时目录；t.after 负责清理 */
function makeBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-entries-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function makeStore(t, overrides = {}) {
  const base = makeBase(t);
  const dir = path.join(base, 'knowledge');
  const store = createEntryStore({ dir, kind: 'knowledge', logger: QUIET_LOGGER, ...overrides });
  // t.after LIFO：先 flush 清掉延迟写定时器，再让 makeBase 注册的清理删目录
  t.after(() => { try { store.flush(); } catch { /* 清理失败忽略 */ } });
  return { store, base, dir };
}

/** 索引记录字段（与实现保持一致的检索必需字段） */
const INDEX_KEYS = ['createdAt', 'groupId', 'groupName', 'hits', 'id', 'importance', 'lastHitAt', 'scope', 'source', 'status', 'summary', 'tags', 'title', 'updatedAt'];

/** 递归收集 .tmp- 残留 */
function tmpLeftovers(dir) {
  const out = [];
  const walk = (base) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.includes('.tmp-')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

test('ensure 创建目录；dir 返回绝对路径；kind 固定', (t) => {
  const { store, dir } = makeStore(t);
  assert.equal(store.dir(), path.resolve(dir));
  assert.equal(store.kind(), 'knowledge');
  assert.equal(fs.existsSync(dir), false);

  assert.deepEqual(store.ensure(), { ok: true, created: true });
  assert.equal(fs.existsSync(path.join(dir, 'entries')), true);
  assert.deepEqual(store.ensure(), { ok: true, created: false });
  // 空目录时 list/search/stats 均为空，不报错
  assert.deepEqual(store.list({}), { total: 0, items: [] });
  assert.deepEqual(store.search('任何'), []);
  assert.deepEqual(store.recall({ query: '任何' }), []);
  assert.equal(store.stats().total, 0);
  assert.deepEqual(store.groups(), []);
});

test('save 新建：frontmatter + 空行 + markdown 正文，权限 0600，index 只存检索字段', (t) => {
  const { store, dir } = makeStore(t);
  const entry = store.save({
    title: '咖啡偏好',
    body: '# 正文标题\n\n用户喜欢喝美式咖啡。',
    tags: ['偏好', '咖啡'],
    scope: 'group',
    groupId: 'g1',
    groupName: '测试群',
    importance: 2,
    source: 'tool',
    meta: { openid: 'u1' },
  });

  assert.match(entry.id, /^k_[a-z0-9]+$/);
  assert.equal(entry.kind, 'knowledge');
  assert.equal(entry.title, '咖啡偏好');
  assert.equal(entry.scope, 'group');
  assert.equal(entry.importance, 2);
  assert.equal(entry.hits, 0);
  assert.ok(Number.isFinite(Date.parse(entry.createdAt)));

  const file = path.join(dir, 'entries', `${entry.id}.md`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('---\n'), '文件必须以 --- 开头');
  assert.match(text, /^id: k_\w+$/m);
  assert.match(text, /^kind: knowledge$/m);
  assert.match(text, /^title: 咖啡偏好$/m);
  assert.match(text, /^tags: \[偏好, 咖啡\]$/m, '数组用 [a, b] 简写');
  assert.match(text, /^scope: group$/m);
  assert.match(text, /^importance: 2$/m);
  assert.match(text, /^meta: \{"openid":"u1"\}$/m);
  assert.ok(text.includes('---\n\n# 正文标题\n\n用户喜欢喝美式咖啡。\n'), 'frontmatter 后空一行再接正文');

  // 100% 往返
  const loaded = store.get(entry.id);
  assert.deepEqual(loaded, entry);

  // index.json 只存检索必需字段
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(index.version, 1);
  assert.equal(index.kind, 'knowledge');
  assert.equal(index.entries.length, 1);
  assert.deepEqual(Object.keys(index.entries[0]).sort(), INDEX_KEYS);
  assert.equal(index.entries[0].summary, '正文标题 用户喜欢喝美式咖啡。', '索引摘要会压平 markdown 标题标记');
  assert.equal(fs.statSync(path.join(dir, 'index.json')).mode & 0o777, 0o600);
  assert.deepEqual(tmpLeftovers(dir), []);
});

test('save 无 id 自动生成；无标题用正文首行；空正文也能保存', (t) => {
  const { store } = makeStore(t);
  const derived = store.save({ body: '## 群规第一条\n\n禁止广告' });
  assert.equal(derived.title, '群规第一条');
  const empty = store.save({ title: '仅标题' });
  assert.equal(empty.body, '');
  assert.match(store.get(empty.id).title, /仅标题/);
});

test('save 更新保留 createdAt / hits；重复保存不产生新文件', (t) => {
  const { store, dir } = makeStore(t);
  const first = store.save({ title: '旧标题', body: '旧正文', tags: ['a'], importance: 0 });
  const updated = store.save({ id: first.id, title: '新标题', body: '新正文', tags: ['b'], importance: 3 });
  assert.equal(updated.id, first.id);
  assert.equal(updated.createdAt, first.createdAt);
  assert.ok(updated.updatedAt >= first.updatedAt);
  assert.deepEqual(updated.tags, ['b']);
  assert.equal(store.get(first.id).title, '新标题');
  assert.equal(fs.readdirSync(path.join(dir, 'entries')).length, 1);
});

test('frontmatter 特殊字符（冒号 / 引号 / 方括号 / 多行 meta）往返正确', (t) => {
  const { store } = makeStore(t);
  const title = '提示: 用 "引号" 与 [括号] 测试';
  const body = '第一行\n第二行 # 井号\n\n- 列表 a\n- 列表 b';
  const meta = { openid: 'u1', groups: { g1: { name: '群: 一', messageCount: 2, lastSeenAt: '2026-10-01T00:00:00.000Z' } } };
  const entry = store.save({ title, body, tags: ['a:b', '含 空格'], meta });
  const loaded = store.get(entry.id);
  assert.equal(loaded.title, title);
  assert.equal(loaded.body, body);
  assert.deepEqual(loaded.tags, ['a:b', '含-空格']);
  assert.deepEqual(loaded.meta, meta);
});

test('get / remove / list 过滤与分页', (t) => {
  const { store } = makeStore(t);
  const g1 = store.save({ title: '群规', body: '禁止广告', tags: ['群规'], scope: 'group', groupId: 'g1', importance: 3 });
  const g2 = store.save({ title: '二群活动', body: '周五聚餐', tags: ['活动'], scope: 'group', groupId: 'g2' });
  const global = store.save({ title: '通用说明', body: '本机器人由插件提供', tags: ['说明'], scope: 'global' });

  assert.equal(store.get(g1.id).title, '群规');
  assert.equal(store.get('k_missing'), null);
  assert.equal(store.get(g1.id).groupName, '');

  // 按作用域严格过滤
  assert.deepEqual(store.list({ scope: 'group' }).items.map((item) => item.id).sort(), [g1.id, g2.id].sort());
  assert.deepEqual(store.list({ scope: 'global' }).items.map((item) => item.id), [global.id]);
  // 群上下文：本群 + global（不含其它群）
  const g1Items = store.list({ groupId: 'g1' }).items.map((item) => item.id).sort();
  assert.deepEqual(g1Items, [g1.id, global.id].sort());
  assert.deepEqual(store.list({ groupId: 'g1', scope: 'group' }).items.map((item) => item.id), [g1.id]);

  // tag 精确过滤
  assert.deepEqual(store.list({ tag: '活动' }).items.map((item) => item.id), [g2.id]);
  // q 检索
  assert.deepEqual(store.list({ q: '聚餐' }).items.map((item) => item.id), [g2.id]);
  assert.equal(store.list({ q: '不存在的词' }).total, 0);
  // 分页：默认按 updatedAt 倒序
  const page1 = store.list({ limit: 2 });
  assert.equal(page1.total, 3);
  assert.equal(page1.items.length, 2);
  const page2 = store.list({ limit: 2, offset: 2 });
  assert.equal(page2.items.length, 1);
  assert.deepEqual([...page1.items.map((i) => i.id), ...page2.items.map((i) => i.id)].sort(), [g1.id, g2.id, global.id].sort());

  // remove
  assert.deepEqual(store.remove(g2.id), { ok: true, id: g2.id, removed: true });
  assert.equal(store.get(g2.id), null);
  assert.equal(store.list({}).total, 2);
  assert.deepEqual(store.remove(g2.id), { ok: true, id: g2.id, removed: false });
});

test('search：中文 2-gram、英文大小写不敏感、标题权重高于正文、超限裁剪', (t) => {
  const { store } = makeStore(t);
  const coffee = store.save({ title: '咖啡偏好', body: '用户喜欢喝美式咖啡，不加糖', tags: ['偏好'] });
  const tea = store.save({ title: '茶', body: '咖啡机在茶水间，管理员喜欢喝茶' });
  const english = store.save({ title: 'Coffee Notes', body: 'Iced americano is the favorite' });

  const cn = store.search('美式咖啡');
  assert.equal(cn[0].id, coffee.id, '标题命中的应排前面');
  assert.deepEqual(Object.keys(cn[0]).sort(), ['id', 'score', 'snippet', 'tags', 'title']);
  assert.ok(cn[0].score > 0);
  assert.ok(cn.some((item) => item.id === tea.id), '正文摘要命中也应返回');
  assert.ok(cn[0].snippet.includes('美式咖啡'));

  const en = store.search('COFFEE');
  assert.ok(en.some((item) => item.id === english.id));
  // 英文词不应把中文条目算进来
  assert.equal(en.find((item) => item.id === coffee.id), undefined);

  assert.equal(store.search('').length, 0);
  assert.equal(store.search('   ').length, 0);
  assert.deepEqual(store.search('绝对不存在的词'), []);
  assert.equal(store.search('咖啡', { limit: 1 }).length, 1);
  assert.equal(store.search('咖啡', { limit: 999 }).length <= 50, true);
  // 作用域 / 群过滤：这里的条目都是 global，所以 scope=group 搜不到，带 groupId 仍能搜到 global
  assert.equal(store.search('咖啡', { scope: 'group' }).length, 0);
  assert.equal(store.search('咖啡', { groupId: 'g1' }).length >= 1, true);
});

test('recall：当前群 > global > 其它群（其它群默认不返回），支持无 query 排序', (t) => {
  const { store } = makeStore(t);
  const inGroup = store.save({ title: '本群暗号', body: '暗号是芝麻开门', tags: ['暗号'], scope: 'group', groupId: 'g1', importance: 0 });
  const global = store.save({ title: '通用暗号', body: '暗号是芝麻开门', tags: ['暗号'], scope: 'global', importance: 0 });
  const otherGroup = store.save({ title: '他群暗号', body: '暗号是芝麻开门', tags: ['暗号'], scope: 'group', groupId: 'g2', importance: 3 });

  const hits = store.recall({ query: '暗号', groupId: 'g1', limit: 6 });
  const ids = hits.map((item) => item.id);
  assert.ok(ids.includes(inGroup.id));
  assert.ok(ids.includes(global.id));
  assert.ok(!ids.includes(otherGroup.id), '其它群条目默认不返回');
  assert.equal(hits[0].id, inGroup.id, '当前群优先级最高');
  assert.ok(hits[0].score > hits[1].score);
  assert.ok(typeof hits[0].body === 'string', 'recall 返回完整条目');

  // scope=group（上下文类型）+ groupId：本群 + global，仍排除其它群
  const grouped = store.recall({ query: '暗号', scope: 'group', groupId: 'g1' });
  assert.deepEqual(grouped.map((item) => item.id).sort(), [inGroup.id, global.id].sort());
  // 显式 scope=global：只取全局
  assert.deepEqual(store.recall({ query: '暗号', scope: 'global', groupId: 'g1' }).map((item) => item.id), [global.id]);
  // 无群上下文：只返回 global
  assert.deepEqual(store.recall({ query: '暗号' }).map((item) => item.id), [global.id]);
  // 无 query：按 scope / importance / 新近排序
  const recent = store.recall({ groupId: 'g1', limit: 2 });
  assert.equal(recent[0].id, inGroup.id);
  // 字符串 query 兼容
  assert.equal(store.recall('暗号').length, 1);
  // limit 生效
  assert.equal(store.recall({ query: '暗号', groupId: 'g1', limit: 1 }).length, 1);
});

test('stats / groups 聚合', (t) => {
  const { store } = makeStore(t);
  store.save({ title: 'G1 知识', body: 'x', tags: ['共同', 'g1'], scope: 'group', groupId: 'g1', groupName: '一群' });
  store.save({ title: 'G1 知识2', body: 'x', tags: ['共同'], scope: 'group', groupId: 'g1' });
  store.save({ title: 'G2 知识', body: 'x', tags: ['g2'], scope: 'group', groupId: 'g2', groupName: '二群' });
  store.save({ title: '全局知识', body: 'x', tags: [], scope: 'global' });

  const stats = store.stats();
  assert.equal(stats.total, 4);
  assert.deepEqual(stats.byScope, { global: 1, group: 3, c2c: 0 });
  assert.deepEqual(stats.tags[0], { tag: '共同', count: 2 });
  assert.ok(Number.isFinite(Date.parse(stats.updatedAt)));

  const groups = store.groups();
  assert.deepEqual(groups[0], { groupId: 'g1', count: 2, name: '一群' });
  assert.deepEqual(groups.find((item) => item.groupId === 'g2'), { groupId: 'g2', count: 1, name: '二群' });
});

test('index.json 缺失 / 损坏 / kind 不符时自动按条目文件重建', (t) => {
  const { store, dir } = makeStore(t);
  const entry = store.save({ title: '需要重建', body: '正文', tags: ['a'] });
  const indexFile = path.join(dir, 'index.json');
  const fresh = () => createEntryStore({ dir, kind: 'knowledge', logger: QUIET_LOGGER });

  // 1) 缺失（新实例 = 进程重启）
  fs.rmSync(indexFile);
  assert.equal(fresh().list({}).total, 1);
  assert.ok(fs.existsSync(indexFile), '重建后应重新写 index.json');

  // 2) 损坏：备份 + 重建
  fs.writeFileSync(indexFile, '{ 这不是 JSON');
  assert.equal(fresh().list({}).items[0].id, entry.id);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('index.json.corrupt-')));

  // 3) kind 不符：重建
  const payload = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  payload.kind = 'member';
  payload.entries = [];
  fs.writeFileSync(indexFile, JSON.stringify(payload));
  assert.equal(fresh().list({}).total, 1);
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).kind, 'knowledge');
});

test('损坏条目文件只跳过不崩溃：无 frontmatter / 未闭合 / 非法文件名', (t) => {
  const { store, dir } = makeStore(t);
  const good = store.save({ title: '好条目', body: '正常正文' });
  const entriesDir = path.join(dir, 'entries');
  fs.writeFileSync(path.join(entriesDir, 'bad1.md'), '没有 frontmatter 的文本');
  fs.writeFileSync(path.join(entriesDir, 'bad2.md'), '---\nid: bad2\ntitle: 未闭合\n');
  fs.writeFileSync(path.join(entriesDir, '非法 名字.md'), '---\ntitle: x\n---\n');

  store.reload();
  assert.equal(store.list({}).total, 1);
  assert.equal(store.get('bad1'), null);
  assert.equal(store.get('bad2'), null);
  // 坏文件损坏不影响后续保存 / 重建
  const another = store.save({ title: '新条目', body: 'x' });
  assert.equal(store.list({}).total, 2);
  assert.ok(store.rebuild().entries.some((row) => row.id === good.id));
  assert.ok(store.rebuild().entries.some((row) => row.id === another.id));
});

test('id 校验：非法 id 抛错且不会写出目录', (t) => {
  const { store, base } = makeStore(t);
  store.ensure();
  for (const bad of ['../evil', 'a/b', '..', 'a b', '', 'k'.repeat(80)]) {
    assert.throws(() => store.get(bad), /entries-store: (非法 id|id 不能为空)/);
  }
  assert.throws(() => store.save({ id: '../evil', title: 'x' }), /非法 id/);
  assert.throws(() => store.remove('../evil'), /非法 id/);
  assert.equal(fs.existsSync(path.join(base, 'evil.md')), false);
  assert.equal(fs.existsSync(path.join(base, '..', 'evil.md')), false);
});

test('写入大小上限 256KB；读取上限不抛错（只读前缀）', (t) => {
  const { store, dir } = makeStore(t);
  assert.throws(() => store.save({ title: '太大', body: 'a'.repeat(256 * 1024) }), /超过/);
  // 直接放一个超过 1MB 的合法条目文件：读取只取前 1MB，不崩溃
  const big = path.join(dir, 'entries', 'k_big.md');
  fs.mkdirSync(path.dirname(big), { recursive: true });
  const body = 'a'.repeat(1024 * 1024 + 100);
  fs.writeFileSync(big, `---\nid: k_big\ntitle: 超大\n---\n\n${body}\n`);
  const loaded = store.get('k_big');
  assert.ok(loaded);
  // 只读前 1MB（含 frontmatter），正文被截断但不抛错
  assert.ok(loaded.body.length <= 1024 * 1024);
  assert.ok(loaded.body.length > 1024 * 1024 - 200);
});

test('deferIndex：只落 dirty 标记；新实例按标记全量重建；flush 落盘清标记', (t) => {
  const { store, dir } = makeStore(t);
  store.ensure();
  const entry = store.save({ title: '延迟写', body: '正文' }, { deferIndex: true });
  const dirty = path.join(dir, '.index-dirty');
  assert.equal(fs.existsSync(dirty), true, '延迟写应留下 .index-dirty 标记');
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.ok(!before.entries.some((row) => row.id === entry.id), '延迟期间 index.json 允许落后');

  // 模拟进程重启：新实例看到 dirty 标记 → 按条目文件重建
  const store2 = createEntryStore({ dir, kind: 'knowledge', logger: QUIET_LOGGER });
  assert.equal(store2.list({}).total, 1);
  assert.equal(fs.existsSync(dirty), false, '重建后标记应被清除');
  assert.ok(store2.list({}).items.some((row) => row.id === entry.id));

  // flush 路径
  const second = store2.save({ title: '再次延迟', body: 'y' }, { deferIndex: true });
  assert.equal(fs.existsSync(dirty), true);
  const flushed = store2.flush();
  assert.deepEqual(flushed, { ok: true, flushed: true });
  assert.equal(fs.existsSync(dirty), false);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.ok(after.entries.some((row) => row.id === second.id));
  // 第一个实例还有未触发的定时器：显式 flush 收尾，测试结束后不再写临时目录
  store.flush();
});

test('noteHit 累加命中次数；原子写无 .tmp 残留；目录函数热改立即生效', (t) => {
  const { store, dir } = makeStore(t);
  const entry = store.save({ title: '命中', body: 'x' });
  const hit = store.noteHit(entry.id);
  assert.equal(hit.hits, 1);
  assert.ok(Number.isFinite(Date.parse(hit.lastHitAt)));
  assert.equal(store.noteHit('k_missing'), null);
  assert.deepEqual(tmpLeftovers(dir), []);
  store.flush();

  // dir 是函数：切换后新建条目落在新目录，旧目录数据不再被看到
  const base2 = makeBase(t);
  const dirA = path.join(base2, 'a');
  const dirB = path.join(base2, 'b');
  let current = dirA;
  const hot = createEntryStore({ dir: () => current, kind: 'knowledge', logger: QUIET_LOGGER });
  const inA = hot.save({ title: 'A 目录', body: 'a' });
  assert.equal(fs.existsSync(path.join(dirA, 'entries', `${inA.id}.md`)), true);
  current = dirB;
  const inB = hot.save({ title: 'B 目录', body: 'b' });
  assert.equal(fs.existsSync(path.join(dirB, 'entries', `${inB.id}.md`)), true);
  assert.equal(fs.existsSync(path.join(dirA, 'entries', `${inB.id}.md`)), false);
  assert.equal(hot.get(inA.id), null);
  assert.deepEqual(hot.list({}).items.map((item) => item.id), [inB.id]);
});

test('tokenize/matchScore：中文 2-gram 与英文词；空 query 返回 0', () => {
  assert.deepEqual(tokenize('咖啡'), ['咖啡']);
  assert.deepEqual(tokenize('美式咖啡'), ['美式', '式咖', '咖啡']);
  assert.deepEqual(tokenize('Coffee Time'), ['coffee', 'time']);
  assert.deepEqual(tokenize('   '), []);
  assert.equal(matchScore('', { title: '咖啡' }), 0);
  assert.equal(matchScore('咖啡', { title: '咖啡偏好' }) > 0, true);
  assert.equal(matchScore('咖啡', { summary: '喜欢喝咖啡' }) > 0, true);
  assert.equal(matchScore('咖啡', { title: '完全无关' }), 0);
  // 标题权重 > 摘要
  assert.ok(matchScore('咖啡', { title: '咖啡' }) > matchScore('咖啡', { summary: '咖啡' }));
});
