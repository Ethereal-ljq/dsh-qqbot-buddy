/**
 * test/console-sse —— SSE hub 单测：订阅/广播/断连清理/心跳/自定义总线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createSseHub, DEFAULT_EVENT_NAMES } from '../lib/console/sse.js';

/** 极简 ServerResponse 替身。 */
function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.ended = false;
  res.headers = null;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.flushHeaders = () => {};
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = () => { res.ended = true; res.emit('close'); };
  return res;
}

function text(res) {
  return res.chunks.join('');
}

test('订阅事件并转发给所有客户端，断连后清理监听', () => {
  const events = new EventEmitter();
  const baseline = events.listenerCount('log');
  const hub = createSseHub({ events });
  assert.equal(events.listenerCount('log'), baseline + 1, 'hub 创建时应订阅事件');

  const res1 = fakeRes();
  const res2 = fakeRes();
  hub.handle({}, res1, { requestId: 'r1' });
  hub.handle({}, res2, { requestId: 'r2' });
  assert.equal(hub.clientCount(), 2);
  assert.match(text(res1), /event: hello/);
  assert.match(text(res2), /event: hello/);
  assert.equal(res1.status, 200);
  assert.match(res1.headers['Content-Type'], /text\/event-stream/);

  events.emit('log', { level: 'info', message: '你好' });
  assert.match(text(res1), /event: log/);
  assert.match(text(res2), /event: log/);
  assert.match(text(res1), /data: \{"level":"info","message":"你好"\}/);

  res1.emit('close');
  assert.equal(hub.clientCount(), 1);
  res2.emit('close');
  assert.equal(hub.clientCount(), 0);

  hub.closeAll();
  assert.equal(events.listenerCount('log'), baseline, 'closeAll 后不应残留监听');
  assert.equal(hub.closed, true);
  assert.throws(() => hub.handle({}, fakeRes(), {}), /停止/);
});

test('开放事件名之外的事件不转发', () => {
  const events = new EventEmitter();
  const hub = createSseHub({ events });
  const res = fakeRes();
  hub.handle({}, res, {});
  events.emit('unrelated', { a: 1 });
  assert.ok(!text(res).includes('event: unrelated'));
  events.emit(DEFAULT_EVENT_NAMES[0], { status: 'online' });
  assert.match(text(res), new RegExp('event: ' + DEFAULT_EVENT_NAMES[0].replace('/', '\\/')));
  hub.closeAll();
});

test('心跳注释帧', async () => {
  const events = new EventEmitter();
  const hub = createSseHub({ events, heartbeatMs: 1000 });
  const res = fakeRes();
  hub.handle({}, res, {});
  await new Promise((resolve) => setTimeout(resolve, 1120));
  assert.match(text(res), /: ping \d+/);
  hub.closeAll();
  assert.equal(hub.clientCount(), 0);
});

test('支持 onAny 自定义事件总线', () => {
  const handlers = new Set();
  const bus = {
    onAny(fn) { handlers.add(fn); },
    offAny(fn) { handlers.delete(fn); },
  };
  const hub = createSseHub({ events: bus });
  assert.equal(handlers.size, 1);
  const res = fakeRes();
  hub.handle({}, res, {});
  for (const handler of handlers) handler('bot/status', { botId: 'b1', status: 'online' });
  assert.match(text(res), /event: bot\/status/);
  assert.match(text(res), /"botId":"b1"/);
  hub.closeAll();
  assert.equal(handlers.size, 0, 'closeAll 应取消 onAny 订阅');
});

test('兼容 core/events 极简总线（on 返回取消函数）', async () => {
  const { createEvents } = await import('../lib/core/events.js');
  const bus = createEvents();
  const hub = createSseHub({ events: bus });
  const res = fakeRes();
  hub.handle({}, res, {});
  bus.emit('log', { message: '来自事件总线' });
  assert.match(text(res), /event: log/);
  assert.match(text(res), /来自事件总线/);
  bus.emit('job/progress', { done: 1, total: 2 });
  assert.match(text(res), /event: job\/progress/);
  hub.closeAll();
  assert.equal(hub.clientCount(), 0);
});

test('closeAll 调用 on 返回的取消函数（无 off 方法的总线也不泄漏）', () => {
  const removed = [];
  const bus = {
    on(type) {
      return () => { removed.push(type); };
    },
  };
  const hub = createSseHub({ events: bus });
  assert.equal(removed.length, 0);
  hub.handle({}, fakeRes(), {});
  hub.closeAll();
  assert.deepEqual(removed.slice().sort(), [...DEFAULT_EVENT_NAMES].sort());
});
