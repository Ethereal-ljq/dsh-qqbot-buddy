/**
 * adapters/mimo —— 小米 MiMo TTS 三类能力（默认音色 / 克隆 / 文字设计）的共用实现。
 *
 * 契约 §6：POST {baseUrl}/chat/completions，头 api-key: <secret>；
 *   body { model, messages:[{role:'user',content:风格/描述}, {role:'assistant',content:text}],
 *          audio:{format:'wav', voice} }
 *   - mimo（默认）：audio.voice = 内置音色名（config.voice / 配置档覆盖）；
 *   - mimo-clone：audio.voice = data:<mime>;base64,<样本音频>（config.samplePath 指向本机文件）；
 *   - mimo-design：user 指令 = config.description（描述想要的声音），不带 audio.voice。
 * 响应 choices[0].message.audio.data 是 base64 音频。
 */
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { kindOf } from '../providers.js';
import {
  decodeBase64Audio, fetchJson, formatOfMediaType, requireSecret, sniffAudioMediaType,
  trimBaseUrl, truncate, ttsError,
} from '../http.js';
import { ffmpegBinary, writeAudioFile } from '../audio.js';

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;

/** kind → MiMo 模型名（模型由能力决定，不再由用户选择）。 */
const MODELS = {
  mimo: 'mimo-v2.5-tts',
  'mimo-clone': 'mimo-v2.5-tts-voiceclone',
  'mimo-design': 'mimo-v2.5-tts-voicedesign',
};

/** 识别样本音频的真实容器（不能只看扩展名：m4a 常被误当 wav）。 */
export function detectSampleContainer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return 'unknown';
  const head4 = buffer.toString('ascii', 0, 4);
  if (head4 === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (buffer.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3';
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  if (head4 === 'OggS') return 'ogg';
  if (head4 === 'fLaC') return 'flac';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'webm';
  if (head4 === '#!AM') return 'amr';
  if (head4 === '#!SI') return 'silk';
  return 'unknown';
}

/**
 * 把 MiMo 不支持的容器（m4a/aac/ogg/flac/webm/amr/silk…）用 ffmpeg 转成 24kHz 单声道 wav。
 * MiMo 克隆接口只接受 mp3 / wav（实测 m4a 直接退回 500 Internal Server Error）。
 * 转码后若 wav 超过 10MB（长音频），再转 64kbps mp3。
 * @returns {Promise<{buffer:Buffer, mediaType:string}>}
 */
async function transcodeSampleToSupported(buffer, container, logger) {
  const binary = ffmpegBinary();
  if (!binary) {
    throw ttsError('MiMo 克隆样本是 ' + container + ' 格式，但本机没有可用的 ffmpeg：请先转成 mp3/wav，或安装 ffmpeg', 'TTS_CONFIG');
  }
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'qqbot-mimo-sample-'));
  try {
    const ext = container === 'unknown' ? '.bin' : '.' + container;
    const input = path.join(dir, 'sample' + ext);
    fsSync.writeFileSync(input, buffer);
    const run = (args) => spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, ...args], {
      timeout: 120000, encoding: 'utf8',
    });
    const outWav = path.join(dir, 'sample.wav');
    const wavResult = run(['-vn', '-ac', '1', '-ar', '24000', '-sample_fmt', 's16', outWav]);
    if (!wavResult || wavResult.error || wavResult.status !== 0) {
      throw ttsError('MiMo 克隆样本转码失败：' + truncate((wavResult && wavResult.stderr) || 'ffmpeg 执行失败', 300), 'TTS_CONFIG');
    }
    const wavBuffer = fsSync.readFileSync(outWav);
    if (wavBuffer.length > 0 && wavBuffer.length <= MAX_SAMPLE_BYTES) {
      logger?.debug?.('[tts:mimo:clone] 样本已从 ' + container + ' 转码为 wav（' + wavBuffer.length + ' bytes）');
      return { buffer: wavBuffer, mediaType: 'audio/wav' };
    }
    // 长音频 wav 超 10MB：改压 mp3
    const outMp3 = path.join(dir, 'sample.mp3');
    const mp3Result = run(['-vn', '-ac', '1', '-ar', '24000', '-codec:a', 'libmp3lame', '-b:a', '64k', outMp3]);
    if (!mp3Result || mp3Result.error || mp3Result.status !== 0) {
      throw ttsError('MiMo 克隆样本转码后仍超过 10MB，请换更短的音频', 'TTS_CONFIG');
    }
    const mp3Buffer = fsSync.readFileSync(outMp3);
    if (mp3Buffer.length > MAX_SAMPLE_BYTES) throw ttsError('MiMo 克隆样本超过 10MB，请换更短的音频', 'TTS_CONFIG');
    logger?.debug?.('[tts:mimo:clone] 样本已从 ' + container + ' 转码为 mp3（' + mp3Buffer.length + ' bytes）');
    return { buffer: mp3Buffer, mediaType: 'audio/mpeg' };
  } finally {
    try { fsSync.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  }
}

/** 克隆样本音频 → data URI（size / magic bytes 校验）。 */
async function loadCloneSample(samplePath, { logger } = {}) {
  const raw = typeof samplePath === 'string' ? samplePath.trim() : '';
  if (raw === '') throw ttsError('MiMo 音色克隆需要选择样本音频文件（samplePath）', 'TTS_CONFIG');
  let stat;
  try {
    stat = await fs.stat(raw);
  } catch {
    throw ttsError('MiMo 克隆样本音频不存在: ' + truncate(raw, 200), 'TTS_CONFIG');
  }
  if (!stat.isFile()) throw ttsError('MiMo 克隆样本不是文件: ' + truncate(raw, 200), 'TTS_CONFIG');
  if (stat.size > MAX_SAMPLE_BYTES) throw ttsError('MiMo 克隆样本超过 10MB，请换更短的音频', 'TTS_CONFIG');
  let buffer = await fs.readFile(raw);
  const container = detectSampleContainer(buffer);
  let mediaType = '';
  if (container === 'wav') {
    mediaType = 'audio/wav';
  } else if (container === 'mp3') {
    mediaType = 'audio/mpeg';
  } else {
    // MiMo 只支持 mp3/wav；m4a 等先用 ffmpeg 转码（旧实现会误标成 wav 导致上游 500）
    const converted = await transcodeSampleToSupported(buffer, container, logger);
    buffer = converted.buffer;
    mediaType = converted.mediaType;
  }
  logger?.debug?.('[tts:mimo:clone] 样本容器=' + container + '，发送 MIME=' + mediaType + '，' + buffer.length + ' bytes');
  return 'data:' + mediaType + ';base64,' + buffer.toString('base64');
}

/**
 * 按 MiMo 能力合成一段文本。
 * @param {'mimo'|'mimo-clone'|'mimo-design'} kind
 */
export async function synthesizeForKind(kind, { provider, text, options = {}, outPath, signal, logger } = {}) {
  const meta = kindOf(kind);
  if (!meta) throw ttsError('未知的 MiMo 语音类型: ' + String(kind), 'TTS_CONFIG');
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const opts = options && typeof options === 'object' ? options : {};

  const baseUrl = trimBaseUrl(config.baseUrl, DEFAULT_BASE_URL);
  const model = MODELS[kind] || MODELS.mimo;
  const secret = requireSecret(provider, 'MiMo 语音');
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const style = String(opts.style || config.style || '').trim();
  const body = { model, messages: [], audio: { format: 'wav' } };
  let voice = '';

  if (kind === 'mimo-clone') {
    body.audio.voice = await loadCloneSample(config.samplePath, { logger });
    if (style !== '') body.messages.push({ role: 'user', content: style });
    voice = 'voiceclone';
  } else if (kind === 'mimo-design') {
    const description = String(config.description || '').trim();
    if (description === '') throw ttsError('MiMo 文字设计音色需要填写音色描述（description）', 'TTS_CONFIG');
    // 设计音色的描述优先于配置档的风格覆盖：这是音色本身的定义。
    body.messages.push({ role: 'user', content: description });
    voice = 'voicedesign';
  } else {
    voice = String(opts.voice || config.voice || '').trim() || 'mimo_default';
    body.audio.voice = voice;
    if (style !== '') body.messages.push({ role: 'user', content: style });
  }
  body.messages.push({ role: 'assistant', content: text });

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
  logger?.debug?.('[tts:mimo:' + kind + '] 合成完成 ' + decoded.buffer.length + ' bytes，model=' + model);
  return { bytes: decoded.buffer.length, format, model, voice };
}

export default {
  kind: 'mimo',
  synthesize: (args) => synthesizeForKind('mimo', args),
};
