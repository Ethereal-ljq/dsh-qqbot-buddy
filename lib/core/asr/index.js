/**
 * core/asr —— 语音识别（ASR）引擎。
 *
 * 与 TTS 共用 provider 表 / secret / 控制台「语音」页的供应商面板（kind.capability='asr'），
 * 但合成引擎（core/tts）会跳过 ASR 供应商；这里只做「音频文件 → 文本」。
 *
 * 选择顺序：profile 的 asr.provider → 全局 asr.defaultProvider → 第一个启用的 ASR 供应商。
 * 未开启 asr.enabled 时调用方（入站中间件）不应调用本模块。
 */
import { capabilityOf, kindOf, providerView, publicKinds } from '../tts/providers.js';
import { createTtsProviderStore } from '../tts/store.js';
import { ttsError } from '../tts/http.js';
import deepseekAdapter from './adapters/deepseek.js';
import mimoAdapter from './adapters/mimo.js';
import openaiAdapter from './adapters/openai.js';
import fasterWhisperAdapter from './adapters/faster-whisper.js';

/** kind → ASR 适配器（新增 ASR 供应商 = providers.js 加 kind + 这里登记）。 */
const ADAPTERS = {
  'deepseek-asr': deepseekAdapter,
  'mimo-asr': mimoAdapter,
  'openai-asr': openaiAdapter,
  'faster-whisper': fasterWhisperAdapter,
};

function firstString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {{db: object, logger?: object}} deps
 */
export function createAsrEngine({ db, logger } = {}) {
  if (!db) throw new TypeError('createAsrEngine 需要 db');
  const log = logger || console;
  const store = createTtsProviderStore({ db });

  function isAsrRow(row) {
    return Boolean(row) && capabilityOf(row.kind) === 'asr';
  }

  function firstEnabledAsr() {
    try {
      const list = typeof store.list === 'function' ? store.list() : [];
      for (const row of list) {
        if (!row || row.enabled === false || row.enabled === 0) continue;
        if (isAsrRow(row)) return row;
      }
    } catch { /* 查询失败按没有供应商处理 */ }
    return null;
  }

  /** ASR 种类的元数据（控制台展示用）。 */
  function kinds() {
    return publicKinds().filter((kind) => kind.capability === 'asr');
  }

  /** ASR 供应商列表（脱敏）。 */
  function listProviders() {
    return store.listPublic().filter((item) => item.capability === 'asr');
  }

  function getProvider(id) {
    const row = store.get(id);
    if (!isAsrRow(row)) return null;
    return providerView(row);
  }

  /** 新增/编辑 ASR 供应商（只接受 capability=asr 的 kind）。 */
  function saveProvider(input = {}) {
    const src = input && typeof input === 'object' ? input : {};
    const kind = firstString(src.kind);
    const existing = firstString(src.id) !== '' ? store.get(firstString(src.id)) : null;
    const effectiveKind = kind !== '' ? kind : (existing ? existing.kind : '');
    const meta = kindOf(effectiveKind);
    if (!meta || capabilityOf(effectiveKind) !== 'asr') {
      throw ttsError('只有语音识别（ASR）供应商可以保存到 ASR 配置', 'ASR_CONFIG');
    }
    return store.save(src);
  }

  function deleteProvider(id) {
    const target = firstString(id);
    if (target === '') return false;
    const row = store.get(target);
    if (row && !isAsrRow(row)) return false;
    return store.remove(target);
  }

  /** 当前 profile 是否开启 ASR（settings 是 v2 生效设置对象）。 */
  function enabled(settings) {
    const cfg = settings && typeof settings === 'object' ? settings.asr : null;
    return Boolean(cfg && cfg.enabled === true);
  }

  /** 依据设置选择供应商；返回内部行（含 secret），找不到返回 null。 */
  function resolveProviderRow(settings) {
    const cfg = settings && typeof settings === 'object' && settings.asr && typeof settings.asr === 'object' ? settings.asr : {};
    const wanted = firstString(cfg.provider);
    const preferred = firstString(cfg.defaultProvider);
    let row = wanted !== '' ? store.get(wanted) : null;
    if (row && !isAsrRow(row)) row = null;
    if (!row && preferred !== '') {
      row = store.get(preferred);
      if (row && !isAsrRow(row)) row = null;
    }
    if (!row) row = firstEnabledAsr();
    return row;
  }

  /**
   * 语音转文字。
   * @param {{providerId?:string, settings?:object, filePath?:string, bytes?:Buffer, signal?:AbortSignal}} input
   */
  async function transcribe(input = {}) {
    const params = input && typeof input === 'object' ? input : {};
    const startedAt = Date.now();
    const explicitId = firstString(params.providerId);
    let provider = explicitId !== '' ? store.get(explicitId) : resolveProviderRow(params.settings);
    if (!provider) {
      throw ttsError('没有可用的 ASR 供应商：请先在控制台「模型 → 语音 → 语音识别（ASR）」添加并启用供应商，再在「设置 → 语音识别（ASR）」开启', 'ASR_PROVIDER_NOT_FOUND');
    }
    if (!isAsrRow(provider)) {
      throw ttsError('该供应商不是语音识别（ASR）类型，不能用于转写', 'ASR_CONFIG');
    }
    if (provider.enabled !== true) {
      throw ttsError('ASR 供应商已停用: ' + (provider.name || provider.id), 'ASR_DISABLED');
    }
    const adapter = ADAPTERS[provider.kind];
    if (!adapter || typeof adapter.transcribe !== 'function') {
      throw ttsError('ASR 供应商类型暂不支持: ' + provider.kind, 'ASR_CONFIG');
    }
    const result = await adapter.transcribe({
      provider,
      filePath: params.filePath,
      bytes: params.bytes,
      signal: params.signal,
      logger: log,
    });
    return {
      ok: true,
      providerId: provider.id,
      provider: providerView(provider),
      text: result.text,
      durationMs: Number(result.durationMs) > 0 ? Number(result.durationMs) : 0,
      requestId: result.requestId || '',
      bytes: Number(result.bytes) || 0,
      ms: Date.now() - startedAt,
    };
  }

  /** 控制台/工具用：指定供应商的转写测试。 */
  async function test(input = {}) {
    const params = input && typeof input === 'object' ? input : {};
    return transcribe({ ...params, providerId: firstString(params.providerId) });
  }

  return {
    kinds,
    listProviders,
    getProvider,
    saveProvider,
    deleteProvider,
    enabled,
    resolveProviderRow,
    transcribe,
    test,
  };
}

export default { createAsrEngine };
