/**
 * collector 单测：假 ctx + async generator 假 LLM 流 + 内存版 memoryStore。
 * 不联网、不访问真实工作区。
 * 覆盖：noteTurnEnd 轮次触发、collectNow 解析容错/maxFacts/截断/去重、
 *       失败只记 stats、in-flight 锁、record 形状兼容、模型路由回退、stats 形状，
 *       以及 memory_* 工具的注册/执行契约（memory-tools 无独立测试文件，合并于此）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCollector } from '../lib/memory/collector.js';
import { createMemoryStore } from '../lib/memory/store.js';
import { registerMemoryTools } from '../lib/tools/memory-tools.js';

const QUIET_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

// ── 假数据构造 ────────────────────────────────────────────────
function makeMemoryStore(initialFacts = []) {
  const facts = [...initialFacts];
  const saved = [];
  return {
    facts,
    saved,
    saveFact(input) {
      const key = input.text.trim();
      if (facts.includes(key)) {
        return { ok: true, duplicate: true, file: 'notes/x.md', entry: key, path: '/tmp/x.md' };
      }
      facts.push(key);
      saved.push({ ...input });
      return { ok: true, duplicate: false, file: 'notes/x.md', entry: key, path: '/tmp/x.md' };
    },
  };
}

function makeSettings(overrides = {}) {
  const autoCollect = {
    enabled: true,
    everyRounds: 6,
    maxFacts: 5,
    maxFactChars: 400,
    provider: 'test-provider',
    model: 'test-model',
    ...(overrides.autoCollect ?? {}),
  };
  const memory = {
    enabled: true,
    dir: '/tmp/qqb-collector-memory',
    injectMaxChars: 4000,
    ...overrides,
    autoCollect, // 放在 spread 之后，确保 overrides.autoCollect 只覆盖局部字段
  };
  return { get: () => ({ memory }) };
}

function makeCtx({ streamFactory, selection, getRouteValue } = {}) {
  const calls = [];
  const ctx = {
    calls,
    get(name) {
      if (name === 'llm') {
        if (!streamFactory) return undefined;
        return {
          stream(options) {
            calls.push(options);
            return streamFactory(options);
          },
        };
      }
      if (name === 'agentDefaultModel') {
        return selection ? { currentSelection: () => selection } : undefined;
      }
      return undefined;
    },
  };
  if (getRouteValue !== undefined) {
    // getRoute 由 createCollector 参数传入，不挂在 ctx 上
  }
  return ctx;
}

/** 生成一段正常文本流（chunk 协议与宿主 BlockAssembler 对齐） */
function makeJsonStream(text, options = {}) {
  return async function* stream() {
    if (options.throwError) throw options.throwError;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: options.finishReason ?? { kind: 'stop' } };
  };
}

function userMessage(text, seq = 1) {
  return {
    type: 'user/message',
    seq,
    time: seq,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  };
}

function assistantMessage(text, seq = 2) {
  return {
    type: 'assistant/message',
    seq,
    time: seq,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] }, stream: [] },
  };
}

function record(events) {
  return { session: { events } };
}

function quietLoggerSink() {
  const stats = { warns: [], errors: [] };
  return {
    warn: (...args) => stats.warns.push(args.join(' ')),
    error: (...args) => stats.errors.push(args.join(' ')),
    info() {},
    debug() {},
    sink: stats,
  };
}

// ── noteTurnEnd / stats ──────────────────────────────────────
test('noteTurnEnd 按 everyRounds 触发一次后台提炼', async () => {
  const memoryStore = makeMemoryStore();
  const payload = JSON.stringify({ facts: [{ text: '用户喜欢猫', tags: ['偏好'], importance: 'normal' }] });
  const ctx = makeCtx({ streamFactory: makeJsonStream(payload) });
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const collector = createCollector({
    ctx,
    settings: makeSettings({ autoCollect: { everyRounds: 3 } }),
    memoryStore,
    logger: QUIET_LOGGER,
    onStats: () => resolveDone(),
  });

  collector.noteTurnEnd(record([userMessage('第一轮')]));
  collector.noteTurnEnd(record([userMessage('第二轮')]));
  assert.equal(memoryStore.saved.length, 0);
  assert.equal(collector.stats().roundsSinceCollect, 2);

  collector.noteTurnEnd(record([userMessage('第三轮')]));
  assert.equal(collector.stats().roundsSinceCollect, 0, '触发后计数清零');

  await done;
  assert.equal(memoryStore.saved.length, 1);
  assert.equal(memoryStore.saved[0].text, '用户喜欢猫');
  assert.equal(memoryStore.saved[0].source, 'auto');
  const stats = collector.stats();
  assert.deepEqual(Object.keys(stats).sort(), [
    'enabled', 'lastCollectAt', 'lastError', 'lastResult', 'roundsSinceCollect', 'totalCollected',
  ]);
  assert.equal(stats.enabled, true);
  assert.equal(stats.lastResult.ok, true);
  assert.equal(stats.totalCollected, 1);
  assert.ok(stats.lastCollectAt > 0);
  assert.equal(stats.lastError, '');
});

test('autoCollect 关闭时只累计轮次、不触发提炼', () => {
  const memoryStore = makeMemoryStore();
  const ctx = makeCtx({ streamFactory: makeJsonStream('{"facts":[]}') });
  const collector = createCollector({
    ctx,
    settings: makeSettings({ autoCollect: { enabled: false, everyRounds: 2 } }),
    memoryStore,
    logger: QUIET_LOGGER,
  });
  collector.noteTurnEnd(record([userMessage('hi')]));
  assert.equal(collector.stats().enabled, false);
  assert.equal(collector.stats().roundsSinceCollect, 1);
  assert.equal(ctx.calls.length, 0);
});

// ── collectNow 解析与保存 ────────────────────────────────────
test('collectNow 容错 markdown 代码块与多余文字，逐条保存事实', async () => {
  const memoryStore = makeMemoryStore();
  const payload = [
    '分析如下：',
    '```json',
    JSON.stringify({
      facts: [
        { text: '用户叫小明', tags: ['称呼'], importance: 'high' },
        { text: '用户喜欢喝美式咖啡', tags: ['偏好'] },
      ],
    }),
    '```',
    '以上。',
  ].join('\n');
  const ctx = makeCtx({ streamFactory: makeJsonStream(payload) });
  const collector = createCollector({
    ctx,
    settings: makeSettings({ autoCollect: { everyRounds: 100 } }),
    memoryStore,
    logger: QUIET_LOGGER,
  });
  const rec = record([
    userMessage('我叫小明'),
    assistantMessage('你好小明'),
    userMessage('我喜欢喝美式咖啡'),
    assistantMessage('记住了'),
  ]);
  const result = await collector.collectNow(rec);

  assert.equal(result.ok, true);
  assert.equal(result.scannedMessages, 4);
  assert.equal(result.added.length, 2);
  assert.deepEqual(memoryStore.saved[0], {
    text: '用户叫小明', tags: ['称呼'], importance: 'high', source: 'auto',
  });
  assert.deepEqual(memoryStore.saved[1], {
    text: '用户喜欢喝美式咖啡', tags: ['偏好'], importance: 'normal', source: 'auto',
  });
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].provider, 'test-provider');
  assert.equal(ctx.calls[0].model, 'test-model');
  assert.ok(Array.isArray(ctx.calls[0].messages) && ctx.calls[0].messages.length === 1);
  assert.equal(collector.stats().totalCollected, 2);
});

test('maxFacts 限制条数、maxFactChars 截断单条', async () => {
  const memoryStore = makeMemoryStore();
  const facts = [];
  for (let i = 0; i < 10; i += 1) facts.push({ text: `第 ${i} 条：${'很长的记忆事实内容'.repeat(8)}` });
  const ctx = makeCtx({ streamFactory: makeJsonStream(JSON.stringify({ facts })) });
  const collector = createCollector({
    ctx,
    settings: makeSettings({ autoCollect: { maxFacts: 3, maxFactChars: 50 } }),
    memoryStore,
    logger: QUIET_LOGGER,
  });
  const result = await collector.collectNow(record([userMessage('随便聊聊')]));
  assert.equal(result.ok, true);
  assert.equal(result.added.length, 3);
  assert.equal(memoryStore.saved.length, 3);
  for (const saved of memoryStore.saved) {
    assert.ok([...saved.text].length <= 50, `事实被截断到 maxFactChars: ${saved.text}`);
  }
});

test('重复事实不计入 added / totalCollected', async () => {
  const memoryStore = makeMemoryStore(['用户叫小明']);
  const payload = JSON.stringify({
    facts: [
      { text: '用户叫小明' },
      { text: '用户住在杭州' },
    ],
  });
  const ctx = makeCtx({ streamFactory: makeJsonStream(payload) });
  const collector = createCollector({
    ctx,
    settings: makeSettings(),
    memoryStore,
    logger: QUIET_LOGGER,
  });
  const result = await collector.collectNow(record([userMessage('我在杭州')]));
  assert.equal(result.ok, true);
  assert.equal(result.added.length, 1);
  assert.equal(memoryStore.saved.length, 1);
  assert.equal(collector.stats().totalCollected, 1);
});

test('JSON 解析失败与模型流异常都只记 stats，不抛出', async () => {
  let call = 0;
  const ctx = makeCtx({
    streamFactory: () => {
      call += 1;
      if (call === 1) return makeJsonStream('这根本不是 JSON')();
      if (call === 2) return makeJsonStream('', { throwError: new Error('network down') })();
      return makeJsonStream(JSON.stringify({ facts: [{ text: '后续成功的事实' }] }))();
    },
  });
  const memoryStore = makeMemoryStore();
  const collector = createCollector({ ctx, settings: makeSettings(), memoryStore, logger: QUIET_LOGGER });
  const rec = record([userMessage('hi')]);

  const bad = await collector.collectNow(rec);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /无法解析/);
  assert.match(collector.stats().lastError, /无法解析/);
  assert.equal(memoryStore.saved.length, 0);

  const boom = await collector.collectNow(rec);
  assert.equal(boom.ok, false);
  assert.match(boom.error, /network down/);
  assert.equal(memoryStore.saved.length, 0);

  const good = await collector.collectNow(rec);
  assert.equal(good.ok, true);
  assert.equal(memoryStore.saved.length, 1);
  assert.equal(collector.stats().lastError, '');
});

test('模型 finish=error / aborted 转为失败结果', async () => {
  const memoryStore = makeMemoryStore();
  const errCtx = makeCtx({
    streamFactory: makeJsonStream('{}', { finishReason: { kind: 'error', failure: { message: 'boom' } } }),
  });
  const c1 = createCollector({ ctx: errCtx, settings: makeSettings(), memoryStore, logger: QUIET_LOGGER });
  const r1 = await c1.collectNow(record([userMessage('hi')]));
  assert.equal(r1.ok, false);
  assert.match(r1.error, /boom/);

  const abortCtx = makeCtx({ streamFactory: makeJsonStream('{}', { finishReason: { kind: 'aborted' } }) });
  const c2 = createCollector({ ctx: abortCtx, settings: makeSettings(), memoryStore, logger: QUIET_LOGGER });
  const r2 = await c2.collectNow(record([userMessage('hi')]));
  assert.equal(r2.ok, false);
  assert.match(r2.error, /中止|超时/);
});

test('in-flight 锁：并发触发返回 skipped，结束后可再次提炼', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  async function* slowStream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    await gate;
    const text = JSON.stringify({ facts: [{ text: '锁测试事实' }] });
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const memoryStore = makeMemoryStore();
  const ctx = makeCtx({ streamFactory: slowStream });
  const collector = createCollector({ ctx, settings: makeSettings(), memoryStore, logger: QUIET_LOGGER });
  const rec = record([userMessage('hi')]);

  const first = collector.collectNow(rec);
  const second = await collector.collectNow(rec);
  assert.equal(second.ok, false);
  assert.equal(second.skipped, true);
  assert.equal(second.added.length, 0);

  release();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(memoryStore.saved.length, 1);

  const third = await collector.collectNow(rec);
  assert.equal(third.ok, true);
  assert.equal(memoryStore.saved.length, 1, '重复事实不再新增');
});

test('collectNow() 无参时使用 noteTurnEnd 记录的 lastRecord', async () => {
  const memoryStore = makeMemoryStore();
  const payload = JSON.stringify({ facts: [{ text: '手动提炼的事实' }] });
  const ctx = makeCtx({ streamFactory: makeJsonStream(payload) });
  const collector = createCollector({
    ctx,
    settings: makeSettings({ autoCollect: { enabled: false } }),
    memoryStore,
    logger: QUIET_LOGGER,
  });
  collector.noteTurnEnd(record([userMessage('记录一下')]));
  const result = await collector.collectNow();
  assert.equal(result.ok, true);
  assert.equal(result.scannedMessages, 1);
  assert.equal(memoryStore.saved[0].text, '手动提炼的事实');
});

test('记忆总开关关闭时 collectNow 直接失败且不调用 LLM', async () => {
  const memoryStore = makeMemoryStore();
  const ctx = makeCtx({ streamFactory: makeJsonStream('{"facts":[]}') });
  const collector = createCollector({
    ctx,
    settings: makeSettings({ enabled: false }),
    memoryStore,
    logger: QUIET_LOGGER,
  });
  collector.noteTurnEnd(record([userMessage('hi')]));
  const result = await collector.collectNow(record([userMessage('hi')]));
  assert.equal(result.ok, false);
  assert.match(result.error, /关闭/);
  assert.equal(ctx.calls.length, 0);
  assert.equal(collector.stats().enabled, false);
});

// ── record 形状兼容 ─────────────────────────────────────────
test('record.session.events / record.agent.session.events / snapshotEvents 都可读取', async () => {
  const events = [
    userMessage('你好', 1),
    assistantMessage('在的', 2),
    { type: 'system/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '系统提示' }] } } },
    { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'image', attachment: {} }], source: { kind: 'user' } } },
    assistantMessage('工具调用', 5),
  ];
  const shapes = [
    { session: { events } },
    { agent: { session: { events } } },
    { session: { snapshotEvents: () => events } },
    { events },
    // 兼容宿主直接把 Session 本体当 record 传进来
    { header: { id: 's1' }, snapshotEvents: () => events },
  ];
  for (const shape of shapes) {
    const memoryStore = makeMemoryStore();
    const payload = JSON.stringify({ facts: [{ text: `形状兼容事实 ${Math.random()}` }] });
    const ctx = makeCtx({ streamFactory: makeJsonStream(payload) });
    const collector = createCollector({ ctx, settings: makeSettings(), memoryStore, logger: QUIET_LOGGER });
    const result = await collector.collectNow(shape);
    assert.equal(result.ok, true);
    assert.equal(result.scannedMessages, 3, '只统计有文本的 user/assistant 消息');
  }
});

test('超过 40 条消息只取最近 40 条，transcript 截断到 12000 字符', async () => {
  const events = [];
  for (let i = 0; i < 50; i += 1) {
    events.push(userMessage(`消息 ${i} ${'x'.repeat(300)}`, i + 1));
  }
  const memoryStore = makeMemoryStore();
  const ctx = makeCtx({ streamFactory: makeJsonStream('{"facts":[]}') });
  const collector = createCollector({
    ctx,
    settings: makeSettings({ autoCollect: { everyRounds: 6 } }),
    memoryStore,
    logger: QUIET_LOGGER,
  });
  const result = await collector.collectNow(record(events));
  assert.equal(result.ok, true);
  assert.equal(result.scannedMessages, 40);
  const prompt = ctx.calls[0].messages[0].content[0].text;
  assert.ok(prompt.includes('消息 49'), '保留最新消息');
  const transcript = prompt.slice(prompt.indexOf('【对话摘录】') + '【对话摘录】'.length).trim();
  assert.ok(transcript.length <= 12000);
});

// ── 模型路由 ─────────────────────────────────────────────────
test('provider/model 为空时回退 agentDefaultModel.currentSelection()', async () => {
  const memoryStore = makeMemoryStore();
  const ctx = makeCtx({
    streamFactory: makeJsonStream('{"facts":[]}'),
    selection: { provider: 'sel-provider', model: 'sel-model' },
  });
  const collector = createCollector({
    ctx,
    settings: makeSettings({ autoCollect: { provider: '', model: '' } }),
    memoryStore,
    logger: QUIET_LOGGER,
  });
  await collector.collectNow(record([userMessage('hi')]));
  assert.equal(ctx.calls[0].provider, 'sel-provider');
  assert.equal(ctx.calls[0].model, 'sel-model');
});

test('getRoute() 优先于默认模型；都为空时报错', async () => {
  const memoryStore = makeMemoryStore();
  const ctx = makeCtx({
    streamFactory: makeJsonStream('{"facts":[]}'),
    selection: { provider: 'sel-provider', model: 'sel-model' },
  });
  const collector = createCollector({
    ctx,
    settings: makeSettings({ autoCollect: { provider: '', model: '' } }),
    memoryStore,
    logger: QUIET_LOGGER,
    getRoute: () => ({ provider: 'route-provider', model: 'route-model' }),
  });
  await collector.collectNow(record([userMessage('hi')]));
  assert.equal(ctx.calls[0].provider, 'route-provider');
  assert.equal(ctx.calls[0].model, 'route-model');

  const noRouteCtx = makeCtx({ streamFactory: makeJsonStream('{"facts":[]}') });
  const c2 = createCollector({
    ctx: noRouteCtx,
    settings: makeSettings({ autoCollect: { provider: '', model: '' } }),
    memoryStore,
    logger: QUIET_LOGGER,
  });
  const result = await c2.collectNow(record([userMessage('hi')]));
  assert.equal(result.ok, false);
  assert.match(result.error, /模型/);
  assert.equal(noRouteCtx.calls.length, 0);
});

test('没有可提炼消息时不调用 LLM', async () => {
  const memoryStore = makeMemoryStore();
  const ctx = makeCtx({ streamFactory: makeJsonStream('{"facts":[]}') });
  const collector = createCollector({ ctx, settings: makeSettings(), memoryStore, logger: QUIET_LOGGER });
  const result = await collector.collectNow(record([]));
  assert.equal(result.ok, false);
  assert.match(result.error, /没有可提炼/);
  assert.equal(ctx.calls.length, 0);
});

// ── memory_* 工具注册/执行（合并测，避免新增独立测试文件） ──
test('registerMemoryTools 注册四个工具且 execute 可用', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-memory-tools-'));
  const dir = path.join(base, 'memory');
  const memoryStore = createMemoryStore({
    settings: { get: () => ({ memory: { enabled: true, dir, injectMaxChars: 4000 } }) },
    logger: QUIET_LOGGER,
  });
  const registered = [];
  const fakeCtx = {
    get(name) {
      if (name === 'tools') {
        return { register(definition) { registered.push(definition); return () => {}; } };
      }
      return undefined;
    },
  };
  const dispose = registerMemoryTools(fakeCtx, memoryStore, QUIET_LOGGER);
  assert.deepEqual(registered.map((d) => d.name).sort(), ['memory_list', 'memory_read', 'memory_save', 'memory_search']);
  for (const definition of registered) {
    assert.equal(typeof definition.description, 'string');
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
  }

  const save = registered.find((d) => d.name === 'memory_save');
  const saved = await save.execute({ content: '用户喜欢猫', tags: ['偏好'], importance: 'high' });
  assert.equal(saved.ok, true);
  assert.equal(saved.duplicate, false);
  assert.match(saved.entry, /用户喜欢猫（#偏好）/);
  const rendered = save.output.render({}, saved);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /已记住/);
  await assert.rejects(() => save.execute({ content: '   ' }), /content/);

  const search = registered.find((d) => d.name === 'memory_search');
  const found = await search.execute({ query: '猫', limit: 5 });
  assert.ok(found.count >= 1);
  assert.equal(found.results[0].file, 'MEMORY.md');
  assert.match(search.output.render({}, found)[0].text, /找到/);
  await assert.rejects(() => search.execute({ query: '' }), /query/);

  const read = registered.find((d) => d.name === 'memory_read');
  const readOut = await read.execute({});
  assert.ok(readOut.text.includes('用户喜欢猫'));
  const list = registered.find((d) => d.name === 'memory_list');
  const listOut = await list.execute({});
  assert.ok(listOut.files.some((f) => f.name === 'MEMORY.md'));
  assert.ok(listOut.totalChars > 0);

  assert.doesNotThrow(() => dispose());
  fs.rmSync(base, { recursive: true, force: true });
});

test('registerMemoryTools 在 tools 服务缺失时只告警不抛错', () => {
  const logger = quietLoggerSink();
  const missing = {
    get() { return undefined; },
  };
  const dispose = registerMemoryTools(missing, { saveFact() {} }, logger);
  assert.equal(typeof dispose, 'function');
  assert.ok(logger.sink.warns.some((line) => line.includes('tools 服务不可用')));
  assert.doesNotThrow(() => dispose());

  // 宿主 get('tools') 直接抛错也不能打挂启动
  const throwing = { get() { throw new Error('service broken'); } };
  const logger2 = quietLoggerSink();
  assert.doesNotThrow(() => registerMemoryTools(throwing, { saveFact() {} }, logger2));
  assert.ok(logger2.sink.warns.some((line) => line.includes('异常')));
});
