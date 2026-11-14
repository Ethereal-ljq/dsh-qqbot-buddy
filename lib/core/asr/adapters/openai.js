/**
 * asr/adapters/openai —— OpenAI 兼容 /audio/transcriptions。
 *
 * 适用于 OpenAI Whisper、Groq、SiliconFlow、本地 faster-whisper-server /
 * whisper.cpp server 等兼容服务：multipart 上传 file + model，返回 {text}。
 */
import fs from 'node:fs/promises';

import { kindOf } from '../../tts/providers.js';
import {
  describeErrorText, fetchWithTimeout, ttsError, trimBaseUrl, truncate,
} from '../../tts/http.js';

const KIND = 'openai-asr';
const META = kindOf(KIND);
const DEFAULT_TIMEOUT_MS = 120000;
/** OpenAI Whisper 单文件上限 25MB。 */
const MAX_BYTES = 25 * 1024 * 1024;

function transcriptionsUrl(baseUrl) {
  if (/\/audio\/transcriptions$/i.test(baseUrl)) return baseUrl;
  return baseUrl + '/audio/transcriptions';
}

async function transcribe({ provider, filePath, bytes, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const baseUrl = trimBaseUrl(config.baseUrl, META.defaultConfig.baseUrl);
  const model = String(config.model || META.defaultConfig.model || 'whisper-1').trim();
  if (model === '') throw ttsError('OpenAI 兼容 ASR 需要填写模型名', 'ASR_CONFIG');
  const secret = provider && typeof provider.secret === 'string' ? provider.secret.trim() : '';
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;

  let buffer = Buffer.isBuffer(bytes) ? bytes : null;
  if (!buffer) {
    if (!filePath) throw ttsError('OpenAI 兼容 ASR 需要音频文件', 'ASR_CONFIG');
    try {
      buffer = await fs.readFile(String(filePath));
    } catch {
      throw ttsError('语音识别音频文件不存在或读取失败: ' + truncate(String(filePath), 200), 'ASR_CONFIG');
    }
  }
  if (buffer.length === 0) throw ttsError('语音识别音频为空', 'ASR_CONFIG');
  if (buffer.length > MAX_BYTES) throw ttsError('语音识别音频超过 25MB，请缩短语音', 'ASR_CONFIG');

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', model);
  const language = String(config.language || '').trim();
  if (language !== '' && language !== 'auto') form.append('language', language);
  const prompt = String(config.prompt || '').trim();
  if (prompt !== '') form.append('prompt', prompt);
  form.append('response_format', 'json');

  const headers = {};
  if (secret !== '') headers.Authorization = 'Bearer ' + secret;
  const response = await fetchWithTimeout(transcriptionsUrl(baseUrl), {
    method: 'POST', headers, body: form,
  }, { timeoutMs, signal, label: 'OpenAI 兼容语音识别' });

  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    throw ttsError('OpenAI 兼容 ASR 读取响应失败: ' + truncate(err && err.message ? err.message : String(err)), 'ASR_UPSTREAM');
  }
  if (!response.ok) {
    const described = describeErrorText(text);
    throw ttsError('OpenAI 兼容 ASR 接口返回 HTTP ' + response.status + (described !== '' ? '：' + described : ''), 'ASR_UPSTREAM');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // 某些本地服务直接返回纯文本
    const plain = String(text || '').trim();
    if (plain === '') throw ttsError('OpenAI 兼容 ASR 返回空响应', 'ASR_UPSTREAM');
    return { text: plain, durationMs: 0, bytes: buffer.length, format: 'wav' };
  }
  const recognized = typeof data.text === 'string' ? data.text.trim() : '';
  if (recognized === '') throw ttsError('OpenAI 兼容 ASR 没有识别出文字', 'ASR_EMPTY');
  logger?.debug?.('[asr:openai] 识别完成 ' + buffer.length + ' bytes，' + recognized.length + ' 字');
  return { text: recognized, durationMs: 0, bytes: buffer.length, format: 'wav' };
}

export default { kind: KIND, transcribe };
