/**
 * lib/objects —— 点号路径读写（设置项 key 形如 reply.mode）。
 * 全部返回新对象，避免原地修改 React state。
 */

/** 读取点号路径；缺失返回 fallback。 */
export function getPath(source: unknown, path: string, fallback?: unknown): unknown {
  const parts = path.split('.');
  let current: unknown = source;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return fallback;
    current = (current as Record<string, unknown>)[part];
  }
  return current === undefined ? fallback : current;
}

/** 写入点号路径，返回新对象。 */
export function setPath<T extends Record<string, unknown>>(source: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const base: Record<string, unknown> = { ...(source || {}) };
  if (rest.length === 0) {
    base[head] = value;
  } else {
    const child = base[head];
    const childObj = child !== null && typeof child === 'object' && !Array.isArray(child)
      ? (child as Record<string, unknown>)
      : {};
    base[head] = setPath(childObj, rest.join('.'), value);
  }
  return base as T;
}

/** 由“脏字段”记录构造嵌套 patch：{ 'persona.extraPrompt': 'x' } → { persona: { extraPrompt: 'x' } }。 */
export function pathsToPatch(dirty: Record<string, unknown>): Record<string, unknown> {
  let patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dirty)) {
    patch = setPath(patch, key, value);
  }
  return patch;
}

/** 结构安全克隆（用于把表单初值隔离开）。 */
export function cloneValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch { /* 回退 JSON */ }
  }
  try { return JSON.parse(JSON.stringify(value)) as T; } catch { return value; }
}
