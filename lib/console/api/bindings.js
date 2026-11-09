/**
 * console/api/bindings —— 作用域绑定（scope → profile，DESIGN-v2 §0.2 / §3）。
 *
 * scope 采用 UMO 风格：qq:group:123 / qq:group:* / qq:c2c:* / qq:* / *；
 * 数值 priority + 匹配精度排序，实际解析在 core/peer.pickBinding，本层只做 CRUD。
 * - PUT /api/bindings        body {botId,scope,profileId,priority} 按 UNIQUE(bot_id,scope) upsert
 * - PUT /api/bindings/:id    更新已有绑定（scope 变更时删旧建新）
 * - DELETE /api/bindings/:id
 */
import {
  requireConfig, guard, badRequest, notFound, asInt, queryString, audit,
} from './helpers.js';

function listBindings(ctx) {
  const config = requireConfig(ctx.deps);
  const botId = queryString(ctx.query, 'bot');
  if (botId) return guard(() => config.listBindings(botId)) || [];
  const bots = guard(() => config.listBots()) || [];
  const out = [];
  for (const bot of bots) {
    for (const binding of guard(() => config.listBindings(bot.id)) || []) out.push(binding);
  }
  return out;
}

/** 按全局自增 id 找回绑定（store 未提供 getBinding，扫描各 bot；绑定数量很小）。 */
function findBinding(config, bindingId) {
  const target = String(bindingId);
  const bots = guard(() => config.listBots()) || [];
  for (const bot of bots) {
    const rows = guard(() => config.listBindings(bot.id)) || [];
    const found = rows.find((row) => String(row.id) === target);
    if (found) return found;
  }
  return null;
}

function upsertBinding(ctx) {
  const config = requireConfig(ctx.deps);
  const body = ctx.body || {};
  const botId = typeof body.botId === 'string' ? body.botId : '';
  const scope = typeof body.scope === 'string' ? body.scope.trim() : '';
  const profileId = typeof body.profileId === 'string' ? body.profileId : '';
  if (botId === '') throw badRequest('缺少 botId');
  if (scope === '') throw badRequest('缺少 scope');
  if (profileId === '') throw badRequest('缺少 profileId');
  const priority = asInt(body.priority, 0, { min: -100000, max: 100000 });
  const binding = guard(() => config.upsertBinding(botId, scope, profileId, priority));
  audit(ctx.deps, { kind: 'binding.upsert', botId, detail: scope + ' -> ' + profileId });
  return binding;
}

function updateBinding(ctx) {
  const config = requireConfig(ctx.deps);
  const existing = findBinding(config, ctx.params.id);
  if (!existing) throw notFound('绑定不存在: ' + ctx.params.id);
  const body = ctx.body || {};
  const scope = typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : existing.scope;
  const profileId = typeof body.profileId === 'string' && body.profileId !== '' ? body.profileId : existing.profileId;
  const priority = body.priority !== undefined
    ? asInt(body.priority, existing.priority, { min: -100000, max: 100000 })
    : existing.priority;
  // scope 变了等于换唯一键：先删旧记录，再按新 scope upsert
  if (scope !== existing.scope) guard(() => config.deleteBinding(existing.id));
  const binding = guard(() => config.upsertBinding(existing.botId, scope, profileId, priority));
  audit(ctx.deps, { kind: 'binding.update', botId: existing.botId, detail: existing.id + ' ' + scope });
  return binding;
}

function deleteBinding(ctx) {
  const config = requireConfig(ctx.deps);
  const existing = findBinding(config, ctx.params.id);
  if (!existing) throw notFound('绑定不存在: ' + ctx.params.id);
  guard(() => config.deleteBinding(existing.id));
  audit(ctx.deps, { kind: 'binding.delete', botId: existing.botId, detail: existing.scope });
  return { ok: true, id: existing.id };
}

export const routes = [
  { method: 'GET', path: '/api/bindings', handler: listBindings },
  { method: 'PUT', path: '/api/bindings', handler: upsertBinding },
  { method: 'PUT', path: '/api/bindings/:id', handler: updateBinding },
  { method: 'DELETE', path: '/api/bindings/:id', handler: deleteBinding },
];
