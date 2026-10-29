/**
 * web/bind-routes —— 扫码绑定 4 条 HTTP 路由（设置页「概览 → 绑定卡片」数据面）。
 *
 *   GET  /qqbot-buddy/api/bind/state    绑定状态投影（appId 可回显，appSecret 永不回显）
 *   POST /qqbot-buddy/api/bind/refresh  丢弃当前二维码并重建
 *   POST /qqbot-buddy/api/bind/manual   {appId, appSecret} 手动填写凭据
 *   POST /qqbot-buddy/api/bind/unbind   解绑（清 patch 凭据 + 重启绑定流程）
 *
 * 与 lib/web/routes.js 保持同一套约定：
 * - 只挂本机 webServer（同源、无额外鉴权，与 chatonly-* 一致）；
 * - 全部 JSON 响应 {ok:true,...} / {ok:false,error}，带 cache-control:no-store；
 * - 请求体上限 8KB（413）、非法 JSON 400、方法不允许 405、跨源 403；
 * - 任何 handler 异常都被兜底成 JSON（绝不抛回宿主）。
 *
 * 生命周期：registerBindRoutes 返回聚合 dispose，由 lib/index.js 通过 ctx.effect 绑定
 * 到插件 fiber；webServer 尚未就绪时用 ctx.inject(['webServer']) 等待（与 routes.js 同）。
 *
 * 依赖注入：{ binding, runtime }。
 * - binding 可为 null（例如插件未装配绑定服务）：state 返回 idle，其余动作 503；
 * - runtime.logger 仅用于日志，缺失时降级 console。
 */

const BASE = '/qqbot-buddy/api/bind';

/** 绑定状态查询（GET/HEAD）。 */
export const BIND_STATE_PATH = BASE + '/state';
/** 刷新二维码（POST）。 */
export const BIND_REFRESH_PATH = BASE + '/refresh';
/** 手动填写凭据（POST，body {appId, appSecret}）。 */
export const BIND_MANUAL_PATH = BASE + '/manual';
/** 解绑（POST）。 */
export const BIND_UNBIND_PATH = BASE + '/unbind';

/** 手动凭据请求体上限（appId 128 + appSecret 256 远小于此值）。 */
const MAX_BODY_BYTES = 8 * 1024;
/** appId / appSecret 长度上限（服务端校验，客户端校验只是体验）。 */
const MAX_APP_ID_LENGTH = 128;
const MAX_APP_SECRET_LENGTH = 256;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
/** state 响应允许回显的字段白名单（appSecret 等永远不在其中）。 */
const STATE_FIELDS = ['phase', 'appId', 'url', 'qrSvg', 'reason', 'issuedAt'];

function errText(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

function log(runtime, level, ...args) {
  try {
    const logger = runtime && runtime.logger;
    if (logger && typeof logger[level] === 'function') logger[level](...args);
  } catch {
    /* 日志失败不能影响请求处理 */
  }
}

/** 构造带 HTTP 状态码的错误；handler 外层兜底会转成 {ok:false,error}。 */
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/** 统一的 JSON 响应（已写头/已结束则静默跳过，避免重复写）。 */
function sendJson(res, status, body, headers) {
  if (!res || typeof res.writeHead !== 'function') return;
  try {
    if (res.writableEnded || res.headersSent) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, { ...JSON_HEADERS, ...(headers || {}) });
    res.end(payload);
  } catch (error) {
    log(null, 'warn', '[qqbot-buddy] 写入绑定接口响应失败：' + errText(error));
    try {
      if (typeof res.destroy === 'function') res.destroy();
    } catch {
      /* ignore */
    }
  }
}

/** 最小 CSRF 防护：带 Origin 的请求必须与 Host 同源（同源 fetch / Desktop IPC 无 Origin 放行）。 */
function trusted(req) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (origin === undefined || origin === null || origin === '') return true;
  const host = req.headers ? req.headers.host : undefined;
  try {
    return new URL(String(origin)).host === host;
  } catch {
    return false;
  }
}

function methodOf(req) {
  const method = req && typeof req.method === 'string' ? req.method : 'GET';
  return method.toUpperCase();
}

/** 读取并解析 JSON 请求体（上限 8KB；空 body 视为 {}）。 */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function') {
      resolve({});
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      // 不 destroy：否则 handler 来不及写出 {ok:false,error}；后续 data 事件由 settled 丢弃
      try {
        if (typeof req.resume === 'function') req.resume();
      } catch {
        /* ignore */
      }
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      let buffer;
      try {
        buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      } catch {
        fail(httpError(400, '请求体编码无效'));
        return;
      }
      size += buffer.length;
      if (size > limit) {
        fail(httpError(413, '请求体超过 ' + limit + ' 字节上限'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', (error) => fail(httpError(400, '读取请求体失败：' + errText(error))));
  });
}

/** 方法校验：不匹配返回 405（带 Allow 头）。 */
function requireMethod(req, res, allowed) {
  const method = methodOf(req);
  const normalized = method === 'HEAD' ? 'GET' : method;
  if (allowed.includes(normalized)) return true;
  try {
    if (typeof req.resume === 'function') req.resume();
  } catch {
    /* ignore */
  }
  sendJson(
    res,
    405,
    { ok: false, error: '不支持的请求方法：' + method },
    { allow: allowed.join(', ') },
  );
  return false;
}

/** 请求体 → 凭据（含可读错误，不打印内容）。 */
function parseCredentials(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: '请求体必须是 JSON 对象' };
  }
  const appId = typeof body.appId === 'string' ? body.appId.trim() : '';
  const appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : '';
  if (appId === '') return { error: 'appId 不能为空' };
  if (appSecret === '') return { error: 'appSecret 不能为空' };
  if (appId.length > MAX_APP_ID_LENGTH) {
    return { error: 'appId 过长（最多 ' + MAX_APP_ID_LENGTH + ' 字符）' };
  }
  if (appSecret.length > MAX_APP_SECRET_LENGTH) {
    return { error: 'appSecret 过长（最多 ' + MAX_APP_SECRET_LENGTH + ' 字符）' };
  }
  return { appId, appSecret };
}

/** 从 binding 产物中只挑白名单字段，保证 appSecret 永不外泄。 */
function projectState(state) {
  const source = state !== null && typeof state === 'object' ? state : {};
  const out = {};
  for (const key of STATE_FIELDS) {
    const value = source[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  if (typeof out.phase !== 'string' || out.phase === '') out.phase = 'starting';
  // 防御：万一上游把 secret 塞进 appId 字段也不回显
  if (out.appId !== undefined && typeof out.appId !== 'string') delete out.appId;
  return out;
}

/** 判断 binding 是否具备某方法（null / 半装配实例都当不可用处理）。 */
function hasMethod(binding, name) {
  return binding !== null && typeof binding === 'object' && typeof binding[name] === 'function';
}

// ── handler：GET /bind/state ─────────────────────────────────
async function handleState(req, res, binding) {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  if (!requireMethod(req, res, ['GET'])) return;
  if (binding === null || (!hasMethod(binding, 'wireState') && !hasMethod(binding, 'isBound'))) {
    // 无绑定服务：未绑定态，UI 只需展示手动填写/等待装配
    sendJson(res, 200, { ok: true, phase: 'idle' });
    return;
  }
  let bound = false;
  try {
    bound = hasMethod(binding, 'isBound') ? binding.isBound() === true : false;
  } catch (error) {
    throw httpError(500, '读取绑定状态失败：' + errText(error));
  }
  if (bound) {
    const state = hasMethod(binding, 'wireState') ? binding.wireState() : {};
    const projected = projectState(state);
    sendJson(res, 200, { ok: true, ...projected, phase: 'bound' });
    return;
  }
  const state = hasMethod(binding, 'wireState') ? binding.wireState() : { phase: 'starting' };
  sendJson(res, 200, { ok: true, ...projectState(state) });
}

// ── handler：POST /bind/refresh ──────────────────────────────
async function handleRefresh(req, res, binding) {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  if (!requireMethod(req, res, ['POST'])) return;
  try {
    if (typeof req.resume === 'function') req.resume(); // refresh 无参数，丢弃可能存在的 body
  } catch {
    /* ignore */
  }
  if (!hasMethod(binding, 'refresh')) {
    sendJson(res, 503, { ok: false, error: '扫码绑定服务不可用' });
    return;
  }
  try {
    binding.refresh();
  } catch (error) {
    throw httpError(500, '刷新二维码失败：' + errText(error));
  }
  // 新二维码异步生成，由 state 轮询收敛
  sendJson(res, 200, { ok: true });
}

// ── handler：POST /bind/manual ───────────────────────────────
async function handleManual(req, res, binding) {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  if (!requireMethod(req, res, ['POST'])) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = Number.isInteger(error && error.status) ? error.status : 400;
    sendJson(res, status, { ok: false, error: errText(error) });
    return;
  }
  const parsed = parseCredentials(body);
  if (parsed.error !== undefined) {
    sendJson(res, 400, { ok: false, error: parsed.error });
    return;
  }
  if (!hasMethod(binding, 'manual')) {
    sendJson(res, 503, { ok: false, error: '扫码绑定服务不可用' });
    return;
  }

  let result;
  try {
    result = await binding.manual(parsed.appId, parsed.appSecret);
  } catch (error) {
    throw httpError(500, '保存凭据失败：' + errText(error));
  }
  if (result !== null && typeof result === 'object' && result.ok === true) {
    sendJson(res, 200, {
      ok: true,
      message: typeof result.message === 'string' && result.message !== '' ? result.message : '凭据已保存',
    });
    return;
  }
  const message =
    result !== null && typeof result === 'object' && typeof result.error === 'string' && result.error !== ''
      ? result.error
      : '保存凭据失败';
  const status =
    result !== null && typeof result === 'object' && Number.isInteger(result.status)
      ? result.status
      : /不能为空|过长|不合法|必须/.test(message)
        ? 400
        : 500;
  sendJson(res, status, { ok: false, error: message });
}

// ── handler：POST /bind/unbind ──────────────────────────────
async function handleUnbind(req, res, binding) {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  if (!requireMethod(req, res, ['POST'])) return;
  try {
    if (typeof req.resume === 'function') req.resume(); // unbind 无参数
  } catch {
    /* ignore */
  }
  if (!hasMethod(binding, 'unbind')) {
    sendJson(res, 503, { ok: false, error: '扫码绑定服务不可用' });
    return;
  }

  let result;
  try {
    result = await binding.unbind();
  } catch (error) {
    throw httpError(500, '解绑失败：' + errText(error));
  }
  if (result !== null && typeof result === 'object' && result.ok === true) {
    sendJson(res, 200, {
      ok: true,
      message:
        typeof result.message === 'string' && result.message !== ''
          ? result.message
          : '已解绑，正在重新生成绑定二维码',
    });
    return;
  }
  const message =
    result !== null && typeof result === 'object' && typeof result.error === 'string' && result.error !== ''
      ? result.error
      : '解绑失败';
  sendJson(res, 500, { ok: false, error: message });
}

/** 路由表：path → handler。 */
const ROUTES = [
  { name: 'bind-state', path: BIND_STATE_PATH, handler: handleState },
  { name: 'bind-refresh', path: BIND_REFRESH_PATH, handler: handleRefresh },
  { name: 'bind-manual', path: BIND_MANUAL_PATH, handler: handleManual },
  { name: 'bind-unbind', path: BIND_UNBIND_PATH, handler: handleUnbind },
];

/**
 * 按 ?botId= 取该机器人的绑定服务（多机器人）；取不到时回退到默认 binding。
 * 旧单机器人部署（runtime 没有 __host）行为不变。
 */
function bindingFor(runtime, req) {
  try {
    const host = runtime && (runtime.__host || runtime.host);
    if (!host || typeof host.runtimeFor !== 'function') return null;
    const url = new URL(String((req && req.url) || '/'), 'http://127.0.0.1');
    const botId = url.searchParams.get('botId') || '';
    if (botId === '') return null;
    const bot = host.runtimeFor(botId);
    return bot && bot.binding ? bot.binding : null;
  } catch {
    return null;
  }
}

/**
 * 注册扫码绑定路由。
 *
 * @param {object} ctx cordis 上下文（需要 ctx.get('webServer') 或 ctx.inject）
 * @param {{binding?: object|null, runtime?: object}} [options]
 * @returns {() => void} 聚合 dispose（幂等）
 */
export function registerBindRoutes(ctx, options = {}) {
  const opts = options !== null && typeof options === 'object' ? options : {};
  const binding = opts.binding !== null && typeof opts.binding === 'object' ? opts.binding : null;
  const runtime = opts.runtime !== null && typeof opts.runtime === 'object' ? opts.runtime : {};

  const disposers = [];
  let registered = false;
  let disposed = false;

  const makeHandler = (route) => {
    return async (req, res) => {
      try {
        const scopedBinding = bindingFor(runtime, req) || binding;
        await route.handler(req, res, scopedBinding, runtime);
      } catch (error) {
        const status = Number.isInteger(error && error.status) ? error.status : 500;
        const message = errText(error) || '服务器内部错误';
        if (status >= 500) {
          log(runtime, 'error', '[qqbot-buddy] bind/' + route.name + ' 处理失败：' + message);
        } else {
          log(runtime, 'debug', '[qqbot-buddy] bind/' + route.name + ' 请求被拒绝（' + status + '）：' + message);
        }
        sendJson(res, status, { ok: false, error: message });
      }
    };
  };

  const registerOn = (webServer) => {
    if (disposed || registered) return false;
    if (!webServer || typeof webServer.register !== 'function') return false;
    registered = true;
    for (const route of ROUTES) {
      try {
        const dispose = webServer.register({
          kind: 'exact',
          path: route.path,
          handler: makeHandler(route),
        });
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        log(runtime, 'warn', '[qqbot-buddy] 注册绑定路由 ' + route.path + ' 失败：' + errText(error));
      }
    }
    log(runtime, 'info', '[qqbot-buddy] 扫码绑定路由已就绪：' + BIND_STATE_PATH);
    return true;
  };

  const getWebServer = () => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    } catch {
      return undefined;
    }
  };

  if (!registerOn(getWebServer())) {
    // webServer 可能尚未就绪：等注入，避免直接抛错打挂插件
    if (ctx && typeof ctx.inject === 'function') {
      try {
        const off = ctx.inject(['webServer'], (scoped) => {
          try {
            registerOn(scoped && scoped.webServer);
          } catch (error) {
            log(runtime, 'warn', '[qqbot-buddy] webServer 注入回调注册绑定路由失败：' + errText(error));
          }
        });
        if (typeof off === 'function') disposers.push(off);
      } catch (error) {
        log(runtime, 'warn', '[qqbot-buddy] 注册 webServer 注入失败（扫码绑定接口不可用）：' + errText(error));
      }
    } else {
      log(runtime, 'warn', '[qqbot-buddy] webServer 不可用，扫码绑定接口未注册');
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      try {
        dispose();
      } catch (error) {
        log(runtime, 'warn', '[qqbot-buddy] 释放绑定路由失败：' + errText(error));
      }
    }
  };
}

export default { registerBindRoutes };
