/**
 * memory-recall 单测：记忆系统 v2（相关性召回 / 重要度 / 时间衰减 / index v2 迁移 / stats）。
 * 全部隔离临时目录，不触碰真实工作区/网络；时间基准用 recall 的 now 选项固定，避免时钟抖动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMemoryStore, tokenizeQuery } from '../lib/memory/store.js';

const QUIET_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const DAY_MS = 86400000;

/** 与 store 内部一致的归一化 hash（直接构造 index.json 时用） */
function sha16(text) {
  const normalized = String(text).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/** 构造一条 index v2 记录（默认 1 秒前、normal 重要度） */
function mkFact(overrides) {
  const text = overrides.text;
  return {
    hash: sha16(text),
    text,
    tags: [],
    at: new Date(Date.now() - 1000).toISOString(),
    file: 'notes/2026-01-01.md',
    importance: 'normal',
    hits: 0,
    lastHitAt: '',
    ...overrides,
  };
}

/** 隔离的 memory store；t.after 负责清理临时目录 */
function makeStore(t, memoryOverrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-memory-recall-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  const memory = {
    enabled: true,
    dir,
    injectMaxChars: 4000,
    recall: {
      enabled: true,
      maxItems: 6,
      maxChars: 1200,
      recencyHalfLifeDays: 30,
      importanceWeight: 2,
      minScore: 0.15,
    },
    ...memoryOverrides,
  };
  const store = createMemoryStore({ settings: { get: () => ({ memory }) }, logger: QUIET_LOGGER });
  return { store, dir, memory };
}

/** 直接写一份 index.json（便于精确构造时间/重要度，不依赖 saveFact 的当前时间） */
function writeIndex(dir, version, facts) {
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version, facts }, null, 2) + '\n');
}

function readRawIndex(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
}

// ── 分词 ─────────────────────────────────────────────────────
test('tokenizeQuery：英文按非字母数字切分、中文按 2-gram 滑动、去重', () => {
  assert.deepEqual(tokenizeQuery('Hello, World! 咖啡好喝'), ['hello', 'world', '咖啡', '啡好', '好喝']);
  assert.deepEqual(tokenizeQuery('GPT-4 模型'), ['gpt', '4', '模型']);
  assert.deepEqual(tokenizeQuery('咖啡'), ['咖啡']);
  assert.deepEqual(tokenizeQuery('   '), []);
  assert.deepEqual(tokenizeQuery(''), []);
  assert.deepEqual(tokenizeQuery(123), []);
  assert.deepEqual(tokenizeQuery('a'), ['a'], '单字母退化为整段匹配，不会丢 query');
  assert.deepEqual(tokenizeQuery('咖啡 咖啡'), ['咖啡'], '词元去重');
});

// ── 打分与排序 ───────────────────────────────────────────────
test('recall：词面命中越多分越高，不相关条目不返回', (t) => {
  const { store, dir } = makeStore(t);
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const at = new Date(now - DAY_MS).toISOString();
  writeIndex(dir, 2, [
    mkFact({ text: '用户喜欢喝美式咖啡', at }),
    mkFact({ text: '用户喜欢喝咖啡', at }),
    mkFact({ text: '阳台上的绿萝开花了', at }),
  ]);

  const hits = store.recall('用户喜欢喝美式咖啡', { now });
  assert.deepEqual(hits.map((hit) => hit.text), ['用户喜欢喝美式咖啡', '用户喜欢喝咖啡']);
  assert.ok(hits[0].score > hits[1].score, '命中词元越多分越高');
  assert.deepEqual(Object.keys(hits[0]).sort(), ['at', 'importance', 'score', 'tags', 'text']);
  assert.equal(hits[0].importance, 'normal');
  assert.equal(hits[0].at, at);
  assert.ok(hits[0].score > 0 && hits[0].score <= 1.5);

  // minScore 可调：只共享一个泛词（用户）的弱相关条目提高门槛后会被过滤
  const strict = makeStore(t, {
    recall: {
      enabled: true,
      maxItems: 6,
      maxChars: 1200,
      recencyHalfLifeDays: 30,
      importanceWeight: 2,
      minScore: 0.35,
    },
  });
  writeIndex(strict.dir, 2, [
    mkFact({ text: '用户喜欢喝美式咖啡', at }),
    mkFact({ text: '用户喜欢喝咖啡', at }),
    mkFact({ text: '用户养了一只猫', at }),
  ]);
  const strictHits = strict.store.recall('用户喜欢喝美式咖啡', { now });
  assert.deepEqual(strictHits.map((hit) => hit.text), ['用户喜欢喝美式咖啡', '用户喜欢喝咖啡']);
});

test('recall：英文按词边界匹配，不误命中子串', (t) => {
  const { store, dir } = makeStore(t);
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const at = new Date(now - DAY_MS).toISOString();
  writeIndex(dir, 2, [
    mkFact({ text: 'Coffee 要加冰', at }),
    mkFact({ text: 'concatenate 是拼接的意思', at }),
  ]);

  const hits = store.recall('coffee', { now });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, 'Coffee 要加冰');

  // concatenate 里虽然有 cat 子串，但不是独立单词，不能命中
  assert.deepEqual(store.recall('cat', { now }), []);
});

test('recall：tag 精确命中提升排序，调用方显式 tags 也算相关', (t) => {
  const { store, dir } = makeStore(t);
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const at = new Date(now - DAY_MS).toISOString();
  writeIndex(dir, 2, [
    mkFact({ text: '喜欢喝拿铁', tags: ['咖啡'], at }),
    mkFact({ text: '喜欢喝拿铁', tags: ['饮品'], at }),
  ]);

  const hits = store.recall('咖啡', { now });
  assert.equal(hits.length, 1, '只有 tag 精确命中/词面命中的条目才相关');
  assert.deepEqual(hits[0].tags, ['咖啡']);
  assert.ok(hits[0].score > 0.2);

  // 显式 tags：命中即视为相关并加权（+0.15），未命中的仍被过滤
  const byTag = store.recall('咖啡', { now, tags: ['饮品'] });
  assert.equal(byTag.length, 2);
  const boosted = byTag.find((hit) => hit.tags[0] === '饮品');
  assert.ok(boosted, '显式 tag 命中后可被召回');
  assert.ok(boosted.score > 0.15);
});

test('recall：时间衰减——旧记忆得分更低，半衰期设置生效', (t) => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const recent = new Date(now - DAY_MS).toISOString();
  const old = new Date(now - 300 * DAY_MS).toISOString();

  const { store, dir } = makeStore(t);
  writeIndex(dir, 2, [
    mkFact({ text: '用户喜欢喝美式咖啡', at: old }),
    mkFact({ text: '用户喜欢喝美式咖啡', at: recent }),
  ]);
  const hits = store.recall('用户喜欢喝美式咖啡', { now });
  assert.equal(hits[0].at, recent, '新记忆排前');
  assert.ok(hits[0].score > hits[1].score);

  // 半衰期 0.5 天：300 天前的记忆几乎完全衰减
  const shortHalf = makeStore(t, {
    recall: {
      enabled: true,
      maxItems: 6,
      maxChars: 1200,
      recencyHalfLifeDays: 0.5,
      importanceWeight: 2,
      minScore: 0.15,
    },
  });
  writeIndex(shortHalf.dir, 2, [mkFact({ text: '用户喜欢喝美式咖啡', at: old })]);
  const [oldHit] = shortHalf.store.recall('用户喜欢喝美式咖啡', { now });
  assert.equal(oldHit.score, 0.7, '词面满分 0.7 + 衰减到 0 的新近度');

  // 半衰期 0 = 忽略时间：新旧同分，按时间新优先
  const noDecay = makeStore(t, {
    recall: {
      enabled: true,
      maxItems: 6,
      maxChars: 1200,
      recencyHalfLifeDays: 0,
      importanceWeight: 2,
      minScore: 0.15,
    },
  });
  writeIndex(noDecay.dir, 2, [
    mkFact({ text: '用户喜欢喝美式咖啡', at: old }),
    mkFact({ text: '用户喜欢喝美式咖啡', at: recent }),
  ]);
  const flat = noDecay.store.recall('用户喜欢喝美式咖啡', { now });
  assert.equal(flat[0].score, flat[1].score);
  assert.equal(flat[0].at, recent);
});

test('recall：得分可解释——半衰期 30 天整时 0.75，high 再加 0.2', (t) => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const at30 = new Date(now - 30 * DAY_MS).toISOString();
  const { store, dir } = makeStore(t);
  writeIndex(dir, 2, [
    mkFact({ text: '用户喜欢喝美式咖啡', at: at30 }),
    mkFact({ text: '用户喜欢喝美式咖啡', at: at30, importance: 'high' }),
  ]);
  const hits = store.recall('用户喜欢喝美式咖啡', { now });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].importance, 'high');
  // 0.7*词面(1) + 0.2*tag(0) + 0.2*重要度(1) + 0.1*新近度(0.5)
  assert.equal(hits[0].score, 0.95);
  // normal 条目：0.7 + 0.1*0.5
  assert.equal(hits[1].score, 0.75);

  // importanceWeight=0 时重要度不参与打分
  const zeroWeight = makeStore(t, {
    recall: {
      enabled: true,
      maxItems: 6,
      maxChars: 1200,
      recencyHalfLifeDays: 30,
      importanceWeight: 0,
      minScore: 0.15,
    },
  });
  writeIndex(zeroWeight.dir, 2, [
    mkFact({ text: '用户喜欢喝美式咖啡', at: at30 }),
    mkFact({ text: '用户喜欢喝美式咖啡', at: at30, importance: 'high' }),
  ]);
  const flat = zeroWeight.store.recall('用户喜欢喝美式咖啡', { now });
  assert.deepEqual(flat.map((hit) => hit.score), [0.75, 0.75]);
});

test('recall：importance 加权、minImportance 过滤、无 query 时重要/新近优先', (t) => {
  const { store, dir } = makeStore(t);
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  writeIndex(dir, 2, [
    mkFact({ text: '项目代号是蓝鲸', at: new Date(now - 200 * DAY_MS).toISOString(), importance: 'high' }),
    mkFact({ text: '用户喜欢喝美式咖啡', at: new Date(now - DAY_MS).toISOString() }),
    mkFact({ text: '用户养了一只猫', at: new Date(now - 300 * DAY_MS).toISOString() }),
  ]);

  const hits = store.recall('项目代号是蓝鲸', { now });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].importance, 'high');

  assert.deepEqual(store.recall('用户喜欢喝美式咖啡', { now, minImportance: 'high' }), []);
  assert.equal(store.recall('项目代号是蓝鲸', { now, minImportance: 'high' }).length, 1);

  // 无 query：0.5*重要度 + 0.5*新近度
  const all = store.recall('', { now });
  assert.deepEqual(all.map((hit) => hit.text), ['项目代号是蓝鲸', '用户喜欢喝美式咖啡', '用户养了一只猫']);

  // 非字符串 query 等价于无 query，不抛错
  assert.equal(store.recall(undefined, { now }).length, 3);
});

// ── limit / maxChars / 开关 ──────────────────────────────────
test('recall：limit、maxChars、默认 maxItems 与开关生效', (t) => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const at = new Date(now - DAY_MS).toISOString();
  const facts = [];
  for (let i = 0; i < 5; i += 1) facts.push(mkFact({ text: '用户喜欢喝美式咖啡' + i, at }));

  const { store, dir } = makeStore(t);
  writeIndex(dir, 2, facts);
  assert.equal(store.recall('用户喜欢喝美式咖啡', { now, limit: 2 }).length, 2);
  assert.equal(store.recall('用户喜欢喝美式咖啡', { now }).length, 5);

  // maxChars 软上限：每条 10 字，上限 25 只能放 2 条
  const tight = makeStore(t, {
    recall: {
      enabled: true,
      maxItems: 6,
      maxChars: 25,
      recencyHalfLifeDays: 30,
      importanceWeight: 2,
      minScore: 0.15,
    },
  });
  writeIndex(tight.dir, 2, facts);
  assert.equal(tight.store.recall('用户喜欢喝美式咖啡', { now, limit: 5 }).length, 2);

  // 默认 maxItems=6
  const many = makeStore(t);
  const manyFacts = [];
  for (let i = 0; i < 8; i += 1) manyFacts.push(mkFact({ text: '记忆条目编号' + i, at }));
  writeIndex(many.dir, 2, manyFacts);
  assert.equal(many.store.recall('').length, 6);

  // 开关关闭：直接返回空数组
  const off = makeStore(t, { recall: { enabled: false } });
  writeIndex(off.dir, 2, facts);
  assert.deepEqual(off.store.recall('用户喜欢喝美式咖啡', { now }), []);
  assert.deepEqual(off.store.recall(''), []);
});

// ── 索引迁移与损坏恢复 ───────────────────────────────────────
test('v1 index.json 自动迁移为 v2：recall 可用，下次保存落盘 v2', (t) => {
  const { store, dir } = makeStore(t);
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  writeIndex(dir, 1, [{
    hash: sha16('用户喜欢喝咖啡'),
    text: '用户喜欢喝咖啡',
    tags: ['偏好'],
    at: new Date(now - DAY_MS).toISOString(),
    file: 'notes/2026-09-30.md',
  }]);

  const idx = store.index();
  assert.equal(idx.version, 2);
  assert.deepEqual(Object.keys(idx.facts[0]).sort(), [
    'at', 'file', 'hash', 'hits', 'importance', 'lastHitAt', 'tags', 'text',
  ]);
  assert.equal(idx.facts[0].importance, 'normal');
  assert.equal(idx.facts[0].hits, 0);
  assert.equal(idx.facts[0].lastHitAt, '');

  // 读取保持只读：v1 文件在下次写入前不被改写
  assert.equal(readRawIndex(dir).version, 1);
  const hits = store.recall('咖啡', { now });
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].tags, ['偏好']);

  store.saveFact({ text: '用户住在杭州' });
  const raw = readRawIndex(dir);
  assert.equal(raw.version, 2, '保存后落盘为 v2');
  assert.equal(raw.facts.length, 2);
  for (const fact of raw.facts) {
    assert.equal(fact.importance, 'normal');
    assert.equal(fact.hits, 0);
    assert.equal(fact.lastHitAt, '');
  }
});

test('index.json 损坏时备份 .corrupt-<ts> 并重建为 v2', (t) => {
  const { store, dir } = makeStore(t);
  fs.writeFileSync(path.join(dir, 'index.json'), '{ 这不是 JSON');

  assert.deepEqual(store.index(), { version: 2, facts: [] });
  assert.deepEqual(store.recall('任意'), []);
  assert.equal(store.stats().facts, 0);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('index.json.corrupt-')));

  store.saveFact({ text: '恢复后的第一条记忆' });
  assert.equal(readRawIndex(dir).version, 2);
  assert.equal(store.index().facts.length, 1);
});

// ── 设置容错与旧 workspace 兼容 ─────────────────────────────
test('设置缺失/异常时 recall 与 stats 用内置默认，不抛错', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-memory-recall-settings-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cases = [
    { label: 'settings 为空', settings: { get: () => ({}) } },
    { label: 'memory 为空', settings: { get: () => ({ memory: {} }) } },
    { label: 'memory.recall 类型错误', settings: { get: () => ({ memory: { recall: 'bad' } }) } },
    { label: 'settings.get 抛错', settings: { get: () => { throw new Error('boom'); } } },
    { label: '没有 settings', settings: undefined },
  ];
  for (const item of cases) {
    const store = createMemoryStore({ settings: item.settings, logger: QUIET_LOGGER });
    assert.deepEqual(store.recall('任意', { limit: 3 }), [], item.label);
    const stats = store.stats();
    assert.deepEqual(Object.keys(stats).sort(), [
      'byImportance', 'chars', 'facts', 'hotEntries', 'lastSavedAt',
    ], item.label);
    assert.deepEqual(stats.byImportance, { high: 0, normal: 0 }, item.label);
    assert.equal(stats.facts, 0, item.label);
    assert.equal(stats.lastSavedAt, '', item.label);
  }

  // 部分 recall 配置：其余字段回默认
  const partial = makeStore(t, { recall: { maxItems: 2 } });
  const facts = [];
  for (let i = 0; i < 4; i += 1) facts.push(mkFact({ text: '记忆条目' + i }));
  writeIndex(partial.dir, 2, facts);
  assert.equal(partial.store.recall('').length, 2);

  // recall 字段整体缺失：默认 maxItems=6
  const missing = makeStore(t, { recall: undefined });
  writeIndex(missing.dir, 2, facts);
  assert.equal(missing.store.recall('').length, 4);
});

test('没有 index.json 时 recall 从 MEMORY.md 兜底（旧 workspace 兼容）', (t) => {
  const { store } = makeStore(t);
  store.writeFile('MEMORY.md', [
    '- [2026-09-01] 用户喜欢喝美式咖啡（#偏好）',
    '- [2026-09-02] 用户养了一只猫',
  ].join('\n') + '\n');

  const hits = store.recall('咖啡');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, '用户喜欢喝美式咖啡');
  assert.deepEqual(hits[0].tags, ['偏好']);

  // 兜底只读：不创建/改写 index.json
  assert.equal(store.index().facts.length, 0);
  assert.equal(store.stats().facts, 0);
  assert.equal(store.stats().hotEntries, 2);
});

// ── stats / 命中计数 / 只读 / 路径安全 ───────────────────────
test('stats 汇总索引与热记忆', (t) => {
  const { store } = makeStore(t);
  store.saveFact({ text: '用户叫小明', importance: 'high', tags: ['称呼'] });
  store.saveFact({ text: '用户喜欢喝美式咖啡' });

  const stats = store.stats();
  assert.equal(stats.facts, 2);
  assert.equal(stats.hotEntries, 2);
  assert.ok(stats.chars > 0);
  assert.deepEqual(stats.byImportance, { high: 1, normal: 1 });
  assert.ok(Number.isFinite(Date.parse(stats.lastSavedAt)));
});

test('重复命中累加 hits/lastHitAt、升级重要度并合并 tag', (t) => {
  const { store } = makeStore(t);
  const first = store.saveFact({ text: '用户喜欢喝咖啡' });
  assert.equal(first.duplicate, false);
  assert.equal(first.hits, 0);

  const second = store.saveFact({ text: '用户喜欢喝咖啡', importance: 'high', tags: ['偏好'] });
  assert.equal(second.duplicate, true);
  assert.equal(second.hits, 1);
  assert.equal(second.importance, 'high');

  const fact = store.index().facts[0];
  assert.equal(fact.hits, 1);
  assert.equal(fact.importance, 'high');
  assert.deepEqual(fact.tags, ['偏好']);
  assert.ok(Number.isFinite(Date.parse(fact.lastHitAt)));
});

test('recall/stats 纯同步只读：不创建文件、不改写 index.json', (t) => {
  const { store, dir } = makeStore(t);
  store.saveFact({ text: '用户喜欢喝美式咖啡' });
  const indexFile = path.join(dir, 'index.json');
  const before = fs.readdirSync(dir, { recursive: true }).sort();
  const indexBefore = fs.readFileSync(indexFile, 'utf8');
  const mtimeBefore = fs.statSync(indexFile).mtimeMs;

  store.recall('咖啡');
  store.recall('');
  store.recall('咖啡', { tags: ['偏好'] });
  store.stats();

  assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), indexBefore);
  assert.equal(fs.statSync(indexFile).mtimeMs, mtimeBefore);
});

test('readFile/writeFile 继续拒绝越界、绝对路径与非 .md', (t) => {
  const { store } = makeStore(t);
  store.ensure();
  assert.throws(() => store.readFile('../secret.md'), /越界/);
  assert.throws(() => store.readFile('/etc/passwd.md'), /绝对路径/);
  assert.throws(() => store.readFile('notes/../../x.md'), /越界/);
  assert.throws(() => store.readFile('a.txt'), /只允许/);
  assert.throws(() => store.writeFile('../x.md', 'x'), /越界/);
  assert.throws(() => store.writeFile('/tmp/x.md', 'x'), /绝对路径/);
});
