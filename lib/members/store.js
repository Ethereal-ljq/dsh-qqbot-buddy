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
      importance: clampInt(entry.importance, 0, 3, 0),
      note: asString(entry.body).slice(0, LIST_NOTE_CHARS),
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
          summary: [item.note, ...item.groups.map((group) => group.name)].filter(Boolean).join(' '),
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
          summary: [item.note, ...item.groups.map((value) => value.name)].filter(Boolean).join(' '),
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
    const tags = payload.tags !== undefined ? payload.tags : existing?.tags ?? [];
    const importance = payload.importance !== undefined ? payload.importance : existing?.importance ?? 0;
    const notesInput = payload.notes !== undefined ? payload.notes : payload.body;
    const body = notesInput !== undefined ? String(notesInput ?? '') : existing?.body ?? '';
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
