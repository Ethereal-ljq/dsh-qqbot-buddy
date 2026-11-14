/**
 * asr/adapters/deepseek —— DeepSeek 官方语音识别（POST /v1/tools/asr）。
 *
 * 契约（api-docs.deepseek.com）：
 *   POST https://api.deepseek.com/v1/tools/asr，Authorization: Bearer <key>
 *   multipart/form-data，file 字段：16 位 PCM WAV 或 Ogg Opus；
 *   限制：≤8 MiB、≤120 秒、上传需 10 分钟内完成；语种自动识别（无 language 参数）。
 *   响应 { request_id, text, duration_ms }。
 */
import fs from 'node:fs/promises';

import { kindOf } from '../../tts/providers.js';
import { readAccountToken } from '../credentials.js';
import {
  describeErrorText, fetchWithTimeout, requireSecret, ttsError, trimBaseUrl, truncate,
} from '../../tts/http.js';

const KIND = 'deepseek-asr';
const META = kindOf(KIND);
const DEFAULT_TIMEOUT_MS = 120000;
/** DeepSeek ASR 单文件上限 8 MiB。 */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** 拼接 /v1/tools/asr（baseUrl 可带或不带 /v1）。 */
function asrUrl(baseUrl) {
  return /\/v1$/i.test(baseUrl) ? baseUrl + '/tools/asr' : baseUrl + '/v1/tools/asr';
}

/** 按 magic bytes 判断 16 位 PCM WAV / Ogg Opus。 */
function detectAudioKind(buffer) {
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  return '';
}

/** 识别一段音频。 */
async function transcribe({ provider, filePath, bytes, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const baseUrl = trimBaseUrl(config.baseUrl, META.defaultConfig.baseUrl);
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  // 鉴权：API Key（Bearer）或 DSH 账号登录（x-dsh-auth-token）
  const authMode = String(config.authMode || 'apikey').trim() === 'account' ? 'account' : 'apikey';
  const headers = {};
  if (authMode === 'account') {
    const token = readAccountToken({ credentialPath: config.credentialPath || '~/.dsh/.credentials.yaml' });
    if (token === '') {
      throw ttsError('DSH 账号未登录，或凭证文件里没有 DeepSeek 账号 token（请先在 DSH 登录，或改用 API Key 鉴权）', 'ASR_CONFIG');
    }
    headers['x-dsh-auth-token'] = token;
  } else {
    headers.Authorization = 'Bearer ' + requireSecret(provider, 'DeepSeek 语音识别');
  }

  let buffer = Buffer.isBuffer(bytes) ? bytes : null;
  const source = filePath ? String(filePath) : '';
  if (!buffer) {
    if (source === '') throw ttsError('DeepSeek 语音识别需要音频文件或字节数据', 'ASR_CONFIG');
    try {
      buffer = await fs.readFile(source);
    } catch {
      throw ttsError('语音识别音频文件不存在或读取失败: ' + truncate(source, 200), 'ASR_CONFIG');
    }
  }
  if (buffer.length === 0) throw ttsError('语音识别音频为空', 'ASR_CONFIG');
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw ttsError('语音识别音频超过 8MB（DeepSeek ASR 上限），请缩短语音', 'ASR_CONFIG');
  }
  const audioKind = detectAudioKind(buffer);
  if (audioKind === '') {
    throw ttsError('DeepSeek ASR 只接受 16 位 PCM WAV 或 Ogg Opus（当前音频不是这两种格式）', 'ASR_CONFIG');
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: audioKind === 'wav' ? 'audio/wav' : 'audio/ogg' }), 'speech.' + audioKind);
  const response = await fetchWithTimeout(asrUrl(baseUrl), {
    method: 'POST',
    headers,
    body: form,
  }, { timeoutMs, signal, label: 'DeepSeek 语音识别' });

  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    throw ttsError('DeepSeek ASR 读取响应失败: ' + truncate(err && err.message ? err.message : String(err)), 'ASR_UPSTREAM');
  }
  if (!response.ok) {
    const described = describeErrorText(text);
    throw ttsError('DeepSeek ASR 接口返回 HTTP ' + response.status + (described !== '' ? '：' + described : ''), 'ASR_UPSTREAM');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw ttsError('DeepSeek ASR 返回的不是合法 JSON：' + truncate(text), 'ASR_UPSTREAM');
  }
  const recognized = typeof data.text === 'string' ? data.text.trim() : '';
  if (recognized === '') throw ttsError('DeepSeek ASR 没有识别出文字（语音可能为空/无有效人声）', 'ASR_EMPTY');
  logger?.debug?.('[asr:deepseek] 识别完成 ' + buffer.length + ' bytes，' + recognized.length + ' 字');
  return {
    text: recognized,
    durationMs: Number(data.duration_ms) > 0 ? Number(data.duration_ms) : 0,
    requestId: typeof data.request_id === 'string' ? data.request_id : '',
    bytes: buffer.length,
    format: audioKind,
  };
}

export default { kind: KIND, transcribe };
