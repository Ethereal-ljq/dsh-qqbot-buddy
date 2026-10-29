/**
 * knowledge/store —— 知识库：通用条目库（lib/entries/store.js）的 knowledge 特化。
 *
 * - 磁盘布局、frontmatter 格式、索引与原子写全部复用 createEntryStore；
 *   <dir>/entries/<id>.md + <dir>/index.json。
 * - dir 每次从 settings.get().knowledge.dir 读取（设置热改立即生效）；
 *   缺省 <cwd>/knowledge，与「一个工作区」原则一致。
 * - 设置读取一律容错：settings 缺失 / get() 抛错 / knowledge 段缺字段时用内置默认。
 */
import path from 'node:path';

import { createEntryStore } from '../entries/store.js';

const KIND = 'knowledge';
/** settings.knowledge 缺省值（与设计文档 §2.3 一致） */
export const KNOWLEDGE_DEFAULTS = Object.freeze({
  enabled: true,
  injectMaxChars: 2500,
  maxPerTurn: 4,
  autoExtract: { enabled: false, everyRounds: 6, maxEntries: 3, minConfidence: 0.8, provider: '', model: '' },
});

function normalizeAutoExtract(raw) {
  const base = KNOWLEDGE_DEFAULTS.autoExtract;
  if (raw === true) return { ...base, enabled: true };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...base };
  const int = (value, min, max, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
  };
  const num = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    enabled: raw.enabled === true,
    everyRounds: int(raw.everyRounds, 1, 100, base.everyRounds),
    maxEntries: int(raw.maxEntries, 1, 10, base.maxEntries),
    minConfidence: num(raw.minConfidence, 0, 1, base.minConfidence),
    provider: typeof raw.provider === 'string' ? raw.provider.trim().slice(0, 100) : '',
    model: typeof raw.model === 'string' ? raw.model.trim().slice(0, 200) : '',
  };
}

function clampInt(value, min, max, fallback) {
  let num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) return fallback;
  num = Math.trunc(num);
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

/**
 * 创建知识库。
 * @param {{settings?: {get: () => any}, logger?: any, dir?: string|(() => string)}} options
 *   dir 显式覆盖时优先于 settings.knowledge.dir（测试/多实例用）。
 */
export function createKnowledgeStore({ settings, logger, dir } = {}) {
  const log = logger ?? console;

  /** 当前 settings.knowledge 段（容错） */
  function cfg() {
    try {
      const snapshot = typeof settings?.get === 'function' ? settings.get() : {};
      const knowledge = snapshot && typeof snapshot === 'object' ? snapshot.knowledge : undefined;
      return knowledge && typeof knowledge === 'object' && !Array.isArray(knowledge) ? knowledge : {};
    } catch (err) {
      log.warn?.('knowledge-store: 读取 settings.knowledge 失败，使用默认值:', err && err.message);
      return {};
    }
  }

  /** 目录解析：显式 dir > settings.knowledge.dir > <cwd>/knowledge */
  function resolveDir() {
    const raw = cfg().dir;
    if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim());
    return path.join(process.cwd(), 'knowledge');
  }

  const dirOption = typeof dir === 'function'
    ? dir
    : (typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : resolveDir);

  const store = createEntryStore({ dir: dirOption, kind: KIND, logger: log });

  /** 知识库设置段（补齐默认值，dir 用真实生效路径） */
  function config() {
    const raw = cfg();
    return {
      enabled: raw.enabled !== false,
      dir: store.dir(),
      injectMaxChars: clampInt(raw.injectMaxChars, 0, 20_000, KNOWLEDGE_DEFAULTS.injectMaxChars),
      maxPerTurn: clampInt(raw.maxPerTurn, 0, 20, KNOWLEDGE_DEFAULTS.maxPerTurn),
      autoExtract: normalizeAutoExtract(raw.autoExtract),
    };
  }

  /**
   * 保存条目（kind 固定 knowledge；id 缺省自动生成）。
   * @param {object} input 条目字段
   * @param {{deferIndex?: boolean}} [options] 透传给条目库（延迟写索引）
   */
  function save(input = {}, options = {}) {
    return store.save({ ...(input || {}), kind: KIND }, options);
  }

  return {
    available: true,
    dir: () => store.dir(),
    ensure: (...args) => store.ensure(...args),
    get: (id) => store.get(id),
    save,
    remove: (id) => store.remove(id),
    list: (options) => store.list(options),
    search: (query, options) => store.search(query, options),
    recall: (input) => store.recall(input),
    stats: () => store.stats(),
    groups: () => store.groups(),
    all: () => store.all(),
    noteHit: (id) => store.noteHit(id),
    rebuild: () => store.rebuild(),
    reload: () => store.reload(),
    flush: () => store.flush(),
    config,
    kind: () => KIND,
  };
}

export default createKnowledgeStore;
