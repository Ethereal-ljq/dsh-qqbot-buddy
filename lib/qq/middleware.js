/**
 * middleware —— QQBot SDK 中间件管线装配。
 *
 * 顺序（与 DESIGN.md 一致，关键点有注释）：
 *   1  errorHandler            兜底异常，避免一条坏消息打挂管线
 *   2  统计计数                 (自研) 记录 stats.received
 *   3  messageFilter           自回声/去重
 *   4  accessPolicy            开放 / 白名单 / 禁用
 *   5  historyBuffer           群历史缓冲（门控之前，未触发的消息也计入上下文）
 *   6  quoteRef                引用解析（mentionGate 的 replyProbe 依赖它先执行）
 *   7  mentionGate             passthrough，只标注 ctx.state.mention，不拦截
 *   8  contentSanitizer        去 @marker / 表情标签
 *   9  rateLimiter             三层限流
 *   10 命令中间件              频率门控之前处理命令并 stop（见 commands.js）
 *   11 frequencyGate           (自研) 调 gate.decide；不触发则 ctx.stop
 *   12 concurrencyGuard        同 peer 串行 + merge
 *   13 typingIndicator         私聊输入状态
 *   14 attachmentProcessor     只有触发的消息才下载富媒体（门控之后）
 */
import {
  errorHandler,
  messageFilter,
  accessPolicy,
  mentionGate,
  contentSanitizer,
  rateLimiter,
  concurrencyGuard,
  typingIndicator,
  quoteRef,
  historyBuffer,
  MemoryHistoryStore,
} from '@tencent-connect/qqbot-nodejs';
import { decide, recordSkip, recordTrigger } from './gate.js';

/** 创建群历史存储（一个插件实例共享一个，回复后清空用）。 */
export function createHistoryStore() {
  return new MemoryHistoryStore();
}

/** 群历史键：带 appId 前缀，多账号时不串味。 */
export function historyGroupKey(appId, groupId) {
  return String(appId || '') + ':' + String(groupId || '');
}

/** 清空某群历史（触发回复后调用，避免下次重复堆上下文）。 */
export function clearGroupHistory(store, appId, groupId) {
  if (!store || !groupId || typeof store.clear !== 'function') return;
  try {
    store.clear(historyGroupKey(appId, groupId));
  } catch {
    /* 历史清理失败不影响主流程 */
  }
}

/** 从入站消息推导 scope / peerId / peerKey（群聊用 groupOpenid，私聊用 senderId）。 */
export function peerInfo(message) {
  const msg = message || {};
  const scope = msg.kind === 'group' ? 'group' : 'c2c';
  const peerId = scope === 'group' ? (msg.groupOpenid || msg.senderId) : msg.senderId;
  return { scope, peerId, peerKey: scope + ':' + (peerId || '') };
}

/**
 * 回复机器人消息探针：quote 命中「机器人自己发过的消息」即视为在回复机器人。
 * 判定依据（任一命中）：
 *   - quote.entry.isBot === true（quoteRef 记录过带有 isBot 的条目）
 *   - quote.refKey / quote.entry.messageId 命中 outbound 维护的 sentTracker 消息 id 集合
 *   - quote.text 命中 sentTracker 记录过的发送文本（文本回退匹配）
 * 任何异常都降级为 false，绝不影响门控。
 */
export function createReplyProbe({ sentTracker } = {}) {
  return function replyProbe(ctx) {
    try {
      const quote = ctx && ctx.state ? ctx.state.quote : undefined;
      if (!quote) return false;
      if (quote.entry && quote.entry.isBot === true) return true;
      if (!sentTracker) return false;
      if (quote.refKey && sentTracker.hasId(quote.refKey)) return true;
      if (quote.entry && quote.entry.messageId && sentTracker.hasId(quote.entry.messageId)) return true;
      const candidates = [quote.text, quote.rawContent, quote.entry && quote.entry.content];
      for (const text of candidates) {
        if (typeof text === 'string' && sentTracker.hasText(text)) return true;
      }
      return false;
    } catch (err) {
      if (ctx && ctx.log && typeof ctx.log.debug === 'function') {
        ctx.log.debug('replyProbe 失败: ' + (err && err.message));
      }
      return false;
    }
  };
}

/**
 * 自研频率门控中间件：决定是否把消息交给下游 agent。
 * 不触发时 ctx.stop(frequency:<reason>)（消息已被 historyBuffer 记录，无需其它处理）。
 * adaptive 模式下 decision.buffer=true 的消息交给 AdaptiveScheduler 攒批后短路。
 */
export function createFrequencyGate({ settings, logger, gateState, stats, replyProbe, adaptive } = {}) {
  return async function frequencyGate(ctx, next) {
    const msg = ctx.message || {};
    const { scope, peerId, peerKey } = peerInfo(msg);
    const now = Date.now();

    let decision;
    try {
      const cfg = settings.get();
      const mention = ctx.state ? ctx.state.mention : undefined;
      const wasMentioned = !!(mention && mention.wasMentioned);
      let isReplyToBot = !!(mention && mention.implicit);
      if (!isReplyToBot && typeof replyProbe === 'function') {
        try {
          isReplyToBot = replyProbe(ctx) === true;
        } catch (err) {
          logger.debug('replyProbe 异常: ' + (err && err.message));
        }
      }
      decision = decide({
        settings: cfg,
        peerKey,
        scope,
        wasMentioned,
        isReplyToBot,
        content: typeof msg.content === 'string' ? msg.content : '',
        isCommand: false,
        now,
        lastReplyAt: gateState.lastReplyAt || stats.lastReplyAt || 0,
        state: gateState,
      });
    } catch (err) {
      // 门控自身故障时放行：宁可多回一条，也不能静默吞掉用户消息
      logger.error('频率门控异常，本条消息放行: ' + (err && err.message));
      decision = { trigger: true, buffer: false, reason: 'mode', forced: false, resetPending: false };
    }

    if (!decision.trigger) {
      stats.skipped = (Number(stats.skipped) || 0) + 1;
      // 自适应模式：交给 scheduler 攒批（不累计 gate pending，批次由 scheduler 维护）
      if (decision.buffer === true) {
        try {
          if (adaptive && typeof adaptive.buffer === 'function') adaptive.buffer(ctx);
          else logger.warn('adaptive 模式缺少 scheduler，本条消息被丢弃');
        } catch (err) {
          logger.warn('adaptive buffer 失败: ' + (err && err.message));
        }
        logger.debug('频率门控缓冲 ' + peerKey + '（adaptive）');
        ctx.stop('frequency:adaptive');
        return;
      }
      // 只有「本可以进入模式决策」的跳过才累计 pending；disabled（总开关/群聊关闭）
      // 不累计，避免重新开启后旧消息一次性触发 count。
      if (decision.reason !== 'disabled') recordSkip(gateState, peerKey, now);
      logger.debug('频率门控跳过 ' + peerKey + '（' + decision.reason + '）');
      ctx.stop('frequency:' + decision.reason);
      return;
    }

    stats.triggered = (Number(stats.triggered) || 0) + 1;
    stats.lastTriggerReason = decision.reason;
    recordTrigger(gateState, peerKey, now, decision.reason);
    if (ctx.state) {
      ctx.state.triggerReason = decision.reason;
      ctx.state.forced = decision.forced;
      ctx.state.frequencyDecision = decision;
    }
    // 立即回复（强制触发或其它模式触发）后清空该 peer 的 adaptive 缓冲并进入冷却，
    // 避免刚回复完又攒一批马上再回。
    if (adaptive && typeof adaptive.noteForcedTrigger === 'function') {
      try {
        adaptive.noteForcedTrigger(peerKey);
      } catch (err) {
        logger.warn('adaptive noteForcedTrigger 失败: ' + (err && err.message));
      }
    }
    await next();
  };
}

/**
 * 装配全部中间件。
 * @param {object} bot QQBot 实例
 * @param {object} deps
 * @param {object} deps.config 部署配置
 * @param {object} deps.settings settings-store
 * @param {object} deps.logger 日志对象
 * @param {object} deps.gateState createGateState() 实例
 * @param {object} deps.stats 统计对象
 * @param {object} deps.sentTracker outbound 维护的已发送消息跟踪器
 * @param {object} deps.historyStore 群历史存储
 * @param {Function} deps.commandMiddleware 命令中间件
 * @param {Function} deps.attachmentMiddleware 附件下载中间件
 * @param {Function} deps.replyProbe 回复机器人探针
 * @param {object} deps.adaptive AdaptiveScheduler（adaptive 模式攒批；可选）
 */
export function setupMiddlewares(bot, deps) {
  const {
    config = {},
    settings,
    logger,
    gateState,
    stats,
    sentTracker,
    commandMiddleware,
    attachmentMiddleware,
    replyProbe,
  } = deps || {};

  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 统计：所有进入管线的消息都计数（含后续被门控跳过的）
  bot.use(async (_ctx, next) => {
    try {
      stats.received = (Number(stats.received) || 0) + 1;
    } catch {
      /* 统计失败不影响消息处理 */
    }
    await next();
  });

  // 3. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter({ skipSelfEcho: false }));

  // 4. 访问控制
  // 注意：SDK 的 allowlist 语义是「allow 为空 => 拒绝所有」，因此不能在 allowlist 模式下
  // 用 ['*'] 兜底（那会把 allowlist 变成 open，反而放行所有人）。只有 open 模式才传 ['*']。
  const access = config.access && typeof config.access === 'object' ? config.access : {};
  const allowList = (input) => (Array.isArray(input) ? input.filter((item) => typeof item === 'string' && item.trim() !== '') : []);
  const c2cMode = access.c2cMode || 'open';
  const groupMode = access.groupMode || 'open';
  const c2cAllow = allowList(access.c2cAllow);
  const groupAllow = allowList(access.groupAllow);
  if (c2cMode === 'allowlist' && c2cAllow.length === 0) {
    logger.warn('访问控制：c2cMode=allowlist 但 c2cAllow 为空，所有私聊都会被拒绝');
  }
  if (groupMode === 'allowlist' && groupAllow.length === 0) {
    logger.warn('访问控制：groupMode=allowlist 但 groupAllow 为空，所有群消息都会被拒绝');
  }
  bot.use(accessPolicy({
    c2c: {
      mode: c2cMode,
      allow: c2cMode === 'open' ? ['*'] : c2cAllow,
    },
    group: {
      mode: groupMode,
      allow: groupMode === 'open' ? ['*'] : groupAllow,
    },
    onBlock: (_mCtx, reason) => {
      logger.debug('访问控制拦截: ' + reason);
    },
  }));

  // 5. 群历史缓冲：放在门控之前，未 @bot 的消息也要进上下文
  const historyLimit = Number(config.historyLimit) > 0 ? Number(config.historyLimit) : 20;
  bot.use(historyBuffer({
    limit: historyLimit,
    store: deps.historyStore,
    recordOnSkip: true,
    groupKey: (ctx) => {
      const msg = ctx.message || {};
      if (msg.kind !== 'group' || !msg.groupOpenid) return undefined;
      return historyGroupKey(config.appId, msg.groupOpenid);
    },
  }));

  // 6. 引用解析：必须在 mentionGate 之前，replyProbe 才能读到 ctx.state.quote
  bot.use(quoteRef({ maxSize: 500, preferMsgElements: true }));

  // 7. @ 门控：只标注，不拦截（真正回不回由频率门控决定）
  bot.use(mentionGate({
    requireMentionInGroup: false,
    passthrough: true,
    isImplicitMention: typeof replyProbe === 'function' ? replyProbe : undefined,
  }));

  // 8. 内容清洗：去 @marker、表情标签、多余空白
  bot.use(contentSanitizer({ parseFaceTags: true }));

  // 9. 三层限流
  bot.use(rateLimiter());

  // 10. 命令处理：频率门控之前，命中命令直接响应并短路
  if (typeof commandMiddleware === 'function') bot.use(commandMiddleware);

  // 11. 频率门控
  bot.use(createFrequencyGate({ settings, logger, gateState, stats, replyProbe, adaptive: deps.adaptive }));

  // 12. 同 peer 串行 + 消息合并，避免同一会话并发 followup
  bot.use(concurrencyGuard({
    strategy: 'merge',
    maxQueue: Number(config.maxQueue) > 0 ? Number(config.maxQueue) : 20,
    maxProcessingMs: Number(config.processingTimeoutMs) > 0 ? Number(config.processingTimeoutMs) : 30 * 60 * 1000,
  }));

  // 13. 私聊输入状态
  bot.use(typingIndicator());

  // 14. 附件下载：只有触发到这里的消息才下载（频率门控之后）
  if (typeof attachmentMiddleware === 'function') bot.use(attachmentMiddleware);
}
