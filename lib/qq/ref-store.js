/**
 * ref-store —— 自管的消息引用索引（msgIdx -> 精简 entry）。
 *
 * 为什么需要：SDK 的 quoteRef 中间件在解析引用时有两条路径：
 *   - store 命中     -> 带 entry（有 senderName / senderId / isBot）
 *   - msg_elements   -> 只有内容和附件，**没有任何作者信息**
 * 而且 msg_elements 优先级更高（preferMsgElements: true），于是
 * 「引用一条图片消息」时会走 msg_elements，作者信息被整个丢掉，
 * 最终只能渲染成「[引用 某位群友 的消息]」——模型只能靠上下文猜是谁发的。
 *
 * 真实案例（2026-11-11 20:26）：有人引用一张表情包说「把这个换成猪头」，
 * 引用作者显示为「某位群友」；而上一句恰好是「院：那我要一群男娘」，
 * 模型就把图里的角色归给了院长。
 *
 * 解法：把同一个 store 实例交给 quoteRef（写入用），自己也留一份（读取用），
 * 在 quoteRef 之后的中间件里把丢失的 entry 补回去。
 */

/** 默认容量：与 quoteRef 的 maxSize 对齐。 */
export const DEFAULT_REF_STORE_SIZE = 500;

/**
 * 创建引用索引 store（满足 quoteRef 的 RefIndexStore 接口：get/set）。
 * @param {{maxSize?: number}} [options]
 */
export function createRefStore({ maxSize = DEFAULT_REF_STORE_SIZE } = {}) {
  const limit = Math.max(1, Math.floor(Number(maxSize)) || DEFAULT_REF_STORE_SIZE);
  const map = new Map();
  return {
    get(key) {
      return map.get(String(key));
    },
    set(key, entry) {
      const k = String(key);
      // Map 的插入顺序即 LRU 顺序：命中时先删再插，保证最新在最前
      if (map.has(k)) map.delete(k);
      map.set(k, entry);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
  };
}

/**
 * 中间件：把 ref store 里还留着的作者信息补回 ctx.state.quote。
 *
 * 必须挂在 quoteRef 之后：quoteRef 已经解析好 quote（可能是 msg_elements 路径），
 * 这里只在「没有 entry」时补一次，不覆盖 SDK 已经给出的内容。
 * 任何异常都吞掉，绝不影响消息处理链路。
 *
 * @param {object} refStore createRefStore() 的返回值
 * @returns {(ctx: object, next: Function) => Promise<void>}
 */
export function createQuoteEnricher(refStore) {
  return async function quoteEnricher(ctx, next) {
    try {
      const state = ctx && ctx.state;
      const quote = state && state.quote;
      if (quote && !quote.entry && quote.refKey && refStore && typeof refStore.get === 'function') {
        const entry = refStore.get(quote.refKey);
        if (entry && typeof entry === 'object') {
          quote.entry = entry;
          ctx.log?.debug?.('[quote-enrich] 补回被引用者信息 key=' + quote.refKey);
        }
      }
    } catch (err) {
      ctx.log?.debug?.('[quote-enrich] 失败: ' + (err && err.message));
    }
    await next();
  };
}

export default createRefStore;