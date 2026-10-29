/**
 * test/multibot-integration.test.js —— 多机器人关键接线测试。
 *
 * 覆盖：
 * 1. 提示词 composer + 涌现：有本轮上下文时注入「本轮相关背景」，无关时不注入；
 * 2. 绑定服务注入 persistCredentials 后，凭据写到宿主指定的位置（机器人 credentials.json）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPromptComposer } from '../lib/prompt.js';
import { createEmergence } from '../lib/context/emergence.js';
import { createBindingService } from '../lib/binding/service.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-int-' + name + '-'));
}

function makeSettingsStub(overrides = {}) {
  const base = {
    memory: { enabled: true, dir: '', injectMaxChars: 4000, selfImprovePrompt: '', recall: { enabled: true, maxItems: 4, maxChars: 1200, recencyHalfLifeDays: 30, importanceWeight: 2, minScore: 0.15 } },
    knowledge: { enabled: true, dir: '', injectMaxChars: 2000, maxPerTurn: 3 },
    members: { enabled: true, dir: '', autoRecord: true, maxPerTurn: 2, maxChars: 800 },
    features: { workspace: true, web: true, stickers: false, vision: false, memory: true },
    stickers: { dir: '', frequency: 'normal', collectEnabled: true },
    prompts: { toolGuide: { enabled: true, text: '' }, sendGuide: { enabled: true, text: '' }, rhythmGuide: { enabled: true, text: '' }, stickerGuide: { enabled: true, text: '' }, sections: {} },
    persona: { mode: 'replace', path: '', suppressRuntimeContext: true, groupExtraPrompt: '', directExtraPrompt: '' },
    phrases: { enabled: false, items: [] },
    behavior: { extraInstructions: '' },
    reply: { groupMode: 'all' },
    tools: { capabilities: {}, capabilityEntries: {}, removedCapabilities: [], extraAllowed: [], skills: { mode: 'allow', allowed: [] } },
  };
  return { get: () => ({ ...base, ...overrides }) };
}

test('prompt + emergence：本轮相关时注入「本轮相关背景」，无关时不注入', () => {
  const knowledge = {
    recall({ query }) {
      if (query.includes('开黑')) {
        return [{ id: 'k1', title: '周六开黑', body: '每周六晚八点群语音开黑', tags: ['活动'], score: 0.9 }];
      }
      return [];
    },
    list() { return { total: 0, items: [] }; },
    stats() { return { tags: [] }; },
  };
  const members = {
    recallAlly({ query }) {
      if (query.includes('老周')) return [{ id: 'm1', title: '老周', tags: ['群主'], body: '群主周哥', score: 1 }];
      return [];
    },
  };
  const memory = { recall: () => [], hotText: () => '' };
  const settings = makeSettingsStub();
  const emergence = createEmergence({ settings, memory, knowledge, members, logger: quiet });
  const persona = { read: () => ({ exists: false, text: '' }) };
  const composer = createPromptComposer({
    settings,
    personaStore: persona,
    memoryStore: memory,
    stickerStore: undefined,
    logger: quiet,
    emergence,
  });

  const relevant = composer.compose({ scope: 'group', turn: { text: '今晚要不要开黑？', scope: 'group', groupId: 'g1' } });
  assert.match(relevant, /本轮相关背景/);
  assert.match(relevant, /周六开黑/);

  const irrelevant = composer.compose({ scope: 'group', turn: { text: '今天天气不错', scope: 'group', groupId: 'g1' } });
  assert.ok(!irrelevant.includes('本轮相关背景'), '无关话题不应注入');

  const noTurn = composer.compose({ scope: 'group' });
  assert.ok(!noTurn.includes('本轮相关背景'), '没有本轮上下文时不应注入');
});

test('绑定服务：persistCredentials 注入后写宿主指定位置，不依赖 profileDir', async () => {
  const writes = [];
  const service = createBindingService({
    logger: quiet,
    profileDir: '',
    getCredentials: () => ({ appId: '', appSecret: '' }),
    persistCredentials: (creds) => {
      writes.push(creds);
      return { ok: true, result: { path: '/tmp/fake-credentials.json' } };
    },
    onBound: () => {},
    connectFn: null,
  });
  const result = await service.manual('102000001', 'secret-value');
  assert.equal(result.ok, true);
  assert.deepEqual(writes, [{ appId: '102000001', appSecret: 'secret-value' }]);
  const state = service.wireState();
  assert.equal(state.phase, 'bound');
  assert.equal(state.appId, '102000001');
  assert.ok(!JSON.stringify(state).includes('secret-value'), '状态投影不能回显 appSecret');
});

test('入站：写入本轮上下文 + 群友自动收录', async () => {
  const { createInboundHandler } = await import('../lib/qq/inbound.js');
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
  const visits = [];
  const record = {
    agent: {
      followup: async (message) => { record.received = message; },
      whenIdle: async () => {},
    },
    turn: { current: null },
  };
  const manager = {
    getOrCreate: async () => record,
  };
  const settings = {
    get: () => ({ members: { autoRecord: true }, reply: { groupMode: 'all' } }),
  };
  const historyStore = { clear() {} };
  const handler = createInboundHandler({
    config: { appId: '102000' },
    logger: quiet,
    manager,
    settings,
    stats: { received: 0, triggered: 0, skipped: 0, replies: 0 },
    historyStore,
    members: { visit: (input) => visits.push(input) },
    botId: 'bot',
  });
  const message = {
    kind: 'group',
    content: '今晚要不要一起开黑？',
    groupOpenid: 'g_demo_88',
    senderId: 'A1B2C3D4E5F601',
    senderName: '阿岚',
    messageId: 'm1',
    attachments: [],
  };
  await handler({ message, replyTarget: { scope: 'group', targetId: 'g_demo_88' }, state: {} });
  // 本轮上下文供 prompt 的涌现段使用
  assert.equal(record.turn.current.text, '今晚要不要一起开黑？');
  assert.equal(record.turn.current.groupId, 'g_demo_88');
  assert.equal(record.turn.current.senderId, 'A1B2C3D4E5F601');
  assert.equal(record.turn.current.senderName, '阿岚');
  // 群友库自动收录
  assert.equal(visits.length, 1);
  assert.equal(visits[0].openid, 'A1B2C3D4E5F601');
  assert.equal(visits[0].name, '阿岚');
  assert.equal(visits[0].groupId, 'g_demo_88');
  // agent 收到的是 user message
  assert.ok(record.received, 'followup 应被调用');
});

