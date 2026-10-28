/** 统一日志适配：把 host logger 包成带前缀、带 debug 开关的小对象。 */
export function createLogger(base, tag, options = {}) {
  const debugEnabled = options.debug === true;
  const emit = (level, args) => {
    const sink = base && typeof base[level] === 'function' ? base : console;
    try {
      sink[level](`[${tag}]`, ...args);
    } catch {
      /* logger 失败不能打挂业务 */
    }
  };
  return {
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    debug: (...args) => { if (debugEnabled) emit('debug', args); },
    child: (suffix) => createLogger(base, tag + ':' + suffix, options),
  };
}
