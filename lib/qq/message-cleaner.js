/**
 * message-cleaner —— 消息流水的保留期清理（对话轮次 + 全量群消息）。
 *
 * 消息量最大的来源是刷屏群（实测单群每天可达上千条），不清理会让 buddy.db 很快膨胀。
 * 保留天数由 settings.messages.retainDays / settings.messages.flowRetainDays 控制
 * （默认都是 14 天 = 两周），与 media-cleaner 同一套模式：
 * 启动时清一次，之后每天清一次，插件卸载时停表。
 */

/** 默认保留天数：两周。与 core/messages/store.js 的 DEFAULT_RETAIN_DAYS 保持一致。 */
export const DEFAULT_RETAIN_DAYS = 14;
/** 清理间隔：1 天（消息量大但清理本身很便宜，不需要更频繁）。 */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 执行一次清理。
 * @param {object} args
 * @param {object} [args.messages] createMessagesStore() 返回的 store
 * @param {object} [args.flow] createFlowStore() 返回的 store（全量群消息流水）
 * @param {number} [args.retainDays]
 * @param {number} [args.flowRetainDays]
 * @param {object} [args.logger]
 * @returns {Promise<{removed:number, cutoff:number, flowRemoved:number, flowCutoff:number}>}
 */
export async function cleanupExpiredMessages({
  messages,
  flow,
  retainDays = DEFAULT_RETAIN_DAYS,
  flowRetainDays = DEFAULT_RETAIN_DAYS,
  logger,
} = {}) {
  const empty = { removed: 0, cutoff: 0, flowRemoved: 0, flowCutoff: 0 };
  const days = Number(retainDays);
  if (!Number.isFinite(days) || days <= 0) return empty;

  let result = { removed: 0, cutoff: 0 };
  if (messages && typeof messages.cleanup === 'function') {
    try {
      result = messages.cleanup({ retainDays: Math.floor(days) }) || { removed: 0, cutoff: 0 };
      if (result.removed > 0) {
        logger?.info?.('已清理 ' + result.removed + ' 条过期消息（保留 ' + Math.floor(days) + ' 天）');
      }
    } catch (err) {
      logger?.warn?.('消息流水清理失败: ' + (err && err.message));
    }
  }

  let flowResult = { removed: 0, cutoff: 0 };
  const flowDays = Number(flowRetainDays);
  if (flow && typeof flow.cleanup === 'function' && Number.isFinite(flowDays) && flowDays > 0) {
    try {
      flowResult = flow.cleanup({ retainDays: Math.floor(flowDays) }) || { removed: 0, cutoff: 0 };
      if (flowResult.removed > 0) {
        logger?.info?.('已清理 ' + flowResult.removed + ' 条过期群消息流水（保留 ' + Math.floor(flowDays) + ' 天）');
      }
    } catch (err) {
      logger?.warn?.('群消息流水清理失败: ' + (err && err.message));
    }
  }

  return {
    removed: result.removed || 0,
    cutoff: result.cutoff || 0,
    flowRemoved: flowResult.removed || 0,
    flowCutoff: flowResult.cutoff || 0,
  };
}

/**
 * 启动消息流水清理：启动时清一次 + 每 24h 清一次。
 * @param {object} ctx cordis 插件上下文（用于 ctx.effect 生命周期；可为 null）
 * @param {object} args
 * @param {object} [args.messages] createMessagesStore() 返回的 store
 * @param {object} [args.flow] createFlowStore() 返回的 store
 * @param {number} [args.retainDays]
 * @param {number} [args.flowRetainDays]
 * @param {object} [args.logger]
 * @returns {Function} stop()
 */
export function startMessageCleanup(ctx, {
  messages,
  flow,
  retainDays = DEFAULT_RETAIN_DAYS,
  flowRetainDays = DEFAULT_RETAIN_DAYS,
  logger,
} = {}) {
  const hasMessages = messages && typeof messages.cleanup === 'function';
  const hasFlow = flow && typeof flow.cleanup === 'function';
  if (!hasMessages && !hasFlow) return () => {};
  const days = Number(retainDays);
  if (hasMessages && (!Number.isFinite(days) || days <= 0)) return () => {};

  const runOnce = () => {
    cleanupExpiredMessages({ messages, flow, retainDays: days, flowRetainDays, logger }).catch(() => {});
  };
  runOnce();
  logger?.info?.('消息流水清理已启动 (保留 ' + Math.floor(days) + ' 天'
    + (hasFlow ? '，群消息流水保留 ' + Math.floor(Number(flowRetainDays) || DEFAULT_RETAIN_DAYS) + ' 天' : '')
    + ')');

  let timer = setInterval(runOnce, CLEANUP_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  let stopped = false;

  /** 停止清理定时器（重复调用幂等）。 */
  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => stop(), 'qqbot-buddy.message-cleanup');
    } catch (err) {
      logger?.warn?.('注册消息清理生命周期失败: ' + (err && err.message));
    }
  }
  return stop;
}

export default startMessageCleanup;
