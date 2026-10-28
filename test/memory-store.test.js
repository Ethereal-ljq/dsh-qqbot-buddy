/**
 * memory-store 单测：隔离临时目录，不触碰真实工作区/网络。
 * 覆盖：ensure/layout/hotText/saveFact 去重+日文件+MEMORY 裁剪/search/
 *       readFile-writeFile 越界与大小限制/原子写权限/index。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMemoryStore } from '../lib/memory/store.js';

const QUIET_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

/** 建一个隔离的 memory store；t.after 负责清理临时目录 */
function makeStore(t, overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-memory-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // 根目录刻意用尚不存在的子目录，便于验证 ensure() 的 created 语义
  const dir = path.join(base, 'memory');
  const memory = {
    enabled: true,
    dir,
    injectMaxChars: 4000,
    autoCollect: {
      enabled: true,
      everyRounds: 6,
      maxFacts: 5,
      maxFactChars: 400,
      provider: '',
      model: '',
    },
    ...overrides,
  };
  const settings = { get: () => ({ memory }) };
  return { store: createMemoryStore({ settings, logger: QUIET_LOGGER }), dir, memory };
}

/** 与 store 内部一致的归一化，用于校验 hash */
function sha16(text) {
  const normalized = String(text).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

test('ensure 创建根目录与 notes；layout 反映文件', (t) => {
  const { store, dir } = makeStore(t);
  assert.equal(store.root(), path.resolve(dir));
  assert.equal(fs.existsSync(dir), false);

  const first = store.ensure();
  assert.deepEqual(first, { ok: true, created: true });
  assert.equal(fs.existsSync(path.join(dir, 'notes')), true);

  const second = store.ensure();
  assert.deepEqual(second, { ok: true, created: false });

  const empty = store.layout();
  assert.equal(empty.dir, path.resolve(dir));
  assert.equal(empty.exists, true);
  assert.deepEqual(empty.files, []);
  assert.equal(empty.totalChars, 0);

  store.saveFact({ text: '用户喜欢喝美式咖啡', tags: ['偏好'] });
  const layout = store.layout();
  assert.equal(layout.exists, true);
  const names = layout.files.map((f) => f.name);
  assert.ok(names.includes('MEMORY.md'));
  assert.ok(names.some((n) => /^notes\/\d{4}-\d{2}-\d{2}\.md$/.test(n)));
  assert.ok(names.every((n) => n.endsWith('.md')), 'index.json 等内部文件不展示');
  assert.ok(!names.includes('index.json'));
  assert.equal(layout.totalChars, store.readFile('MEMORY.md').text.length + store.readFile(names.find((n) => n.startsWith('notes/'))).text.length);
  for (const file of layout.files) {
    assert.equal(typeof file.size, 'number');
    assert.equal(typeof file.mtime, 'number');
  }
});

test('saveFact 写 MEMORY.md 与当日 notes，index hash 正确', (t) => {
  const { store, dir } = makeStore(t);
  const text = '用户称呼我小明，喜欢喝美式咖啡';
  const result = store.saveFact({ text, tags: ['称呼', '#偏好'], importance: 'high', source: 'tool' });

  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.match(result.file, /^notes\/\d{4}-\d{2}-\d{2}\.md$/);
  assert.equal(result.path, path.join(dir, ...result.file.split('/')));

  const memoryText = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  assert.match(memoryText, /^- \[\d{4}-\d{2}-\d{2}\] 用户称呼我小明，喜欢喝美式咖啡（#称呼 #偏好）$/m);
  assert.equal(result.entry, memoryText.trim());

  const daily = fs.readFileSync(result.path, 'utf8');
  assert.match(daily, /^# 记忆记录 \d{4}-\d{2}-\d{2}/);
  assert.match(daily, /- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[tool\] \[重要\] 用户称呼我小明，喜欢喝美式咖啡（#称呼 #偏好）/);

  const index = store.index();
  assert.equal(index.version, 1);
  assert.equal(index.facts.length, 1);
  const fact = index.facts[0];
  assert.deepEqual(Object.keys(fact).sort(), ['at', 'file', 'hash', 'tags', 'text']);
  assert.equal(fact.hash, sha16(text));
  assert.equal(fact.hash.length, 16);
  assert.deepEqual(fact.tags, ['称呼', '偏好']);
  assert.equal(fact.text, text);
  assert.equal(fact.file, result.file);
  assert.ok(Number.isFinite(Date.parse(fact.at)));

  // 文件权限 0600
  assert.equal(fs.statSync(path.join(dir, 'MEMORY.md')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'index.json')).mode & 0o777, 0o600);
});

test('重复事实返回 duplicate 且不重复写文件', (t) => {
  const { store, dir } = makeStore(t);
  const first = store.saveFact({ text: '用户喜欢喝咖啡', tags: ['偏好'] });
  const second = store.saveFact({ text: '\n 用户喜欢喝咖啡 \n', tags: ['偏好'] });
  const third = store.saveFact({ text: '用户喜欢喝咖啡' });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);
  assert.equal(second.ok, true);
  assert.equal(second.path, first.path);

  const memoryLines = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim().split('\n');
  assert.equal(memoryLines.length, 1);
  const notesFile = path.join(dir, ...first.file.split('/'));
  const daily = fs.readFileSync(notesFile, 'utf8');
  assert.equal(daily.split('\n').filter((l) => l.startsWith('- [')).length, 1);
  assert.equal(store.index().facts.length, 1);
});

test('大小写不同的英文事实视为重复（归一化去重）', (t) => {
  const { store } = makeStore(t);
  assert.equal(store.saveFact({ text: 'My favorite color is Blue' }).duplicate, false);
  assert.equal(store.saveFact({ text: 'my favorite color is blue' }).duplicate, true);
});

test('MEMORY.md 超过 800 条从最旧裁剪，index 保留', (t) => {
  const { store, dir } = makeStore(t);
  const lines = [];
  for (let i = 0; i < 810; i += 1) lines.push(`- [2026-01-01] 旧条目 ${i}`);
  store.writeFile('MEMORY.md', lines.join('\n') + '\n');

  const saved = store.saveFact({ text: '最新的一条事实' });
  assert.equal(saved.duplicate, false);

  const memoryText = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  const entries = memoryText.trim().split('\n');
  assert.equal(entries.length, 800);
  assert.ok(entries.at(-1).includes('最新的一条事实'));
  assert.ok(!memoryText.includes('旧条目 0'));
  assert.ok(memoryText.includes('旧条目 10'));
  // 裁剪只影响 MEMORY.md，index 仍保留（用于后续去重）
  assert.equal(store.index().facts.length, 1);
});

test('hotText 取尾部且按行回退，不截半个字符', (t) => {
  const { store } = makeStore(t);
  assert.equal(store.hotText(100), '');

  const lines = [];
  for (let i = 0; i < 5; i += 1) lines.push(`- [2026-10-2${i}] 第 ${i} 条记忆内容`);
  const content = lines.join('\n') + '\n';
  store.writeFile('MEMORY.md', content);

  const hot = store.hotText(45);
  assert.ok(hot.length <= 45);
  assert.ok(content.trimEnd().endsWith(hot));
  assert.ok(hot.startsWith('- ['), '必须按整行回退');
  assert.equal(store.hotText(10_000), content.trimEnd());
  assert.equal(store.hotText(0), '');
  assert.equal(store.hotText(-5), '');

  // 单行超长（emoji 代理对）→ 按字符尾部回退，不能切出半个 emoji
  store.writeFile('MEMORY.md', '😀'.repeat(100));
  const tail = store.hotText(10);
  assert.equal(tail, '😀'.repeat(5));
  assert.ok(!/^[\uDC00-\uDFFF]/.test(tail));
  assert.ok(!/[\uD800-\uDBFF]$/.test(tail));
});

test('search 大小写不敏感、限制 1..20、返回 file/line/text', (t) => {
  const { store, dir } = makeStore(t);
  store.saveFact({ text: '用户喜欢喝美式咖啡', tags: ['偏好'] });
  store.writeFile(
    'notes/2020-01-02.md',
    ['# 记忆记录 2020-01-02', '- [2020-01-02 10:00:00] [tool] Coffee 要加冰', '- [2020-01-02 10:00:01] [tool] 咖啡不要糖'].join('\n'),
  );

  const hits = store.search('咖啡');
  assert.ok(hits.length >= 2);
  for (const hit of hits) {
    assert.equal(typeof hit.file, 'string');
    assert.ok(Number.isInteger(hit.line) && hit.line >= 1);
    assert.equal(typeof hit.text, 'string');
  }
  assert.equal(hits[0].file, 'MEMORY.md');

  const english = store.search('COFFEE');
  assert.equal(english.length, 1);
  assert.equal(english[0].file, 'notes/2020-01-02.md');
  assert.equal(english[0].line, 2);

  assert.equal(store.search('咖啡', 1).length, 1);
  assert.equal(store.search('咖啡', 999).length <= 20, true);
  assert.deepEqual(store.search(''), []);
  assert.deepEqual(store.search('不存在的词'), []);

  // 超过 1MB 的 .md 只检索前 1MB，不能整读进内存
  const big = path.join(dir, 'notes', 'big.md');
  fs.writeFileSync(big, 'needle-head\n' + 'x'.repeat(1024 * 1024) + '\nneedle-beyond-limit\n');
  const bigHits = store.search('needle');
  assert.equal(bigHits.length, 1);
  assert.equal(bigHits[0].text, 'needle-head');
  assert.deepEqual(store.search('needle-beyond-limit'), []);
});

test('readFile/writeFile 拒绝越界、绝对路径与非 .md', (t) => {
  const { store, dir } = makeStore(t);
  store.ensure();

  assert.throws(() => store.readFile('../secret.md'), /越界/);
  assert.throws(() => store.readFile('/etc/passwd.md'), /绝对路径/);
  assert.throws(() => store.readFile('notes/../MEMORY.md'), /越界/);
  assert.throws(() => store.readFile('..\\secret.md'), /越界/);
  assert.throws(() => store.readFile('a.txt'), /只允许/);
  assert.throws(() => store.readFile('index.json'), /只允许/);
  assert.throws(() => store.readFile('notes/missing.md'), /不存在/);
  assert.throws(() => store.readFile(''), /不能为空/);

  assert.throws(() => store.writeFile('../outside.md', 'x'), /越界/);
  assert.throws(() => store.writeFile('/tmp/outside.md', 'x'), /绝对路径/);
  assert.throws(() => store.writeFile('outside.txt', 'x'), /只允许/);
  assert.equal(fs.existsSync(path.join(dir, '..', 'outside.md')), false);

  const written = store.writeFile('notes/2026-01-01.md', '# 标题\n内容');
  assert.equal(written.ok, true);
  assert.equal(written.path, path.join(dir, 'notes', '2026-01-01.md'));
  assert.deepEqual(store.readFile('notes/2026-01-01.md'), { path: written.path, text: '# 标题\n内容' });
});

test('读写大小限制', (t) => {
  const { store, dir } = makeStore(t);
  store.ensure();

  // 写入 <=256KB；恰好在边界允许，超出拒绝
  assert.equal(store.writeFile('edge.md', 'a'.repeat(256 * 1024)).ok, true);
  assert.throws(() => store.writeFile('big.md', 'a'.repeat(256 * 1024 + 1)), /超过/);
  assert.throws(() => store.writeFile('number.md', 123), /字符串/);

  // 读取 <=1MB
  const huge = path.join(dir, 'huge.md');
  fs.writeFileSync(huge, 'a'.repeat(1024 * 1024 + 1));
  assert.throws(() => store.readFile('huge.md'), /超过/);
  assert.equal(store.readFile('edge.md').text.length, 256 * 1024);
});

test('原子写：无 .tmp 残留，覆盖后内容正确', (t) => {
  const { store, dir } = makeStore(t);
  store.writeFile('notes/2026-02-03.md', '第一版');
  store.writeFile('notes/2026-02-03.md', '第二版');
  assert.equal(store.readFile('notes/2026-02-03.md').text, '第二版');

  const leftovers = [];
  const walk = (base) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.includes('.tmp-')) leftovers.push(full);
    }
  };
  walk(dir);
  assert.deepEqual(leftovers, []);
});

test('appendDaily 建当日文件、带时间与来源', (t) => {
  const { store, dir } = makeStore(t);
  const result = store.appendDaily('今天聊了电影', { source: 'manual', tags: ['电影'] });
  assert.match(result.file, /^notes\/\d{4}-\d{2}-\d{2}\.md$/);
  const text = fs.readFileSync(path.join(dir, ...result.file.split('/')), 'utf8');
  assert.match(text, /^# 记忆记录 \d{4}-\d{2}-\d{2}/);
  assert.match(text, /- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[manual\] 今天聊了电影（#电影）/);
  assert.throws(() => store.appendDaily('   '), /不能为空/);
});

test('index.json 损坏时回退空索引并可继续保存', (t) => {
  const { store, dir } = makeStore(t);
  store.ensure();
  fs.writeFileSync(path.join(dir, 'index.json'), '{ 这不是 JSON');

  assert.deepEqual(store.index(), { version: 1, facts: [] });
  const saved = store.saveFact({ text: '恢复后的第一条记忆' });
  assert.equal(saved.ok, true);
  assert.equal(store.index().facts.length, 1);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('index.json.corrupt-')));
});

test('没有配置 dir 时回退到 cwd/memory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-memory-cwd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldCwd = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(oldCwd));
  const store = createMemoryStore({ settings: { get: () => ({ memory: {} }) }, logger: QUIET_LOGGER });
  assert.equal(store.root(), path.join(dir, 'memory'));
});
