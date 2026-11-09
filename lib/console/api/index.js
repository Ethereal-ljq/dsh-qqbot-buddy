/**
 * console/api/index —— API 路由汇总（声明式路由表）。
 *
 * 每条 route: { method, path(支持 :param), auth?, csrf?, handler(ctx) }
 * - auth 默认 true（要会话 cookie）；auth:false 仅 health/login；
 * - csrf 默认对非 GET 生效；route.csrf 可显式覆盖；
 * - server.js 负责匹配、鉴权、CSRF、body 解析与统一错误格式。
 */
import { routes as health } from './health.js';
import { routes as auth } from './auth.js';
import { routes as state } from './state.js';
import { routes as bots } from './bots.js';
import { routes as profiles } from './profiles.js';
import { routes as bindings } from './bindings.js';
import { routes as settings } from './settings.js';
import { routes as schema } from './schema.js';
import { routes as tools } from './tools.js';
import { routes as kb } from './kb.js';
import { routes as memories } from './memories.js';
import { routes as members } from './members.js';
import { routes as personas } from './personas.js';
import { routes as stickers } from './stickers.js';
import { routes as audit } from './audit.js';
import { routes as stubs } from './stubs.js';

/** 全部 API 路由（SSE /api/events 由 server 用 sse hub 单独挂载）。 */
export const API_ROUTES = [
  ...health,
  ...auth,
  ...state,
  ...bots,
  ...profiles,
  ...bindings,
  ...settings,
  ...schema,
  ...tools,
  ...kb,
  ...memories,
  ...members,
  ...personas,
  ...stickers,
  ...audit,
  ...stubs,
];
