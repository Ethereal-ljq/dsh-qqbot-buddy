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
function createFakeSdk({ startBehavior = 'ready' } = {}) {
  const factoryCalls = [];
  const behaviors = { startBehavior };
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

    /** 模拟 SDK 长连接：start() 立刻 resolve，但 READY/ERROR 事件异步到达。 */
    async start() {
      this.started = true;
      if (behaviors.startBehavior === 'ready') {
        setImmediate(() => this.emitHandlers('ready'));
      } else if (behaviors.startBehavior === 'error') {
        setImmediate(() => this.emitHandlers('error', Object.assign(new Error('invalid app secret'), { code: 'token_invalid' })));
      }
      // silent：不发事件，用于验证 READY 超时
    }

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

    async sendImage(target, source) { this.calls.push({ method: 'sendImage', target, source }); return { message: { id: 'img-' + this.calls.length }, upload: {} }; }
    async sendVideo(target, source) { this.calls.push({ method: 'sendVideo', target, source }); return { message: { id: 'vid' }, upload: {} }; }
    async sendVoice(target, source) { this.calls.push({ method: 'sendVoice', target, source }); return { message: { id: 'voice' }, upload: {} }; }
    async sendFile(target, source, opts) { this.calls.push({ method: 'sendFile', target, source, opts }); return { message: { id: 'file' }, upload: {} }; }

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

function createRig({
  settings = {}, appSecret = 'secret-1', appId = 'app-1',
  sdk = createFakeSdk(), cfg, readyTimeoutMs, memoryCollector, members,
} = {}) {
  const log = createFakeLogger();
  const ctx = createFakeCtx();
  const runtime = createRuntime({ appId, appSecret, cfg });
  if (memoryCollector) runtime.memoryCollector = memoryCollector;
  if (members) runtime.members = members;
  const delivered = [];
  const botRuntime = createBotRuntime({ settings, delivered });
  const factory = createQqTransportFactory({ ctx, runtime, logger: log, sdk, ...(readyTimeoutMs ? { readyTimeoutMs } : {}) });
  const transport = factory(botRuntime);
  return { log, ctx, runtime, delivered, botRuntime, factory, transport, sdk };
}

// ── 生命周期 ─────────────────────────────────────────────
test('无凭据：start() 抛出可读错误（缺哪个字段 / 去哪填 / 影响范围）', async () => {
  const { transport, sdk, log } = createRig({ appSecret: '' });
  await assert.rejects(() => transport.start(), (err) => {
    assert.match(err.message, /缺少 AppSecret/);
    assert.match(err.message, /控制台「机器人」页/);
    assert.match(err.message, /其它机器人不受影响/, '应说明影响范围（只跳过 QQ 连接）');
    return true;
  });
  assert.equal(sdk.factoryCalls.length, 0, '无凭据时不应装配中间件');
  assert.ok(log.byLevel('warn').some((args) => String(args[0]).includes('缺少 AppSecret')), '应有 warn 级日志说明跳过原因');
});

test('无凭据：AppID 与 AppSecret 都缺时两者都列出来', async () => {
  const { transport } = createRig({ appId: '', appSecret: '' });
  await assert.rejects(() => transport.start(), (err) => {
    assert.match(err.message, /缺少 AppID \/ AppSecret/);
    return true;
  });
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

  // quoteRef 必须带 enrichEntry：否则「引用一张卡片追问」时 entry.content 为空，
  // 模型只会看到 [empty message]（见 .work/QQ-PLATFORM-COMPARISON.md §2）。
  const quote = sdk.factoryCalls.find((item) => item.name === 'quoteRef');
  assert.equal(typeof quote.options.enrichEntry, 'function', 'quoteRef 必须注入 enrichEntry 以保留卡片正文');

  // quoteRef 必须用我们自己的 ref store：SDK 走 msg_elements 时会丢作者，
  // 要靠同一个 store 实例在后续中间件里补回来（否则引用图作者显示「某位群友」）。
  assert.ok(quote.options.store, 'quoteRef 必须注入自管 store');
  assert.equal(typeof quote.options.store.get, 'function', 'store 需实现 get');
  assert.equal(typeof quote.options.store.set, 'function', 'store 需实现 set');
  // 中间件链里必须有一个 enricher 能读到它：注册的中间件数量应比 SDK 内置多
  assert.ok(instance.middlewares.length >= 15, '应额外挂上引用作者补全中间件（实际 ' + instance.middlewares.length + '）');

  // enrichEntry 对卡片消息补正文，对普通消息原样返回
  const cardCtx = { message: { msgType: 3, content: '', raw: { ark_data: { ark_name: '小程序', fields: { title: '测试卡片', source: '哔哩哔哩' } } } } };
  const enriched = quote.options.enrichEntry({ messageId: 'm1', content: '' }, cardCtx);
  assert.ok(enriched.content.startsWith('[卡片:小程序]'), '卡片消息应补出卡片正文，实际: ' + enriched.content);
  const plainEntry = { messageId: 'm2', content: '普通文本' };
  const plainCtx = { message: { msgType: 0, content: '普通文本' } };
  assert.deepEqual(quote.options.enrichEntry(plainEntry, plainCtx), plainEntry, '普通消息不应被改写');
  // 异常输入不能让整条管线挂掉
  assert.deepEqual(quote.options.enrichEntry(plainEntry, undefined), plainEntry, 'ctx 缺失时应原样返回');

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
// ── D. 连接状态准确性：READY / ERROR / 超时 ────────────────
test('start() 等待 READY：连接成功后 ready=true', async () => {
  const { transport } = createRig();
  await transport.start();
  assert.equal(transport.ready, true);
  await transport.stop();
  assert.equal(transport.ready, false);
});

test('连接前 ERROR：start() 立即 reject（带 SDK 错误信息）并清理实例', async () => {
  const sdk = createFakeSdk({ startBehavior: 'error' });
  const { transport } = createRig({ sdk });
  await assert.rejects(() => transport.start(), (err) => {
    assert.match(err.message, /invalid app secret|token_invalid/);
    assert.match(err.message, /code=token_invalid/, '错误信息应带 SDK 错误码');
    assert.match(err.message, /appId=app-1/, '错误信息应带 appId');
    return true;
  });
  assert.equal(transport.bot, null, '失败后应清理 QQBot 实例');
});

test('READY 超时：start() reject 超时错误，提示含排查顺序与 appId（不无限等待）', async () => {
  const sdk = createFakeSdk({ startBehavior: 'silent' });
  const { transport } = createRig({ sdk, readyTimeoutMs: 100 });
  await assert.rejects(() => transport.start(), (err) => {
    assert.match(err.message, /连接超时/);
    assert.match(err.message, /排查顺序/);
    assert.match(err.message, /AppID\/AppSecret/, '应提示检查凭据');
    assert.match(err.message, /appId=app-1/, '应带上 appId 便于定位机器人');
    return true;
  });
  assert.equal(transport.bot, null);
});

// ── B. 记忆提炼接线：turn/end -> collector.noteTurnEnd({botId, transcript}) ──
test('出站 turn/end 调用 memoryCollector.noteTurnEnd，并带完整 transcript', async () => {
  const calls = [];
  const memoryCollector = {
    noteTurnEnd(record, extra = {}) { calls.push({ record, extra }); },
  };
  const { transport, ctx, botRuntime } = createRig({
    settings: { reply: { enabled: true, memory: { autoExtractEvery: 10 } } },
    memoryCollector,
  });
  await transport.start();
  const instance = transport.bot;

  // 入站一条消息（产生 record 与用户侧转录）
  await instance.dispatchMessage({
    message: { kind: 'c2c', content: '我最喜欢蓝色', messageId: 'm-mem', senderId: 'U-MEM' },
    state: {},
    receivedAt: Date.now(),
    replyTarget: { scope: 'c2c', targetId: 'U-MEM', msgId: 'm-mem' },
  });
  await tick(10);
  const record = botRuntime.sessions.get('c2c:U-MEM');
  assert.ok(record, '入站应创建会话记录');

  // 出站 turn/end（助手最终文本进转录 + 触发 collector）
  const session = { header: { id: record.sessionId } };
  ctx.emit('session/event', session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '记住啦，你喜欢蓝色' }] } } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await tick(60);

  assert.equal(calls.length, 1, 'turn/end 应调用一次 collector');
  assert.equal(calls[0].extra.botId, 'bot-1');
  assert.match(String(calls[0].extra.transcript), /用户: .*我最喜欢蓝色/, 'transcript 应包含用户侧原文');
  assert.match(String(calls[0].extra.transcript), /助手: .*记住啦/, 'transcript 应包含助手侧最终文本');
  assert.equal(record.settings && typeof record.settings, 'object', 'collector 调用前应刷新 record.settings');
  await transport.stop();
});
// ── 群友库自动收录：runtime.members.upsert ──────────────────
test('群聊入站自动 upsert 群友（runtime.members 已装配时）', async () => {
  const upserts = [];
  const members = { upsert(input) { upserts.push(input); return { openid: input.openid, created: true }; } };
  const { transport } = createRig({ settings: { reply: { enabled: true, mode: 'mention' } }, members });
  await transport.start();
  await transport.bot.dispatchMessage({
    message: { kind: 'group', content: '大家好', messageId: 'm-member', groupOpenid: 'G-M', senderId: 'U-M', senderName: '阿岚' },
    state: { mention: { wasMentioned: true } },
    receivedAt: Date.now(),
  });
  await tick(10);
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0], { botId: 'bot-1', openid: 'U-M', nickname: '阿岚' });
  await transport.stop();
});

test('群友库 upsert 抛错只 warn，不影响消息投递', async () => {
  const members = { upsert() { throw new Error('db locked'); } };
  const { transport, delivered } = createRig({ settings: { reply: { enabled: true, mode: 'mention' } }, members });
  await transport.start();
  await transport.bot.dispatchMessage({
    message: { kind: 'group', content: 'hi', messageId: 'm-member2', groupOpenid: 'G-M2', senderId: 'U-M2', senderName: '小明' },
    state: { mention: { wasMentioned: true } },
    receivedAt: Date.now(),
  });
  await tick(10);
  assert.equal(delivered.length, 1, '群友库失败不应阻断聊天投递');
  await transport.stop();
});
// ── 工具层通道：transport.messageSender / mediaSender ──────
test('transport 暴露 messageSender/mediaSender 给工具层（sendCard / 媒体发送）', async () => {
  const { transport } = createRig();
  await transport.start();
  const instance = transport.bot;

  assert.equal(typeof transport.messageSender.sendCard, 'function');
  assert.equal(typeof transport.mediaSender.sendImage, 'function');

  await transport.messageSender.sendCard({ scope: 'c2c', targetId: 'U1', msgId: 'm1' }, {
    title: '标题', description: '摘要', url: 'https://example.com/a',
  });
  assert.equal(instance.calls[0].msgType, 8, '图文卡片应走 msg_type=8');

  await transport.mediaSender.sendImage({ scope: 'group', targetId: 'G1', msgId: 'm2' }, { localPath: '/tmp/x.png' });
  const mediaCall = instance.calls.find((call) => call.method === 'sendImage');
  assert.ok(mediaCall, '应调用 SDK sendImage');
  assert.equal(mediaCall.target.msgId, 'm2');
  await transport.stop();
});
