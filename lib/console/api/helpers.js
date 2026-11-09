/**
 * console/api/helpers —— HTTP 错误、响应整形、配置/服务降级的共享工具。
 *
 * 约定（DESIGN-v2 §3）：2xx 返回裸数据；错误统一 {error:{code,message}}。
 * 配置层（core/config）与服务层（kb/memory/toolsDiscover/runtime）都由 deps 注入，
 * 未装配时降级为空态或 501，而不是 import 不存在的模块。
 */
import { getPath, setPath, deepMerge } from '../../core/config/schema.js';

/** 携带 HTTP 状态与错误 code 的异常；server 统一转成 {error:{code,message}}。 */
export class HttpError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'HttpError';
    this.status = Number(status) || 500;
    this.code = String(code || 'internal_error');
    this.details = details;
  }
}

export const badRequest = (message, code = 'invalid_request') => new HttpError(400, code, message);
export const notFound = (message) => new HttpError(404, 'not_found', message);
export const notImplemented = (message) => new HttpError(501, 'not_implemented', message);
export const notReady = (message) => new HttpError(501, 'not_ready', message);

/** 是否普通对象（非 null/数组）。 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 宽容布尔（true/false/1/0/'true'/'false'）。 */
export function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

/** 整数解析 + 边界裁剪。 */
export function asInt(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

/** 从 URLSearchParams 取整数。 */
export function queryInt(query, name, fallback, options) {
  return asInt(query?.get?.(name), fallback, options);
}

/** 从 URLSearchParams 取非空字符串（空串归 null）。 */
export function queryString(query, name) {
  const value = query?.get?.(name);
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 同步服务调用 → 把校验类异常转成 HttpError（404/400）。
 * 其他异常原样抛出，由 server 记日志并返回 500。
 */
export function guard(fn) {
  try {
    return fn();
  } catch (err) {
    throw mapServiceError(err);
  }
}

/** guard 的异步版本。 */
export async function guardAsync(fn) {
  try {
    return await fn();
  } catch (err) {
    throw mapServiceError(err);
  }
}

/** core/config 的 Error → HttpError 映射（不吞未知错误）。 */
export function mapServiceError(err) {
  if (err instanceof HttpError) return err;
  const message = String(err?.message || err || '未知错误');
  if (message.includes('不存在')) return new HttpError(404, 'not_found', message);
  if (/(不能为空|非法|必须|至少|无法|需要|不能)/.test(message)) {
    return new HttpError(400, 'invalid_request', message);
  }
  return err;
}

/** 取配置服务；未装配时抛 501。 */
export function requireConfig(deps) {
  const config = deps?.config;
  if (!config || typeof config !== 'object') throw notReady('配置服务未装配（core/config）');
  return config;
}

/** bot 对外视图：脱敏 appSecret（只暴露 hasAppSecret）。 */
export function publicBot(bot) {
  if (!bot || typeof bot !== 'object') return null;
  const secret = typeof bot.appSecret === 'string' ? bot.appSecret : '';
  const hasAppSecret = Boolean(bot.hasAppSecret ?? bot.hasSecret ?? (secret !== ''));
  return {
    id: bot.id,
    name: bot.name,
    appId: bot.appId ?? '',
    appSecret: '',
    hasAppSecret,
    enabled: Boolean(bot.enabled),
    cwd: bot.cwd ?? null,
    createdAt: bot.createdAt ?? null,
    updatedAt: bot.updatedAt ?? null,
  };
}

/**
 * 生效设置（嵌套对象）→ 扁平点号键对象，键与 GET /api/schema 的 items[].key 一致。
 * 只按 schema 项取叶子，json 型设置项保持原对象。
 */
export function flattenSettings(items, settings) {
  const out = {};
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.key !== 'string') continue;
    const value = getPath(settings, item.key, undefined);
    if (value !== undefined) out[item.key] = value;
  }
  return out;
}

/**
 * PUT /api/settings 的入参 → 嵌套 patch。
 * 同时接受三种写法：
 *   { "reply.enabled": false }（扁平点号键）
 *   { reply: { enabled: false } }（嵌套）
 *   { values: {...} }（带外壳）
 * @param {object} input
 * @param {Array<{key:string}>} items schema 项
 */
export function toNestedSettings(input, items) {
  const known = new Set((Array.isArray(items) ? items : []).map((item) => item.key));
  let src = input;
  if (isPlainObject(src) && isPlainObject(src.values) && Object.keys(src).length === 1) src = src.values;
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const [key, value] of Object.entries(src)) {
    if (key.includes('.') || known.has(key)) {
      setPath(out, key, value);
      continue;
    }
    if (isPlainObject(value)) {
      out[key] = deepMerge(isPlainObject(out[key]) ? out[key] : {}, value);
      continue;
    }
    setPath(out, key, value);
  }
  return out;
}

/** 运行状态归一化：deps.runtime 可以是 {online,bots} / {getStatus()}；缺省视为离线。 */
export function runtimeStatus(deps) {
  const service = deps?.runtime;
  let raw = null;
  try {
    if (typeof service?.getStatus === 'function') raw = service.getStatus();
    else if (isPlainObject(service?.status)) raw = service.status;
  } catch {
    raw = null;
  }
  if (!isPlainObject(raw)) raw = {};
  const online = Boolean(raw.online ?? service?.online ?? false);
  const bots = isPlainObject(raw.bots) ? raw.bots : {};
  return { online, bots };
}

/** 写审计（失败不影响主流程）。 */
export function audit(deps, { kind, detail = '', botId = null } = {}) {
  try {
    deps?.config?.audit?.({ botId, kind, detail });
  } catch { /* 审计失败不阻断业务 */ }
}

/** 同步安全调用：异常时返回 fallback（并可选上报）。 */
export function safeCall(fn, fallback = null, onError = null) {
  try {
    return fn();
  } catch (err) {
    try { onError?.(err); } catch { /* ignore */ }
    return fallback;
  }
}

/** 异步安全调用。 */
export async function safeCallAsync(fn, fallback = null, onError = null) {
  try {
    return await fn();
  } catch (err) {
    try { onError?.(err); } catch { /* ignore */ }
    return fallback;
  }
}
