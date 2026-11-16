/**
 * console/api/kb —— 知识库文档列表 / 入库 / 检索 / 删除（DESIGN-v2 §2/§3）。
 *
 * 读写分离：
 * - 列表可直读 SQLite（kb_docs/kb_chunks 由 migrations 固定），内核未装配也能看；
 * - ingest/search/remove 必须走 deps.kb（core/kb/store.js）：删文档若直接 DELETE kb_docs，
 *   FK 级联不会触发 FTS 删除触发器，会留下影子行——这是 kb-dev 明确提示的坑。
 */
import { all } from '../../core/db.js';
import { runKbHygiene } from '../../core/kb/hygiene.js';
import {
  notImplemented, badRequest, notFound, guard, guardAsync, queryString, queryInt, asInt, audit,
} from './helpers.js';

function parseMeta(meta) {
  if (meta === null || meta === undefined || meta === '') return null;
  if (typeof meta === 'object') return meta;
  try { return JSON.parse(meta); } catch { return null; }
}

function rowToDoc(row) {
  return {
    id: row.id,
    botId: row.bot_id,
    source: row.source,
    title: row.title ?? null,
    hash: row.hash,
    meta: parseMeta(row.meta),
    kind: row.kind ?? null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    authority: row.authority ?? null,
    pinned: Number(row.pinned) === 1,
    recallCount: Number(row.recall_count ?? row.recallCount ?? 0) || 0,
    lastRecalledAt: row.last_recalled_at ?? row.lastRecalledAt ?? null,
    staleAt: row.stale_at ?? row.staleAt ?? null,
    staleReason: row.stale_reason ?? row.staleReason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    chunkCount: Number(row.chunk_count ?? row.chunkCount ?? 0) || 0,
  };
}

function kbService(deps) {
  const service = deps?.kb;
  return service && typeof service === 'object' ? service : null;
}

async function listDocs(ctx) {
  const botId = queryString(ctx.query, 'bot');
  const limit = queryInt(ctx.query, 'limit', 100, { min: 1, max: 500 });
  const offset = queryInt(ctx.query, 'offset', 0, { min: 0, max: 100000 });
  const includeArchived = queryString(ctx.query, 'archived') === '1';
  const kind = queryString(ctx.query, 'kind');
  const service = kbService(ctx.deps);
  if (service && typeof service.listDocs === 'function' && botId) {
    const docs = await guardAsync(() => service.listDocs({ botId, limit, offset, includeArchived, kind }));
    return Array.isArray(docs) ? docs : [];
  }
  // 降级：只读 SQLite（表结构与 FTS 由 migrations 管理）
  const db = ctx.deps.db;
  if (!db) return [];
  const select = 'SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.doc_id = d.id) AS chunk_count FROM kb_docs d';
  const rows = botId
    ? all(db, select + ' WHERE d.bot_id = ? ORDER BY d.updated_at DESC LIMIT ? OFFSET ?', botId, limit, offset)
    : all(db, select + ' ORDER BY d.updated_at DESC LIMIT ? OFFSET ?', limit, offset);
  return rows.map(rowToDoc);
}

async function ingest(ctx) {
  const service = kbService(ctx.deps);
  if (!service || typeof service.ingest !== 'function') {
    throw notImplemented('知识库内核未装配（M4），暂不能入库');
  }
  const body = ctx.body || {};
  const botId = typeof body.botId === 'string' ? body.botId : '';
  if (botId === '') throw badRequest('缺少 botId');
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.trim() === '') throw badRequest('缺少 text');
  const input = {
    botId,
    text,
    source: typeof body.source === 'string' ? body.source : '',
    title: typeof body.title === 'string' ? body.title : '',
    meta: body.meta ?? null,
    kind: typeof body.kind === 'string' ? body.kind : undefined,
    confidence: body.confidence === undefined ? undefined : body.confidence,
    authority: typeof body.authority === 'string' ? body.authority : undefined,
    pinned: body.pinned === undefined ? undefined : Boolean(body.pinned),
    sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : undefined,
    fetchedAt: typeof body.fetchedAt === 'string' ? body.fetchedAt : undefined,
  };
  const result = await guardAsync(() => service.ingest(input));
  audit(ctx.deps, { kind: 'kb.ingest', botId, detail: input.source || input.title || '' });
  if (result && typeof result === 'object') {
    const doc = result.doc ?? null;
    return {
      doc,
      chunks: typeof result.chunks === 'number' ? result.chunks : (Array.isArray(result.chunks) ? result.chunks.length : 0),
      docId: result.docId ?? doc?.id ?? null,
      changed: result.changed !== false,
    };
  }
  return { doc: result ?? null, chunks: 0, docId: result?.id ?? null, changed: true };
}

async function search(ctx) {
  const service = kbService(ctx.deps);
  if (!service || typeof service.search !== 'function') {
    throw notImplemented('知识库内核未装配（M4），暂不能检索');
  }
  const body = ctx.body || {};
  const botId = typeof body.botId === 'string' ? body.botId : '';
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (botId === '') throw badRequest('缺少 botId');
  if (query === '') throw badRequest('缺少 query');
  const limit = asInt(body.limit, 10, { min: 1, max: 50 });
  const results = await guardAsync(() => service.search({ botId, query, limit }));
  return Array.isArray(results) ? results : [];
}

/**
 * GET /api/kb/docs/:id —— 文档详情 + 分块（控制台编辑回填用）。
 *
 * 为什么要分块：kb_docs 只存 hash/title/meta，原文不落库；编辑时只能按 chunks 拼回近似全文，
 * 并在保存时整篇重建分块（同一 source 原地更新，docId 不变）。
 */
async function getDocDetail(ctx) {
  const service = kbService(ctx.deps);
  const botId = queryString(ctx.query, 'bot');
  if (botId === '') throw badRequest('缺少 bot');
  const id = asInt(ctx.params.id ?? queryString(ctx.query, 'id'), NaN, { min: 1 });
  if (!Number.isFinite(id)) throw badRequest('文档 id 非法');
  const db = ctx.deps?.db;
  let doc = null;
  if (service && typeof service.getDoc === 'function') {
    doc = await guardAsync(() => service.getDoc({ botId, docId: id }));
  }
  if (!doc && db) {
    const rows = all(db,
      'SELECT d.*, (SELECT COUNT(*) FROM kb_chunks c WHERE c.doc_id = d.id) AS chunk_count'
      + ' FROM kb_docs d WHERE d.id = ? AND d.bot_id = ?', id, botId);
    if (rows.length > 0) doc = rowToDoc(rows[0]);
  }
  if (!doc) throw notFound('知识库文档不存在: ' + id);
  const chunks = db
    ? all(db, 'SELECT id, ord, text FROM kb_chunks WHERE doc_id = ? ORDER BY ord', id)
      .map((row) => ({ id: Number(row.id), ord: Number(row.ord), text: String(row.text || '') }))
    : [];
  return { ...doc, chunkCount: doc.chunkCount || chunks.length, chunks };
}

/**
 * PUT /api/kb/docs/:id —— 编辑文档（标题 / 全文）。
 *
 * 实现方式：沿用原 source 重新 ingest。store.ingest 对同 source 是原地更新（保留 docId/created_at，
 * 重建 chunks + FTS 索引），所以这里不需要"先删后建"，也不会有影子行。
 * 注意：kb_docs 不存原文，文本按 chunks 拼回（块间有少量重叠），保存后以新文本为准。
 */
async function updateDoc(ctx) {
  const service = kbService(ctx.deps);
  if (!service || typeof service.ingest !== 'function' || typeof service.getDoc !== 'function') {
    throw notImplemented('知识库内核未装配（M4），暂不能编辑');
  }
  const body = ctx.body || {};
  const botId = typeof body.botId === 'string' ? body.botId : '';
  if (botId === '') throw badRequest('缺少 botId');
  const id = asInt(ctx.params.id ?? body.id, NaN, { min: 1 });
  if (!Number.isFinite(id)) throw badRequest('文档 id 非法');
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.trim() === '') throw badRequest('缺少 text（编辑需要提交完整正文）');
  const existing = await guardAsync(() => service.getDoc({ botId, docId: id }));
  if (!existing) throw notFound('知识库文档不存在: ' + id);
  const title = typeof body.title === 'string' && body.title.trim() !== ''
    ? body.title.trim()
    : (existing.title || '');
  const input = {
    botId,
    text,
    title,
    source: existing.source, // 保持同一 source：ingest 原地更新，docId 不变
    meta: existing.meta ?? null,
    kind: typeof body.kind === 'string' ? body.kind : undefined,
    confidence: body.confidence === undefined ? undefined : body.confidence,
    authority: typeof body.authority === 'string' ? body.authority : undefined,
    pinned: body.pinned === undefined ? undefined : Boolean(body.pinned),
    sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : undefined,
    fetchedAt: typeof body.fetchedAt === 'string' ? body.fetchedAt : undefined,
  };
  const result = await guardAsync(() => service.ingest(input));
  audit(ctx.deps, { kind: 'kb.update', botId, detail: 'doc=' + id });
  const doc = result && result.doc ? result.doc : null;
  const docId = result && result.docId !== undefined ? result.docId : (doc?.id ?? id);
  const chunks = result && typeof result.chunks === 'number'
    ? result.chunks
    : (Array.isArray(result?.chunks) ? result.chunks.length : 0);
  return { doc, docId, chunks, changed: result?.changed !== false };
}

/**
 * POST /api/kb/docs/:id/meta —— 只改治理元数据（分类/置信度/权威/保护位/归档/恢复）。
 * 与 PUT /api/kb/docs/:id 分工：改正文走 PUT（会重建分块），改标签走这里（不动 chunks）。
 */
async function updateDocMeta(ctx) {
  const service = kbService(ctx.deps);
  if (!service || typeof service.updateDocMeta !== 'function') {
    throw notImplemented('知识库内核未装配（M4），暂不能修改文档元数据');
  }
  const body = ctx.body || {};
  const botId = typeof body.botId === 'string' ? body.botId : '';
  if (botId === '') throw badRequest('缺少 botId');
  const id = asInt(ctx.params.id ?? body.id, NaN, { min: 1 });
  if (!Number.isFinite(id)) throw badRequest('文档 id 非法');
  const patch = {};
  if (typeof body.kind === 'string') patch.kind = body.kind;
  if (body.confidence !== undefined) patch.confidence = body.confidence;
  if (typeof body.authority === 'string') patch.authority = body.authority;
  if (body.pinned !== undefined) patch.pinned = Boolean(body.pinned);
  if (body.stale !== undefined) patch.stale = Boolean(body.stale);
  if (typeof body.staleReason === 'string') patch.staleReason = body.staleReason;
  if (typeof body.sourceUrl === 'string') patch.sourceUrl = body.sourceUrl;
  if (typeof body.fetchedAt === 'string') patch.fetchedAt = body.fetchedAt;
  if (Object.keys(patch).length === 0) throw badRequest('没有可更新的字段');
  const result = await guardAsync(() => service.updateDocMeta({ botId, id, patch }));
  if (!result || result.updated === false && !result.doc) throw notFound('知识库文档不存在: ' + id);
  audit(ctx.deps, { kind: 'kb.meta', botId, detail: 'doc=' + id + ' ' + Object.keys(patch).join(',') });
  return { ok: true, doc: result.doc ?? null };
}

/**
 * POST /api/kb/hygiene —— 知识治理：干跑预览 / 执行软归档 + 清理超 TTL 归档。
 * body: { botId, dryRun?, purge? }；阈值读该 bot 的生效设置（配置档 → 知识库）。
 */
async function runHygiene(ctx) {
  const service = kbService(ctx.deps);
  if (!service || typeof service.listDocs !== 'function') {
    throw notImplemented('知识库内核未装配（M4），暂不能执行治理');
  }
  const body = ctx.body || {};
  const botId = typeof body.botId === 'string' ? body.botId : '';
  if (botId === '') throw badRequest('缺少 botId');
  const config = ctx.deps?.config;
  let settings = {};
  try { settings = config && typeof config.getSettings === 'function' ? config.getSettings(botId) || {} : {}; } catch { settings = {}; }
  const dryRun = body.dryRun !== false;
  const result = await guardAsync(() => runKbHygiene({
    kb: service,
    botId,
    settings,
    dryRun,
    purge: body.purge !== false,
  }));
  audit(ctx.deps, { kind: 'kb.hygiene', botId, detail: (dryRun ? 'dryRun' : 'apply') + ' archive=' + (result.archive?.length ?? 0) });
  return result;
}

/** DELETE /api/kb/docs/:id 与 DELETE /api/kb/docs?id=（DESIGN 表格写的是后者）。 */
async function removeDoc(ctx) {
  const service = kbService(ctx.deps);
  if (!service || typeof service.removeDoc !== 'function') {
    throw notImplemented('知识库内核未装配（M4）；删除需走内核以同步 FTS 索引');
  }
  const body = ctx.body || {};
  const botId = queryString(ctx.query, 'bot') || (typeof body.botId === 'string' ? body.botId : '');
  if (botId === '') throw badRequest('缺少 bot');
  const id = asInt(ctx.params.id ?? queryString(ctx.query, 'id') ?? body.id, NaN, { min: 1 });
  if (!Number.isFinite(id)) throw badRequest('文档 id 非法');
  const result = await guardAsync(() => service.removeDoc({ botId, id }));
  if (!result || result.removed !== true) throw notFound('知识库文档不存在: ' + id);
  audit(ctx.deps, { kind: 'kb.remove', botId, detail: 'doc=' + id });
  return { ok: true, id: result.docId ?? id, removed: true, chunks: result.chunks ?? 0 };
}

export const routes = [
  { method: 'GET', path: '/api/kb/docs', handler: listDocs },
  { method: 'GET', path: '/api/kb/docs/:id', handler: getDocDetail },
  { method: 'PUT', path: '/api/kb/docs/:id', handler: updateDoc },
  { method: 'DELETE', path: '/api/kb/docs', handler: removeDoc },
  { method: 'DELETE', path: '/api/kb/docs/:id', handler: removeDoc },
  { method: 'POST', path: '/api/kb/ingest', handler: ingest },
  { method: 'POST', path: '/api/kb/docs/:id/meta', handler: updateDocMeta },
  { method: 'POST', path: '/api/kb/hygiene', handler: runHygiene },
  { method: 'POST', path: '/api/kb/search', handler: search },
];
