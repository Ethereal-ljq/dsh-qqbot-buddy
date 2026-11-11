/**
 * adapters/openai —— OpenAI 兼容 /audio/speech（OpenAI、中转、本地网关通用）。
 *
 * 契约 §6：POST {baseUrl}/audio/speech，Bearer 鉴权（本地无鉴权服务可留空）；
 *   body { model, input, voice, response_format, speed, instructions? }；
 *   响应二进制音频，实际格式按 content-type / magic bytes 嗅探。
 */
import { kindOf } from '../providers.js';
import {
  fetchWithTimeout, formatOfMediaType, mimeTypeFor, readAudioResponse, sniffAudioMediaType,
  ttsError, trimBaseUrl,
} from '../http.js';
import { writeAudioFile } from '../audio.js';

const KIND = 'openai';
const META = kindOf(KIND);
const DEFAULT_TIMEOUT_MS = 120000;

/** 归一化输出格式（只允许 mp3/wav）。 */
function plannedFormat(value) {
  return String(value || '').trim().toLowerCase() === 'wav' ? 'wav' : 'mp3';
}

/** 归一化语速（0.25 ~ 4）。 */
function normalizeSpeed(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return Math.min(4, Math.max(0.25, number));
}

/** 合成一段文本。 */
async function synthesize({ provider, text, options = {}, outPath, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const opts = options && typeof options === 'object' ? options : {};
  const baseUrl = trimBaseUrl(config.baseUrl, META.defaultConfig.baseUrl);
  const model = String(config.model || META.defaultConfig.model || '').trim();
  if (model === '') throw ttsError('OpenAI 语音需要填写模型名', 'TTS_CONFIG');
  const voice = String(opts.voice || config.voice || META.defaultConfig.voice || '').trim();
  if (voice === '') throw ttsError('OpenAI 语音需要选择音色', 'TTS_CONFIG');
  const secret = provider && typeof provider.secret === 'string' ? provider.secret.trim() : '';
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const format = plannedFormat(config.format || META.defaultConfig.format);
  const speed = normalizeSpeed(opts.speed !== undefined && opts.speed !== null ? opts.speed : config.speed);

  const body = { model, input: text, voice, response_format: format, speed };
  const instructions = String(opts.style || config.instructions || '').trim();
  if (instructions !== '') body.instructions = instructions;
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== '') headers.Authorization = 'Bearer ' + secret;

  const response = await fetchWithTimeout(baseUrl + '/audio/speech', {
    method: 'POST', headers, body: JSON.stringify(body),
  }, { timeoutMs, signal, label: 'OpenAI 语音' });
  const audio = await readAudioResponse(response, { label: 'OpenAI 语音', plannedFormat: format });
  const sniffed = sniffAudioMediaType(audio.buffer);
  const actualFormat = (sniffed ? formatOfMediaType(sniffed) : '') || audio.format || format;
  await writeAudioFile(outPath, audio.buffer);
  logger?.debug?.('[tts:openai] 合成完成 ' + audio.buffer.length + ' bytes，format=' + actualFormat);
  return { bytes: audio.buffer.length, format: actualFormat, model, voice, meta: { mimeType: mimeTypeFor(actualFormat) } };
}

export default { kind: KIND, synthesize };
