/**
 * qq/voice-asr —— QQ 语音消息 → DeepSeek 官方 ASR 转写。
 *
 * 位置：附件中间件里（门控之后、入站组装之前）。下载语音附件 → ffmpeg 转 16-bit PCM
 * WAV（16 kHz 单声道，≤asr.maxSeconds 秒）→ runtime.asr.transcribe → 写入
 * ctx.state.processedAttachments（inbound 的 buildVoicePart 直接使用）。
 *
 * 失败/未开启一律静默降级：保留 QQ 自带 asr_refer_text 或语音 URL 文案，不影响回复。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ffmpegBinary } from '../core/tts/audio.js';

/** 语音识别目标格式：16kHz 单声道 16bit PCM WAV（DeepSeek ASR 支持 8000–48000Hz）。 */
const TARGET_SAMPLE_RATE = 16000;
const CONVERT_TIMEOUT_MS = 30000;

/** 把任意输入音频转成 ASR 可接受的 WAV；失败返回空串（不抛错）。 */
function convertToWav(inputPath, maxSeconds, logger) {
  const binary = ffmpegBinary();
  if (!binary) {
    logger?.debug?.('[asr] 本机没有 ffmpeg，跳过语音转写（回退 QQ 文本）');
    return '';
  }
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-asr-'));
    const output = path.join(dir, 'voice.wav');
    const seconds = Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Math.min(120, Math.max(5, Math.floor(Number(maxSeconds))))
      : 120;
    const result = spawnSync(binary, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-vn', '-ac', '1', '-ar', String(TARGET_SAMPLE_RATE), '-sample_fmt', 's16',
      '-t', String(seconds),
      output,
    ], { timeout: CONVERT_TIMEOUT_MS, encoding: 'utf8' });
    if (!result || result.error || result.status !== 0) {
      logger?.debug?.('[asr] 语音转码失败，跳过: ' + String((result && result.stderr) || '').slice(0, 300));
      return '';
    }
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) return '';
    return output;
  } catch (err) {
    logger?.debug?.('[asr] 语音转码异常，跳过: ' + (err && err.message ? err.message : String(err)));
    return '';
  }
}

/**
 * @param {{asr: object, getSettings?: Function, logger?: object}} deps
 * @returns {null | ((args: {message:object, files:Array}) => Promise<Array>)}
 */
export function createVoiceTranscriber({ asr, getSettings, logger } = {}) {
  if (!asr || typeof asr.transcribe !== 'function') return null;

  function settingsFor(message) {
    try {
      return typeof getSettings === 'function' ? (getSettings(message) || {}) : {};
    } catch {
      return {};
    }
  }

  async function transcribeVoiceFiles({ message, files, settings: provided } = {}) {
    const settings = provided && typeof provided === 'object' ? provided : settingsFor(message);
    const cfg = settings && typeof settings === 'object' && settings.asr && typeof settings.asr === 'object'
      ? settings.asr
      : null;
    if (!cfg || cfg.enabled !== true) return [];
    const list = Array.isArray(files) ? files : [];
    const processed = [];
    for (const file of list) {
      if (!file || !file.localPath) continue;
      const wavPath = convertToWav(file.localPath, cfg.maxSeconds, logger);
      if (wavPath === '') continue;
      try {
        const result = await asr.transcribe({ settings, filePath: wavPath });
        const text = result && typeof result.text === 'string' ? result.text.trim() : '';
        if (text !== '') {
          processed.push({
            type: 'voice',
            voiceText: text,
            duration: result.durationMs > 0 ? Math.round(result.durationMs / 1000) : undefined,
            providerId: result.providerId,
          });
          logger?.debug?.('[asr] 语音转写完成: ' + text.slice(0, 80));
        }
      } catch (err) {
        logger?.warn?.('语音识别失败（回退 QQ 自带文本）: ' + (err && err.message ? err.message : String(err)));
      } finally {
        try { fs.rmSync(wavPath, { force: true }); } catch { /* 清理失败忽略 */ }
      }
    }
    return processed;
  }
  // 供附件中间件在下载前判断：是否启用 ASR、策略是 fallback 还是 always
  transcribeVoiceFiles.settingsFor = settingsFor;
  return transcribeVoiceFiles;
}

export default { createVoiceTranscriber };
