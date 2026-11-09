/**
 * core/events —— 极简进程内事件总线（控制台 SSE、状态推送用）。
 * 监听器抛错只记录，不影响发布方。
 */
export function createEvents({ logger } = {}) {
  const listeners = new Map();
  return {
    on(type, handler) {
      if (typeof handler !== 'function') return () => {};
      const set = listeners.get(type) || new Set();
      set.add(handler);
      listeners.set(type, set);
      if (type !== '*') {
        const star = listeners.get('*') || new Set();
        // 通配监听由 subscribers('*') 单独处理，这里不复制
      }
      return () => set.delete(handler);
    },
    emit(type, payload) {
      for (const handler of [...(listeners.get(type) || [])]) {
        try { handler(payload); } catch (err) { logger?.warn?.('事件监听失败 ' + type + ': ' + err.message); }
      }
      for (const handler of [...(listeners.get('*') || [])]) {
        try { handler({ type, payload }); } catch (err) { logger?.warn?.('通配监听失败: ' + err.message); }
      }
    },
    clear() { listeners.clear(); },
  };
}
