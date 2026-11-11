/**
 * models-api —— 控制台「模型」页后端接口：槽位 / LLM 目录 / TTS 供应商 CRUD 与试听。
 *
 * 只测 API 契约层：TTS 引擎与宿主 llm 服务都用 fake 注入，不联网。
 */
import assert from 'node:assert/strict';
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
    enabled: row.enabled !== false,
    config: row.config,
    hasSecret: row.secret !== '',
    summary: row.config.model || row.config.voice || '',
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
      if (!['edge', 'mimo'].includes(input.kind)) {
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
    assert.deepEqual(res.data.ready, ['llm', 'vision', 'voice']);
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
    for (const expected of ['edge', 'mimo', 'bailian', 'openai', 'custom', 'command']) {
      assert.ok(ids.includes(expected), '缺少 kind: ' + expected);
    }
    const mimo = res.data.kinds.find((kind) => kind.id === 'mimo');
    assert.ok(Array.isArray(mimo.fields) && mimo.fields.length > 0);
    assert.ok(mimo.models.some((model) => model.value === 'mimo-v2.5-tts-voicedesign'));
    const edge = res.data.kinds.find((kind) => kind.id === 'edge');
    assert.equal(edge.needsSecret, false);
    assert.ok(edge.voices.some((voice) => voice.value === 'zh-CN-XiaoxiaoNeural'));
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
