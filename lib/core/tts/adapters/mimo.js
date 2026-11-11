/**
 * adapters/mimo —— 小米 MiMo TTS（OpenAI 风格 chat/completions + audio 输出）。
 *
 * 契约 §6：POST {baseUrl}/chat/completions，头 api-key: <secret>；
 *   body { model, messages:[{role:'user',content:style}, {role:'assistant',content:text}],
 *          audio:{format:'wav', voice} }
 *   - voicedesign：style 就是「用文字描述想要的声音」，作为 user 指令；
 *   - voiceclone：voice 字段改成 data:<mime>;base64,<样本音频>（config.samplePath 读本地文件）。
 * 响应 choices[0].message.audio.data 是 base64 音频。
 */
import fs from 'node:fs/promises';

import { kindOf } from '../providers.js';
import {
  decodeBase64Audio, fetchJson, formatOfMediaType, requireSecret, sniffAudioMediaType,
  trimBaseUrl, truncate, ttsError,
} from '../http.js';
import { writeAudioFile } from '../audio.js';

const KIND = 'mimo';
const META = kindOf(KIND);
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;

/** 克隆样本音频 → data URI（size/magic bytes 校验）。 */
async function loadCloneSample(samplePath) {
  const raw = typeof samplePath === 'string' ? samplePath.trim() : '';
  if (raw === '') throw ttsError('MiMo 音色克隆需要填写样本音频路径（samplePath）', 'TTS_CONFIG');
  let stat;
  try {
    stat = await fs.stat(raw);
  } catch {
    throw ttsError('MiMo 克隆样本音频不存在: ' + truncate(raw, 200), 'TTS_CONFIG');
  }
  if (!stat.isFile()) throw ttsError('MiMo 克隆样本不是文件: ' + truncate(raw, 200), 'TTS_CONFIG');
  if (stat.size > MAX_SAMPLE_BYTES) throw ttsError('MiMo 克隆样本超过 10MB，请换更短的音频', 'TTS_CONFIG');
  const buffer = await fs.readFile(raw);
  const sniffed = sniffAudioMediaType(buffer);
  const mediaType = sniffed || (/\.mp3$/i.test(raw) ? 'audio/mpeg' : 'audio/wav');
  return 'data:' + mediaType + ';base64,' + buffer.toString('base64');
}

/** 合成一段文本。 */
async function synthesize({ provider, text, options = {}, outPath, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const opts = options && typeof options === 'object' ? options : {};
  const baseUrl = trimBaseUrl(config.baseUrl, META.defaultConfig.baseUrl);
  const model = String(config.model || META.defaultConfig.model || '').trim();
  if (model === '') throw ttsError('MiMo 语音需要选择模型', 'TTS_CONFIG');
  const secret = requireSecret(provider, 'MiMo 语音');
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const voice = String(opts.voice || config.voice || '').trim();
  const style = String(opts.style || config.style || '').trim();
  const isClone = model.endsWith('voiceclone');
  const isDesign = model.endsWith('voicedesign');
  if (isDesign && style === '') throw ttsError('MiMo voicedesign 模型需要在风格指令里描述想要的声音', 'TTS_CONFIG');

  const body = { model, messages: [], audio: { format: 'wav' } };
  if (style !== '') body.messages.push({ role: 'user', content: style });
  body.messages.push({ role: 'assistant', content: text });
  if (isClone) {
    body.audio.voice = await loadCloneSample(config.samplePath);
  } else if (voice !== '') {
    body.audio.voice = voice;
  }

  const { data } = await fetchJson(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': secret },
    body: JSON.stringify(body),
  }, { timeoutMs, signal, label: 'MiMo 语音' });

  const base64 = data
    && data.choices && data.choices[0] && data.choices[0].message
    && data.choices[0].message.audio
    && data.choices[0].message.audio.data;
  if (typeof base64 !== 'string' || base64.trim() === '') {
    throw ttsError('MiMo 语音返回里没有音频数据', 'TTS_UPSTREAM');
  }
  const decoded = decodeBase64Audio(base64, 'MiMo 语音');
  const sniffed = sniffAudioMediaType(decoded.buffer);
  const format = (sniffed ? formatOfMediaType(sniffed) : '') || 'wav';
  await writeAudioFile(outPath, decoded.buffer);
  logger?.debug?.('[tts:mimo] 合成完成 ' + decoded.buffer.length + ' bytes，model=' + model);
  return { bytes: decoded.buffer.length, format, model, voice: isClone ? 'voiceclone' : voice };
}

export default { kind: KIND, synthesize };
