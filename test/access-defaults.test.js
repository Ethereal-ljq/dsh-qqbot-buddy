/**
 * 访问控制默认值 —— 聊天桥接必须「没配置就拒绝」。
 *
 * 背景：维护者复验时指出 c2cMode / groupMode 默认 open，等于任何能给机器人发私聊、
 * 或在群里 @ 它的人都能驱动本机 agent。这里锁住三层默认：
 *   1) 插件 schema 的默认值；
 *   2) 中间件在缺配置时的回退值；
 *   3) 被拦截时是否把 openid 打给用户（否则他不知道该把什么填进白名单）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigSchema } from '../lib/config-schema.js';
import { setupMiddlewares } from '../lib/qq/middleware.js';

const DEFAULT_ACCESS = { c2cMode: 'allowlist', c2cAllow: [], groupMode: 'allowlist', groupAllow: [] };

function createFakeLogger() {
  const entries = [];
  const make = (level) => (...args) => { entries.push({ level, args }); };
  return {
    entries,
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
    child() { return this; },
  };
}

/** 假 SDK：任何 api.X(opts) 都记下 options 并返回一个 no-op 中间件。 */
function createFakeSdk(captured) {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key !== 'string') return undefined;
      return (options) => {
        captured[key] = options;
        return async (_ctx, next) => { if (typeof next === 'function') await next(); };
      };
    },
  });
}

function build(captured, config = {}) {
  const logger = createFakeLogger();
  const bot = { use() { return this; } };
  const sdk = createFakeSdk(captured);
  setupMiddlewares(bot, {
    config,
    settings: { reply: { mode: 'adaptive' } },
    logger,
    gateState: {},
    stats: {},
    sdk,
    commandMiddleware: null,
    attachmentMiddleware: null,
    replyProbe: null,
  });
  return logger;
}

test('schema 默认：私聊与群聊都是 allowlist，白名单为空', () => {
  const resolved = ConfigSchema({});
  assert.deepEqual(resolved.access, DEFAULT_ACCESS);
});

test('schema 显式配置优先：open / disabled 原样保留', () => {
  const resolved = ConfigSchema({ access: { c2cMode: 'open', groupMode: 'disabled', groupAllow: ['g1'] } });
  assert.equal(resolved.access.c2cMode, 'open');
  assert.equal(resolved.access.groupMode, 'disabled');
  assert.deepEqual(resolved.access.groupAllow, ['g1']);
});

test('中间件缺配置时回退到拒绝，而不是 open', () => {
  const captured = {};
  build(captured, {});
  assert.equal(captured.accessPolicy.c2c.mode, 'allowlist');
  assert.deepEqual(captured.accessPolicy.c2c.allow, []);
  assert.equal(captured.accessPolicy.group.mode, 'allowlist');
  assert.deepEqual(captured.accessPolicy.group.allow, []);
});

test('open 只在显式配置时生效，并被翻译成 allow:*', () => {
  const captured = {};
  const logger = build(captured, { access: { c2cMode: 'open', groupMode: 'open' } });
  assert.equal(captured.accessPolicy.c2c.mode, 'open');
  assert.deepEqual(captured.accessPolicy.c2c.allow, ['*']);
  assert.ok(logger.entries.some((e) => e.level === 'warn' && e.args.join(' ').includes('为 open')));
});

test('被拦截时打印 openid，同一 openid 只提示一次', () => {
  const captured = {};
  const logger = build(captured, {});
  const onBlock = captured.accessPolicy.onBlock;

  onBlock({ message: { kind: 'c2c', senderId: 'openid-A' } }, 'not in allowlist');
  onBlock({ message: { kind: 'c2c', senderId: 'openid-A' } }, 'not in allowlist');
  const hits = logger.entries.filter((e) => String(e.args.join(' ')).includes('openid=openid-A'));
  assert.equal(hits.length, 1, '同一个 openid 不应重复刷屏');
  assert.ok(hits[0].args.join(' ').includes('access.c2cAllow'));

  onBlock({ message: { kind: 'group', groupOpenid: 'group-B' } }, 'not in allowlist');
  const groupHits = logger.entries.filter((e) => String(e.args.join(' ')).includes('openid=group-B'));
  assert.equal(groupHits.length, 1);
  assert.ok(groupHits[0].args.join(' ').includes('access.groupAllow'));
});
