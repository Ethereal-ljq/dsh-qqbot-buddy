/**
 * test/tts-engine —— TTS 引擎（core/tts/index.js）：供应商 CRUD / 选择解析 / 合成 /
 * 分段合并 / 错误码 / 试听 base64。
 *
 * 全部离线：mock 全局 fetch；wav 合并走纯 JS（禁用 ffmpeg 探测，避免真实子进程）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb } from '../lib/core/db.js';
import { createTtsEngine } from '../lib/core/tts/index.js';
import { encodeWav, parseWav } from '../lib/core/tts/audio.js';

// 引擎测试不依赖本机 ffmpeg（避免真实子进程；wav 合并本就走纯 JS）
process.env.QQBOT_TTS_DISABLE_FFMPEG = '1';

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const MP3 = Buffer.from([0xff, 0xf3, 0x44, 0xc4, 0x00, 0x00, 0x01, 0x02, 0x03]);
const WAV = encodeWav(Buffer.alloc(4800));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-tts-engine-'));
  const db = openDb(path.join(dir, 'tts.db'));
  const engine = createTtsEngine({ db, dataDir: dir, logger: QUIET });
  return {
    dir,
    db,
    engine,
    cleanup() {
      closeDb(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** 记录请求并返回指定音频的 fetch mock。 */
function fetchRecorder(responseFactory) {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    return responseFactory(calls.length);
  };
  fetchMock.calls = calls;
  return fetchMock;
}

function mp3Response() {
  return new Response(new Uint8Array(MP3), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function openaiProvider(engine, overrides = {}) {
  return engine.saveProvider({
    name: 'OpenAI 测试',
    kind: 'openai',
    secret: 'sk-test',
    config: {
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'mp3',
      speed: 1,
      ...overrides,
    },
  });
}

function bailianProvider(engine) {
  return engine.saveProvider({ name: '百炼测试', kind: 'bailian', secret: 'sk-bailian', config: {} });
}

// ── 元数据 / CRUD ──────────────────────────────────────────

test('kinds / 供应商 CRUD / secret 脱敏', () => {
  const h = setup();
  try {
    const kinds = h.engine.kinds();
    assert.equal(kinds.length, 6);
    assert.deepEqual(kinds.map((kind) => kind.id).sort(), ['bailian', 'command', 'custom', 'edge', 'mimo', 'openai']);
    // 返回的是拷贝，外部改动不影响引擎
    kinds[0].label = '被改掉';
    assert.notEqual(h.engine.kinds()[0].label, '被改掉');

    assert.equal(h.engine.listProviders().length, 0);
    const created = h.engine.saveProvider({ name: 'Edge', kind: 'edge' });
    assert.match(created.id, /^tts_[0-9a-f]{12}$/);
    assert.equal(created.hasSecret, false);
    assert.equal('secret' in created, false);
    assert.equal(h.engine.getProvider(created.id).name, 'Edge');
    assert.equal(h.engine.getProvider('tts_nope'), null);
    assert.equal(h.engine.listProviders().length, 1);

    const updated = h.engine.saveProvider({ id: created.id, name: 'Edge2' });
    assert.equal(updated.name, 'Edge2');
    assert.throws(() => h.engine.saveProvider({ kind: 'nope' }), /未知的 TTS 供应商类型/);
    assert.equal(h.engine.deleteProvider(created.id), true);
    assert.equal(h.engine.deleteProvider(created.id), false);
    assert.equal(h.engine.listProviders().length, 0);
  } finally {
    h.cleanup();
  }
});

// ── resolveSelection ───────────────────────────────────────

test('resolveSelection：未启用/无供应商返回 null，按 provider → defaultProvider → firstEnabled 解析', () => {
  const h = setup();
  try {
    assert.equal(h.engine.resolveSelection({ settings: null }), null);
    assert.equal(h.engine.resolveSelection({ settings: { voice: { enabled: false } } }), null);
    // 启用但一个供应商都没有
    assert.equal(h.engine.resolveSelection({ settings: { voice: { enabled: true } } }), null);

    const first = h.engine.saveProvider({
      name: '一号', kind: 'bailian', config: { voice: 'Cherry', model: 'qwen3-tts-flash' },
    });
    const second = h.engine.saveProvider({
      name: '二号', kind: 'openai', config: { baseUrl: 'https://api.example.com/v1', model: 'tts-1', voice: 'nova' },
    });

    // 显式 provider
    const explicit = h.engine.resolveSelection({
      settings: { voice: { enabled: true, provider: second.id, voice: 'echo', style: '', speed: 1.25, maxChars: 120 } },
    });
    assert.equal(explicit.providerId, second.id);
    assert.equal(explicit.voice, 'echo');
    assert.equal(explicit.speed, 1.25);
    assert.equal(explicit.maxChars, 120);
    assert.equal(explicit.provider.kind, 'openai');
    assert.equal('secret' in explicit.provider, false, 'selection 里的 provider 必须是脱敏视图');

    // 未显式选：用 defaultProvider（全局）
    const byDefault = h.engine.resolveSelection({
      settings: { voice: { enabled: true, provider: '', defaultProvider: first.id } },
    });
    assert.equal(byDefault.providerId, first.id);
    assert.equal(byDefault.voice, 'Cherry', '未覆盖音色时回退供应商默认音色');

    // provider 指向不存在的 id → 回退第一个启用的供应商
    const fallback = h.engine.resolveSelection({
      settings: { voice: { enabled: true, provider: 'tts_missing', defaultProvider: '' } },
    });
    assert.equal(fallback.providerId, first.id, '按 created_at ASC 回退第一个启用供应商');
  } finally {
    h.cleanup();
  }
});

// ── synthesize ─────────────────────────────────────────────

test('synthesize：单段合成写文件（命名规则/请求体/返回结构）', async () => {
  const h = setup();
  try {
    const provider = openaiProvider(h.engine);
    const fetchMock = fetchRecorder(() => mp3Response());
    const result = await withFetch(fetchMock, () => h.engine.synthesize({
      text: '  你好，世界。  ',
      providerId: provider.id,
    }));

    assert.equal(result.ok, true);
    assert.equal(result.providerId, provider.id);
    assert.equal(result.kind, 'openai');
    assert.equal(result.model, 'gpt-4o-mini-tts');
    assert.equal(result.voice, 'alloy');
    assert.equal(result.format, 'mp3');
    assert.equal(result.segments, 1);
    assert.equal(result.truncated, false);
    assert.equal(result.text, '你好，世界。');
    assert.equal(result.bytes, MP3.length);
    assert.ok(result.ms >= 0);
    assert.match(path.basename(result.filePath), /^\d{8}-\d{6}-[0-9a-f]{6}\.mp3$/);
    assert.equal(path.dirname(result.filePath), h.engine.audioDir());
    assert.deepEqual(fs.readFileSync(result.filePath), MP3);

    assert.equal(fetchMock.calls.length, 1);
    const body = JSON.parse(fetchMock.calls[0].init.body);
    assert.equal(body.input, '你好，世界。');
    assert.equal(body.voice, 'alloy');
  } finally {
    h.cleanup();
  }
});

test('synthesize：maxChars 截断并标记 truncated（显式参数优先于 settings）', async () => {
  const h = setup();
  try {
    const provider = openaiProvider(h.engine);
    const fetchMock = fetchRecorder(() => mp3Response());

    const explicit = await withFetch(fetchMock, () => h.engine.synthesize({
      text: '一'.repeat(200),
      providerId: provider.id,
      maxChars: 50,
    }));
    assert.equal(explicit.truncated, true);
    assert.equal(explicit.text.length, 50);
    assert.equal(JSON.parse(fetchMock.calls[0].init.body).input.length, 50);

    // settings.voice.maxChars=20 生效
    const settings = {
      voice: { enabled: true, provider: provider.id, defaultProvider: '', voice: '', style: '', speed: 1, maxChars: 20 },
    };
    const bySettings = await withFetch(fetchMock, () => h.engine.synthesizeForSettings({
      text: '长'.repeat(100),
      settings,
    }));
    assert.equal(bySettings.truncated, true);
    assert.equal(bySettings.text.length, 20);
    assert.equal(bySettings.voice, 'alloy', '未覆盖音色时用供应商默认音色');
  } finally {
    h.cleanup();
  }
});

test('synthesize：超过单次请求上限时自动分段，wav 拼接重写头', async () => {
  const h = setup();
  try {
    const provider = bailianProvider(h.engine);
    const fetchMock = fetchRecorder(() => jsonResponse({ output: { audio: { data: WAV.toString('base64') } } }));
    const text = '这是用于测试分段合并的句子。'.repeat(50); // 700 字，bailian 单次上限 600
    assert.ok(text.length > 600);

    const result = await withFetch(fetchMock, () => h.engine.synthesize({
      text,
      providerId: provider.id,
      maxChars: 1200,
    }));

    assert.equal(result.segments, 2, '700 字按 600 字上限应切 2 段');
    assert.equal(fetchMock.calls.length, 2);
    for (const call of fetchMock.calls) {
      const body = JSON.parse(call.init.body);
      assert.ok(body.input.text.length <= 600, '每段不得超过 kind.maxCharsPerRequest');
    }
    assert.equal(result.format, 'wav');
    assert.match(result.filePath, /\.wav$/);
    const merged = parseWav(fs.readFileSync(result.filePath));
    assert.equal(merged.data.length, 4800 * 2, '两段 PCM 应完整拼接');
    assert.equal(result.bytes, 44 + 4800 * 2);
    // 音频目录里不应残留分段临时文件
    const leftovers = fs.readdirSync(h.engine.audioDir()).filter((name) => name.startsWith('.tts-seg-'));
    assert.deepEqual(leftovers, []);
  } finally {
    h.cleanup();
  }
});

test('synthesize：适配器返回实际格式与 kind.outputFormat 不一致时，重命名输出文件', async () => {
  const h = setup();
  try {
    const provider = openaiProvider(h.engine);
    const fetchMock = fetchRecorder(() => new Response(new Uint8Array(WAV), { status: 200, headers: { 'content-type': 'audio/wav' } }));
    const result = await withFetch(fetchMock, () => h.engine.synthesize({ text: '你好', providerId: provider.id }));
    assert.equal(result.format, 'wav');
    assert.match(result.filePath, /\.wav$/);
    assert.equal(parseWav(fs.readFileSync(result.filePath)).data.length, 4800);
  } finally {
    h.cleanup();
  }
});

test('synthesize：fileNameHint 只接受安全字符', async () => {
  const h = setup();
  try {
    const provider = openaiProvider(h.engine);
    const fetchMock = fetchRecorder(() => mp3Response());
    const safe = await withFetch(fetchMock, () => h.engine.synthesize({ text: 'x', providerId: provider.id, fileNameHint: 'hello_1' }));
    assert.match(path.basename(safe.filePath), /-hello_1\.mp3$/);
    const unsafe = await withFetch(fetchMock, () => h.engine.synthesize({ text: 'x', providerId: provider.id, fileNameHint: '../../etc/passwd' }));
    assert.equal(path.dirname(unsafe.filePath), h.engine.audioDir(), '危险 hint 必须被忽略');
  } finally {
    h.cleanup();
  }
});

// ── 错误码 ─────────────────────────────────────────────────

test('synthesize：错误统一 .code 与中文消息', async () => {
  const h = setup();
  try {
    const provider = openaiProvider(h.engine);
    const noFetch = async () => { throw new Error('不应发起网络请求'); };

    await withFetch(noFetch, async () => {
      await assert.rejects(h.engine.synthesize({ text: '   ', providerId: provider.id }),
        (err) => err.code === 'TTS_EMPTY_TEXT' && /文字不能为空/.test(err.message));
      await assert.rejects(h.engine.synthesize({ text: 'x', providerId: 'tts_nope' }),
        (err) => err.code === 'TTS_PROVIDER_NOT_FOUND');
      await assert.rejects(h.engine.synthesize({ text: 'x', settings: { voice: { enabled: false } } }),
        (err) => err.code === 'TTS_DISABLED' && /未启用/.test(err.message));
    });

    // 全部供应商停用：启用语音也报「没有可用的供应商」；显式指定则报「已停用」
    h.engine.saveProvider({ id: provider.id, enabled: false });
    await withFetch(noFetch, async () => {
      await assert.rejects(h.engine.synthesize({ text: 'x', settings: { voice: { enabled: true } } }),
        (err) => err.code === 'TTS_PROVIDER_NOT_FOUND' && /没有可用的 TTS 供应商/.test(err.message));
      await assert.rejects(h.engine.synthesize({ text: 'x', providerId: provider.id }),
        (err) => err.code === 'TTS_DISABLED' && /已停用/.test(err.message));
    });
    h.engine.saveProvider({ id: provider.id, enabled: true });

    // 上游 500
    await withFetch(async () => jsonResponse({ error: { message: 'upstream exploded' } }, 500), async () => {
      await assert.rejects(h.engine.synthesize({ text: 'x', providerId: provider.id }),
        (err) => err.code === 'TTS_UPSTREAM' && /HTTP 500/.test(err.message) && /upstream exploded/.test(err.message));
    });

    // 超时（fetch 抛 AbortError → http 层映射 TTS_TIMEOUT）
    await withFetch(async () => { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }, async () => {
      await assert.rejects(h.engine.synthesize({ text: 'x', providerId: provider.id }),
        (err) => err.code === 'TTS_TIMEOUT');
    });

    // 供应商配置缺失（mimo 缺 secret）
    const mimo = h.engine.saveProvider({ name: 'MiMo', kind: 'mimo', config: {} });
    await withFetch(noFetch, async () => {
      await assert.rejects(h.engine.synthesize({ text: 'x', providerId: mimo.id }),
        (err) => err.code === 'TTS_CONFIG' && /API Key/.test(err.message));
    });
  } finally {
    h.cleanup();
  }
});

// ── 试听 ───────────────────────────────────────────────────

test('test：返回 audioBase64/mimeType，默认测试文案，试听文件用完即删', async () => {
  const h = setup();
  try {
    const provider = openaiProvider(h.engine);
    const fetchMock = fetchRecorder(() => mp3Response());
    const result = await withFetch(fetchMock, () => h.engine.test({ providerId: provider.id }));

    assert.equal(result.ok, true);
    assert.equal(result.providerId, provider.id);
    assert.equal(result.kind, 'openai');
    assert.equal(result.format, 'mp3');
    assert.equal(result.mimeType, 'audio/mpeg');
    assert.equal(result.bytes, MP3.length);
    assert.equal(result.audioBase64, MP3.toString('base64'));
    assert.equal(result.tooLarge, undefined);
    assert.equal(JSON.parse(fetchMock.calls[0].init.body).input, '你好，这是一条语音合成测试。');

    // 试听文件不留在音频目录
    assert.deepEqual(fs.readdirSync(h.engine.audioDir()), []);

    // 自定义文案 + 过长截断到 500
    const custom = await withFetch(fetchMock, () => h.engine.test({ providerId: provider.id, text: '  播放这句  ' }));
    assert.equal(JSON.parse(fetchMock.calls[1].init.body).input, '播放这句');

    // 缺少 providerId
    await assert.rejects(h.engine.test({}), (err) => err.code === 'TTS_CONFIG' && /id/.test(err.message));
  } finally {
    h.cleanup();
  }
});

test('test：音频 base64 超过 4MB 时省略并返回 tooLarge', async () => {
  const h = setup();
  try {
    const provider = openaiProvider(h.engine);
    const big = Buffer.alloc(4 * 1024 * 1024);
    big[0] = 0xff;
    big[1] = 0xf3;
    const fetchMock = fetchRecorder(() => new Response(new Uint8Array(big), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const result = await withFetch(fetchMock, () => h.engine.test({ providerId: provider.id }));
    assert.equal(result.tooLarge, true);
    assert.equal('audioBase64' in result, false, '过大的 base64 不应返回');
    assert.equal(result.bytes, big.length);
    assert.equal(result.mimeType, 'audio/mpeg');
  } finally {
    h.cleanup();
  }
});

// ── 装配约束 ───────────────────────────────────────────────

test('createTtsEngine：缺少 db / dataDir 时给明确 TypeError', () => {
  assert.throws(() => createTtsEngine({}), /需要由 lib\/core\/db\.js 的 openDb\(\) 打开的 db/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-tts-engine-boot-'));
  const db = openDb(path.join(dir, 'x.db'));
  try {
    assert.throws(() => createTtsEngine({ db }), /需要 dataDir/);
  } finally {
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audioDir：懒创建 dataDir/tts-media', () => {
  const h = setup();
  try {
    const dir = h.engine.audioDir();
    assert.equal(dir, path.join(h.dir, 'tts-media'));
    assert.equal(fs.statSync(dir).isDirectory(), true);
    assert.equal(h.engine.audioDir(), dir, '重复调用返回同一目录');
  } finally {
    h.cleanup();
  }
});
