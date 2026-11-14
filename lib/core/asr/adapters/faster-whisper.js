/**
 * asr/adapters/faster-whisper —— 本地 faster-whisper（Python venv + CTranslate2）。
 *
 * 调用 lib/core/asr/workers/faster_whisper.py：模型在本地运行，完全离线、无 API 费用。
 * pythonPath / modelPath 支持 ~ 展开；耗时取决于 CPU/模型，超时默认 180s。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { kindOf } from '../../tts/providers.js';
import { ttsError, truncate } from '../../tts/http.js';
import { expandHome } from '../credentials.js';

const KIND = 'faster-whisper';
const META = kindOf(KIND);
const DEFAULT_TIMEOUT_MS = 180000;
const WORKER_PATH = fileURLToPath(new URL('../workers/faster_whisper_worker.py', import.meta.url));

function requireLocalFile(filePath, label) {
  const expanded = expandHome(filePath);
  if (expanded === '') throw ttsError('本地 faster-whisper 缺少' + label, 'ASR_CONFIG');
  try {
    if (!fs.statSync(expanded).isFile()) throw new Error('not a file');
  } catch {
    throw ttsError('本地 faster-whisper 的' + label + '不存在: ' + truncate(expanded, 300), 'ASR_CONFIG');
  }
  return expanded;
}

async function transcribe({ provider, filePath, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const pythonPath = requireLocalFile(config.pythonPath, ' Python');
  if (!fs.existsSync(WORKER_PATH)) throw ttsError('faster-whisper worker 脚本缺失: ' + WORKER_PATH, 'ASR_CONFIG');
  const modelPath = expandHome(config.modelPath);
  if (modelPath === '') throw ttsError('本地 faster-whisper 缺少模型路径', 'ASR_CONFIG');
  if (!fs.existsSync(modelPath) && /[\\/]/.test(modelPath)) {
    throw ttsError('本地 faster-whisper 模型路径不存在: ' + truncate(modelPath, 300), 'ASR_CONFIG');
  }
  const audioPath = String(filePath || '');
  if (audioPath === '') throw ttsError('本地 faster-whisper 需要音频文件', 'ASR_CONFIG');
  if (!fs.existsSync(audioPath)) throw ttsError('语音识别音频文件不存在: ' + truncate(audioPath, 300), 'ASR_CONFIG');

  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const args = [
    WORKER_PATH,
    '--model', modelPath,
    '--audio', audioPath,
    '--language', String(config.language || 'auto').trim() || 'auto',
    '--device', String(config.device || 'auto').trim() || 'auto',
    '--compute-type', String(config.computeType || 'default').trim() || 'default',
    '--beam-size', String(Number(config.beamSize) > 0 ? Number(config.beamSize) : 5),
  ];
  const result = spawnSync(pythonPath, args, {
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    signal,
  });
  if (!result || result.error) {
    const code = result && result.error && result.error.code;
    if (code === 'ETIMEDOUT') throw ttsError('本地 faster-whisper 转写超时（' + timeoutMs + 'ms），可换更小模型', 'ASR_UPSTREAM');
    throw ttsError('本地 faster-whisper 执行失败: ' + truncate(result && result.error ? result.error.message : '未知错误', 300), 'ASR_UPSTREAM');
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().split('\n').slice(-2).join(' ');
    throw ttsError('本地 faster-whisper 转写失败: ' + truncate(stderr, 500), 'ASR_UPSTREAM');
  }
  const stdout = String(result.stdout || '').trim();
  let payload = null;
  try {
    payload = JSON.parse(stdout.split('\n').filter(Boolean).pop() || '{}');
  } catch {
    throw ttsError('本地 faster-whisper 输出不是合法 JSON: ' + truncate(stdout, 300), 'ASR_UPSTREAM');
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text === '') throw ttsError('本地 faster-whisper 没有识别出文字', 'ASR_EMPTY');
  logger?.debug?.('[asr:faster-whisper] 识别完成 ' + text.length + ' 字，model=' + modelPath);
  return {
    text,
    durationMs: Number(payload.duration) > 0 ? Math.round(Number(payload.duration) * 1000) : 0,
    language: payload.language || '',
    bytes: 0,
    format: 'wav',
  };
}

export default { kind: KIND, transcribe };
