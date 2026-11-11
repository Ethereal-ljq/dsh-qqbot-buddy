/**
 * test/tts-adapters —— 六个 TTS 适配器 + http/edge-token 工具（全部离线）。
 *
 * 网络：mock 全局 fetch；Edge：注入 Fake WebSocket（EventEmitter 风格，不联网）；
 * 本地命令：注入 fake spawn（不执行真实子进程）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  assertHttpUrl, decodeBase64Audio, describeErrorText, describePayloadError, formatOfMediaType,
  getByPath, mimeTypeFor, sniffAudioMediaType, truncate,
} from '../lib/core/tts/http.js';
import { encodeWav } from '../lib/core/tts/audio.js';
import {
  EDGE_TOKEN_VERSION, EDGE_TRUSTED_CLIENT_TOKEN, secMsGec,
} from '../lib/core/tts/edge-token.js';
import { createEdgeAdapter } from '../lib/core/tts/adapters/edge.js';
import mimoAdapter from '../lib/core/tts/adapters/mimo.js';
import bailianAdapter from '../lib/core/tts/adapters/bailian.js';
import openaiAdapter from '../lib/core/tts/adapters/openai.js';
import customAdapter from '../lib/core/tts/adapters/custom.js';
import commandAdapter, { shellQuote } from '../lib/core/tts/adapters/command.js';

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const MP3 = Buffer.from([0xff, 0xf3, 0x44, 0xc4, 0x00, 0x00, 0x01, 0x02, 0x03]);
const WAV = encodeWav(Buffer.alloc(4800));

function tempDir(prefix = 'qqbot-tts-adapter-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function audioResponse(bytes, contentType = 'audio/mpeg', status = 200) {
  return new Response(new Uint8Array(bytes), { status, headers: { 'content-type': contentType } });
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

function provider(kind, config = {}, secret = '') {
  return { id: 'tts_' + kind, name: kind, kind, enabled: true, config, secret };
}

// ── http 工具 ──────────────────────────────────────────────

test('http 工具：URL 校验 / 音频嗅探 / base64 / 点号路径 / 错误提取', () => {
  assert.throws(() => assertHttpUrl('ftp://example.com/a'), (err) => err.code === 'TTS_CONFIG' && /只支持 http/.test(err.message));
  assert.throws(() => assertHttpUrl('not a url'), (err) => err.code === 'TTS_CONFIG');
  assert.equal(assertHttpUrl('https://example.com/x').protocol, 'https:');

  assert.equal(sniffAudioMediaType(MP3), 'audio/mpeg');
  assert.equal(sniffAudioMediaType(WAV), 'audio/wav');
  assert.equal(sniffAudioMediaType(Buffer.from('hello')), null);
  assert.equal(formatOfMediaType('audio/wav'), 'wav');
  assert.equal(mimeTypeFor('wav'), 'audio/wav');
  assert.equal(mimeTypeFor('mp3'), 'audio/mpeg');

  const dataUri = 'data:audio/wav;base64,' + WAV.toString('base64');
  const decoded = decodeBase64Audio(dataUri);
  assert.deepEqual(decoded.buffer, WAV);
  assert.equal(decoded.format, 'wav');
  assert.throws(() => decodeBase64Audio(''), (err) => err.code === 'TTS_UPSTREAM');
  assert.throws(() => decodeBase64Audio('@@@'), (err) => err.code === 'TTS_UPSTREAM');

  const payload = { a: { b: [{ c: 'value' }] } };
  assert.equal(getByPath(payload, 'a.b.0.c'), 'value');
  assert.equal(getByPath(payload, 'a.b[0].c'), 'value');
  assert.equal(getByPath(payload, 'a.nope'), undefined);
  assert.equal(getByPath(payload, ''), payload);

  assert.equal(describePayloadError({ error: { message: 'bad key' } }), 'bad key');
  assert.equal(describePayloadError({ message: 'boom' }), 'boom');
  assert.equal(describePayloadError(null), '');
  assert.equal(describeErrorText('{"message":"校验失败"}'), '校验失败');
  assert.match(describeErrorText('上游原文'), /上游原文/);
  assert.equal(truncate('x'.repeat(600)).length, 500);
});

// ── Edge token（v2，确定性向量）────────────────────────────

test('edge v2 token：确定性向量 / 5 分钟桶 / 常量', () => {
  const expected = '2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2';
  assert.equal(secMsGec({ now: 1700000000000 }), expected);
  assert.equal(secMsGec({ now: () => 1700000000000 }), expected, 'now 支持函数注入');
  // 同一 5 分钟桶（+60s）token 不变；跨桶（+300s）变化
  assert.equal(secMsGec({ now: 1700000060000 }), expected);
  assert.notEqual(secMsGec({ now: 1700000300000 }), expected);
  assert.equal(EDGE_TOKEN_VERSION, '2-143.0.3650.96');
  assert.equal(EDGE_TRUSTED_CLIENT_TOKEN, '6A5AA1D4EAFF4E9FB37E23D68491D6F4');
  assert.match(expected, /^[0-9A-F]{16}-[0-9A-F]{64}$/);
});

// ── Edge 适配器（Fake WebSocket）───────────────────────────

class FakeWebSocket {
  static instances = [];
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.handlers = new Map();
    this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
  }
  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }
  emit(event, ...args) {
    for (const handler of [...(this.handlers.get(event) || [])]) handler(...args);
  }
  send(data) { this.sent.push(String(data)); }
  close() { this.closeCalls += 1; }
  static reset() { FakeWebSocket.instances = []; }
  static get last() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }
}

/** 按 Edge 协议拼一个二进制音频帧（2 字节大端 header 长度 + header JSON + 音频）。 */
function edgeAudioFrame(payload) {
  const header = Buffer.from(JSON.stringify({ Path: 'audio', ContentType: 'audio/mpeg' }));
  const out = Buffer.alloc(2 + header.length + payload.length);
  out.writeUInt16BE(header.length, 0);
  header.copy(out, 2);
  payload.copy(out, 2 + header.length);
  return out;
}

function edgeProvider(config = {}) {
  return provider('edge', {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+0%',
    pitch: '+0Hz',
    volume: '+0%',
    ...config,
  });
}

test('edge 适配器：URL/握手 headers/帧顺序/二进制拼接/落盘', async () => {
  const savedEnv = process.env.QQBOT_EDGE_TTS_URL;
  delete process.env.QQBOT_EDGE_TTS_URL;
  const dir = tempDir();
  FakeWebSocket.reset();
  try {
    const outPath = path.join(dir, 'edge.mp3');
    const adapter = createEdgeAdapter({ WebSocketImpl: FakeWebSocket, now: () => 1700000000000 });
    const promise = adapter.synthesize({
      provider: edgeProvider(),
      text: '你好 <world> & "引号"',
      options: { voice: 'zh-CN-YunxiNeural', speed: 1.1 },
      outPath,
      logger: QUIET,
    });
    const ws = FakeWebSocket.last;
    assert.ok(ws, '应创建 WebSocket 实例');

    const url = new URL(ws.url);
    assert.equal(url.protocol, 'wss:');
    assert.equal(url.hostname, 'speech.platform.bing.com');
    assert.equal(url.searchParams.get('TrustedClientToken'), EDGE_TRUSTED_CLIENT_TOKEN);
    assert.equal(url.searchParams.get('Sec-MS-GEC'), secMsGec({ now: 1700000000000 }));
    assert.equal(url.searchParams.get('Sec-MS-GEC-Version'), EDGE_TOKEN_VERSION);
    assert.match(url.searchParams.get('ConnectionId'), /^[0-9a-f]{32}$/);

    const headers = ws.options.headers || {};
    assert.equal(headers.Origin, 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold');
    assert.match(headers['User-Agent'], /Edg\/143\.0\.0\.0/);
    assert.match(headers.Cookie, /^muid=[0-9A-F]{32};$/);
    assert.equal(headers.Pragma, 'no-cache');
    assert.equal(headers['Cache-Control'], 'no-cache');
    assert.match(headers['Accept-Language'], /en-US/);

    // open 后才发帧：先 speech.config 再 ssml
    assert.equal(ws.sent.length, 0);
    ws.emit('open');
    assert.equal(ws.sent.length, 2);
    assert.match(ws.sent[0], /Path:speech\.config/);
    assert.match(ws.sent[0], /audio-24khz-48kbitrate-mono-mp3/);
    assert.match(ws.sent[0], /"sentenceBoundaryEnabled":"false"/);
    assert.match(ws.sent[0], /"wordBoundaryEnabled":"false"/);
    assert.match(ws.sent[1], /Path:ssml/);
    assert.match(ws.sent[1], /X-RequestId:[0-9a-f]{32}/);
    assert.match(ws.sent[1], /<voice name="zh-CN-YunxiNeural">/);
    assert.match(ws.sent[1], /rate="\+10%"/);
    assert.match(ws.sent[1], /xml:lang="zh-CN"/);
    // XML 转义：< > & " 不能原样出现
    assert.match(ws.sent[1], /你好 &lt;world&gt; &amp; &quot;引号&quot;/);

    ws.emit('message', edgeAudioFrame(Buffer.from([0x01, 0x02])), true);
    ws.emit('message', edgeAudioFrame(Buffer.from([0x03])), true);
    ws.emit('message', Buffer.from('X-RequestId:abc\r\nPath:turn.end\r\n\r\n{}'), false);

    const result = await promise;
    assert.equal(result.format, 'mp3');
    assert.equal(result.model, 'edge-tts');
    assert.equal(result.voice, 'zh-CN-YunxiNeural');
    assert.equal(result.bytes, 3);
    assert.deepEqual(fs.readFileSync(outPath), Buffer.from([0x01, 0x02, 0x03]));
    assert.ok(ws.closeCalls >= 1, '完成后应关闭连接');
  } finally {
    if (savedEnv === undefined) delete process.env.QQBOT_EDGE_TTS_URL;
    else process.env.QQBOT_EDGE_TTS_URL = savedEnv;
    FakeWebSocket.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edge 适配器：QQBOT_EDGE_TTS_URL 覆盖基址但仍拼鉴权 query', async () => {
  const savedEnv = process.env.QQBOT_EDGE_TTS_URL;
  const dir = tempDir();
  FakeWebSocket.reset();
  try {
    process.env.QQBOT_EDGE_TTS_URL = 'ws://127.0.0.1:18080/edge';
    const adapter = createEdgeAdapter({ WebSocketImpl: FakeWebSocket, now: () => 1700000000000 });
    const promise = adapter.synthesize({
      provider: edgeProvider(),
      text: '测试',
      options: {},
      outPath: path.join(dir, 'edge.mp3'),
      logger: QUIET,
    });
    const ws = FakeWebSocket.last;
    const url = new URL(ws.url);
    assert.equal(url.protocol, 'ws:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '18080');
    assert.equal(url.pathname, '/edge');
    assert.equal(url.searchParams.get('TrustedClientToken'), EDGE_TRUSTED_CLIENT_TOKEN);
    assert.equal(url.searchParams.get('Sec-MS-GEC-Version'), EDGE_TOKEN_VERSION);
    ws.emit('open');
    ws.emit('message', edgeAudioFrame(MP3), true);
    ws.emit('message', Buffer.from('Path:turn.end\r\n'), false);
    const result = await promise;
    assert.equal(result.bytes, MP3.length);
  } finally {
    if (savedEnv === undefined) delete process.env.QQBOT_EDGE_TTS_URL;
    else process.env.QQBOT_EDGE_TTS_URL = savedEnv;
    FakeWebSocket.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edge 适配器：连接失败/提前关闭/无音频/超时/取消 都给出可读错误', async () => {
  const dir = tempDir();
  FakeWebSocket.reset();
  const makeAdapter = (config = {}) => createEdgeAdapter({ WebSocketImpl: FakeWebSocket, now: () => 1700000000000 });
  try {
    // error 事件
    let promise = makeAdapter().synthesize({
      provider: edgeProvider(), text: 'x', options: {}, outPath: path.join(dir, 'a.mp3'), logger: QUIET,
    });
    FakeWebSocket.last.emit('error', new Error('boom'));
    await assert.rejects(promise, (err) => err.code === 'TTS_UPSTREAM' && /连接失败/.test(err.message));

    // 提前关闭
    promise = makeAdapter().synthesize({
      provider: edgeProvider(), text: 'x', options: {}, outPath: path.join(dir, 'b.mp3'), logger: QUIET,
    });
    FakeWebSocket.last.emit('open');
    FakeWebSocket.last.emit('close', 1006);
    await assert.rejects(promise, (err) => err.code === 'TTS_UPSTREAM' && /提前关闭/.test(err.message));

    // turn.end 但没有任何音频
    promise = makeAdapter().synthesize({
      provider: edgeProvider(), text: 'x', options: {}, outPath: path.join(dir, 'c.mp3'), logger: QUIET,
    });
    FakeWebSocket.last.emit('open');
    FakeWebSocket.last.emit('message', Buffer.from('Path:turn.end'), false);
    await assert.rejects(promise, (err) => err.code === 'TTS_UPSTREAM' && /没有返回音频/.test(err.message));

    // 超时
    promise = makeAdapter({ timeoutMs: 20 }).synthesize({
      provider: edgeProvider({ timeoutMs: 20 }), text: 'x', options: {}, outPath: path.join(dir, 'd.mp3'), logger: QUIET,
    });
    await assert.rejects(promise, (err) => err.code === 'TTS_TIMEOUT' && /超时/.test(err.message));

    // 调用方取消
    const controller = new AbortController();
    promise = makeAdapter().synthesize({
      provider: edgeProvider(), text: 'x', options: {}, outPath: path.join(dir, 'e.mp3'), signal: controller.signal, logger: QUIET,
    });
    controller.abort();
    await assert.rejects(promise, (err) => err.code === 'TTS_ABORTED' && /取消/.test(err.message));
  } finally {
    FakeWebSocket.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── MiMo ───────────────────────────────────────────────────

test('mimo 适配器：请求协议 / base64 响应 / 落盘', async () => {
  const dir = tempDir();
  try {
    const requests = [];
    const outPath = path.join(dir, 'mimo.wav');
    const result = await withFetch(async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({ choices: [{ message: { audio: { data: WAV.toString('base64') } } }] });
    }, async () => mimoAdapter.synthesize({
      provider: provider('mimo', {
        baseUrl: 'https://api.example.com/v1/',
        model: 'mimo-v2.5-tts',
        voice: '冰糖',
        style: '温柔一点',
      }, 'key-123'),
      text: '你好呀',
      options: {},
      outPath,
      logger: QUIET,
    }));

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.example.com/v1/chat/completions');
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(requests[0].init.headers['api-key'], 'key-123');
    assert.match(requests[0].init.headers['Content-Type'], /application\/json/);
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.model, 'mimo-v2.5-tts');
    assert.deepEqual(body.messages, [
      { role: 'user', content: '温柔一点' },
      { role: 'assistant', content: '你好呀' },
    ]);
    assert.deepEqual(body.audio, { format: 'wav', voice: '冰糖' });

    assert.equal(result.format, 'wav');
    assert.equal(result.model, 'mimo-v2.5-tts');
    assert.equal(result.voice, '冰糖');
    assert.equal(result.bytes, WAV.length);
    assert.deepEqual(fs.readFileSync(outPath), WAV);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mimo 适配器：voiceclone 样本转 data URI；错误分支可读', async () => {
  const dir = tempDir();
  try {
    const samplePath = path.join(dir, 'sample.wav');
    fs.writeFileSync(samplePath, WAV);
    let capturedBody = null;
    await withFetch(async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return jsonResponse({ choices: [{ message: { audio: { data: WAV.toString('base64') } } }] });
    }, async () => mimoAdapter.synthesize({
      provider: provider('mimo', {
        baseUrl: 'https://api.example.com/v1',
        model: 'mimo-v2.5-tts-voiceclone',
        voice: '',
        style: '',
        samplePath,
      }, 'key'),
      text: '克隆音色',
      options: {},
      outPath: path.join(dir, 'clone.wav'),
      logger: QUIET,
    }));
    assert.match(capturedBody.audio.voice, /^data:audio\/wav;base64,/);
    assert.equal(Buffer.from(capturedBody.audio.voice.split(',')[1], 'base64').length, WAV.length);

    // 缺 secret
    await assert.rejects(mimoAdapter.synthesize({
      provider: provider('mimo', { model: 'mimo-v2.5-tts', voice: 'x' }, ''),
      text: 'x', options: {}, outPath: path.join(dir, 'e.wav'), logger: QUIET,
    }), (err) => err.code === 'TTS_CONFIG' && /API Key/.test(err.message));

    // 上游 401
    await withFetch(async () => jsonResponse({ error: { message: 'bad key' } }, 401), async () => {
      await assert.rejects(mimoAdapter.synthesize({
        provider: provider('mimo', { model: 'mimo-v2.5-tts', voice: 'x' }, 'k'),
        text: 'x', options: {}, outPath: path.join(dir, 'f.wav'), logger: QUIET,
      }), (err) => err.code === 'TTS_UPSTREAM' && /HTTP 401/.test(err.message) && /bad key/.test(err.message));
    });

    // 响应没有音频
    await withFetch(async () => jsonResponse({ choices: [{ message: {} }] }), async () => {
      await assert.rejects(mimoAdapter.synthesize({
        provider: provider('mimo', { model: 'mimo-v2.5-tts', voice: 'x' }, 'k'),
        text: 'x', options: {}, outPath: path.join(dir, 'g.wav'), logger: QUIET,
      }), (err) => err.code === 'TTS_UPSTREAM' && /没有音频数据/.test(err.message));
    });

    // voiceclone 缺样本路径
    await assert.rejects(mimoAdapter.synthesize({
      provider: provider('mimo', { model: 'mimo-v2.5-tts-voiceclone', samplePath: '' }, 'k'),
      text: 'x', options: {}, outPath: path.join(dir, 'h.wav'), logger: QUIET,
    }), (err) => err.code === 'TTS_CONFIG' && /样本音频路径/.test(err.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 百炼 ───────────────────────────────────────────────────

test('bailian 适配器：URL 响应自动下载 / base64 响应 / 请求协议', async () => {
  const dir = tempDir();
  try {
    const calls = [];
    const result = await withFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('multimodal-generation')) {
        return jsonResponse({ output: { audio: { url: 'https://cdn.example.com/tts/a.wav' } } });
      }
      return audioResponse(WAV, 'audio/wav');
    }, async () => bailianAdapter.synthesize({
      provider: provider('bailian', {
        baseUrl: 'https://dashscope.example.com/api/v1',
        model: 'qwen3-tts-flash',
        voice: 'Cherry',
        languageType: 'Chinese',
      }, 'sk-dash'),
      text: '欢迎使用百炼',
      options: {},
      outPath: path.join(dir, 'bailian.wav'),
      logger: QUIET,
    }));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://dashscope.example.com/api/v1/services/aigc/multimodal-generation/generation');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-dash');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.input, { text: '欢迎使用百炼', voice: 'Cherry', language_type: 'Chinese' });
    assert.equal(body.model, 'qwen3-tts-flash');
    assert.equal(calls[1].url, 'https://cdn.example.com/tts/a.wav');
    assert.equal(calls[1].init.method, 'GET');
    assert.equal(result.format, 'wav');
    assert.equal(result.bytes, WAV.length);

    // base64 分支
    await withFetch(async () => jsonResponse({ output: { audio: { data: WAV.toString('base64') } } }), async () => {
      const inline = await bailianAdapter.synthesize({
        provider: provider('bailian', { baseUrl: 'https://dashscope.example.com/api/v1', model: 'qwen-tts', voice: 'Cherry' }, 'sk'),
        text: '你好', options: {}, outPath: path.join(dir, 'inline.wav'), logger: QUIET,
      });
      assert.equal(inline.bytes, WAV.length);
    });

    // 缺 secret / 响应没有音频
    await assert.rejects(bailianAdapter.synthesize({
      provider: provider('bailian', { model: 'qwen-tts', voice: 'Cherry' }, ''),
      text: 'x', options: {}, outPath: path.join(dir, 'no-secret.wav'), logger: QUIET,
    }), (err) => err.code === 'TTS_CONFIG');
    await withFetch(async () => jsonResponse({ output: {} }), async () => {
      await assert.rejects(bailianAdapter.synthesize({
        provider: provider('bailian', { model: 'qwen-tts', voice: 'Cherry' }, 'sk'),
        text: 'x', options: {}, outPath: path.join(dir, 'empty.wav'), logger: QUIET,
      }), (err) => err.code === 'TTS_UPSTREAM' && /没有音频数据/.test(err.message));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── OpenAI 兼容 ────────────────────────────────────────────

test('openai 适配器：/audio/speech 请求与二进制响应', async () => {
  const dir = tempDir();
  try {
    const calls = [];
    const result = await withFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      return audioResponse(MP3, 'audio/mpeg');
    }, async () => openaiAdapter.synthesize({
      provider: provider('openai', {
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o-mini-tts',
        voice: 'alloy',
        format: 'mp3',
        speed: 1,
        instructions: '默认语气',
      }, 'sk-openai'),
      text: '你好世界',
      options: { voice: 'nova', speed: 1.2, style: '活泼一点' },
      outPath: path.join(dir, 'openai.mp3'),
      logger: QUIET,
    }));

    assert.equal(calls[0].url, 'https://api.example.com/v1/audio/speech');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-openai');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'gpt-4o-mini-tts');
    assert.equal(body.input, '你好世界');
    assert.equal(body.voice, 'nova');
    assert.equal(body.response_format, 'mp3');
    assert.equal(body.speed, 1.2);
    assert.equal(body.instructions, '活泼一点');
    assert.equal(result.format, 'mp3');
    assert.equal(result.bytes, MP3.length);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'openai.mp3')), MP3);

    // 实际返回 wav（配置 mp3）：按 magic bytes 嗅探为 wav
    await withFetch(async () => audioResponse(WAV, 'audio/wav'), async () => {
      const sniffed = await openaiAdapter.synthesize({
        provider: provider('openai', { baseUrl: 'https://api.example.com/v1', model: 'tts-1', voice: 'alloy', format: 'mp3' }, ''),
        text: 'x', options: {}, outPath: path.join(dir, 'sniffed.mp3'), logger: QUIET,
      });
      assert.equal(sniffed.format, 'wav', '按 content-type/magic bytes 嗅探实际格式');
    });

    // 无鉴权本地服务：不发送 Authorization
    await withFetch(async (url, init) => {
      assert.equal('Authorization' in init.headers, false);
      return audioResponse(MP3, 'audio/mpeg');
    }, async () => openaiAdapter.synthesize({
      provider: provider('openai', { baseUrl: 'http://127.0.0.1:8080/v1', model: 'tts-1', voice: 'alloy', format: 'mp3' }, ''),
      text: 'x', options: {}, outPath: path.join(dir, 'local.mp3'), logger: QUIET,
    }));

    // 上游 500 JSON 错误（消息截断在 500 字符内）
    await withFetch(async () => jsonResponse({ error: { message: 'upstream exploded' } }, 500), async () => {
      await assert.rejects(openaiAdapter.synthesize({
        provider: provider('openai', { baseUrl: 'https://api.example.com/v1', model: 'tts-1', voice: 'alloy', format: 'mp3' }, 'sk'),
        text: 'x', options: {}, outPath: path.join(dir, 'err.mp3'), logger: QUIET,
      }), (err) => err.code === 'TTS_UPSTREAM' && /HTTP 500/.test(err.message) && /upstream exploded/.test(err.message));
    });

    // HTTP 200 但返回 JSON 错误体（常见中转坑）
    await withFetch(async () => jsonResponse({ error: { message: 'quota exceeded' } }), async () => {
      await assert.rejects(openaiAdapter.synthesize({
        provider: provider('openai', { baseUrl: 'https://api.example.com/v1', model: 'tts-1', voice: 'alloy', format: 'mp3' }, 'sk'),
        text: 'x', options: {}, outPath: path.join(dir, 'json200.mp3'), logger: QUIET,
      }), (err) => err.code === 'TTS_UPSTREAM' && /不是音频/.test(err.message) && /quota exceeded/.test(err.message));
    });

    // 超时错误映射（模拟 fetch 直接抛 AbortError）
    await withFetch(async () => { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }, async () => {
      await assert.rejects(openaiAdapter.synthesize({
        provider: provider('openai', { baseUrl: 'https://api.example.com/v1', model: 'tts-1', voice: 'alloy', format: 'mp3' }, 'sk'),
        text: 'x', options: {}, outPath: path.join(dir, 'timeout.mp3'), logger: QUIET,
      }), (err) => err.code === 'TTS_TIMEOUT');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 自定义 HTTP ────────────────────────────────────────────

test('custom 适配器：URL/Header/Body 模板渲染 + secret 注入 + 三种响应类型', async () => {
  const dir = tempDir();
  try {
    const calls = [];
    const config = {
      url: 'https://example.com/tts?text={{text}}&voice={{voice}}',
      method: 'POST',
      headers: { 'X-Trace': '{{style}}' },
      bodyTemplate: '{"t":"{{text}}","s":"{{speed}}"}',
      responseType: 'audio',
      responsePath: '',
      format: 'mp3',
      secretHeader: 'Authorization',
      secretPrefix: 'Bearer ',
    };
    const result = await withFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      return audioResponse(MP3, 'audio/mpeg');
    }, async () => customAdapter.synthesize({
      provider: provider('custom', config, 's3cret'),
      text: '文字 "引号"',
      options: { voice: 'cherry', style: '温柔 一点', speed: 1.2 },
      outPath: path.join(dir, 'custom.mp3'),
      logger: QUIET,
    }));

    const requestUrl = new URL(calls[0].url);
    assert.equal(requestUrl.searchParams.get('text'), '文字 "引号"', 'URL 占位符应 URL 编码后还原一致');
    assert.equal(requestUrl.searchParams.get('voice'), 'cherry');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['X-Trace'], '温柔 一点');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer s3cret');
    assert.match(calls[0].init.headers['Content-Type'], /application\/json/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.t, '文字 "引号"', 'body 模板里的引号应被 JSON 转义且可解析');
    assert.equal(body.s, '1.2');
    assert.equal(result.format, 'mp3');
    assert.equal(result.bytes, MP3.length);

    // json_base64
    await withFetch(async () => jsonResponse({ data: { audio: WAV.toString('base64') } }), async () => {
      const inline = await customAdapter.synthesize({
        provider: provider('custom', {
          url: 'https://example.com/tts',
          method: 'POST',
          headers: {},
          bodyTemplate: '{"text":"{{text}}"}',
          responseType: 'json_base64',
          responsePath: 'data.audio',
          format: 'wav',
          secretHeader: '',
          secretPrefix: '',
        }),
        text: '你好',
        options: {},
        outPath: path.join(dir, 'custom-b64.wav'),
        logger: QUIET,
      });
      assert.equal(inline.bytes, WAV.length);
      assert.equal(inline.format, 'wav');
    });

    // json_url
    await withFetch(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('example.com/tts')) {
        return jsonResponse({ result: { url: 'https://cdn.example.com/audio/out.mp3' } });
      }
      return audioResponse(MP3, 'audio/mpeg');
    }, async () => {
      const downloaded = await customAdapter.synthesize({
        provider: provider('custom', {
          url: 'https://example.com/tts',
          method: 'POST',
          headers: {},
          bodyTemplate: '{"text":"{{text}}"}',
          responseType: 'json_url',
          responsePath: 'result.url',
          format: 'mp3',
          secretHeader: '',
          secretPrefix: '',
        }),
        text: '下载',
        options: {},
        outPath: path.join(dir, 'custom-url.mp3'),
        logger: QUIET,
      });
      assert.equal(downloaded.bytes, MP3.length);
      assert.equal(downloaded.format, 'mp3');
    });

    // JSON 路径取不到值
    await withFetch(async () => jsonResponse({ result: {} }), async () => {
      await assert.rejects(customAdapter.synthesize({
        provider: provider('custom', {
          url: 'https://example.com/tts',
          method: 'POST',
          headers: {},
          bodyTemplate: '{}',
          responseType: 'json_base64',
          responsePath: 'result.audio',
          format: 'mp3',
          secretHeader: '',
          secretPrefix: '',
        }),
        text: 'x', options: {}, outPath: path.join(dir, 'missing.mp3'), logger: QUIET,
      }), (err) => err.code === 'TTS_UPSTREAM' && /没有找到字段/.test(err.message));
    });

    // 非法 method / 非 http URL
    await assert.rejects(customAdapter.synthesize({
      provider: provider('custom', { url: 'https://example.com/tts', method: 'PUT', bodyTemplate: '{}', responseType: 'audio' }),
      text: 'x', options: {}, outPath: path.join(dir, 'bad-method.mp3'), logger: QUIET,
    }), (err) => err.code === 'TTS_CONFIG' && /GET\/POST/.test(err.message));
    await assert.rejects(customAdapter.synthesize({
      provider: provider('custom', { url: 'ftp://example.com/tts', method: 'POST', bodyTemplate: '{}', responseType: 'audio' }),
      text: 'x', options: {}, outPath: path.join(dir, 'bad-url.mp3'), logger: QUIET,
    }), (err) => err.code === 'TTS_CONFIG' && /只支持 http/.test(err.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 本地命令 ───────────────────────────────────────────────

function makeFakeSpawn(options = {}) {
  const calls = [];
  const state = { kills: 0 };
  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, spawnOptions });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { state.kills += 1; };
    setTimeout(() => {
      if (options.stderr) child.stderr.emit('data', Buffer.from(options.stderr));
      if (options.neverClose) return;
      const code = options.code === undefined ? 0 : options.code;
      if (code === 0 && options.writeOutput !== false) {
        const match = /--write-media\s+'([^']*)'/.exec(args[1]);
        if (match) fs.writeFileSync(match[1], MP3);
      }
      child.emit('close', code, options.signal || null);
    }, options.delay === undefined ? 5 : options.delay);
    return child;
  };
  return { spawn, calls, state };
}

const COMMAND_TEMPLATE = 'edge-tts --voice {{voice}} --text {{text}} --write-media {{output}}';

test('command 适配器：模板 shell 转义 / 退出码 / 输出文件校验 / 超时', async () => {
  const dir = tempDir();
  try {
    // 成功
    const fake = makeFakeSpawn();
    const outPath = path.join(dir, 'cmd.mp3');
    const result = await commandAdapter.synthesize({
      provider: provider('command', { command: COMMAND_TEMPLATE, outputFormat: 'mp3' }),
      text: "a'b 你好",
      options: { voice: 'zh-CN-XiaoxiaoNeural', spawn: fake.spawn },
      outPath,
      logger: QUIET,
    });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].command, '/bin/sh');
    assert.equal(fake.calls[0].args[0], '-c');
    const rendered = fake.calls[0].args[1];
    assert.ok(rendered.startsWith('edge-tts --voice '));
    assert.ok(rendered.includes(shellQuote("a'b 你好")), '文本必须按 POSIX 单引号转义');
    assert.ok(rendered.includes(shellQuote(outPath)));
    assert.equal(result.format, 'mp3');
    assert.equal(result.bytes, MP3.length);
    assert.deepEqual(fs.readFileSync(outPath), MP3);

    // 非 0 退出码 + stderr
    const failing = makeFakeSpawn({ code: 2, stderr: 'boom: model missing' });
    await assert.rejects(commandAdapter.synthesize({
      provider: provider('command', { command: COMMAND_TEMPLATE, outputFormat: 'mp3' }),
      text: 'x', options: { spawn: failing.spawn }, outPath: path.join(dir, 'fail.mp3'), logger: QUIET,
    }), (err) => err.code === 'TTS_UPSTREAM' && /退出码 2/.test(err.message) && /boom: model missing/.test(err.message));

    // 成功但没有生成文件
    const noOutput = makeFakeSpawn({ writeOutput: false });
    await assert.rejects(commandAdapter.synthesize({
      provider: provider('command', { command: COMMAND_TEMPLATE, outputFormat: 'mp3' }),
      text: 'x', options: { spawn: noOutput.spawn }, outPath: path.join(dir, 'no-output.mp3'), logger: QUIET,
    }), (err) => err.code === 'TTS_UPSTREAM' && /没有生成音频文件/.test(err.message));

    // 超时：命令不返回 → kill + TTS_TIMEOUT
    const hanging = makeFakeSpawn({ neverClose: true });
    await assert.rejects(commandAdapter.synthesize({
      provider: provider('command', { command: 'sleep 10', outputFormat: 'mp3', timeoutMs: 20 }),
      text: 'x', options: { spawn: hanging.spawn }, outPath: path.join(dir, 'timeout.mp3'), logger: QUIET,
    }), (err) => err.code === 'TTS_TIMEOUT' && /超时/.test(err.message));
    assert.ok(hanging.state.kills >= 1, '超时应 kill 子进程');

    // 缺命令模板
    await assert.rejects(commandAdapter.synthesize({
      provider: provider('command', { command: '   ', outputFormat: 'mp3' }),
      text: 'x', options: { spawn: makeFakeSpawn().spawn }, outPath: path.join(dir, 'no-cmd.mp3'), logger: QUIET,
    }), (err) => err.code === 'TTS_CONFIG' && /命令模板/.test(err.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
