import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, get, run } from '../lib/core/db.js';
import { createMemoryStore } from '../lib/core/memory/store.js';
import {
  COLLECT_SOURCE,
  JOB_NAME,
  MAX_FACT_TEXT_CHARS,
  TRANSCRIPT_MAX_CHARS,
  buildCollectPrompt,
  createMemoryCollector,
  parseFacts,
  readMemorySettings,
  tailTranscript,
} from '../lib/core/memory/collect.js';

const FENCE = String.fromCharCode(96).repeat(3);

/* ------------------------------ 测试脚手架 ------------------------------ */

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-collect-'));
  const db = openDb(path.join(dir, 'test.db'));
  const now = Date.now();
  for (const id of ['bot-a', 'bot-b']) {
    run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', id, id, now, now);
  }
  t.after(() => closeDb(db));
  const memory = createMemoryStore({ db });
  const log = fakeLogger();
  return { db, memory, log };
}

function fakeLogger() {
  const warns = [];
  return {
    warns,
    warn(message) { warns.push(String(message)); },
    info() {},
    debug() {},
    error(message) { warns.push(String(message)); },
  };
}

function fakeOneShot(handler = () => ({ ok: true, text: '' })) {
  const calls = [];
  return {
    calls,
    async generate(args) {
      calls.push(args);
      return handler(args);
    },
  };
}

const oneFact = () => ({ ok: true, text: '{"text":"用户喜欢猫","kind":"preference"}' });

/** 旁路 LLM 必须带 provider/model（否则 llm 服务报 NO_ADAPTER）——测试统一注入。 */
const TEST_ROUTE = { provider: 'test-provider', model: 'test-model' };

/** 伪 agent：让 resolveRecordRoute 能拿到「最近一次请求的路由」。 */
function fakeAgentWithRoute() {
  return {
    session: {
      requestHeader: () => ({ config: { ...TEST_ROUTE } }),
    },
  };
}

/**
 * 测试用 collector 包装：自动补 route / record.agent。
 * 生产里 route 来自 record.agent.session.requestHeader()（这次对话真实用过的），
 * 测试里没有真实 agent，这里统一注入，避免 34 处调用点逐条改。
 */
function makeCollector({ memory, db, oneShot, logger, ...rest }) {
  const inner = createMemoryCollector({ memory, db, oneShot: oneShot || fakeOneShot(oneFact), logger: logger || fakeLogger(), ...rest });
  return {
    ...inner,
    maybeCollect: (args = {}) => inner.maybeCollect({ route: TEST_ROUTE, ...args }),
    collectNow: (args = {}) => inner.collectNow({ route: TEST_ROUTE, ...args }),
    noteTurnEnd: (record, extra) => {
      const withAgent = record && typeof record === 'object' && !record.agent
        ? { ...record, agent: fakeAgentWithRoute() }
        : record;
      return inner.noteTurnEnd(withAgent, extra);
    },
  };
}

/* ------------------------------ record.settings 形态兼容（回归） ------------------------------ */

test('record.settings 是函数时也要生效（BotRuntime 的真实形态）', async (t) => {
  // 回归：以前用 typeof record.settings === 'object' 判断，函数形态被整个丢弃，
  // 导致 settings.memory.autoExtractEvery 永远读不到、只能吃默认值 10。
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  const collector = makeCollector({ memory, db, oneShot });
  const record = {
    botId: 'bot-a',
    peer: 'c2c:user-1',
    // 关键：函数形态（与 BotRuntime 的 settings: () => self.settingsFor(peer) 一致）
    settings: () => ({ memory: { enabled: true, autoExtractEvery: 3 } }),
    turn: { current: { text: '' } },
  };
  for (let i = 0; i < 3; i++) {
    record.turn.current.text = '第' + i + '句';
    collector.noteTurnEnd(record, { transcript: '用户: 第' + i + '句' });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await collector.whenIdle?.();
  await new Promise((resolve) => setTimeout(resolve, 150));
  // 阈值 3：3 轮就该触发一次；若是旧 bug（阈值被当成 10），这里会是 0
  assert.equal(oneShot.calls.length, 1, 'record.settings 为函数时 autoExtractEvery 必须生效');
});

test('resolveRecordSettings 兼容函数 / 对象 / 抛错 / 缺失四种形态', async () => {
  const { resolveRecordSettings } = await import('../lib/core/memory/collect.js');
  const bag = { memory: { enabled: false } };
  assert.deepEqual(resolveRecordSettings({ settings: () => bag }), bag);
  assert.deepEqual(resolveRecordSettings({ settings: bag }), bag);
  assert.equal(resolveRecordSettings({ settings: () => { throw new Error('boom'); } }), undefined);
  assert.equal(resolveRecordSettings({}), undefined);
  assert.equal(resolveRecordSettings(null), undefined);
  // 函数返回非对象时也当没设置
  assert.equal(resolveRecordSettings({ settings: () => 'nope' }), undefined);
});

/* ------------------------------ 失败可观测性（P0） ------------------------------ */

test('提炼成功时状态记录 outcome=saved 并清零 failureCount', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  const collector = makeCollector({ memory, db, oneShot });
  await collector.collectNow({ botId: 'bot-a', peer: 'c2c:u1', transcript: '用户: 我喜欢猫' });
  const state = collector.getState({ botId: 'bot-a', peer: 'c2c:u1' });
  assert.equal(state.lastOutcome, 'saved');
  assert.equal(state.lastSaved, 1);
  assert.equal(state.failureCount, 0);
});

test('模型失败时状态记录 outcome=llm-error 并累加 failureCount', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(() => ({ ok: false, error: '模型炸了' }));
  const collector = makeCollector({ memory, db, oneShot });
  await collector.collectNow({ botId: 'bot-a', peer: 'c2c:u2', transcript: '用户: 随便说点' });
  const state = collector.getState({ botId: 'bot-a', peer: 'c2c:u2' });
  assert.equal(state.lastOutcome, 'llm-error');
  assert.match(state.lastReason, /模型炸了/);
  assert.equal(state.failureCount, 1);
});

test('解析为空时状态记录 outcome=parse-empty（能区分「跑了没产出」）', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(() => ({ ok: true, text: '这句不是 JSON' }));
  const collector = makeCollector({ memory, db, oneShot });
  await collector.collectNow({ botId: 'bot-a', peer: 'c2c:u3', transcript: '用户: 随便说点' });
  const state = collector.getState({ botId: 'bot-a', peer: 'c2c:u3' });
  assert.equal(state.lastOutcome, 'parse-empty');
  assert.equal(state.lastFacts, 0);
});

test('转录为空时写状态并产生 warn 日志（以前完全静默）', async (t) => {
  const { memory, db, log } = setup(t);
  // 必须显式注入 logger：makeCollector 默认会自己造一个 fakeLogger，拿不到这里的 log
  const collector = createMemoryCollector({ memory, db, oneShot: fakeOneShot(oneFact), logger: log });
  await collector.collectNow({ botId: 'bot-a', peer: 'c2c:u4', transcript: '   ' });
  const state = collector.getState({ botId: 'bot-a', peer: 'c2c:u4' });
  assert.equal(state.lastOutcome, 'empty-transcript');
  assert.ok(log.warns.some((line) => line.includes('转录为空')), '空转录必须留下日志，实际: ' + JSON.stringify(log.warns));
});

test('全部命中近似去重时状态记录 outcome=all-deduped', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(() => ({ ok: true, text: '{"text":"用户喜欢猫","kind":"preference"}' }));
  const collector = makeCollector({ memory, db, oneShot });
  await collector.collectNow({ botId: 'bot-a', peer: 'c2c:u5', transcript: '用户: 我喜欢猫' });
  await collector.collectNow({ botId: 'bot-a', peer: 'c2c:u5', transcript: '用户: 我喜欢猫' });
  const state = collector.getState({ botId: 'bot-a', peer: 'c2c:u5' });
  assert.equal(state.lastOutcome, 'all-deduped');
  assert.match(state.lastReason, /命中已有记忆/);
});

/* ------------------------------ 转录来源：消息流水优先 ------------------------------ */

test('装配 messages store 时，转录从消息库取（跨重启、含助手回复）', async (t) => {
  const { memory, db } = setup(t);
  const { createMessagesStore } = await import('../lib/core/messages/store.js');
  const messages = createMessagesStore({ db });
  messages.save({ botId: 'bot-a', peer: 'group:db', senderId: 'S1', senderName: '朝咱', role: 'user', content: '这个泡馍店也太会做生意了', messageId: 'd1' });
  messages.save({ botId: 'bot-a', peer: 'group:db', role: 'assistant', content: '糖蒜两块钱挺气人', messageId: 'd2' });

  const oneShot = fakeOneShot(oneFact);
  const collector = createMemoryCollector({
    memory, db, oneShot, messages, logger: fakeLogger(),
  });
  await collector.maybeCollect({ botId: 'bot-a', peer: 'group:db', transcript: '这段不该被用', route: TEST_ROUTE, rounds: 10 });
  const prompt = oneShot.calls[0].prompt;
  assert.match(prompt, /朝咱: 这个泡馍店/, '应从消息库取用户侧消息');
  assert.match(prompt, /助手: 糖蒜两块钱挺气人/, '应从消息库取助手侧消息');
  assert.doesNotMatch(prompt, /这段不该被用/, '有消息库时不该用传入的内存转录');
});

test('消息库为空时回退到传入的 transcript（不因装配了 store 就丢数据）', async (t) => {
  const { memory, db } = setup(t);
  const { createMessagesStore } = await import('../lib/core/messages/store.js');
  const messages = createMessagesStore({ db });
  const oneShot = fakeOneShot(oneFact);
  const collector = createMemoryCollector({ memory, db, oneShot, messages, logger: fakeLogger() });
  await collector.maybeCollect({ botId: 'bot-a', peer: 'group:empty', transcript: '用户: 内存里的转录', route: TEST_ROUTE, rounds: 10 });
  assert.match(oneShot.calls[0].prompt, /内存里的转录/);
});

/* ------------------------------ 模型路由（NO_ADAPTER 回归） ------------------------------ */

test('resolveRecordRoute：从 agent.session.requestHeader 读出这次对话真实用过的路由', async () => {
  const { resolveRecordRoute } = await import('../lib/core/memory/collect.js');
  const record = {
    agent: { session: { requestHeader: () => ({ config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }) } },
  };
  assert.deepEqual(resolveRecordRoute(record), { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
});

test('resolveRecordRoute：拿不到时返回 null（不抛）', async () => {
  const { resolveRecordRoute } = await import('../lib/core/memory/collect.js');
  assert.equal(resolveRecordRoute(null), null);
  assert.equal(resolveRecordRoute({}), null);
  assert.equal(resolveRecordRoute({ agent: {} }), null);
  assert.equal(resolveRecordRoute({ agent: { session: {} } }), null);
  // requestHeader 返回不完整配置
  assert.equal(resolveRecordRoute({ agent: { session: { requestHeader: () => ({ config: { provider: 'x' } }) } } }), null);
  // requestHeader 抛错
  assert.equal(resolveRecordRoute({ agent: { session: { requestHeader: () => { throw new Error('boom'); } } } }), null);
});

test('normalizeRoute：provider 与 model 必须同时非空', async () => {
  const { normalizeRoute } = await import('../lib/core/memory/collect.js');
  assert.deepEqual(normalizeRoute({ provider: ' p ', model: ' m ' }), { provider: 'p', model: 'm' });
  assert.equal(normalizeRoute({ provider: 'p' }), null);
  assert.equal(normalizeRoute({ model: 'm' }), null);
  assert.equal(normalizeRoute({ provider: '', model: 'm' }), null);
  assert.equal(normalizeRoute(null), null);
});

test('oneShot 必须收到 provider/model（否则线上报 no adapter registered）', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  const collector = makeCollector({ memory, db, oneShot });
  await collector.collectNow({ botId: 'bot-a', peer: 'c2c:u1', transcript: '用户: 我喜欢猫' });
  assert.equal(oneShot.calls.length, 1);
  assert.equal(oneShot.calls[0].provider, TEST_ROUTE.provider, 'provider 必须透传给 oneShot');
  assert.equal(oneShot.calls[0].model, TEST_ROUTE.model, 'model 必须透传给 oneShot');
});

test('完全没有路由时不发请求，记 no-route 并给出可操作提示', async (t) => {
  const { memory, db, log } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  // 绕过包装器，直接测「既没 route 又没 settings.model」的情况
  const inner = createMemoryCollector({ memory, db, oneShot, logger: log });
  const result = await inner.collectNow({ botId: 'bot-a', peer: 'c2c:u9', transcript: '用户: 随便' });
  assert.equal(result.reason, 'no-route');
  assert.equal(oneShot.calls.length, 0, '没有路由时不该发请求（避免必然失败的 NO_ADAPTER）');
  const state = inner.getState({ botId: 'bot-a', peer: 'c2c:u9' });
  assert.equal(state.lastOutcome, 'no-route');
  assert.match(state.lastReason, /provider/);
  assert.ok(log.warns.some((w) => w.includes('未配置模型路由')));
});

test('没有 live agent 时回落到设置里的 model.provider/model.model', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  const inner = createMemoryCollector({ memory, db, oneShot, logger: fakeLogger() });
  const result = await inner.collectNow({
    botId: 'bot-a',
    peer: 'c2c:u-settings',
    transcript: '用户: 我喜欢猫',
    settings: { model: { provider: 'from-settings', model: 'model-x' } },
  });
  assert.equal(result.ok, true);
  assert.equal(oneShot.calls[0].provider, 'from-settings');
  assert.equal(oneShot.calls[0].model, 'model-x');
});

/* ------------------------------ 触发规则 ------------------------------ */

test('autoExtractEvery=0 时自动提炼关闭（不调模型）', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  const collector = makeCollector({ memory, db, oneShot });
  const result = await collector.maybeCollect({
    botId: 'bot-a', peer: 'group:1', transcript: '用户喜欢猫',
    rounds: 1, settings: { memory: { autoExtractEvery: 0 } },
  });
  assert.equal(result.triggered, false);
  assert.equal(result.reason, 'auto-disabled');
  assert.equal(oneShot.calls.length, 0);
});

test('memory.enabled=false 时完全不计数不提炼', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  const collector = makeCollector({ memory, db, oneShot });
  const result = await collector.maybeCollect({
    botId: 'bot-a', peer: 'group:1', transcript: '用户喜欢猫',
    rounds: 5, settings: { memory: { enabled: false, autoExtractEvery: 1 } },
  });
  assert.equal(result.triggered, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(collector.getRounds({ botId: 'bot-a', peer: 'group:1' }), 0);
});

test('未达阈值只累加轮次，达到阈值触发一次并清零', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  const collector = makeCollector({ memory, db, oneShot });
  const settings = { memory: { autoExtractEvery: 3 } };

  const first = await collector.maybeCollect({ botId: 'bot-a', peer: 'group:1', transcript: '第一轮对话', settings });
  const second = await collector.maybeCollect({ botId: 'bot-a', peer: 'group:1', transcript: '第二轮对话', settings });
  assert.equal(first.triggered, false);
  assert.equal(first.reason, 'below-threshold');
  assert.equal(second.rounds, 2);
  assert.equal(collector.getRounds({ botId: 'bot-a', peer: 'group:1' }), 2);
  assert.equal(oneShot.calls.length, 0);

  const third = await collector.maybeCollect({ botId: 'bot-a', peer: 'group:1', transcript: '第三轮对话', settings });
  assert.equal(third.triggered, true);
  assert.equal(third.rounds, 0);
  assert.equal(third.result.ok, true);
  assert.equal(third.result.facts, 1);
  assert.equal(third.result.created, 1);
  assert.equal(oneShot.calls.length, 1);
  assert.equal(collector.getRounds({ botId: 'bot-a', peer: 'group:1' }), 0);

  const memories = memory.list({ botId: 'bot-a' });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].text, '用户喜欢猫');
  assert.equal(memories[0].kind, 'preference');
  assert.equal(memories[0].source, COLLECT_SOURCE);
  assert.equal(memories[0].peer, 'group:1');
});

test('轮次计数持久化到 job_state：换一个 collector 实例继续累计', async (t) => {
  const { memory, db } = setup(t);
  const settings = { memory: { autoExtractEvery: 3 } };
  const first = makeCollector({ memory, db });
  await first.maybeCollect({ botId: 'bot-a', peer: 'group:1', transcript: '对话1', settings });
  await first.maybeCollect({ botId: 'bot-a', peer: 'group:1', transcript: '对话2', settings });

  const row = get(db, 'SELECT value FROM job_state WHERE bot_id = ? AND peer = ? AND job = ?', 'bot-a', 'group:1', JOB_NAME);
  assert.ok(row, 'job_state 应已写入');
  assert.equal(JSON.parse(row.value).rounds, 2);

  const oneShot = fakeOneShot(oneFact);
  const second = makeCollector({ memory, db, oneShot });
  const third = await second.maybeCollect({ botId: 'bot-a', peer: 'group:1', transcript: '对话3', settings });
  assert.equal(third.triggered, true, '新实例应接着持久化的轮次计数触发');
  assert.equal(oneShot.calls.length, 1);
  const after = get(db, 'SELECT value FROM job_state WHERE bot_id = ? AND peer = ? AND job = ?', 'bot-a', 'group:1', JOB_NAME);
  assert.equal(JSON.parse(after.value).rounds, 0);
});

test('不同 peer / 不同 bot 的轮次互相隔离', async (t) => {
  const { memory, db } = setup(t);
  const settings = { memory: { autoExtractEvery: 2 } };
  const collector = makeCollector({ memory, db });
  await collector.maybeCollect({ botId: 'bot-a', peer: 'group:1', transcript: 'A', settings });
  assert.equal(collector.getRounds({ botId: 'bot-a', peer: 'group:1' }), 1);
  assert.equal(collector.getRounds({ botId: 'bot-a', peer: 'group:2' }), 0);
  assert.equal(collector.getRounds({ botId: 'bot-b', peer: 'group:1' }), 0);
});

test('collectNow 手动触发忽略轮次与 autoExtractEvery=0', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  const collector = makeCollector({ memory, db, oneShot });
  for (let i = 0; i < 5; i += 1) {
    await collector.maybeCollect({
      botId: 'bot-a', peer: 'group:1', transcript: '对话' + i,
      settings: { memory: { autoExtractEvery: 0 } },
    });
  }
  const result = await collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript: '手动触发用的对话' });
  assert.equal(result.ok, true);
  assert.equal(result.saved, 1);
  assert.equal(oneShot.calls.length, 1);
  assert.equal(memory.list({ botId: 'bot-a' }).length, 1);
  assert.equal(collector.getRounds({ botId: 'bot-a', peer: 'group:1' }), 0);
});

/* ------------------------------ 失败降级 ------------------------------ */

test('模型失败只 warn 不抛，轮次已清零不连环重试', async (t) => {
  const { memory, db, log } = setup(t);
  const oneShot = fakeOneShot(() => ({ ok: false, error: 'llm boom' }));
  const collector = makeCollector({ memory, db, oneShot, logger: log });
  const result = await collector.maybeCollect({
    botId: 'bot-a', peer: 'group:1', transcript: '用户喜欢猫',
    settings: { memory: { autoExtractEvery: 1 } },
  });
  assert.equal(result.triggered, true);
  assert.equal(result.result.ok, false);
  assert.match(result.result.error, /boom/);
  assert.equal(memory.list({ botId: 'bot-a' }).length, 0);
  assert.equal(collector.getRounds({ botId: 'bot-a', peer: 'group:1' }), 0);
  assert.ok(log.warns.some((line) => /记忆提炼失败/.test(line)), '应记录 warn');
});

test('模型输出不是 JSON 时降级为空，不入库也不抛', async (t) => {
  const { memory, db, log } = setup(t);
  const oneShot = fakeOneShot(() => ({ ok: true, text: '这不是 JSON，只是一段解释。' }));
  const collector = makeCollector({ memory, db, oneShot, logger: log });
  const result = await collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript: '对话内容' });
  assert.equal(result.ok, true);
  assert.equal(result.facts, 0);
  assert.equal(result.saved, 0);
  assert.equal(memory.list({ botId: 'bot-a' }).length, 0);
  assert.ok(log.warns.some((line) => /解析为空/.test(line)));
});

test('oneShot 抛异常时被捕获并降级', async (t) => {
  const { memory, db, log } = setup(t);
  const oneShot = fakeOneShot(() => { throw new Error('network down'); });
  const collector = makeCollector({ memory, db, oneShot, logger: log });
  const result = await collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript: '对话' });
  assert.equal(result.ok, false);
  assert.match(result.error, /network down/);
  assert.ok(log.warns.length > 0);
});

test('超过超时时间会中止并返回错误，不挂起', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(() => new Promise(() => { /* 永不返回 */ }));
  const collector = makeCollector({ memory, db, oneShot, timeoutMs: 30 });
  const result = await collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript: '对话' });
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
});

/* ------------------------------ 解析与去重 ------------------------------ */

test('解析代码块/JSON 数组/kind 别名，并做批内去重', async (t) => {
  const { memory, db } = setup(t);
  const text = [
    FENCE + 'json',
    '[{"text":"用户喜欢猫","kind":"preference"},',
    ' {"text":"用户住在杭州","kind":"fact"},',
    ' {"text":"用户住在杭州","kind":"fact"}]',
    FENCE,
  ].join('\n');
  const oneShot = fakeOneShot(() => ({ ok: true, text }));
  const collector = makeCollector({ memory, db, oneShot });
  const result = await collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript: '对话' });
  assert.equal(result.ok, true);
  assert.equal(result.facts, 2, '重复事实批内去重');
  assert.equal(result.created, 2);
  const list = memory.list({ botId: 'bot-a' });
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((row) => row.text).sort(), ['用户住在杭州', '用户喜欢猫']);
});

test('解析失败条目被丢弃，正常条目继续入库（kind 归一化）', async (t) => {
  const { memory, db } = setup(t);
  const text = [
    '- {"text":"用户喜欢猫","kind":"unknown_kind"}',
    '- 这一行不是 JSON',
    '- {"text":"","kind":"fact"}',
    '- {"text":"项目周五上线","kind":"event"}',
  ].join('\n');
  const oneShot = fakeOneShot(() => ({ ok: true, text }));
  const collector = makeCollector({ memory, db, oneShot });
  const result = await collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript: '对话' });
  assert.equal(result.ok, true);
  assert.equal(result.facts, 2);
  const list = memory.list({ botId: 'bot-a' });
  assert.equal(list.length, 2);
  const kinds = Object.fromEntries(list.map((row) => [row.text, row.kind]));
  assert.equal(kinds['用户喜欢猫'], 'fact');
  assert.equal(kinds['项目周五上线'], 'event');
});

test('同一条记忆已存在时走近似去重，只刷新不新增', async (t) => {
  const { memory, db } = setup(t);
  memory.save({ botId: 'bot-a', peer: 'group:1', text: '用户喜欢猫' });
  const oneShot = fakeOneShot(oneFact);
  const collector = makeCollector({ memory, db, oneShot });
  const result = await collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript: '对话' });
  assert.equal(result.ok, true);
  assert.equal(result.created, 0);
  assert.equal(result.deduped, 1);
  assert.equal(memory.list({ botId: 'bot-a' }).length, 1);
});

test('parseFacts 纯函数：数组 / facts 包装 / 超长截断 / 条数上限', () => {
  assert.deepEqual(parseFacts('{"text":"单条事实","kind":"fact"}'), [{ text: '单条事实', kind: 'fact' }]);
  assert.deepEqual(parseFacts('{"facts":[{"text":"甲方周五验收","kind":"event"}]}'), [{ text: '甲方周五验收', kind: 'event' }]);
  const long = '很'.repeat(MAX_FACT_TEXT_CHARS + 50);
  const truncated = parseFacts(JSON.stringify({ text: long, kind: 'fact' }));
  assert.equal(truncated.length, 1);
  assert.equal([...truncated[0].text].length, MAX_FACT_TEXT_CHARS);

  const many = Array.from({ length: 20 }, (unused, index) => ({ text: '事实' + index, kind: 'fact' }));
  assert.equal(parseFacts(JSON.stringify(many)).length, 8, '最多 8 条');
  assert.deepEqual(parseFacts(''), []);
  assert.deepEqual(parseFacts(FENCE), []);
});

/* ------------------------------ 转录/提示词/设置 ------------------------------ */

test('转录尾截断：保留最近内容并标注省略', () => {
  const transcript = '开头标记' + '旧'.repeat(7000) + '最近的关键约定';
  const clipped = tailTranscript(transcript, TRANSCRIPT_MAX_CHARS);
  assert.ok(clipped.length <= TRANSCRIPT_MAX_CHARS + 10);
  assert.match(clipped, /前文已截断/);
  assert.ok(clipped.endsWith('最近的关键约定'));
  assert.ok(!clipped.includes('开头标记'), '早期内容应被丢弃');
  assert.equal(tailTranscript('', 6000), '');
  assert.equal(tailTranscript('短', 6000), '短');

  const prompt = buildCollectPrompt(clipped);
  assert.match(prompt, /最近的关键约定/);
  assert.match(prompt, /kind 只能取/);
});

test('实际调用模型的 prompt 使用尾截断后的转录，并带 maxTokens 预算', async (t) => {
  const { memory, db } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  const collector = makeCollector({ memory, db, oneShot, maxTokens: 512 });
  const transcript = '旧'.repeat(7000) + '末尾关键事实';
  await collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript });
  assert.equal(oneShot.calls.length, 1);
  const args = oneShot.calls[0];
  assert.match(args.prompt, /末尾关键事实/);
  assert.ok(args.prompt.length < 7000, 'prompt 不应包含完整 7000 字转录');
  assert.equal(args.maxTokens, 512);
  assert.ok(typeof args.system === 'string' && args.system.length > 0);
  assert.ok(args.signal, '应传入 AbortSignal');
});

test('readMemorySettings 兼容嵌套 / 扁平 / config-store 三种 settings', () => {
  assert.deepEqual(readMemorySettings({ memory: { autoExtractEvery: 5, enabled: false } }), { enabled: false, autoExtractEvery: 5 });
  assert.deepEqual(readMemorySettings({ 'memory.autoExtractEvery': 3 }), { enabled: true, autoExtractEvery: 3 });
  const storeLike = { getEffectiveSettings: () => ({ memory: { autoExtractEvery: 2 } }) };
  assert.deepEqual(readMemorySettings(storeLike, { botId: 'bot-a', peer: 'group:1' }), { enabled: true, autoExtractEvery: 2 });
  assert.deepEqual(readMemorySettings(undefined), { enabled: true, autoExtractEvery: 10 });
});

/* ------------------------------ 并发锁与兼容钩子 ------------------------------ */

test('并发锁：同 bot+peer 同时只跑一个提炼', async (t) => {
  const { memory, db } = setup(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const oneShot = fakeOneShot(async () => {
    await gate;
    return oneFact();
  });
  const collector = makeCollector({ memory, db, oneShot });
  const running = collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript: '第一段对话' });
  assert.equal(collector.isBusy('bot-a', 'group:1'), true);
  const second = await collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript: '第二段对话' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy');
  release();
  const first = await running;
  assert.equal(first.ok, true);
  assert.equal(collector.isBusy('bot-a', 'group:1'), false);

  const other = await collector.collectNow({ botId: 'bot-a', peer: 'group:2', transcript: '别的对话' });
  assert.equal(other.ok, true);
});

test('noteTurnEnd 兼容 qq/outbound 的 turn/end 钩子', async (t) => {
  const { memory, db, log } = setup(t);
  const oneShot = fakeOneShot(oneFact);
  const collector = makeCollector({ memory, db, oneShot, logger: log });
  const record = {
    peer: 'group:1',
    botId: 'bot-a',
    settings: { memory: { autoExtractEvery: 1 } },
    turn: { current: { text: '我最近开始养猫了' } },
  };
  collector.noteTurnEnd(record);
  await collector.whenIdle();
  assert.equal(oneShot.calls.length, 1);
  assert.match(oneShot.calls[0].prompt, /我最近开始养猫了/);
  assert.equal(memory.list({ botId: 'bot-a' }).length, 1);

  assert.doesNotThrow(() => collector.noteTurnEnd({ peer: 'group:1', turn: { current: { text: 'x' } } }));
  await collector.whenIdle();
});

test('参数缺失返回 invalid-args 而不是抛错', async (t) => {
  const { memory, db } = setup(t);
  const collector = makeCollector({ memory, db });
  const maybe = await collector.maybeCollect({ peer: 'group:1', transcript: 'x' });
  assert.equal(maybe.triggered, false);
  assert.equal(maybe.reason, 'invalid-args');
  const manual = await collector.collectNow({ botId: 'bot-a', transcript: 'x' });
  assert.equal(manual.ok, false);
  assert.equal(manual.reason, 'invalid-args');
  const empty = await collector.collectNow({ botId: 'bot-a', peer: 'group:1', transcript: '   ' });
  assert.equal(empty.reason, 'empty-transcript');
});

test('工厂校验：缺 memory / oneShot 直接抛 TypeError', () => {
  assert.throws(() => createMemoryCollector({ oneShot: fakeOneShot() }), TypeError);
  assert.throws(() => createMemoryCollector({ memory: { save() {} } }), TypeError);
});
