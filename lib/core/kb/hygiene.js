/**
 * core/kb/hygiene —— 知识库治理：置信度低 + 召回少的知识定期"软归档"，归档满 TTL 再物理删除。
 *
 * 设计要点（2026-11-16）：
 * - 保护位优先：pinned=1、kind='rule'、authority=member/admin 的文档永不自动清理
 *   （群友自己写的规则/梗即使没人检索也必须留着，靠 pinned 注入生效，而不是靠召回）；
 * - 只打"普通知识"：kind ∈ {fact, lookup, meme, other} 且 authority ∈ {model, external}；
 *   kind 为 NULL 的历史数据（v1 迁移）跳过，避免误删；
 * - 置信度低 + 召回少是"与"关系：高置信但冷门不删，低置信但常被召回也不删（交给人工改）；
 * - 软归档（stale_at）→ 控制台可恢复；归档满 archiveTtlDays 天才真删。
 *
 * 阈值全部可调（配置档 → 知识库），默认值刻意调短：软归档保留 7 天，方便肉眼验证。
 */
import { defaultConfidence, normalizeConfidence, normalizeKind } from './store.js';

/** 默认阈值（改这里要同步 core/config/schema.js 的默认值）。 */
export const HYGIENE_DEFAULTS = Object.freeze({
  enabled: true,
  confidenceFloor: 40,
  staleAgeDays: 14,
  recallIdleDays: 45,
  archiveTtlDays: 7,
  pinnedInjectChars: 240,
});

const DAY_MS = 24 * 60 * 60 * 1000;

function numOf(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

/** 从生效设置里读治理阈值（兼容嵌套 {kb:{...}} 与扁平 'kb.xxx' 两种形态）。 */
export function resolveHygieneSettings(settings = {}) {
  const bag = settings && typeof settings === 'object' ? settings : {};
  const nested = bag.kb && typeof bag.kb === 'object' && !Array.isArray(bag.kb) ? bag.kb : {};
  const pick = (key) => (nested[key] !== undefined ? nested[key] : bag['kb.' + key]);
  const enabled = pick('hygieneEnabled') !== undefined ? pick('hygieneEnabled') !== false : HYGIENE_DEFAULTS.enabled;
  return {
    enabled,
    confidenceFloor: numOf(pick('confidenceFloor'), HYGIENE_DEFAULTS.confidenceFloor, 0, 100),
    staleAgeDays: numOf(pick('staleAgeDays'), HYGIENE_DEFAULTS.staleAgeDays, 1, 3650),
    recallIdleDays: numOf(pick('recallIdleDays'), HYGIENE_DEFAULTS.recallIdleDays, 1, 3650),
    archiveTtlDays: numOf(pick('archiveTtlDays'), HYGIENE_DEFAULTS.archiveTtlDays, 1, 365),
    pinnedInjectChars: numOf(pick('pinnedInjectChars'), HYGIENE_DEFAULTS.pinnedInjectChars, 0, 4000),
  };
}

/** 单篇文档是否参与自动治理（保护位/来源/分类三重豁免）。 */
export function isProtectedDoc(doc = {}) {
  if (doc.pinned === true) return true;
  if (normalizeKind(doc.kind) === 'rule') return true;
  const authority = typeof doc.authority === 'string' ? doc.authority : '';
  if (authority === 'member' || authority === 'admin') return true;
  // kind 未分类 = 历史数据（v1 迁移 / 旧版本写入），不参与自动清理
  return normalizeKind(doc.kind) === null;
}

/** 计算一次治理计划（纯函数，便于单测/干跑预览）。 */
export function planHygiene({ docs = [], settings = {}, now = Date.now() } = {}) {
  const cfg = resolveHygieneSettings(settings);
  const archive = [];
  const purge = [];
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (!doc || typeof doc !== 'object') continue;
    const staleAt = doc.staleAt === null || doc.staleAt === undefined ? null : Number(doc.staleAt);
    if (staleAt !== null) {
      if (now - staleAt >= cfg.archiveTtlDays * DAY_MS) purge.push({ id: Number(doc.id), title: doc.title || doc.source || '', staleAt });
      continue;
    }
    if (isProtectedDoc(doc)) continue;
    const confidence = normalizeConfidence(doc.confidence)
      ?? defaultConfidence({ kind: normalizeKind(doc.kind), authority: doc.authority || 'model' });
    // 高置信一律不动（哪怕冷门）；低置信才进入候选，冷召回的门槛放宽到 floor+20。
    if (confidence >= cfg.confidenceFloor + 20) continue;
    const ageDays = (now - Number(doc.updatedAt || doc.createdAt || now)) / DAY_MS;
    const idleDays = doc.lastRecalledAt ? (now - Number(doc.lastRecalledAt)) / DAY_MS : null;
    const noRecall = confidence < cfg.confidenceFloor
      && (Number(doc.recallCount) || 0) === 0
      && ageDays >= cfg.staleAgeDays;
    const coldRecall = confidence < cfg.confidenceFloor + 20
      && idleDays !== null
      && idleDays >= cfg.recallIdleDays
      && (Number(doc.recallCount) || 0) < 2;
    if (!noRecall && !coldRecall) continue;
    const reason = noRecall
      ? '置信度 ' + confidence + ' < ' + cfg.confidenceFloor + '，入库 ' + Math.floor(ageDays) + ' 天从未被召回'
      : '置信度 ' + confidence + '，' + Math.floor(idleDays) + ' 天未被召回且召回 < 2 次';
    archive.push({ id: Number(doc.id), title: doc.title || doc.source || '', reason, confidence });
  }
  return { config: cfg, archive, purge };
}

/**
 * 执行一次治理：扫描 → 归档 → 清理超 TTL 的归档。
 * @param {{kb: object, botId: string, settings?: object, now?: number, dryRun?: boolean, purge?: boolean}} args
 */
export function runKbHygiene({ kb, botId, settings = {}, now = Date.now(), dryRun = false, purge = true } = {}) {
  if (!kb || typeof kb.listDocs !== 'function') {
    return { ok: false, reason: 'kb 未装配', scanned: 0, archive: [], purge: [] };
  }
  const docs = kb.listDocs({ botId, includeArchived: true, limit: 5000 });
  const plan = planHygiene({ docs, settings, now });
  const result = { ok: true, dryRun, scanned: Array.isArray(docs) ? docs.length : 0, archive: plan.archive, purge: plan.purge, config: plan.config };
  if (dryRun) return result;
  let archived = 0;
  for (const item of plan.archive) {
    try {
      const updated = kb.updateDocMeta({ botId, id: item.id, patch: { stale: true, staleAt: now, staleReason: item.reason } });
      if (updated && updated.updated !== false) archived += 1;
    } catch { /* 单篇失败不影响其它 */ }
  }
  let purged = 0;
  if (purge && plan.purge.length > 0 && typeof kb.purgeArchived === 'function') {
    purged = Number(kb.purgeArchived({ botId, before: now - plan.config.archiveTtlDays * DAY_MS })?.purged) || 0;
  }
  result.archived = archived;
  result.purged = purged;
  return result;
}

/**
 * 启动知识治理定时器：每 30 分钟扫一次，按每 bot 的 kb.hygieneIntervalHours 决定是否真跑。
 * 失败只 warn，不影响主流程；返回 dispose。
 * @param {{kb: object, config: object, logger?: object, checkIntervalMs?: number, now?: Function}} args
 */
export function startHygieneScheduler({ kb, config, logger, checkIntervalMs = 30 * 60 * 1000, now = Date.now } = {}) {
  if (!kb || typeof kb.listDocs !== 'function' || !config || typeof config.listBots !== 'function') {
    return () => {};
  }
  const lastRun = new Map();
  let timer = null;
  const tick = () => {
    let bots = [];
    try { bots = config.listBots() || []; } catch { bots = []; }
    for (const bot of bots) {
      try {
        const botId = String(bot && bot.id ? bot.id : '');
        if (botId === '') continue;
        let settings = {};
        try { settings = config.getSettings(botId) || {}; } catch { settings = {}; }
        const cfg = resolveHygieneSettings(settings);
        if (!cfg.enabled) continue;
        const rawInterval = Number(settings?.kb?.hygieneIntervalHours ?? settings?.['kb.hygieneIntervalHours']);
        const intervalHours = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 24;
        const last = lastRun.get(botId) || 0;
        if (now() - last < intervalHours * 60 * 60 * 1000) continue;
        lastRun.set(botId, now());
        const result = runKbHygiene({ kb, botId, settings, now: now(), dryRun: false });
        if (result && (result.archived > 0 || result.purged > 0)) {
          logger?.info?.('知识治理：bot=' + botId + ' 归档 ' + (result.archived || 0) + ' 篇、清理 ' + (result.purged || 0) + ' 篇');
        }
      } catch (err) {
        logger?.warn?.('知识治理失败（单个 bot，跳过）: ' + ((err && err.message) || String(err)));
      }
    }
  };
  try {
    tick();
    timer = setInterval(tick, checkIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    logger?.info?.('知识治理调度已启动（每 ' + Math.round(checkIntervalMs / 60000) + ' 分钟检查一次）');
  } catch (err) {
    logger?.warn?.('知识治理调度启动失败: ' + ((err && err.message) || String(err)));
  }
  return () => {
    if (timer !== null) { clearInterval(timer); timer = null; }
  };
}
