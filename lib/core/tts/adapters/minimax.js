/**
 * adapters/minimax —— MiniMax T2A / 音色克隆 / 音色设计。
 *
 * 协议（中国区 https://api.minimax.cn，鉴权 Authorization: Bearer <API Key>）：
 *   - 合成：POST /v1/t2a_v2 {model,text,stream:false,voice_setting,audio_setting}
 *        → data.audio 是 **hex** 编码音频（不是 base64），extra_info.audio_format 给格式；
 *   - 上传：POST /v1/files/upload multipart {purpose:'voice_clone'|'prompt_audio', file}
 *        → file.file_id；
 *   - 克隆：POST /v1/voice_clone {file_id, voice_id, clone_prompt?} → voice_id；
 *   - 设计：POST /v1/voice_design {prompt, preview_text, voice_id?}
 *        → voice_id + trial_audio（hex 试听音频）。
 *
 * 克隆/设计属于「生成音色」动作：成功后把 voice_id 存回 provider.config.voiceId，
 * 后续 T2A 合成直接用它（配置档里的音色覆盖优先）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { kindOf } from '../providers.js';
import {
  fetchJson, mimeTypeFor, requireSecret, sniffAudioMediaType, trimBaseUrl, truncate, ttsError,
} from '../http.js';
import { writeAudioFile } from '../audio.js';

const DEFAULT_BASE_URL = 'https://api.minimax.cn';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_DEMO_BASE64 = 4 * 1024 * 1024;
const SAMPLE_EXTS = new Set(['.mp3', '.m4a', '.wav']);
const DEFAULT_MODEL = 'speech-2.8-hd';

/** base_resp.status_code 非 0 → 可读错误（1004 鉴权 / 1008 余额 / 限流…）。 */
function assertMiniMaxOk(payload, label) {
  const base = payload && payload.base_resp;
  if (!base || base.status_code === undefined || base.status_code === null) return payload;
  const code = Number(base.status_code);
  if (!Number.isFinite(code) || code === 0) return payload;
  const message = String(base.status_msg || '未知错误');
  const hints = {
    1001: '超时', 1002: '触发 RPM 限流', 1004: 'API Key 无效或未授权',
    1008: '余额不足', 1013: '服务内部错误', 1039: '触发 TPM 限流',
    2038: '无复刻权限：请先在 MiniMax 平台完成个人/企业认证',
  };
  const hint = hints[code] ? '（' + hints[code] + '）' : '';
  throw ttsError(label + '失败：' + message + hint + '（status_code=' + code + '）',
    code === 1004 ? 'TTS_CONFIG' : 'TTS_UPSTREAM');
}

function baseUrlOf(config) {
  return trimBaseUrl(config && config.baseUrl, DEFAULT_BASE_URL);
}

function secretOf(provider, label) {
  const secret = requireSecret(provider, label);
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw ttsError(label + ' 需要 MiniMax API Key：请在控制台「模型 → 语音（TTS）」里填写', 'TTS_CONFIG');
  }
  return secret.trim();
}

/** 读取待上传样本并做本地校验（扩展名 / 大小；时长由服务端校验）。 */
async function readSample(filePath, label) {
  const raw = typeof filePath === 'string' ? filePath.trim() : '';
  if (raw === '') throw ttsError('MiniMax ' + label + ' 需要选择本机音频文件', 'TTS_CONFIG');
  let stat;
  try {
    stat = await fs.stat(raw);
  } catch {
    throw ttsError('MiniMax ' + label + ' 文件不存在: ' + truncate(raw, 200), 'TTS_CONFIG');
  }
  if (!stat.isFile()) throw ttsError('MiniMax ' + label + ' 不是文件: ' + truncate(raw, 200), 'TTS_CONFIG');
  if (stat.size > MAX_UPLOAD_BYTES) throw ttsError('MiniMax ' + label + ' 超过 20MB，请换更短的音频', 'TTS_CONFIG');
  const ext = path.extname(raw).toLowerCase();
  if (!SAMPLE_EXTS.has(ext)) throw ttsError('MiniMax ' + label + ' 只支持 mp3 / m4a / wav', 'TTS_CONFIG');
  return { filename: path.basename(raw), ext, bytes: await fs.readFile(raw) };
}

function mimeOfExt(ext) {
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/mp4';
  return 'audio/wav';
}

/** multipart 上传；purpose=voice_clone / prompt_audio。 */
async function uploadFile({ baseUrl, secret, file, purpose, signal, label }) {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', new Blob([file.bytes], { type: mimeOfExt(file.ext) }), file.filename);
  const { data } = await fetchJson(baseUrl + '/v1/files/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret },
    body: form,
  }, { timeoutMs: DEFAULT_TIMEOUT_MS, signal, label });
  assertMiniMaxOk(data, label);
  const fileId = data && data.file && data.file.file_id;
  if (fileId === undefined || fileId === null || fileId === '') {
    throw ttsError(label + '返回里没有 file_id', 'TTS_UPSTREAM');
  }
  const numeric = Number(fileId);
  if (!Number.isFinite(numeric)) throw ttsError(label + '返回的 file_id 不是数字', 'TTS_UPSTREAM');
  return numeric;
}

/** 生成一个符合 MiniMax 规则的自定义 voice_id（8–256、字母开头、字母数字-_）。 */
function generateVoiceId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return 'qqbot' + Date.now().toString(36) + rand;
}

/** T2A v2 非流式合成（hex → 文件）。 */
async function synthesizeMiniMax(kind, { provider, text, options = {}, outPath, signal, logger } = {}) {
  const meta = kindOf(kind);
  if (!meta) throw ttsError('未知的 MiniMax 语音类型: ' + String(kind), 'TTS_CONFIG');
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const opts = options && typeof options === 'object' ? options : {};
  const baseUrl = baseUrlOf(config);
  const secret = secretOf(provider, 'MiniMax 语音');
  const model = String(opts.model || config.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  // 默认类型允许配置档覆盖音色；克隆/设计类型必须用生成出来的 voiceId（配置档的音色覆盖不适用）。
  const configuredVoice = String(config.voiceId || config.voice || '').trim();
  const voiceId = kind === 'minimax'
    ? (String(opts.voice || '').trim() || configuredVoice)
    : (configuredVoice || String(opts.voice || '').trim());
  if (voiceId === '') {
    throw ttsError('该 MiniMax 供应商还没有音色 ID：请先在卡片里执行「' + (meta.prepareLabel || '生成音色') + '」', 'TTS_CONFIG');
  }
  const speedRaw = opts.speed !== undefined && opts.speed !== null ? opts.speed : config.speed;
  const speed = Number.isFinite(Number(speedRaw)) ? Math.min(2, Math.max(0.5, Number(speedRaw))) : 1;
  const pitch = Number.isFinite(Number(config.pitch)) ? Math.min(12, Math.max(-12, Math.trunc(Number(config.pitch)))) : 0;
  const vol = Number.isFinite(Number(config.vol)) ? Math.min(10, Math.max(0.1, Number(config.vol))) : 1;
  const emotion = String(opts.emotion || config.emotion || '').trim();
  const voiceSetting = { voice_id: voiceId, speed, pitch, vol };
  if (emotion !== '') voiceSetting.emotion = emotion;
  const body = {
    model,
    text,
    stream: false,
    voice_setting: voiceSetting,
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
  };
  const { data } = await fetchJson(baseUrl + '/v1/t2a_v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret },
    body: JSON.stringify(body),
  }, { timeoutMs: DEFAULT_TIMEOUT_MS, signal, label: 'MiniMax 语音' });
  assertMiniMaxOk(data, 'MiniMax 语音');
  const hex = data && data.data && data.data.audio;
  if (typeof hex !== 'string' || hex.trim() === '') throw ttsError('MiniMax 语音返回里没有音频数据', 'TTS_UPSTREAM');
  const buffer = Buffer.from(hex.trim(), 'hex');
  if (buffer.length === 0) throw ttsError('MiniMax 语音返回了空音频', 'TTS_UPSTREAM');
  const sniffed = sniffAudioMediaType(buffer);
  const rawFormat = String((data.extra_info && data.extra_info.audio_format) || '').toLowerCase();
  const format = rawFormat === 'wav' || rawFormat === 'flac' ? rawFormat : (sniffed && sniffed.endsWith('/wav') ? 'wav' : 'mp3');
  await writeAudioFile(outPath, buffer);
  logger?.debug?.('[tts:minimax:' + kind + '] 合成完成 ' + buffer.length + ' bytes, voice=' + voiceId);
  return { bytes: buffer.length, format, model, voice: voiceId };
}

/** 克隆：上传样本（+可选示例）→ voice_clone → configPatch.voiceId。 */
async function prepareClone({ provider, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const baseUrl = baseUrlOf(config);
  const secret = secretOf(provider, 'MiniMax 音色克隆');
  const sample = await readSample(config.samplePath, '克隆样本');
  const fileId = await uploadFile({ baseUrl, secret, file: sample, purpose: 'voice_clone', signal, label: 'MiniMax 上传克隆样本' });
  logger?.debug?.('[tts:minimax-clone] 样本已上传 file_id=' + fileId);

  let clonePrompt = null;
  const promptSamplePath = String(config.promptSamplePath || '').trim();
  if (promptSamplePath !== '') {
    const promptFile = await readSample(promptSamplePath, '示例音频');
    const promptFileId = await uploadFile({ baseUrl, secret, file: promptFile, purpose: 'prompt_audio', signal, label: 'MiniMax 上传示例音频' });
    clonePrompt = { prompt_audio: promptFileId, prompt_text: String(config.promptText || '').trim() };
    logger?.debug?.('[tts:minimax-clone] 示例音频已上传 file_id=' + promptFileId);
  }

  const voiceId = String(config.voiceId || '').trim() || generateVoiceId();
  const body = { file_id: fileId, voice_id: voiceId };
  if (clonePrompt) body.clone_prompt = clonePrompt;
  const { data } = await fetchJson(baseUrl + '/v1/voice_clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret },
    body: JSON.stringify(body),
  }, { timeoutMs: DEFAULT_TIMEOUT_MS, signal, label: 'MiniMax 音色克隆' });
  assertMiniMaxOk(data, 'MiniMax 音色克隆');
  const returned = String((data && data.voice_id) || '').trim();
  if (returned === '') throw ttsError('MiniMax 音色克隆返回里没有 voice_id', 'TTS_UPSTREAM');
  logger?.info?.('[tts:minimax-clone] 克隆完成 voice_id=' + returned);
  return { configPatch: { voiceId: returned }, meta: { voiceId: returned, fileId } };
}

/** 文字设计：voice_design → voice_id + trial_audio（hex）。 */
async function prepareDesign({ provider, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const baseUrl = baseUrlOf(config);
  const secret = secretOf(provider, 'MiniMax 音色设计');
  const prompt = String(config.description || '').trim();
  if (prompt === '') throw ttsError('MiniMax 音色设计需要填写音色描述（description）', 'TTS_CONFIG');
  const previewText = String(config.previewText || '').trim() || '你好，这是音色设计的试听。';
  const body = { prompt, preview_text: previewText };
  const wanted = String(config.voiceId || '').trim();
  if (wanted !== '') body.voice_id = wanted;
  const { data } = await fetchJson(baseUrl + '/v1/voice_design', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret },
    body: JSON.stringify(body),
  }, { timeoutMs: DEFAULT_TIMEOUT_MS, signal, label: 'MiniMax 音色设计' });
  assertMiniMaxOk(data, 'MiniMax 音色设计');
  const voiceId = String((data && data.voice_id) || '').trim();
  if (voiceId === '') throw ttsError('MiniMax 音色设计返回里没有 voice_id', 'TTS_UPSTREAM');
  let demoAudioBase64 = '';
  let demoMimeType = '';
  let demoBytes = 0;
  const trial = typeof data.trial_audio === 'string' ? data.trial_audio.trim() : '';
  if (trial !== '') {
    try {
      const buffer = Buffer.from(trial, 'hex');
      if (buffer.length > 0 && Math.ceil(buffer.length / 3) * 4 <= MAX_DEMO_BASE64) {
        const sniffed = sniffAudioMediaType(buffer);
        const fmt = sniffed ? sniffed.split('/')[1] : 'mpeg';
        demoMimeType = mimeTypeFor(fmt === 'mpeg' ? 'mp3' : fmt);
        demoAudioBase64 = buffer.toString('base64');
        demoBytes = buffer.length;
      }
    } catch { /* 试听音频解码失败不影响设计结果 */ }
  }
  logger?.info?.('[tts:minimax-design] 设计完成 voice_id=' + voiceId);
  return { configPatch: { voiceId }, meta: { voiceId }, demoAudioBase64, demoMimeType, demoBytes };
}

export async function synthesizeForKind(kind, args) {
  return synthesizeMiniMax(kind, args);
}

export async function prepareForKind(kind, args) {
  if (kind === 'minimax-clone') return prepareClone(args);
  if (kind === 'minimax-design') return prepareDesign(args);
  throw ttsError('该 MiniMax 类型不支持生成音色操作', 'TTS_CONFIG');
}

export default {
  kind: 'minimax',
  synthesize: (args) => synthesizeMiniMax('minimax', args),
};
