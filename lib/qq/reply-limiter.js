/**
 * reply-limiter —— 被动回复额度计数器（v2 自带实现）。
 *
 * 从 `@tencent-connect/qqbot-nodejs/protocol` 的 ReplyLimiter 逐行移植（该子路径在
 * 1.0.x 导出；这里 vendored 一份，保证「SDK 未安装 / 测试环境」也能加载 sender）。
 * 行为对齐：
 *   - 单条入站消息可被动回复 limit 次（默认 4），首次回复起 ttlMs 内有效；
 *   - 窗口过期 -> fallbackReason='expired'；次数用尽 -> 'limit_exceeded'；
 *   - 跟踪表超过 maxTrackedMessages 时按 TTL 机会式淘汰。
 *
 * 生产环境 gateway 仍会注入 SDK 的 ReplyLimiter（见 gateway.js），行为完全一致；
 * 这个文件只作为无 SDK 时的回落实现，不改变协议语义。
 */

/** 单条消息默认最多被动回复 4 次。 */
const DEFAULT_LIMIT = 4;
/** 被动回复窗口默认 1 小时。 */
const DEFAULT_TTL_MS = 60 * 60 * 1000;
/** 跟踪表默认容量上限。 */
const DEFAULT_MAX_TRACKED = 10_000;

export class ReplyLimiter {
  constructor(config = {}) {
    this.limit = Number.isFinite(config.limit) ? config.limit : DEFAULT_LIMIT;
    this.ttlMs = Number.isFinite(config.ttlMs) ? config.ttlMs : DEFAULT_TTL_MS;
    this.maxTracked = Number.isFinite(config.maxTrackedMessages) ? config.maxTrackedMessages : DEFAULT_MAX_TRACKED;
    this.tracker = new Map();
  }

  /** 是否还能对这条消息发被动回复。 */
  checkLimit(messageId) {
    const now = Date.now();
    this.evictIfNeeded(now);
    const record = this.tracker.get(messageId);
    if (!record) {
      return { allowed: true, remaining: this.limit, shouldFallbackToProactive: false };
    }
    if (now - record.firstReplyAt > this.ttlMs) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: 'expired',
        message: 'Message is older than ' + this.ttlMs / (60 * 60 * 1000) + 'h; sending as a proactive message instead',
      };
    }
    const remaining = this.limit - record.count;
    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        shouldFallbackToProactive: true,
        fallbackReason: 'limit_exceeded',
        message: 'Passive reply limit reached (' + this.limit + ' per hour); sending proactively instead',
      };
    }
    return { allowed: true, remaining, shouldFallbackToProactive: false };
  }

  /** 记一次被动回复。 */
  record(messageId) {
    const now = Date.now();
    const existing = this.tracker.get(messageId);
    if (!existing) {
      this.tracker.set(messageId, { count: 1, firstReplyAt: now });
    } else if (now - existing.firstReplyAt > this.ttlMs) {
      this.tracker.set(messageId, { count: 1, firstReplyAt: now });
    } else {
      existing.count += 1;
    }
  }

  getStats() {
    let totalReplies = 0;
    for (const record of this.tracker.values()) totalReplies += record.count;
    return { trackedMessages: this.tracker.size, totalReplies };
  }

  getConfig() {
    return { limit: this.limit, ttlMs: this.ttlMs, ttlHours: this.ttlMs / (60 * 60 * 1000) };
  }

  clear() {
    this.tracker.clear();
  }

  evictIfNeeded(now) {
    if (this.tracker.size <= this.maxTracked) return;
    for (const [id, rec] of this.tracker) {
      if (now - rec.firstReplyAt > this.ttlMs) this.tracker.delete(id);
    }
  }
}

export default ReplyLimiter;
