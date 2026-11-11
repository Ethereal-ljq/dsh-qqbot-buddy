/**
 * adapters/bailian —— 阿里云百炼 / DashScope 非实时语音合成（Qwen-TTS）。
 *
 * 契约 §6：POST {baseUrl}/services/aigc/multimodal-generation/generation，
 *   头 Authorization: Bearer <secret>；body { model, input:{text, voice, language_type} }；
 *   响应 output.audio.url（下载）或 output.audio.data（base64）。
 */
import { kindOf } from '../providers.js';
import {
  decodeBase64Audio, fetchJson, fetchWithTimeout, formatOfMediaType, readAudioResponse,
  requireSecret, sniffAudioMediaType, ttsError, trimBaseUrl,
} from '../http.js';
import { writeAudioFile } from '../audio.js';

const KIND = 'bailian';
const META = kindOf(KIND);
const DEFAULT_TIMEOUT_MS = 120000;

/** 合成一段文本。 */
async function synthesize({ provider, text, options = {}, outPath, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const opts = options && typeof options === 'object' ? options : {};
  const baseUrl = trimBaseUrl(config.baseUrl, META.defaultConfig.baseUrl);
  const model = String(config.model || META.defaultConfig.model || '').trim();
  if (model === '') throw ttsError('百炼语音需要选择模型', 'TTS_CONFIG');
  const secret = requireSecret(provider, '百炼语音');
  const voice = String(opts.voice || config.voice || '').trim();
  if (voice === '') throw ttsError('百炼语音需要选择音色', 'TTS_CONFIG');
  const languageType = String(config.languageType || 'Auto').trim() || 'Auto';
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;

  const { data } = await fetchJson(baseUrl + '/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret },
    body: JSON.stringify({ model, input: { text, voice, language_type: languageType } }),
  }, { timeoutMs, signal, label: '百炼语音' });

  const audio = data && data.output && data.output.audio ? data.output.audio : {};
  let buffer = null;
  if (typeof audio.data === 'string' && audio.data.trim() !== '') {
    buffer = decodeBase64Audio(audio.data, '百炼语音').buffer;
  } else if (typeof audio.url === 'string' && audio.url.trim() !== '') {
    const response = await fetchWithTimeout(audio.url.trim(), { method: 'GET' }, {
      timeoutMs, signal, label: '百炼语音音频下载',
    });
    const downloaded = await readAudioResponse(response, { label: '百炼语音音频下载', plannedFormat: 'wav' });
    buffer = downloaded.buffer;
  }
  if (!buffer) throw ttsError('百炼语音返回里没有音频数据', 'TTS_UPSTREAM');
  const sniffed = sniffAudioMediaType(buffer);
  const format = (sniffed ? formatOfMediaType(sniffed) : '') || 'wav';
  await writeAudioFile(outPath, buffer);
  logger?.debug?.('[tts:bailian] 合成完成 ' + buffer.length + ' bytes，model=' + model);
  return { bytes: buffer.length, format, model, voice };
}

export default { kind: KIND, synthesize };
