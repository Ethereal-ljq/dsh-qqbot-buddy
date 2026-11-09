/**
 * console/api/bots —— Bot 增删改查（DESIGN-v2 §3）。
 *
 * bot 是 QQ 应用本体 + 独立工作目录；appSecret 只写不读：
 * GET 一律返回 appSecret:'' + hasAppSecret，PATCH 中 appSecret 缺省或空串表示不改。
 */
import {
  requireConfig, publicBot, guard, badRequest, notFound, asBool, audit,
} from './helpers.js';

function text(value) {
  return typeof value === 'string' ? value : '';
}

function listBots(ctx) {
  const config = requireConfig(ctx.deps);
  const rows = guard(() => config.listBots()) || [];
  return rows.map(publicBot);
}

function getBot(ctx) {
  const config = requireConfig(ctx.deps);
  const bot = guard(() => config.getBot(ctx.params.id));
  if (!bot) throw notFound('bot 不存在: ' + ctx.params.id);
  return publicBot(bot);
}

function createBot(ctx) {
  const config = requireConfig(ctx.deps);
  const body = ctx.body || {};
  const name = text(body.name).trim();
  if (name === '') throw badRequest('bot 名称不能为空');
  const input = {
    name,
    appId: text(body.appId),
    appSecret: text(body.appSecret),
    enabled: asBool(body.enabled, true),
    cwd: text(body.cwd).trim(),
  };
  const bot = guard(() => config.createBot(input));
  audit(ctx.deps, { kind: 'bot.create', botId: bot?.id, detail: name });
  return publicBot(bot);
}

function updateBot(ctx) {
  const config = requireConfig(ctx.deps);
  const id = ctx.params.id;
  const existing = guard(() => config.getBot(id));
  if (!existing) throw notFound('bot 不存在: ' + id);
  const body = ctx.body || {};
  const patch = {};
  if (typeof body.name === 'string' && body.name.trim() !== '') patch.name = body.name.trim();
  if (typeof body.appId === 'string') patch.appId = body.appId.trim();
  // 空串 = 保持原 secret 不变（避免前端脱敏表单误清空）
  if (typeof body.appSecret === 'string' && body.appSecret.trim() !== '') patch.appSecret = body.appSecret;
  if (body.enabled !== undefined) patch.enabled = asBool(body.enabled, existing.enabled);
  if (typeof body.cwd === 'string' && body.cwd.trim() !== '') patch.cwd = body.cwd.trim();
  const bot = guard(() => config.updateBot(id, patch));
  audit(ctx.deps, { kind: 'bot.update', botId: id, detail: JSON.stringify(Object.keys(patch)) });
  return publicBot(bot);
}

function deleteBot(ctx) {
  const config = requireConfig(ctx.deps);
  const id = ctx.params.id;
  const existing = guard(() => config.getBot(id));
  if (!existing) throw notFound('bot 不存在: ' + id);
  guard(() => config.deleteBot(id));
  audit(ctx.deps, { kind: 'bot.delete', botId: id, detail: existing.name || '' });
  return { ok: true, id };
}

export const routes = [
  { method: 'GET', path: '/api/bots', handler: listBots },
  { method: 'POST', path: '/api/bots', handler: createBot },
  { method: 'GET', path: '/api/bots/:id', handler: getBot },
  { method: 'PATCH', path: '/api/bots/:id', handler: updateBot },
  { method: 'DELETE', path: '/api/bots/:id', handler: deleteBot },
];
