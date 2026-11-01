/**
 * sender —— 统一的 QQ 消息发送器。
 *
 * 为什么需要：插件原来只有一条路——`bot.sendMarkdown(target, chunk)`，失败去掉
 * msg_id 再试一次主动。这既不区分错误码（内容违规也会再发一条主动消息），也不
 * 记被动回复次数（单聊 4 次 / 群聊 5 次），主动兜底还没有频控。
 *
 * 本模块负责：
 *   1) 被动回复预算：复用 SDK `ReplyLimiter`（单聊 4 次/60min、群聊 5 次/5min，可配），
 *      用满直接走主动，不再白撞一次 40034128；
 *   2) 错误码分类（error-codes.js）：窗口/次数→主动；markdown 权限/格式→纯文本重发；
 *      去重→换 msg_seq 重试一次；频控/瞬时→退避；永久错误→放弃；
 *   3) 主动消息治理：单关系 20/min、1000/天，Bot 维度 10/s（可配未认证 5/s）；
 *   4) 引用回复：被动首条带 `message_reference`（入站 replyTarget.refIdx）；
 *   5) 统计：passive/proactive/degraded/failed 与最近失败，供设置页概览。
 *
 * 多机器人：一个 sender 实例对应一个 QQBot；budgets 由 gateway 按 bot 持有并跨重连
 * 保留（重连后同一 msg_id 的已用次数不能清零）。
 */
import { ReplyLimiter } from '@tencent-connect/qqbot-nodejs/protocol';
import {
  SEND_ERROR,
  classifySendError,
  isMarkdownPermission,
  shouldDegradeToPlain,
  isDedupeError,
  isPassiveExpired,
} from './error-codes.js';

/** 被动回复额度（按 QQ 文档；单聊 60min 与字段说明的 5min 冲突，先按页首 60min）。 */
export const DEFAULT_REPLY_LIMITS = {
  c2c: { limit: 4, ttlMs: 60 * 60 * 1000 },
  group: { limit: 5, ttlMs: 5 * 60 * 1000 },
};

/** 主动消息频控（文档：单关系 20/qpm、1000/天；Bot 10/qps（未认证 5/qps+30/qpm））。 */
export const DEFAULT_PROACTIVE_LIMITS = {
  perTargetPerMinute: 20,
  perTargetPerDay: 1000,
  botPerSecond: 10,
  maxWaitMs: 60_000,
};

const MAX_RECENT_FAILURES = 20;

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 生成一个与上一次不同、且在 0..65535 内的 msg_seq。 */
export function nextMsgSeq() {
  return Math.floor(Math.random() * 65535) + 1;
}

/** 主动消息等待失败（排队过久/日限额已满）。 */
export class ProactiveGateError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ProactiveGateError';
    this.code = code;
  }
}

/**
 * 主动消息限速闸门：per-target 滑动窗口 + 每日上限 + Bot 全局每秒上限。
 * 超限时等待；等待超过 maxWaitMs 抛 RATE_WAIT_TIMEOUT；日限额满了抛 DAILY_LIMIT。
 */
export function createProactiveGate(options = {}) {
  const config = { ...DEFAULT_PROACTIVE_LIMITS, ...(options || {}) };
  const targets = new Map();
  let second = { at: 0, count: 0 };
  const now = typeof options.now === 'function' ? options.now : Date.now;

  function dayKey(nowMs) {
    const d = new Date(nowMs);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function targetRecord(key, nowMs) {
    let record = targets.get(key);
    const keyDay = dayKey(nowMs);
    if (!record || record.day !== keyDay) {
      record = { day: keyDay, count: 0, minute: [] };
      targets.set(key, record);
    }
    // 只保留最近 60s
    record.minute = record.minute.filter((ts) => nowMs - ts < 60_000);
    return record;
  }

  async function waitSlot(targetKey) {
    const startedAt = now();
    const key = String(targetKey || '');
    for (;;) {
      const nowMs = now();
      const record = targetRecord(key, nowMs);
      if (record.count >= config.perTargetPerDay) {
        throw new ProactiveGateError('DAILY_LIMIT', '该用户/群今日主动消息已达上限（' + config.perTargetPerDay + ' 条）');
      }
      const currentSecond = Math.floor(nowMs / 1000);
      if (second.at !== currentSecond) second = { at: currentSecond, count: 0 };
      const waitMinute = record.minute.length >= config.perTargetPerMinute
        ? record.minute[0] + 60_000 - nowMs
        : 0;
      const waitSecond = second.count >= config.botPerSecond
        ? 1000 - (nowMs % 1000)
        : 0;
      const wait = Math.max(waitMinute, waitSecond, 0);
      if (wait <= 0) break;
      if (nowMs - startedAt >= config.maxWaitMs) {
        throw new ProactiveGateError('RATE_WAIT_TIMEOUT', '主动消息排队超时（' + config.maxWaitMs + 'ms）');
      }
      await sleep(Math.min(wait, 250));
    }
    const record = targetRecord(key, now());
    record.minute.push(now());
    record.count += 1;
    const currentSecond = Math.floor(now() / 1000);
    if (second.at !== currentSecond) second = { at: currentSecond, count: 0 };
    second.count += 1;
  }

  return {
    /** 占一个主动消息配额，然后执行 fn。 */
    async run(targetKey, fn) {
      await waitSlot(String(targetKey || ''));
      return fn();
    },
    stats() {
      return { targets: targets.size, botSecondCount: second.count };
    },
    reset() {
      targets.clear();
      second = { at: 0, count: 0 };
    },
  };
}

/**
 * 创建发送器。
 * @param {object} deps
 * @param {Function} deps.getBot 返回当前 QQBot（重连后自动跟随）
 * @param {object} [deps.logger]
 * @param {object} [deps.settings] settings-store（读 reply.quoteReply / reply.proactiveFallback）
 * @param {Map} [deps.budgets] 按 scope 复用的 ReplyLimiter（跨重连保留）；不传则内部新建
 * @param {object} [deps.limits] 覆盖 DEFAULT_REPLY_LIMITS
 * @param {object} [deps.proactive] 覆盖 DEFAULT_PROACTIVE_LIMITS
 */
export function createSender(deps = {}) {
  const { getBot, logger, settings, stats } = deps;
  const log = logger || console;
  const limits = {
    c2c: { ...DEFAULT_REPLY_LIMITS.c2c, ...(deps.limits && deps.limits.c2c) },
    group: { ...DEFAULT_REPLY_LIMITS.group, ...(deps.limits && deps.limits.group) },
  };
  const budgets = deps.budgets instanceof Map ? deps.budgets : new Map();
  const gate = createProactiveGate(deps.proactive || {});
  const counters = {
    passive: 0, proactive: 0, degraded: 0, dedupeRetry: 0, failed: 0, dropped: 0,
  };
  const recentFailures = [];
  const deadPassive = new Map(); // msgId -> 失效时间戳（窗口过期/次数用尽后不再尝试被动）
  let markdownUsable = true;

  function botNow() {
    return typeof getBot === 'function' ? getBot() : undefined;
  }

  function readSettings() {
    try {
      return (settings && typeof settings.get === 'function' ? settings.get() : null) || {};
    } catch {
      return {};
    }
  }

  function proactiveFallbackEnabled() {
    const reply = readSettings().reply || {};
    return reply.proactiveFallback !== false;
  }

  function scopeOf(target) {
    return target && target.scope === 'group' ? 'group' : 'c2c';
  }

  function targetKey(target) {
    return scopeOf(target) + ':' + String((target && target.targetId) || '');
  }

  function budgetFor(scope) {
    let budget = budgets.get(scope);
    if (!budget) {
      budget = new ReplyLimiter(limits[scope]);
      budgets.set(scope, budget);
    }
    return budget;
  }

  function passiveAllowed(target) {
    const msgId = target && target.msgId;
    if (!msgId) return false;
    const deadAt = deadPassive.get(msgId);
    if (deadAt && deadAt > Date.now()) return false;
    try {
      return budgetFor(scopeOf(target)).checkLimit(msgId).allowed === true;
    } catch {
      return true;
    }
  }

  function markPassiveDead(target, ttlMs) {
    if (!target || !target.msgId) return;
    deadPassive.set(target.msgId, Date.now() + (ttlMs || 10 * 60 * 1000));
    if (deadPassive.size > 2000) {
      const now = Date.now();
      for (const [key, at] of deadPassive) {
        if (at <= now) deadPassive.delete(key);
      }
    }
  }

  function noteFailure(meta) {
    recentFailures.unshift({ at: Date.now(), ...meta });
    if (recentFailures.length > MAX_RECENT_FAILURES) recentFailures.length = MAX_RECENT_FAILURES;
    counters.failed += 1;
    if (stats && typeof stats === 'object') {
      stats.sendFailures = (Number(stats.sendFailures) || 0) + 1;
    }
  }

  /**
   * 底层发送：优先用 `bot.send()`（可带 messageReference / extra），
   * 兼容老 bot / 测试 fake（只有 sendMarkdown / sendText）。
   */
  async function rawSend(bot, target, payload, extra = {}) {
    const bodyTarget = extra.proactive
      ? { scope: target.scope, targetId: target.targetId }
      : target;
    const opts = { target: bodyTarget };
    if (payload.card) {
      // 注意：SDK 的 QQBot.send() 没有 card 字段（会静默忽略），必须走 extra 透传；
      // 否则线上只发出 msg_type=8 而没有 card，会被平台以 22006/304061 拒绝。
      opts.msgType = 8;
      opts.extra = Object.assign({}, opts.extra, { card: payload.card });
    } else if (payload.markdown !== undefined) {
      opts.msgType = 2;
      opts.markdown = { content: payload.markdown };
    } else {
      opts.msgType = 0;
      opts.content = payload.content;
    }
    if (!extra.proactive && extra.quote && target.refIdx) {
      opts.messageReference = { message_id: target.refIdx };
    }
    if (extra.eventId) {
      opts.extra = Object.assign({}, opts.extra, { event_id: extra.eventId });
    }
    if (extra.msgSeq !== undefined) {
      opts.extra = Object.assign({}, opts.extra, { msg_seq: extra.msgSeq });
    }

    if (typeof bot.send === 'function') return bot.send(opts);
    // 兼容路径（老 SDK / 测试 fake）：卡片只能走 bot.send，缺少时抛错由上层降级纯文本
    if (payload.card) throw new Error('QQBot 不支持发送图文卡片（缺少 send()）');
    const text = payload.markdown !== undefined ? payload.markdown : String(payload.content ?? '');
    if (typeof bot.sendMarkdown === 'function') return bot.sendMarkdown(bodyTarget, text);
    if (typeof bot.sendText === 'function') return bot.sendText(bodyTarget, text);
    throw new Error('QQBot 不支持发送消息（缺少 send/sendMarkdown）');
  }

  function payloadFor(mode, text, card) {
    if (mode === 'card' && card) return { card };
    return mode === 'markdown' && markdownUsable ? { markdown: text } : { content: text };
  }

  /** 统一成 QQ 图文卡片结构（tuwen）。 */
  function normalizeCard(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const pick = (value) => (typeof value === 'string' ? value.trim() : '');
    const title = pick(raw.title);
    const description = pick(raw.description);
    const url = pick(raw.url);
    const picUrl = pick(raw.pic_url) || pick(raw.picUrl);
    if (!title || !description || !url) return undefined;
    const content = { title, description, url };
    if (picUrl) content.pic_url = picUrl;
    return { type: 'tuwen', content };
  }

  function fail(code, extra = {}) {
    return { ok: false, code, ...extra };
  }

  /**
   * 发送主流程：被动优先，按错误码决定降级/重试/放弃。
   * @param {object} target {scope,targetId,msgId?,refIdx?}
   * @param {string} text
   * @param {object} [opts]
   * @param {'markdown'|'plain'} [opts.mode]
   * @param {boolean} [opts.quote] 首条是否引用（需 target.refIdx；由模型通过 qqbot_quote_reply 决定）
   * @param {boolean} [opts.forceProactive]
   * @param {string} [opts.eventId] 事件被动回复（与 msg_id 互斥）
   * @returns {Promise<{ok:boolean, result?:any, mode?:string, degraded?:boolean, code?:string, category?:string, error?:string, attempts?:number}>}
   */
  async function send(target, text, opts = {}) {
    const body = typeof text === 'string' ? text : String(text ?? '');
    const wantsCard = opts.mode === 'card';
    const cardPayload = wantsCard ? normalizeCard(opts.card) : undefined;
    if (wantsCard && !cardPayload) return fail('INVALID_CARD');
    if (!body.trim() && !cardPayload) return fail('EMPTY');
    const bot = botNow();
    if (!bot) return fail('NO_BOT');
    if (!target || !target.targetId) return fail('NO_TARGET');

    const scope = scopeOf(target);
    const wantsMarkdown = opts.mode !== 'plain';
    let mode = wantsCard ? 'card' : (wantsMarkdown && markdownUsable ? 'markdown' : 'plain');
    let cardFallbackTried = false;
    let degradedReason = '';
    const eventMode = !!opts.eventId;
    const forceProactive = opts.forceProactive === true || eventMode;
    let usePassive = !forceProactive && passiveAllowed(target);
    // 引用由调用方决定（outbound 依据模型是否调用 qqbot_quote_reply 传入），sender 只负责发送
    let quotePending = !!opts.quote;
    let dedupeRetried = false;
    let proactiveRetried = false;

    if (!usePassive && !forceProactive && !proactiveFallbackEnabled()) {
      counters.dropped += 1;
      return fail('PASSIVE_EXHAUSTED');
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
      // event_id 回复既不是普通被动（无 msg_id 预算）也不是主动：单独走一次，
      // 失败就放弃（事件类错误多为 40034026/40034027，重试无意义）。
      const proactive = !usePassive && !eventMode;
      const payload = payloadFor(mode, body, cardPayload);
      try {
        const result = proactive
          ? await gate.run(targetKey(target), () => rawSend(bot, target, payload, { proactive: true }))
          : await rawSend(bot, target, payload, {
            quote: quotePending,
            eventId: opts.eventId,
          });
        if (!proactive && !opts.eventId) {
          try {
            budgetFor(scope).record(target.msgId);
          } catch {
            /* 预算记录失败不影响已发送结果 */
          }
        }
        counters[proactive ? 'proactive' : 'passive'] += 1;
        return {
          ok: true,
          result,
          mode: proactive ? 'proactive' : 'passive',
          degraded: mode === 'plain' && (wantsMarkdown || wantsCard),
          ...(mode === 'plain' && degradedReason ? { degradedReason } : {}),
          attempts: attempt + 1,
        };
      } catch (err) {
        // 主动消息排队被限速闸门拒绝：直接返回原因（日限额/排队超时），不再重试
        if (err && err.name === 'ProactiveGateError') {
          counters.dropped += 1;
          return fail(err.code || 'PROACTIVE_BLOCKED', { category: 'rate_limit', error: errText(err) });
        }
        const cls = classifySendError(err);
        noteFailure({
          scope,
          targetId: target.targetId,
          mode: proactive ? 'proactive' : 'passive',
          category: cls.category,
          code: cls.code,
          error: cls.message,
        });
        log.warn('发送失败 [' + cls.category + (cls.code !== undefined ? '/' + cls.code : '') + ']: ' + cls.message);

        // 0) 引用回复本身导致格式错误（旧客户端/平台兼容）：去掉引用重试一次
        if (cls.category === SEND_ERROR.FORMAT && quotePending) {
          log.warn('引用回复被拒绝，去掉 message_reference 重试: ' + cls.message);
          quotePending = false;
          continue;
        }

        // 0.5) 图文卡片发送失败（内容/权限/客户端不支持）：降级为纯文本（标题+摘要+链接），
        //      保证信息必达；窗口/频控错误仍走主动重试，不在这里降级。
        if (mode === 'card' && !cardFallbackTried
          && cls.category !== SEND_ERROR.WINDOW && cls.category !== SEND_ERROR.RATE_LIMIT) {
          cardFallbackTried = true;
          counters.degraded += 1;
          degradedReason = cls.code !== undefined ? String(cls.code) : cls.category;
          log.warn('图文卡片发送失败，降级为纯文本: ' + cls.message);
          mode = 'plain';
          continue;
        }

        // 1) markdown 权限/格式：改纯文本重发（被动优先，次数够就还走被动）
        if (shouldDegradeToPlain(cls) && mode === 'markdown') {
          counters.degraded += 1;
          degradedReason = cls.code !== undefined ? String(cls.code) : cls.category;
          if (isMarkdownPermission(cls)) {
            markdownUsable = false;
            log.warn('该机器人 Markdown 不可用，后续消息改纯文本');
          }
          mode = 'plain';
          continue;
        }

        // 2) 去重：同一 msg_id 换 msg_seq 重试一次
        if (isDedupeError(cls) && !proactive && !dedupeRetried) {
          dedupeRetried = true;
          counters.dedupeRetry += 1;
          try {
            const result = await rawSend(bot, target, payload, { quote: quotePending, msgSeq: nextMsgSeq() });
            try {
              budgetFor(scope).record(target.msgId);
            } catch {
              /* ignore */
            }
            counters.passive += 1;
            return { ok: true, result, mode: 'passive', dedupeRetry: true, attempts: attempt + 1 };
          } catch (retryErr) {
            const retryCls = classifySendError(retryErr);
            noteFailure({
              scope,
              targetId: target.targetId,
              mode: 'passive',
              category: retryCls.category,
              code: retryCls.code,
              error: retryCls.message,
            });
            if (!isPassiveExpired(retryCls)) {
              return fail(String(retryCls.code ?? retryCls.category), {
                category: retryCls.category,
                error: retryCls.message,
              });
            }
          }
        }

        // event_id 回复失败：直接放弃，不转主动（避免欢迎语变成骚扰）
        if (eventMode) {
          counters.dropped += 1;
          return fail(String(cls.code ?? cls.category), { category: cls.category, error: cls.message });
        }

        // 3) 被动凭证失效/频控/瞬时/未知：标记该 msg_id 失效，转主动
        if (!proactive && isPassiveExpired(cls)) {
          if (cls.category === SEND_ERROR.WINDOW) markPassiveDead(target, limits[scope].ttlMs);
          if (!proactiveFallbackEnabled()) {
            counters.dropped += 1;
            return fail(String(cls.code ?? cls.category), { category: cls.category, error: cls.message });
          }
          usePassive = false;
          continue;
        }

        // 4) 主动消息：频控/瞬时错误退避后重试一次
        if (proactive && (cls.category === SEND_ERROR.RATE_LIMIT
          || cls.category === SEND_ERROR.TRANSIENT || cls.category === SEND_ERROR.NETWORK)
          && !proactiveRetried) {
          proactiveRetried = true;
          await sleep(1200);
          continue;
        }

        // 5) 其余（永久错误 / 主动也失败）：放弃，不刷重试
        return fail(String(cls.code ?? cls.category), { category: cls.category, error: cls.message });
      }
    }

    return fail('EXHAUSTED');
  }

  return {
    /** 发送 Markdown（被动优先）；返回结构化结果，不抛异常。 */
    async sendMarkdown(target, text, opts = {}) {
      return send(target, text, { ...opts, mode: 'markdown' });
    },
    /** 发送纯文本（msg_type=0）。 */
    async sendPlain(target, text, opts = {}) {
      return send(target, text, { ...opts, mode: 'plain' });
    },
    /**
     * 发送 QQ 图文卡片（msg_type=8，tuwen）。
     * 卡片失败（内容/权限）自动降级为纯文本（标题+摘要+链接）；窗口/频控错误照常走主动重试。
     * @param {object} target {scope,targetId,msgId?,refIdx?}
     * @param {{title:string,description:string,url:string,pic_url?:string}} card
     * @param {object} [opts]
     */
    async sendCard(target, card, opts = {}) {
      const fallbackText = typeof opts.fallbackText === 'string' && opts.fallbackText.trim()
        ? opts.fallbackText
        : [card && card.title, card && card.description, card && card.url]
          .filter((part) => typeof part === 'string' && part.trim() !== '')
          .join('\n');
      return send(target, fallbackText, { ...opts, mode: 'card', card });
    },
    /** 主动推送（无 msg_id）；欢迎语/提醒/召回用。 */
    async sendProactive(target, text, opts = {}) {
      return send(target, text, { ...opts, forceProactive: true, quote: false, mode: opts.mode || 'markdown' });
    },
    /** 事件被动回复（event_id，与 msg_id 互斥；不支持则自动放弃）。 */
    async sendEvent(target, eventId, text, opts = {}) {
      if (!eventId) return fail('NO_EVENT_ID');
      return send(target, text, { ...opts, eventId, quote: false, mode: opts.mode || 'plain' });
    },
    /** 当前发送统计（概览页/状态接口用）。 */
    status() {
      return {
        markdownUsable,
        counters: { ...counters },
        passiveDead: deadPassive.size,
        proactive: gate.stats(),
        recentFailures: recentFailures.slice(0, 5),
      };
    },
  };
}

export default createSender;
