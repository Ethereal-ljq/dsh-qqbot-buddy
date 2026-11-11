/**
 * adapters/edge —— 微软 Edge 语音（内置 WebSocket 协议，免 API Key）。
 *
 * 协议（2026-11 实测，替代早期 v1 描述）：
 *   1. wss 地址 = 基址 + ?TrustedClientToken=...&ConnectionId=<32 hex>&
 *      Sec-MS-GEC=<v2 token>&Sec-MS-GEC-Version=2-143.0.3650.96；
 *      v2 token 见 ../edge-token.js（旧的 sha256(ticks+token) 会被 403 拒绝）；
 *   2. 握手 headers 必须模拟 Edge 扩展（Origin/UA/Cookie muid 等），Node 全局 WebSocket
 *      不能设置自定义 header，因此用依赖里的 ws 包；ws 在**首次合成时懒加载**，
 *      缺失只影响 Edge 供应商，不会拖垮整个 TTS 引擎装配；
 *   3. 连接后先发 speech.config（mp3 输出、关闭边界事件），再发 SSML 文本帧；
 *   4. 收到文本帧且含 Path:turn.end 即结束；二进制帧前 2 字节大端是 header JSON 长度，
 *      跳过 header 后的字节是 mp3 音频。
 *
 * 测试：createEdgeAdapter({ WebSocketImpl: FakeWs, now: () => 固定时间 }) 注入替身，
 * 或 QQBOT_EDGE_TTS_URL 指向本地代理；绝不真实联网。
 */
import crypto from 'node:crypto';

import { kindOf } from '../providers.js';
import { EDGE_TOKEN_VERSION, EDGE_TRUSTED_CLIENT_TOKEN, EDGE_WSS_BASE, secMsGec } from '../edge-token.js';
import { ttsError, truncate } from '../http.js';
import { writeAudioFile } from '../audio.js';

const KIND = 'edge';

/**
 * ws 包「按需加载」引导器。
 *
 * 为什么不在模块顶层静态 import：engine 会静态 import 全部适配器；若某个部署环境
 * 没有装到 ws（例如 --local 复制安装、profile 依赖未 hoist），静态 import 会让
 * **整个 TTS 引擎装配失败**（所有供应商都不可用）。按需加载后：没有 ws 只影响
 * Edge 这一个供应商（调用时给出可读的安装提示），其余 5 类供应商照常工作。
 */
let cachedWebSocketImpl = null;
async function loadWebSocketImpl() {
  if (cachedWebSocketImpl) return cachedWebSocketImpl;
  try {
    const mod = await import('ws');
    const impl = mod && (mod.default || mod.WebSocket || mod);
    if (typeof impl !== 'function') throw new Error('ws 模块没有导出构造函数');
    cachedWebSocketImpl = impl;
    return impl;
  } catch {
    throw ttsError('Edge 语音需要 ws 依赖（当前安装不完整）：请重装插件，或改用「本地命令行」等其他 TTS 供应商', 'TTS_CONFIG');
  }
}
const META = kindOf(KIND);
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const DEFAULT_TIMEOUT_MS = 30000;
/** Edge 扩展的固定 Origin（服务端会校验来源形态）。 */
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
/** Edge 143 的 User-Agent（版本与 Sec-MS-GEC-Version 对齐）。 */
const EDGE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

/** 任意二进制帧数据 → Buffer。 */
function toBuffer(data) {
  if (data === undefined || data === null) return null;
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** XML 转义（SSML 里的文本/属性）。 */
function escapeXml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 从音色名推导 SSML 语言（zh-CN-XiaoxiaoNeural → zh-CN）。 */
function deriveLang(voice) {
  const parts = String(voice || '').split('-');
  if (parts.length >= 2 && /^[A-Za-z]{2,3}$/.test(parts[0]) && /^[A-Za-z]{2,4}$/.test(parts[1])) {
    return parts[0] + '-' + parts[1];
  }
  return 'zh-CN';
}

/** 语速：配置档 speed 优先（1.2 → '+20%'），否则用 config.rate。 */
function normalizeRate(configRate, speed) {
  const number = Number(speed);
  if (Number.isFinite(number) && number > 0 && number !== 1) {
    const delta = Math.round((number - 1) * 100);
    return (delta >= 0 ? '+' : '') + delta + '%';
  }
  const raw = typeof configRate === 'string' ? configRate.trim() : '';
  if (raw === '') return '+0%';
  if (/^[+-]?\d+(?:\.\d+)?%$/.test(raw)) return /^[+-]/.test(raw) ? raw : '+' + raw;
  return raw;
}

/** 音调/音量参数（缺省补默认值）。 */
function normalizeParam(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw === '' ? fallback : raw;
}

/**
 * 构造 wss 地址（覆盖 base 时仍拼鉴权 query）。
 * @param {{baseUrl?:string, now?:number, connectionId?:string}} [options]
 */
export function buildEdgeUrl(options = {}) {
  const base = typeof options.baseUrl === 'string' && options.baseUrl.trim() !== ''
    ? options.baseUrl.trim()
    : (typeof process.env.QQBOT_EDGE_TTS_URL === 'string' && process.env.QQBOT_EDGE_TTS_URL.trim() !== ''
      ? process.env.QQBOT_EDGE_TTS_URL.trim()
      : EDGE_WSS_BASE);
  let url;
  try {
    url = new URL(base);
  } catch {
    throw ttsError('Edge 语音地址非法: ' + truncate(base, 200), 'TTS_CONFIG');
  }
  url.searchParams.set('TrustedClientToken', EDGE_TRUSTED_CLIENT_TOKEN);
  url.searchParams.set('ConnectionId', options.connectionId || crypto.randomBytes(16).toString('hex'));
  url.searchParams.set('Sec-MS-GEC', secMsGec({ now: options.now }));
  url.searchParams.set('Sec-MS-GEC-Version', EDGE_TOKEN_VERSION);
  return url.toString();
}

/** 模拟 Edge 扩展的握手 headers（Cookie muid 每次随机）。 */
export function buildHandshakeHeaders(muid = crypto.randomBytes(16).toString('hex').toUpperCase()) {
  return {
    Origin: EDGE_ORIGIN,
    'User-Agent': EDGE_USER_AGENT,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Cookie: 'muid=' + muid + ';',
  };
}

/** speech.config 文本帧。 */
export function buildSpeechConfigFrame() {
  const config = {
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  };
  return 'Content-Type:application/json; charset=utf-8\r\n'
    + 'Path:speech.config\r\n\r\n'
    + JSON.stringify(config);
}

/** SSML 文本帧。 */
export function buildSsmlFrame({ text, voice, rate = '+0%', pitch = '+0Hz', volume = '+0%', requestId = '' } = {}) {
  const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="' + deriveLang(voice) + '">'
    + '<voice name="' + escapeXml(voice) + '">'
    + '<prosody pitch="' + escapeXml(pitch) + '" rate="' + escapeXml(rate) + '" volume="' + escapeXml(volume) + '">'
    + escapeXml(text)
    + '</prosody></voice></speak>';
  return 'X-RequestId:' + (requestId || crypto.randomBytes(16).toString('hex')) + '\r\n'
    + 'Content-Type:application/ssml+xml\r\n'
    + 'Path:ssml\r\n\r\n'
    + ssml;
}

/** 剥离二进制帧的 2 字节大端 header，返回音频字节。 */
function extractAudioChunk(buffer) {
  if (!buffer || buffer.length < 2) return null;
  const headerLength = buffer.readUInt16BE(0);
  const start = 2 + headerLength;
  if (start > buffer.length) return null;
  return buffer.subarray(start);
}

/**
 * 创建 Edge 适配器。
 * @param {{WebSocketImpl?: Function, now?: () => number, baseUrl?: string}} [injected]
 *   WebSocketImpl 需兼容 ws 接口（on/send/close，message 事件 (data, isBinary)）；
 *   now 固定时间便于测试 token；baseUrl 覆盖 wss 基址（也可用 QQBOT_EDGE_TTS_URL）。
 */
export function createEdgeAdapter(injected = {}) {
  // 测试注入替身时完全不碰 ws；生产默认懒加载（见 loadWebSocketImpl）。
  const injectedImpl = typeof injected.WebSocketImpl === 'function' ? injected.WebSocketImpl : null;
  const clock = typeof injected.now === 'function' ? injected.now : Date.now;
  const baseUrlOverride = typeof injected.baseUrl === 'string' ? injected.baseUrl : '';

  /**
   * 合成一段文本。
   * @returns {Promise<{bytes:number, format:'mp3', model:string, voice:string}>}
   */
  async function synthesize({ provider, text, options = {}, outPath, signal, logger } = {}) {
    const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
    const opts = options && typeof options === 'object' ? options : {};
    const voice = String(opts.voice || config.voice || (META.defaultConfig && META.defaultConfig.voice) || '').trim();
    if (voice === '') throw ttsError('Edge 语音需要选择音色', 'TTS_CONFIG');
    const rate = normalizeRate(config.rate, opts.speed);
    const pitch = normalizeParam(config.pitch, '+0Hz');
    const volume = normalizeParam(config.volume, '+0%');
    const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const nowMs = Number(clock()) || Date.now();
    const url = buildEdgeUrl({
      baseUrl: typeof opts.baseUrl === 'string' && opts.baseUrl !== '' ? opts.baseUrl : baseUrlOverride,
      now: nowMs,
    });
    const headers = buildHandshakeHeaders();
    const requestId = crypto.randomBytes(16).toString('hex');
    // 懒加载 ws（缺依赖时只有 Edge 供应商报错，不影响引擎装配与其他供应商）
    const WebSocketImpl = injectedImpl || await loadWebSocketImpl();

    const chunks = await new Promise((resolve, reject) => {
      let settled = false;
      let ws = null;
      let timer = null;
      const audio = [];
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      };
      const finish = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { if (ws && typeof ws.close === 'function') ws.close(); } catch { /* 关闭失败忽略 */ }
        if (err) reject(err);
        else resolve(audio);
      };
      const onAbort = () => finish(ttsError('Edge 语音合成已取消', 'TTS_ABORTED'));
      if (signal && signal.aborted) { onAbort(); return; }
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(ttsError('Edge 语音合成超时（' + timeoutMs + 'ms）', 'TTS_TIMEOUT')), timeoutMs);
      try {
        ws = new WebSocketImpl(url, { headers });
      } catch (err) {
        finish(ttsError('Edge 语音连接创建失败: ' + truncate(err && err.message ? err.message : String(err)), 'TTS_UPSTREAM'));
        return;
      }
      if (!ws || typeof ws.on !== 'function' || typeof ws.send !== 'function') {
        finish(ttsError('Edge 语音 WebSocket 实现不可用（需要 on/send）', 'TTS_CONFIG'));
        return;
      }
      ws.on('open', () => {
        if (settled) return;
        try {
          ws.send(buildSpeechConfigFrame());
          ws.send(buildSsmlFrame({ text, voice, rate, pitch, volume, requestId }));
        } catch (err) {
          finish(ttsError('Edge 语音发送合成请求失败: ' + truncate(err && err.message ? err.message : String(err)), 'TTS_UPSTREAM'));
        }
      });
      ws.on('message', (data, isBinary) => {
        if (settled) return;
        const buffer = toBuffer(data);
        if (!buffer) return;
        if (isBinary === false) {
          // 文本帧：合成结束标志
          if (/Path:\s*turn\.end/i.test(buffer.toString('utf8'))) finish(null);
          return;
        }
        const chunk = extractAudioChunk(buffer);
        if (chunk && chunk.length > 0) audio.push(chunk);
      });
      ws.on('error', (err) => {
        const detail = err && err.message ? '：' + truncate(err.message, 200) : '';
        finish(ttsError('Edge 语音连接失败' + detail, 'TTS_UPSTREAM'));
      });
      ws.on('close', (code) => {
        if (settled) return;
        finish(ttsError('Edge 语音连接提前关闭' + (code !== undefined ? '（code=' + code + '）' : ''), 'TTS_UPSTREAM'));
      });
    });

    if (chunks.length === 0) throw ttsError('Edge 语音没有返回音频数据', 'TTS_UPSTREAM');
    const buffer = Buffer.concat(chunks);
    await writeAudioFile(outPath, buffer);
    logger?.debug?.('[tts:edge] 合成完成 ' + buffer.length + ' bytes，voice=' + voice);
    return { bytes: buffer.length, format: 'mp3', model: 'edge-tts', voice };
  }

  return { kind: KIND, synthesize };
}

export default createEdgeAdapter();
