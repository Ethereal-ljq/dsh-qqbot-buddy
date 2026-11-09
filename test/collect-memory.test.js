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

function makeCollector({ memory, db, oneShot, logger, ...rest }) {
  return createMemoryCollector({ memory, db, oneShot: oneShot || fakeOneShot(oneFact), logger: logger || fakeLogger(), ...rest });
}

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
