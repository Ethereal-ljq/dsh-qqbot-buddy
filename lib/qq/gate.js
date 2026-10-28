/**
 * gate —— 回复频率门控（纯函数，可单测，不触碰任何 IO / 定时器）。
 *
 * 设计契约见 DESIGN.md「qq/gate.js」一节：
 *   createGateState() / decide() / recordTrigger() / recordSkip() / pendingSnapshot()
 *
 * 决策优先级（从上到下，命中即返回）：
 *   1. 命令消息（由调用方在门控之前处理，这里只兜底）   -> trigger reason=command
 *   2. 总开关关闭                                        -> skip   reason=disabled
 *   3. 私聊：c2cEnabled 打开则必回，否则 disabled        -> trigger reason=c2c
 *   4. 群聊关闭（groupEnabled=false）                    -> skip   reason=disabled
 *   5. 强制触发：@ / 回复机器人 / 关键词（各自可开关）   -> trigger reason=mention|reply|keyword
 *   6. 自适应模式（groupMode='adaptive'）：非强制触发时只返回 buffer 标记，
 *      不触发、不累计 pending、不走 minGap（debounce/cooldown/maxWait 由 AdaptiveScheduler 负责）
 *   7. 非强制触发之间的全局最小间隔（minGapSeconds）     -> skip   reason=cooldown
 *   8. 按 groupMode 决策：
 *        adaptive    -> buffer=true（交给 scheduler 攒批）
 *        all         -> 每条都回
 *        count       -> 累计 countThreshold 条后回；pending 最早一条等待超时则 flush 回
 *        interval    -> 距上次回复超过 intervalSeconds 回
 *        probability -> 按 probability 概率回
 *   9. 空消息（无文本）且最终没触发                      -> skip   reason=empty
 *
 * 约定：reason 表示「本次决策走的哪个分支」。cooldown 表示本该触发但被 minGap 拦下；
 * 调用方据此记 skipped 统计。resetPending=true 表示触发后应清空该 peer 的 pending 队列。
 */

/** 单个 peer 最多保留的 pending 记录数（防止超长群聊把内存吃满）。 */
const MAX_PENDING_PER_PEER = 200;
/** state.peers 最多跟踪的 peer 数；超出后按插入顺序淘汰最早的。 */
const MAX_PEERS = 2000;

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const toInt = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : fallback);

/**
 * 创建门控状态。gateway 全局持有一个实例，随消息累积 pending。
 * @returns {{peers: Map<string, {pending: Array<{at:number}>, lastSkipAt:number}>, lastReplyAt:number, lastTriggerReason:string, totalTriggers:number, totalSkips:number}}
 */
export function createGateState() {
  return {
    peers: new Map(),
    /** 最近一次触发回复的时间戳（毫秒）；interval / minGap 用它做基准。 */
    lastReplyAt: 0,
    /** 最近一次触发原因，供 /status 与 UI 展示。 */
    lastTriggerReason: '',
    totalTriggers: 0,
    totalSkips: 0,
  };
}

/** 取出某 peer 的 pending 数组（不存在时返回空数组，不创建）。 */
function pendingOf(state, peerKey) {
  const peer = state && state.peers ? state.peers.get(peerKey) : undefined;
  return peer && Array.isArray(peer.pending) ? peer.pending : [];
}

/** 取 pending 里最早一条的时间戳（兼容旧格式直接存数字）。 */
function pendingAt(entry, fallback) {
  if (entry && typeof entry === 'object' && Number.isFinite(entry.at)) return entry.at;
  if (Number.isFinite(entry)) return entry;
  return fallback;
}

/** 关键词是否命中（纯文本子串；英文忽略大小写，中文天然按子串）。 */
function keywordHit(text, keywords) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const raw of keywords) {
    if (typeof raw !== 'string') continue;
    const kw = raw.trim();
    if (kw === '') continue;
    if (lower.includes(kw.toLowerCase())) return true;
  }
  return false;
}

function trigger(reason, forced) {
  return { trigger: true, buffer: false, reason, forced, resetPending: true };
}

function skip(reason) {
  return { trigger: false, buffer: false, reason, forced: false, resetPending: false };
}

/**
 * 纯函数：根据设置与当前状态决定「这条消息要不要回」。
 *
 * @param {object} args
 * @param {object} args.settings       完整 Settings（settings-store.get() 的快照）
 * @param {string} [args.peerKey]      peer 唯一键，建议 scope:peerId，用于查 pending
 * @param {'group'|'c2c'} [args.scope] 会话类型
 * @param {boolean} [args.wasMentioned] 是否被 @（来自 SDK mentionGate 的 ctx.state.mention）
 * @param {boolean} [args.isReplyToBot] 是否在回复机器人消息（quote/messageId 命中）
 * @param {string} [args.content]      清洗后的消息文本
 * @param {boolean} [args.isCommand]   是否已识别的命令（兜底路径）
 * @param {number} [args.now]          当前时间戳（便于测试注入）
 * @param {number} [args.lastReplyAt]  上次触发时间（缺省读 state.lastReplyAt）
 * @param {object} [args.state]        createGateState() 的实例
 * @param {() => number} [args.random] 随机数发生器（probability 模式，测试可注入）
 * @returns {{trigger:boolean, buffer:boolean, reason:string, forced:boolean, resetPending:boolean}}
 *   buffer=true 表示「模式要求攒批」，调用方应交给 AdaptiveScheduler.buffer(ctx) 后短路。
 */
export function decide({
  settings,
  peerKey = '',
  scope = 'group',
  wasMentioned = false,
  isReplyToBot = false,
  content = '',
  isCommand = false,
  now = Date.now(),
  lastReplyAt = 0,
  state = null,
  random = Math.random,
} = {}) {
  const cfg = settings && typeof settings === 'object' ? settings : {};
  const reply = cfg.reply && typeof cfg.reply === 'object' ? cfg.reply : {};
  const triggers = cfg.triggers && typeof cfg.triggers === 'object' ? cfg.triggers : {};
  const gateState = state && typeof state === 'object' ? state : null;

  const text = typeof content === 'string' ? content : '';
  const trimmed = text.trim();
  const effectiveLastReply = Number.isFinite(lastReplyAt) && lastReplyAt > 0
    ? lastReplyAt
    : (gateState && Number.isFinite(gateState.lastReplyAt) ? gateState.lastReplyAt : 0);

  // 1. 命令兜底：命令响应不受频率开关影响。
  if (isCommand) return trigger('command', true);

  // 2. 总开关：false = 永不自动回复。
  if (reply.enabled === false) return skip('disabled');

  // 3. 私聊：c2c 打开则必回（强制触发，不受 minGap 影响）。
  if (scope === 'c2c') {
    if (reply.c2cEnabled === false) return skip('disabled');
    return trigger('c2c', true);
  }

  // 4. 群聊总开关
  if (reply.groupEnabled === false) return skip('disabled');

  // 5. 强制触发：@ / 回复机器人 / 关键词
  if (triggers.onMention !== false && wasMentioned === true) return trigger('mention', true);
  if (triggers.onReplyToBot !== false && isReplyToBot === true) return trigger('reply', true);
  const keywords = Array.isArray(triggers.keywords) ? triggers.keywords : [];
  if (keywords.length > 0 && keywordHit(trimmed, keywords)) return trigger('keyword', true);

  const mode = typeof reply.groupMode === 'string' ? reply.groupMode : 'count';

  // 6. 自适应模式：非强制触发时不立即回，只打 buffer 标记交给 AdaptiveScheduler；
  //    不累计 pending、不走 minGap（攒批的 debounce/cooldown/maxWait 由 scheduler 负责）。
  if (mode === 'adaptive') {
    return { trigger: false, buffer: true, reason: 'adaptive', forced: false, resetPending: false };
  }

  // 7. 非强制触发之间的全局最小间隔（主动回复才受限，强制回复不受限）。
  const minGapSec = Math.max(0, toInt(reply.minGapSeconds, 0));
  if (minGapSec > 0 && effectiveLastReply > 0 && now - effectiveLastReply < minGapSec * 1000) {
    return skip('cooldown');
  }

  const pending = pendingOf(gateState, peerKey);

  // 8. 按模式决策
  let result;
  if (mode === 'all') {
    result = trigger('mode', false);
  } else if (mode === 'interval') {
    const intervalMs = Math.max(0, toInt(reply.intervalSeconds, 0)) * 1000;
    if (effectiveLastReply <= 0 || now - effectiveLastReply >= intervalMs) {
      result = trigger('mode', false);
    } else {
      result = skip('mode');
    }
  } else if (mode === 'probability') {
    const p = clamp01(Number(reply.probability));
    if (p <= 0) result = skip('mode');
    else if (p >= 1) result = trigger('mode', false);
    else result = random() < p ? trigger('mode', false) : skip('mode');
  } else {
    // 默认 count：累计 N 条触发；pending 最早一条等待超时则 flush。
    const threshold = Math.max(1, toInt(reply.countThreshold, 1));
    const count = pending.length + 1; // 当前这条也算进去
    const flushSec = Math.max(0, toInt(reply.flushAfterSeconds, 0));
    if (count >= threshold) {
      result = trigger('mode', false);
    } else if (flushSec > 0 && pending.length > 0) {
      const oldestAt = pendingAt(pending[0], now);
      if (now - oldestAt >= flushSec * 1000) result = trigger('flush', false);
      else result = skip('mode');
    } else {
      result = skip('mode');
    }
  }

  // 9. 空消息：没有文本、也没被强制触发；保留 mode 判定（图片消息也应计入 count）。
  if (!result.trigger && trimmed === '') return skip('empty');
  return result;
}

/**
 * 记录一次触发：更新最近回复时间/原因，并清空该 peer 的 pending。
 * @param {object} state createGateState() 实例
 * @param {string} peerKey peer 键
 * @param {number} [now] 触发时间戳
 * @param {string} [reason] 触发原因
 */
export function recordTrigger(state, peerKey, now = Date.now(), reason = 'mode') {
  if (!state || typeof state !== 'object') return;
  state.lastReplyAt = now;
  state.lastTriggerReason = reason;
  state.totalTriggers = (Number(state.totalTriggers) || 0) + 1;
  if (state.peers && peerKey) state.peers.delete(peerKey);
}

/**
 * 记录一次跳过：该 peer 的 pending 追加一条，用于 count 模式累计与 UI 展示。
 * @param {object} state createGateState() 实例
 * @param {string} peerKey peer 键
 * @param {number} [now] 记录时间戳
 */
export function recordSkip(state, peerKey, now = Date.now()) {
  if (!state || typeof state !== 'object' || !peerKey) return;
  state.totalSkips = (Number(state.totalSkips) || 0) + 1;
  if (!(state.peers instanceof Map)) state.peers = new Map();

  let peer = state.peers.get(peerKey);
  if (!peer) {
    peer = { pending: [], lastSkipAt: 0 };
    state.peers.set(peerKey, peer);
    // 淘汰最早的 peer，避免恶意刷屏把 Map 撑爆。
    if (state.peers.size > MAX_PEERS) {
      const oldestKey = state.peers.keys().next().value;
      if (oldestKey !== undefined && oldestKey !== peerKey) state.peers.delete(oldestKey);
    }
  }
  if (!Array.isArray(peer.pending)) peer.pending = [];
  peer.pending.push({ at: now });
  peer.lastSkipAt = now;
  if (peer.pending.length > MAX_PENDING_PER_PEER) {
    peer.pending.splice(0, peer.pending.length - MAX_PENDING_PER_PEER);
  }
}

/**
 * 生成 pending 快照（给设置页 / botState 用）。
 * @param {object} state createGateState() 实例
 * @param {number} [now] 当前时间戳
 * @returns {Array<{peerKey:string, scope:string, peerId:string, count:number, oldestAt:number, waitingMs:number, lastSkipAt:number}>}
 */
export function pendingSnapshot(state, now = Date.now()) {
  const out = [];
  if (!state || !(state.peers instanceof Map)) return out;
  for (const [peerKey, peer] of state.peers) {
    const pending = peer && Array.isArray(peer.pending) ? peer.pending : [];
    if (pending.length === 0) continue;
    const oldestAt = pendingAt(pending[0], now);
    const sep = peerKey.indexOf(':');
    out.push({
      peerKey,
      scope: sep >= 0 ? peerKey.slice(0, sep) : '',
      peerId: sep >= 0 ? peerKey.slice(sep + 1) : peerKey,
      count: pending.length,
      oldestAt,
      waitingMs: Math.max(0, now - oldestAt),
      lastSkipAt: Number(peer.lastSkipAt) || 0,
    });
  }
  // 等得最久的排前面，UI 一眼看到该 flush 的群。
  out.sort((a, b) => b.waitingMs - a.waitingMs);
  return out;
}

/**
 * 清空全部 pending（设置页「清空待回复」动作 / 重连时使用）。
 * @param {object} state createGateState() 实例
 */
export function clearPending(state) {
  if (state && state.peers instanceof Map) state.peers.clear();
}
