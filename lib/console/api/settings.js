/**
 * console/api/settings —— GET/PUT /api/settings：分层设置的读写（?bot= 指定 bot 层视角）。
 *
 * GET 返回扁平点号键 values（与 /api/schema items[].key 对齐）；
 * PUT 接受扁平点号键 / 嵌套对象 / {values:{...}} 三种写法，
 * 经 core/config patchSettings 按 scope（global/bot/profile）自动分流归一化。
 */
import { requireConfig, flattenSettings, toNestedSettings, guard, badRequest, notFound, queryString, audit } from './helpers.js';

function readSchema(config) {
  const payload = guard(() => config.schema()) || {};
  return Array.isArray(payload.items) ? payload.items : [];
}

function resolveBotId(ctx) {
  return queryString(ctx.query, 'bot') || '';
}

function assertBotExists(config, botId) {
  if (botId === '') return;
  const bot = guard(() => config.getBot(botId));
  if (!bot) throw notFound('bot 不存在: ' + botId);
}

function getSettings(ctx) {
  const config = requireConfig(ctx.deps);
  const botId = resolveBotId(ctx);
  assertBotExists(config, botId);
  const items = readSchema(config);
  const effective = guard(() => config.getSettings(botId));
  audit(ctx.deps, { kind: 'settings.read', detail: 'bot=' + (botId || '(global)') });
  return { botId, values: flattenSettings(items, effective) };
}

function putSettings(ctx) {
  const config = requireConfig(ctx.deps);
  const botId = resolveBotId(ctx);
  assertBotExists(config, botId);
  const items = readSchema(config);
  const patch = toNestedSettings(ctx.body, items);
  if (Object.keys(patch).length === 0) throw badRequest('没有可更新的设置项');
  const result = guard(() => config.patchSettings(botId, patch)) || {};
  const effective = result.settings || guard(() => config.getSettings(botId));
  audit(ctx.deps, { kind: 'settings.patch', detail: 'bot=' + (botId || '(global)') });
  return {
    botId,
    values: flattenSettings(items, effective),
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    profileId: result.profileId ?? null,
  };
}

export const routes = [
  { method: 'GET', path: '/api/settings', handler: getSettings },
  { method: 'PUT', path: '/api/settings', handler: putSettings },
];
