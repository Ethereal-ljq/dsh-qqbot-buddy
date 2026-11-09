/**
 * console/api/memories —— 长期记忆（DESIGN-v2 §2/§3）。
 *
 * list 可读 deps.memory.list 或直读 SQLite（只读安全）；
 * save/search/remove 必须走 deps.memory（core/memory/store.js），
 * 以保留近似去重、检索模式（fts/like）与 FTS 触发器语义，未装配时 501。
 */
import { all } from '../../core/db.js';
import {
  notImplemented, badRequest, notFound, guardAsync, queryString, queryInt, asInt, audit,
} from './helpers.js';

function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags !== 'string' || tags === '') return null;
  try {
    const value = JSON.parse(tags);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function rowToMemory(row) {
  return {
    id: row.id,
    botId: row.bot_id,
    peer: row.peer ?? null,
    kind: row.kind || 'fact',
    text: row.text,
    tags: parseTags(row.tags),
    source: row.source ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memoryService(deps) {
  const service = deps?.memory;
  return service && typeof service === 'object' ? service : null;
}

async function listMemories(ctx) {
  const botId = queryString(ctx.query, 'bot');
  const peer = queryString(ctx.query, 'peer');
  const kind = queryString(ctx.query, 'kind');
  const limit = queryInt(ctx.query, 'limit', 100, { min: 1, max: 500 });
  const offset = queryInt(ctx.query, 'offset', 0, { min: 0, max: 100000 });
  const service = memoryService(ctx.deps);
  if (service && typeof service.list === 'function' && botId) {
    const rows = await guardAsync(() => service.list({
      botId,
      peer: peer || undefined,
      kind: kind || undefined,
      limit,
      offset,
    }));
    return Array.isArray(rows) ? rows : [];
  }
  // 降级：只读 SQLite（memories 表由 migrations 固定）
  const db = ctx.deps.db;
  if (!db) return [];
  const where = [];
  const params = [];
  if (botId) { where.push('bot_id = ?'); params.push(botId); }
  if (peer) { where.push('peer = ?'); params.push(peer); }
  if (kind) { where.push('kind = ?'); params.push(kind); }
  const sql = 'SELECT * FROM memories'
    + (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  return all(db, sql, ...params, limit, offset).map(rowToMemory);
}

async function saveMemory(ctx) {
  const service = memoryService(ctx.deps);
  if (!service || typeof service.save !== 'function') {
    throw notImplemented('记忆内核未装配（M4），暂不能写入记忆');
  }
  const body = ctx.body || {};
  const botId = typeof body.botId === 'string' ? body.botId : '';
  if (botId === '') throw badRequest('缺少 botId');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text === '') throw badRequest('缺少 text');
  const input = {
    botId,
    text,
    peer: typeof body.peer === 'string' ? body.peer : undefined,
    kind: typeof body.kind === 'string' && body.kind !== '' ? body.kind : 'fact',
    tags: body.tags,
    source: typeof body.source === 'string' ? body.source : undefined,
  };
  const saved = await guardAsync(() => service.save(input));
  audit(ctx.deps, { kind: 'memory.save', botId, detail: text.slice(0, 80) });
  return saved;
}

async function searchMemories(ctx) {
  const service = memoryService(ctx.deps);
  if (!service || typeof service.search !== 'function') {
    throw notImplemented('记忆内核未装配（M4），暂不能检索记忆');
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

async function removeMemory(ctx) {
  const service = memoryService(ctx.deps);
  const remove = service && (typeof service.remove === 'function' ? service.remove : service.delete);
  if (typeof remove !== 'function') {
    throw notImplemented('记忆内核未装配（M4），暂不能删除记忆');
  }
  const id = asInt(ctx.params.id ?? queryString(ctx.query, 'id'), NaN, { min: 1 });
  if (!Number.isFinite(id)) throw badRequest('记忆 id 非法');
  const result = await guardAsync(() => remove.call(service, { id }));
  if (!result || result.removed !== true) throw notFound('记忆不存在: ' + id);
  audit(ctx.deps, { kind: 'memory.remove', detail: 'id=' + id });
  return { ok: true, removed: true, id: result.id ?? id };
}

export const routes = [
  { method: 'GET', path: '/api/memories', handler: listMemories },
  { method: 'POST', path: '/api/memories', handler: saveMemory },
  { method: 'POST', path: '/api/memories/search', handler: searchMemories },
  { method: 'DELETE', path: '/api/memories/:id', handler: removeMemory },
  { method: 'DELETE', path: '/api/memories', handler: removeMemory },
];
