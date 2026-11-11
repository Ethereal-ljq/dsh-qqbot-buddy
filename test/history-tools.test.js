/**
 * history-tools —— 模型侧的 chat_history_search / chat_history_recent。
 *
 * 背景：模型原本只能看到 SDK 内存里的最近 20 条（重启即丢），
 * 被问「上次说的那个」时只能瞎猜。这两个工具让它能主动查原始消息记录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDb, migrate, openDb } from '../lib/core/db.js';
import { createMessagesStore } from '../lib/core/messages/store.js';
import { buildHistoryTools } from '../lib/tools/history-tools.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-history-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  t.after(() => closeDb(db));
  const messages = createMessagesStore({ db });
  const base = Date.now();
  messages.save({ botId: 'bot-a', peer: 'group:G1', scope: 'group', senderId: 'S1', senderName: '朝咱', content: '这个泡馍店也太会做生意了', messageId: 'm1', createdAt: base - 3000 });
  messages.save({ botId: 'bot-a', peer: 'group:G1', scope: 'group', senderId: 'S2', senderName: '院', content: '我是单独加的糖蒜', messageId: 'm2', createdAt: base - 2000 });
  messages.save({ botId: 'bot-a', peer: 'c2c:U1', scope: 'c2c', senderId: 'U1', senderName: '群主', content: '私聊里说的话', messageId: 'm3', createdAt: base - 1000 });
  return { messages, tools: buildHistoryTools({ messages, botId: 'bot-a', resolvePeer: () => 'group:G1' }) };
}

const toolOf = (tools, name) => tools.find((t) => t.name === name);

test('构造出两个工具：chat_history_search / chat_history_recent', (t) => {
  const { tools } = setup(t);
  assert.deepEqual(tools.map((x) => x.name), ['chat_history_search', 'chat_history_recent']);
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.parameters.type, 'object');
  }
});

test('chat_history_search：关键词跨会话检索', async (t) => {
  const { tools } = setup(t);
  const result = await toolOf(tools, 'chat_history_search').execute({ query: '糖蒜' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].who, '院');
  assert.match(result.results[0].text, /糖蒜/);
});

test('chat_history_search：peer 限定会话', async (t) => {
  const { tools } = setup(t);
  const all = await toolOf(tools, 'chat_history_search').execute({});
  assert.equal(all.results.length, 3, '不传 peer 时应跨会话');
  const scoped = await toolOf(tools, 'chat_history_search').execute({ peer: 'c2c:U1' });
  assert.equal(scoped.results.length, 1);
  assert.equal(scoped.results[0].peer, 'c2c:U1');
});

test('chat_history_search：sender 按昵称过滤（非 openid 形态）', async (t) => {
  const { tools } = setup(t);
  const result = await toolOf(tools, 'chat_history_search').execute({ sender: '朝咱' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].who, '朝咱');
});

test('chat_history_search：sender 是 openid 时按 senderId 精确过滤', async (t) => {
  const { tools } = setup(t);
  // S2 不是合法 openid 形态（太短），所以这里用 fetch 出来的真实长串来验证分支
  const { messages } = setup(t);
  messages.save({ botId: 'bot-a', peer: 'group:G1', senderId: '66C13BA866464A969A81769F7003F40B', senderName: '院', content: '院的新消息', messageId: 'm9' });
  const tools2 = buildHistoryTools({ messages, botId: 'bot-a' });
  const result = await toolOf(tools2, 'chat_history_search').execute({ sender: '66C13BA866464A969A81769F7003F40B' });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].who, '院');
});

test('chat_history_search：since 支持相对时间（2h / 3d）', async (t) => {
  const { messages } = setup(t);
  messages.save({ botId: 'bot-a', peer: 'group:G1', senderName: '老消息', content: '十天前说的话', messageId: 'm-old', createdAt: Date.now() - 10 * 86400000 });
  const tools = buildHistoryTools({ messages, botId: 'bot-a' });
  const recent = await toolOf(tools, 'chat_history_search').execute({ since: '1d' });
  assert.ok(recent.results.every((r) => r.who !== '老消息'), '1 天内不应包含十天前的消息');
  const all = await toolOf(tools, 'chat_history_search').execute({});
  assert.ok(all.results.some((r) => r.who === '老消息'), '不限时间时应包含');
});

test('chat_history_recent：默认用当前会话，越往下越新', async (t) => {
  const { tools } = setup(t);
  const result = await toolOf(tools, 'chat_history_recent').execute({});
  assert.equal(result.peer, 'group:G1', '未显式传 peer 时应回落到当前会话');
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[0], /泡馍/, '最早的在前面');
  assert.match(result.messages[1], /糖蒜/);
});

test('chat_history_recent：无法确定会话时报可读错误', async (t) => {
  const { messages } = setup(t);
  const tools = buildHistoryTools({ messages, botId: 'bot-a' }); // 没有 resolvePeer
  await assert.rejects(
    () => toolOf(tools, 'chat_history_recent').execute({}),
    /无法确定当前会话/,
  );
});

test('store 未装配时 createDataTools 不注册历史工具（降级不报错）', async () => {
  const { createDataTools } = await import('../lib/tools/data-tools.js');
  const without = createDataTools({ memory: null, kb: null, members: null, messages: null, botId: 'bot-a' });
  assert.deepEqual(without, [], 'store 全缺时不应注册任何数据工具');

  // 只有 messages、其它 store 缺失时，只注册历史工具
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-history-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  try {
    const messages = createMessagesStore({ db });
    const only = createDataTools({ memory: null, kb: null, members: null, messages, botId: 'bot-a' });
    assert.deepEqual(only.map((x) => x.name).sort(), ['chat_history_recent', 'chat_history_search']);
  } finally {
    closeDb(db);
  }
});
