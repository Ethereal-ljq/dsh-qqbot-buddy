/**
 * settings-store 单测（DESIGN 质量项 2）：
 * 深合并、越界截断、未知字段丢弃、原子落盘、订阅触发、坏 JSON 回退默认。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSettingsStore, resolveDefaults } from '../lib/settings-store.js';
import { createFakeLogger } from './helpers/fake-ctx.js';

/** 建临时目录并在测试结束后删除。 */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 构造被测 store；默认文件放在临时目录。 */
function makeStore(t, { file, cwd } = {}) {
  const dir = tempDir(t);
  const resolvedFile = file ?? path.join(dir, 'settings.json');
  const defaults = resolveDefaults({ cwd: cwd ?? path.join(dir, 'cwd') });
  const logger = createFakeLogger();
  const store = createSettingsStore({ file: resolvedFile, defaults, logger });
  return { dir, file: resolvedFile, defaults, logger, store };
}

test('resolveDefaults：生成绝对路径且 get() 与默认值一致', (t) => {
  const { store, defaults } = makeStore(t);
  assert.equal(defaults.version, 1);
  assert.ok(path.isAbsolute(defaults.persona.path), 'persona.path 必须是绝对路径');
  assert.ok(path.isAbsolute(defaults.memory.dir), 'memory.dir 必须是绝对路径');
  assert.ok(defaults.persona.path.endsWith('persona.md'));
  assert.ok(defaults.memory.dir.endsWith('memory'));
  // 文件不存在时 get() 直接返回默认值（内存态），不产生文件。
  assert.deepEqual(store.get(), defaults);
  assert.ok(path.isAbsolute(store.file), 'store.file 必须是绝对路径');
});

test('get() 返回深拷贝：改快照不会影响内部状态', (t) => {
  const { store } = makeStore(t);
  const snapshot = store.get();
  snapshot.reply.countThreshold = 99;
  snapshot.triggers.keywords.push('篡改');
  snapshot.memory.autoCollect.everyRounds = 1;
  assert.equal(store.get().reply.countThreshold, 3);
  assert.deepEqual(store.get().triggers.keywords, []);
  assert.equal(store.get().memory.autoCollect.everyRounds, 6);
});

test('defaults 快照不可变：改 store.defaults 不影响后续校验', (t) => {
  const { store } = makeStore(t);
  const defaults = store.defaults;
  defaults.reply.countThreshold = 123;
  assert.equal(store.defaults.reply.countThreshold, 3);
});

test('patch 深合并：只改指定叶子字段，同级字段保留', async (t) => {
  const { store } = makeStore(t);
  const { settings, changed } = await store.patch({ reply: { countThreshold: 8 } });
  assert.equal(settings.reply.countThreshold, 8);
  assert.equal(settings.reply.groupMode, 'count');
  assert.equal(settings.reply.flushAfterSeconds, 120);
  assert.equal(settings.triggers.onMention, true);
  assert.equal(settings.memory.autoCollect.everyRounds, 6);
  assert.deepEqual(changed, ['reply.countThreshold']);

  // 再补一次嵌套 memory 字段，reply 的修改必须保留。
  const second = await store.patch({ memory: { autoCollect: { maxFacts: 9 } } });
  assert.equal(second.settings.reply.countThreshold, 8);
  assert.equal(second.settings.memory.autoCollect.maxFacts, 9);
  assert.deepEqual(second.changed, ['memory.autoCollect.maxFacts']);
});

test('越界值截断到边界（数值/概率/秒数/记忆上限）', async (t) => {
  const { store } = makeStore(t);
  const { settings } = await store.patch({
    reply: {
      countThreshold: 999,
      intervalSeconds: 1,
      probability: 2,
      minGapSeconds: 999999,
      flushAfterSeconds: -3,
    },
    memory: {
      injectMaxChars: 999999,
      autoCollect: { everyRounds: 0, maxFacts: 999, maxFactChars: 1 },
    },
  });
  assert.equal(settings.reply.countThreshold, 200);
  assert.equal(settings.reply.intervalSeconds, 5);
  assert.equal(settings.reply.probability, 1);
  assert.equal(settings.reply.minGapSeconds, 3600);
  assert.equal(settings.reply.flushAfterSeconds, 0);
  assert.equal(settings.memory.injectMaxChars, 20000);
  assert.equal(settings.memory.autoCollect.everyRounds, 1);
  assert.equal(settings.memory.autoCollect.maxFacts, 20);
  assert.equal(settings.memory.autoCollect.maxFactChars, 50);

  const lower = await store.patch({ reply: { countThreshold: -5, probability: -1 } });
  assert.equal(lower.settings.reply.countThreshold, 1);
  assert.equal(lower.settings.reply.probability, 0);
});

test('类型错误回退默认：布尔/枚举/数值/绝对路径', async (t) => {
  const { store, defaults } = makeStore(t);
  const { settings } = await store.patch({
    reply: { enabled: 'yes', groupMode: 'bogus', probability: 'abc' },
    persona: { path: 'relative/persona.md', mode: 'weird' },
    memory: { dir: 'relative-memory' },
    triggers: { keywords: 'not-an-array' },
  });
  assert.equal(settings.reply.enabled, defaults.reply.enabled);
  assert.equal(settings.reply.groupMode, defaults.reply.groupMode);
  assert.equal(settings.reply.probability, defaults.reply.probability);
  assert.equal(settings.persona.path, defaults.persona.path);
  assert.equal(settings.persona.mode, defaults.persona.mode);
  assert.equal(settings.memory.dir, defaults.memory.dir);
  assert.deepEqual(settings.triggers.keywords, []);
});

test('未知字段丢弃：顶层与嵌套都只保留契约字段', async (t) => {
  const { store, file } = makeStore(t);
  const { changed } = await store.patch({
    unknownTop: 1,
    reply: { unknownReply: true, enabled: false },
    memory: { autoCollect: { unknownNested: 'x', everyRounds: 2 } },
  });
  assert.deepEqual(changed, ['memory.autoCollect.everyRounds', 'reply.enabled']);
  const snapshot = store.get();
  assert.equal('unknownTop' in snapshot, false);
  assert.equal('unknownReply' in snapshot.reply, false);
  assert.equal('unknownNested' in snapshot.memory.autoCollect, false);
  // 落盘内容同样不应包含未知字段。
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('unknownTop' in raw, false);
  assert.equal('unknownReply' in raw.reply, false);
});

test('未知字段导致的空 patch 不落盘、不通知', async (t) => {
  const { store, file } = makeStore(t);
  let calls = 0;
  store.subscribe(() => { calls += 1; });
  const { changed } = await store.patch({ onlyUnknown: true });
  assert.deepEqual(changed, []);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(file), false);
});

test('原子落盘：0600 权限、合法 JSON、无 tmp 残留', async (t) => {
  const { store, file, dir } = makeStore(t);
  await store.patch({ reply: { countThreshold: 7 } });
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600, 'settings.json 权限必须是 0600');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.endsWith('\n'), '文件应以换行结尾');
  assert.doesNotThrow(() => JSON.parse(raw));
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('坏 JSON：备份为 .corrupt-* 并回退默认值，之后可正常 patch', async (t) => {
  const { dir, file, defaults, logger } = makeStore(t);
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const store = createSettingsStore({ file, defaults, logger });
  assert.deepEqual(store.get(), defaults, '坏 JSON 必须回退默认值而不是抛错');
  const corrupt = fs.readdirSync(dir).filter((name) => name.startsWith('settings.json.corrupt-'));
  assert.equal(corrupt.length, 1, '坏文件应被改名备份');
  assert.equal(fs.existsSync(file), false, '坏文件应被移走');
  assert.ok(logger.byLevel('warn').length >= 1, '坏 JSON 应有 warn 日志');
  // 回退后仍能正常工作。
  const { settings } = await store.patch({ reply: { countThreshold: 4 } });
  assert.equal(settings.reply.countThreshold, 4);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).reply.countThreshold, 4);
});

test('文件不存在：使用默认值，首次 patch 才创建文件', (t) => {
  const { store, file } = makeStore(t);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(store.get(), store.defaults);
});

test('订阅：变更时收到快照、无变更不触发、退订后不再触发', async (t) => {
  const { store } = makeStore(t);
  const received = [];
  const unsubscribe = store.subscribe((snapshot) => received.push(snapshot));
  await store.patch({ reply: { countThreshold: 5 } });
  assert.equal(received.length, 1);
  assert.equal(received[0].reply.countThreshold, 5);
  // 收到的快照是副本，改它不影响 store。
  received[0].reply.countThreshold = 42;
  assert.equal(store.get().reply.countThreshold, 5);

  // 同值 patch 不触发。
  await store.patch({ reply: { countThreshold: 5 } });
  assert.equal(received.length, 1);

  unsubscribe();
  await store.patch({ reply: { countThreshold: 6 } });
  assert.equal(received.length, 1);
});

test('订阅者抛错不影响其它订阅者，也不阻断落盘', async (t) => {
  const { store, file } = makeStore(t);
  const seen = [];
  store.subscribe(() => { throw new Error('订阅者故意抛错'); });
  store.subscribe((snapshot) => seen.push(snapshot.reply.countThreshold));
  const { settings } = await store.patch({ reply: { countThreshold: 9 } });
  assert.equal(settings.reply.countThreshold, 9);
  assert.deepEqual(seen, [9]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).reply.countThreshold, 9);
});

test('replace：用默认值补全缺失字段，清掉自定义值', async (t) => {
  const { store, defaults } = makeStore(t);
  await store.patch({ reply: { countThreshold: 77 }, behavior: { extraInstructions: '自定义' } });
  const { settings, changed } = await store.replace({ reply: { enabled: false } });
  assert.equal(settings.reply.enabled, false);
  assert.equal(settings.reply.countThreshold, defaults.reply.countThreshold);
  assert.equal(settings.behavior.extraInstructions, defaults.behavior.extraInstructions);
  assert.ok(changed.includes('reply.enabled'));
  assert.ok(changed.includes('reply.countThreshold'));
  assert.ok(changed.includes('behavior.extraInstructions'));
});

test('keywords：过滤非字符串/空串/超长，去重并截断到 50 条', async (t) => {
  const { store } = makeStore(t);
  const many = Array.from({ length: 60 }, (_, index) => '关键词' + index);
  const { settings } = await store.patch({
    triggers: {
      keywords: ['甲', '甲', '', '   ', 123, 'x'.repeat(41), '乙', ...many],
    },
  });
  const keywords = settings.triggers.keywords;
  assert.equal(keywords[0], '甲');
  assert.equal(keywords.includes(''), false);
  assert.equal(keywords.includes('x'.repeat(41)), false);
  assert.equal(keywords.length, 50, '最多保留 50 个关键词');
  assert.equal(new Set(keywords).size, keywords.length, '关键词必须去重');
});

test('changed 返回被改动的点路径（含数组变化）', async (t) => {
  const { store } = makeStore(t);
  const { changed } = await store.patch({
    reply: { groupMode: 'interval' },
    triggers: { keywords: ['甲'] },
  });
  assert.deepEqual(changed, ['reply.groupMode', 'triggers.keywords']);
});

test('并发 patch：串行落盘，最终文件包含两次修改', async (t) => {
  const { store, file } = makeStore(t);
  const first = store.patch({ reply: { countThreshold: 11 } });
  const second = store.patch({ memory: { injectMaxChars: 3000 } });
  await Promise.all([first, second]);
  const snapshot = store.get();
  assert.equal(snapshot.reply.countThreshold, 11);
  assert.equal(snapshot.memory.injectMaxChars, 3000);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.reply.countThreshold, 11);
  assert.equal(raw.memory.injectMaxChars, 3000);
});

test('数值字符串容错：可被解析时按数字校验，不可解析回退默认', async (t) => {
  const { store, defaults } = makeStore(t);
  const { settings } = await store.patch({
    reply: { countThreshold: '12', intervalSeconds: 'abc' },
  });
  assert.equal(settings.reply.countThreshold, 12);
  assert.equal(settings.reply.intervalSeconds, defaults.reply.intervalSeconds);
});
// ── model 段（追加需求：模型切换） ───────────────────────────

test('model：默认跟随宿主（provider/model/effort 均为空串）', async (t) => {
  const { store, defaults } = makeStore(t);
  assert.deepEqual(defaults.model, { provider: '', model: '', reasoningEffort: '' });
  assert.deepEqual(store.get().model, { provider: '', model: '', reasoningEffort: '' });
});

test('model：深合并单个字段，不影响同段其它字段', async (t) => {
  const { store } = makeStore(t);
  const first = await store.patch({ model: { provider: 'openai' } });
  assert.deepEqual(first.changed, ['model.provider']);
  assert.deepEqual(first.settings.model, { provider: 'openai', model: '', reasoningEffort: '' });

  const second = await store.patch({ model: { model: 'gpt-6', reasoningEffort: 'high' } });
  assert.deepEqual(second.changed, ['model.model', 'model.reasoningEffort']);
  assert.deepEqual(second.settings.model, { provider: 'openai', model: 'gpt-6', reasoningEffort: 'high' });
  // 落盘内容同样完整且只含契约字段
  const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.deepEqual(raw.model, { provider: 'openai', model: 'gpt-6', reasoningEffort: 'high' });
});

test('model：provider/model/effort 超长截断到 200/300/32 并 trim', async (t) => {
  const { store } = makeStore(t);
  const { settings } = await store.patch({
    model: {
      provider: 'p'.repeat(250),
      model: 'm'.repeat(400),
      reasoningEffort: 'e'.repeat(40),
    },
  });
  assert.equal(settings.model.provider.length, 200);
  assert.equal(settings.model.model.length, 300);
  assert.equal(settings.model.reasoningEffort.length, 32);

  const trimmed = await store.patch({ model: { provider: '  openai  ', model: '  gpt-6  ' } });
  assert.equal(trimmed.settings.model.provider, 'openai');
  assert.equal(trimmed.settings.model.model, 'gpt-6');
});

test('model：非字符串类型回退默认空串，未知字段丢弃', async (t) => {
  const { store } = makeStore(t);
  const { settings, changed } = await store.patch({
    model: {
      provider: 123,
      model: { nested: 'x' },
      reasoningEffort: ['high'],
      unknownModelField: '丢弃',
      unknownEffort: true,
    },
  });
  assert.deepEqual(settings.model, { provider: '', model: '', reasoningEffort: '' });
  assert.deepEqual(changed, []);
  assert.equal('unknownModelField' in settings.model, false);
  assert.equal('unknownEffort' in settings.model, false);
  // patch 里混入未知字段 + 合法字段时只记录合法变更
  const mixed = await store.patch({ model: { unknownA: 1, provider: 'deepseek-account' } });
  assert.deepEqual(mixed.changed, ['model.provider']);
  assert.equal('unknownA' in mixed.settings.model, false);
});

test('model：replace 用默认值清空自定义模型选择', async (t) => {
  const { store } = makeStore(t);
  await store.patch({ model: { provider: 'p', model: 'm', reasoningEffort: 'max' } });
  const { settings, changed } = await store.replace({});
  assert.deepEqual(settings.model, { provider: '', model: '', reasoningEffort: '' });
  assert.ok(changed.includes('model.provider'));
  assert.ok(changed.includes('model.model'));
  assert.ok(changed.includes('model.reasoningEffort'));
});
// ── agent / features 段（追加需求：Agent 预设 + 功能开关） ─────

test('agent/features：默认值（preset 空串跟随内置组合，5 个功能开关全开）', async (t) => {
  const { store, defaults } = makeStore(t);
  assert.deepEqual(defaults.agent, { preset: '' });
  assert.deepEqual(defaults.features, {
    workspace: true,
    web: true,
    stickers: true,
    vision: true,
    memory: true,
  });
  assert.deepEqual(store.get().agent, { preset: '' });
  assert.deepEqual(store.get().features, defaults.features);
});

test('agent.preset：patch 深合并、trim、超长截断到 120、非字符串回退空串', async (t) => {
  const { store } = makeStore(t);
  const first = await store.patch({ agent: { preset: '  minimal  ' } });
  assert.deepEqual(first.changed, ['agent.preset']);
  assert.equal(first.settings.agent.preset, 'minimal');

  const long = await store.patch({ agent: { preset: 'p'.repeat(200) } });
  assert.equal(long.settings.agent.preset.length, 120);

  const invalid = await store.patch({ agent: { preset: 123, unknownAgentField: '丢弃' } });
  assert.equal(invalid.settings.agent.preset, '');
  assert.equal('unknownAgentField' in invalid.settings.agent, false);
  // 只认 preset 一个字段，直接调用 validate 检查未知字段剥离
  const validated = store.validate({ agent: { preset: 'x', extra: 1 } });
  assert.deepEqual(validated.agent, { preset: 'x' });
});

test('features：深合并单个开关，不影响其它开关', async (t) => {
  const { store } = makeStore(t);
  const first = await store.patch({ features: { workspace: false } });
  assert.deepEqual(first.changed, ['features.workspace']);
  assert.deepEqual(first.settings.features, {
    workspace: false,
    web: true,
    stickers: true,
    vision: true,
    memory: true,
  });

  const second = await store.patch({ features: { web: false, memory: false } });
  assert.deepEqual(second.changed, ['features.memory', 'features.web']);
  assert.deepEqual(second.settings.features, {
    workspace: false,
    web: false,
    stickers: true,
    vision: true,
    memory: false,
  });
  const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.deepEqual(raw.features, second.settings.features);
});

test('features：非布尔值回退默认 true，未知字段丢弃', async (t) => {
  const { store } = makeStore(t);
  const { settings, changed } = await store.patch({
    features: {
      workspace: 'false',
      web: 0,
      stickers: null,
      vision: 'no',
      memory: 1,
      unknownFeature: false,
    },
  });
  assert.deepEqual(settings.features, {
    workspace: true,
    web: true,
    stickers: true,
    vision: true,
    memory: true,
  });
  assert.deepEqual(changed, []);
  assert.equal('unknownFeature' in settings.features, false);
});

test('features：可全部关闭并落盘；replace 重置为全开', async (t) => {
  const { store } = makeStore(t);
  const off = await store.patch({
    features: { workspace: false, web: false, stickers: false, vision: false, memory: false },
  });
  assert.deepEqual(Object.values(off.settings.features), [false, false, false, false, false]);
  assert.equal(off.changed.length, 5);

  const reset = await store.replace({});
  assert.deepEqual(reset.settings.features, {
    workspace: true,
    web: true,
    stickers: true,
    vision: true,
    memory: true,
  });
  assert.ok(reset.changed.includes('features.workspace'));
});

test('agent/features 与其它段互不影响（同一 patch 多段变更）', async (t) => {
  const { store } = makeStore(t);
  const { settings, changed } = await store.patch({
    agent: { preset: 'host-preset' },
    features: { stickers: false },
    model: { provider: 'p', model: 'm' },
  });
  assert.equal(settings.agent.preset, 'host-preset');
  assert.equal(settings.features.stickers, false);
  assert.equal(settings.features.memory, true);
  assert.equal(settings.model.provider, 'p');
  assert.deepEqual(changed, ['agent.preset', 'features.stickers', 'model.model', 'model.provider']);
});
// ── stickers 段（追加需求 2026-10-26：表情包管理） ──────────

test('stickers：默认目录指向 <cwd>/stickers，允许收藏、单张上限 8MB', async (t) => {
  const { store, defaults } = makeStore(t);
  assert.ok(path.isAbsolute(defaults.stickers.dir), 'stickers.dir 必须是绝对路径');
  assert.ok(defaults.stickers.dir.endsWith('stickers'));
  assert.deepEqual(defaults.stickers, {
    dir: path.join(path.resolve(defaults.persona.path, '..'), 'stickers'),
    collectEnabled: true,
    maxMB: 8,
    dailyLimit: 10,
    // 发送频率只影响提示词节奏指引，默认 normal（与旧行为一致：大概每 3~5 轮）
    frequency: 'normal',
  });
  assert.deepEqual(store.get().stickers, defaults.stickers);
});

test('stickers.frequency：默认 normal，只接受已知档位，未知值回退 normal', async (t) => {
  const { store } = makeStore(t);
  assert.equal(store.get().stickers.frequency, 'normal');

  for (const level of ['off', 'rare', 'normal', 'often']) {
    const result = await store.patch({ stickers: { frequency: level } });
    assert.equal(result.settings.stickers.frequency, level, '应接受档位 ' + level);
  }

  const bad = await store.patch({ stickers: { frequency: 'always' } });
  assert.equal(bad.settings.stickers.frequency, 'normal', '未知档位应回退 normal');

  const other = await store.patch({ stickers: { frequency: 'rare' } });
  assert.equal(other.settings.stickers.frequency, 'rare', '切档应立即生效');
  assert.deepEqual(other.changed, ['stickers.frequency'], '只改 frequency 时变更列表只应有这一项');
});

test('stickers：深合并单个字段，不影响同段其它字段', async (t) => {
  const { store } = makeStore(t);
  const first = await store.patch({ stickers: { collectEnabled: false } });
  assert.deepEqual(first.changed, ['stickers.collectEnabled']);
  assert.equal(first.settings.stickers.collectEnabled, false);
  assert.equal(first.settings.stickers.maxMB, 8);
  assert.ok(first.settings.stickers.dir.endsWith('stickers'));

  const second = await store.patch({ stickers: { maxMB: 20 } });
  assert.deepEqual(second.changed, ['stickers.maxMB']);
  assert.equal(second.settings.stickers.maxMB, 20);
  assert.equal(second.settings.stickers.collectEnabled, false);
});

test('stickers：maxMB 越界截断到 1..50，非数值回退默认', async (t) => {
  const { store } = makeStore(t);
  const low = await store.patch({ stickers: { maxMB: 0 } });
  assert.equal(low.settings.stickers.maxMB, 1);
  const high = await store.patch({ stickers: { maxMB: 999 } });
  assert.equal(high.settings.stickers.maxMB, 50);
  const invalid = await store.patch({ stickers: { maxMB: 'abc' } });
  assert.equal(invalid.settings.stickers.maxMB, 8, '不可解析时应回退契约默认值 8');
  const obj = await store.patch({ stickers: { maxMB: { n: 3 } } });
  assert.equal(obj.settings.stickers.maxMB, 8, '非标量应回退契约默认值 8');
});

test('stickers：dir 只接受绝对路径，相对路径回退默认；未知字段丢弃', async (t) => {
  const { store, defaults } = makeStore(t);
  const relative = await store.patch({ stickers: { dir: 'relative/stickers', extra: 'x' } });
  assert.equal(relative.settings.stickers.dir, defaults.stickers.dir);
  assert.equal('extra' in relative.settings.stickers, false);
  assert.deepEqual(relative.changed, []);

  const abs = path.join(path.dirname(defaults.stickers.dir), 'custom-stickers');
  const accepted = await store.patch({ stickers: { dir: abs } });
  assert.equal(accepted.settings.stickers.dir, abs);
  assert.deepEqual(accepted.changed, ['stickers.dir']);
});

test('stickers：replace 重置为默认值', async (t) => {
  const { store, defaults } = makeStore(t);
  await store.patch({ stickers: { collectEnabled: false, maxMB: 50 } });
  const { settings, changed } = await store.replace({});
  assert.deepEqual(settings.stickers, defaults.stickers);
  assert.ok(changed.includes('stickers.collectEnabled'));
  assert.ok(changed.includes('stickers.maxMB'));
});

test('stickers 与 features.stickers 独立（总开关在 features，管理配置在 stickers）', async (t) => {
  const { store } = makeStore(t);
  const { settings, changed } = await store.patch({
    features: { stickers: false },
    stickers: { collectEnabled: true, maxMB: 12 },
  });
  assert.equal(settings.features.stickers, false);
  assert.equal(settings.stickers.collectEnabled, true);
  assert.equal(settings.stickers.maxMB, 12);
  assert.deepEqual(changed, ['features.stickers', 'stickers.maxMB']);
});
// ── reply.adaptive / stickers.dailyLimit（追加需求 2026-10-26 晚） ──

test('reply.adaptive：默认值 4/12/20/true，groupMode 接受 adaptive', async (t) => {
  const { store, defaults } = makeStore(t);
  assert.deepEqual(defaults.reply.adaptive, {
    debounceSeconds: 4,
    cooldownSeconds: 12,
    maxWaitSeconds: 20,
    requireRelevance: true,
  });
  const { settings, changed } = await store.patch({ reply: { groupMode: 'adaptive' } });
  assert.equal(settings.reply.groupMode, 'adaptive');
  assert.deepEqual(settings.reply.adaptive, defaults.reply.adaptive);
  assert.deepEqual(changed, ['reply.groupMode']);
});

test('reply.adaptive：深合并单个参数，不影响其它参数', async (t) => {
  const { store } = makeStore(t);
  const first = await store.patch({ reply: { adaptive: { debounceSeconds: 8 } } });
  assert.deepEqual(first.changed, ['reply.adaptive.debounceSeconds']);
  assert.deepEqual(first.settings.reply.adaptive, {
    debounceSeconds: 8,
    cooldownSeconds: 12,
    maxWaitSeconds: 20,
    requireRelevance: true,
  });
  const second = await store.patch({ reply: { adaptive: { cooldownSeconds: 0, maxWaitSeconds: 60 } } });
  assert.deepEqual(second.settings.reply.adaptive, {
    debounceSeconds: 8,
    cooldownSeconds: 0,
    maxWaitSeconds: 60,
    requireRelevance: true,
  });
});

test('reply.adaptive：越界截断（debounce 0..30 / cooldown 0..600 / maxWait 2..300）', async (t) => {
  const { store } = makeStore(t);
  const high = await store.patch({ reply: { adaptive: { debounceSeconds: 999, cooldownSeconds: 9999, maxWaitSeconds: 9999 } } });
  assert.equal(high.settings.reply.adaptive.debounceSeconds, 30);
  assert.equal(high.settings.reply.adaptive.cooldownSeconds, 600);
  assert.equal(high.settings.reply.adaptive.maxWaitSeconds, 300);
  const low = await store.patch({ reply: { adaptive: { debounceSeconds: -5, cooldownSeconds: -1, maxWaitSeconds: 1 } } });
  assert.equal(low.settings.reply.adaptive.debounceSeconds, 0);
  assert.equal(low.settings.reply.adaptive.cooldownSeconds, 0);
  assert.equal(low.settings.reply.adaptive.maxWaitSeconds, 2);
  // 不可解析数值 → 契约默认
  const invalid = await store.patch({ reply: { adaptive: { debounceSeconds: 'abc', maxWaitSeconds: {} } } });
  assert.equal(invalid.settings.reply.adaptive.debounceSeconds, 4);
  assert.equal(invalid.settings.reply.adaptive.maxWaitSeconds, 20);
});

test('reply.adaptive：requireRelevance 非布尔回退默认 true；未知字段丢弃', async (t) => {
  const { store } = makeStore(t);
  const off = await store.patch({ reply: { adaptive: { requireRelevance: false } } });
  assert.equal(off.settings.reply.adaptive.requireRelevance, false);
  const invalid = await store.patch({ reply: { adaptive: { requireRelevance: 'false', unknownAdaptive: 1 } } });
  assert.equal(invalid.settings.reply.adaptive.requireRelevance, true, '非布尔应回退默认 true');
  assert.equal('unknownAdaptive' in invalid.settings.reply.adaptive, false);
  // 0 / null 也不是布尔 → 回退 true
  const numeric = await store.patch({ reply: { adaptive: { requireRelevance: 0 } } });
  assert.equal(numeric.settings.reply.adaptive.requireRelevance, true);
});

test('reply.adaptive：replace 重置为默认值', async (t) => {
  const { store, defaults } = makeStore(t);
  await store.patch({ reply: { groupMode: 'adaptive', adaptive: { debounceSeconds: 30, requireRelevance: false } } });
  const { settings, changed } = await store.replace({});
  assert.deepEqual(settings.reply.adaptive, defaults.reply.adaptive);
  assert.equal(settings.reply.groupMode, 'count');
  assert.ok(changed.includes('reply.adaptive.debounceSeconds'));
  assert.ok(changed.includes('reply.adaptive.requireRelevance'));
});

test('stickers.dailyLimit：默认 10，1..100 截断，非数值回退默认，未知字段丢弃', async (t) => {
  const { store, defaults } = makeStore(t);
  assert.equal(defaults.stickers.dailyLimit, 10);
  const ok = await store.patch({ stickers: { dailyLimit: 25 } });
  assert.equal(ok.settings.stickers.dailyLimit, 25);
  assert.deepEqual(ok.changed, ['stickers.dailyLimit']);
  const low = await store.patch({ stickers: { dailyLimit: 0 } });
  assert.equal(low.settings.stickers.dailyLimit, 1);
  const high = await store.patch({ stickers: { dailyLimit: 999 } });
  assert.equal(high.settings.stickers.dailyLimit, 100);
  const invalid = await store.patch({ stickers: { dailyLimit: 'abc', unknownStickerField: true } });
  assert.equal(invalid.settings.stickers.dailyLimit, 10, '不可解析回退契约默认 10');
  assert.equal('unknownStickerField' in invalid.settings.stickers, false);
  assert.equal(store.get().stickers.maxMB, 8, 'dailyLimit 变更不影响 maxMB');
});


test('phrases：默认关闭条目为空；文本去重/空文本丢弃/启用开关保留', async (t) => {
  const { store } = makeStore(t);
  assert.deepEqual(store.get().phrases, { enabled: true, items: [] });
  const patched = await store.patch({
    phrases: {
      enabled: false,
      items: [
        { text: '哦对了', note: '想到一件事' },
        { text: '哦对了', note: '重复' },
        { text: '   ', note: '空' },
        { text: 'onp', note: '哦牛批', enabled: false, unknown: 1 },
      ],
    },
  });
  assert.equal(patched.settings.phrases.enabled, false);
  assert.deepEqual(patched.settings.phrases.items, [
    { text: '哦对了', note: '想到一件事', enabled: true },
    { text: 'onp', note: '哦牛批', enabled: false },
  ]);
  assert.equal('unknown' in patched.settings.phrases.items[1], false);
  assert.ok(patched.changed.includes('phrases.items'));
});



test('reply.bubbleSplit：默认 auto；marker/off 保留，非法值回退默认', async (t) => {
  const { store, defaults } = makeStore(t);
  assert.equal(defaults.reply.bubbleSplit, 'auto');
  assert.equal((await store.patch({ reply: { bubbleSplit: 'marker' } })).settings.reply.bubbleSplit, 'marker');
  assert.equal((await store.patch({ reply: { bubbleSplit: 'off' } })).settings.reply.bubbleSplit, 'off');
  assert.equal((await store.patch({ reply: { bubbleSplit: 'nope' } })).settings.reply.bubbleSplit, 'auto');
});
// ── admin / phrases（第四批：管理员与口头禅） ────────────────

test('admin：默认关闭、openids/names 为空数组', async (t) => {
  const { store, defaults } = makeStore(t);
  assert.deepEqual(defaults.admin, { enabled: false, openids: [], names: [] });
  assert.deepEqual(store.get().admin, defaults.admin);
});

test('admin：enabled 布尔校验、openids/names 深合并与截断', async (t) => {
  const { store } = makeStore(t);
  const on = await store.patch({ admin: { enabled: true } });
  assert.equal(on.settings.admin.enabled, true);
  assert.deepEqual(on.changed, ['admin.enabled']);

  const invalid = await store.patch({ admin: { enabled: 'yes' } });
  assert.equal(invalid.settings.admin.enabled, false, '非布尔应回退契约默认值 false');

  // openids 去重 + 上限 100；names 去重 + 上限 50
  const openids = Array.from({ length: 120 }, (_, index) => 'openid-' + index);
  const names = Array.from({ length: 60 }, (_, index) => '昵称' + index);
  const lists = await store.patch({ admin: { openids: openids.concat(['openid-1']), names } });
  assert.equal(lists.settings.admin.openids.length, 100);
  assert.equal(lists.settings.admin.names.length, 50);
  assert.equal(new Set(lists.settings.admin.openids).size, 100);
  // 非字符串/空串/超长条目丢弃
  const filtered = await store.patch({ admin: { openids: ['ok', '', 123, 'x'.repeat(101)] } });
  assert.deepEqual(filtered.settings.admin.openids, ['ok']);
  const tooLongName = await store.patch({ admin: { names: ['n'.repeat(41), '正常'] } });
  assert.deepEqual(tooLongName.settings.admin.names, ['正常']);
});

test('admin：未知字段丢弃，replace 重置', async (t) => {
  const { store, defaults } = makeStore(t);
  const patched = await store.patch({ admin: { enabled: true, openids: ['u1'], unknownAdmin: 'x' } });
  assert.equal('unknownAdmin' in patched.settings.admin, false);
  const reset = await store.replace({});
  assert.deepEqual(reset.settings.admin, defaults.admin);
});

test('phrases：默认开启、条目空；文本 trim/截断、去重（大小写不敏感）、最多 40 条', async (t) => {
  const { store, defaults } = makeStore(t);
  assert.deepEqual(defaults.phrases, { enabled: true, items: [] });

  const items = [
    { text: '  笑死  ', note: ' n ', enabled: true },
    { text: '笑死', note: 'dup', enabled: false },
    { text: 'AAA' },
    { text: 'aaa' },
    { text: '', note: 'empty' },
    { text: 'x'.repeat(100), note: 'y'.repeat(400) },
    ...Array.from({ length: 45 }, (_, index) => ({ text: 'phrase-' + index })),
  ];
  const { settings } = await store.patch({ phrases: { enabled: false, items } });
  assert.equal(settings.phrases.enabled, false);
  assert.ok(settings.phrases.items.length <= 40);
  assert.equal(settings.phrases.items[0].text, '笑死');
  assert.equal(settings.phrases.items[0].note, 'n');
  const texts = settings.phrases.items.map((item) => item.text);
  assert.equal(texts.filter((textValue) => textValue.toLowerCase() === 'aaa').length, 1, '大小写不敏感去重');
  assert.equal(texts.includes(''), false);
  const longEntry = settings.phrases.items.find((item) => item.text.length === 80);
  assert.ok(longEntry, '超长文本应截断到 80 后保留');
  assert.equal(longEntry.note.length, 300);
  // 非布尔 enabled 回退 true
  const numeric = await store.patch({ phrases: { items: [{ text: '唯一', enabled: 0 }] } });
  assert.equal(numeric.settings.phrases.items[0].enabled, true);
});


test('settings.prompts：默认四段启用且 text 为空；开关/文本归一化，非法值回退', async (t) => {
  const { store, defaults } = makeStore(t);
  // v0.11 起 prompts 多一个 sections（分段覆盖表），其余仍是四段引导词
  assert.deepEqual(
    Object.keys(defaults.prompts).sort(),
    ['rhythmGuide', 'sections', 'sendGuide', 'stickerGuide', 'toolGuide'],
  );
  assert.deepEqual(defaults.prompts.sections, {}, 'sections 默认空（全部走内置默认）');
  for (const key of ['rhythmGuide', 'sendGuide', 'stickerGuide', 'toolGuide']) {
    assert.equal(defaults.prompts[key].enabled, true, key + ' 默认启用');
    assert.equal(defaults.prompts[key].text, '', key + ' 默认空文本（用内置默认）');
  }
  const patched = await store.patch({ prompts: { stickerGuide: { enabled: false, text: '【表情包】只在深夜发' } } });
  assert.equal(patched.settings.prompts.stickerGuide.enabled, false);
  assert.equal(patched.settings.prompts.stickerGuide.text, '【表情包】只在深夜发');
  assert.equal(patched.settings.prompts.toolGuide.enabled, true, '其它段不受影响');
  // 超长文本截断到 8000；enabled 非布尔回退默认
  const long = await store.patch({ prompts: { sendGuide: { enabled: 'yes', text: 'x'.repeat(9000) } } });
  assert.equal(long.settings.prompts.sendGuide.text.length, 8000);
  assert.equal(long.settings.prompts.sendGuide.enabled, true);
});


test('settings.tools.extraAllowed：默认空、去空去重、长度截断、非数组回退', async (t) => {
  const { store, defaults } = makeStore(t);
  assert.deepEqual(defaults.tools.extraAllowed, []);
  const patched = await store.patch({ tools: { extraAllowed: ['skill', ' skill ', '', 'mcp__fs__read'] } });
  assert.deepEqual(patched.settings.tools.extraAllowed, ['skill', 'mcp__fs__read']);
  const tooMany = await store.patch({ tools: { extraAllowed: Array.from({ length: 60 }, (_, i) => 'tool_' + i) } });
  assert.equal(tooMany.settings.tools.extraAllowed.length, 50);
  const invalid = await store.patch({ tools: { extraAllowed: 'skill' } });
  assert.deepEqual(invalid.settings.tools.extraAllowed, []);
});

test('settings.patchReplace：集合型字段可整体替换（深合并删不掉键）', async () => {
  const s = await import('../lib/settings-store.js');
  const nodeFs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-st-'));
  const file = path.join(dir, 'settings.json');
  const store = s.createSettingsStore({ file, defaults: s.resolveDefaults({ cwd: dir }), logger: { warn() {}, error() {} } });

  await store.patchReplace({ tools: { capabilityEntries: { a: { tools: ['x'] } } } }, ['tools.capabilityEntries']);
  assert.deepEqual(Object.keys(store.get().tools.capabilityEntries), ['a']);

  // 普通 patch 清空 -> 无效（深合并）
  await store.patch({ tools: { capabilityEntries: {} } });
  assert.deepEqual(Object.keys(store.get().tools.capabilityEntries), ['a'], '深合并不应删除键');

  // patchReplace -> 真正清空
  await store.patchReplace({ tools: { capabilityEntries: {} } }, ['tools.capabilityEntries']);
  assert.deepEqual(store.get().tools.capabilityEntries, {}, 'patchReplace 应整体替换');
});

test('prompts.sections：patchReplace 可整体清空（深合并删不掉键）', async () => {
  const s = await import('../lib/settings-store.js');
  const nodeFs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-sec-'));
  const store = s.createSettingsStore({ file: path.join(dir, 'settings.json'), defaults: s.resolveDefaults({ cwd: dir }), logger: { warn() {}, error() {} } });

  await store.patchReplace({ prompts: { sections: { safety: { enabled: true, text: '自定义安全' } } } }, ['prompts.sections']);
  assert.equal(store.get().prompts.sections.safety.text, '自定义安全');

  // 普通 patch 清空无效（深合并）
  await store.patch({ prompts: { sections: {} } });
  assert.ok(store.get().prompts.sections.safety, '深合并不应删除分段覆盖');

  // patchReplace 清空生效
  await store.patchReplace({ prompts: { sections: {} } }, ['prompts.sections']);
  assert.deepEqual(store.get().prompts.sections, {}, 'patchReplace 应清空分段覆盖');
});
