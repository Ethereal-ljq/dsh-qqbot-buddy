/**
 * console/api/auth —— 登录 / 注销 / 当前会话（DESIGN-v2 §3）。
 *
 * 登录：POST /api/auth/login {token} → 200 {ok,expiresAt} + Set-Cookie；
 *       失败 401；失败次数超限 429（Retry-After）；token 只走 scrypt 校验。
 * 注销：POST /api/auth/logout（需 CSRF）→ 清 cookie 并删库中会话。
 * 会话：GET /api/auth/session（需登录）→ {authenticated,...}。
 */
import { HttpError, badRequest, audit } from './helpers.js';
import { sessionCookie, clearSessionCookie } from '../auth.js';

/** 从请求体取 token 并做基础校验。 */
function readLoginToken(body) {
  const token = typeof body?.token === 'string' ? body.token.trim() : '';
  if (token === '') throw new HttpError(400, 'invalid_token', '缺少 token');
  if (token.length > 512) throw new HttpError(400, 'invalid_token', 'token 格式非法');
  return token;
}

function login(ctx) {
  const { auth, res, req, deps, ip } = ctx;
  const token = readLoginToken(ctx.body);

  // 先看限速，避免被用来暴力猜 token；成功后清零。
  const limit = auth.checkRateLimit(ip);
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    throw new HttpError(429, 'rate_limited', '登录失败次数过多，请 ' + retryAfter + ' 秒后再试', { retryAfter });
  }
  if (!auth.verifyToken(token)) {
    auth.recordFailure(ip);
    audit(deps, { kind: 'auth.login.fail', detail: 'ip=' + ip });
    throw new HttpError(401, 'invalid_token', 'token 无效');
  }
  auth.clearFailures(ip);
  const session = auth.createSession({ ip, userAgent: req.headers['user-agent'] || '' });
  res.setHeader('Set-Cookie', sessionCookie(session.sid, {
    maxAgeMs: Math.max(0, session.expiresAt - session.createdAt),
  }));
  audit(deps, { kind: 'auth.login', detail: 'ip=' + ip });
  return { ok: true, expiresAt: session.expiresAt };
}

function logout(ctx) {
  const { auth, sid, res, deps, ip } = ctx;
  if (sid) auth.destroySession(sid);
  res.setHeader('Set-Cookie', clearSessionCookie());
  audit(deps, { kind: 'auth.logout', detail: 'ip=' + ip });
  return { ok: true };
}

function sessionInfo(ctx) {
  return { authenticated: true, ...ctx.session };
}

export const routes = [
  { method: 'POST', path: '/api/auth/login', auth: false, csrf: false, handler: login },
  { method: 'POST', path: '/api/auth/logout', handler: logout },
  { method: 'GET', path: '/api/auth/session', handler: sessionInfo },
];
