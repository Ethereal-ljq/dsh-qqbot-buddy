/**
 * console/api/kb —— 知识库文档列表 / 入库 / 检索 / 删除（DESIGN-v2 §2/§3）。
 *
 * 读写分离：
 * - 列表可直读 SQLite（kb_docs/kb_chunks 由 migrations 固定），内核未装配也能看；
 * - ingest/search/remove 必须走 deps.kb（core/kb/store.js）：删文档若直接 DELETE kb_docs，
 *   FK 级联不会触发 FTS 删除触发器，会留下影子行——这是 kb-dev 明确提示的坑。
 */
import { all } from '../../core/db.js';
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
  const service = kbService(ctx.deps);
  if (service && typeof service.listDocs === 'function' && botId) {
    const docs = await guardAsync(() => service.listDocs({ botId, limit, offset }));
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
  { method: 'DELETE', path: '/api/kb/docs', handler: removeDoc },
  { method: 'DELETE', path: '/api/kb/docs/:id', handler: removeDoc },
  { method: 'POST', path: '/api/kb/ingest', handler: ingest },
  { method: 'POST', path: '/api/kb/search', handler: search },
];
