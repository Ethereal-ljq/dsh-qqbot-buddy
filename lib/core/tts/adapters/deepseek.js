/**
 * adapters/deepseek —— DeepSeek 官方 TTS（POST /v1/tools/tts）。
 *
 * 契约（api-docs.deepseek.com）：
 *   POST https://api.deepseek.com/v1/tools/tts，Authorization: Bearer <key>
 *   body { text, voice_id: 'stella'|'tide', format: 'wav'|'pcm', filter_markdown?: true }
 *   响应在响应体中流式返回音频：format=wav 返回 audio/wav；format=pcm 返回 24kHz、
 *   16 位有符号、单声道的原始 PCM（没有容器头，这里自动补 WAV 头再落盘）。
 *   不支持语速；单次 text 最多 10,000 计费字符（引擎按 maxCharsPerRequest 先分段）。
 */
import { encodeWav, writeAudioFile } from '../audio.js';
import {
  fetchWithTimeout, readAudioResponse, requireSecret, sniffAudioMediaType, ttsError, trimBaseUrl,
} from '../http.js';
import { kindOf } from '../providers.js';

const KIND = 'deepseek';
const META = kindOf(KIND);
const DEFAULT_TIMEOUT_MS = 120000;
const VOICES = new Set(['stella', 'tide']);

/** 拼接 /v1/tools/tts（baseUrl 可带或不带 /v1）。 */
function ttsUrl(baseUrl) {
  return /\/v1$/i.test(baseUrl) ? baseUrl + '/tools/tts' : baseUrl + '/v1/tools/tts';
}

/** 合成一段文本。 */
async function synthesize({ provider, text, options = {}, outPath, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const opts = options && typeof options === 'object' ? options : {};
  const baseUrl = trimBaseUrl(config.baseUrl, META.defaultConfig.baseUrl);
  const requested = String(config.format || 'wav').trim().toLowerCase() === 'pcm' ? 'pcm' : 'wav';
  const voice = String(opts.voice || config.voice || META.defaultConfig.voice || 'stella').trim();
  if (!VOICES.has(voice)) {
    throw ttsError('DeepSeek TTS 音色只支持 stella / tide（当前: ' + voice + '）', 'TTS_CONFIG');
  }
  const secret = requireSecret(provider, 'DeepSeek 语音');
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const body = {
    text,
    voice_id: voice,
    format: requested,
    filter_markdown: true,
  };

  const response = await fetchWithTimeout(ttsUrl(baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + secret,
    },
    body: JSON.stringify(body),
  }, { timeoutMs, signal, label: 'DeepSeek 语音' });

  const audio = await readAudioResponse(response, { label: 'DeepSeek 语音', plannedFormat: 'wav' });
  let buffer = audio.buffer;
  let format = audio.format || 'wav';
  const isPcm = requested === 'pcm'
    || /pcm/i.test(audio.contentType)
    || !sniffAudioMediaType(buffer);
  if (isPcm) {
    // 24 kHz / 16 bit / 单声道 PCM -> 标准 WAV
    buffer = encodeWav(buffer, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
    format = 'wav';
  }
  await writeAudioFile(outPath, buffer);
  logger?.debug?.('[tts:deepseek] 合成完成 ' + buffer.length + ' bytes（请求格式=' + requested + '，落盘=' + format + '）');
  return {
    bytes: buffer.length,
    format,
    model: 'deepseek-tools-tts',
    voice,
    meta: { mimeType: 'audio/wav' },
  };
}

export default { kind: KIND, synthesize };
