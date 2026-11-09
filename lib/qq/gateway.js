/**
 * gateway —— v2 QQ 传输层工厂（唯一入口）。
 *
 * 契约见 docs/TRANSPORT-CONTRACT.md：
 *   createQqTransportFactory({ ctx, runtime, logger, sdk? }) -> (botRuntime) => { start(), stop() }
 *
 * 与 v1 gateway 的差异（只改接线）：
 *   - 生命周期交给 host：v1 一个 gateway 管一个 bot 并可热重连；v2 host/agent.js 的
 *     BotRuntime 为每个 bot 持有 transport，start()/stop() 由 host 调用；
 *   - 会话管理交给 host：v1 的 SessionManager 换成 BotRuntime + session-adapter；
 *   - 设置按 peer 现读：v1 settings 单例换成 settings.forPeer(peer)（作用域绑定/配置档）；
 *   - 发送入口交给 BotRuntime.followup(peer, {text, imageBlocks})；
 *   - 工具/记忆/知识/群友库等 v1 副作用不在这里注册（M2/M4 各自负责），留 TODO 注释；
 *   - SDK 动态注入：生产动态 import @tencent-connect/qqbot-nodejs，测试注入假 SDK。
 */
import fs from 'node:fs';
import path from 'node:path';

import { formatPeer } from '../core/peer.js';
import { VERSION } from '../version.js';

import { createGateState } from './gate.js';
import { createSender } from './sender.js';
import { createSettingsView } from './settings.js';
import { createSessionAdapter } from './session-adapter.js';
import {
  setupMiddlewares,
  createHistoryStore,
  createReplyProbe,
  clearGroupHistory,
} from './middleware.js';
import { createCommandMiddleware } from './commands.js';
import { createAttachmentMiddleware } from './attachment.js';
import { createAdaptiveScheduler } from './adaptive.js';
import { createInboundHandler } from './inbound.js';
import { createOutboundHandler, createSentTracker } from './outbound.js';
import { createRawEventHandler } from './events.js';
import { createInteractionHandler } from './interaction.js';
import { startMediaCleanup } from './media-cleaner.js';
import { sendMediaSafely } from './media-send.js';

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
    debug: (...args) => logger.debug?.(...args),
    info: (...args) => logger.debug?.(...args),
    warn: (...args) => logger.warn?.(...args),
    error: (...args) => logger.error?.(...args),
  };
}

/** 动态加载 QQ SDK（未安装时给出可读错误，由 host 置 status=error）。 */
async function loadSdk() {
  try {
    return await import('@tencent-connect/qqbot-nodejs');
  } catch (err) {
    throw new Error('QQ SDK 不可用（缺少依赖 @tencent-connect/qqbot-nodejs，请先执行 npm install）: ' + errText(err));
  }
}

/** 尝试取 SDK 的 ReplyLimiter（生产用官方实现；失败由 sender 回落 vendored 实现）。 */
async function loadReplyLimiter(api) {
  if (api && typeof api.ReplyLimiter === 'function') return api.ReplyLimiter;
  try {
    const protocol = await import('@tencent-connect/qqbot-nodejs/protocol');
    if (protocol && typeof protocol.ReplyLimiter === 'function') return protocol.ReplyLimiter;
  } catch { /* 旧版 SDK 没有 ./protocol 子路径：sender 用 vendored 实现 */ }
  return undefined;
}

/**
 * 创建 QQ 传输层工厂。
 * @param {object} deps
 * @param {object} deps.ctx 插件上下文（用于 ctx.on('session/event')）
 * @param {object} deps.runtime 插件 runtime（cfg/config/logger/events/paths）
 * @param {object} deps.logger 日志对象
 * @param {object} [deps.sdk] 已加载的 QQ SDK 模块（测试注入假 SDK；生产省略 = 动态 import）
 * @returns {(botRuntime: object) => {start:Function, stop:Function}}
 */
export function createQqTransportFactory({ ctx, runtime, logger, sdk = null, readyTimeoutMs = 15000 } = {}) {
  const log = logger || console;
  // start() 等待 READY 的上限（毫秒）；测试可注入更短的值。ERROR 事件会立即结算。
  const readyWaitMs = Number.isFinite(Number(readyTimeoutMs)) && Number(readyTimeoutMs) > 0
    ? Math.floor(Number(readyTimeoutMs))
    : 15000;

  return function createTransport(botRuntime) {
    if (!botRuntime) throw new Error('createQqTransport: 缺少 botRuntime');

    const botId = botRuntime.id;
    const settings = createSettingsView({ botRuntime });
    const manager = createSessionAdapter({ botRuntime, logger: log });
    const mediaDir = path.join(botRuntime.cwd || '.', 'media');

    /** 部署级配置 + 本 bot 的 appId（协议中间件读 config.access/historyLimit/...）。 */
    function deploymentConfig() {
      const cfg = runtime && runtime.cfg && typeof runtime.cfg === 'object' ? runtime.cfg : {};
      return Object.assign({}, cfg, { appId: credentials().appId });
    }

    /** 每次现读凭据：控制台改 appId/appSecret 后 restart 立即生效。 */
    function credentials() {
      let bot = botRuntime.bot && typeof botRuntime.bot === 'object' ? botRuntime.bot : {};
      try {
        if (runtime && runtime.config && typeof runtime.config.getBot === 'function') {
          const fresh = runtime.config.getBot(botId);
          if (fresh) bot = fresh;
        }
      } catch (err) {
        log.warn?.('读取机器人凭据失败，沿用快照: ' + errText(err));
      }
      return {
        appId: typeof bot.appId === 'string' ? bot.appId.trim() : '',
        appSecret: typeof bot.appSecret === 'string' ? bot.appSecret.trim() : '',
        name: typeof bot.name === 'string' ? bot.name.trim() : '',
      };
    }

    /** 日志/错误里的机器人标识：「昵称」(botId)。 */
    function botLabel(creds) {
      const info = creds && typeof creds === 'object' ? creds : credentials();
      const name = info.name !== undefined ? info.name : '';
      return (name !== '' ? '「' + name + '」' : '') + '(' + botId + ')';
    }

    /** SDK 错误描述：文案 + code（token 失效/参数错误时 code 是关键线索）。 */
    function describeSdkError(err) {
      const text = errText(err);
      const rawCode = err && (err.code !== undefined ? err.code : err.bizCode);
      const code = rawCode !== undefined && rawCode !== null && rawCode !== '' ? String(rawCode) : '';
      return code !== '' ? text + '（code=' + code + '）' : text;
    }

    /**
     * READY 超时错误：一次性给出「谁、等多久、下一步查什么、最近错误」，
     * 控制台/日志直接可读（真机部署最常见的三类原因都列出来）。
     */
    function buildReadyTimeoutError(creds) {
      const waitText = readyWaitMs >= 1000 ? Math.round(readyWaitMs / 1000) + ' 秒' : readyWaitMs + ' 毫秒';
      const parts = [
        'QQ 连接超时：' + waitText + ' 内未收到 READY'
          + '（机器人 ' + botLabel(creds) + ', appId=' + (creds.appId || '(空)') + '）',
        '排查顺序：1) 控制台「机器人」页确认 AppID/AppSecret 与 QQ 开放平台一致；'
          + '2) 本机可访问 api.bot.qq.com（或已用 QQBOT_BASE_URL 配代理）；'
          + '3) QQ 开放平台里机器人状态正常、已开通消息权限；'
          + '4) 刚改过凭据的话重启该机器人。',
      ];
      if (lastError) parts.push('最近一次 SDK 错误：' + lastError);
      return new Error(parts.join('；'));
    }

    // ── 运行期状态（一次 transport 实例内共享） ──────────────
    const gateState = createGateState();
    const stats = { received: 0, triggered: 0, skipped: 0, replies: 0, lastReplyAt: 0 };
    const sentTracker = createSentTracker();
    const replyProbe = createReplyProbe({ sentTracker });
    const replyBudgets = new Map(); // scope -> ReplyLimiter（跨 start/stop 保留，重连不清零）

    let config = deploymentConfig();
    let historyStore = null;
    let sender = null;
    let adaptive = null;
    let inbound = null;
    let outbound = null;
    let commandMiddleware = null;
    let attachmentMiddleware = null;
    let interactionHandler = null;
    let rawEventHandler = null;
    let instance = null;
    let offSessionEvent = null;
    let stopMediaCleanup = null;
    let ready = false;
    let startedAt = 0;
    let lastError = '';
    /** start() 等待 READY/ERROR 的同步器（SDK 的 start() 是长连接，不能直接 await）。 */
    let readyWaiter = null;

    function settleReady(error) {
      const waiter = readyWaiter;
      if (!waiter) return;
      if (error) waiter.reject(error); else waiter.resolve();
    }

    /** 当前 QQBot 实例（sender/命令/rawEvent 通过闭包跟随，不缓存快照）。 */
    function currentBot() {
      return instance;
    }

    /**
     * 媒体发送适配器（qqbot_send_file 工具用）：按扩展名分发到 SDK 的
     * sendImage/sendVideo/sendVoice/sendFile，并复用 media-send 的安全兜底
     * （只有「确定未送达」才主动重发；「可能已送达」抛 UNKNOWN_DELIVERY）。
     */
    const mediaSender = {
      sendImage: (target, source) => requireInstance('sendImage')(target, source),
      sendVideo: (target, source) => requireInstance('sendVideo')(target, source),
      sendVoice: (target, source) => requireInstance('sendVoice')(target, source),
      sendFile: (target, source, opts) => requireInstance('sendFile')(target, source, opts),
    };

    function requireInstance(method) {
      if (!instance) throw new Error('QQ 机器人尚未就绪（缺少 ' + method + ' 通道）');
      return (target, source, opts) => sendMediaSafely(instance, method, target, source, opts, log);
    }

    /**
     * 入站最终投递：BotRuntime.followup(peer, {text, imageBlocks})。
     * 带图被宿主拒绝时降级为纯文本重投（v1 followupWithImageFallback 的 v2 等价物，
     * 迁移到 transport 层，避免 inbound/adaptive 各自维护一份）。
     */
    async function deliver({ peer, body, imageBlocks = [], message } = {}) {
      const text = typeof body === 'string' ? body : String(body ?? '');
      const blocks = Array.isArray(imageBlocks) ? imageBlocks : [];
      // 本轮用户原话 + 发送者：prompt 召回（记忆/知识/群友）必须用短 query，
      // 不能用拼了 Chat history 的整包 body，否则 FTS 零命中。
      const recallQuery = message && typeof message.content === 'string' ? message.content : '';
      const senderId = message && typeof message.senderId === 'string' ? message.senderId : '';
      let first;
      try {
        first = await botRuntime.followup(peer, { text, imageBlocks: blocks, recallQuery, senderId });
      } catch (err) {
        first = { ok: false, error: errText(err) };
      }
      if (first && first.ok !== false) return { ok: true, degraded: false };
      if (blocks.length === 0) return { ok: false, error: (first && first.error) || 'followup 失败' };
      log.warn?.('带图投递失败，降级为纯文本重投: ' + ((first && first.error) || ''));
      try {
        const second = await botRuntime.followup(peer, { text, recallQuery, senderId });
        if (second && second.ok !== false) return { ok: true, degraded: true };
        return { ok: false, error: (second && second.error) || 'followup 失败' };
      } catch (err) {
        return { ok: false, error: errText(err) };
      }
    }

    /** 等当前 turn 结束（同 peer 串行）。 */
    async function whenIdle(peer) {
      if (botRuntime && typeof botRuntime.whenIdle === 'function') return botRuntime.whenIdle(peer);
    }

    /**
     * 互动回调（按钮/快捷菜单）投喂：把按钮数据当一条用户消息。
     * v1 走 manager.getOrCreate + agent.followup + whenIdle；v2 统一走 BotRuntime。
     */
    async function feedInteraction({ scope, peerId, text } = {}) {
      if (!scope || !peerId || !text) return;
      const peer = formatPeer(scope, peerId);
      if (peer === '') return;
      await botRuntime.followup(peer, { text: '[按钮] ' + text });
      try {
        await whenIdle(peer);
      } catch { /* 投递已成功，等空闲失败只影响串行体验 */ }
    }

    /** 构建 QQBot 实例（不启动）。 */
    function createBotInstance(api, creds) {
      return new api.QQBot({
        appId: creds.appId,
        appSecret: creds.appSecret,
        transport: 'websocket',
        baseUrl: baseUrlFromEnv('QQBOT_BASE_URL'),
        tokenBaseUrl: baseUrlFromEnv('QQBOT_TOKEN_BASE_URL'),
        userAgent: buildUserAgent(),
        logger: sdkLoggerFrom(log),
      });
    }

    /** 订阅 session/event（出站）。只订阅一次；stop 时取消。 */
    function attachSessionEvents() {
      if (offSessionEvent) {
        try { offSessionEvent(); } catch { /* 忽略 */ }
        offSessionEvent = null;
      }
      if (!ctx || typeof ctx.on !== 'function' || typeof outbound !== 'function') return;
      try {
        const disposer = ctx.on('session/event', outbound);
        offSessionEvent = typeof disposer === 'function' ? disposer : null;
        return;
      } catch (err) {
        log.warn?.('订阅 session/event 失败: ' + errText(err));
      }
    }

    /** 组装全部协作者 + QQBot 实例 + 中间件链 + 事件处理。 */
    async function bootstrap(api) {
      config = deploymentConfig();
      historyStore = createHistoryStore(api);
      const ReplyLimiter = await loadReplyLimiter(api);

      sender = createSender({
        getBot: currentBot,
        logger: log,
        settings,
        stats,
        budgets: replyBudgets,
        ...(ReplyLimiter ? { ReplyLimiter } : {}),
      });

      adaptive = createAdaptiveScheduler({
        getBot: currentBot,
        manager,
        config,
        settings,
        gateState,
        stats,
        logger: log,
        mediaDir,
        historyStore,
        deliver,
        whenIdle,
        clearHistory: (scope, peerId) => clearGroupHistory(historyStore, config.appId, peerId),
      });

      inbound = createInboundHandler({
        config,
        logger: log,
        manager,
        settings,
        stats,
        historyStore,
        botId,
        // 群友库自动收录（v2 runtime.members 已装配；缺失时 inbound 内部自动跳过）
        members: runtime && runtime.members ? runtime.members : undefined,
        getSender: () => sender,
        deliver,
        whenIdle,
      });

      commandMiddleware = createCommandMiddleware({
        settings,
        manager,
        logger: log,
        stats,
        getBot: currentBot,
        adaptive,
        getSender: () => sender,
        getVisibility: (peer) => botRuntime.visibility(peer),
      });

      attachmentMiddleware = createAttachmentMiddleware({ config, logger: log, mediaDir });

      interactionHandler = createInteractionHandler({
        manager,
        getSettings: () => settings.get(),
        logger: log,
        stats,
        getBot: currentBot,
        feedAgent: feedInteraction,
      });

      // TODO(v2-M5): v2 设置 schema 暂无 welcome.*（加好友/入群欢迎语），events.js 里
      // 欢迎语开关因此默认关闭；控制台补设置项后在这里映射即可（事件/去重逻辑已就绪）。
      rawEventHandler = createRawEventHandler({
        getSender: () => sender,
        getSettings: () => settings.get(),
        logger: log,
        stats,
      });

      // 记忆提炼（M4 接线）：v2 的 collector 由 core/memory/collect.js 提供，显式传 botId；
      // outbound 会把完整转录放进 extra.transcript。未装配（runtime.memoryCollector=null）时跳过。
      const memoryCollector = runtime && runtime.memoryCollector ? runtime.memoryCollector : null;
      const collector = memoryCollector
        ? {
          noteTurnEnd(record, extra = {}) {
            try {
              // 提炼阈值读的是每 peer 生效设置（作用域绑定会随控制台改动热更新）
              if (record && typeof record.peer === 'string' && record.peer !== '') {
                record.settings = botRuntime.settingsFor(record.peer);
              }
            } catch { /* 设置读取失败时沿用会话创建时快照 */ }
            try {
              memoryCollector.noteTurnEnd(record, Object.assign({}, extra, { botId }));
            } catch (err) {
              log.warn?.('memory collector.noteTurnEnd 失败（忽略）: ' + errText(err));
            }
          },
        }
        : undefined;

      outbound = createOutboundHandler({
        config,
        logger: log,
        manager,
        stats,
        sentTracker,
        getBot: currentBot,
        collector,
        settings,
        getSender: () => sender,
        getMediaSender: () => mediaSender,
      });

      const creds = credentials();
      instance = createBotInstance(api, creds);

      setupMiddlewares(instance, {
        config,
        settings,
        logger: log,
        gateState,
        stats,
        sdk: api,
        historyStore,
        commandMiddleware,
        attachmentMiddleware,
        replyProbe,
        adaptive,
      });

      // 入站：中间件链走完后交给 agent（契约：botRuntime.followup）
      instance.on('message', (mCtx) => {
        Promise.resolve()
          .then(() => inbound(mCtx))
          .catch((err) => log.error?.('入站消息处理失败: ' + errText(err)));
      });

      // 互动回调：按钮 ack + 投喂 / 反馈 / 清空会话
      instance.on('interaction', (iCtx, event) => {
        Promise.resolve()
          .then(() => interactionHandler(iCtx, event))
          .catch((err) => log.warn?.('互动回调处理失败: ' + errText(err)));
      });

      // 生命周期事件（加好友/入群/主动消息许可）
      instance.on('rawEvent', (eventCtx) => {
        Promise.resolve()
          .then(() => rawEventHandler(eventCtx))
          .catch((err) => log.warn?.('rawEvent 处理失败: ' + errText(err)));
      });

      instance.on('error', (err) => {
        lastError = describeSdkError(err);
        const credsNow = credentials();
        log.error?.('QQBot 错误（机器人 ' + botLabel(credsNow) + ', appId=' + (credsNow.appId || '(空)') + '）: ' + lastError);
        // 连接建立前的 ERROR 视为启动失败（READY 之后只记日志，不影响已建立的连接）
        if (!ready) {
          settleReady(new Error('QQBot 连接失败（机器人 ' + botLabel(credsNow)
            + ', appId=' + (credsNow.appId || '(空)') + '）: ' + lastError));
        }
      });

      instance.on('ready', () => {
        ready = true;
        startedAt = Date.now();
        lastError = '';
        log.info?.('QQ 机器人已就绪 (bot=' + botId + ', appId=' + credentials().appId + ')');
        settleReady();
      });

      // SDK 1.0.5+：resumed / disconnected 事件在旧版 handlers 表里不存在，on 会抛 TypeError
      try {
        instance.on('resumed', () => {
          ready = true;
          lastError = '';
          log.info?.('QQ 连接已恢复（session resumed）');
          settleReady();
        });
      } catch (err) {
        log.warn?.('当前 SDK 不支持 resumed 事件: ' + errText(err));
      }
      try {
        instance.on('disconnected', (event) => {
          ready = false;
          const detail = event
            ? 'code=' + event.code + (event.reason ? ' reason=' + event.reason : '')
            : 'unknown';
          if (event && event.willReconnect) {
            log.info?.('QQ 连接断开，正在重连: ' + detail);
            lastError = '';
          } else {
            log.error?.('QQ 连接永久断开: ' + detail);
            lastError = 'disconnected ' + detail;
          }
        });
      } catch (err) {
        log.warn?.('当前 SDK 不支持 disconnected 事件: ' + errText(err));
      }

      attachSessionEvents();

      // 媒体目录 + TTL 清理（stop 时停掉定时器）
      try { fs.mkdirSync(mediaDir, { recursive: true, mode: 0o755 }); } catch (err) {
        log.warn?.('创建媒体目录失败: ' + errText(err));
      }
      stopMediaCleanup = startMediaCleanup(null, { mediaDir, logger: log });
    }

    /**
     * 建立 QQBot 连接、装中间件、订阅出站事件。
     * 失败直接 throw（host 会把该 bot 置 status=error，其他 bot 不受影响）。
     */
    async function start() {
      if (instance) return;
      const creds = credentials();
      if (creds.appId === '' || creds.appSecret === '') {
        // 无凭据：优雅失败 = 抛出可读错误，由 host 捕获并置 error，不产生未捕获异常。
        // 提示要能直接指导运维：缺哪个字段、去哪填、影响范围（只跳过 QQ 连接）。
        const missing = [];
        if (creds.appId === '') missing.push('AppID');
        if (creds.appSecret === '') missing.push('AppSecret');
        const hint = 'QQ 机器人 ' + botLabel(creds) + ' 缺少 ' + missing.join(' / ')
          + '：请在控制台「机器人」页填写 QQ 开放平台的 AppID 与 AppSecret 后重启该机器人。'
          + '本次仅跳过 QQ 连接（控制台可用，其它机器人不受影响）。';
        log.warn?.(hint);
        throw new Error(hint);
      }
      const api = sdk || await loadSdk();
      try {
        await bootstrap(api);
      } catch (err) {
        // 装配中途失败：清掉已创建的资源（定时器/订阅/实例），再交给 host 置 error
        try { await stop(); } catch { /* 清理失败不掩盖原始错误 */ }
        throw err;
      }
      const started = instance;
      log.info?.('正在启动 QQ 机器人 (bot=' + botId + ', appId=' + creds.appId + ', ua=' + buildUserAgent() + ')');

      // 先装好 READY/ERROR 同步器，再调用 SDK 的 start()（长连接，本身不会 resolve）
      const readyPromise = new Promise((resolve, reject) => {
        readyWaiter = { resolve, reject };
      });
      if (ready) settleReady();
      let timer = null;
      const timeoutPromise = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(buildReadyTimeoutError(creds));
        }, readyWaitMs);
      });
      Promise.resolve()
        .then(() => started.start())
        .catch((err) => {
          if (instance === started) {
            ready = false;
            lastError = describeSdkError(err);
          }
          log.error?.('QQBot 启动失败（机器人 ' + botLabel(creds) + ', appId=' + (creds.appId || '(空)') + '）: ' + lastError);
          settleReady(new Error('QQBot 启动失败（机器人 ' + botLabel(creds)
            + ', appId=' + (creds.appId || '(空)') + '）: ' + errText(err)));
        });

      try {
        await Promise.race([readyPromise, timeoutPromise]);
      } catch (err) {
        // 连接失败/超时：清理半连接资源，再交给 host 置 status=error
        log.error?.('QQ 传输层启动失败: ' + errText(err));
        try { await stop(); } catch { /* 清理失败不掩盖原始错误 */ }
        throw err;
      } finally {
        clearTimeout(timer);
        readyWaiter = null;
      }
    }

    /** 断开连接、清理定时器与监听。可重复调用。 */
    async function stop() {
      try { adaptive?.dispose?.(); } catch (err) { log.warn?.('释放 adaptive 失败: ' + errText(err)); }
      adaptive = null;
      if (offSessionEvent) {
        try { offSessionEvent(); } catch { /* 忽略 */ }
        offSessionEvent = null;
      }
      if (stopMediaCleanup) {
        try { stopMediaCleanup(); } catch (err) { log.warn?.('停止媒体清理失败: ' + errText(err)); }
        stopMediaCleanup = null;
      }
      const current = instance;
      instance = null;
      ready = false;
      startedAt = 0;
      readyWaiter = null;
      inbound = null;
      outbound = null;
      sender = null;
      if (current && typeof current.stop === 'function') {
        try { current.stop(); } catch (err) { log.warn?.('停止 QQBot 失败: ' + errText(err)); }
      }
    }

    /** 状态快照（调试/控制台可选）：不参与传输契约。 */
    function status() {
      return {
        botId,
        appId: credentials().appId,
        ready,
        startedAt,
        lastError,
        sessions: manager.size,
        stats: { ...stats },
        sender: sender && typeof sender.status === 'function' ? sender.status() : null,
      };
    }

    return {
      start,
      stop,
      status,
      // 只读调试句柄（host/控制台可选使用；不改变契约）
      get bot() { return instance; },
      get ready() { return ready; },
      /**
       * 工具层取用（lib/tools）：消息发送器（sender.js，含 sendCard/sendMarkdown/sendProactive）
       * 与媒体发送器（sendImage/sendVideo/sendVoice/sendFile）。按调用时现取，不缓存。
       */
      get messageSender() { return sender; },
      get mediaSender() { return mediaSender; },
    };
  };
}

export default createQqTransportFactory;
