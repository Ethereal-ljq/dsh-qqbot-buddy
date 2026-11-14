/**
 * console/api/stickers —— 表情包库（DESIGN-v2 §3）。
 *
 * 按 (bot_id, hash) 去重；删除时同时尽力删文件；quota 供控制台展示当日发送量。
 * 优先 deps.stickers，缺省用 deps.db 即时构造 core/stickers/store。
 */
import fs from 'node:fs';
import path from 'node:path';

import { createStickersStore } from '../../core/stickers/store.js';
import {
  badRequest, notFound, guard, queryString, queryInt, asInt, audit,
} from './helpers.js';

/** 表情包文件可预览的 MIME（其它扩展名当二进制下载）。 */
const STICKER_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

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

/**
 * 表情包文件预览：GET /api/stickers/:id/file?bot=…（RAW 流式响应）。
 *
 * 只服务「库里登记过」的文件（DB 是唯一真相），路径直接来自登记行；
 * 这里不做目录白名单——控制台本身就是管理员入口，且表情包可以登记任意本地路径。
 * 文件被移动/清理时返回 404，前端用占位图兜底。
 */
function stickerFile(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const id = asInt(ctx.params.id, NaN, { min: 1 });
  if (!Number.isFinite(id)) throw badRequest('表情包 id 非法');
  const sticker = guard(() => store.get({ botId, id }));
  if (!sticker || typeof sticker.file !== 'string' || sticker.file.trim() === '') {
    throw notFound('表情包不存在或没有文件: ' + id);
  }
  const file = path.resolve(sticker.file);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw notFound('表情包文件不存在（可能已被移动或清理）: ' + sticker.file);
  }
  if (!stat.isFile()) throw notFound('表情包路径不是普通文件: ' + sticker.file);
  const ext = path.extname(file).toLowerCase();
  const type = STICKER_MIME[ext] || 'application/octet-stream';
  const res = ctx.res;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=120',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
  // 响应已由 handler 自行写完（与 SSE 同样的 RAW 约定）
  return ctx.raw;
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
  { method: 'GET', path: '/api/stickers/:id/file', handler: stickerFile },
  { method: 'DELETE', path: '/api/stickers/:id', handler: removeSticker },
];
