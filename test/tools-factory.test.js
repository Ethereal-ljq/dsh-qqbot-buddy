/**
 * tools-factory —— createToolFactory：注册到 agentCtx、能力过滤、依赖缺失降级。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createToolFactory } from '../lib/tools/index.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function createAgentCtx() {
  const definitions = [];
  const effects = [];
  return {
    definitions,
    effects,
    tools: {
      register(definition) {
        definitions.push(definition);
        return () => { /* disposer */ };
      },
    },
    effect(fn, label) { effects.push({ fn, label }); },
  };
}

function createRuntime({ withOneShot = true, withStickers = false, withData = false, withTts = false } = {}) {
  const runtime = {
    cfg: {},
    oneShot: withOneShot
      ? { async generate() { return { ok: true, text: '一张蓝色背景的图' }; } }
      : null,
    // TTS 引擎（core/tts，契约见 docs/MODELS-CENTER.md §6）；缺省时 qqbot_speak 降级不注册
    tts: withTts
      ? {
        resolveSelection() {
          return { provider: 'edge', providerId: 'tts_1', voice: 'zh-CN-XiaoxiaoNeural', style: '', speed: 1, maxChars: 300 };
        },
        async synthesizeForSettings() {
          return {
            ok: true, providerId: 'tts_1', kind: 'edge', model: 'edge-tts', voice: 'zh-CN-XiaoxiaoNeural',
            format: 'mp3', filePath: '/tmp/fake-tts.mp3', bytes: 16, ms: 1, segments: 1, truncated: false, text: '你好',
          };
        },
      }
      : null,
    stickers: withStickers
      ? {
        _items: [],
        list() { return this._items; },
        add(input) { const item = { id: this._items.length + 1, ...input, created: true }; this._items.push(item); return item; },
        quota() { return { day: '2026-11-09', count: 0 }; },
        recordSend() { return { day: '2026-11-09', count: 1 }; },
      }
      : null,
  };
  if (withData) {
    runtime.memory = {
      save: () => ({ id: 1, created: true }), search: () => [], list: () => [], get: () => null,
    };
    runtime.kb = {
      search: () => [], ingest: () => ({ docId: 1, chunks: 1, changed: true }), getDoc: () => ({ title: 't', chunkCount: 1 }),
    };
    runtime.members = {
      upsert: () => ({ created: true }), list: () => [], get: () => null,
    };
  }
  return runtime;
}

function createBotRuntime() {
  return {
    id: 'bot-1',
    cwd: '/tmp/qq-tools-factory-bot',
    bot: { appId: 'app-1' },
    sessions: new Map(),
    transport: {
      mediaSender: { sendImage: async () => ({}), sendVideo: async () => ({}), sendVoice: async () => ({}), sendFile: async () => ({}) },
      messageSender: { sendCard: async () => ({ ok: true }) },
    },
    settingsFor: () => ({}),
  };
}

const baseSettings = {
  tools: { capabilities: { workspace: true, web: true, memory: true, stickers: true, vision: true, skills: false, imagegen: false } },
  stickers: { enabled: true, dailyQuota: 30 },
};

function createRig({ settings = baseSettings, runtime, agentCtx } = {}) {
  const ctx = {
    get(name) {
      if (name === 'attachments') {
        return {
          async saveImage(input) {
            return { attachmentId: 'sha256:fake', mediaType: input.mediaType, bytes: input.data ? input.data.length : 0, name: input.name };
          },
        };
      }
      return undefined;
    },
  };
  const factory = createToolFactory({ ctx, runtime: runtime || createRuntime(), logger: silentLogger });
  const botCtx = agentCtx || createAgentCtx();
  return { factory, botCtx, settings, botRuntime: createBotRuntime() };
}

async function run(rig, settings) {
  const result = await rig.factory({
    agentCtx: rig.botCtx,
    agent: {},
    runtime: rig.botRuntime,
    settings: settings || rig.settings,
    peer: 'c2c:U1',
    botId: 'bot-1',
  });
  return result;
}

test('默认能力下注册全部 QQ 工具（send_file/send_card/quote_reply/describe_image）', async () => {
  const rig = createRig({ runtime: createRuntime({ withStickers: true }) });
  const result = await run(rig);
  const names = rig.botCtx.definitions.map((item) => item.name);
  for (const expected of ['qqbot_send_file', 'qqbot_send_card', 'qqbot_quote_reply', 'qqbot_describe_image', 'qqbot_sticker_save', 'qqbot_send_sticker']) {
    assert.ok(names.includes(expected), '缺少工具: ' + expected + '（实际 ' + names.join(',') + '）');
  }
  assert.deepEqual(result.registered.sort(), names.sort());
  // 每个工具都有 execute + 参数 schema
  for (const def of rig.botCtx.definitions) {
    assert.equal(typeof def.execute, 'function');
    assert.equal(def.parameters.type, 'object');
    assert.equal(typeof def.description, 'string');
  }
  // 注册随 agent 生命周期释放（effect 绑定了 disposer）
  assert.ok(rig.botCtx.effects.length >= 1, '应通过 agentCtx.effect 绑定工具 disposer');
  assert.ok(rig.botCtx.effects[0].label.includes('qqbot-buddy.tool:'));
});

test('能力关闭：stickers=false 只跳过发送/表情工具，vision=false 跳过看图', async () => {
  const settings = {
    tools: { capabilities: { workspace: true, web: true, memory: true, stickers: false, vision: false, skills: false, imagegen: false } },
  };
  const rig = createRig({ runtime: createRuntime({ withStickers: true }) });
  await run(rig, settings);
  const names = rig.botCtx.definitions.map((item) => item.name);
  assert.deepEqual(names.sort(), ['qqbot_quote_reply', 'qqbot_send_card'].sort());
});

test('deny/allow 列表对插件工具同样生效（deny 优先）', async () => {
  const settings = {
    tools: {
      capabilities: { stickers: false, vision: false, workspace: true, web: true, memory: true, skills: false, imagegen: false },
      deny: ['qqbot_send_card'],
      allow: ['qqbot_describe_image'],
    },
  };
  const rig = createRig({ runtime: createRuntime({ withStickers: true }) });
  await run(rig, settings);
  const names = rig.botCtx.definitions.map((item) => item.name);
  assert.ok(names.includes('qqbot_describe_image'), 'allow 可越过能力关闭');
  assert.ok(!names.includes('qqbot_send_card'), 'deny 优先');
  assert.ok(!names.includes('qqbot_send_file'));
});

test('依赖缺失降级：无 oneShot 不注册 describe_image；无 stickers store 不注册表情工具', async () => {
  const rig = createRig({ runtime: createRuntime({ withOneShot: false, withStickers: false }) });
  await run(rig);
  const names = rig.botCtx.definitions.map((item) => item.name);
  assert.ok(!names.includes('qqbot_describe_image'));
  assert.ok(!names.includes('qqbot_sticker_save'));
  assert.ok(!names.includes('qqbot_send_sticker'));
  assert.ok(names.includes('qqbot_send_file'), '发送工具不依赖上述服务');
  assert.ok(names.includes('qqbot_quote_reply'));
});

test('agentCtx.tools 不可用时不抛错，返回空结果', async () => {
  const ctx = { get: () => undefined };
  const factory = createToolFactory({ ctx, runtime: createRuntime(), logger: silentLogger });
  const result = await factory({ agentCtx: {}, agent: {}, runtime: createBotRuntime(), settings: baseSettings, peer: 'c2c:U1', botId: 'bot-1' });
  assert.deepEqual(result, { registered: [], skipped: [] });
});
test('语音能力：默认关不注册 qqbot_speak；开启 voice 且 tts 已装配才注册', async () => {
  // 1) 默认能力（voice=false）：即便 runtime.tts 已装配也不注册
  const rig = createRig({ runtime: createRuntime({ withTts: true }) });
  await run(rig);
  let names = rig.botCtx.definitions.map((item) => item.name);
  assert.ok(!names.includes('qqbot_speak'), 'voice 能力默认关闭，不应注册 qqbot_speak');

  // 2) 显式开启 voice 能力 + tts 可用 -> 注册
  const voiceOn = {
    tools: { capabilities: { ...baseSettings.tools.capabilities, voice: true } },
  };
  const rig2 = createRig({ runtime: createRuntime({ withTts: true }) });
  await run(rig2, voiceOn);
  names = rig2.botCtx.definitions.map((item) => item.name);
  assert.ok(names.includes('qqbot_speak'), '开启 voice 后应注册 qqbot_speak');
  const speak = rig2.botCtx.definitions.find((item) => item.name === 'qqbot_speak');
  assert.equal(typeof speak.execute, 'function');
  // 兼容别名：模型常把语音工具猜成 qqbot_send_voice，注册成同一实现，避免 unknown tool
  assert.ok(names.includes('qqbot_send_voice'), '开启 voice 后应同时注册兼容别名 qqbot_send_voice');
  const voiceAlias = rig2.botCtx.definitions.find((item) => item.name === 'qqbot_send_voice');
  assert.equal(voiceAlias.execute, speak.execute, '别名必须复用 qqbot_speak 的 execute');

  // 3) 能力开了但 tts 未装配 -> 依赖缺失降级不注册
  const rig3 = createRig({ runtime: createRuntime({ withTts: false }) });
  const result3 = await run(rig3, voiceOn);
  names = rig3.botCtx.definitions.map((item) => item.name);
  assert.ok(!names.includes('qqbot_speak'), 'tts 缺失时应降级不注册');
  assert.ok(!result3.skipped.includes('qqbot_speak'), '能力已开启，不属于「能力关闭跳过」');
});

test('数据类工具：memory/kb/members 已装配时注册 memory_* / knowledge_* / member_*', async () => {
  const rig = createRig({ runtime: createRuntime({ withStickers: true, withData: true }) });
  await run(rig);
  const names = rig.botCtx.definitions.map((item) => item.name);
  for (const expected of [
    'memory_save', 'memory_search', 'memory_read', 'memory_list',
    'knowledge_search', 'knowledge_read', 'knowledge_save',
    'member_lookup', 'member_note',
  ]) {
    assert.ok(names.includes(expected), '缺少数据工具: ' + expected);
  }
  // memory 能力关闭时 memory_* 跳过，但 knowledge/member 仍注册
  const settings = {
    tools: { capabilities: { workspace: true, web: true, memory: false, stickers: true, vision: true, skills: false, imagegen: false } },
  };
  const rig2 = createRig({ runtime: createRuntime({ withData: true }) });
  await run(rig2, settings);
  const names2 = rig2.botCtx.definitions.map((item) => item.name);
  assert.ok(!names2.includes('memory_save'));
  assert.ok(names2.includes('knowledge_search'));
  assert.ok(names2.includes('member_lookup'));
});
