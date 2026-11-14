/**
 * test/asr —— ASR 引擎（core/asr）：供应商选择 / DeepSeek ASR 协议 / 错误码。
 *
 * 全部离线：mock 全局 fetch；音频用本地临时 WAV（16bit PCM）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb } from '../lib/core/db.js';
import { encodeWav } from '../lib/core/tts/audio.js';
import { createAsrEngine } from '../lib/core/asr/index.js';
import { readAccountToken } from '../lib/core/asr/credentials.js';

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const WAV = encodeWav(Buffer.alloc(3200));

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-asr-'));
  const db = openDb(path.join(dir, 'asr.db'));
  const engine = createAsrEngine({ db, logger: QUIET });
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

test('asr：供应商 CRUD 只接受 ASR kind；TTS kind 被拒绝', () => {
  const h = setup();
  try {
    assert.equal(h.engine.listProviders().length, 0);
    assert.throws(() => h.engine.saveProvider({ name: 'x', kind: 'edge' }), /ASR/);
    const created = h.engine.saveProvider({
      name: 'DeepSeek ASR',
      kind: 'deepseek-asr',
      secret: 'sk-ds',
      config: { baseUrl: 'https://api.deepseek.com' },
    });
    assert.match(created.id, /^tts_[0-9a-f]{12}$/);
    assert.equal(created.capability, 'asr');
    assert.equal(created.group, 'asr');
    assert.equal(h.engine.listProviders().length, 1);
    assert.equal(h.engine.getProvider(created.id).hasSecret, true);
    assert.equal(h.engine.deleteProvider(created.id), true);
    assert.equal(h.engine.deleteProvider('nope'), false);
  } finally {
    h.cleanup();
  }
});

test('asr：DeepSeek /v1/tools/asr 协议 + 选择顺序 + 错误', async () => {
  const h = setup();
  const wavPath = path.join(h.dir, 'voice.wav');
  fs.writeFileSync(wavPath, WAV);
  try {
    const provider = h.engine.saveProvider({
      name: 'DeepSeek ASR',
      kind: 'deepseek-asr',
      secret: 'sk-ds',
      config: { baseUrl: 'https://api.deepseek.com' },
    });
    assert.equal(h.engine.enabled({ asr: { enabled: true } }), true);
    assert.equal(h.engine.enabled({ asr: { enabled: false } }), false);

    const calls = [];
    const result = await withFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        request_id: 'req_1',
        text: '今天上海天气怎么样？',
        duration_ms: 3200,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }, async () => h.engine.transcribe({
      settings: { asr: { enabled: true, provider: provider.id } },
      filePath: wavPath,
    }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/asr');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-ds');
    assert.ok(calls[0].init.body instanceof FormData);
    assert.ok(calls[0].init.body.get('file'));
    assert.equal(result.text, '今天上海天气怎么样？');
    assert.equal(result.durationMs, 3200);
    assert.equal(result.providerId, provider.id);

    // 没有 ASR 供应商时给出可读错误
    h.engine.deleteProvider(provider.id);
    await assert.rejects(h.engine.transcribe({ settings: { asr: { enabled: true } }, filePath: wavPath }),
      (err) => err.code === 'ASR_PROVIDER_NOT_FOUND' && /ASR 供应商/.test(err.message));

    // 非 WAV/Ogg 音频：本地即可读错误
    const badProvider = h.engine.saveProvider({ name: 'bad', kind: 'deepseek-asr', secret: 'k' });
    const badPath = path.join(h.dir, 'bad.bin');
    fs.writeFileSync(badPath, Buffer.from('not audio'));
    await assert.rejects(h.engine.transcribe({ providerId: badProvider.id, filePath: badPath }),
      (err) => err.code === 'ASR_CONFIG' && /WAV|Ogg/.test(err.message));
  } finally {
    h.cleanup();
  }
});

test('asr：上游错误体转可读消息', async () => {
  const h = setup();
  const wavPath = path.join(h.dir, 'voice.wav');
  fs.writeFileSync(wavPath, WAV);
  try {
    const provider = h.engine.saveProvider({ name: 'DS', kind: 'deepseek-asr', secret: 'k' });
    await withFetch(async () => new Response(JSON.stringify({ error: { message: 'audio too long' } }), {
      status: 413, headers: { 'content-type': 'application/json' },
    }), async () => {
      await assert.rejects(h.engine.transcribe({ providerId: provider.id, filePath: wavPath }),
        (err) => err.code === 'ASR_UPSTREAM' && /413/.test(err.message) && /audio too long/.test(err.message));
    });
  } finally {
    h.cleanup();
  }
});


test('asr：DeepSeek 账号登录鉴权（x-dsh-auth-token）+ 凭证文件解析', async () => {
  const h = setup();
  const wavPath = path.join(h.dir, 'voice.wav');
  fs.writeFileSync(wavPath, WAV);
  const credPath = path.join(h.dir, 'credentials.yaml');
  fs.writeFileSync(credPath, [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-test',
    'records:',
    '  deepseek-account-platform/default:',
    '    kind: account',
    '    payload:',
    '      version: 1',
    '      token: test-account-token',
    '      issuer: https://platform.deepseek.com',
    '',
  ].join('\n'));
  try {
    const provider = h.engine.saveProvider({
      name: 'DS account',
      kind: 'deepseek-asr',
      config: { baseUrl: 'https://api.deepseek.com', authMode: 'account', credentialPath: credPath },
    });
    let headers = null;
    const result = await withFetch(async (url, init) => {
      headers = init.headers;
      return new Response(JSON.stringify({ request_id: 'r1', text: '账号鉴权转写', duration_ms: 1200 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }, async () => h.engine.transcribe({ providerId: provider.id, filePath: wavPath }));
    assert.equal(headers['x-dsh-auth-token'], 'test-account-token');
    assert.equal(headers.Authorization, undefined);
    assert.equal(result.text, '账号鉴权转写');
    assert.equal(readAccountToken({ credentialPath: credPath }), 'test-account-token');
  } finally {
    h.cleanup();
  }
});

test('asr：MiMo-V2.5-ASR chat/completions 协议', async () => {
  const h = setup();
  const wavPath = path.join(h.dir, 'voice.wav');
  fs.writeFileSync(wavPath, WAV);
  try {
    const provider = h.engine.saveProvider({
      name: 'MiMo ASR',
      kind: 'mimo-asr',
      secret: 'mimo-key',
      config: { baseUrl: 'https://api.xiaomimimo.com/v1', language: 'zh' },
    });
    let captured = null;
    const result = await withFetch(async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '你好，MiMo 识别。' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }, async () => h.engine.transcribe({ providerId: provider.id, filePath: wavPath }));
    assert.equal(captured.url, 'https://api.xiaomimimo.com/v1/chat/completions');
    assert.equal(captured.init.headers['api-key'], 'mimo-key');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, 'mimo-v2.5-asr');
    assert.equal(body.asr_options.language, 'zh');
    const content = body.messages[0].content[0];
    assert.equal(content.type, 'input_audio');
    assert.match(content.input_audio.data, /^data:audio\/wav;base64,/);
    assert.equal(result.text, '你好，MiMo 识别。');
    assert.equal(result.providerId, provider.id);
  } finally {
    h.cleanup();
  }
});

test('asr：OpenAI 兼容 /audio/transcriptions（multipart + JSON text）', async () => {
  const h = setup();
  const wavPath = path.join(h.dir, 'voice.wav');
  fs.writeFileSync(wavPath, WAV);
  try {
    const provider = h.engine.saveProvider({
      name: 'Local whisper server',
      kind: 'openai-asr',
      secret: 'sk-local',
      config: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'whisper-1', language: 'zh' },
    });
    let captured = null;
    const result = await withFetch(async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ text: '本地服务识别结果' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }, async () => h.engine.transcribe({ providerId: provider.id, filePath: wavPath }));
    assert.equal(captured.url, 'http://127.0.0.1:8000/v1/audio/transcriptions');
    assert.equal(captured.init.headers.Authorization, 'Bearer sk-local');
    assert.ok(captured.init.body instanceof FormData);
    assert.equal(captured.init.body.get('model'), 'whisper-1');
    assert.equal(captured.init.body.get('language'), 'zh');
    assert.ok(captured.init.body.get('file'));
    assert.equal(result.text, '本地服务识别结果');
  } finally {
    h.cleanup();
  }
});

test('asr：faster-whisper 本地路径校验（缺 python/模型给可读错误）', async () => {
  const h = setup();
  const wavPath = path.join(h.dir, 'voice.wav');
  fs.writeFileSync(wavPath, WAV);
  try {
    const provider = h.engine.saveProvider({
      name: 'local whisper',
      kind: 'faster-whisper',
      config: { pythonPath: path.join(h.dir, 'no-python'), modelPath: path.join(h.dir, 'no-model') },
    });
    await assert.rejects(
      h.engine.transcribe({ providerId: provider.id, filePath: wavPath }),
      (err) => err.code === 'ASR_CONFIG' && /python|模型/i.test(err.message),
    );
    const okProvider = h.engine.saveProvider({
      name: 'local whisper 2',
      kind: 'faster-whisper',
      config: { pythonPath: process.execPath, modelPath: path.join(h.dir, 'no-model') },
    });
    await assert.rejects(
      h.engine.transcribe({ providerId: okProvider.id, filePath: wavPath }),
      (err) => err.code === 'ASR_CONFIG' && /模型/.test(err.message),
    );
  } finally {
    h.cleanup();
  }
});
