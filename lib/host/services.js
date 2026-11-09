/**
 * host/services —— 宿主服务访问的唯一收口（只有 host/ 允许 import @deepseek-ai/*）。
 */

/** 取宿主服务；不存在或抛错返回 undefined。 */
export function getService(ctx, serviceName) {
  if (!ctx || typeof serviceName !== 'string' || serviceName === '') return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(serviceName);
      if (value !== undefined) return value;
    }
    return ctx[serviceName];
  } catch {
    return undefined;
  }
}

/** 取宿主服务；不存在直接抛错（用于创建 agent 这种硬依赖）。 */
export function requireService(ctx, serviceName) {
  const value = getService(ctx, serviceName);
  if (value === undefined) throw new Error('宿主服务不可用: ' + serviceName);
  return value;
}

/** 安全读属性（部分 cordis 服务是 proxy，直接读可能抛）。 */
export function safeProp(target, key, fallback) {
  try {
    const value = target && target[key];
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 错误转字符串。 */
export function errText(err) {
  return err instanceof Error ? err.message : String(err);
}
