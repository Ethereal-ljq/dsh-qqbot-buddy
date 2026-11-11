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

/** job_state 里记忆提炼任务名（与 core/memory/collect.js 的 JOB_NAME 保持一致）。 */
const COLLECT_JOB = 'memory-collect';

/** job_state.value 是 JSON 字符串（collector 写入）；解析失败按空状态处理，与 collector 读状态口径一致。 */
function parseJobState(value) {
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toFiniteInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

/**
 * job_state 行 → 提炼状态（camelCase，前端契约）。
 * 字段语义与 core/memory/collect.js 的 normalizeState 对齐：
 * lastOutcome / lastReason / lastFacts / failureCount 是 P0 可观测性新增的结局字段，
 * 旧数据没有这些字段时按“尚未记录”处理（outcome=''）。
 */
function rowToCollectState(row) {
  const state = parseJobState(row.value);
  const lastRunAt = toFiniteInt(state.lastRunAt, 0);
  const updatedAt = toFiniteInt(row.updated_at, 0);
  return {
    botId: row.bot_id,
    peer: row.peer ?? '',
    rounds: Math.max(0, toFiniteInt(state.rounds, 0)),
    lastRunAt: lastRunAt > 0 ? lastRunAt : null,
    lastSaved: Math.max(0, toFiniteInt(state.lastSaved, 0)),
    lastOutcome: typeof state.lastOutcome === 'string' ? state.lastOutcome : '',
    lastReason: typeof state.lastReason === 'string' ? state.lastReason : '',
    lastFacts: Math.max(0, toFiniteInt(state.lastFacts, 0)),
    failureCount: Math.max(0, toFiniteInt(state.failureCount, 0)),
    updatedAt: updatedAt > 0 ? updatedAt : null,
  };
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

/**
 * GET /api/memories/health —— 记忆自动提炼健康度（各 peer 的最近结局）。
 *
 * 直读 job_state 的理由与 list 直读 SQLite 一致：collector 实例不一定装配进 console deps，
 * 而 job_state 是持久化事实来源（重启不丢），控制台只读即可诊断
 * 「提炼跑过但 0 入库」到底是 parse-empty / all-deduped，还是根本没触发（没有记录）。
 * 参数：bot（可选，按机器人过滤）、limit（默认 100，1~500），按 updated_at 倒序。
 */
async function listCollectHealth(ctx) {
  const db = ctx.deps?.db;
  if (!db) return [];
  const botId = queryString(ctx.query, 'bot');
  const limit = queryInt(ctx.query, 'limit', 100, { min: 1, max: 500 });
  const where = ['job = ?'];
  const params = [COLLECT_JOB];
  if (botId) { where.push('bot_id = ?'); params.push(botId); }
  const sql = 'SELECT bot_id, peer, value, updated_at FROM job_state'
    + ' WHERE ' + where.join(' AND ')
    + ' ORDER BY updated_at DESC LIMIT ?';
  return all(db, sql, ...params, limit).map(rowToCollectState);
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
  { method: 'GET', path: '/api/memories/health', handler: listCollectHealth },
  { method: 'POST', path: '/api/memories', handler: saveMemory },
  { method: 'POST', path: '/api/memories/search', handler: searchMemories },
  { method: 'DELETE', path: '/api/memories/:id', handler: removeMemory },
  { method: 'DELETE', path: '/api/memories', handler: removeMemory },
];
