/**
 * adapters/custom —— 自定义 HTTP 语音接口（模板化 URL / Header / Body）。
 *
 * 契约 §6：按 provider.config 渲染 URL/Header/Body：
 *   - 占位符 {{text}} {{voice}} {{style}} {{speed}}；URL 中自动 URL 编码，
 *     body 模板里自动做 JSON 字符串转义（模板本身应是合法 JSON 字符串片段）；
 *   - secret 按 secretHeader / secretPrefix 注入（不写进 headers JSON，读接口也不返回）；
 *   - responseType：audio（直接音频字节）| json_base64（responsePath 取 base64）|
 *     json_url（responsePath 取音频 URL 后下载）。
 *
 * 安全：只允许 http(s)；URL 中的占位符编码后再交给 fetch。
 */
import { kindOf } from '../providers.js';
import {
  decodeBase64Audio, fetchJson, fetchWithTimeout, formatOfMediaType, getByPath,
  readAudioResponse, sniffAudioMediaType, ttsError, truncate,
} from '../http.js';
import { normalizeFormat, writeAudioFile } from '../audio.js';

const KIND = 'custom';
const META = kindOf(KIND);
const DEFAULT_TIMEOUT_MS = 120000;
const RESPONSE_TYPES = ['audio', 'json_base64', 'json_url'];

/** 占位符表：text/voice/style/speed（值统一转字符串）。 */
function templateValues(text, options, config) {
  const opts = options && typeof options === 'object' ? options : {};
  return {
    text: String(text === undefined || text === null ? '' : text),
    voice: String(opts.voice || config.voice || ''),
    style: String(opts.style || config.style || ''),
    speed: String(opts.speed !== undefined && opts.speed !== null ? opts.speed : (config.speed !== undefined ? config.speed : 1)),
  };
}

/** URL 模板：占位符做 URL 编码。 */
export function renderUrlTemplate(template, values) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? encodeURIComponent(values[key]) : match
  ));
}

/** body 模板：占位符转成 JSON 字符串字面量里的内容（转义引号/反斜杠/换行）。 */
export function renderJsonTemplate(template, values) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    const encoded = JSON.stringify(values[key]);
    return encoded.slice(1, -1);
  });
}

/** header 值模板：去掉换行，避免 header 注入。 */
export function renderHeaderTemplate(template, values) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    return String(values[key]).replace(/[\r\n]+/g, ' ');
  });
}

/** 合成一段文本。 */
async function synthesize({ provider, text, options = {}, outPath, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const opts = options && typeof options === 'object' ? options : {};
  const urlTemplate = String(config.url || '').trim();
  if (urlTemplate === '') throw ttsError('自定义 HTTP 接口需要填写接口 URL', 'TTS_CONFIG');
  const method = String(config.method || 'POST').trim().toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw ttsError('自定义 HTTP 接口只支持 GET/POST 请求', 'TTS_CONFIG');
  const responseType = String(config.responseType || 'audio').trim();
  if (!RESPONSE_TYPES.includes(responseType)) throw ttsError('未知的自定义 TTS 响应类型: ' + truncate(responseType, 50), 'TTS_CONFIG');
  const responsePath = String(config.responsePath || '').trim();
  if (responseType !== 'audio' && responsePath === '') {
    throw ttsError('响应类型为 JSON 时必须填写 JSON 字段路径（responsePath）', 'TTS_CONFIG');
  }
  const plannedFormat = normalizeFormat(config.format) || 'mp3';
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const values = templateValues(text, opts, config);
  const url = renderUrlTemplate(urlTemplate, values);
  const label = '自定义 TTS';

  // 请求头：先展开配置里的 JSON，再按需注入密钥
  const headers = {};
  if (config.headers && typeof config.headers === 'object') {
    for (const [name, value] of Object.entries(config.headers)) {
      if (typeof name !== 'string' || name.trim() === '') continue;
      headers[name.trim()] = renderHeaderTemplate(String(value), values).replace(/[\r\n]/g, ' ');
    }
  }
  const secret = provider && typeof provider.secret === 'string' ? provider.secret.trim() : '';
  const secretHeader = String(config.secretHeader || '').trim();
  if (secret !== '' && secretHeader !== '') {
    headers[secretHeader] = String(config.secretPrefix || '') + secret.replace(/[\r\n]/g, '');
  }

  const init = { method, headers };
  if (method !== 'GET') {
    const body = renderJsonTemplate(String(config.bodyTemplate || ''), values);
    if (body.trim() !== '') {
      init.body = body;
      if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  let buffer;
  let format = plannedFormat;
  if (responseType === 'audio') {
    const response = await fetchWithTimeout(url, init, { timeoutMs, signal, label });
    const audio = await readAudioResponse(response, { label, plannedFormat });
    buffer = audio.buffer;
    const sniffed = sniffAudioMediaType(buffer);
    format = (sniffed ? formatOfMediaType(sniffed) : '') || audio.format || plannedFormat;
  } else {
    const { data } = await fetchJson(url, init, { timeoutMs, signal, label });
    const picked = getByPath(data, responsePath);
    if (typeof picked !== 'string' || picked.trim() === '') {
      throw ttsError(label + ' 响应里没有找到字段 ' + truncate(responsePath, 100) + '（需要非空字符串）', 'TTS_UPSTREAM');
    }
    if (responseType === 'json_base64') {
      const decoded = decodeBase64Audio(picked, label);
      buffer = decoded.buffer;
      const sniffed = sniffAudioMediaType(buffer);
      format = (sniffed ? formatOfMediaType(sniffed) : '') || decoded.format || plannedFormat;
    } else {
      const downloadUrl = picked.trim();
      const response = await fetchWithTimeout(downloadUrl, { method: 'GET' }, { timeoutMs, signal, label: label + ' 音频下载' });
      const audio = await readAudioResponse(response, { label: label + ' 音频下载', plannedFormat });
      buffer = audio.buffer;
      const sniffed = sniffAudioMediaType(buffer);
      format = (sniffed ? formatOfMediaType(sniffed) : '') || audio.format || plannedFormat;
    }
  }
  await writeAudioFile(outPath, buffer);
  logger?.debug?.('[tts:custom] 合成完成 ' + buffer.length + ' bytes，type=' + responseType);
  return { bytes: buffer.length, format, model: String(config.model || 'custom'), voice: values.voice };
}

export default { kind: KIND, synthesize };
