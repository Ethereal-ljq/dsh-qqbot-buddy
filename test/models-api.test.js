/**
 * models-api —— 控制台「模型」页后端接口：槽位 / LLM 目录 / TTS 供应商 CRUD 与试听。
 *
 * 只测 API 契约层：TTS 引擎与宿主 llm 服务都用 fake 注入，不联网。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHarness } from './console-helpers.js';

/** 最小 fake TTS 引擎（接口见 docs/MODELS-CENTER.md §6）。 */
function createFakeTts() {
  const rows = new Map();
  let seq = 0;
  const view = (row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    kindLabel: row.kind,
    kindShort: row.kind,
    group: (row.kind === 'deepseek-asr' || row.kind === 'mimo-asr' || row.kind === 'openai-asr' || row.kind === 'faster-whisper') ? 'asr' : /-clone$/.test(row.kind) ? 'clone' : /-design$/.test(row.kind) ? 'design' : 'default',
    groupLabel: (row.kind === 'deepseek-asr' || row.kind === 'mimo-asr' || row.kind === 'openai-asr' || row.kind === 'faster-whisper') ? '语音识别（ASR）' : /-clone$/.test(row.kind) ? '音色克隆' : /-design$/.test(row.kind) ? '文字设计音色' : '默认音色 TTS',
    capability: (row.kind === 'deepseek-asr' || row.kind === 'mimo-asr' || row.kind === 'openai-asr' || row.kind === 'faster-whisper') ? 'asr' : 'tts',
    ...(row.kind === 'minimax-clone' ? { prepareLabel: '克隆音色' } : {}),
    ...(row.kind === 'minimax-design' ? { prepareLabel: '生成设计音色' } : {}),
    enabled: row.enabled !== false,
    config: row.config,
    hasSecret: row.secret !== '',
    summary: row.config.model || row.config.voice || row.config.description || '',
    outputFormat: 'mp3',
    createdAt: 1,
    updatedAt: 1,
  });
  return {
    calls: [],
    listProviders() { return [...rows.values()].map(view); },
    getProvider(id) { return rows.get(id) || null; },
    saveProvider(input) {
      this.calls.push({ method: 'saveProvider', input });
      if (!input || typeof input !== 'object') throw new Error('请求体必须是对象');
      if (!['edge', 'mimo', 'mimo-clone', 'mimo-design', 'minimax', 'minimax-clone', 'minimax-design', 'deepseek', 'deepseek-asr', 'mimo-asr', 'openai-asr', 'faster-whisper'].includes(input.kind)) {
        const err = new Error('未知的 TTS 供应商类型: ' + (input.kind || '(空)'));
        err.code = 'invalid_tts_provider';
        throw err;
      }
      const id = typeof input.id === 'string' && input.id !== '' ? input.id : 'tts_' + (++seq).toString(16).padStart(2, '0');
      const row = {
        id,
        name: typeof input.name === 'string' && input.name !== '' ? input.name : '未命名',
        kind: input.kind,
        enabled: input.enabled !== false,
        config: input.config && typeof input.config === 'object' ? input.config : {},
        secret: typeof input.secret === 'string' && input.secret !== '' ? input.secret : (rows.get(id)?.secret || ''),
      };
      rows.set(id, row);
      return view(row);
    },
    deleteProvider(id) { return rows.delete(id); },
    async prepareProvider({ providerId }) {
      const row = rows.get(providerId);
      if (!row) { const err = new Error('供应商不存在'); err.code = 'TTS_PROVIDER_NOT_FOUND'; throw err; }
      if (!String(row.kind).startsWith('minimax-')) {
        const err = new Error('该 TTS 供应商类型不支持「生成音色」操作');
        err.code = 'TTS_CONFIG';
        throw err;
      }
      const voiceId = row.kind === 'minimax-clone' ? 'qqbotClone01' : 'ttv-voice-01';
      row.config = { ...row.config, voiceId };
      return {
        ok: true,
        provider: view(row),
        configPatch: { voiceId },
        demoAudioBase64: row.kind === 'minimax-design' ? Buffer.from('demo').toString('base64') : '',
        demoMimeType: row.kind === 'minimax-design' ? 'audio/mpeg' : '',
        demoBytes: row.kind === 'minimax-design' ? 4 : 0,
        meta: { voiceId },
      };
    },
    async test({ providerId, text }) {
      const row = rows.get(providerId);
      if (!row) { const err = new Error('供应商不存在'); err.code = 'TTS_PROVIDER_NOT_FOUND'; throw err; }
      return {
        ok: true,
        providerId,
        kind: row.kind,
        model: 'test-model',
        voice: 'test-voice',
        format: 'mp3',
        bytes: 4,
        ms: 3,
        audioBase64: Buffer.from('abcd').toString('base64'),
        mimeType: 'audio/mpeg',
        text,
      };
    },
  };
}

/** fake 宿主 llm 服务：一个 provider 正常、一个 provider 抛错（容错测试）。 */
function createFakeLlm() {
  return {
    listProviders() {
      return [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'broken', name: 'Broken Provider' }];
    },
    async listModels(provider) {
      if (provider === 'broken') throw new Error('provider exploded');
      return [{ provider, id: 'deepseek-v4.1-flash', name: 'V4.1 Flash', inputModalities: ['text', 'image'] }];
    },
  };
}

async function setup() {
  const tts = createFakeTts();
  const llm = createFakeLlm();
  const harness = await createHarness({
    deps: {
      tts,
      rootCtx: { get: (name) => (name === 'llm' ? llm : undefined) },
    },
  });
  await harness.loginOk();
  return { harness, tts };
}

test('GET /api/models/slots：模型类型插槽含 ready 与 planned', async () => {
  const { harness } = await setup();
  try {
    const res = await harness.request('GET', '/api/models/slots');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.slots));
    const ids = res.data.slots.map((slot) => slot.id);
    assert.deepEqual(ids.slice(0, 3), ['llm', 'vision', 'voice']);
    assert.deepEqual(res.data.ready, ['llm', 'vision', 'voice', 'asr']);
    assert.ok(res.data.planned.length >= 1, '至少要有一个预留插槽');
    for (const slot of res.data.slots) {
      assert.equal(typeof slot.label, 'string');
      assert.equal(typeof slot.desc, 'string');
      if (slot.status === 'ready') assert.ok(slot.settingsSection, slot.id + ' ready 必须有 settingsSection');
    }
  } finally {
    await harness.close();
  }
});

test('GET /api/models/llm：provider/model 目录 + 单个 provider 失败不影响整体', async () => {
  const { harness } = await setup();
  try {
    const res = await harness.request('GET', '/api/models/llm');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.providers.map((item) => item.id), ['deepseek', 'broken']);
    assert.equal(res.data.models.length, 1);
    assert.equal(res.data.models[0].provider, 'deepseek');
    assert.equal(res.data.models[0].id, 'deepseek-v4.1-flash');
    assert.deepEqual(res.data.models[0].inputModalities, ['text', 'image']);
  } finally {
    await harness.close();
  }
});

test('GET /api/models/llm：宿主 llm 服务不可用时返回空目录 + warning', async () => {
  const harness = await createHarness({ deps: { tts: createFakeTts() } });
  await harness.loginOk();
  try {
    const res = await harness.request('GET', '/api/models/llm');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.providers, []);
    assert.deepEqual(res.data.models, []);
    assert.match(res.data.warning, /不可用/);
  } finally {
    await harness.close();
  }
});

test('GET /api/models/tts/kinds：返回全部供应商种类与字段元数据', async () => {
  const { harness } = await setup();
  try {
    const res = await harness.request('GET', '/api/models/tts/kinds');
    assert.equal(res.status, 200);
    const ids = res.data.kinds.map((kind) => kind.id);
    for (const expected of ['edge', 'mimo', 'mimo-clone', 'mimo-design', 'minimax', 'minimax-clone', 'minimax-design', 'deepseek', 'deepseek-asr', 'mimo-asr', 'openai-asr', 'faster-whisper', 'bailian', 'openai', 'custom', 'command']) {
      assert.ok(ids.includes(expected), '缺少 kind: ' + expected);
    }
    // 分组元数据：默认 / 克隆 / 文字设计
    assert.deepEqual(res.data.groups.map((group) => group.id), ['default', 'clone', 'design', 'asr']);
    const kinds = new Map(res.data.kinds.map((kind) => [kind.id, kind]));
    assert.equal(kinds.get('mimo').group, 'default');
    assert.equal(kinds.get('mimo-clone').group, 'clone');
    assert.equal(kinds.get('mimo-design').group, 'design');
    assert.equal(kinds.get('minimax').group, 'default');
    assert.equal(kinds.get('minimax-clone').group, 'clone');
    assert.equal(kinds.get('minimax-design').group, 'design');
    assert.equal(kinds.get('deepseek').group, 'default');
    assert.equal(kinds.get('deepseek').capability, 'tts');
    assert.equal(kinds.get('deepseek-asr').group, 'asr');
    assert.equal(kinds.get('deepseek-asr').capability, 'asr');
    assert.ok(kinds.get('deepseek').voices.some((voice) => voice.value === 'stella'));
    assert.equal(kinds.get('mimo-asr').group, 'asr');
    assert.equal(kinds.get('mimo-asr').capability, 'asr');
    assert.equal(kinds.get('openai-asr').group, 'asr');
    assert.equal(kinds.get('faster-whisper').group, 'asr');
    assert.equal(kinds.get('faster-whisper').needsSecret, false);
    // MiniMax 默认音色：系统音色 / 模型下拉
    assert.ok(kinds.get('minimax').voices.some((voice) => voice.value === 'female-shaonv'));
    assert.ok(kinds.get('minimax').models.some((model) => model.value === 'speech-2.8-hd'));
    // MiniMax 克隆：需要「生成音色」动作，样本字段是 audio
    assert.equal(kinds.get('minimax-clone').prepareLabel, '克隆音色');
    assert.equal(kinds.get('minimax-clone').fields.find((field) => field.key === 'samplePath').type, 'audio');
    // 克隆：样本字段是 audio（文件选择器）而不是手输 text
    const sample = kinds.get('mimo-clone').fields.find((field) => field.key === 'samplePath');
    assert.equal(sample.type, 'audio');
    assert.equal(sample.required, true);
    // 文字设计：描述必填
    const design = kinds.get('mimo-design').fields.find((field) => field.key === 'description');
    assert.equal(design.type, 'textarea');
    assert.equal(design.required, true);
    // 默认音色：不再暴露 model 字段
    assert.equal(kinds.get('mimo').fields.some((field) => field.key === 'model'), false);
    const edge = kinds.get('edge');
    assert.equal(edge.needsSecret, false);
    assert.ok(edge.voices.some((voice) => voice.value === 'zh-CN-XiaoxiaoNeural'));
  } finally {
    await harness.close();
  }
});

test('GET /api/models/tts/audio/list：只列目录 + 音频文件，限制在选择器根目录内', async () => {
  const { harness } = await setup();
  try {
    const workspace = harness.workspaceRoot;
    assert.ok(workspace, 'harness 应暴露 workspaceRoot');
    fs.mkdirSync(path.join(workspace, 'audio'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'audio', 'sample.mp3'), Buffer.from('mp3'));
    fs.writeFileSync(path.join(workspace, 'audio', 'voice.wav'), Buffer.alloc(8, 1));
    fs.writeFileSync(path.join(workspace, 'audio', 'notes.txt'), 'not audio');
    fs.mkdirSync(path.join(workspace, 'audio', 'nested'), { recursive: true });

    const res = await harness.request('GET', '/api/models/tts/audio/list?path=' + encodeURIComponent(path.join(workspace, 'audio')));
    assert.equal(res.status, 200);
    assert.equal(res.data.path, fs.realpathSync(path.join(workspace, 'audio')));
    assert.ok(Array.isArray(res.data.roots) && res.data.roots.some((root) => root.id === 'workspace'));
    const names = res.data.entries.map((entry) => entry.name);
    assert.ok(names.includes('nested'), '目录应出现');
    assert.ok(names.includes('sample.mp3') && names.includes('voice.wav'), '音频文件应出现');
    assert.equal(names.includes('notes.txt'), false, '非音频文件不应出现');
    const nested = res.data.entries.find((entry) => entry.name === 'nested');
    assert.equal(nested.type, 'dir');
    const mp3 = res.data.entries.find((entry) => entry.name === 'sample.mp3');
    assert.equal(mp3.type, 'file');
    assert.equal(mp3.ext, 'mp3');
    // 目录在前
    assert.equal(res.data.entries[0].type, 'dir');

    // 不带 path：默认第一个根目录（工作区）
    const rootRes = await harness.request('GET', '/api/models/tts/audio/list');
    assert.equal(rootRes.status, 200);
    assert.equal(rootRes.data.path, fs.realpathSync(workspace));

    // 越界目录拒绝
    const outside = path.join(os.tmpdir(), 'qqbot-audio-outside-' + Date.now());
    fs.mkdirSync(outside, { recursive: true });
    try {
      const denied = await harness.request('GET', '/api/models/tts/audio/list?path=' + encodeURIComponent(outside));
      assert.equal(denied.status, 400);
      assert.equal(denied.data.error.code, 'path_outside_roots');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }

    // 不存在的目录
    const missing = await harness.request('GET', '/api/models/tts/audio/list?path=' + encodeURIComponent(path.join(workspace, 'nope-dir')));
    assert.equal(missing.status, 400);
    assert.equal(missing.data.error.code, 'path_not_found');
  } finally {
    await harness.close();
  }
});

test('TTS 供应商 CRUD：新增/列表/编辑（secret 留空保留）/删除 + 无效 kind 400', async () => {
  const { harness, tts } = await setup();
  try {
    const created = await harness.request('POST', '/api/models/tts/providers', {
      body: { name: '本地 Edge', kind: 'edge', config: { voice: 'zh-CN-XiaoxiaoNeural' } },
    });
    assert.equal(created.status, 200);
    assert.equal(created.data.kind, 'edge');
    assert.equal(created.data.hasSecret, false);
    const id = created.data.id;

    const list = await harness.request('GET', '/api/models/tts/providers');
    assert.equal(list.status, 200);
    assert.equal(list.data.providers.length, 1);
    assert.equal(list.data.providers[0].id, id);

    // 编辑：不传 secret -> store/engine 语义是保留原值（fake 这里验证请求确实带上了 id）
    const patched = await harness.request('PATCH', '/api/models/tts/providers/' + id, {
      body: { name: 'Edge 改名', kind: 'edge', config: { voice: 'zh-CN-YunxiNeural' } },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.name, 'Edge 改名');
    assert.equal(tts.calls.at(-1).input.id, id);

    // 无效 kind：服务层抛错 -> 400 + 可读 code
    const bad = await harness.request('POST', '/api/models/tts/providers', { body: { name: 'x', kind: 'nope' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'invalid_tts_provider');
    assert.match(bad.data.error.message, /未知的 TTS 供应商类型/);

    const removed = await harness.request('DELETE', '/api/models/tts/providers/' + id);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.data, { ok: true, id });
    const gone = await harness.request('PATCH', '/api/models/tts/providers/' + id, { body: { kind: 'edge' } });
    assert.equal(gone.status, 404);
  } finally {
    await harness.close();
  }
});

test('POST /api/models/tts/providers/:id/prepare：生成音色（MiniMax 克隆/设计）并回填 voiceId', async () => {
  const { harness } = await setup();
  try {
    const created = await harness.request('POST', '/api/models/tts/providers', {
      body: { name: 'MiniMax 克隆', kind: 'minimax-clone', config: { samplePath: '/tmp/sample.mp3' } },
    });
    assert.equal(created.status, 200);
    const id = created.data.id;

    const prepared = await harness.request('POST', '/api/models/tts/providers/' + encodeURIComponent(id) + '/prepare', { body: {} });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.data.ok, true);
    assert.equal(prepared.data.voiceId, 'qqbotClone01');
    assert.equal(prepared.data.provider.config.voiceId, 'qqbotClone01');
    assert.equal(prepared.data.provider.kind, 'minimax-clone');

    // 不支持的类型 → 400 可读错误
    const edge = await harness.request('POST', '/api/models/tts/providers', {
      body: { name: 'Edge', kind: 'edge', config: {} },
    });
    const rejected = await harness.request('POST', '/api/models/tts/providers/' + encodeURIComponent(edge.data.id) + '/prepare', { body: {} });
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error.message, /不支持/);

    // 不存在的供应商 → 404
    const missing = await harness.request('POST', '/api/models/tts/providers/tts_nope/prepare', { body: {} });
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

test('GET /api/models/tts/providers：defaultProvider 来自全局设置 voice.defaultProvider', async () => {
  const { harness, tts } = await setup();
  try {
    tts.saveProvider({ name: '默认档', kind: 'edge' });
    harness.config.patchSettings('', { voice: { defaultProvider: 'tts_01' } });
    const res = await harness.request('GET', '/api/models/tts/providers');
    assert.equal(res.status, 200);
    assert.equal(res.data.defaultProvider, 'tts_01');
  } finally {
    await harness.close();
  }
});

test('POST /api/models/tts/providers/:id/test：返回可试听的 base64 音频；缺省文案可覆盖', async () => {
  const { harness, tts } = await setup();
  try {
    const created = await harness.request('POST', '/api/models/tts/providers', { body: { name: '试听', kind: 'edge' } });
    const id = created.data.id;
    const res = await harness.request('POST', '/api/models/tts/providers/' + id + '/test', { body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.providerId, id);
    assert.equal(res.data.mimeType, 'audio/mpeg');
    assert.equal(Buffer.from(res.data.audioBase64, 'base64').toString(), 'abcd');
    assert.equal(res.data.text, '你好，这是一条语音合成测试。');

    const custom = await harness.request('POST', '/api/models/tts/providers/' + id + '/test', { body: { text: '自定义试听文本' } });
    assert.equal(custom.data.text, '自定义试听文本');

    const missing = await harness.request('POST', '/api/models/tts/providers/tts_nope/test', { body: {} });
    assert.equal(missing.status, 404);
    assert.equal(tts.calls.filter((call) => call.method === 'saveProvider').length, 1);
  } finally {
    await harness.close();
  }
});

test('TTS 引擎未装配：接口 501 not_ready（前端按空态处理）', async () => {
  const harness = await createHarness();
  await harness.loginOk();
  try {
    const res = await harness.request('GET', '/api/models/tts/providers');
    assert.equal(res.status, 501);
    assert.equal(res.data.error.code, 'not_ready');
  } finally {
    await harness.close();
  }
});
