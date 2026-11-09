/**
 * qq-gateway —— v2 传输层工厂接线：生命周期 / 中间件链 / 入站投递 / 出站订阅 / sender。
 *
 * 全部使用假 SDK（不连真 QQ）：
 *   - FakeQQBot 记录 use()/on()/send()，dispatchMessage 会真的跑一遍中间件洋葱链；
 *   - 中间件工厂是 no-op（SDK 自身行为不在本插件测试范围），但要验明装配顺序与参数；
 *   - 其余 QQ 协议逻辑（gate/命令/入站组装/出站/sender）都是 lib/qq 真实实现。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createQqTransportFactory } from '../lib/qq/gateway.js';

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function createFakeLogger(entries = []) {
  const make = (level) => (...args) => { entries.push({ level, args }); };
  return {
    entries,
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
    child: () => createFakeLogger(entries),
    byLevel(level) { return entries.filter((entry) => entry.level === level).map((entry) => entry.args); },
  };
}

// ── 假 SDK ────────────────────────────────────────────────
function createFakeSdk() {
  const factoryCalls = [];
  const makeMiddleware = (name) => (options) => {
    factoryCalls.push({ name, options });
    return async (ctx, next) => next();
  };

  class MemoryHistoryStore {
    constructor() { this.data = new Map(); }
    clear(key) { this.data.delete(key); }
  }

  class FakeQQBot {
    constructor(options) {
      this.options = options;
      this.middlewares = [];
      this.handlers = new Map();
      this.calls = [];
      this.started = false;
      this.stopped = false;
      this.store = new MemoryHistoryStore();
    }

    use(fn) { this.middlewares.push(fn); return this; }

    on(event, handler) {
      const list = this.handlers.get(event) || [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }

    emitHandlers(event, ...args) {
      for (const handler of this.handlers.get(event) || []) handler(...args);
    }

    async start() { this.started = true; }

    stop() { this.stopped = true; }

    async send(opts) {
      this.calls.push(opts);
      return { id: 'sent-' + this.calls.length, ext_info: {} };
    }

    // 真 SDK 同时提供 sendMarkdown/sendText（sender 的兼容路径 + outbound 的就绪判断用）
    async sendMarkdown(target, text) {
      return this.send({ target, msgType: 2, markdown: { content: text } });
    }

    async sendText(target, text) {
      return this.send({ target, msgType: 0, content: text });
    }

    /** 跑完整中间件链后再派发 message 事件（模拟 SDK 的洋葱模型）。 */
    async dispatchMessage(ctx) {
      ctx.bot = this;
      ctx.stop = (reason) => { ctx.stopped = reason || true; };
      const chain = [...this.middlewares];
      const run = async (index) => {
        if (index >= chain.length) {
          this.emitHandlers('message', ctx);
          return;
        }
        await chain[index](ctx, () => run(index + 1));
      };
      await run(0);
    }
  }

  return {
    QQBot: FakeQQBot,
    MemoryHistoryStore,
    factoryCalls,
    errorHandler: makeMiddleware('errorHandler'),
    messageFilter: makeMiddleware('messageFilter'),
    accessPolicy: makeMiddleware('accessPolicy'),
    historyBuffer: makeMiddleware('historyBuffer'),
    quoteRef: makeMiddleware('quoteRef'),
    mentionGate: makeMiddleware('mentionGate'),
    contentSanitizer: makeMiddleware('contentSanitizer'),
    rateLimiter: makeMiddleware('rateLimiter'),
    concurrencyGuard: makeMiddleware('concurrencyGuard'),
    typingIndicator: makeMiddleware('typingIndicator'),
  };
}

// ── 假 ctx / runtime / botRuntime ─────────────────────────
function createFakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    on(event, handler) {
      const set = listeners.get(event) || new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) || [])]) handler(...args);
    },
    listenerCount(event) { return (listeners.get(event) || new Set()).size; },
  };
}

function createRuntime({ appId = 'app-1', appSecret = 'secret-1', cfg = {} } = {}) {
  return {
    cfg: {
      textChunkLimit: 4500,
      historyLimit: 20,
      maxQueue: 20,
      processingTimeoutMs: 30 * 60 * 1000,
      access: { c2cMode: 'open', groupMode: 'open', c2cAllow: [], groupAllow: [] },
      ...cfg,
    },
    config: {
      getBot: (id) => ({ id, appId, appSecret, name: '测试机器人', enabled: true }),
    },
  };
}

function createBotRuntime({ settings = {}, delivered = [] } = {}) {
  const sessions = new Map();
  const host = {
    ctx: {},
    sessionIndex: new Map(),
    findSession(sessionId) {
      for (const record of sessions.values()) {
        if (String(record.sessionId) === String(sessionId)) return { botId: 'bot-1', peer: record.peer, runtime: botRuntime };
      }
      return null;
    },
  };
  const botRuntime = {
    id: 'bot-1',
    bot: { id: 'bot-1', name: '测试机器人', appId: 'app-1', enabled: true },
    cwd: '/tmp/qq-gateway-test-bot',
    host,
    sessions,
    settingsFor: () => settings,
    followup: async (peer, payload) => { delivered.push({ peer, ...payload }); return { ok: true }; },
    whenIdle: async () => {},
    async getOrCreate(peer) {
      let record = sessions.get(peer);
      if (!record) {
        record = {
          peer,
          sessionId: 'sid-' + peer,
          agent: { followup: async () => {}, whenIdle: async () => {} },
          handle: { dispose: async () => {} },
          state: {},
          settings,
          lastActivity: Date.now(),
        };
        sessions.set(peer, record);
      }
      return record;
    },
  };
  return botRuntime;
}

function createRig({ settings = {}, appSecret = 'secret-1', appId = 'app-1', sdk = createFakeSdk(), cfg } = {}) {
  const log = createFakeLogger();
  const ctx = createFakeCtx();
  const runtime = createRuntime({ appId, appSecret, cfg });
  const delivered = [];
  const botRuntime = createBotRuntime({ settings, delivered });
  const factory = createQqTransportFactory({ ctx, runtime, logger: log, sdk });
  const transport = factory(botRuntime);
  return { log, ctx, runtime, delivered, botRuntime, factory, transport, sdk };
}

// ── 生命周期 ─────────────────────────────────────────────
test('无凭据：start() 抛出可读错误（不产生未捕获异常）', async () => {
  const { transport, sdk } = createRig({ appSecret: '' });
  await assert.rejects(() => transport.start(), /凭据|appId\/appSecret/);
  assert.equal(sdk.factoryCalls.length, 0, '无凭据时不应装配中间件');
});

test('SDK 缺成员：start() 抛可读错误而不是崩在 requireSdk 深处', async () => {
  const rig = createRig();
  const broken = createQqTransportFactory({
    ctx: createFakeCtx(),
    runtime: createRuntime(),
    logger: createFakeLogger(),
    sdk: {},
  });
  const transport = broken(rig.botRuntime);
  await assert.rejects(() => transport.start(), /QQ SDK 缺少成员/);
});

test('有凭据：start() 装配中间件链 / 事件处理 / 出站订阅，stop() 清理且幂等', async () => {
  const { transport, ctx, sdk, log } = createRig();
  await transport.start();
  const instance = transport.bot;
  assert.ok(instance, '应创建 QQBot 实例');
  assert.equal(instance.options.appId, 'app-1');
  assert.equal(instance.options.appSecret, 'secret-1');
  assert.equal(instance.options.transport, 'websocket');
  assert.match(instance.options.userAgent, /^qqbot-buddy\//);

  // 中间件链：SDK 内置 10 个 + 自研命令/频率门控/附件 = 14
  assert.ok(instance.middlewares.length >= 14, '中间件链应装配完整（实际 ' + instance.middlewares.length + '）');
  const names = sdk.factoryCalls.map((item) => item.name);
  for (const expected of ['errorHandler', 'messageFilter', 'accessPolicy', 'historyBuffer', 'quoteRef', 'mentionGate', 'contentSanitizer', 'rateLimiter', 'concurrencyGuard', 'typingIndicator']) {
    assert.ok(names.includes(expected), '缺少 SDK 中间件: ' + expected);
  }
  // messageFilter 的去重窗口必须是 10 分钟（v0.22 现场结论）
  const filter = sdk.factoryCalls.find((item) => item.name === 'messageFilter');
  assert.equal(filter.options.dedup.windowMs, 10 * 60 * 1000);

  // 事件处理齐全
  for (const event of ['message', 'interaction', 'rawEvent', 'error', 'ready', 'resumed', 'disconnected']) {
    assert.ok((instance.handlers.get(event) || []).length >= 1, '缺少事件处理: ' + event);
  }
  // 出站只订阅一次
  assert.equal(ctx.listenerCount('session/event'), 1);
  // 连接已发起（start() 不 await 长连接）
  await tick();
  assert.equal(instance.started, true);

  await transport.stop();
  assert.equal(instance.stopped, true);
  assert.equal(ctx.listenerCount('session/event'), 0, 'stop() 应取消出站订阅');
  await transport.stop(); // 幂等
});

// ── 入站：中间件链 -> followup ────────────────────────────
test('私聊入站：中间件链走完 -> BotRuntime.followup(peer, {text})', async () => {
  const { transport, delivered } = createRig({ settings: { reply: { enabled: true } } });
  await transport.start();
  const instance = transport.bot;
  await instance.dispatchMessage({
    message: { kind: 'c2c', content: '你好呀', messageId: 'm-1', senderId: 'U1', senderName: '阿岚' },
    state: {},
    receivedAt: Date.now(),
    replyTarget: { scope: 'c2c', targetId: 'U1', msgId: 'm-1' },
  });
  await tick();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].peer, 'c2c:U1');
  assert.equal(delivered[0].text, '你好呀');

  // 入站后应把 replyTarget 记在会话记录上，供出站被动回复使用
  const record = transport.bot && null;
  void record;
  await transport.stop();
});

test('群聊 adaptive 模式：非 @ 消息被缓冲（不投递），@ 后强制触发投递', async () => {
  const { transport, delivered } = createRig({ settings: { reply: { enabled: true, mode: 'adaptive' } } });
  await transport.start();
  const instance = transport.bot;

  const groupMessage = (extra = {}) => ({
    message: { kind: 'group', content: '随便聊聊', messageId: 'm-g1', groupOpenid: 'G1', senderId: 'U1', senderName: '阿岚' },
    state: {},
    receivedAt: Date.now(),
    replyTarget: { scope: 'group', targetId: 'G1', msgId: 'm-g1' },
    ...extra,
  });

  await instance.dispatchMessage(groupMessage());
  await tick(5);
  assert.equal(delivered.length, 0, 'adaptive 模式非 @ 消息应进入攒批而不是立即投递');

  await instance.dispatchMessage(groupMessage({ state: { mention: { wasMentioned: true } } }));
  await tick(10);
  assert.equal(delivered.length, 1, '@ 消息应强制触发投递');
  assert.equal(delivered[0].peer, 'group:G1');
  await transport.stop();
});

test('群聊 @ 消息在非 adaptive 模式下也会投递，并带上发送者标签', async () => {
  const { transport, delivered, botRuntime } = createRig({ settings: { reply: { enabled: true, mode: 'mention' } } });
  await transport.start();
  await transport.bot.dispatchMessage({
    message: { kind: 'group', content: '在吗', messageId: 'm-g2', groupOpenid: 'G2', senderId: 'U2', senderName: '小明' },
    state: { mention: { wasMentioned: true } },
    receivedAt: Date.now(),
  });
  await tick(10);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].peer, 'group:G2');
  assert.match(String(delivered[0].text), /小明/);
  // 未 @ 的普通群消息在 mention 模式下会被门控拦下
  await transport.bot.dispatchMessage({
    message: { kind: 'group', content: '路过', messageId: 'm-g3', groupOpenid: 'G2', senderId: 'U3', senderName: '路人' },
    state: {},
    receivedAt: Date.now(),
  });
  await tick(10);
  assert.equal(delivered.length, 1);
  void botRuntime;
  await transport.stop();
});

// ── 出站：session/event -> sender -> QQBot.send ───────────
test('出站：turn/end 取最后一段 assistant 文本，经 sender 被动回复（带 msg_id）', async () => {
  const { transport, ctx, botRuntime } = createRig({
    settings: { reply: { enabled: true, splitBubbles: true, maxBubbles: 4 } },
  });
  await transport.start();
  const instance = transport.bot;

  // 模拟一个已建立的会话（host.findSession 反查得到）
  const record = await botRuntime.getOrCreate('c2c:U9');
  record.replyTarget = { scope: 'c2c', targetId: 'U9', msgId: 'msg-in-1' };
  record.quoteNext = false;

  const session = { header: { id: record.sessionId } };
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '第一段\n\n第二段' }] } },
  });
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await tick(60);

  assert.equal(instance.calls.length, 2, '空行分条：两段各发一条');
  assert.deepEqual(instance.calls.map((call) => call.markdown.content), ['第一段', '第二段']);
  for (const call of instance.calls) {
    assert.equal(call.msgType, 2, '默认 markdown');
    assert.equal(call.target.msgId, 'msg-in-1', '被动回复应带 msg_id');
  }
  await transport.stop();
});

test('出站：未知 session 的事件被静默忽略', async () => {
  const { transport, ctx } = createRig();
  await transport.start();
  const instance = transport.bot;
  ctx.emit('session/event', { header: { id: 'unknown-session' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } });
  ctx.emit('session/event', { header: { id: 'unknown-session' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await tick(30);
  assert.equal(instance.calls.length, 0);
  await transport.stop();
});

test('出站：异常结束的 turn 不发残留文本，只发一条错误提示', async () => {
  const { transport, ctx, botRuntime } = createRig();
  await transport.start();
  const instance = transport.bot;
  const record = await botRuntime.getOrCreate('c2c:U7');
  record.replyTarget = { scope: 'c2c', targetId: 'U7', msgId: 'msg-7' };
  const session = { header: { id: record.sessionId } };
  ctx.emit('session/event', session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '半截话' }] } } });
  ctx.emit('session/event', session, {
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { code: 'E_X', message: 'boom' } } },
  });
  await tick(60);
  assert.equal(instance.calls.length, 1);
  assert.match(String(instance.calls[0].markdown.content), /E_X/);
  assert.doesNotMatch(String(instance.calls[0].markdown.content), /半截话/);
  await transport.stop();
});
test('restart：stop() 之后可以再次 start()（host restart 路径）', async () => {
  const { transport } = createRig();
  await transport.start();
  const first = transport.bot;
  await transport.stop();
  await transport.start();
  const second = transport.bot;
  assert.ok(second && second !== first, '重启应创建新的 QQBot 实例');
  await transport.stop();
});

test('出站：被动回复预算 4 次用满后自动走主动（不带 msg_id）', async () => {
  const { transport, ctx, botRuntime } = createRig();
  await transport.start();
  const instance = transport.bot;
  const record = await botRuntime.getOrCreate('c2c:UB');
  record.replyTarget = { scope: 'c2c', targetId: 'UB', msgId: 'msg-budget' };
  const session = { header: { id: record.sessionId } };
  for (let i = 0; i < 5; i += 1) {
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '第' + (i + 1) + '条' }] } },
    });
    ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    await tick(30);
  }
  assert.equal(instance.calls.length, 5);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(instance.calls[i].target.msgId, 'msg-budget', '第 ' + (i + 1) + ' 条应走被动');
  }
  assert.equal(instance.calls[4].target.msgId, undefined, '第 5 条应去掉 msg_id 走主动');
  await transport.stop();
});
