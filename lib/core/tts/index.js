/**
 * core/tts/index —— TTS 引擎（模型中心 · 语音）。
 *
 * 对外契约见 docs/MODELS-CENTER.md §6；console API 与 qqbot_speak 工具都依赖这个接口：
 *   kinds / listProviders / getProvider / saveProvider / deleteProvider /
 *   resolveSelection / synthesize / synthesizeForSettings / test / audioDir
 *
 * 职责：
 * - 从 provider store 取供应商（secret 只在内部行里用，不对外）；
 * - resolveSelection：profile 的 voice.*（含全局 voice.defaultProvider）→ 生效选择；
 * - synthesize：按 kind.maxCharsPerRequest 分段 → 适配器逐段合成到临时文件 →
 *   wav 重写头 / mp3 拼接（ffmpeg 可选）→ 写 dataDir/tts-media；
 * - 错误统一 Error + 稳定 .code（TTS_*），消息中文可读；
 * - 环境变量 QQBOT_EDGE_TTS_URL / QQBOT_TTS_FFMPEG / QQBOT_TTS_DISABLE_FFMPEG 见各模块。
 *
 * 装配失败由 lib/index.js 捕获并降级（runtime.tts=null），不阻断插件启动。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { kindOf, providerView, publicKinds } from './providers.js';
import { createTtsProviderStore } from './store.js';
import { mergeAudioBuffers, normalizeFormat, removeFiles, splitTextSegments, writeAudioFile } from './audio.js';
import { mimeTypeFor, ttsError, truncate } from './http.js';
import edgeAdapter from './adapters/edge.js';
import mimoAdapter from './adapters/mimo.js';
import bailianAdapter from './adapters/bailian.js';
import openaiAdapter from './adapters/openai.js';
import customAdapter from './adapters/custom.js';
import commandAdapter from './adapters/command.js';

/** kind → 适配器（新增供应商 = providers.js 加 kind + 这里登记适配器）。 */
const ADAPTERS = {
  edge: edgeAdapter,
  mimo: mimoAdapter,
  bailian: bailianAdapter,
  openai: openaiAdapter,
  custom: customAdapter,
  command: commandAdapter,
};

const DEFAULT_MAX_CHARS = 300;
const MAX_MAX_CHARS = 10000;
/** 控制台试听返回的 base64 上限（契约 §7：超 4MB 省略并返回 tooLarge）。 */
const TEST_MAX_BASE64 = 4 * 1024 * 1024;
const DEFAULT_TEST_TEXT = '你好，这是一条语音合成测试。';
const AUDIO_DIR_NAME = 'tts-media';

/** 空串归一化。 */
function firstString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 归一化单次文字上限（默认 300，来自 voice.maxChars）。 */
function normalizeMaxChars(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(1, Math.floor(number)));
}

/** 归一化语速（0.25 ~ 4，默认 1）。 */
function normalizeSpeed(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return Math.min(4, Math.max(0.25, number));
}

/** 随机 hex。 */
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** yyyyMMdd-HHmmss 文件名前缀 + 随机串（+ 可选安全 hint）。 */
function buildBaseName(date, fileNameHint) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate())
    + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  const hint = typeof fileNameHint === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(fileNameHint.trim())
    ? '-' + fileNameHint.trim()
    : '';
  return stamp + '-' + randomHex(3) + hint;
}

/** 非 TTS_* 错误统一加中文前缀 + 稳定 code（fs/undici 的英文错误也能给用户看）。 */
function normalizeError(err) {
  if (!(err instanceof Error)) return ttsError('语音合成失败: ' + truncate(String(err)), 'TTS_UPSTREAM');
  if (typeof err.code === 'string' && err.code.startsWith('TTS_')) return err;
  err.code = 'TTS_UPSTREAM';
  if (!err.message || err.message.trim() === '') err.message = '语音合成失败';
  else if (!/[\u4e00-\u9fa5]/.test(err.message)) err.message = '语音合成失败: ' + err.message;
  return err;
}

/**
 * 创建 TTS 引擎。
 * @param {{db: import('node:sqlite').DatabaseSync, dataDir: string, logger?: object}} options
 */
export function createTtsEngine({ db, dataDir, logger } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createTtsEngine: 需要由 lib/core/db.js 的 openDb() 打开的 db');
  }
  const rootDir = typeof dataDir === 'string' ? dataDir.trim() : '';
  if (rootDir === '') throw new TypeError('createTtsEngine: 需要 dataDir（音频输出目录的父目录）');
  const baseDir = path.resolve(rootDir);
  const log = logger && typeof logger === 'object' ? logger : console;
  const store = createTtsProviderStore({ db });
  const audioRoot = path.join(baseDir, AUDIO_DIR_NAME);

  /** 音频输出目录（懒创建，保证存在）。 */
  function audioDir() {
    try {
      fs.mkdirSync(audioRoot, { recursive: true, mode: 0o755 });
    } catch (err) {
      throw ttsError('TTS 音频目录创建失败: ' + truncate(err && err.message ? err.message : String(err)), 'TTS_CONFIG');
    }
    return audioRoot;
  }

  /** 供应商种类元数据（前端通用表单用）。 */
  function kinds() {
    return publicKinds();
  }

  /** 供应商列表（secret 脱敏）。 */
  function listProviders() {
    return store.listPublic();
  }

  /** 单个供应商（secret 脱敏）。 */
  function getProvider(id) {
    return store.getPublic(id);
  }

  /** 新增/编辑供应商（校验/secret 保留由 store + providers.js 负责）。 */
  function saveProvider(input) {
    return store.save(input);
  }

  /** 删除供应商。 */
  function deleteProvider(id) {
    return store.remove(id);
  }

  /**
   * profile 设置 → 生效的供应商选择；未启用或没有可用供应商返回 null（纯查询，不抛错）。
   * 查找顺序：voice.provider → voice.defaultProvider（global 合并值）→ 第一个启用的供应商。
   * @param {{settings?: object}} [input]
   */
  function resolveSelection({ settings } = {}) {
    const voiceCfg = settings && typeof settings === 'object' && settings.voice && typeof settings.voice === 'object'
      ? settings.voice
      : null;
    if (!voiceCfg || voiceCfg.enabled !== true) return null;
    const wanted = firstString(voiceCfg.provider);
    const preferred = firstString(voiceCfg.defaultProvider);
    let row = wanted !== '' ? store.get(wanted) : null;
    if (!row && preferred !== '') row = store.get(preferred);
    if (!row) row = store.firstEnabled();
    if (!row) return null;
    const config = row.config || {};
    return {
      provider: providerView(row),
      providerId: row.id,
      voice: firstString(voiceCfg.voice) || firstString(config.voice),
      style: firstString(voiceCfg.style) || firstString(config.style),
      speed: normalizeSpeed(voiceCfg.speed !== undefined ? voiceCfg.speed : config.speed),
      maxChars: normalizeMaxChars(voiceCfg.maxChars),
    };
  }

  /**
   * 合成语音并落盘。
   * @param {object} input
   * @param {string} input.text
   * @param {string} [input.providerId] 显式指定供应商（控制台试听/指定路由用）
   * @param {string} [input.voice] 音色覆盖
   * @param {string} [input.style] 风格指令覆盖
   * @param {number} [input.speed] 语速覆盖
   * @param {number} [input.maxChars] 文字上限（默认取 settings.voice.maxChars）
   * @param {object} [input.settings] 生效设置（不传则用第一个启用的供应商）
   * @param {string} [input.fileNameHint] 文件名提示（仅 [A-Za-z0-9_-] 生效）
   * @param {AbortSignal} [input.signal]
   * @param {string} [input.outDir] 输出目录覆盖（测试用）
   */
  async function synthesize(input = {}) {
    const startedAt = Date.now();
    const params = input && typeof input === 'object' ? input : {};
    const settings = params.settings && typeof params.settings === 'object' ? params.settings : null;
    const explicitId = firstString(params.providerId);
    const selection = settings ? resolveSelection({ settings }) : null;

    // ── 1. 选供应商 ──────────────────────────────────────────
    let provider = null;
    if (explicitId !== '') {
      provider = store.get(explicitId);
      if (!provider) throw ttsError('TTS 供应商不存在: ' + explicitId, 'TTS_PROVIDER_NOT_FOUND');
    } else if (selection) {
      provider = store.get(selection.providerId);
      if (!provider) throw ttsError('TTS 供应商不存在: ' + selection.providerId, 'TTS_PROVIDER_NOT_FOUND');
    } else if (settings) {
      const voiceCfg = settings.voice && typeof settings.voice === 'object' ? settings.voice : {};
      if (voiceCfg.enabled !== true) throw ttsError('语音合成未启用（配置档 → 语音（TTS））', 'TTS_DISABLED');
      throw ttsError('没有可用的 TTS 供应商：请先在控制台「模型 → 语音（TTS）」里添加并启用供应商', 'TTS_PROVIDER_NOT_FOUND');
    } else {
      provider = store.firstEnabled();
      if (!provider) throw ttsError('没有可用的 TTS 供应商：请先在控制台「模型 → 语音（TTS）」里添加并启用供应商', 'TTS_PROVIDER_NOT_FOUND');
    }
    if (provider.enabled !== true) {
      throw ttsError('TTS 供应商已停用: ' + (provider.name || provider.id), 'TTS_DISABLED');
    }
    const meta = kindOf(provider.kind);
    if (!meta) throw ttsError('未知的 TTS 供应商类型: ' + provider.kind, 'TTS_CONFIG');
    const adapter = ADAPTERS[provider.kind];
    if (!adapter || typeof adapter.synthesize !== 'function') {
      throw ttsError('TTS 供应商类型暂不支持: ' + provider.kind, 'TTS_CONFIG');
    }
    const config = provider.config && typeof provider.config === 'object' ? provider.config : {};

    // ── 2. 文本截断与参数 ────────────────────────────────────
    const voiceCfg = settings && settings.voice && typeof settings.voice === 'object' ? settings.voice : {};
    const maxChars = normalizeMaxChars(
      params.maxChars !== undefined && params.maxChars !== null
        ? params.maxChars
        : (selection ? selection.maxChars : voiceCfg.maxChars),
    );
    const rawText = typeof params.text === 'string' ? params.text : String(params.text === undefined || params.text === null ? '' : params.text);
    let text = rawText.trim();
    if (text === '') throw ttsError('要合成的文字不能为空', 'TTS_EMPTY_TEXT');
    let truncated = false;
    const chars = Array.from(text);
    if (chars.length > maxChars) {
      text = chars.slice(0, maxChars).join('').trimEnd();
      truncated = true;
    }
    if (text === '') throw ttsError('要合成的文字不能为空', 'TTS_EMPTY_TEXT');

    const options = {
      voice: firstString(params.voice) || (selection ? selection.voice : '') || firstString(config.voice),
      style: firstString(params.style) || (selection ? selection.style : '') || firstString(config.style),
      speed: normalizeSpeed(
        params.speed !== undefined && params.speed !== null
          ? params.speed
          : (selection ? selection.speed : config.speed),
      ),
    };

    // ── 3. 分段 → 逐段合成 → 拼接 → 落盘 ────────────────────
    const plannedFormat = normalizeFormat(meta.outputFormat) || 'mp3';
    const outRoot = typeof params.outDir === 'string' && params.outDir.trim() !== ''
      ? path.resolve(params.outDir.trim())
      : audioDir();
    try { fs.mkdirSync(outRoot, { recursive: true, mode: 0o755 }); } catch (err) {
      throw ttsError('TTS 输出目录创建失败: ' + truncate(err && err.message ? err.message : String(err)), 'TTS_CONFIG');
    }
    const baseName = buildBaseName(new Date(), params.fileNameHint);
    const tempPaths = [];
    try {
      const segments = splitTextSegments(text, meta.maxCharsPerRequest);
      if (segments.length === 0) throw ttsError('要合成的文字不能为空', 'TTS_EMPTY_TEXT');
      const results = [];
      for (let index = 0; index < segments.length; index += 1) {
        const segmentPath = path.join(outRoot, '.tts-seg-' + randomHex(4) + '-' + index + '.' + plannedFormat);
        tempPaths.push(segmentPath);
        const result = await adapter.synthesize({
          provider,
          text: segments[index],
          options: { ...options },
          outPath: segmentPath,
          signal: params.signal,
          logger: log,
        });
        results.push(result && typeof result === 'object' ? result : {});
      }
      const formats = results.map((item) => normalizeFormat(item.format)).filter((item) => item !== '');
      const sameFormat = formats.length === results.length && new Set(formats).size === 1;
      const actualFormat = sameFormat ? formats[0] : plannedFormat;
      const buffers = [];
      for (const segmentPath of tempPaths) {
        try {
          buffers.push(fs.readFileSync(segmentPath));
        } catch {
          throw ttsError('语音分段文件读取失败: ' + truncate(segmentPath, 200), 'TTS_UPSTREAM');
        }
      }
      if (buffers.length === 0 || buffers.every((item) => item.length === 0)) {
        throw ttsError('语音合成没有产出音频数据', 'TTS_UPSTREAM');
      }
      const merged = buffers.length === 1 ? buffers[0] : mergeAudioBuffers(buffers, actualFormat, { logger: log });
      const finalPath = path.join(outRoot, baseName + '.' + actualFormat);
      await writeAudioFile(finalPath, merged);
      const first = results[0] || {};
      return {
        ok: true,
        providerId: provider.id,
        kind: provider.kind,
        model: firstString(first.model) || firstString(config.model) || provider.kind,
        voice: firstString(first.voice) || options.voice,
        format: actualFormat,
        filePath: finalPath,
        bytes: merged.length,
        ms: Date.now() - startedAt,
        segments: segments.length,
        truncated,
        text,
      };
    } catch (err) {
      throw normalizeError(err);
    } finally {
      await removeFiles(tempPaths);
    }
  }

  /** 按生效设置合成（工具层/自动回复用）。 */
  async function synthesizeForSettings(input = {}) {
    const params = input && typeof input === 'object' ? input : {};
    const { settings, ...rest } = params;
    return synthesize({ ...rest, settings: settings || null });
  }

  /**
   * 控制台试听：合成一段测试语音，返回 base64 供前端 <audio> 播放。
   * audioBase64 超过 4MB 时省略并返回 tooLarge:true（契约 §7）。
   */
  async function test(input = {}) {
    const startedAt = Date.now();
    const params = input && typeof input === 'object' ? input : {};
    const providerId = firstString(params.providerId);
    if (providerId === '') throw ttsError('缺少 TTS 供应商 id', 'TTS_CONFIG');
    const rawText = typeof params.text === 'string' && params.text.trim() !== '' ? params.text.trim() : DEFAULT_TEST_TEXT;
    const text = Array.from(rawText).slice(0, 500).join('');
    const result = await synthesize({
      text,
      providerId,
      outDir: audioDir(),
      maxChars: 500,
      fileNameHint: 'test',
    });
    let audioBase64 = '';
    let tooLarge = false;
    try {
      const buffer = fs.readFileSync(result.filePath);
      // base64 长度 = ceil(bytes / 3) * 4；超过 4MB 就不返回（避免控制台请求体爆炸）
      if (Math.ceil(buffer.length / 3) * 4 > TEST_MAX_BASE64) tooLarge = true;
      else audioBase64 = buffer.toString('base64');
    } catch (err) {
      throw normalizeError(err);
    } finally {
      try { fs.rmSync(result.filePath, { force: true }); } catch { /* 清理失败不影响结果 */ }
    }
    const out = {
      ok: true,
      providerId: result.providerId,
      kind: result.kind,
      model: result.model,
      voice: result.voice,
      format: result.format,
      bytes: result.bytes,
      ms: Date.now() - startedAt,
      mimeType: mimeTypeFor(result.format),
    };
    if (tooLarge) out.tooLarge = true;
    else out.audioBase64 = audioBase64;
    return out;
  }

  return {
    kinds,
    listProviders,
    getProvider,
    saveProvider,
    deleteProvider,
    resolveSelection,
    synthesize,
    synthesizeForSettings,
    test,
    audioDir,
  };
}

export default { createTtsEngine };
