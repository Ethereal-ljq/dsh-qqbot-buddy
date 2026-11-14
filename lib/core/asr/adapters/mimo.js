/**
 * asr/adapters/mimo —— 小米 MiMo-V2.5-ASR（OpenAI 兼容 chat/completions）。
 *
 * 契约（mimo.mi.com/docs）：
 *   POST {baseUrl}/chat/completions，头 api-key: <key>
 *   body { model:'mimo-v2.5-asr',
 *          messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'data:audio/wav;base64,...'}}]}],
 *          asr_options:{ language:'auto'|'zh'|'en' } }
 *   wav/mp3，base64 后 ≤10MB；响应 choices[0].message.content 为转写文本。
 */
import fs from 'node:fs/promises';

import { kindOf } from '../../tts/providers.js';
import {
  describePayloadError, fetchJson, requireSecret, sniffAudioMediaType, ttsError, trimBaseUrl, truncate,
} from '../../tts/http.js';

const KIND = 'mimo-asr';
const META = kindOf(KIND);
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_BASE64 = 10 * 1024 * 1024;

function chatUrl(baseUrl) {
  if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl;
  return baseUrl + '/chat/completions';
}

/** 从 OpenAI 风格响应里取文本。 */
export function textFromChatCompletion(data) {
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
      .join('')
      .trim();
  }
  return '';
}

async function transcribe({ provider, filePath, bytes, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const baseUrl = trimBaseUrl(config.baseUrl, META.defaultConfig.baseUrl);
  const secret = requireSecret(provider, 'MiMo 语音识别');
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;

  let buffer = Buffer.isBuffer(bytes) ? bytes : null;
  if (!buffer) {
    if (!filePath) throw ttsError('MiMo 语音识别需要音频文件', 'ASR_CONFIG');
    try {
      buffer = await fs.readFile(String(filePath));
    } catch {
      throw ttsError('语音识别音频文件不存在或读取失败: ' + truncate(String(filePath), 200), 'ASR_CONFIG');
    }
  }
  if (buffer.length === 0) throw ttsError('语音识别音频为空', 'ASR_CONFIG');
  const mediaType = sniffAudioMediaType(buffer);
  if (mediaType !== 'audio/wav' && mediaType !== 'audio/mpeg') {
    throw ttsError('MiMo ASR 只接受 wav / mp3（当前音频格式不支持）', 'ASR_CONFIG');
  }
  const base64 = buffer.toString('base64');
  if (base64.length > MAX_BASE64) {
    throw ttsError('MiMo ASR 音频 base64 后超过 10MB，请缩短语音', 'ASR_CONFIG');
  }
  const language = String(config.language || 'auto').trim() || 'auto';
  const body = {
    model: String(config.model || META.defaultConfig.model || 'mimo-v2.5-asr').trim(),
    messages: [{
      role: 'user',
      content: [{ type: 'input_audio', input_audio: { data: 'data:' + mediaType + ';base64,' + base64 } }],
    }],
    asr_options: { language },
  };
  const { data } = await fetchJson(chatUrl(baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': secret },
    body: JSON.stringify(body),
  }, { timeoutMs, signal, label: 'MiMo 语音识别' });
  const text = textFromChatCompletion(data);
  if (text === '') {
    const described = describePayloadError(data);
    throw ttsError('MiMo ASR 没有识别出文字' + (described !== '' ? '：' + described : ''), 'ASR_EMPTY');
  }
  logger?.debug?.('[asr:mimo] 识别完成 ' + buffer.length + ' bytes，' + text.length + ' 字');
  return { text, durationMs: 0, bytes: buffer.length, format: mediaType === 'audio/wav' ? 'wav' : 'mp3' };
}

export default { kind: KIND, transcribe };
