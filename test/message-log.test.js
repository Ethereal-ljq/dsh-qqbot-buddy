/**
 * message-log —— 入站消息落库的适配层。
 *
 * 重点：
 *   - 群聊正文开头的 [昵称 (openid)] 标签要剥掉（senderName 已单独成列，否则 transcript 重复）；
 *   - 引用块 / 历史块里的标签**不能**剥（那是多人的上下文）；
 *   - store 缺失 / 写失败时静默降级，绝不影响回复链路。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDb, migrate, openDb } from '../lib/core/db.js';
import { createMessagesStore } from '../lib/core/messages/store.js';
import { appendAssistantRecord, appendMessageRecord } from '../lib/qq/message-log.js';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-msglog-'));
  const db = openDb(path.join(dir, 'test.db'));
  migrate(db);
  t.after(() => closeDb(db));
  return { messages: createMessagesStore({ db }) };
}

const silentLogger = { warn() {}, info() {}, debug() {}, error() {} };

test('群聊：剥掉开头的发言人标签，正文与 senderName 不重复', (t) => {
  const { messages } = setup(t);
  appendMessageRecord({
    messages, botId: 'bot-a', scope: 'group', peer: 'group:G1',
    message: { senderId: 'S1', senderName: '朝咱', messageId: 'm1', msgType: 0 },
    body: '[朝咱 (S1)] 这泡馍店也太会做生意了',
    logger: silentLogger,
  });
  const row = messages.search({ botId: 'bot-a' })[0];
  assert.equal(row.content, '这泡馍店也太会做生意了');
  assert.equal(row.senderName, '朝咱');
});

test('群聊：引用块/历史块里的标签必须保留（那是多人上下文）', (t) => {
  const { messages } = setup(t);
  const body = '[朝咱 (S1)] [Quoted message begins]\n[院 (S2)] 原话\n[Quoted message ends]\n[Current message]\n我的回复';
  appendMessageRecord({
    messages, botId: 'bot-a', scope: 'group', peer: 'group:G1',
    message: { senderId: 'S1', senderName: '朝咱', messageId: 'm1', msgType: 0 },
    body, logger: silentLogger,
  });
  const row = messages.search({ botId: 'bot-a' })[0];
  assert.ok(!row.content.startsWith('[朝咱'), '开头标签应被剥掉');
  assert.ok(row.content.includes('[院 (S2)] 原话'), '引用块内的标签必须保留');
});

test('私聊：不加发言人标签，原样入库', (t) => {
  const { messages } = setup(t);
  appendMessageRecord({
    messages, botId: 'bot-a', scope: 'c2c', peer: 'c2c:U1',
    message: { senderId: 'U1', senderName: '群主', messageId: 'm1', msgType: 0 },
    body: '私聊里说的话', logger: silentLogger,
  });
  assert.equal(messages.search({ botId: 'bot-a' })[0].content, '私聊里说的话');
});

test('空正文不写库', (t) => {
  const { messages } = setup(t);
  const result = appendMessageRecord({
    messages, botId: 'bot-a', scope: 'group', peer: 'group:G1',
    message: { senderId: 'S1', messageId: 'm1' }, body: '   ', logger: silentLogger,
  });
  assert.equal(result.ok, false);
  assert.equal(messages.stats({ botId: 'bot-a' }).count, 0);
});

test('store 缺失时静默降级（不影响回复链路）', () => {
  const result = appendMessageRecord({
    messages: null, botId: 'bot-a', scope: 'group', peer: 'group:G1',
    message: { senderId: 'S1', messageId: 'm1' }, body: '随便', logger: silentLogger,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-store');
});

test('store 抛错时只 warn 不抛（绝不阻断回复）', () => {
  const warnings = [];
  const result = appendMessageRecord({
    messages: { save() { throw new Error('磁盘满了'); } },
    botId: 'bot-a', scope: 'group', peer: 'group:G1',
    message: { senderId: 'S1', messageId: 'm1' }, body: '随便',
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.equal(result.ok, false);
  assert.ok(warnings.some((w) => w.includes('磁盘满了')));
});

test('助手消息：role=assistant，按 peer 推导 scope', (t) => {
  const { messages } = setup(t);
  appendAssistantRecord({ messages, botId: 'bot-a', peer: 'group:G1', content: '我回一句', logger: silentLogger });
  const row = messages.search({ botId: 'bot-a' })[0];
  assert.equal(row.role, 'assistant');
  assert.equal(row.scope, 'group');
  assert.equal(row.content, '我回一句');
});
