/**
 * core/kb/store —— 知识库存储与检索（SQLite + FTS5 trigram）。
 *
 * 职责：
 * - createKbStore({db}) 工厂：复用 lib/core/db.js 的 openDb/withTx，不另建连接、不碰 FTS 索引表；
 * - ingest：按 (bot_id, source) 幂等（表上有 UNIQUE(bot_id, source)）；内容 hash 未变时直接返回
 *   changed:false，变化时在事务内替换该文档的全部 chunks（FTS 由 migrations.js 的触发器同步）；
 * - search({botId, query, limit})：按 bot 隔离。query < 3 字符时 trigram 无法命中，必须回退
 *   LIKE 并标注 mode:'like'；否则走 bm25 排序并标注 mode:'fts'（docs/DESIGN-v2.md §2 硬契约）。
 *   返回 { chunkId, docId, text, title, score, mode, snippet }；
 * - listDocs/getDoc/removeDoc：控制台管理面使用。
 */
import { createHash } from 'node:crypto';
import { all, get, run, withTx } from '../db.js';
import { chunkMarkdown } from './chunk.js';
import {
  FTS_MIN_CHARS,
  MODE_FTS,
  MODE_LIKE,
  buildSnippet,
  ftsPhrase,
  likePattern,
  likeScore,
  normalizeQuery,
  shouldFallbackLike,
} from './text-search.js';

export { FTS_MIN_CHARS, MODE_FTS, MODE_LIKE };

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
/** LIKE 回退时先取回的候选数（按命中位置再排序截断）。 */
const LIKE_SCAN_LIMIT = 200;

const DOC_COLUMNS = `
  d.id,
  d.bot_id AS botId,
  d.source,
  d.title,
  d.hash,
  d.meta,
  d.created_at AS createdAt,
  d.updated_at AS updatedAt,
  (SELECT COUNT(*) FROM kb_chunks c WHERE c.doc_id = d.id) AS chunkCount
`;

/**
 * 创建知识库 store。
 * @param {{ db: import('node:sqlite').DatabaseSync }} options
 */
export function createKbStore({ db } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createKbStore: 需要由 lib/core/db.js 的 openDb() 打开的 db');
  }
  return {
    ingest: (input = {}) => ingest(db, input),
    search: (input = {}) => search(db, input),
    listDocs: (input = {}) => listDocs(db, input),
    getDoc: (input = {}) => getDoc(db, input),
    removeDoc: (input = {}) => removeDoc(db, input),
  };
}

/* ------------------------------ 写入 ------------------------------ */

/**
 * 幂等入库：同一 bot 下同一 source 只保留一份文档；内容 hash 变化才替换 chunks。
 * @returns {{ doc: object|null, docId: number, chunks: number, changed: boolean }}
 */
function ingest(db, input = {}) {
  const botId = requireBotId(input.botId);
  const text = input.text === undefined || input.text === null ? '' : String(input.text);
  const providedTitle = input.title === undefined || input.title === null ? '' : String(input.title).trim();
  const providedSource = input.source === undefined || input.source === null ? '' : String(input.source).trim();
  const hash = hashDoc(providedTitle, text);
  // source 是幂等键：调用方没给时退化为 title，再退化为内容 hash 派生的 inline 标识。
  // 这样 POST /api/kb/ingest 不传 source 时，同样内容重复提交仍然幂等，不会每次新建文档。
  const source = providedSource || providedTitle || 'inline:' + hash.slice(0, 16);
  const title = providedTitle || source;
  const meta = normalizeMeta(input.meta);

  const existing = get(db, 'SELECT id, hash FROM kb_docs WHERE bot_id = ? AND source = ?', botId, source);
  if (existing && existing.hash === hash) {
    const counted = get(db, 'SELECT COUNT(*) AS count FROM kb_chunks WHERE doc_id = ?', existing.id);
    const docId = Number(existing.id);
    return { doc: getDoc(db, { botId, docId }), docId, chunks: Number(counted.count), changed: false };
  }

  // 只有真正要写库时才分块，幂等重入不做无谓计算
  const pieces = chunkMarkdown(text, {
    maxChars: input.maxChars === undefined ? undefined : input.maxChars,
    overlap: input.overlap === undefined ? undefined : input.overlap,
  }).map((chunk) => chunk.text);

  const now = Date.now();
  const docId = withTx(db, () => {
    let id;
    if (existing) {
      id = Number(existing.id);
      run(db, 'DELETE FROM kb_chunks WHERE doc_id = ?', id);
      run(db, 'UPDATE kb_docs SET title = ?, hash = ?, meta = ?, updated_at = ? WHERE id = ?',
        title, hash, meta, now, id);
    } else {
      const info = run(db,
        'INSERT INTO kb_docs(bot_id, source, title, hash, meta, created_at, updated_at) VALUES(?,?,?,?,?,?,?)',
        botId, source, title, hash, meta, now, now);
      id = Number(info.lastInsertRowid);
    }
    const insertChunk = db.prepare('INSERT INTO kb_chunks(doc_id, ord, text) VALUES(?, ?, ?)');
    for (let ord = 0; ord < pieces.length; ord += 1) insertChunk.run(id, ord, pieces[ord]);
    return id;
  });

  return { doc: getDoc(db, { botId, docId }), docId, chunks: pieces.length, changed: true };
}

/**
 * 删除文档及其 chunks。选择器：{ botId, source } 或 { botId, docId }。
 * @returns {{ removed: boolean, docId: number|null, chunks: number }}
 */
function removeDoc(db, selector = {}) {
  const botId = requireBotId(selector.botId);
  const targetId = selector.docId === undefined ? selector.id : selector.docId;
  let row;
  if (targetId !== undefined && targetId !== null) {
    row = get(db, 'SELECT id FROM kb_docs WHERE id = ? AND bot_id = ?', Number(targetId), botId);
  } else {
    const source = requireSource(selector.source);
    row = get(db, 'SELECT id FROM kb_docs WHERE bot_id = ? AND source = ?', botId, source);
  }
  if (!row) return { removed: false, docId: null, chunks: 0 };

  const docId = Number(row.id);
  const counted = get(db, 'SELECT COUNT(*) AS count FROM kb_chunks WHERE doc_id = ?', docId);
  withTx(db, () => {
    // 显式删 chunks：触发器的 FTS 删除只对直接 DELETE 生效，不能依赖 ON DELETE CASCADE
    run(db, 'DELETE FROM kb_chunks WHERE doc_id = ?', docId);
    run(db, 'DELETE FROM kb_docs WHERE id = ?', docId);
  });
  return { removed: true, docId, chunks: Number(counted.count) };
}

/* ------------------------------ 查询 ------------------------------ */

/**
 * 检索知识库。
 * @param {{ botId: string, query: string, limit?: number }} input
 * @returns {{ chunkId: number, docId: number, text: string, title: string,
 *             score: number, mode: 'fts'|'like', snippet: string }[]}
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
    // 极端输入（纯标点等）可能让 FTS5 解析失败，退化成 LIKE 而不是把错误抛给调用方
    if (isFtsSyntaxError(err)) return likeSearch(db, owner, keyword, size);
    throw err;
  }
}

/** 文档列表（控制台）。 */
function listDocs(db, { botId, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
  const owner = requireBotId(botId);
  const size = clampInt(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const skip = Math.max(0, Math.floor(Number(offset) || 0));
  const rows = all(db, `SELECT ${DOC_COLUMNS} FROM kb_docs d
    WHERE d.bot_id = ? ORDER BY d.updated_at DESC, d.id DESC LIMIT ? OFFSET ?`, owner, size, skip);
  return rows.map(mapDocRow);
}

/** 单文档详情：按 docId（或 id）或 source 查。 */
function getDoc(db, selector = {}) {
  const owner = requireBotId(selector.botId);
  const targetId = selector.docId === undefined ? selector.id : selector.docId;
  let row;
  if (targetId !== undefined && targetId !== null) {
    row = get(db, `SELECT ${DOC_COLUMNS} FROM kb_docs d WHERE d.id = ? AND d.bot_id = ?`, Number(targetId), owner);
  } else if (selector.source !== undefined && selector.source !== null && String(selector.source).trim()) {
    row = get(db, `SELECT ${DOC_COLUMNS} FROM kb_docs d WHERE d.source = ? AND d.bot_id = ?`, String(selector.source).trim(), owner);
  } else {
    return null;
  }
  return row ? mapDocRow(row) : null;
}

/* ------------------------------ 内部：两种检索模式 ------------------------------ */

function ftsSearch(db, botId, keyword, limit) {
  // CROSS JOIN 是性能关键：普通 JOIN 时 SQLite 可能先用 bot 索引驱动 kb_docs，
  // 再对每个 chunk 逐行执行 MATCH（10k chunks 实测 200ms+）；CROSS JOIN 强制 FTS 索引先行，
  // 先得到命中 rowid 再按主键回表，10k 条下选择性查询可到 <1ms。
  const rows = all(db, `SELECT c.id AS chunkId, c.doc_id AS docId, c.text AS text, d.title AS title,
      bm25(kb_chunks_fts) AS rank
    FROM kb_chunks_fts
    CROSS JOIN kb_chunks c ON c.id = kb_chunks_fts.rowid
    JOIN kb_docs d ON d.id = c.doc_id
    WHERE kb_chunks_fts MATCH ? AND d.bot_id = ?
    ORDER BY rank
    LIMIT ?`, ftsPhrase(keyword), botId, limit);
  return rows.map((row) => ({
    chunkId: Number(row.chunkId),
    docId: Number(row.docId),
    text: row.text,
    title: row.title,
    score: Number((-Number(row.rank || 0)).toFixed(6)),
    mode: MODE_FTS,
    snippet: buildSnippet(row.text, keyword),
  }));
}

function likeSearch(db, botId, keyword, limit) {
  // ESCAPE '\\' 在 SQL 里是一个反斜杠，与 text-search.js 的 escapeLike 配套
  const rows = all(db, `SELECT c.id AS chunkId, c.doc_id AS docId, c.text AS text, d.title AS title
    FROM kb_chunks c
    JOIN kb_docs d ON d.id = c.doc_id
    WHERE d.bot_id = ? AND c.text LIKE ? ESCAPE '\\'
    LIMIT ?`, botId, likePattern(keyword), LIKE_SCAN_LIMIT);
  return rows
    .map((row) => ({
      chunkId: Number(row.chunkId),
      docId: Number(row.docId),
      text: row.text,
      title: row.title,
      score: likeScore(row.text, keyword),
      mode: MODE_LIKE,
      snippet: buildSnippet(row.text, keyword),
    }))
    .sort((a, b) => b.score - a.score || a.chunkId - b.chunkId)
    .slice(0, limit);
}

/* ------------------------------ 内部工具 ------------------------------ */

function hashDoc(title, text) {
  return createHash('sha256').update(title).update('\u0000').update(text).digest('hex');
}

function requireBotId(value) {
  const botId = String(value ?? '').trim();
  if (!botId) throw new TypeError('kb store: botId 不能为空');
  return botId;
}

function requireSource(value) {
  const source = String(value ?? '').trim();
  if (!source) throw new TypeError('kb store: source 不能为空');
  return source;
}

function normalizeMeta(meta) {
  if (meta === undefined || meta === null) return null;
  return typeof meta === 'string' ? meta : JSON.stringify(meta);
}

function parseMeta(meta) {
  if (meta === undefined || meta === null || meta === '') return null;
  try { return JSON.parse(meta); } catch { return meta; }
}

function mapDocRow(row) {
  return {
    id: Number(row.id),
    botId: row.botId,
    source: row.source,
    title: row.title,
    hash: row.hash,
    meta: parseMeta(row.meta),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    chunkCount: Number(row.chunkCount),
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
