/**
 * core/tts/http —— TTS 适配器共用的 HTTP / 音频字节工具。
 *
 * 职责（契约 §6）：
 * - 统一超时：fetchWithTimeout 用 AbortSignal.timeout 与调用方 signal 合并（AbortSignal.any），
 *   并只允许 http(s) URL；网络/超时/取消错误统一中文消息 + .code；
 * - fetchJson：校验 HTTP 状态、解析 JSON，错误信息截断上游响应体（≤500 字符）；
 * - readAudioResponse：读取二进制音频，按 content-type / magic bytes 嗅探实际格式；
 * - decodeBase64Audio / sniffAudioMediaType / formatOfMediaType / mimeTypeFor；
 * - getByPath：自定义 HTTP 适配器的 JSON 字段点号路径取值。
 *
 * 安全约定：错误信息里只放截断后的上游片段，绝不打印 secret（调用方自行保证）。
 */
export const MAX_ERROR_TEXT = 500;
/** 单次音频响应上限，防止异常服务把内存打爆。 */
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

/** 统一错误：Error 子类，带稳定 .code（TTS_*）。 */
export class TtsError extends Error {
  constructor(message, code = 'TTS_UPSTREAM', options = undefined) {
    super(message, options);
    this.name = 'TtsError';
    this.code = code;
  }
}

/** 构造 TTS 错误（适配器/引擎共用）。 */
export function ttsError(message, code = 'TTS_UPSTREAM', cause = undefined) {
  return new TtsError(String(message), code, cause === undefined ? undefined : { cause });
}

/** 截断文本到 max 个字符（不追加省略号，保证错误信息长度可控）。 */
export function truncate(text, max = MAX_ERROR_TEXT) {
  const value = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text);
  return value.length > max ? value.slice(0, max) : value;
}

/** 校验并返回 URL 对象；只允许 http(s)。 */
export function assertHttpUrl(rawUrl, label = 'TTS') {
  let url;
  try {
    url = new URL(String(rawUrl === undefined || rawUrl === null ? '' : rawUrl));
  } catch {
    throw ttsError(label + ' 接口地址非法: ' + truncate(String(rawUrl || '(空)'), 200), 'TTS_CONFIG');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw ttsError(label + ' 只支持 http(s) 接口地址: ' + url.protocol, 'TTS_CONFIG');
  }
  return url;
}

/** 把 fetch 抛出的异常翻译成可读的 TTS 错误。 */
function translateFetchError(err, label, timeoutMs, callerSignal, timeoutSignal) {
  const timedOut = timeoutSignal ? timeoutSignal.aborted : false;
  if (callerSignal && callerSignal.aborted) return ttsError(label + ' 请求已取消', 'TTS_ABORTED', err);
  if (timedOut || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
    return ttsError(label + ' 请求超时（' + Number(timeoutMs) + 'ms）', 'TTS_TIMEOUT', err);
  }
  const cause = err && err.cause && err.cause.message ? '（' + truncate(err.cause.message, 200) + '）' : '';
  return ttsError(label + ' 网络请求失败: ' + truncate(err && err.message ? err.message : String(err)) + cause, 'TTS_UPSTREAM', err);
}

/**
 * 带超时的 fetch。
 * @param {string|URL} url http(s) 地址
 * @param {RequestInit} [init]
 * @param {{timeoutMs?:number, signal?:AbortSignal, label?:string}} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init = {}, options = {}) {
  const label = options.label || 'TTS';
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;
  const callerSignal = options.signal && typeof options.signal.aborted === 'boolean' ? options.signal : null;
  const parsed = assertHttpUrl(url, label);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = [timeoutSignal];
  if (callerSignal) signals.push(callerSignal);
  const combined = AbortSignal.any(signals);
  try {
    return await fetch(parsed, { redirect: 'follow', ...init, signal: combined });
  } catch (err) {
    throw translateFetchError(err, label, timeoutMs, callerSignal, timeoutSignal);
  }
}

/** 从上游错误体里提取最可读的一句话（bailian/openai/mimo 的错误结构各不相同）。 */
export function describePayloadError(payload) {
  if (payload === undefined || payload === null) return '';
  if (typeof payload === 'string') return truncate(payload);
  if (typeof payload !== 'object' || Array.isArray(payload)) return '';
  const pick = (value) => {
    if (typeof value === 'string' && value.trim() !== '') return truncate(value.trim());
    return '';
  };
  const direct = pick(payload.message) || pick(payload.msg) || pick(payload.error_message) || pick(payload.detail);
  if (direct !== '') return direct;
  if (typeof payload.error === 'string') return pick(payload.error);
  if (payload.error && typeof payload.error === 'object') {
    const nested = pick(payload.error.message) || pick(payload.error.msg) || pick(payload.error.code);
    if (nested !== '') return nested;
  }
  const code = pick(payload.code) || pick(payload.error_code);
  if (code !== '') return code;
  if (payload.output && typeof payload.output === 'object') {
    const nested = pick(payload.output.message) || pick(payload.output.code);
    if (nested !== '') return nested;
  }
  return '';
}

/** 解析错误响应文本：优先 JSON 里的 message，否则截断原文。 */
export function describeErrorText(text) {
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '') return '';
  try {
    const data = JSON.parse(raw);
    const described = describePayloadError(data);
    return described !== '' ? described : truncate(raw);
  } catch {
    return truncate(raw);
  }
}

/**
 * 带超时的 JSON 请求：非 2xx / 非 JSON 都抛 TTS_UPSTREAM（消息截断）。
 * @returns {Promise<{data:any, status:number, headers:Headers, response:Response}>}
 */
export async function fetchJson(url, init = {}, options = {}) {
  const label = options.label || 'TTS';
  const response = await fetchWithTimeout(url, init, options);
  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    throw translateFetchError(err, label, options.timeoutMs || 30000, options.signal || null, null);
  }
  if (!response.ok) {
    const described = describeErrorText(text);
    throw ttsError(label + ' 接口返回 HTTP ' + response.status + (described !== '' ? '：' + described : ''), 'TTS_UPSTREAM');
  }
  if (text.trim() === '') throw ttsError(label + ' 接口返回了空响应', 'TTS_UPSTREAM');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw ttsError(label + ' 接口返回的不是合法 JSON：' + truncate(text), 'TTS_UPSTREAM');
  }
  return { data, status: response.status, headers: response.headers, response };
}

/**
 * 读取二进制音频响应。
 * @param {Response} response
 * @param {{label?:string, plannedFormat?:'mp3'|'wav'|''}} [options]
 * @returns {Promise<{buffer:Buffer, contentType:string, mediaType:string, format:string}>}
 */
export async function readAudioResponse(response, options = {}) {
  const label = options.label || 'TTS';
  const contentType = String((response.headers && response.headers.get('content-type')) || '').toLowerCase();
  if (!response.ok) {
    let text = '';
    try { text = await response.text(); } catch { text = ''; }
    const described = describeErrorText(text);
    throw ttsError(label + ' 接口返回 HTTP ' + response.status + (described !== '' ? '：' + described : ''), 'TTS_UPSTREAM');
  }
  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw ttsError(label + ' 读取音频响应超时或被取消', 'TTS_TIMEOUT', err);
    }
    throw ttsError(label + ' 读取音频响应失败: ' + truncate(err && err.message ? err.message : String(err)), 'TTS_UPSTREAM', err);
  }
  if (buffer.length === 0) throw ttsError(label + ' 返回了空音频数据', 'TTS_UPSTREAM');
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw ttsError(label + ' 返回的音频过大（' + buffer.length + ' bytes，上限 ' + MAX_AUDIO_BYTES + '）', 'TTS_UPSTREAM');
  }
  // HTTP 200 + JSON 错误体是常见坑（部分中转服务这样返回）
  if (contentType.includes('json') || contentType.includes('text/')) {
    const text = buffer.toString('utf8');
    const described = describeErrorText(text);
    throw ttsError(label + ' 返回的不是音频' + (described !== '' ? '：' + described : '（content-type: ' + contentType + '）'), 'TTS_UPSTREAM');
  }
  const mediaType = sniffAudioMediaType(buffer);
  const format = (mediaType ? formatOfMediaType(mediaType) : '') || formatOfContentType(contentType) || options.plannedFormat || '';
  return { buffer, contentType, mediaType, format };
}

/** content-type → 音频格式。 */
export function formatOfContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  if (value.includes('mpeg') || value.includes('mp3')) return 'mp3';
  if (value.includes('wav') || value.includes('wave') || value.includes('x-wav')) return 'wav';
  return '';
}

/** mediaType → 音频格式。 */
export function formatOfMediaType(mediaType) {
  const value = String(mediaType || '').toLowerCase();
  if (value === 'audio/mpeg' || value === 'audio/mp3') return 'mp3';
  if (value === 'audio/wav' || value === 'audio/wave' || value === 'audio/x-wav') return 'wav';
  return '';
}

/** 音频格式 → 标准 MIME（试听接口返回 mimeType 用）。 */
export function mimeTypeFor(format) {
  return String(format || '').toLowerCase() === 'wav' ? 'audio/wav' : 'audio/mpeg';
}

/**
 * magic bytes 嗅探音频格式（不信 content-type）。
 * @returns {'audio/mpeg'|'audio/wav'|null}
 */
export function sniffAudioMediaType(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 3) return null;
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (buffer.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

/**
 * 解码 base64 音频（兼容 data URI 前缀 / base64url / 换行）。
 * @returns {{buffer:Buffer, mediaType:string, format:string}}
 */
export function decodeBase64Audio(value, label = 'TTS') {
  let text = typeof value === 'string' ? value.trim() : '';
  if (text === '') throw ttsError(label + ' 返回的音频数据为空', 'TTS_UPSTREAM');
  let mediaType = '';
  const dataUri = /^data:([^;,]+)?;base64,/i.exec(text);
  if (dataUri) {
    mediaType = dataUri[1] || '';
    text = text.slice(dataUri[0].length);
  }
  // base64url（- _）也兼容：部分网关会这么返回
  text = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (text === '' || /[^A-Za-z0-9+/=]/.test(text)) {
    throw ttsError(label + ' 返回的 base64 音频非法', 'TTS_UPSTREAM');
  }
  const buffer = Buffer.from(text, 'base64');
  if (buffer.length === 0) throw ttsError(label + ' 解码后的音频为空', 'TTS_UPSTREAM');
  const sniffed = sniffAudioMediaType(buffer);
  return { buffer, mediaType, format: (sniffed ? formatOfMediaType(sniffed) : '') || formatOfContentType(mediaType) };
}

/** 按点号路径取 JSON 值（支持 `a.b.0.c`、`a.b[0].c`）；取不到返回 undefined。 */
export function getByPath(payload, path) {
  const rawPath = typeof path === 'string' ? path.trim() : '';
  if (rawPath === '') return payload;
  const keys = rawPath.replace(/\[(\d+)\]/g, '.$1').split('.').map((key) => key.trim()).filter((key) => key !== '');
  let cursor = payload;
  for (const key of keys) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(key);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
    } else if (typeof cursor === 'object') {
      cursor = cursor[key];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/** 需要密钥的供应商统一校验（消息可直接展示给管理员）。 */
export function requireSecret(provider, label = 'TTS') {
  const secret = provider && typeof provider.secret === 'string' ? provider.secret.trim() : '';
  if (secret === '') {
    throw ttsError(label + ' 需要 API Key：请在控制台「模型 → 语音（TTS）」里填写', 'TTS_CONFIG');
  }
  return secret;
}

/** 去掉 baseUrl 末尾斜杠。 */
export function trimBaseUrl(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : '';
  const base = text !== '' ? text : String(fallback || '');
  return base.replace(/\/+$/, '');
}

export default {
  MAX_ERROR_TEXT, MAX_AUDIO_BYTES, TtsError, ttsError, truncate, assertHttpUrl, fetchWithTimeout,
  describePayloadError, describeErrorText, fetchJson, readAudioResponse, formatOfContentType,
  formatOfMediaType, mimeTypeFor, sniffAudioMediaType, decodeBase64Audio, getByPath, requireSecret, trimBaseUrl,
};
