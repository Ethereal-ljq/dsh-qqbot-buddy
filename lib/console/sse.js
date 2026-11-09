/**
 * console/sse —— /api/events 的 SSE 广播中心。
 *
 * 职责：
 * - 订阅 deps.events（EventEmitter）：bot/status、log、job/progress 三类事件转发给浏览器；
 * - 每个连接 25s 发一次注释心跳（: ping），中间代理不会因空闲掐断；
 * - 客户端断开/服务停止时清理定时器与事件监听，避免泄漏（测试覆盖 listener 数回落）。
 *
 * 事件总线约定：deps.events 是 EventEmitter 时按固定事件名订阅；
 * 若提供 onAny(fn) 自定义总线则用 onAny/offAny 订阅全部事件。
 */
import { HttpError } from './api/helpers.js';

/** 默认转发的宿主事件名（DESIGN-v2 §3：bot/status、log、job/progress）。 */
export const DEFAULT_EVENT_NAMES = ['bot/status', 'log', 'job/progress'];
/** 默认心跳间隔 25s。 */
export const DEFAULT_HEARTBEAT_MS = 25000;

/**
 * @param {object} options
 * @param {import('node:events').EventEmitter} [options.events] 宿主事件总线
 * @param {{debug?:Function,info?:Function,warn?:Function,error?:Function}} [options.logger]
 * @param {number} [options.heartbeatMs]
 * @param {string[]} [options.eventNames]
 * @param {string} [options.version] 握手 hello 里带的版本
 */
export function createSseHub({
  events = null,
  logger = null,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  eventNames = DEFAULT_EVENT_NAMES,
  version = '',
} = {}) {
  /** @type {Set<{res: import('node:http').ServerResponse, timer: any, closed: boolean, requestId: string}>} */
  const clients = new Set();
  const unsubscribers = [];
  let closed = false;
  let seq = 0;

  function log(level, message, error) {
    try { logger?.[level]?.(message, error); } catch { /* ignore */ }
  }

  function safeJson(payload) {
    try { return JSON.stringify(payload === undefined ? null : payload); } catch { return '"[unserializable]"'; }
  }

  function sendFrame(client, frame) {
    if (client.closed) return;
    try {
      client.res.write(frame);
    } catch {
      removeClient(client, 'write failed');
    }
  }

  /** 向所有已连接浏览器广播一个命名事件。 */
  function broadcast(name, payload) {
    if (closed || clients.size === 0) return;
    seq += 1;
    const frame = 'event: ' + name + '\ndata: ' + safeJson(payload) + '\nid: ' + seq + '\n\n';
    for (const client of [...clients]) sendFrame(client, frame);
  }

  function removeClient(client, reason) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    if (client.timer !== null) {
      clearInterval(client.timer);
      client.timer = null;
    }
    try { client.res.end(); } catch { /* 连接可能已断 */ }
    log('debug', '[console] SSE 客户端断开（' + (reason || 'closed') + '），剩余 ' + clients.size);
  }

  function subscribeEvents() {
    if (!events) return;
    try {
      if (typeof events.onAny === 'function') {
        const handler = (name, payload) => {
          if (typeof name === 'string' && name !== '') broadcast(name, payload);
        };
        const off = events.onAny(handler);
        unsubscribers.push(makeUnsubscribe(off, () => events.offAny?.(handler)));
        return;
      }
      if (typeof events.on !== 'function') return;
      for (const name of eventNames) {
        const handler = (payload) => broadcast(name, payload);
        // 兼容两类总线：EventEmitter（on 返回 this，需 off/removeListener 移除）
        // 与 core/events 的极简总线（on 直接返回取消函数）
        const off = events.on(name, handler);
        unsubscribers.push(makeUnsubscribe(off, () => {
          if (typeof events.off === 'function') events.off(name, handler);
          else if (typeof events.removeListener === 'function') events.removeListener(name, handler);
        }));
      }
    } catch (err) {
      log('warn', '[console] 订阅事件总线失败：' + (err?.message || err));
    }
  }

  /** 统一取消订阅：优先用 on/onAny 返回的取消函数，否则调用 fallback。 */
  function makeUnsubscribe(returned, fallback) {
    return () => {
      try {
        if (typeof returned === 'function') returned();
        else fallback();
      } catch { /* ignore */ }
    };
  }

  function unsubscribeEvents() {
    while (unsubscribers.length > 0) {
      const fn = unsubscribers.pop();
      try { fn(); } catch { /* ignore */ }
    }
  }

  /**
   * 处理一个 SSE 连接：写好响应头后连接保持打开，返回值交给 server 跳过 JSON 响应。
   */
  function handle(req, res, { requestId = '' } = {}) {
    if (closed) throw new HttpError(503, 'console_stopping', '控制台正在停止');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try { res.flushHeaders?.(); } catch { /* ignore */ }

    const client = { res, requestId, timer: null, closed: false };
    clients.add(client);
    // SSE 是长连接：响应 'close' 即浏览器断开（不要监听 req close，GET 请求体早已结束）。
    res.once?.('close', () => removeClient(client, 'client closed'));
    res.once?.('error', () => removeClient(client, 'response error'));

    // 握手：浏览器重连间隔 + hello（前端据此判断连通/版本）。
    sendFrame(client, 'retry: 3000\n\n');
    sendFrame(client, 'event: hello\ndata: ' + safeJson({ at: Date.now(), version, requestId }) + '\n\n');

    client.timer = setInterval(
      () => sendFrame(client, ': ping ' + Date.now() + '\n\n'),
      Math.max(1000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS),
    );
    if (typeof client.timer.unref === 'function') client.timer.unref();

    log('debug', '[console] SSE 客户端接入，当前 ' + clients.size);
  }

  /** 停服：断开全部连接并移除事件监听。 */
  function closeAll() {
    closed = true;
    unsubscribeEvents();
    for (const client of [...clients]) removeClient(client, 'server stopping');
  }

  function clientCount() {
    return clients.size;
  }

  subscribeEvents();

  return {
    handle,
    closeAll,
    broadcast,
    clientCount,
    get closed() { return closed; },
  };
}
