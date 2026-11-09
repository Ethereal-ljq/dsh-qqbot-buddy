/**
 * core/memory/store —— 长期记忆（按 bot 共享）的写入 / 近似去重 / 检索 / prompt 召回拼装。
 *
 * 职责：
 * - createMemoryStore({db}) 工厂：复用 lib/core/db.js 的 openDb/withTx，不另建连接；
 *   FTS 索引由 migrations.js 的触发器维护，store 不直接写 memories_fts；
 * - save：同 bot 下“近似去重”——归一化后完全相同直接命中；否则用字符 bigram Dice 相似度，
 *   ≥ MEMORY_DEDUPE_THRESHOLD 视为同一条，只刷新 updated_at / 合并 tags，不新增行；
 * - search：与知识库同一检索规则（<3 字符 trigram 无法命中 → LIKE 并标 mode:'like'；
 *   ≥3 字符走 bm25 并标 mode:'fts'），结果按 bot 隔离；
 * - list/get/update/remove：控制台管理面；
 * - recallForPrompt({botId, query, budgetChars})：按字符预算把最相关记忆拼成可注入 prompt 的文本。
 */
import { all, get, run, withTx } from '../db.js';
import {
  FTS_MIN_CHARS,
  MODE_FTS,
  MODE_LIKE,
  buildSnippet,
  charLength,
  ftsPhrase,
  likePattern,
  likeScore,
  normalizeQuery,
  shouldFallbackLike,
  truncateText,
} from '../kb/text-search.js';

export { FTS_MIN_CHARS, MODE_FTS, MODE_LIKE };

/** 近似去重阈值：字符 bigram Dice 系数 ≥ 0.85 视为同一条记忆。 */
export const DEDUPE_THRESHOLD = 0.85;
/** 近似去重扫描的最近记忆条数（控制 O(n) 比较成本）。 */
export const DEDUPE_SCAN_LIMIT = 300;
/** 记忆默认种类。 */
export const DEFAULT_MEMORY_KIND = 'fact';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const LIKE_SCAN_LIMIT = 200;
const DEFAULT_RECALL_LIMIT = 8;
const DEFAULT_RECALL_BUDGET = 1200;
const RECALL_PREFIX = '- ';

const MEMORY_COLUMNS = `
  m.id,
  m.bot_id AS botId,
  m.peer,
  m.kind,
  m.text,
  m.tags,
  m.source,
  m.created_at AS createdAt,
  m.updated_at AS updatedAt
`;

/**
 * 创建记忆 store。
 * @param {{ db: import('node:sqlite').DatabaseSync }} options
 */
export function createMemoryStore({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createMemoryStore: 需要由 lib/core/db.js 的 openDb() 打开的 db');
  }
  return {
    save: (input = {}) => save(db, input),
    search: (input = {}) => search(db, input),
    list: (input = {}) => list(db, input),
    get: (input) => getOne(db, input),
    update: (input, patch) => update(db, input, patch),
    remove: (input) => remove(db, input),
    delete: (input) => remove(db, input),
    recallForPrompt: (input = {}) => recallForPrompt(db, input),
  };
}

/* ------------------------------ 写入 ------------------------------ */

/**
 * 保存一条记忆（近似去重）。
 * @returns 记忆实体 + { created: boolean, deduped: boolean }
 */
function save(db, input = {}) {
  const botId = requireBotId(input.botId);
  const text = normalizeMemoryText(input.text);
  if (!text) throw new TypeError('memory.save: text 不能为空');
  const now = Date.now();
  const kind = normalizeKind(input.kind);
  const peer = input.peer === undefined || input.peer === null ? null : String(input.peer);
  const source = input.source === undefined || input.source === null ? null : String(input.source);
  const tags = normalizeTags(input.tags);

  const result = withTx(db, () => {
    const duplicate = findNearDuplicate(db, botId, text);
    if (duplicate) {
      const mergedTags = mergeTagsJson(duplicate.tags, tags);
      if (mergedTags !== duplicate.tags) {
        run(db, 'UPDATE memories SET tags = ?, updated_at = ? WHERE id = ?', mergedTags, now, duplicate.id);
      } else {
        run(db, 'UPDATE memories SET updated_at = ? WHERE id = ?', now, duplicate.id);
      }
      return { id: Number(duplicate.id), created: false, deduped: true };
    }
    const info = run(db,
      'INSERT INTO memories(bot_id, peer, kind, text, tags, source, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
      botId, peer, kind, text, tags, source, now, now);
    return { id: Number(info.lastInsertRowid), created: true, deduped: false };
  });
  // 对外返回“完整实体 + created/deduped 标记”，控制台可直接回显
  const entity = getOne(db, result.id);
  return { ...(entity || { id: result.id }), created: result.created, deduped: result.deduped };
}

/** 更新一条记忆（可改 text/kind/peer/source/tags）；找不到返回 null。 */
function update(db, input, patch) {
  const changes = typeof input === 'object' && input !== null ? input : { id: input, ...(patch || {}) };
  const memoryId = toMemoryId(changes.id);
  const existing = getOne(db, memoryId);
  if (!existing) return null;

  const sets = [];
  const params = [];
  if (changes.text !== undefined) {
    const text = normalizeMemoryText(changes.text);
    if (!text) throw new TypeError('memory.update: text 不能为空');
    sets.push('text = ?');
    params.push(text);
  }
  if (changes.kind !== undefined) {
    sets.push('kind = ?');
    params.push(normalizeKind(changes.kind));
  }
  if (changes.peer !== undefined) {
    sets.push('peer = ?');
    params.push(changes.peer === null ? null : String(changes.peer));
  }
  if (changes.source !== undefined) {
    sets.push('source = ?');
    params.push(changes.source === null ? null : String(changes.source));
  }
  if (changes.tags !== undefined) {
    sets.push('tags = ?');
    params.push(normalizeTags(changes.tags));
  }
  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(memoryId);
  return withTx(db, () => {
    run(db, `UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return getOne(db, memoryId);
  });
}

/** 删除一条记忆。 */
function remove(db, input) {
  const memoryId = toMemoryId(typeof input === 'object' && input !== null ? input.id : input);
  return withTx(db, () => {
    const existing = get(db, 'SELECT id FROM memories WHERE id = ?', memoryId);
    if (!existing) return { removed: false, id: memoryId };
    run(db, 'DELETE FROM memories WHERE id = ?', memoryId);
    return { removed: true, id: memoryId };
  });
}

/* ------------------------------ 检索 ------------------------------ */

/**
 * 检索记忆。
 * @returns {{ id:number, botId:string, peer:string|null, kind:string, text:string,
 *             tags:string[]|null, source:string|null, createdAt:number, updatedAt:number,
 *             score:number, mode:'fts'|'like', snippet:string }[]}
 */
function search(db, { botId, query, limit = DEFAULT_SEARCH_LIMIT } = {}) {
  const owner = requireBotId(botId);
  const keyword = normalizeQuery(query);
  if (!keyword) return [];
  const size = clampInt(limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  // 硬契约：trigram 最小 3 字符，<3 回退 LIKE
  if (shouldFallbackLike(keyword)) return likeSearch(db, owner, keyword, size);
  try {
    return ftsSearch(db, owner, keyword, size);
  } catch (err) {
    if (isFtsSyntaxError(err)) return likeSearch(db, owner, keyword, size);
    throw err;
  }
}

/** 记忆列表（控制台）：按 updated_at 倒序，可按 kind/peer 过滤。 */
function list(db, { botId, kind, peer, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
  const owner = requireBotId(botId);
  const size = clampInt(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const where = ['m.bot_id = ?'];
  const params = [owner];
  if (kind !== undefined && kind !== null && String(kind).trim()) {
    where.push('m.kind = ?');
    params.push(String(kind).trim());
  }
  if (peer !== undefined && peer !== null && String(peer).trim()) {
    where.push('m.peer = ?');
    params.push(String(peer).trim());
  }
  const rows = all(db, `SELECT ${MEMORY_COLUMNS} FROM memories m
    WHERE ${where.join(' AND ')} ORDER BY m.updated_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    ...params, size, skip);
  return rows.map(mapMemoryRow);
}

/** 单条记忆（按 id 或 { id }）。 */
function getOne(db, selector) {
  const id = Number(typeof selector === 'object' && selector !== null ? selector.id : selector);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = get(db, `SELECT ${MEMORY_COLUMNS} FROM memories m WHERE m.id = ?`, id);
  return row ? mapMemoryRow(row) : null;
}

/**
 * 召回拼装：按检索相关度取记忆，用 "- 文本" 逐行拼到 budgetChars 字符预算内。
 * 没有 query 时退化为最近记忆；第一条超预算会截断，之后不再追加（保证相关性优先）。
 */
function recallForPrompt(db, { botId, query = '', budgetChars = DEFAULT_RECALL_BUDGET, limit = DEFAULT_RECALL_LIMIT } = {}) {
  const owner = requireBotId(botId);
  const budget = Math.max(0, Math.floor(Number(budgetChars) || 0));
  if (budget <= 0) return '';
  const size = clampInt(limit, DEFAULT_RECALL_LIMIT, MAX_LIST_LIMIT);
  const keyword = normalizeQuery(query);
  const rows = keyword
    ? search(db, { botId: owner, query: keyword, limit: size })
    : list(db, { botId: owner, limit: size });

  const lines = [];
  let used = 0;
  for (const row of rows) {
    const line = RECALL_PREFIX + normalizeMemoryText(row.text);
    if (!line || line.trim() === RECALL_PREFIX.trim()) continue;
    const separator = lines.length ? 1 : 0;
    const cost = charLength(line) + separator;
    if (used + cost <= budget) {
      lines.push(line);
      used += cost;
      continue;
    }
    if (lines.length === 0) lines.push(truncateText(line, budget));
    break;
  }
  return lines.join('\n');
}

/* ------------------------------ 内部：检索实现 ------------------------------ */

function ftsSearch(db, botId, keyword, limit) {
  // CROSS JOIN 强制 FTS 索引先行，避免 SQLite 用 bot/时间索引驱动后逐行 MATCH（见 kb/store.js 同处注释）
  const rows = all(db, `SELECT ${MEMORY_COLUMNS}, bm25(memories_fts) AS rank
    FROM memories_fts
    CROSS JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ? AND m.bot_id = ?
    ORDER BY rank
    LIMIT ?`, ftsPhrase(keyword), botId, limit);
  return rows.map((row) => ({
    ...mapMemoryRow(row),
    score: Number((-Number(row.rank || 0)).toFixed(6)),
    mode: MODE_FTS,
    snippet: buildSnippet(row.text, keyword),
  }));
}

function likeSearch(db, botId, keyword, limit) {
  // ESCAPE '\\' 在 SQL 里是一个反斜杠，与 text-search.js 的 escapeLike 配套
  const rows = all(db, `SELECT ${MEMORY_COLUMNS} FROM memories m
    WHERE m.bot_id = ? AND m.text LIKE ? ESCAPE '\\'
    ORDER BY m.updated_at DESC, m.id DESC
    LIMIT ?`, botId, likePattern(keyword), LIKE_SCAN_LIMIT);
  return rows
    .map((row) => ({
      ...mapMemoryRow(row),
      score: likeScore(row.text, keyword),
      mode: MODE_LIKE,
      snippet: buildSnippet(row.text, keyword),
    }))
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

/* ------------------------------ 去重：相似度 ------------------------------ */

/**
 * 字符 bigram Dice 相似度（0~1）。用于近似去重，纯函数可单测。
 * 归一化会去掉空白/标点/符号并转小写，因此“用户喜欢猫。”与“用户喜欢猫咪”约 0.89。
 */
export function textSimilarity(left, right) {
  const a = normalizeForCompare(left);
  const b = normalizeForCompare(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  if (gramsA.length === 0 || gramsB.length === 0) return 0;
  const counts = new Map();
  for (const gram of gramsA) counts.set(gram, (counts.get(gram) || 0) + 1);
  let intersection = 0;
  for (const gram of gramsB) {
    const remaining = counts.get(gram) || 0;
    if (remaining > 0) {
      intersection += 1;
      counts.set(gram, remaining - 1);
    }
  }
  return Number(((2 * intersection) / (gramsA.length + gramsB.length)).toFixed(4));
}

function findNearDuplicate(db, botId, text) {
  const normalized = normalizeForCompare(text);
  const candidates = all(db,
    'SELECT id, text, tags FROM memories WHERE bot_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?',
    botId, DEDUPE_SCAN_LIMIT);
  let best = null;
  let bestScore = 0;
  for (const row of candidates) {
    if (normalizeForCompare(row.text) === normalized) return row;
    const similarity = textSimilarity(row.text, text);
    if (similarity >= DEDUPE_THRESHOLD && similarity > bestScore) {
      best = row;
      bestScore = similarity;
    }
  }
  return best;
}

function normalizeForCompare(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(text) {
  const chars = Array.from(text);
  const grams = [];
  for (let i = 0; i + 1 < chars.length; i += 1) grams.push(chars[i] + chars[i + 1]);
  return grams;
}

/* ------------------------------ 内部工具 ------------------------------ */

/** 记忆文本归一化：去首尾空白 + 折叠内部空白（保留可读性）。 */
export function normalizeMemoryText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function requireBotId(value) {
  const botId = String(value ?? '').trim();
  if (!botId) throw new TypeError('memory store: botId 不能为空');
  return botId;
}

function normalizeKind(value) {
  const kind = value === undefined || value === null ? '' : String(value).trim();
  return kind || DEFAULT_MEMORY_KIND;
}

function toMemoryId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError('memory store: 无效的 id: ' + value);
  return id;
}

/** tags 统一存成 JSON 字符串数组（或 null）。 */
function normalizeTags(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return tagsToJson(value);
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    try { return tagsToJson(JSON.parse(raw)); } catch { /* 当普通字符串处理 */ }
  }
  return tagsToJson(raw.split(/[,，\s]+/));
}

function tagsToJson(list) {
  const seen = new Set();
  for (const item of list) {
    const tag = String(item ?? '').trim();
    if (tag) seen.add(tag);
  }
  return seen.size ? JSON.stringify([...seen]) : null;
}

function mergeTagsJson(existingJson, newJson) {
  if (!newJson) return existingJson;
  const merged = new Set([...parseTagsArray(existingJson), ...parseTagsArray(newJson)]);
  return merged.size ? JSON.stringify([...merged]) : existingJson;
}

function parseTagsArray(tags) {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/** 行 -> 对外对象：tags 反序列化为数组，时间转 number。 */
function mapMemoryRow(row) {
  return {
    id: Number(row.id),
    botId: row.botId,
    peer: row.peer === undefined ? null : row.peer,
    kind: row.kind,
    text: row.text,
    tags: parseTagsArray(row.tags),
    source: row.source === undefined ? null : row.source,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function clampInt(value, fallback, max) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(num, max);
}

function isFtsSyntaxError(err) {
  const message = String((err && err.message) || err || '');
  return /fts5|syntax|matcher|unterminated/i.test(message);
}
