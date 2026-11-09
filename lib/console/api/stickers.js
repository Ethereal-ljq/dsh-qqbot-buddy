/**
 * console/api/stickers —— 表情包库（DESIGN-v2 §3）。
 *
 * 按 (bot_id, hash) 去重；删除时同时尽力删文件；quota 供控制台展示当日发送量。
 * 优先 deps.stickers，缺省用 deps.db 即时构造 core/stickers/store。
 */
import { createStickersStore } from '../../core/stickers/store.js';
import {
  badRequest, notFound, guard, queryString, queryInt, asInt, audit,
} from './helpers.js';

function storeOf(ctx) {
  const injected = ctx.deps?.stickers;
  if (injected && typeof injected === 'object') return injected;
  return createStickersStore({ db: ctx.deps.db, logger: ctx.deps.logger });
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

function listStickers(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const limit = queryInt(ctx.query, 'limit', 200, { min: 1, max: 500 });
  const offset = queryInt(ctx.query, 'offset', 0, { min: 0, max: 1_000_000 });
  const emotion = queryString(ctx.query, 'emotion');
  return guard(() => store.list({ botId, limit, offset, emotion }));
}

function addSticker(ctx) {
  const body = ctx.body || {};
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') throw badRequest('缺少 name');
  const file = typeof body.file === 'string' ? body.file.trim() : '';
  if (file === '') throw badRequest('缺少 file');
  const sticker = guard(() => store.add({
    botId,
    name,
    file,
    emotion: typeof body.emotion === 'string' ? body.emotion : '',
    hash: typeof body.hash === 'string' ? body.hash : '',
  }));
  audit(ctx.deps, { kind: sticker.created ? 'sticker.add' : 'sticker.dedupe', botId, detail: sticker.file });
  return sticker;
}

function removeSticker(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const id = asInt(ctx.params.id, NaN, { min: 1 });
  if (!Number.isFinite(id)) throw badRequest('表情包 id 非法');
  const result = guard(() => store.remove({ botId, id }));
  if (!result || result.removed !== true) throw notFound('表情包不存在: ' + id);
  audit(ctx.deps, { kind: 'sticker.remove', botId, detail: String(id) });
  return { ok: true, removed: true, id, file: result.file };
}

function stickerQuota(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  return guard(() => store.quota({ botId }));
}

export const routes = [
  { method: 'GET', path: '/api/stickers', handler: listStickers },
  { method: 'POST', path: '/api/stickers', handler: addSticker },
  { method: 'GET', path: '/api/stickers/quota', handler: stickerQuota },
  { method: 'DELETE', path: '/api/stickers/:id', handler: removeSticker },
];
