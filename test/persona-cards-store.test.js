/**
 * persona-cards-store 单测：隔离临时目录 + 假 personaStore。
 * 覆盖：list 空态、create（含从当前人设导入）、update、activate（走 personaStore.write 备份）、
 *       delete（不删当前人设）、importCurrent、detectActive 内容比对、损坏/非法索引回退、
 *       名称/描述/大小限制、原子写 0600，以及真实 persona-store 的集成切换+备份。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPersonaCardsStore } from '../lib/persona-cards-store.js';
import { createPersonaStore } from '../lib/persona-store.js';

const QUIET_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 假 personaStore：内存文本 + 可注入写失败，记录 write 调用 */
function makeFakePersonaStore(initial = '') {
  let text = initial;
  const writes = [];
  let failNext = false;
  return {
    writes,
    get text() { return text; },
    setText(next) { text = typeof next === 'string' ? next : ''; },
    setFailNext(value) { failNext = value === true; },
    read() {
      const exists = text !== '';
      return {
        text,
        path: '/tmp/qqb-cards-persona.md',
        bytes: Buffer.byteLength(text, 'utf8'),
        lines: text === '' ? 0 : text.split('\n').length,
        exists,
        mtime: 0,
      };
    },
    write(next) {
      if (failNext) {
        failNext = false;
        return { ok: false, error: '模拟写失败' };
      }
      if (typeof next !== 'string' || next.trim() === '') {
        return { ok: false, error: '人设不能为空' };
      }
      writes.push(next);
      text = next.endsWith('\n') ? next : next + '\n';
      return { ok: true, backup: 'persona-backup-1.md' };
    },
  };
}

/** 创建隔离 store 与目录 */
function makeStore(t, { persona = '', cwdName = 'ws' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-persona-cards-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, cwdName);
  fs.mkdirSync(cwd, { recursive: true });
  const personaStore = makeFakePersonaStore(persona);
  const store = createPersonaCardsStore({
    settings: { get: () => ({}) },
    personaStore,
    cwd,
    logger: QUIET_LOGGER,
  });
  return { store, personaStore, cwd, cardsDir: path.join(cwd, 'personas'), indexFile: path.join(cwd, 'personas', 'index.json'), base };
}

function readIndex(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('list 空目录：custom=true、cards 为空、目录字段正确', (t) => {
  const { store, cardsDir, indexFile } = makeStore(t);
  const result = store.list();
  assert.equal(result.ok, true);
  assert.equal(result.dir, cardsDir);
  assert.equal(result.indexFile, indexFile);
  assert.equal(result.activeId, null);
  assert.equal(result.active, null);
  assert.equal(result.custom, true);
  assert.equal(result.cardCount, 0);
  assert.deepEqual(result.cards, []);
  assert.equal(result.persona, '/tmp/qqb-cards-persona.md');
  assert.equal(typeof result.personaInfo, 'object');
  assert.equal(result.personaInfo.exists, false);
  assert.equal(result.personaInfo.chars, 0);
  assert.equal(store.dir(), cardsDir);
});

test('create 写卡文件 + index.json，字段/权限/返回结构符合契约', (t) => {
  const { store, cardsDir, indexFile } = makeStore(t);
  const result = store.create({ name: '温柔姐姐', description: '说话温柔', content: '你是温柔的姐姐。' });

  assert.equal(result.ok, true);
  assert.match(result.card.id, UUID_RE);
  assert.equal(result.card.name, '温柔姐姐');
  assert.equal(result.card.description, '说话温柔');
  assert.equal(result.card.file, result.card.id + '.md');
  assert.equal(result.card.chars, '你是温柔的姐姐。'.length);
  assert.equal(result.card.active, false);
  assert.equal(result.card.missing, false);
  assert.equal(result.activeId, null);
  assert.equal(result.custom, true);
  assert.ok(Number.isFinite(Date.parse(result.card.createdAt)));
  assert.equal(result.card.createdAt, result.card.updatedAt);

  const cardFile = path.join(cardsDir, result.card.file);
  assert.equal(fs.readFileSync(cardFile, 'utf8'), '你是温柔的姐姐。');
  assert.equal(fs.statSync(cardFile).mode & 0o777, 0o600);

  const index = readIndex(indexFile);
  assert.deepEqual(Object.keys(index).sort(), ['activeId', 'cards', 'version']);
  assert.equal(index.version, 1);
  assert.equal(index.activeId, null);
  assert.equal(index.cards.length, 1);
  assert.deepEqual(Object.keys(index.cards[0]).sort(), ['createdAt', 'description', 'file', 'id', 'name', 'updatedAt']);
  assert.equal(fs.statSync(indexFile).mode & 0o777, 0o600);

  // 目录里没有原子写残留
  const leftovers = fs.readdirSync(cardsDir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('create 省略 content 时取当前人设，内容一致即自动 active', (t) => {
  const { store, personaStore, indexFile } = makeStore(t, { persona: '你是一只猫娘。\n' });
  const result = store.create({ name: '猫娘' });
  assert.equal(result.ok, true);
  assert.equal(result.card.chars, '你是一只猫娘。\n'.length);
  assert.equal(result.activeId, result.card.id);
  assert.equal(result.custom, false);

  const listed = store.list();
  assert.equal(listed.activeId, result.card.id);
  assert.equal(listed.active, result.card.id);
  assert.equal(listed.custom, false);
  assert.equal(listed.cards[0].active, true);
  assert.equal(readIndex(indexFile).activeId, result.card.id);

  // detectActive 稳定：内容仍一致 → 不重复写盘
  const indexText = fs.readFileSync(indexFile, 'utf8');
  const detected = store.detectActive();
  assert.equal(detected.ok, true);
  assert.equal(detected.activeId, result.card.id);
  assert.equal(detected.changed, false);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), indexText);
  assert.equal(personaStore.writes.length, 0, 'create 不应改写当前人设');
});

test('create 参数校验：名称/描述/内容长度与类型', (t) => {
  const { store } = makeStore(t);
  assert.equal(store.create({}).ok, false);
  assert.match(store.create({}).error, /名称/);
  assert.match(store.create({ name: '   ' }).error, /名称/);
  assert.match(store.create({ name: '名'.repeat(41) }).error, /40/);
  assert.equal(store.create({ name: 'ok', content: '正文', description: '描'.repeat(201) }).ok, false);
  assert.equal(store.create({ name: 'ok', content: '正文', description: '描'.repeat(200) }).ok, true);
  assert.match(store.create({ name: 'ok', content: '' }).error, /不能为空/);
  assert.match(store.create({ name: 'ok', content: '   ' }).error, /不能为空/);
  assert.match(store.create({ name: 'ok', content: 123 }).error, /字符串/);
  const huge = 'a'.repeat(256 * 1024 + 1);
  assert.match(store.create({ name: 'ok', content: huge }).error, /256KB/);
  // 恰好 256KB 允许
  assert.equal(store.create({ name: '边界', content: 'a'.repeat(256 * 1024) }).ok, true);
  // 当前人设为空时不能省略 content
  assert.match(store.create({ name: '无内容' }).error, /当前人设为空/);
});

test('update 改名称/描述/内容，updatedAt 更新且 active 随内容变化', (t) => {
  const { store, personaStore, cardsDir } = makeStore(t);
  const created = store.create({ name: '旧名', description: '旧描述', content: '内容A' });
  const id = created.card.id;

  // 只改元数据
  const metaUpdated = store.update(id, { name: '新名', description: '新描述' });
  assert.equal(metaUpdated.ok, true);
  assert.equal(metaUpdated.card.name, '新名');
  assert.equal(metaUpdated.card.description, '新描述');
  assert.equal(metaUpdated.card.chars, '内容A'.length);
  assert.ok(Date.parse(metaUpdated.card.updatedAt) >= Date.parse(created.card.updatedAt));
  assert.equal(fs.readFileSync(path.join(cardsDir, created.card.file), 'utf8'), '内容A');

  // 内容改成与当前人设一致 → active
  personaStore.setText('内容B');
  const contentUpdated = store.update(id, { content: '内容B' });
  assert.equal(contentUpdated.ok, true);
  assert.equal(contentUpdated.card.chars, 3);
  assert.equal(contentUpdated.activeId, id);
  assert.equal(contentUpdated.custom, false);
  assert.equal(fs.readFileSync(path.join(cardsDir, created.card.file), 'utf8'), '内容B');

  // 此时卡已是激活卡（内容 == 人设），再覆盖它 → 人设同步更新，保持激活不漂移。
  // 这是 v0.11 的语义修正：覆盖「激活卡」必须同步人设，否则内容不一致会导致
  // activeId 漂移/变 custom，用户看到的就是"覆盖没生效"。
  const again = store.update(id, { content: '内容C' });
  assert.equal(again.activeId, id, '覆盖激活卡后仍应保持激活');
  assert.equal(again.custom, false);
  assert.equal(personaStore.read().text.trimEnd(), '内容C', '覆盖激活卡应同步人设');

  // 错误分支
  assert.match(store.update(randomUUID(), { name: 'x' }).error, /不存在/);
  assert.match(store.update(id, {}).error, /没有可更新/);
  assert.match(store.update(id, { name: '' }).error, /名称/);
  assert.match(store.update(id, { content: '' }).error, /不能为空/);
});

test('activate 通过 personaStore.write 写回并带备份；失败不改索引', (t) => {
  const { store, personaStore, indexFile } = makeStore(t, { persona: '旧人设\n' });
  const created = store.create({ name: '卡A', content: '新人设内容' });
  const id = created.card.id;

  const activated = store.activate(id);
  assert.equal(activated.ok, true);
  assert.equal(activated.activeId, id);
  assert.equal(activated.active, true);
  assert.equal(activated.custom, false);
  assert.equal(activated.backup, 'persona-backup-1.md');
  assert.deepEqual(personaStore.writes, ['新人设内容']);
  assert.equal(personaStore.text, '新人设内容\n');
  assert.equal(readIndex(indexFile).activeId, id);
  assert.equal(store.list().cards[0].active, true);

  // 不存在 / 文件缺失
  assert.match(store.activate(randomUUID()).error, /不存在/);
  const created2 = store.create({ name: '卡B', content: '卡B内容' });
  fs.unlinkSync(path.join(store.dir(), created2.card.file));
  assert.match(store.activate(created2.card.id).error, /缺失/);

  // personaStore.write 失败：返回错误且索引不变成该卡
  const created3 = store.create({ name: '卡C', content: '卡C内容' });
  const before = readIndex(indexFile).activeId;
  personaStore.setFailNext(true);
  const failed = store.activate(created3.card.id);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /模拟写失败/);
  assert.equal(readIndex(indexFile).activeId, before);
  assert.equal(store.list().cards.find((card) => card.id === created3.card.id).active, false);
});

test('delete 只删卡文件与索引，绝不删除/修改当前人设', (t) => {
  const { store, personaStore, cardsDir } = makeStore(t, { persona: '当前人设\n' });
  const active = store.importCurrent({ name: '我的卡' });
  assert.equal(active.ok, true);
  const other = store.create({ name: '其它卡', content: '其它内容' });
  const writesBefore = personaStore.writes.length;

  const deletedActive = store.delete(active.card.id);
  assert.equal(deletedActive.ok, true);
  assert.equal(deletedActive.id, active.card.id);
  assert.equal(deletedActive.wasActive, true);
  assert.equal(deletedActive.activeId, null);
  assert.equal(deletedActive.custom, true);
  assert.equal(fs.existsSync(path.join(cardsDir, active.card.file)), false);
  assert.equal(personaStore.text, '当前人设\n', '删除卡不能改动当前人设文件');
  assert.equal(personaStore.writes.length, writesBefore, '删除卡不应调用 personaStore.write');

  const listed = store.list();
  assert.equal(listed.cards.length, 1);
  assert.equal(listed.cards[0].id, other.card.id);
  assert.equal(listed.activeId, null);

  const deletedOther = store.delete(other.card.id);
  assert.equal(deletedOther.ok, true);
  assert.equal(deletedOther.wasActive, false);
  assert.equal(store.list().cards.length, 0);
  assert.match(store.delete(randomUUID()).error, /不存在/);
});

test('delete 非激活卡不影响当前激活卡', (t) => {
  const { store } = makeStore(t, { persona: '人设X\n' });
  const active = store.importCurrent({ name: '激活卡' });
  const other = store.create({ name: '别的卡', content: '别的' });
  const result = store.delete(other.card.id);
  assert.equal(result.ok, true);
  assert.equal(result.activeId, active.card.id);
  assert.equal(store.list().activeId, active.card.id);
});

test('importCurrent 把当前人设存成新卡并自动激活；空人设报错', (t) => {
  const { store, personaStore } = makeStore(t, { persona: '自定义人设内容\n' });
  const result = store.importCurrent({ name: '自定义', description: '从当前人设导入' });
  assert.equal(result.ok, true);
  assert.equal(result.activeId, result.card.id);
  assert.equal(result.active, true);
  assert.equal(result.custom, false);
  assert.equal(result.card.chars, '自定义人设内容\n'.length);
  assert.equal(fs.readFileSync(path.join(store.dir(), result.card.file), 'utf8'), '自定义人设内容\n');
  assert.equal(personaStore.writes.length, 0);
  assert.match(store.importCurrent({ name: '' }).error, /名称/);

  const emptyStore = makeStore(t).store;
  assert.match(emptyStore.importCurrent({ name: '空' }).error, /当前人设为空/);
});

test('detectActive 内容比对；人设被外部改成自定义后变为 custom', (t) => {
  const { store, personaStore, indexFile } = makeStore(t);
  const created = store.create({ name: '卡', content: '卡片内容' });
  assert.equal(store.detectActive().activeId, null);

  personaStore.setText('卡片内容\n');
  const matched = store.detectActive();
  assert.equal(matched.ok, true);
  assert.equal(matched.activeId, created.card.id);
  assert.equal(matched.card.id, created.card.id);
  assert.equal(matched.custom, false);
  assert.equal(matched.changed, true);
  assert.equal(readIndex(indexFile).activeId, created.card.id);

  personaStore.setText('我改成了自定义人设');
  const custom = store.detectActive();
  assert.equal(custom.activeId, null);
  assert.equal(custom.card, null);
  assert.equal(custom.custom, true);
  assert.equal(custom.changed, true);
  assert.equal(readIndex(indexFile).activeId, null);
});

test('多张卡内容相同时，activate 指定哪张就标记哪张 active', (t) => {
  const { store } = makeStore(t, { persona: '相同内容\n' });
  const first = store.create({ name: '第一张', content: '相同内容' });
  const second = store.create({ name: '第二张', content: '相同内容' });
  assert.equal(store.list().activeId, first.card.id, '默认取索引提示/第一张');

  const activated = store.activate(second.card.id);
  assert.equal(activated.ok, true);
  const listed = store.list();
  assert.equal(listed.activeId, second.card.id);
  assert.equal(listed.cards.find((card) => card.id === first.card.id).active, false);
  assert.equal(listed.cards.find((card) => card.id === second.card.id).active, true);
});

test('损坏 index.json 回退空索引并备份 .corrupt-*，之后可继续创建', (t) => {
  const { store, cardsDir, indexFile } = makeStore(t);
  fs.mkdirSync(cardsDir, { recursive: true });
  fs.writeFileSync(indexFile, '{ 这不是 JSON');

  const listed = store.list();
  assert.equal(listed.ok, true);
  assert.equal(listed.cardCount, 0);
  assert.deepEqual(listed.cards, []);
  assert.ok(fs.readdirSync(cardsDir).some((name) => name.startsWith('index.json.corrupt-')));

  const created = store.create({ name: '恢复后', content: '正文' });
  assert.equal(created.ok, true);
  assert.equal(readIndex(indexFile).cards.length, 1);
});

test('非法索引条目（路径穿越/缺字段）被丢弃，缺失卡文件标记 missing', (t) => {
  const { store, cardsDir, indexFile } = makeStore(t);
  fs.mkdirSync(cardsDir, { recursive: true });
  fs.writeFileSync(
    indexFile,
    JSON.stringify({
      version: 1,
      activeId: 'not-exist',
      cards: [
        { id: 'bad1', name: '穿越', file: '../evil.md', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: 'bad2', name: '', file: 'bad2.md' },
        { id: 'good1', name: '正常', file: 'good1.md', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ],
    }),
  );
  const listed = store.list();
  assert.equal(listed.ok, true);
  assert.equal(listed.cards.length, 1, '越界与缺名的条目被丢弃');
  assert.equal(listed.cards[0].id, 'good1');
  assert.equal(listed.cards[0].missing, true, '文件不存在标记 missing');
  assert.equal(listed.activeId, null);
  assert.equal(listed.custom, true);
});

test('索引 activeId 过期时以内容比对为准，detectActive 会修正落盘', (t) => {
  const { store, personaStore, indexFile } = makeStore(t);
  const cardA = store.create({ name: 'A', content: '内容A' });
  const cardB = store.create({ name: 'B', content: '内容B' });
  personaStore.setText('内容B\n');

  // 手工把索引写成过期值 A
  const index = readIndex(indexFile);
  index.activeId = cardA.card.id;
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

  const listed = store.list();
  assert.equal(listed.activeId, cardB.card.id, '内容一致优先于索引声明');
  assert.equal(readIndex(indexFile).activeId, cardA.card.id, 'list 只读不落盘');

  const detected = store.detectActive();
  assert.equal(detected.activeId, cardB.card.id);
  assert.equal(detected.changed, true);
  assert.equal(readIndex(indexFile).activeId, cardB.card.id);
});

test('index.json 无法写入时回滚刚写的卡文件', (t) => {
  const { store, cardsDir, indexFile } = makeStore(t);
  fs.mkdirSync(cardsDir, { recursive: true });
  fs.mkdirSync(indexFile); // 用目录占位，令原子 rename 失败

  const result = store.create({ name: '会失败', content: '正文' });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  const cardFiles = fs.readdirSync(cardsDir).filter((name) => name.endsWith('.md') && !name.startsWith('.'));
  assert.deepEqual(cardFiles, [], '索引写失败后不应留下孤儿卡文件');
});

test('与真实 persona-store 集成：activate 产生备份，delete 保留 persona 文件', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-cards-real-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'ws');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(cwd, { recursive: true });
  const personaPath = path.join(cwd, 'persona.md');
  fs.writeFileSync(personaPath, '旧人设内容\n');

  const settings = { get: () => ({ persona: { path: personaPath } }) };
  const personaStore = createPersonaStore({ settings, stateDir, logger: QUIET_LOGGER });
  const store = createPersonaCardsStore({ settings, personaStore, cwd, logger: QUIET_LOGGER });

  const created = store.create({ name: '新卡', content: '新卡人设\n' });
  assert.equal(created.ok, true);
  const activated = store.activate(created.card.id);
  assert.equal(activated.ok, true);
  assert.equal(fs.readFileSync(personaPath, 'utf8'), '新卡人设\n');
  assert.equal(personaStore.backups().length, 1, 'activate 应通过 personaStore.write 备份旧人设');

  const detected = store.detectActive();
  assert.equal(detected.activeId, created.card.id);

  const deleted = store.delete(created.card.id);
  assert.equal(deleted.ok, true);
  assert.equal(fs.readFileSync(personaPath, 'utf8'), '新卡人设\n', 'delete 不改动 persona 文件');
  assert.equal(store.list().activeId, null);
});

test('logger 可缺省、cwd 可缺省时仍能工作', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-cards-nocwd-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const oldCwd = process.cwd();
  process.chdir(base);
  t.after(() => process.chdir(oldCwd));
  const personaStore = makeFakePersonaStore('人设\n');
  const store = createPersonaCardsStore({ personaStore });
  assert.equal(store.dir(), path.join(base, 'personas'));
  const created = store.create({ name: '默认 cwd', content: '内容' });
  assert.equal(created.ok, true);
});

test('update：覆盖「当前激活卡」时应同步写入人设，保持激活状态不漂移', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const nodeFs = await import('node:fs');
  const { createPersonaCardsStore } = await import('../lib/persona-cards-store.js');
  const { createPersonaStore } = await import('../lib/persona-store.js');

  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-card-'));
  const stateDir = path.join(dir, 'state');
  nodeFs.mkdirSync(stateDir, { recursive: true });
  const settings = { get: () => ({ persona: { path: path.join(dir, 'persona.md') } }) };
  const logger = { warn() {}, info() {}, debug() {} };
  const personaStore = createPersonaStore({ settings, stateDir, logger });
  const cards = createPersonaCardsStore({ personaStore, cwd: dir, logger });

  personaStore.write('原始人设内容\n第二行');
  const created = cards.create({ name: '卡A', content: '原始人设内容\n第二行' });
  assert.ok(created && created.ok !== false, '创建卡应成功');
  const id = created.card.id;
  const activated = cards.activate(id);
  assert.ok(activated && activated.ok === true, '激活应成功');

  // 取人设当前值（含写入补的换行），再覆盖同一张卡
  const current = personaStore.read().text;
  const updated = cards.update(id, { content: current.trimEnd() });
  assert.ok(updated && updated.ok !== false, '覆盖应成功');
  assert.equal(updated.activeId, id, '覆盖后仍应是这张卡处于激活状态');
  assert.equal(updated.card.active, true, '覆盖后卡片应保持 active');
  assert.equal(updated.custom, false, '不应变成自定义状态');
});

test('update：覆盖「非激活卡」只改卡文件，不动人设', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const nodeFs = await import('node:fs');
  const { createPersonaCardsStore } = await import('../lib/persona-cards-store.js');
  const { createPersonaStore } = await import('../lib/persona-store.js');

  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-card2-'));
  const stateDir = path.join(dir, 'state');
  nodeFs.mkdirSync(stateDir, { recursive: true });
  const settings = { get: () => ({ persona: { path: path.join(dir, 'persona.md') } }) };
  const logger = { warn() {}, info() {}, debug() {} };
  const personaStore = createPersonaStore({ settings, stateDir, logger });
  const cards = createPersonaCardsStore({ personaStore, cwd: dir, logger });

  personaStore.write('当前人设');
  const a = cards.create({ name: '卡A', content: '当前人设' });
  const b = cards.create({ name: '卡B', content: '另一份人设' });
  cards.activate(a.card.id);
  const before = personaStore.read().text;

  const updated = cards.update(b.card.id, { content: '另一份人设v2' });
  assert.ok(updated && updated.ok !== false);
  assert.equal(personaStore.read().text, before, '非激活卡覆盖不应改人设');
  assert.equal(updated.activeId, a.card.id, '激活卡仍是 A');
});

test('删除人格卡：先备份到 .trash/，误删可恢复', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const nodeFs = await import('node:fs');
  const { createPersonaCardsStore } = await import('../lib/persona-cards-store.js');
  const { createPersonaStore } = await import('../lib/persona-store.js');

  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-del-'));
  const stateDir = path.join(dir, 'state');
  nodeFs.mkdirSync(stateDir, { recursive: true });
  const settings = { get: () => ({ persona: { path: path.join(dir, 'persona.md') } }) };
  const logger = { warn() {}, info() {}, debug() {} };
  const personaStore = createPersonaStore({ settings, stateDir, logger });
  const cards = createPersonaCardsStore({ personaStore, cwd: dir, logger });

  const created = cards.create({ name: '要删的卡', content: '会被误删的人设内容' });
  assert.ok(created && created.ok !== false);
  const id = created.card.id;

  const deleted = cards.delete(id);
  assert.ok(deleted && deleted.ok === true, '删除应成功');
  assert.ok(typeof deleted.trashPath === 'string' && deleted.trashPath !== '', '应返回备份路径');
  assert.equal(nodeFs.existsSync(deleted.trashPath), true, '备份文件应存在');
  assert.equal(nodeFs.readFileSync(deleted.trashPath, 'utf8'), '会被误删的人设内容', '备份内容应与原卡一致');

  // 正式卡文件已删、索引里也没有
  const list = cards.list();
  assert.equal(list.cards.some((c) => c.id === id), false, '索引里不应再有该卡');
});
