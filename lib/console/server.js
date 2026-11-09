/**
 * console/server —— 独立控制台 HTTP 服务（node:http，零外部依赖）。
 *
 * 用法（由 lib/index.js 装配，随插件 apply/dispose 起停）：
 *   const server = createConsoleServer({ deps, host: '127.0.0.1', port: 6198, logger });
 *   await server.start();   // 首次启动会初始化 token（scrypt 入库 + 明文文件 0600）
 *   server.address();       // { host, port, url } | null
 *   await server.stop();    // 断开 SSE、关闭连接
 *
 * deps（除 db 外全部可选，缺服务时对应接口降级为 501/空态，绝不 import 不存在的模块）：
 *   db             node:sqlite DatabaseSync（必需）
 *   config         core/config store（Bot/Profile/Binding/设置/审计）
 *   kb / memory    知识库 / 记忆内核（写接口未装配时 501）
 *   toolsDiscover  工具发现（M2；未装配 items=[]）
 *   runtime        运行状态 {online,bots} 或 {getStatus()}
 *   events         EventEmitter（SSE 事件源：bot/status、log、job/progress）
 *   auth           createConsoleAuth 实例（装配方预创建时传入；否则本服务创建并回填 deps.auth）
 *   actions        { run(name, body) }（POST /api/actions/:name）
 *   paths          { dataDir, webDist, tokenFile }
 *   logger         { debug, info, warn, error }
 *
 * 路由表声明式：route = { method, path(支持 :param), auth?, csrf?, handler(ctx) }。
 * handler 返回值 → 200 JSON；抛 HttpError → 对应状态；返回 RAW 表示已自行写响应（SSE）。
 * 中间件顺序：Host 校验 → 路由匹配 → 会话鉴权 → CSRF → JSON body → handler。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_ROUTES } from './api/index.js';
import { HttpError, runtimeStatus } from './api/helpers.js';
import { COOKIE_NAME, createConsoleAuth, isCsrfValid, parseCookies } from './auth.js';
import { createSseHub } from './sse.js';
import { createStaticHandler } from './static.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 6198;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
/** handler 返回它表示“响应已由 handler 写完”（SSE 长连接）。 */
const RAW = Symbol('console.raw-response');
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 包版本（health/state 展示；读不到不致命）。 */
function readVersion() {
  try {
    const file = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = readVersion();

/** 默认数据目录：~/.dsh-qqbot/v2（运行数据不进 workspace，DESIGN §0.4）。 */
function defaultDataDir() {
  return path.join(os.homedir(), '.dsh-qqbot', 'v2');
}

/** 默认前端产物目录：<repo>/web/dist。 */
function defaultWebDist() {
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTNAMES.has(String(host || '').toLowerCase());
}

/** 归一化远端地址（IPv4-mapped IPv6 → IPv4）。 */
function normalizeIp(address) {
  const value = String(address || '');
  if (value === '::1') return '::1';
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value;
}

/** logger 适配：只取可用的方法，缺省静默。 */
function createLogger(logger) {
  const noop = () => {};
  const pick = (level) => (logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : noop);
  return { debug: pick('debug'), info: pick('info'), warn: pick('warn'), error: pick('error') };
}

/** 监听地址 → 可点击 URL 的 host 部分。 */
function displayHost(host) {
  const value = String(host || DEFAULT_HOST);
  if (value === '0.0.0.0' || value === '::') return '127.0.0.1';
  if (value.includes(':') && !value.startsWith('[')) return '[' + value + ']';
  return value;
}

/** 请求 id：优先回显客户端 X-Request-Id（限安全字符），否则生成。 */
function resolveRequestId(req) {
  const raw = req.headers ? req.headers['x-request-id'] : undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)) return value;
  return crypto.randomUUID();
}

/** 解析请求 URL（host 头参与解析，非法时 400）。 */
function parseRequestUrl(req) {
  const raw = typeof req.url === 'string' && req.url !== '' ? req.url : '/';
  const hostHeader = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'localhost';
  try {
    return new URL(raw, 'http://' + hostHeader);
  } catch {
    throw new HttpError(400, 'bad_request', '非法请求 URL');
  }
}

/** 路径 → 解码后的段数组（解码失败 400）。 */
function splitPath(pathname) {
  const parts = String(pathname || '/').split('/');
  const out = [];
  for (const part of parts) {
    if (part === '') continue;
    try {
      out.push(decodeURIComponent(part));
    } catch {
      throw new HttpError(400, 'bad_path', '非法请求路径');
    }
  }
  return out;
}

/** 编译路由声明为匹配器（:param 提取）。 */
function compileRoute(route) {
  const parts = String(route.path || '/').split('/').filter((part) => part !== '').map((part) => (
    part.startsWith(':') ? { key: part.slice(1) } : { literal: part }
  ));
  return {
    method: String(route.method || 'GET').toUpperCase(),
    auth: route.auth,
    csrf: route.csrf,
    handler: route.handler,
    parts,
  };
}

function matchSegments(compiled, segments) {
  if (compiled.parts.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < compiled.parts.length; i += 1) {
    const part = compiled.parts[i];
    const segment = segments[i];
    if (part.key !== undefined) {
      if (segment === '') return null;
      params[part.key] = segment;
    } else if (part.literal !== segment) {
      return null;
    }
  }
  return params;
}

/** 找到 route；找不到时返回该路径允许的方法（用于 405）。 */
function findRoute(compiledRoutes, method, segments) {
  const allowed = new Set();
  for (const compiled of compiledRoutes) {
    const params = matchSegments(compiled, segments);
    if (params === null) continue;
    allowed.add(compiled.method);
    if (compiled.method === method) return { route: compiled, params, allowed: [] };
  }
  return { route: null, params: null, allowed: [...allowed] };
}

/** 读取并解析 JSON 请求体（空体 → {}；超限 413；非法 JSON 400）。 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        done(new HttpError(413, 'payload_too_large', '请求体过大（上限 ' + limit + ' 字节）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (chunks.length === 0) { done(null, {}); return; }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') { done(null, {}); return; }
      try {
        done(null, JSON.parse(text));
      } catch {
        done(new HttpError(400, 'invalid_json', '请求体不是合法 JSON'));
      }
    });
    req.on('error', (err) => done(err));
  });
}

/** 统一 JSON 响应（已设置的头如 X-Request-Id 会保留）。 */
function sendJson(res, status, data, extraHeaders = {}) {
  if (res.writableEnded) return;
  let payload;
  try {
    payload = JSON.stringify(data === undefined ? null : data);
  } catch {
    status = 500;
    payload = JSON.stringify({ error: { code: 'serialize_error', message: '响应序列化失败' } });
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

/** 统一错误响应 {error:{code,message,requestId}}；5xx 只回笼统文案并记日志。 */
function sendError(res, err, requestId, log) {
  const isHttp = err instanceof HttpError;
  const status = isHttp ? err.status : 500;
  const code = isHttp ? err.code : 'internal_error';
  const message = isHttp ? err.message : '服务器内部错误';
  if (!isHttp) {
    log.error('[console] 未处理异常 requestId=' + requestId, err);
  } else if (status >= 500) {
    log.error('[console] ' + status + ' ' + code + ' ' + message + ' requestId=' + requestId);
  } else {
    log.debug('[console] ' + status + ' ' + code + ' ' + message + ' requestId=' + requestId);
  }
  const error = { code, message, requestId };
  if (isHttp && err.details && typeof err.details === 'object') {
    for (const [key, value] of Object.entries(err.details)) {
      if (key === 'headers') continue;
      error[key] = value;
    }
  }
  const headers = {};
  if (isHttp && err.details?.retryAfter) headers['Retry-After'] = String(err.details.retryAfter);
  if (isHttp && err.details?.headers && typeof err.details.headers === 'object') {
    Object.assign(headers, err.details.headers);
  }
  sendJson(res, status, { error }, headers);
}

/**
 * 创建控制台服务。
 * @param {object} options
 * @param {object} options.deps 依赖注入（见文件头注释）
 * @param {string} [options.host] 监听地址（默认 127.0.0.1）
 * @param {number} [options.port] 监听端口（默认 6198；0 = 随机端口，测试用）
 * @param {object} [options.logger] 日志
 * @param {string} [options.token] 部署配置里的预置 token（也可放在 deps.token）
 * @param {string[]} [options.allowedHosts] 覆盖 Host 头白名单
 * @param {number} [options.maxBodyBytes] JSON 请求体上限
 * @returns {{start:Function, stop:Function, address:Function}}
 */
export function createConsoleServer({
  deps = {},
  host,
  port,
  logger,
  token,
  allowedHosts,
  maxBodyBytes,
} = {}) {
  const baseDeps = deps && typeof deps === 'object' ? deps : {};
  if (!baseDeps.db) throw new Error('createConsoleServer 需要 deps.db（node:sqlite DatabaseSync）');

  const log = createLogger(logger || baseDeps.logger);
  const dataDir = baseDeps.paths?.dataDir || defaultDataDir();
  const webDist = baseDeps.paths?.webDist || defaultWebDist();
  const tokenFile = baseDeps.paths?.tokenFile || null;
  const configuredToken = typeof token === 'string'
    ? token
    : (typeof baseDeps.token === 'string' ? baseDeps.token : '');
  const listenHost = typeof host === 'string' && host !== '' ? host : DEFAULT_HOST;
  const parsedPort = typeof port === 'number' ? port : (typeof port === 'string' && port !== '' ? Number(port) : DEFAULT_PORT);
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error('控制台端口非法: ' + port);
  }
  const bodyLimit = Number.isInteger(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : DEFAULT_MAX_BODY_BYTES;
  const hostAllowlist = Array.isArray(allowedHosts) && allowedHosts.length > 0
    ? new Set(allowedHosts.map((item) => String(item).toLowerCase()))
    : null;

  let httpServer = null;
  let auth = baseDeps.auth && typeof baseDeps.auth === 'object' ? baseDeps.auth : null;
  let staticHandler = null;
  let sseHub = null;
  let startedAt = 0;
  let boundPort = parsedPort;
  let stopping = false;

  const compiledRoutes = API_ROUTES.map(compileRoute);
  // SSE 不是普通 JSON 响应，单独挂载（仍走 cookie 鉴权，GET 不需要 CSRF）
  compiledRoutes.push(compileRoute({
    method: 'GET',
    path: '/api/events',
    auth: true,
    csrf: false,
    handler: (ctx) => {
      sseHub.handle(ctx.req, ctx.res, { requestId: ctx.requestId });
      return RAW;
    },
  }));

  function consoleInfo(online) {
    const uptimeMs = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
    return { version: VERSION, host: listenHost, port: boundPort, startedAt, uptimeMs, online: Boolean(online) };
  }

  /** Host 头校验（防 DNS rebinding）：只绑回环时只接受本机主机名，任意端口。 */
  function isHostAllowed(url) {
    const hostname = String(url?.hostname || '').toLowerCase();
    if (hostAllowlist) return hostAllowlist.has(hostname);
    if (!isLoopbackHost(listenHost)) return true;
    return LOOPBACK_HOSTNAMES.has(hostname);
  }

  function buildContext(req, res, url, match, requestId) {
    const runtime = runtimeStatus(baseDeps);
    const cookies = parseCookies(req.headers.cookie);
    return {
      req,
      res,
      deps: baseDeps,
      url,
      query: url.searchParams,
      params: match.params || {},
      body: null,
      requestId,
      ip: normalizeIp(req.socket?.remoteAddress),
      sid: cookies[COOKIE_NAME] || null,
      session: null,
      auth,
      sseHub,
      logger: log,
      raw: RAW,
      console: consoleInfo(runtime.online),
    };
  }

  /** 单条路由的中间件链：鉴权 → CSRF → body → handler。 */
  async function dispatch(route, ctx) {
    const method = String(ctx.req.method || 'GET').toUpperCase();
    if (route.auth !== false) {
      const session = ctx.sid ? auth.getSession(ctx.sid) : null;
      if (!session) throw new HttpError(401, 'unauthorized', '未登录或会话已过期');
      ctx.session = session;
    }
    const needsCsrf = route.csrf !== undefined ? Boolean(route.csrf) : !SAFE_METHODS.has(method);
    if (needsCsrf && !isCsrfValid(ctx.req)) {
      throw new HttpError(403, 'csrf_required', '非 GET 请求缺少 X-QQBot-CSRF: 1');
    }
    if (BODY_METHODS.has(method)) ctx.body = await readJsonBody(ctx.req, bodyLimit);
    const result = await route.handler(ctx);
    if (result === RAW) return;
    sendJson(ctx.res, 200, result === undefined ? null : result);
  }

  async function handleRequest(req, res) {
    const requestId = resolveRequestId(req);
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = parseRequestUrl(req);
      if (!isHostAllowed(url)) {
        throw new HttpError(403, 'invalid_host', 'Host 头不被允许（控制台只接受本机访问）');
      }
      const method = String(req.method || 'GET').toUpperCase();
      const segments = splitPath(url.pathname);
      const match = findRoute(compiledRoutes, method, segments);
      if (match.route) {
        const ctx = buildContext(req, res, url, match, requestId);
        await dispatch(match.route, ctx);
        return;
      }
      if (match.allowed.length > 0) {
        res.setHeader('Allow', match.allowed.join(', '));
        throw new HttpError(405, 'method_not_allowed', '不支持的请求方法: ' + method);
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        throw new HttpError(404, 'not_found', '接口不存在: ' + method + ' ' + url.pathname);
      }
      await staticHandler.handle(req, res, { url, requestId });
    } catch (err) {
      if (res.headersSent) {
        // 静态/SSE 响应已开始：不要再写 JSON，直接结束连接
        try { res.end(); } catch { /* ignore */ }
        if (!(err instanceof HttpError)) log.error('[console] 响应中途异常 requestId=' + requestId, err);
        return;
      }
      sendError(res, err, requestId, log);
    }
  }

  async function start() {
    if (httpServer) return address();
    if (stopping) throw new Error('控制台正在停止，不能立刻重新启动');
    startedAt = Date.now();
    if (!auth) {
      auth = createConsoleAuth({
        db: baseDeps.db,
        dataDir,
        tokenFile,
        token: configuredToken,
        logger: log,
        sessionTtlMs: baseDeps.sessionTtlMs,
        rateLimit: baseDeps.rateLimit,
      });
      if (!baseDeps.auth) {
        try { baseDeps.auth = auth; } catch { /* deps 可能被冻结 */ }
      }
    }
    if (typeof auth.ensureToken === 'function') {
      const info = auth.ensureToken();
      if (info && info.created) log.info('[console] 首次启动已生成控制台 token，明文见 ' + auth.tokenPath);
    }
    if (typeof auth.cleanupExpired === 'function') auth.cleanupExpired();
    staticHandler = createStaticHandler({ distDir: webDist, logger: log });
    sseHub = createSseHub({ events: baseDeps.events ?? null, logger: log, version: VERSION });

    const server = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        log.error('[console] 请求处理未捕获异常', err);
        if (!res.headersSent) sendError(res, new HttpError(500, 'internal_error', '服务器内部错误'), resolveRequestId(req), log);
      });
    });
    server.on('clientError', (err, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(parsedPort, listenHost);
    });
    server.on('error', (err) => log.error('[console] HTTP 服务异常：' + (err?.message || err)));
    httpServer = server;
    const info = server.address();
    boundPort = info && typeof info === 'object' ? info.port : parsedPort;
    if (!isLoopbackHost(listenHost)) {
      log.warn('[console] 控制台监听在非回环地址 ' + listenHost + '，请确认网络可信并保证 token 强度');
    }
    log.info('[console] 控制台已启动 http://' + displayHost(listenHost) + ':' + boundPort);
    return address();
  }

  async function stop() {
    stopping = true;
    const server = httpServer;
    httpServer = null;
    if (sseHub) {
      try { sseHub.closeAll(); } catch { /* ignore */ }
      sseHub = null;
    }
    staticHandler = null;
    if (server) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        server.close(finish);
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        setTimeout(finish, 2000).unref?.();
      });
    }
    stopping = false;
    log.info('[console] 控制台已停止');
  }

  function address() {
    if (!httpServer) return null;
    const info = httpServer.address();
    if (!info || typeof info !== 'object') return null;
    return { host: listenHost, port: info.port, url: 'http://' + displayHost(listenHost) + ':' + info.port };
  }

  return { start, stop, address };
}
