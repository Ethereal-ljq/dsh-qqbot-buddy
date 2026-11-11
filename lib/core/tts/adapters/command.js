/**
 * adapters/command —— 本地命令行 TTS（piper / sherpa-onnx / edge-tts CLI / say 等）。
 *
 * 契约 §6：spawn('/bin/sh', ['-c', 命令模板])，占位符做 shell 单引号转义；
 *   {{output}} 会替换成 outPath（扩展名已按 config.outputFormat 决定）；
 *   命令必须退出码 0 且生成非空输出文件；超时 kill；禁止把 text 直接拼进 shell。
 *
 * 安全：这是管理员显式配置本机命令的能力；文本一律经 shellQuote 包成单引号参数。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';

import { kindOf } from '../providers.js';
import { ttsError, truncate } from '../http.js';
import { normalizeFormat } from '../audio.js';

const KIND = 'command';
const META = kindOf(KIND);
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_STDERR = 4000;

/** POSIX shell 单引号转义：' → '\''。 */
export function shellQuote(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/** 渲染命令模板：已知占位符替换为转义后的单引号参数，未知占位符原样保留。 */
export function renderCommandTemplate(template, values) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? shellQuote(values[key]) : match
  ));
}

/** 合成一段文本。 */
async function synthesize({ provider, text, options = {}, outPath, signal, logger } = {}) {
  const config = provider && provider.config && typeof provider.config === 'object' ? provider.config : {};
  const opts = options && typeof options === 'object' ? options : {};
  const template = String(config.command || '').trim();
  if (template === '') throw ttsError('本地命令模式需要填写命令模板', 'TTS_CONFIG');
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const format = normalizeFormat(config.outputFormat) || normalizeFormat(META.outputFormat) || 'mp3';
  const values = {
    text,
    voice: opts.voice || config.voice || '',
    style: opts.style || config.style || '',
    speed: String(opts.speed !== undefined && opts.speed !== null ? opts.speed : (config.speed !== undefined ? config.speed : 1)),
    output: outPath,
  };
  const rendered = renderCommandTemplate(template, values);
  const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : nodeSpawn;

  await new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let stderr = '';
    let timer = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };
    const killChild = () => {
      try { if (child && typeof child.kill === 'function') child.kill('SIGKILL'); } catch { /* 已退出则忽略 */ }
    };
    const onAbort = () => { killChild(); finish(ttsError('本地 TTS 命令已取消', 'TTS_ABORTED')); };
    if (signal && signal.aborted) { onAbort(); return; }
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      killChild();
      finish(ttsError('本地 TTS 命令超时（' + timeoutMs + 'ms）', 'TTS_TIMEOUT'));
    }, timeoutMs);
    try {
      child = spawnFn('/bin/sh', ['-c', rendered], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      finish(ttsError('本地 TTS 命令启动失败: ' + truncate(err && err.message ? err.message : String(err)), 'TTS_CONFIG'));
      return;
    }
    if (!child || typeof child.on !== 'function') {
      finish(ttsError('本地 TTS 命令无法启动（spawn 返回值异常）', 'TTS_CONFIG'));
      return;
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR);
      });
    }
    child.on('error', (err) => {
      finish(ttsError('本地 TTS 命令执行失败: ' + truncate(err && err.message ? err.message : String(err)), 'TTS_CONFIG'));
    });
    child.on('close', (code, exitSignal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim() !== '' ? '：' + truncate(stderr.trim()) : '';
        finish(ttsError('本地 TTS 命令退出码 ' + code + (exitSignal ? '（signal=' + exitSignal + '）' : '') + detail, 'TTS_UPSTREAM'));
        return;
      }
      fs.stat(outPath).then((stat) => {
        if (settled) return;
        if (!stat.isFile() || stat.size === 0) {
          finish(ttsError('本地 TTS 命令没有生成音频文件: ' + truncate(outPath, 200), 'TTS_UPSTREAM'));
          return;
        }
        finish(null);
      }).catch(() => {
        finish(ttsError('本地 TTS 命令没有生成音频文件: ' + truncate(outPath, 200), 'TTS_UPSTREAM'));
      });
    });
  });

  const stat = await fs.stat(outPath);
  logger?.debug?.('[tts:command] 合成完成 ' + stat.size + ' bytes');
  return { bytes: stat.size, format, model: 'command', voice: values.voice };
}

export default { kind: KIND, synthesize };
