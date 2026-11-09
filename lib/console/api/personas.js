/**
 * console/api/personas —— 人格卡 CRUD + 激活（DESIGN-v2 §3）。
 *
 * 激活由 core/personas/store 事务内保证同 bot 唯一 active，并原子写
 * <bot cwd>/persona.md（写失败只 warn，不影响激活结果）。
 * 优先 deps.personas，缺省用 deps.db 即时构造 store。
 */
import { createPersonasStore } from '../../core/personas/store.js';
import {
  badRequest, notFound, guard, queryString, asInt, audit,
} from './helpers.js';

function storeOf(ctx) {
  const injected = ctx.deps?.personas;
  if (injected && typeof injected === 'object') return injected;
  return createPersonasStore({ db: ctx.deps.db, logger: ctx.deps.logger });
}

function assertBot(ctx, botId) {
  const config = ctx.deps?.config;
  if (!config || typeof config.getBot !== 'function') return;
  const bot = guard(() => config.getBot(botId));
  if (!bot) throw notFound('bot 不存在: ' + botId);
}

function botIdOf(ctx) {
  const fromQuery = queryString(ctx.query, 'bot');
  const fromBody = typeof ctx.body?.botId === 'string' ? ctx.body.botId.trim() : '';
  const botId = fromQuery || fromBody;
  if (!botId) throw badRequest('缺少 bot 参数');
  assertBot(ctx, botId);
  return botId;
}

function listPersonas(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  return guard(() => store.list({ botId }));
}

function getPersona(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const persona = guard(() => store.get({ botId, id: ctx.params.id }));
  if (!persona) throw notFound('人格卡不存在: ' + ctx.params.id);
  return persona;
}

function createPersona(ctx) {
  const body = ctx.body || {};
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') throw badRequest('缺少 name');
  if (body.content !== undefined && typeof body.content !== 'string') throw badRequest('content 必须是字符串');
  const persona = guard(() => store.create({ botId, name, content: body.content ?? '' }));
  audit(ctx.deps, { kind: 'persona.create', botId, detail: persona.id });
  return persona;
}

function updatePersona(ctx) {
  const body = ctx.body || {};
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
    throw badRequest('name 必须是非空字符串');
  }
  if (body.content !== undefined && typeof body.content !== 'string') throw badRequest('content 必须是字符串');
  if (body.name === undefined && body.content === undefined) throw badRequest('没有可更新的字段');
  const persona = guard(() => store.update({ botId, id: ctx.params.id, name: body.name, content: body.content }));
  if (!persona) throw notFound('人格卡不存在: ' + ctx.params.id);
  audit(ctx.deps, { kind: 'persona.update', botId, detail: persona.id });
  return persona;
}

function deletePersona(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const result = guard(() => store.remove({ botId, id: ctx.params.id }));
  if (!result || result.removed !== true) throw notFound('人格卡不存在: ' + ctx.params.id);
  audit(ctx.deps, { kind: 'persona.remove', botId, detail: ctx.params.id });
  return { ok: true, removed: true, id: ctx.params.id };
}

function activatePersona(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const persona = guard(() => store.activate({ botId, id: ctx.params.id }));
  if (!persona) throw notFound('人格卡不存在: ' + ctx.params.id);
  audit(ctx.deps, { kind: 'persona.activate', botId, detail: persona.id });
  return persona;
}

export const routes = [
  { method: 'GET', path: '/api/personas', handler: listPersonas },
  { method: 'POST', path: '/api/personas', handler: createPersona },
  { method: 'GET', path: '/api/personas/:id', handler: getPersona },
  { method: 'PATCH', path: '/api/personas/:id', handler: updatePersona },
  { method: 'DELETE', path: '/api/personas/:id', handler: deletePersona },
  { method: 'POST', path: '/api/personas/:id/activate', handler: activatePersona },
];
