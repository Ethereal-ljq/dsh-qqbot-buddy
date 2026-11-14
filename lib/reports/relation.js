/**
 * reports/relation —— 群友「关系/好感」的每日增量。
 *
 * 为什么单独一条流水线：
 *   日报是「写群」，关系是「写状态」；混在一次调用里会互相污染，也不好回滚。
 *
 * 规则（防谄媚/防刷分）：
 *   - level -2..2（警惕/一般/普通/亲近/很亲近），每次最多 ±1；
 *   - 必须带原文证据，且逐字命中当天该成员的发言；
 *   - 同一人冷却 7 天（affinity.changedAt）；自然周累计变化不超过 ±2；
 *   - profileSource=manual 默认不改（relation.allowManual 可放开）；
 *   - 每次最多改 5 人，全部写 audit（kind=member.affinity），可追溯。
 */
import { localDay, dayBounds, routeOf } from './daily.js';

export const AFFINITY_MIN = -2;
export const AFFINITY_MAX = 2;
/** 每人自动调整冷却天数。 */
export const COOLDOWN_DAYS = 7;
/** 单人单周累计变化上限（绝对值）。 */
export const WEEK_CAP = 2;
/** 单次最多改几个人。 */
export const MAX_CHANGES = 5;
/** 进入评估的最低当日发言数。 */
export const MIN_SPEAKER_MESSAGES = 5;

function clampLevel(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, n));
}

/** 自然周起点（周一）的本地日期串。 */
export function weekStartKey(at = Date.now()) {
  const d = new Date(at);
  const offset = (d.getDay() + 6) % 7; // 周一=0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
  return localDay(monday);
}

function normalizeEvidence(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

function clean(text, max) {
  const value = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : value.slice(0, max);
}

/** 按发言人聚合当天消息（只保留有 openid 且发言够多的人）。 */
export function groupSpeakers(messages = [], min = MIN_SPEAKER_MESSAGES) {
  const map = new Map();
  for (const row of Array.isArray(messages) ? messages : []) {
    const openid = String(row.senderId || '').trim();
    if (openid === '') continue;
    if (!map.has(openid)) map.set(openid, { openid, name: row.senderName || openid.slice(0, 8), rows: [] });
    const item = map.get(openid);
    item.rows.push(row);
    if (row.senderName) item.name = row.senderName;
  }
  return [...map.values()].filter((item) => item.rows.length >= min);
}

/** 当前是否在冷却期 / 本周额度是否用完。 */
export function relationBudget(affinity = {}, at = Date.now()) {
  const changedAt = Number(affinity.changedAt) || 0;
  const cooldown = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  if (changedAt > 0 && at - changedAt < cooldown) {
    return { ok: false, reason: 'cooldown' };
  }
  const week = weekStartKey(at);
  const used = String(affinity.weekStart || '') === week ? Number(affinity.weekDelta) || 0 : 0;
  if (Math.abs(used) >= WEEK_CAP) return { ok: false, reason: 'week-cap' };
  return { ok: true, week, used };
}

/** 构造提示词：只评价对机器人的态度。 */
export function buildRelationPrompt({ day, candidates = [] } = {}) {
  const lines = [];
  lines.push('你在维护一个 QQ 机器人与群友的关系档位（-2..2）。只评价「群友对机器人（助手）的态度」，不评价他在群里的人缘。');
  lines.push('');
  lines.push('档位：-2 警惕、-1 一般、0 普通、1 亲近、2 很亲近。');
  lines.push('规则：');
  lines.push('1) 只根据材料里该成员的原话判断，必须填写 evidence（逐字原话，系统会回查）；');
  lines.push('2) delta 只能是 -1、0 或 1；一次最多调整一档；');
  lines.push('3) 礼貌寒暄、开玩笑、一次夸奖都不足以加分；持续互动、明确表达好感才 +1；');
  lines.push('4) 明确敌意、辱骂、反复驱赶才 -1；阴阳怪气不扣分；');
  lines.push('5) 没把握就不输出该成员；只输出 JSON，不要解释。');
  lines.push('');
  lines.push('输出格式：{"changes":[{"openid":"...","delta":1,"note":"不超过 20 字","evidence":"原话"}]}');
  lines.push('');
  for (const item of candidates) {
    lines.push('### ' + item.name + '（openid=' + item.openid + '，当前 ' + item.level + '）');
    for (const row of item.rows.slice(-12)) {
      lines.push('- ' + clean(row.content, 200));
    }
    lines.push('');
  }
  lines.push('日期：' + day);
  return lines.join('\n');
}

/** 从模型输出里抠 JSON（与 daily 同一策略）。 */
export function extractJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * 校验模型给的 changes：
 *   - openid 必须在候选里；delta ∈ {-1,0,1}；
 *   - evidence 必须逐字命中该成员当天发言；
 *   - 每人最多一条，整体最多 MAX_CHANGES 条。
 */
export function sanitizeChanges(parsed, candidates = []) {
  const byId = new Map((Array.isArray(candidates) ? candidates : []).map((item) => [item.openid, item]));
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(parsed && parsed.changes) ? parsed.changes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const openid = String(raw.openid || '').trim();
    const candidate = byId.get(openid);
    if (!candidate || seen.has(openid)) continue;
    const delta = Math.round(Number(raw.delta));
    if (!Number.isFinite(delta) || delta < -1 || delta > 1 || delta === 0) continue;
    const evidence = normalizeEvidence(raw.evidence).slice(0, 200);
    if (evidence.length < 2) continue;
    const corpus = candidate.rows.map((row) => normalizeEvidence(row.content));
    if (!corpus.some((body) => body.includes(evidence))) continue;
    seen.add(openid);
    out.push({ openid, name: candidate.name, delta, note: clean(raw.note, 40), evidence: String(raw.evidence).trim().slice(0, 200) });
    if (out.length >= MAX_CHANGES) break;
  }
  return out;
}

/**
 * 执行每日关系增量。
 * @param {object} args
 * @param {object} args.flow
 * @param {object} args.members
 * @param {object} args.oneShot
 * @param {object} args.config createConfigStore()（用于 audit）
 * @param {string} args.botId
 * @param {string} args.peer
 * @param {string} [args.day]
 * @param {object} [args.settings]
 * @param {object} [args.logger]
 */
export async function updateRelations({
  flow, members, oneShot, config, botId, peer, day, settings, logger, now = Date.now(),
} = {}) {
  const log = logger || console;
  const relationCfg = (settings && settings.relation) || {};
  if (relationCfg.enabled !== true) return { ok: true, skipped: 'disabled', changes: [] };
  if (!flow || !members || !oneShot) return { ok: false, reason: 'missing-deps', changes: [] };

  const target = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : localDay(new Date(now));
  const { start, end } = dayBounds(target);
  const messages = flow.list({ botId, peer, since: start, until: end - 1, limit: 5000 }) || [];
  const speakers = groupSpeakers(messages);
  if (speakers.length === 0) return { ok: true, skipped: 'no-speakers', changes: [] };

  const allowManual = relationCfg.allowManual === true;
  const candidates = [];
  for (const item of speakers.slice(0, 20)) {
    const member = members.get({ botId, openid: item.openid });
    const profile = member && member.profileJson && typeof member.profileJson === 'object' ? member.profileJson : {};
    if (String(profile.profileSource || '') === 'manual' && !allowManual) continue;
    const affinity = profile.affinity && typeof profile.affinity === 'object' ? profile.affinity : {};
    const budget = relationBudget(affinity, now);
    if (!budget.ok) continue;
    const level = clampLevel(affinity.level);
    candidates.push({ ...item, level, affinity, budget });
  }
  if (candidates.length === 0) return { ok: true, skipped: 'no-candidates', changes: [] };

  const prompt = buildRelationPrompt({ day: target, candidates });
  const route = routeOf(settings);
  let output;
  try {
    output = await oneShot.generate({
      prompt,
      maxTokens: 800,
      timeoutMs: 120000,
      plugin: 'dsh-qqbot-buddy:relation',
      ...(route ? { provider: route.provider, model: route.model } : {}),
    });
  } catch (err) {
    return { ok: false, reason: 'llm-error', error: (err && err.message) || String(err), changes: [] };
  }
  if (!output || output.ok !== true) return { ok: false, reason: 'llm-failed', error: output && output.error, changes: [] };

  const parsed = extractJson(output.text);
  const changes = sanitizeChanges(parsed, candidates);
  const applied = [];
  for (const change of changes) {
    const candidate = candidates.find((item) => item.openid === change.openid);
    if (!candidate) continue;
    const before = clampLevel(candidate.level);
    const next = clampLevel(before + change.delta);
    if (next === before) continue;
    // 自然周累计变化 = 本周已用 + 本次变化，夹在 ±WEEK_CAP
    const cappedDelta = Math.max(-WEEK_CAP, Math.min(WEEK_CAP, candidate.budget.used + (next - before)));
    const finalLevel = clampLevel(before + (cappedDelta - candidate.budget.used));
    if (finalLevel === before) continue;
    const affinity = {
      ...candidate.affinity,
      level: finalLevel,
      note: change.note || candidate.affinity.note || '',
      changedAt: now,
      weekStart: candidate.budget.week,
      weekDelta: cappedDelta,
      source: 'auto',
    };
    const profile = members.get({ botId, openid: change.openid });
    const profileJson = profile && profile.profileJson && typeof profile.profileJson === 'object' ? profile.profileJson : {};
    try {
      members.upsert({ botId, openid: change.openid, profile: { ...profileJson, affinity } });
    } catch (err) {
      log.warn?.('关系写入失败（忽略）: ' + ((err && err.message) || String(err)));
      continue;
    }
    try {
      config?.audit?.({
        botId,
        kind: 'member.affinity',
        detail: JSON.stringify({ openid: change.openid, before, after: finalLevel, delta: finalLevel - before, note: affinity.note, evidence: change.evidence, day: target }),
      });
    } catch { /* 审计失败不影响状态 */ }
    applied.push({ ...change, before, after: finalLevel });
  }
  if (applied.length > 0) {
    log.info?.('群友关系已更新: ' + peer + ' ' + target + ' 共 ' + applied.length + ' 人');
  }
  return { ok: true, day: target, changes: applied };
}

export default updateRelations;
