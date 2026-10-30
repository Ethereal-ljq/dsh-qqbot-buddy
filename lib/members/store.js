/**
 * members/store —— 群友库：一条成员 = 一条 kind='member' 的通用条目。
 *
 * 复用 lib/entries/store.js（同一套 frontmatter / index.json / 原子写），
 * 成员 id 由 openid 稳定派生：m_<sha1(openid).slice(0,16)>，同一 openid 永远不会产生重复条目。
 *
 * meta 结构：
 * {
 *   openid,
 *   name,
 *   aliases: [],
 *   groups: { [groupId]: { name?, firstSeenAt, lastSeenAt, messageCount } }
 * }
 *
 * 复杂度说明（visit 是每条群消息都会调用的热路径）：
 * - 成员全量加载进内存缓存一次（首条 visit/list 时扫描 entries/*.md，O(成员数) 次小文件读）；
 * - visit 只做：更新内存中的那一条 + 原子写 1 个成员小文件 + 延迟写索引（deferIndex，
 *   索引最多延迟 600ms，期间靠 <dir>/.index-dirty 标记保证崩溃后可全量重建）；
 *   不重写整个文件池，每条消息的磁盘成本 = 1 个小文件（通常 < 1KB）。
 * - list/search/recallAlly/groups/stats 走内存缓存，O(成员数) 纯计算。
 * - reload() 丢弃缓存（外部改动 / 目录热改后调用）。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { createEntryStore, matchScore, recencyScore } from '../entries/store.js';

const KIND = 'member';
/** settings.members 缺省值（与设计文档 §2.4 一致） */
export const MEMBER_DEFAULTS = Object.freeze({
  enabled: true,
  autoRecord: true,
  injectSender: true,
  maxPerTurn: 3,
  maxChars: 800,
});
/** 列表里 note 的最大展示长度（完整正文用 get 读取） */
const MAX_AUTO_NOTES = 4;
const AUTO_NOTE_MAX_CHARS = 500;
const LIST_NOTE_CHARS = 2000;

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function clampInt(value, min, max, fallback) {
  let num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) return fallback;
  num = Math.trunc(num);
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

/** 任意时间输入（ISO 字符串 / Date / 毫秒数）→ ISO；失败返回 fallback */
function asIso(value, fallback = '') {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

/** openid → 稳定成员 id（sha1 前 16 位十六进制） */
export function memberId(openid) {
  const raw = asString(openid).trim();
  if (raw === '') return '';
  return `m_${createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 16)}`;
}

/** openid 短码，用于标题兜底展示 */
function shortOpenid(openid) {
  const raw = asString(openid);
  return raw.length <= 8 ? raw : `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

/**
 * 创建群友库。
 * @param {{settings?: {get: () => any}, logger?: any, dir?: string|(() => string)}} options
 */
export function createMemberStore({ settings, logger, dir } = {}) {
  const log = logger ?? console;

  /** 当前 settings.members 段（容错） */
  function cfg() {
    try {
      const snapshot = typeof settings?.get === 'function' ? settings.get() : {};
      const members = snapshot && typeof snapshot === 'object' ? snapshot.members : undefined;
      return members && typeof members === 'object' && !Array.isArray(members) ? members : {};
    } catch (err) {
      log.warn?.('member-store: 读取 settings.members 失败，使用默认值:', err && err.message);
      return {};
    }
  }

  function resolveDir() {
    const raw = cfg().dir;
    if (typeof raw === 'string' && raw.trim() !== '') return path.resolve(raw.trim());
    return path.join(process.cwd(), 'members');
  }

  const dirOption = typeof dir === 'function'
    ? dir
    : (typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : resolveDir);

  const entries = createEntryStore({ dir: dirOption, kind: KIND, logger: log });

  /** 成员缓存：Map<id, entry>；null = 未加载 */
  let cache = null;

  function loadCache() {
    if (cache) return cache;
    cache = new Map();
    for (const entry of entries.all()) {
      if (entry.kind !== KIND) continue;
      cache.set(entry.id, entry);
    }
    return cache;
  }

  /** 设置段（补齐默认值） */
  function config() {
    const raw = cfg();
    return {
      enabled: raw.enabled !== false,
      dir: entries.dir(),
      autoRecord: raw.autoRecord !== false,
      injectSender: raw.injectSender !== false,
      maxPerTurn: clampInt(raw.maxPerTurn, 0, 20, MEMBER_DEFAULTS.maxPerTurn),
      maxChars: clampInt(raw.maxChars, 0, 10_000, MEMBER_DEFAULTS.maxChars),
    };
  }

  function get(id) {
    const safe = asString(id).trim();
    if (safe === '') return null;
    const map = loadCache();
    if (map.has(safe)) return map.get(safe);
    const entry = entries.get(safe);
    if (entry) map.set(safe, entry);
    return entry;
  }

  /** 按 openid 查成员 */
  function getByOpenid(openid) {
    const id = memberId(openid);
    return id === '' ? null : get(id);
  }

  /**
   * 记录一次群消息（upsert）：累加 messageCount、更新 lastSeenAt。
   * @param {{groupId?:string, groupName?:string, openid:string, name?:string, at?:string|Date}} input
   * @returns {object} 完整成员条目
   */
  function visit(input = {}) {
    const openid = asString(input.openid).trim();
    if (openid === '') throw new Error('member-store: openid 不能为空');
    const id = memberId(openid);
    const at = asIso(input.at) || nowIso();
    const groupId = asString(input.groupId).trim();
    const groupName = asString(input.groupName).trim();
    const name = asString(input.name).trim();
    const map = loadCache();
    const existing = map.get(id) || null;
    const meta = existing && existing.meta && typeof existing.meta === 'object' ? { ...existing.meta } : {};
    const groups = meta.groups && typeof meta.groups === 'object' && !Array.isArray(meta.groups)
      ? { ...meta.groups }
      : {};
    if (groupId !== '') {
      const prev = groups[groupId] && typeof groups[groupId] === 'object' ? groups[groupId] : {};
      const prevLast = asIso(prev.lastSeenAt);
      groups[groupId] = {
        name: groupName !== '' ? groupName : asString(prev.name),
        firstSeenAt: asIso(prev.firstSeenAt) || at,
        // 单调前进：乱序事件（延迟上报 / 手工导入）不能把「最近活跃」改回更早
        lastSeenAt: prevLast !== '' && prevLast > at ? prevLast : at,
        messageCount: clampInt(prev.messageCount, 0, Number.MAX_SAFE_INTEGER, 0) + 1,
      };
    }
    meta.openid = openid;
    if (name !== '') meta.name = name;
    if (!Array.isArray(meta.aliases)) meta.aliases = meta.aliases ? [String(meta.aliases)] : [];
    meta.groups = groups;

    const title = asString(meta.name) || asString(existing?.title) || `群友 ${shortOpenid(openid)}`;
    const entry = entries.save({
      id,
      kind: KIND,
      title,
      body: existing?.body ?? '',
      tags: existing?.tags ?? [],
      scope: 'global',
      groupId: '',
      groupName: '',
      importance: existing?.importance ?? 0,
      source: existing?.source || 'auto',
      meta,
      createdAt: existing?.createdAt,
      hits: existing?.hits ?? 0,
      lastHitAt: existing?.lastHitAt ?? '',
    }, { deferIndex: true });
    map.set(id, entry);
    return entry;
  }

  /** 群友结构化画像默认值（存 meta.profile，供提示词懒加载与 UI 编辑） */
const PROFILE_DEFAULTS = Object.freeze({
  nicknames: [],
  personality: [],
  deeds: [],
  affinity: { level: 0, note: '' },
});
const PROFILE_MAX_NICKNAMES = 8;
const PROFILE_MAX_PERSONALITY = 4;
const PROFILE_MAX_DEEDS = 6;
const PROFILE_ITEM_MAX_CHARS = 80;
const PROFILE_AFFINITY_NOTE_CHARS = 60;

function strList(value, maxItems, maxChars) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[，,;；\n]+/) : [];
  const out = [];
  for (const item of source) {
    const text = asString(item).replace(/\s+/g, ' ').trim().slice(0, maxChars);
    if (text === '') continue;
    const key = text.normalize('NFKC').toLowerCase();
    if (out.some((existing) => existing.normalize('NFKC').toLowerCase() === key)) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function uniqueAppend(base, extra, maxItems, maxChars) {
  return strList([...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])], maxItems, maxChars);
}

/** 归一化群友画像（容错旧数据/模型输出；缺字段用默认值） */
function normalizeProfile(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const affinitySrc = src.affinity && typeof src.affinity === 'object' ? src.affinity : {};
  return {
    nicknames: strList(src.nicknames, PROFILE_MAX_NICKNAMES, 40),
    personality: strList(src.personality, PROFILE_MAX_PERSONALITY, PROFILE_ITEM_MAX_CHARS),
    deeds: strList(src.deeds, PROFILE_MAX_DEEDS, PROFILE_ITEM_MAX_CHARS),
    affinity: {
      level: clampInt(affinitySrc.level, -2, 2, 0),
      note: asString(affinitySrc.note).replace(/\s+/g, ' ').trim().slice(0, PROFILE_AFFINITY_NOTE_CHARS),
    },
  };
}

/** 画像 → 一行检索文本（列表搜索/召回匹配用） */
function profileText(profile) {
  const normalized = normalizeProfile(profile);
  return [
    normalized.nicknames.length > 0 ? '称呼：' + normalized.nicknames.join('、') : '',
    normalized.personality.length > 0 ? '性格：' + normalized.personality.join('、') : '',
    normalized.deeds.length > 0 ? '事迹：' + normalized.deeds.join('；') : '',
    normalized.affinity.note !== '' ? '关系：' + normalized.affinity.note : '',
  ]
    .filter((part) => part !== '')
    .join('｜');
}

/** 成员完整信息（列表项） */
  function toItem(entry) {
    const meta = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
    const rawGroups = meta.groups && typeof meta.groups === 'object' && !Array.isArray(meta.groups) ? meta.groups : {};
    const groups = Object.entries(rawGroups).map(([groupId, value]) => {
      const item = value && typeof value === 'object' ? value : {};
      return {
        groupId,
        name: asString(item.name),
        firstSeenAt: asIso(item.firstSeenAt),
        lastSeenAt: asIso(item.lastSeenAt),
        messageCount: clampInt(item.messageCount, 0, Number.MAX_SAFE_INTEGER, 0),
      };
    }).sort((a, b) => (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0));
    let lastSeenAt = '';
    let messageCount = 0;
    for (const group of groups) {
      messageCount += group.messageCount;
      if (group.lastSeenAt > lastSeenAt) lastSeenAt = group.lastSeenAt;
    }
    return {
      id: entry.id,
      openid: asString(meta.openid),
      name: entry.title || asString(meta.name),
      aliases: Array.isArray(meta.aliases) ? meta.aliases.filter((item) => typeof item === 'string') : [],
      tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
      profile: normalizeProfile(meta.profile),
      profileSource: asString(meta.profileSource),
      profileUpdatedAt: asIso(meta.profileUpdatedAt),
      importance: clampInt(entry.importance, 0, 3, 0),
      note: asString(entry.body).slice(0, LIST_NOTE_CHARS),
      notesSource: asString(meta.notesSource) === 'manual' ? 'manual' : (asString(meta.notesSource) === 'auto' ? 'auto' : ''),
      autoNotes: Array.isArray(meta.autoNotes)
        ? meta.autoNotes
          .filter((item) => item && typeof item.text === 'string' && item.text.trim() !== '')
          .slice(0, MAX_AUTO_NOTES)
          .map((item) => ({ text: String(item.text).slice(0, AUTO_NOTE_MAX_CHARS), at: asIso(item.at), confidence: Number(item.confidence) || 0 }))
        : [],
      groups,
      lastSeenAt,
      messageCount,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * 列出成员。
   * @param {{groupId?:string, q?:string, tag?:string, limit?:number, offset?:number}} options
   * @returns {{total:number, items:Array<object>}}
   */
  function list(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const groupId = asString(opts.groupId).trim();
    const query = asString(opts.q).trim();
    const tag = asString(opts.tag).trim();
    const limit = clampInt(opts.limit, 1, 200, 50);
    const offset = clampInt(opts.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const rows = [];
    for (const entry of loadCache().values()) {
      const item = toItem(entry);
      if (groupId !== '' && !item.groups.some((group) => group.groupId === groupId)) continue;
      if (tag !== '' && !item.tags.includes(tag)) continue;
      let score = 0;
      if (query !== '') {
        score = matchScore(query, {
          title: item.name,
          tags: [...item.aliases, ...item.tags],
          summary: [item.note, profileText(item.profile), ...item.groups.map((group) => group.name)].filter(Boolean).join(' '),
        });
        if (score <= 0) continue;
      }
      rows.push({ item, score });
    }
    rows.sort((a, b) => {
      if (query !== '' && b.score !== a.score) return b.score - a.score;
      const at = Date.parse(a.item.lastSeenAt) || Date.parse(a.item.updatedAt) || 0;
      const bt = Date.parse(b.item.lastSeenAt) || Date.parse(b.item.updatedAt) || 0;
      if (at !== bt) return bt - at;
      return a.item.id.localeCompare(b.item.id);
    });
    const total = rows.length;
    return { total, items: rows.slice(offset, offset + limit).map((row) => row.item) };
  }

  /**
   * 群友召回：当前群成员（发言人本人最高权重），供每轮上下文注入。
   * @param {{query?:string, groupId?:string, senderId?:string, limit?:number}} input
   * @returns {Array<object>} 成员条目 + score + group（当前群统计）
   */
  function recallAlly(input = {}) {
    const opts = input && typeof input === 'object' ? input : {};
    const query = asString(opts.query).trim();
    const groupId = asString(opts.groupId).trim();
    const senderId = asString(opts.senderId).trim();
    const limit = clampInt(opts.limit, 1, 50, 3);
    const rows = [];
    for (const entry of loadCache().values()) {
      const item = toItem(entry);
      const group = groupId === '' ? null : item.groups.find((value) => value.groupId === groupId) || null;
      // 指定群时只要该群见过的成员；私聊（无 groupId）时全部成员
      if (groupId !== '' && !group) continue;
      let score = 0;
      // 发言人本人最高权重（说话人自己最相关）
      if (senderId !== '' && item.openid === senderId) score += 100;
      if (query !== '') {
        const matched = matchScore(query, {
          title: item.name,
          tags: [...item.aliases, ...item.tags],
          summary: [item.note, profileText(item.profile), ...item.groups.map((value) => value.name)].filter(Boolean).join(' '),
        });
        if (matched <= 0 && score === 0) continue;
        score += matched * 10;
      } else if (score === 0) {
        // 无 query 时按群活跃度 + 新近度排序：默认只取最近活跃的成员
        score += 1;
      }
      const lastSeenAt = group ? group.lastSeenAt : item.lastSeenAt;
      score += recencyScore(lastSeenAt, 14) * 3;
      score += clampInt(item.importance, 0, 3, 0) * 0.5;
      if (group) score += Math.min(2, Math.log10(group.messageCount + 1)) * 1.5;
      rows.push({ entry, item, group, score: Math.round(score * 1000) / 1000 });
    }
    rows.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.id.localeCompare(b.item.id);
    });
    return rows.slice(0, limit).map(({ entry, group, score }) => ({
      ...entry,
      score,
      group: group
        ? {
          groupId: group.groupId,
          name: group.name,
          firstSeenAt: group.firstSeenAt,
          lastSeenAt: group.lastSeenAt,
          messageCount: group.messageCount,
        }
        : null,
    }));
  }

  /**
   * 手工保存/编辑成员画像（UI）。
   * @param {{id?:string, openid?:string, name?:string, tags?:string[], notes?:string, importance?:number, aliases?:string[]}} input
   * @returns {object} 完整成员条目
   */
  function save(input = {}) {
    const payload = input && typeof input === 'object' ? input : {};
    const openid = asString(payload.openid).trim();
    const id = asString(payload.id).trim() || memberId(openid);
    if (id === '') throw new Error('member-store: 需要 id 或 openid');
    const existing = get(id);
    if (!existing && openid === '' && asString(payload.name).trim() === '') {
      throw new Error(`member-store: 成员不存在: ${id}`);
    }
    const meta = existing && existing.meta && typeof existing.meta === 'object' ? { ...existing.meta } : {};
    if (openid !== '') meta.openid = openid;
    if (!meta.openid && !existing) meta.openid = '';
    // 兼容 Web 路由字段名：title = name、body = notes（UI/API 直接复用条目库字段）
    const name = asString(payload.name !== undefined ? payload.name : payload.title).trim();
    if (name !== '') meta.name = name;
    if (payload.aliases !== undefined) {
      meta.aliases = Array.isArray(payload.aliases)
        ? payload.aliases.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()).slice(0, 8)
        : [];
    }
    if (!Array.isArray(meta.aliases)) meta.aliases = [];
    if (!meta.groups || typeof meta.groups !== 'object' || Array.isArray(meta.groups)) meta.groups = {};
    // 人工编辑画像：整体替换并标记 manual（自动提炼不会覆盖 manual）
    if (payload.profile !== undefined) {
      meta.profile = normalizeProfile(payload.profile);
      meta.profileSource = 'manual';
      meta.profileUpdatedAt = nowIso();
    }
    const tags = payload.tags !== undefined ? payload.tags : existing?.tags ?? [];
    const importance = payload.importance !== undefined ? payload.importance : existing?.importance ?? 0;
    const notesInput = payload.notes !== undefined ? payload.notes : payload.body;
    const body = notesInput !== undefined ? String(notesInput ?? '') : existing?.body ?? '';
    // 人工保存非空备注 → 标记为 manual，自动提炼不再覆盖正文
    if (notesInput !== undefined && body.trim() !== '') meta.notesSource = 'manual';
    const title = asString(meta.name) || asString(existing?.title) || (asString(meta.openid) !== '' ? `群友 ${shortOpenid(meta.openid)}` : '群友');
    const entry = entries.save({
      id,
      kind: KIND,
      title,
      body,
      tags,
      scope: 'global',
      groupId: '',
      groupName: '',
      importance,
      source: existing?.source || 'manual',
      meta,
      createdAt: existing?.createdAt,
      hits: existing?.hits ?? 0,
      lastHitAt: existing?.lastHitAt ?? '',
    });
    loadCache().set(id, entry);
    return entry;
  }

  /**
   * 自动提炼补充备注（默认不覆盖人工备注）：
   * - 正文为空 → 直接写正文，notesSource='auto'；
   * - 正文是自动写的（notesSource='auto'）→ 用新内容替换；
   * - 正文是人工的 → 只追加到 meta.autoNotes（去重、最多 4 条），正文完全不动。
   * @returns {{ok:boolean, mode:'body'|'autoNotes'|'skipped', reason?:string, entry?:object}}
   */
  function applyAutoNote(input = {}) {
    const payload = input && typeof input === 'object' ? input : {};
    const id = asString(payload.id).trim() || (asString(payload.openid).trim() !== '' ? memberId(payload.openid) : '');
    if (id === '') return { ok: false, mode: 'skipped', reason: '缺少 id/openid' };
    const existing = get(id);
    if (!existing) return { ok: false, mode: 'skipped', reason: '成员不存在: ' + id };
    const note = asString(payload.note).replace(/\s+/g, ' ').trim().slice(0, AUTO_NOTE_MAX_CHARS);
    if (note === '') return { ok: false, mode: 'skipped', reason: 'note 为空' };
    const at = asIso(payload.at) || nowIso();
    const confidence = Math.min(1, Math.max(0, Number(payload.confidence) || 0));
    const meta = existing.meta && typeof existing.meta === 'object' ? { ...existing.meta } : {};
    const body = asString(existing.body).trim();
    const notesSource = asString(meta.notesSource);
    const tags = Array.from(new Set([...((Array.isArray(existing.tags) ? existing.tags : [])), ...(Array.isArray(payload.tags) ? payload.tags : [])])).slice(0, 12);
    let nextBody = body;
    let mode = 'autoNotes';
    if (body === '') {
      nextBody = note;
      meta.notesSource = 'auto';
      meta.autoNotes = [];
      mode = 'body';
    } else if (notesSource === 'auto') {
      if (body !== note) {
        nextBody = note;
        meta.notesSource = 'auto';
        mode = 'body';
      } else {
        return { ok: true, mode: 'skipped', reason: '内容未变化', entry: existing };
      }
    } else {
      // 人工备注：正文不动，只维护自动补充列表
      const list = Array.isArray(meta.autoNotes) ? meta.autoNotes.filter((item) => item && typeof item.text === 'string') : [];
      const normalized = String(note).normalize('NFKC').toLowerCase();
      if (body.normalize('NFKC').toLowerCase().includes(normalized)) {
        return { ok: true, mode: 'skipped', reason: '人工备注已包含该信息', entry: existing };
      }
      const deduped = list.filter((item) => String(item.text).normalize('NFKC').toLowerCase() !== normalized);
      deduped.push({ text: note, at: at, confidence: confidence });
      meta.autoNotes = deduped.slice(-MAX_AUTO_NOTES);
    }
    const entry = entries.save({
      id: id,
      kind: KIND,
      title: asString(meta.name) || asString(existing.title),
      body: nextBody,
      tags: tags,
      scope: 'global',
      groupId: '',
      groupName: '',
      importance: existing.importance ?? 0,
      source: existing.source || 'auto',
      meta: meta,
      createdAt: existing.createdAt,
      hits: existing.hits ?? 0,
      lastHitAt: existing.lastHitAt ?? '',
    });
    loadCache().set(id, entry);
    return { ok: true, mode: mode, entry: entry };
  }

  /**
   * 把一条自动补充采纳到人工备注（正文），随后从 autoNotes 移除；带 location 时可指定群。
   * @returns {{ok:boolean, entry?:object, reason?:string}}
   */
  function adoptAutoNote(input = {}) {
    const payload = input && typeof input === 'object' ? input : {};
    const id = asString(payload.id).trim();
    if (id === '') return { ok: false, reason: '缺少 id' };
    const existing = get(id);
    if (!existing) return { ok: false, reason: '成员不存在: ' + id };
    const meta = existing.meta && typeof existing.meta === 'object' ? { ...existing.meta } : {};
    const list = Array.isArray(meta.autoNotes) ? meta.autoNotes.filter((item) => item && typeof item.text === 'string') : [];
    const index = Number.isInteger(payload.index) ? payload.index : -1;
    const picked = index >= 0 && index < list.length ? list[index] : list[0];
    if (!picked) return { ok: false, reason: '没有可采纳的自动补充' };
    const body = asString(existing.body).trim();
    const nextBody = body === '' ? String(picked.text) : body + '\n' + String(picked.text);
    meta.autoNotes = list.filter((item) => item !== picked);
    meta.notesSource = 'manual';
    const entry = entries.save({
      id: id,
      kind: KIND,
      title: asString(meta.name) || asString(existing.title),
      body: nextBody,
      tags: Array.isArray(existing.tags) ? existing.tags : [],
      scope: 'global',
      groupId: '',
      groupName: '',
      importance: existing.importance ?? 0,
      source: existing.source || 'auto',
      meta: meta,
      createdAt: existing.createdAt,
      hits: existing.hits ?? 0,
      lastHitAt: existing.lastHitAt ?? '',
    });
    loadCache().set(id, entry);
    return { ok: true, entry: entry };
  }

  /**
   * 自动提炼写入画像（合并语义，不覆盖人工画像）：
   * - nicknames/personality/deeds 并集并去重限长；affinity 仅在显式传入时覆盖；
   * - profileSource=auto；manual 画像不允许自动覆盖，但允许补充（并集）。
   * @returns {{ok:boolean, reason?:string, entry?:object}}
   */
  function updateProfile(id, patch = {}) {
    const safeId = asString(id).trim();
    if (safeId === '') return { ok: false, reason: '缺少 id' };
    const existing = get(safeId);
    if (!existing) return { ok: false, reason: '成员不存在: ' + safeId };
    const payload = patch && typeof patch === 'object' ? patch : {};
    const meta = existing.meta && typeof existing.meta === 'object' ? { ...existing.meta } : {};
    const current = normalizeProfile(meta.profile);
    const incomingSrc = payload.profile !== undefined ? payload.profile : payload;
    const incoming = normalizeProfile(incomingSrc);
    const hasAffinity = payload.affinity !== undefined
      || (payload.profile !== undefined && payload.profile && typeof payload.profile === 'object' && payload.profile.affinity !== undefined);
    const merged = {
      nicknames: uniqueAppend(current.nicknames, incoming.nicknames, PROFILE_MAX_NICKNAMES, 40),
      personality: uniqueAppend(current.personality, incoming.personality, PROFILE_MAX_PERSONALITY, PROFILE_ITEM_MAX_CHARS),
      deeds: uniqueAppend(current.deeds, incoming.deeds, PROFILE_MAX_DEEDS, PROFILE_ITEM_MAX_CHARS),
      affinity: hasAffinity ? incoming.affinity : current.affinity,
    };
    meta.profile = merged;
    if (asString(meta.profileSource) !== 'manual') meta.profileSource = payload.source === 'manual' ? 'manual' : 'auto';
    meta.profileUpdatedAt = nowIso();
    const tags = Array.isArray(payload.tags)
      ? uniqueAppend(existing.tags, payload.tags, 12, 24)
      : Array.isArray(existing.tags) ? existing.tags : [];
    const entry = entries.save({
      id: safeId,
      kind: KIND,
      title: asString(meta.name) || asString(existing.title),
      body: asString(existing.body),
      tags: tags,
      scope: 'global',
      groupId: '',
      groupName: '',
      importance: existing.importance ?? 0,
      source: existing.source || 'auto',
      meta: meta,
      createdAt: existing.createdAt,
      hits: existing.hits ?? 0,
      lastHitAt: existing.lastHitAt ?? '',
    });
    loadCache().set(safeId, entry);
    return { ok: true, entry: entry };
  }

  /** 删除成员 */
  function remove(id) {
    const safe = asString(id).trim();
    if (safe === '') throw new Error('member-store: id 不能为空');
    const result = entries.remove(safe);
    loadCache().delete(safe);
    return result;
  }

  /** 群聚合：{groupId, count, name}（来自成员 meta.groups） */
  function groups() {
    const map = new Map();
    for (const entry of loadCache().values()) {
      const item = entry.meta && typeof entry.meta === 'object' ? entry.meta : {};
      const rawGroups = item.groups && typeof item.groups === 'object' && !Array.isArray(item.groups) ? item.groups : {};
      for (const [groupId, value] of Object.entries(rawGroups)) {
        const group = value && typeof value === 'object' ? value : {};
        const row = map.get(groupId) || { groupId, count: 0, name: '' };
        row.count += 1;
        if (asString(group.name) !== '') row.name = asString(group.name);
        map.set(groupId, row);
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.groupId.localeCompare(b.groupId));
  }

  /** 统计：{total, groups, messages, byImportance, tags, lastSeenAt, updatedAt} */
  function stats() {
    let lastSeenAt = '';
    let messages = 0;
    let high = 0;
    let updatedAt = '';
    const groupSet = new Set();
    const tagCount = new Map();
    for (const entry of loadCache().values()) {
      const item = toItem(entry);
      if (clampInt(item.importance, 0, 3, 0) >= 2) high += 1;
      if (item.lastSeenAt > lastSeenAt) lastSeenAt = item.lastSeenAt;
      if (entry.updatedAt > updatedAt) updatedAt = entry.updatedAt;
      messages += item.messageCount;
      for (const group of item.groups) groupSet.add(group.groupId);
      for (const tag of item.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
    }
    const total = loadCache().size;
    return {
      total,
      groups: groupSet.size,
      messages,
      byImportance: { high, normal: Math.max(0, total - high) },
      tags: [...tagCount.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
      lastSeenAt,
      updatedAt,
    };
  }

  return {
    available: true,
    dir: () => entries.dir(),
    ensure: () => entries.ensure(),
    get,
    getByOpenid,
    /** 单条成员 → 列表项形状（工具 / UI 详情用）；不存在返回 null */
    item: (id) => {
      const entry = get(id);
      return entry ? toItem(entry) : null;
    },
    idFor: (openid) => memberId(openid),
    visit,
    save,
    updateProfile,
    applyAutoNote,
    adoptAutoNote,
    remove,
    list,
    recallAlly,
    groups,
    stats,
    all: () => [...loadCache().values()],
    flush: () => entries.flush(),
    reload: () => {
      cache = null;
      return entries.reload();
    },
    rebuild: () => {
      cache = null;
      return entries.rebuild();
    },
    config,
    kind: () => KIND,
  };
}

export default createMemberStore;
