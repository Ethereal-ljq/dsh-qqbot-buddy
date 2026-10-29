/**
 * gateway —— QQBot 实例的创建、中间件装配、入站/出站接线、工具注册与生命周期。
 *
 * 职责边界：
 *   - 中间件管线在 middleware.js；命令在 commands.js；入站组装在 inbound.js；
 *     出站在 outbound.js；附件在 attachment.js；媒体清理在 media-cleaner.js。
 *   - 本模块只做「接线 + 状态 + 启停」，并把 bot 实例用闭包暴露给需要它的地方
 *     （outbound / 命令 / send_file 工具），这样「手动重连」换新实例时所有引用自动跟随。
 *
 * 凭据缺失时不启动 bot，只 warn（设置页仍可见，由 index.js 注册 web 路由）。
 */
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { setupMiddlewares, createHistoryStore, createReplyProbe, clearGroupHistory } from './middleware.js';
import { createCommandMiddleware } from './commands.js';
import { createInboundHandler } from './inbound.js';
import { createOutboundHandler, createSentTracker } from './outbound.js';
import { createAttachmentMiddleware, downloadMediaAttachments } from './attachment.js';
import { createAdaptiveScheduler } from './adaptive.js';
import { startMediaCleanup } from './media-cleaner.js';
import { pendingSnapshot, clearPending as clearGatePending } from './gate.js';
import { registerSendFileTool } from '../tools/send-file.js';
import { registerVisionTool } from '../tools/vision.js';

import { VERSION } from '../version.js';
const DEFAULT_BASE_URL = 'https://api.bot.qq.com';

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function buildUserAgent() {
  return 'qqbot-buddy/' + VERSION + ' (deepseek-harness)';
}

function baseUrlFromEnv(name) {
  const raw = process.env[name];
  const value = typeof raw === 'string' ? raw.trim() : '';
  const base = value !== '' ? value : DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
}

/** SDK logger 适配：info 降级到 debug，避免 SDK 每条消息刷屏。 */
function sdkLoggerFrom(logger) {
  return {
    debug: (...args) => logger.debug(...args),
    info: (...args) => logger.debug(...args),
    warn: (...args) => logger.warn(...args),
    error: (...args) => logger.error(...args),
  };
}

/** 安全获取可选服务。 */
function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 创建 QQ 网关控制器。
 * @param {object} deps
 * @param {object} deps.ctx 插件上下文
 * @param {object} deps.config 部署配置（已解析 appId/appSecret/cwd）
 * @param {object} deps.logger 日志对象
 * @param {object} deps.settings settings-store
 * @param {object} deps.manager SessionManager
 * @param {object} deps.gateState createGateState() 实例
 * @param {object} deps.stats 统计对象
 * @param {string} deps.stateDir 状态目录
 * @param {string} deps.mediaDir 媒体目录
 * @param {object} [deps.collector] memory collector
 */
export function createGateway(deps = {}) {
  const {
    ctx, config = {}, logger, settings, manager, gateState, stats, stateDir, mediaDir, collector,
    members, registerTools = true, botId = '', knowledgeExtractor = null,
  } = deps;
  const log = logger || console;

  /**
   * 当前 QQ 凭据：每次现读 config。
   * 扫码/手动绑定后 config 会被原地更新（index 的 runtimeConfig 与 manager/gateway 共享同一引用），
   * 因此这里绝不能缓存成 const 快照，否则热切换后仍用旧 appId 建连接。
   */
  function currentCredentials() {
    return {
      appId: typeof config.appId === 'string' ? config.appId.trim() : '',
      appSecret: typeof config.appSecret === 'string' ? config.appSecret.trim() : '',
    };
  }

  const historyStore = deps.historyStore || createHistoryStore();
  const sentTracker = deps.sentTracker || createSentTracker();
  const replyProbe = createReplyProbe({ sentTracker });

  // adaptive 模式调度器：中间件把攒批消息交给它，触发时下载附件 -> 组装 -> followup。
  const adaptive = createAdaptiveScheduler({
    getBot: currentBot,
    manager: manager,
    config: config,
    settings: settings,
    gateState: gateState,
    stats: stats,
    logger: log,
    mediaDir: mediaDir,
    historyStore: historyStore,
    downloadAttachments: downloadMediaAttachments,
    clearHistory: (scope, peerId) => clearGroupHistory(historyStore, config.appId, peerId),
  });

  /** 当前 bot 实例（重连会替换）。 */
  let bot = null;
  let ready = false;
  let startedAt = 0;
  let lastError = '';
  let disposed = false;
  let lifecycleRegistered = false;
  let mediaCleanupStarted = false;
  let toolsRegistered = false;
  let toolDisposers = [];
  let offSessionEvent = null;

  const inboundHandler = createInboundHandler({
    config: config,
    logger: log,
    manager: manager,
    settings: settings,
    stats: stats,
    historyStore: historyStore,
    members: members,
    botId: botId,
  });

  /** 取当前 bot；未就绪时抛错（由工具层转成可读错误）。 */
  function currentBot() {
    return bot;
  }

  function requireBot() {
    if (!bot) throw new Error('QQ 机器人尚未就绪');
    return bot;
  }

  // ── 媒体发送适配器（qqbot_send_file 用） ───────────────────
  async function sendMediaWithFallback(method, target, source, opts) {
    const instance = requireBot();
    const safeTarget = target && typeof target === 'object' ? target : {};
    try {
      return await instance[method](safeTarget, source, opts);
    } catch (err) {
      // 被动回复窗口过期/超频：去掉 msgId 再试一次主动推送
      log.warn('媒体发送失败，尝试主动推送: ' + errText(err));
      const proactive = { scope: safeTarget.scope, targetId: safeTarget.targetId };
      return instance[method](proactive, source, opts);
    }
  }

  const mediaSender = {
    sendImage: (target, source) => sendMediaWithFallback('sendImage', target, source),
    sendVideo: (target, source) => sendMediaWithFallback('sendVideo', target, source),
    sendVoice: (target, source) => sendMediaWithFallback('sendVoice', target, source),
    sendFile: (target, source, opts) => sendMediaWithFallback('sendFile', target, source, opts),
  };

  /** 工具只注册一次（重连不重复注册）；返回的注销函数在插件卸载时调用。 */
  function registerToolsOnce() {
    if (toolsRegistered) return;
    toolsRegistered = true;
    const sfDisposer = registerSendFileTool({
      ctx: ctx,
      sender: mediaSender,
      manager: manager,
      config: config,
      logger: log,
      mediaDir: mediaDir,
    });
    if (typeof sfDisposer === 'function') toolDisposers.push(sfDisposer);
    const visionDisposer = registerVisionTool({ ctx: ctx, config: config, logger: log });
    if (typeof visionDisposer === 'function') toolDisposers.push(visionDisposer);
  }

  /** 订阅 session/event（出站）。重连前会先取消旧订阅，避免重复发送。 */
  function attachSessionEvents() {
    if (offSessionEvent) {
      try {
        offSessionEvent();
      } catch {
        /* 忽略 */
      }
      offSessionEvent = null;
    }
    if (!ctx || typeof ctx.on !== 'function') return;
    try {
      // turn/end 同时驱动两个提炼器：记忆（collector）与知识（knowledgeExtractor）
      const turnEndCollector = {
        noteTurnEnd(record) {
          try { collector?.noteTurnEnd?.(record); } catch (err) { log.warn('memory collector.noteTurnEnd 失败: ' + errText(err)); }
          try { knowledgeExtractor?.noteTurnEnd?.(record); } catch (err) { log.warn('knowledge extractor.noteTurnEnd 失败: ' + errText(err)); }
        },
      };
      const handler = createOutboundHandler({
        config: config,
        logger: log,
        manager: manager,
        stats: stats,
        sentTracker: sentTracker,
        getBot: currentBot,
        collector: turnEndCollector,
        settings: settings,
      });
      const disposer = ctx.on('session/event', handler);
      offSessionEvent = typeof disposer === 'function' ? disposer : null;
    } catch (err) {
      log.warn('订阅 session/event 失败: ' + errText(err));
    }
  }

  /** 创建一个配置好的 QQBot 实例（不启动）。 */
  function createBotInstance() {
    const credentials = currentCredentials();
    const instance = new QQBot({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      transport: 'websocket',
      baseUrl: baseUrlFromEnv('QQBOT_BASE_URL'),
      tokenBaseUrl: baseUrlFromEnv('QQBOT_TOKEN_BASE_URL'),
      userAgent: buildUserAgent(),
      logger: sdkLoggerFrom(log),
    });

    const commandMiddleware = createCommandMiddleware({
      settings: settings,
      manager: manager,
      logger: log,
      stats: stats,
      getBot: currentBot,
      adaptive: adaptive,
    });
    const attachmentMiddleware = createAttachmentMiddleware({ config: config, logger: log, mediaDir: mediaDir });

    setupMiddlewares(instance, {
      config: config,
      settings: settings,
      logger: log,
      gateState: gateState,
      stats: stats,
      sentTracker: sentTracker,
      historyStore: historyStore,
      commandMiddleware: commandMiddleware,
      attachmentMiddleware: attachmentMiddleware,
      replyProbe: replyProbe,
      adaptive: adaptive,
    });

    // 入站：中间件链走完后交给 agent
    instance.on('message', async (mCtx) => {
      try {
        await inboundHandler(mCtx);
      } catch (err) {
        log.error('入站消息处理失败: ' + errText(err));
      }
    });

    // 互动回调：本插件没有自定义按钮，统一回「未知」静默 ack
    instance.on('interaction', async (_iCtx, event) => {
      try {
        if (event && event.id) await instance.acknowledgeInteraction(event.id, 3);
      } catch (err) {
        log.warn('互动回调 ack 失败: ' + errText(err));
      }
    });

    instance.on('error', (err) => {
      lastError = errText(err);
      log.error('QQBot 错误: ' + lastError);
    });

    instance.on('ready', () => {
      ready = true;
      startedAt = Date.now();
      lastError = '';
      log.info('QQ 机器人已就绪 (appId=' + currentCredentials().appId + ')');
    });

    // resumed：op7（网关要求重连）/ op9 且 session 可恢复时，SDK 发的是 resumed 而不是 ready
    // （QQBot.js 的 RESUME 分支 -> onResumed -> emit('resumed')）。
    // 只监听 ready 会让 ready 永久停在 false：设置页显示「未连接」，但实际收发完全正常。
    try {
      instance.on('resumed', () => {
        ready = true;
        lastError = '';
        log.info('QQ 连接已恢复（session resumed）');
      });
    } catch (err) {
      log.warn('当前 qqbot-nodejs SDK 不支持 resumed 事件: ' + errText(err));
    }

    // disconnected 是 SDK 1.0.5+ 新增事件；旧版 handlers 表没有该键，on 会抛 TypeError
    try {
      instance.on('disconnected', (event) => {
        ready = false;
        const detail = event
          ? 'code=' + event.code + (event.reason ? ' reason=' + event.reason : '')
          : 'unknown';
        // willReconnect=true 属于协议内的正常重连（op7 / code 1000 NORMAL）：
        // SDK 会自动重连并 RESUME，断线期间的消息由服务端补发，因此只记 info、不写 lastError。
        // 只有 willReconnect=false（重连次数耗尽 / 致命关闭）才是真正的断连。
        if (event && event.willReconnect) {
          log.info('QQ 连接断开，正在重连: ' + detail);
          lastError = '';
        } else {
          log.error('QQ 连接永久断开: ' + detail);
          lastError = 'disconnected ' + detail;
        }
      });
    } catch (err) {
      log.warn('当前 qqbot-nodejs SDK 不支持 disconnected 事件: ' + errText(err));
    }

    return instance;
  }

  /** 启动（或重连后重新启动）网关。 */
  async function bootstrap() {
    if (disposed) return false;
    // 任何启动路径（首启 / 无凭据 / 手动重连）都注册卸载清理，避免 autoStart=false 后
    // 通过 web「重连」启动的 bot 在插件卸载时泄漏。registerLifecycle 是幂等的。
    registerLifecycle();
    const credentials = currentCredentials();
    if (!credentials.appId || !credentials.appSecret) {
      log.warn('未配置 QQ 凭据（appId/appSecret），跳过网关启动；设置页仍可使用');
      return false;
    }
    try {
      bot = createBotInstance();
      attachSessionEvents();
      // 多机器人部署由宿主统一注册工具（registerTools=false），这里跳过
      if (registerTools !== false) registerToolsOnce();
      if (!mediaCleanupStarted) {
        mediaCleanupStarted = true;
        startMediaCleanup(ctx, { mediaDir: mediaDir, logger: log });
      }
      ready = false;
      startedAt = Date.now();
      lastError = '';
      const instance = bot;
      log.info('正在启动 QQ 机器人 (appId=' + credentials.appId + ', ua=' + buildUserAgent() + ')');
      // bot.start() 在 stop 之前不会 resolve，因此不能 await（会阻塞插件加载）
      Promise.resolve()
        .then(() => instance.start())
        .catch((err) => {
          if (instance === bot) ready = false;
          lastError = errText(err);
          log.error('QQBot 启动失败: ' + lastError);
        });
      return true;
    } catch (err) {
      lastError = errText(err);
      bot = null;
      log.error('创建 QQBot 实例失败: ' + lastError);
      return false;
    }
  }

  /** 停止当前 bot（可选销毁会话）。 */
  async function stopBot({ disposeSessions = false } = {}) {
    const instance = bot;
    bot = null;
    ready = false;
    startedAt = 0;
    // 停 bot 时清空自适应缓冲与定时器（缓冲不持久化，重启即丢，可接受）
    try {
      adaptive.clearAll();
    } catch (err) {
      log.warn('清空 adaptive 缓冲失败: ' + errText(err));
    }
    if (offSessionEvent) {
      try {
        offSessionEvent();
      } catch {
        /* 忽略 */
      }
      offSessionEvent = null;
    }
    if (disposeSessions && manager && typeof manager.disposeAll === 'function') {
      try {
        await manager.disposeAll();
      } catch (err) {
        log.warn('销毁会话失败: ' + errText(err));
      }
    }
    if (instance) {
      try {
        instance.stop();
      } catch (err) {
        log.warn('停止 QQBot 失败: ' + errText(err));
      }
    }
  }

  /** 注册插件生命周期（卸载时停 bot + 销毁会话 + 注销工具）。 */
  function registerLifecycle() {
    if (lifecycleRegistered) return;
    lifecycleRegistered = true;
    if (!ctx || typeof ctx.effect !== 'function') return;
    try {
      ctx.effect(() => () => {
        void dispose().catch((err) => log.error('网关卸载清理失败: ' + errText(err)));
      }, 'qqbot-buddy.gateway');
    } catch (err) {
      log.warn('注册网关生命周期失败: ' + errText(err));
    }
  }

  /** 完全卸载：停 bot、销毁会话、注销工具。 */
  async function dispose() {
    if (disposed) return;
    disposed = true;
    await stopBot({ disposeSessions: true });
    try {
      adaptive.dispose();
    } catch (err) {
      log.warn('释放 adaptive scheduler 失败: ' + errText(err));
    }
    for (const disposer of toolDisposers) {
      try {
        if (typeof disposer === 'function') disposer();
      } catch (err) {
        log.warn('注销工具失败: ' + errText(err));
      }
    }
    toolDisposers = [];
    toolsRegistered = false;
  }

  /**
   * 应用新的 QQ 凭据（扫码绑定 / 手动填写 / 解绑时由 index 的 runtime.applyCredentials 调用）。
   * 语义：更新运行期 config -> 停旧 bot（保留内存会话）-> 以新凭据重新 bootstrap。
   * @param {{appId?:string, appSecret?:string}} credentials
   * @returns {Promise<{ok:boolean, bound?:boolean, error?:string}>}
   */
  async function applyCredentials(credentials = {}) {
    if (disposed) return { ok: false, error: '插件已卸载' };
    const input = credentials && typeof credentials === 'object' ? credentials : {};
    const nextAppId = typeof input.appId === 'string' ? input.appId.trim() : '';
    const nextAppSecret = typeof input.appSecret === 'string' ? input.appSecret.trim() : '';
    // 原地更新 config：manager 的 sessionKey / inbound 的 appId 都依赖同一个引用
    config.appId = nextAppId;
    config.appSecret = nextAppSecret;
    log.info('应用新的 QQ 凭据: appId=' + (nextAppId || '(空)'));
    await stopBot({ disposeSessions: false });
    lastError = '';
    if (!nextAppId || !nextAppSecret) {
      log.warn('凭据为空，网关保持停止（未绑定状态）');
      return { ok: true, bound: false };
    }
    const started = await bootstrap();
    if (!started) return { ok: false, error: lastError || '凭据已保存但网关启动失败' };
    return { ok: true, bound: true };
  }

  /** 供 web「重连」按钮调用：停旧实例再建新实例，保留现有会话。 */
  async function restartBot() {
    if (disposed) return { ok: false, error: '插件已卸载' };
    log.info('手动重启 QQ 机器人...');
    await stopBot({ disposeSessions: false });
    const started = await bootstrap();
    if (!started) return { ok: false, error: lastError || '缺少凭据或启动失败' };
    return { ok: true };
  }

  /** 清空频率门控的 pending 队列（web「清空待回复」）。 */
  function clearPending() {
    try {
      clearGatePending(gateState);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  }

  /** 机器人状态快照（web /api/state 用）。 */
  function botState() {
    let pending = [];
    try {
      const gatePending = pendingSnapshot(gateState);
      let adaptivePending = [];
      try {
        adaptivePending = adaptive && typeof adaptive.pendingSnapshot === 'function'
          ? adaptive.pendingSnapshot()
          : [];
      } catch {
        adaptivePending = [];
      }
      pending = gatePending.concat(Array.isArray(adaptivePending) ? adaptivePending : []);
      pending.sort((a, b) => (Number(b && b.waitingMs) || 0) - (Number(a && a.waitingMs) || 0));
    } catch {
      pending = [];
    }
    return {
      appId: currentCredentials().appId,
      ready: ready,
      startedAt: startedAt,
      lastError: lastError,
      sessionCount: manager && typeof manager.size === 'number' ? manager.size : 0,
      pending: pending,
    };
  }

  /** 启动网关（index.js 调用）。 */
  async function start() {
    registerLifecycle();
    if (registerTools !== false) registerToolsOnce();
    return bootstrap();
  }

  return {
    start: start,
    dispose: dispose,
    restartBot: restartBot,
    applyCredentials: applyCredentials,
    getCredentials: currentCredentials,
    clearPending: clearPending,
    botState: botState,
    getBot: currentBot,
    /** 媒体发送适配器（qqbot_send_file 按机器人路由时用）。 */
    sender: mediaSender,
    sentTracker: sentTracker,
    historyStore: historyStore,
    replyProbe: replyProbe,
    adaptive: adaptive,
    get ready() {
      return ready;
    },
    get bot() {
      return bot;
    },
    get appId() {
      return currentCredentials().appId;
    },
  };
}

export default createGateway;