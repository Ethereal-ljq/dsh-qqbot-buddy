/**
 * console/api/profiles —— 配置档（Profile）增删改查与激活（DESIGN-v2 §3 / §0.2）。
 *
 * Profile 只装可变策略（人设/模型/回复/工具策略），记忆与知识库按 bot 共享，切换 profile 不丢数据。
 * 创建 bot 时 core/config 会自动建一个默认 profile；最后一个 profile 不允许删除。
 */
import {
  requireConfig, guard, badRequest, notFound, asBool, queryString, audit, isPlainObject,
} from './helpers.js';

function listProfiles(ctx) {
  const config = requireConfig(ctx.deps);
  const botId = queryString(ctx.query, 'bot');
  if (botId) return guard(() => config.listProfiles(botId)) || [];
  const bots = guard(() => config.listBots()) || [];
  const out = [];
  for (const bot of bots) {
    for (const profile of guard(() => config.listProfiles(bot.id)) || []) out.push(profile);
  }
  return out;
}

function getProfile(ctx) {
  const config = requireConfig(ctx.deps);
  const profile = guard(() => config.getProfile(ctx.params.id));
  if (!profile) throw notFound('配置档不存在: ' + ctx.params.id);
  return profile;
}

function createProfile(ctx) {
  const config = requireConfig(ctx.deps);
  const body = ctx.body || {};
  const botId = typeof body.botId === 'string' ? body.botId : '';
  if (botId === '') throw badRequest('缺少 botId');
  const bot = guard(() => config.getBot(botId));
  if (!bot) throw notFound('bot 不存在: ' + botId);
  const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : '配置档';
  const data = isPlainObject(body.data) ? body.data : {};
  let profile = guard(() => config.createProfile(botId, { name, data }));
  if (asBool(body.isDefault, false) && profile) profile = guard(() => config.activateProfile(profile.id));
  audit(ctx.deps, { kind: 'profile.create', botId, detail: name });
  return profile;
}

function updateProfile(ctx) {
  const config = requireConfig(ctx.deps);
  const existing = getProfile(ctx);
  const body = ctx.body || {};
  const patch = {};
  if (typeof body.name === 'string' && body.name.trim() !== '') patch.name = body.name.trim();
  if (isPlainObject(body.data)) patch.data = body.data;
  if (body.isDefault !== undefined) patch.isDefault = asBool(body.isDefault, existing.isDefault);
  const profile = guard(() => config.updateProfile(existing.id, patch));
  audit(ctx.deps, { kind: 'profile.update', botId: existing.botId, detail: existing.id });
  return profile;
}

function activateProfile(ctx) {
  const config = requireConfig(ctx.deps);
  const existing = getProfile(ctx);
  const profile = guard(() => config.activateProfile(existing.id));
  audit(ctx.deps, { kind: 'profile.activate', botId: existing.botId, detail: existing.id });
  return profile;
}

function deleteProfile(ctx) {
  const config = requireConfig(ctx.deps);
  const existing = getProfile(ctx);
  guard(() => config.deleteProfile(existing.id));
  audit(ctx.deps, { kind: 'profile.delete', botId: existing.botId, detail: existing.id });
  return { ok: true, id: existing.id };
}

export const routes = [
  { method: 'GET', path: '/api/profiles', handler: listProfiles },
  { method: 'POST', path: '/api/profiles', handler: createProfile },
  { method: 'GET', path: '/api/profiles/:id', handler: getProfile },
  { method: 'PATCH', path: '/api/profiles/:id', handler: updateProfile },
  { method: 'DELETE', path: '/api/profiles/:id', handler: deleteProfile },
  { method: 'POST', path: '/api/profiles/:id/activate', handler: activateProfile },
];
