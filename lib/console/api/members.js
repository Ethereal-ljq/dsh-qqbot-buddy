/**
 * console/api/members —— 群友库 CRUD（DESIGN-v2 §3）。
 *
 * 优先使用 deps.members（lib/index.js 装配的 runtime.members）；未装配时用 deps.db
 * 即时构造 core/members/store（store 无状态、等价），保证控制台独立可用。
 * bot 存在性用可选 deps.config 校验；写操作记 audit。
 */
import { createMembersStore } from '../../core/members/store.js';
import {
  badRequest, notFound, guard, queryString, queryInt, asInt, audit,
} from './helpers.js';

function storeOf(ctx) {
  const injected = ctx.deps?.members;
  if (injected && typeof injected === 'object') return injected;
  return createMembersStore({ db: ctx.deps.db });
}

function assertBot(ctx, botId) {
  const config = ctx.deps?.config;
  if (!config || typeof config.getBot !== 'function') return;
  const bot = guard(() => config.getBot(botId));
  if (!bot) throw notFound('bot 不存在: ' + botId);
}

/** ?bot= 优先，其次 body.botId；缺 bot 视为 400。 */
function botIdOf(ctx) {
  const fromQuery = queryString(ctx.query, 'bot');
  const fromBody = typeof ctx.body?.botId === 'string' ? ctx.body.botId.trim() : '';
  const botId = fromQuery || fromBody;
  if (!botId) throw badRequest('缺少 bot 参数');
  assertBot(ctx, botId);
  return botId;
}

function listMembers(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const limit = queryInt(ctx.query, 'limit', 100, { min: 1, max: 500 });
  const offset = queryInt(ctx.query, 'offset', 0, { min: 0, max: 1_000_000 });
  const query = queryString(ctx.query, 'q') || queryString(ctx.query, 'query') || '';
  return guard(() => store.list({ botId, limit, offset, query }));
}

function getMember(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const id = asInt(ctx.params.id, NaN, { min: 1 });
  if (!Number.isFinite(id)) throw badRequest('成员 id 非法');
  const member = guard(() => store.get({ botId, id }));
  if (!member) throw notFound('成员不存在: ' + id);
  return member;
}

function upsertMember(ctx) {
  const body = ctx.body || {};
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const openid = typeof body.openid === 'string' ? body.openid.trim() : '';
  if (openid === '') throw badRequest('缺少 openid');
  const profileJson = body.profileJson !== undefined ? body.profileJson : body.profile;
  const member = guard(() => store.upsert({
    botId,
    openid,
    nickname: body.nickname,
    note: body.note,
    profileJson,
  }));
  audit(ctx.deps, { kind: 'member.upsert', botId, detail: openid });
  return member;
}

function updateMember(ctx) {
  const body = ctx.body || {};
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const id = asInt(ctx.params.id, NaN, { min: 1 });
  if (!Number.isFinite(id)) throw badRequest('成员 id 非法');
  const member = guard(() => store.update({
    botId,
    id,
    nickname: body.nickname,
    note: body.note,
    profileJson: body.profileJson !== undefined ? body.profileJson : body.profile,
  }));
  if (!member) throw notFound('成员不存在: ' + id);
  audit(ctx.deps, { kind: 'member.update', botId, detail: String(id) });
  return member;
}

function removeMember(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const id = asInt(ctx.params.id, NaN, { min: 1 });
  if (!Number.isFinite(id)) throw badRequest('成员 id 非法');
  const result = guard(() => store.remove({ botId, id }));
  if (!result || result.removed !== true) throw notFound('成员不存在: ' + id);
  audit(ctx.deps, { kind: 'member.remove', botId, detail: String(id) });
  return { ok: true, removed: true, id };
}

export const routes = [
  { method: 'GET', path: '/api/members', handler: listMembers },
  { method: 'POST', path: '/api/members', handler: upsertMember },
  { method: 'GET', path: '/api/members/:id', handler: getMember },
  { method: 'PATCH', path: '/api/members/:id', handler: updateMember },
  { method: 'DELETE', path: '/api/members/:id', handler: removeMember },
];
