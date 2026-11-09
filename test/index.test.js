import test from 'node:test';
import assert from 'node:assert/strict';

import * as entry from '../lib/index.js';
import { createEvents } from '../lib/core/events.js';

test('插件入口导出契约', () => {
  assert.equal(entry.name, 'qqbot-buddy');
  assert.deepEqual(entry.inject, ['agents']);
  assert.ok(entry.Config);
  assert.equal(typeof entry.apply, 'function');
  assert.match(entry.VERSION, /^\d+\.\d+/);
});

test('事件总线：普通监听/通配监听/解绑', () => {
  const events = createEvents();
  const got = [];
  const off = events.on('bot/status', (payload) => got.push(['status', payload.ok]));
  events.on('*', (envelope) => got.push(['any', envelope.type]));
  events.emit('bot/status', { ok: true });
  assert.deepEqual(got, [['status', true], ['any', 'bot/status']]);
  off();
  events.emit('bot/status', { ok: false });
  assert.equal(got.length, 3);
  assert.deepEqual(got[2], ['any', 'bot/status']);
});

test('事件监听抛错不影响其他监听', () => {
  const events = createEvents();
  let hits = 0;
  events.on('x', () => { throw new Error('boom'); });
  events.on('x', () => { hits += 1; });
  assert.doesNotThrow(() => events.emit('x', 1));
  assert.equal(hits, 1);
});
