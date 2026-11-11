/**
 * core/tts/audio —— 文本分段、音频拼接与落盘（纯 Node，零依赖）。
 *
 * 引擎合成流程（契约 §6）：
 *   1. splitTextSegments：按换行/句末标点切句，装箱到 ≤ kind.maxCharsPerRequest；
 *   2. 适配器逐段合成到临时文件；
 *   3. mergeAudioBuffers：wav 解析各段 PCM data 后重写标准 WAV 头；mp3 字节顺序拼接；
 *      本机有 ffmpeg 时优先尝试 ffmpeg concat（缺失/失败静默降级，绝不抛错）；
 *   4. writeAudioFile / removeFiles：落盘与清理。
 *
 * 为什么 wav 要手工合并：TTS 供应商通常返回同一采样参数的 PCM，直接重写 RIFF 头
 * 比逐段转码又快又无损；ffmpeg 只作为格式不一致时的兜底。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ttsError } from './http.js';

/** 默认单段字符上限（voice.maxChars 的默认值）。 */
export const DEFAULT_MAX_CHARS = 300;

/** 归一化音频格式：只认 mp3/wav，其它返回空串。 */
export function normalizeFormat(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'wav' || text === 'mp3') return text;
  if (text === 'mpeg' || text === 'audio/mpeg' || text === 'audio/mp3') return 'mp3';
  if (text === 'audio/wav' || text === 'audio/x-wav' || text === 'audio/wave') return 'wav';
  return '';
}

/** 按 Unicode 码点切分，避免把 emoji/代理对切成两半。 */
function hardSplit(text, limit) {
  const chars = Array.from(text);
  if (chars.length <= limit) return [text];
  const out = [];
  for (let index = 0; index < chars.length; index += limit) {
    out.push(chars.slice(index, index + limit).join(''));
  }
  return out;
}

/** 切句：按换行拆行后，按句末标点切句（标点保留在前一句结尾）。 */
function splitSentences(line) {
  const matched = line.match(/[^。！？!?；;…]+[。！？!?；;…]*/g);
  return matched ? matched.filter((item) => item.trim() !== '') : [];
}

/**
 * 文本分段：按换行/句末标点切句，再装箱成每段 ≤ maxChars。
 * 超长单句会被硬切，保证任何一段都不超过供应商单次请求上限。
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string[]} 非空分段（按原文顺序）
 */
export function splitTextSegments(text, maxChars = DEFAULT_MAX_CHARS) {
  const limit = Math.max(1, Math.floor(Number(maxChars)) || DEFAULT_MAX_CHARS);
  const source = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text);
  const normalized = source.replace(/\r\n?/g, '\n').trim();
  if (normalized === '') return [];
  const units = [];
  for (const paragraph of normalized.split(/\n+/)) {
    const line = paragraph.trim();
    if (line === '') continue;
    for (const sentence of splitSentences(line)) {
      const trimmed = sentence.trim();
      if (trimmed === '') continue;
      if (Array.from(trimmed).length <= limit) units.push(trimmed);
      else units.push(...hardSplit(trimmed, limit));
    }
  }
  // 装箱：相邻句子尽量合并到同一段，减少请求数
  const segments = [];
  let current = '';
  let currentLength = 0;
  for (const unit of units) {
    const unitLength = Array.from(unit).length;
    if (current === '') {
      current = unit;
      currentLength = unitLength;
      continue;
    }
    if (currentLength + unitLength <= limit) {
      current += unit;
      currentLength += unitLength;
      continue;
    }
    segments.push(current);
    current = unit;
    currentLength = unitLength;
  }
  if (current !== '') segments.push(current);
  return segments;
}

/** RIFF chunk 构造（payload 奇数长度补 1 字节对齐）。 */
function buildChunk(id, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const padding = data.length % 2;
  const out = Buffer.alloc(8 + data.length + padding);
  out.write(id, 0, 'ascii');
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
}

/**
 * 解析 WAV：返回 fmt 块原始字节（保留 extensible 等扩展）与拼接后的 data 块。
 * @param {Buffer|Uint8Array} bytes
 */
export function parseWav(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length < 12) throw ttsError('WAV 音频数据过短，无法解析', 'TTS_UPSTREAM');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw ttsError('不是合法的 WAV 音频（缺少 RIFF/WAVE 标记）', 'TTS_UPSTREAM');
  }
  let offset = 12;
  let fmt = null;
  const dataChunks = [];
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(buffer.length, start + size);
    if (id === 'fmt ') {
      if (end - start < 16) throw ttsError('WAV 的 fmt 块不完整', 'TTS_UPSTREAM');
      fmt = {
        raw: Buffer.from(buffer.subarray(start, end)),
        size,
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      dataChunks.push(Buffer.from(buffer.subarray(start, end)));
    }
    offset = start + size + (size % 2);
  }
  if (!fmt) throw ttsError('WAV 音频缺少 fmt 块', 'TTS_UPSTREAM');
  if (dataChunks.length === 0) throw ttsError('WAV 音频缺少 data 块', 'TTS_UPSTREAM');
  return { fmt, data: Buffer.concat(dataChunks) };
}

/** 用 fmt 原始字节 + PCM data 重写标准 WAV（RIFF/fmt/data，长度对齐）。 */
export function encodeWavFromFmt(fmtRaw, pcmData) {
  const fmtChunk = buildChunk('fmt ', fmtRaw);
  const data = Buffer.isBuffer(pcmData) ? pcmData : Buffer.from(pcmData || []);
  const dataChunk = buildChunk('data', data);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmtChunk, dataChunk]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** 用 PCM 数据构造标准 WAV（测试与本地合成兜底用）。 */
export function encodeWav(pcmData, options = {}) {
  const channels = Math.max(1, Math.floor(Number(options.channels)) || 1);
  const sampleRate = Math.max(1, Math.floor(Number(options.sampleRate)) || 24000);
  const bitsPerSample = Math.max(8, Math.floor(Number(options.bitsPerSample)) || 16);
  const blockAlign = channels * (bitsPerSample / 8);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bitsPerSample, 14);
  return encodeWavFromFmt(fmt, Buffer.isBuffer(pcmData) ? pcmData : Buffer.from(pcmData || []));
}

/**
 * 合并多段 WAV：要求 fmt 块完全一致（同一供应商同一请求参数必然一致），
 * 拼接 PCM data 后重写头；不一致时抛 TTS_UPSTREAM（由 mergeAudioBuffers 尝试 ffmpeg 兜底）。
 */
export function mergeWavBuffers(buffers) {
  const list = (Array.isArray(buffers) ? buffers : []).map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item || [])));
  if (list.length === 0) throw ttsError('没有可合并的 WAV 分段', 'TTS_UPSTREAM');
  if (list.length === 1) return list[0];
  const parsed = list.map(parseWav);
  const first = parsed[0];
  for (const item of parsed) {
    if (!item.fmt.raw.equals(first.fmt.raw)) {
      throw ttsError('WAV 分段格式不一致，无法直接合并', 'TTS_UPSTREAM');
    }
  }
  return encodeWavFromFmt(first.fmt.raw, Buffer.concat(parsed.map((item) => item.data)));
}

/** ffmpeg 探测结果缓存：undefined 未探测 / null 不可用 / 字符串为可执行路径。 */
let ffmpegCache;

/**
 * 探测 ffmpeg 可执行文件（可用 QQBOT_TTS_FFMPEG 指定路径、QQBOT_TTS_DISABLE_FFMPEG=1 关闭）。
 * 缺失返回 null（调用方降级为纯 JS 拼接，不报错）。
 */
export function ffmpegBinary(env = process.env) {
  const settings = env && typeof env === 'object' ? env : {};
  if (settings.QQBOT_TTS_DISABLE_FFMPEG === '1') return null;
  if (ffmpegCache !== undefined) return ffmpegCache;
  const configured = typeof settings.QQBOT_TTS_FFMPEG === 'string' ? settings.QQBOT_TTS_FFMPEG.trim() : '';
  if (configured !== '') {
    ffmpegCache = configured;
    return ffmpegCache;
  }
  try {
    const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 3000 });
    ffmpegCache = probe && !probe.error && probe.status === 0 ? 'ffmpeg' : null;
  } catch {
    ffmpegCache = null;
  }
  return ffmpegCache;
}

/** 仅测试用：清空 ffmpeg 探测缓存。 */
export function resetFfmpegCache() {
  ffmpegCache = undefined;
}

/** 用 ffmpeg concat demuxer 拼接；不可用或失败返回 null（由调用方降级）。 */
function tryFfmpegConcat(buffers, format, options = {}) {
  const binary = options.ffmpeg === null ? null : (options.ffmpeg || ffmpegBinary());
  if (!binary) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-tts-merge-'));
  try {
    const inputs = buffers.map((buffer, index) => {
      const file = path.join(dir, 'seg-' + index + '.' + format);
      fs.writeFileSync(file, buffer);
      return file;
    });
    const listFile = path.join(dir, 'list.txt');
    // concat demuxer 的 file 指令：路径里的单引号用 '\'' 转义
    fs.writeFileSync(listFile, inputs.map((file) => "file '" + file.replace(/'/g, "'\\''") + "'").join('\n'));
    const outFile = path.join(dir, 'out.' + format);
    const result = spawnSync(binary, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', outFile,
    ], { timeout: Math.max(10000, buffers.length * 5000), encoding: 'utf8' });
    if (!result || result.error || result.status !== 0) {
      options.logger?.debug?.('[tts] ffmpeg 拼接失败，降级为纯 JS 拼接: ' + (result && result.stderr ? result.stderr.slice(0, 300) : ''));
      return null;
    }
    const stat = fs.statSync(outFile);
    if (!stat.isFile() || stat.size === 0) return null;
    return fs.readFileSync(outFile);
  } catch (err) {
    options.logger?.debug?.('[tts] ffmpeg 拼接异常，降级为纯 JS 拼接: ' + (err && err.message ? err.message : String(err)));
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  }
}

/**
 * 合并多段音频。
 * - wav：优先纯 JS 重写 WAV 头（无损、快）；格式不一致时尝试 ffmpeg，仍失败则抛可读错误；
 * - mp3：优先 ffmpeg concat（顺序播放更稳）；ffmpeg 缺失/失败时字节顺序拼接，绝不报错；
 * - 其它：字节顺序拼接。
 * @param {Buffer[]} buffers
 * @param {'mp3'|'wav'|string} format
 * @param {{logger?:object, ffmpeg?:string|null}} [options]
 * @returns {Buffer}
 */
export function mergeAudioBuffers(buffers, format, options = {}) {
  const list = (Array.isArray(buffers) ? buffers : [])
    .map((item) => (Buffer.isBuffer(item) ? item : Buffer.from(item || [])))
    .filter((item) => item.length > 0);
  if (list.length === 0) throw ttsError('没有可拼接的音频分段', 'TTS_UPSTREAM');
  if (list.length === 1) return list[0];
  const normalized = normalizeFormat(format);
  if (normalized === 'wav') {
    try {
      return mergeWavBuffers(list);
    } catch (err) {
      const merged = tryFfmpegConcat(list, 'wav', options);
      if (merged) return merged;
      throw err instanceof Error ? err : ttsError('WAV 分段合并失败', 'TTS_UPSTREAM');
    }
  }
  const merged = tryFfmpegConcat(list, 'mp3', options);
  if (merged) return merged;
  return Buffer.concat(list);
}

/** 写音频文件（自动建目录）。 */
export async function writeAudioFile(filePath, data) {
  const raw = String(filePath === undefined || filePath === null ? '' : filePath).trim();
  if (raw === '') throw ttsError('音频输出路径为空', 'TTS_CONFIG');
  const target = path.resolve(raw);
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, buffer);
  return { filePath: target, bytes: buffer.length };
}

/** 尽力删除一批临时文件（不存在/权限错误忽略）。 */
export async function removeFiles(files = []) {
  for (const file of files) {
    try { await fsp.rm(String(file), { force: true }); } catch { /* 清理失败不影响主流程 */ }
  }
}

export default {
  DEFAULT_MAX_CHARS, normalizeFormat, splitTextSegments, parseWav, encodeWavFromFmt, encodeWav,
  mergeWavBuffers, ffmpegBinary, resetFfmpegCache, mergeAudioBuffers, writeAudioFile, removeFiles,
};
