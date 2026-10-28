/**
 * adaptive —— 自适应回复模式（群聊攒批 + 静默/冷却/最长等待 + 相关性过滤）。
 *
 * 与 gate/middleware 的分工（DESIGN「追加需求（2026-10-26 晚）」）：
 *   - gate.decide 在 groupMode='adaptive' 且非强制触发时只返回 {trigger:false, buffer:true}；
 *   - middleware 把 ctx 交给 buffer(ctx) 后立即 ctx.stop，不进入后续管线；
 *   - 本模块按 per-peer 批次攒消息，debounce（最后一条后静默 N 秒）/ maxWait（从首条起最长等待）
 *     到点后触发；触发时受 cooldown 与「另一轮 running」约束；
 *   - 触发后把「除最后一条外」的消息合成为 history，最后一条复用 assembleAgentBody 作为当前消息，
 *     再走 manager.getOrCreate -> agent.followup -> whenIdle，最后清空该群 history。
 *
 * 所有定时器/时钟/下载器/manager 都可注入，便于单测用 fake timers 驱动，不必真实等待。
 */
import { downloadMediaAttachments, classifyContentType } from './attachment.js';
import { assembleAgentBody } from './inbound.js';
import { clearGroupHistory } from './middleware.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 单 peer 批次最多保留的消息数（丢最旧）。 */
const MAX_BATCH = 30;
/** 触发时若另一轮仍在跑，多久后重试（毫秒）。 */
const RUNNING_RETRY_MS = 300;
/** peers Map 最大跟踪数量（防止长期运行内存膨胀）。 */
const MAX_PEERS = 500;

/** settings.reply.adaptive 缺省值（settings-store 已保证，但这里再兜一层）。 */
const DEFAULT_ADAPTIVE = {
  debounceSeconds: 4,
  cooldownSeconds: 12,
  maxWaitSeconds: 20,
  requireRelevance: true,
};

/**
 * 问句特征正则（DESIGN 固定）：批次里只要有一条命中就认为「值得接话」。
 * 除问句外，图片/视频/文件附件也算相关。
 */
const QUESTION_RE = /[?？]|吗|呢|么|怎么|为什么|为啥|啥|什么|哪|谁|是不是|能不能|可不可以|有没有|如何|多少|几|该不该|要不要/;

const IMAGE_LABEL = '[图片]';
const VIDEO_LABEL = '[视频]';
const FILE_LABEL = '[文件]';

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** setTimeout 返回的数字/对象都尝试 unref，避免阻塞进程退出。 */
function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') {
    try {
      timer.unref();
    } catch {
      /* 忽略 */
    }
  }
  return timer;
}

/** 会话里是否带「可接话」的媒体附件（图片/视频/文件；语音不算）。 */
function hasRelevantAttachment(message) {
  const attachments = message && Array.isArray(message.attachments) ? message.attachments : [];
  for (const att of attachments) {
    if (!att) continue;
    const kind = classifyContentType(att.content_type);
    if (kind === 'image' || kind === 'video' || kind === 'file') return true;
  }
  return false;
}

/** 批次内是否有问句特征（文本）或相关媒体。 */
export function batchHasRelevance(messages) {
  if (!Array.isArray(messages)) return false;
  for (const entry of messages) {
    const message = entry && entry.message ? entry.message : entry;
    if (!message) continue;
    const text = typeof message.content === 'string' ? message.content : '';
    if (text && QUESTION_RE.test(text)) return true;
    if (hasRelevantAttachment(message)) return true;
  }
  return false;
}

/** 把一条消息的附件渲染成媒体行（用于 history 条目）。 */
function buildMediaLines(attachments, downloaded) {
  const lines = [];
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return lines;
  const byFilename = new Map();
  for (const item of Array.isArray(downloaded) ? downloaded : []) {
    if (item && item.filename) byFilename.set(item.filename, item);
  }
  for (const att of list) {
    if (!att) continue;
    const kind = classifyContentType(att.content_type);
    const local = byFilename.get(att.filename);
    const target = local ? local.localPath : (att.url || att.filename || kind);
    if (kind === 'image') lines.push(IMAGE_LABEL + '\n' + 'Image: ' + target);
    else if (kind === 'video') lines.push(VIDEO_LABEL + '\n' + 'Video: ' + target);
    else if (kind === 'file') lines.push(FILE_LABEL + '\n' + 'File: ' + target);
    else if (kind === 'voice') {
      const asr = att.asr_refer_text ? String(att.asr_refer_text).trim() : '';
      if (asr) lines.push('[语音] ' + asr);
      else if (att.url) lines.push('[语音] ' + att.url);
    }
  }
  return lines;
}

/** 批次 history 条目的正文（原文 + 媒体行）。 */
function buildHistoryContent(message, downloaded) {
  const parts = [];
  const text = message && typeof message.content === 'string' ? message.content.trim() : '';
  if (text) parts.push(text);
  const media = buildMediaLines(message && message.attachments, downloaded);
  if (media.length > 0) parts.push(media.join('\n'));
  return parts.join('\n');
}

/**
 * 创建自适应调度器。
 * @param {object} args
 * @param {Function} args.getBot 返回当前 QQBot（预留；当前触发链路不直接用）
 * @param {object} args.manager SessionManager
 * @param {object} args.config 部署配置（appId 用于清群历史）
 * @param {object} args.settings settings-store（每次现读，热生效）
 * @param {object} args.gateState createGateState() 实例（触发后更新 lastReplyAt）
 * @param {object} args.stats 统计对象
 * @param {object} args.logger 日志对象
 * @param {string} args.mediaDir 媒体下载目录
 * @param {object} [args.historyStore] 群历史存储（清 history 用）
 * @param {Function} [args.downloadAttachments] 下载器（默认 attachment.downloadMediaAttachments）
 * @param {number} [args.maxBytes] 单附件上限
 * @param {Function} [args.assembleBody] 组装器（默认 inbound.assembleAgentBody，测试可注入）
 * @param {Function} [args.makeUserMessage] UserMessage 工厂（默认 dsh-llm.createUserMessage）
 * @param {Function} [args.clearHistory] 清群历史回调 (scope, peerId)（默认用 historyStore + clearGroupHistory）
 * @param {Function} [args.now] 时钟（默认 Date.now）
 * @param {object} [args.timers] 定时器实现 { setTimeout, clearTimeout }（默认全局，测试可注入）
 */
export function createAdaptiveScheduler(args = {}) {
  const {
    getBot,
    manager,
    config = {},
    settings,
    gateState,
    stats,
    logger,
    mediaDir,
    historyStore,
    downloadAttachments = downloadMediaAttachments,
    maxBytes,
    assembleBody = assembleAgentBody,
    makeUserMessage = createUserMessage,
    clearHistory,
    now = Date.now,
    timers = {},
  } = args;

  const log = logger || console;
  const timerApi = {
    setTimeout: typeof timers.setTimeout === 'function' ? timers.setTimeout : ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: typeof timers.clearTimeout === 'function' ? timers.clearTimeout : ((t) => clearTimeout(t)),
  };

  /** peerKey -> peer 状态 */
  const peers = new Map();
  let disposed = false;

  // ── 设置读取 ────────────────────────────────────────────
  function readReplySettings() {
    let cfg = {};
    try {
      cfg = settings && typeof settings.get === 'function' ? settings.get() : {};
    } catch (err) {
      log.warn('adaptive 读取设置失败: ' + errText(err));
    }
    const reply = cfg && cfg.reply && typeof cfg.reply === 'object' ? cfg.reply : {};
    const adaptiveSrc = reply.adaptive && typeof reply.adaptive === 'object' ? reply.adaptive : {};
    const adaptive = {
      debounceSeconds: toInt(adaptiveSrc.debounceSeconds, DEFAULT_ADAPTIVE.debounceSeconds),
      cooldownSeconds: toInt(adaptiveSrc.cooldownSeconds, DEFAULT_ADAPTIVE.cooldownSeconds),
      maxWaitSeconds: toInt(adaptiveSrc.maxWaitSeconds, DEFAULT_ADAPTIVE.maxWaitSeconds),
      requireRelevance: adaptiveSrc.requireRelevance !== false,
    };
    return {
      enabled: reply.enabled !== false,
      groupEnabled: reply.groupEnabled !== false,
      groupMode: typeof reply.groupMode === 'string' ? reply.groupMode : 'count',
      adaptive: adaptive,
    };
  }

  // ── peer 状态与定时器 ──────────────────────────────────
  function peerIdOf(peerKey) {
    const sep = String(peerKey).indexOf(':');
    return sep >= 0 ? String(peerKey).slice(sep + 1) : String(peerKey);
  }

  function createPeer(peerKey) {
    return {
      peerKey: peerKey,
      peerId: peerIdOf(peerKey),
      messages: [],
      firstAt: 0,
      lastAt: 0,
      debounceTimer: null,
      maxTimer: null,
      retryTimer: null,
      cooldownUntil: 0,
      running: false,
    };
  }

  function clearTimer(peer, key) {
    const timer = peer ? peer[key] : null;
    if (timer === null || timer === undefined) return;
    try {
      timerApi.clearTimeout(timer);
    } catch {
      /* 忽略 */
    }
    peer[key] = null;
  }

  function clearPeerTimers(peer) {
    clearTimer(peer, 'debounceTimer');
    clearTimer(peer, 'maxTimer');
    clearTimer(peer, 'retryTimer');
  }

  function clearPeerMessages(peer) {
    peer.messages = [];
    peer.firstAt = 0;
  }

  function maybeDeletePeer(peerKey, peer) {
    if (!peer) return;
    if (peer.running) return;
    if (peer.messages.length > 0) return;
    if (peer.debounceTimer || peer.maxTimer || peer.retryTimer) return;
    if (peer.cooldownUntil > now()) return;
    peers.delete(peerKey);
  }

  /** peers 超过上限时淘汰最早的非 running peer（避免长期运行内存膨胀）。 */
  function enforcePeerLimit(keepKey) {
    if (peers.size <= MAX_PEERS) return;
    for (const [key, value] of peers) {
      if (key === keepKey) continue;
      if (value.running) continue;
      clearPeerTimers(value);
      peers.delete(key);
      if (peers.size <= MAX_PEERS) break;
    }
  }

  function scheduleDebounce(peerKey, peer) {
    const replySettings = readReplySettings();
    const delayMs = Math.max(0, replySettings.adaptive.debounceSeconds) * 1000;
    clearTimer(peer, 'debounceTimer');
    peer.debounceTimer = unrefTimer(timerApi.setTimeout(() => {
      peer.debounceTimer = null;
      void runFlush(peerKey);
    }, delayMs));
  }

  function scheduleMaxWait(peerKey, peer) {
    if (peer.maxTimer) return;
    const replySettings = readReplySettings();
    const waitMs = Math.max(0, replySettings.adaptive.maxWaitSeconds) * 1000;
    const base = Number.isFinite(peer.firstAt) && peer.firstAt > 0 ? peer.firstAt : now();
    const delayMs = Math.max(0, waitMs - (now() - base));
    peer.maxTimer = unrefTimer(timerApi.setTimeout(() => {
      peer.maxTimer = null;
      void runFlush(peerKey);
    }, delayMs));
  }

  function scheduleRetry(peerKey, peer, delayMs) {
    clearTimer(peer, 'retryTimer');
    peer.retryTimer = unrefTimer(timerApi.setTimeout(() => {
      peer.retryTimer = null;
      void runFlush(peerKey);
    }, Math.max(0, delayMs)));
  }

  // ── 触发主流程 ──────────────────────────────────────────
  /** 下载一条消息的附件（失败只 warn，返回空数组）。 */
  async function downloadForMessage(message) {
    const attachments = message && Array.isArray(message.attachments) ? message.attachments : [];
    if (attachments.length === 0 || typeof downloadAttachments !== 'function') return [];
    try {
      const result = await downloadAttachments({
        attachments: attachments,
        mediaDir: mediaDir,
        ...(Number.isFinite(maxBytes) && maxBytes > 0 ? { maxBytes: maxBytes } : {}),
        logger: log,
      });
      return Array.isArray(result) ? result : [];
    } catch (err) {
      log.warn('adaptive 下载附件失败: ' + errText(err));
      return [];
    }
  }

  /** 真正交给 agent：批次 history + 最后一条当前消息。 */
  async function deliver(peerKey, batch) {
    const last = batch[batch.length - 1];
    if (!last) return false;
    const earlier = batch.slice(0, -1);
    const downloadedByEntry = new Map();
    for (const entry of batch) {
      downloadedByEntry.set(entry, await downloadForMessage(entry.message));
    }
    const history = [];
    for (const entry of earlier) {
      const content = buildHistoryContent(entry.message, downloadedByEntry.get(entry) || []);
      if (!content) continue;
      history.push({
        senderId: entry.message.senderId,
        senderName: entry.message.senderName,
        content: content,
        messageId: entry.message.messageId,
        timestamp: entry.at,
      });
    }
    const lastState = Object.assign({}, last.state && typeof last.state === 'object' ? last.state : {}, {
      triggerReason: 'adaptive',
      forced: false,
      history: history,
      downloadedFiles: downloadedByEntry.get(last) || [],
    });
    const body = assembleBody({ message: last.message, state: lastState, scope: 'group', logger: log });
    if (!body || String(body).trim() === '') {
      log.debug('adaptive 批次组装为空，跳过: ' + peerKey);
      return false;
    }
    if (!manager || typeof manager.getOrCreate !== 'function') {
      log.warn('adaptive 无法触发：manager 不可用');
      return false;
    }
    const peerId = peerIdOf(peerKey);
    const record = await manager.getOrCreate('group', peerId, last.message.senderId, last.replyTarget);
    const userMessage = makeUserMessage({
      content: [{ type: 'text', text: body }],
      source: { kind: 'user' },
    });
    await record.agent.followup(userMessage);
    try {
      await record.agent.whenIdle();
    } catch (err) {
      log.warn('adaptive whenIdle rejected: ' + errText(err));
    }
    // 触发后清空该群 history 缓冲，避免下一批重复堆上下文
    try {
      if (typeof clearHistory === 'function') clearHistory('group', peerId);
      else if (historyStore) clearGroupHistory(historyStore, config.appId, peerId);
    } catch (err) {
      log.warn('adaptive 清群历史失败: ' + errText(err));
    }
    log.info('adaptive 触发: ' + peerKey + ' 批次 ' + batch.length + ' 条');
    return true;
  }

  /** 一次 flush 尝试（timer 回调 / retry 都走这里；所有异常内部消化）。 */
  async function runFlush(peerKey) {
    if (disposed) return;
    const peer = peers.get(peerKey);
    if (!peer) return;
    if (peer.messages.length === 0) {
      clearPeerTimers(peer);
      maybeDeletePeer(peerKey, peer);
      return;
    }
    const replySettings = readReplySettings();
    // 模式切走 / 总开关关闭：清空该 peer 缓冲（flush 兜底）
    if (!replySettings.enabled || !replySettings.groupEnabled || replySettings.groupMode !== 'adaptive') {
      clearPeerTimers(peer);
      clearPeerMessages(peer);
      maybeDeletePeer(peerKey, peer);
      return;
    }
    // 串行：另一轮仍在跑 -> 300ms 后重试
    if (peer.running) {
      scheduleRetry(peerKey, peer, RUNNING_RETRY_MS);
      return;
    }
    // 冷却：顺延到冷却结束
    const current = now();
    if (peer.cooldownUntil > current) {
      scheduleRetry(peerKey, peer, peer.cooldownUntil - current);
      return;
    }
    // 相关性过滤：批次里没有问句/图片/视频/文件 -> 整批丢弃
    if (replySettings.adaptive.requireRelevance && !batchHasRelevance(peer.messages)) {
      log.debug('adaptive 批次无问句/媒体，丢弃: ' + peerKey);
      clearPeerTimers(peer);
      clearPeerMessages(peer);
      maybeDeletePeer(peerKey, peer);
      return;
    }

    const batch = peer.messages;
    peer.messages = [];
    peer.firstAt = 0;
    clearPeerTimers(peer);
    peer.running = true;
    try {
      const delivered = await deliver(peerKey, batch);
      const finishedAt = now();
      if (delivered) {
        stats.triggered = (Number(stats.triggered) || 0) + 1;
        stats.lastTriggerReason = 'adaptive';
        if (gateState) gateState.lastReplyAt = finishedAt;
        const cooldownMs = Math.max(0, replySettings.adaptive.cooldownSeconds) * 1000;
        peer.cooldownUntil = finishedAt + cooldownMs;
      }
    } catch (err) {
      log.error('adaptive 触发失败: ' + errText(err));
    } finally {
      peer.running = false;
      if (disposed) {
        clearPeerTimers(peer);
        clearPeerMessages(peer);
        peers.delete(peerKey);
      } else if (peer.messages.length > 0) {
        scheduleDebounce(peerKey, peer);
        scheduleMaxWait(peerKey, peer);
      } else {
        maybeDeletePeer(peerKey, peer);
      }
    }
  }

  // ── 对外 API ────────────────────────────────────────────
  /** 把一条已触发 buffer 的消息放进该 peer 的批次并（重）启定时器。 */
  function buffer(ctx) {
    if (disposed) return;
    try {
      if (!ctx || !ctx.message) return;
      const message = ctx.message;
      if (message.kind !== 'group') return;
      const peerId = message.groupOpenid || message.senderId;
      if (!peerId) return;
      const peerKey = 'group:' + peerId;
      let peer = peers.get(peerKey);
      if (!peer) {
        peer = createPeer(peerKey);
        peers.set(peerKey, peer);
        enforcePeerLimit(peerKey);
      }
      const at = now();
      peer.messages.push({
        ctx: ctx,
        message: message,
        replyTarget: ctx.replyTarget,
        state: ctx.state || {},
        at: at,
      });
      if (peer.messages.length > MAX_BATCH) {
        peer.messages.splice(0, peer.messages.length - MAX_BATCH);
      }
      if (!peer.firstAt) peer.firstAt = at;
      peer.lastAt = at;
      scheduleDebounce(peerKey, peer);
      scheduleMaxWait(peerKey, peer);
      log.debug('adaptive 缓冲: ' + peerKey + ' 共 ' + peer.messages.length + ' 条');
    } catch (err) {
      log.warn('adaptive buffer 失败: ' + errText(err));
    }
  }

  /**
   * 强制触发（@/回复/关键词/命令）后调用：清空该 peer 缓冲并进入冷却，
   * 避免刚被强制回复又立刻攒批再回一次。
   */
  function noteForcedTrigger(peerKey) {
    if (disposed || !peerKey) return;
    try {
      const peerKeyStr = String(peerKey);
      const replySettings = readReplySettings();
      let peer = peers.get(peerKeyStr);
      // 非 adaptive 模式且没有现存缓冲/冷却态：无需创建 peer（避免非 adaptive 模式无界增长）
      if (!peer && replySettings.groupMode !== 'adaptive') return;
      if (!peer) {
        peer = createPeer(peerKeyStr);
        peers.set(peerKeyStr, peer);
        enforcePeerLimit(peerKeyStr);
      }
      clearPeerTimers(peer);
      clearPeerMessages(peer);
      peer.cooldownUntil = now() + Math.max(0, replySettings.adaptive.cooldownSeconds) * 1000;
      log.debug('adaptive 强制触发，清空缓冲并进入冷却: ' + peerKeyStr);
    } catch (err) {
      log.warn('adaptive noteForcedTrigger 失败: ' + errText(err));
    }
  }

  /** 清空单个 peer（不传则清空全部）的缓冲与定时器。 */
  function clear(peerKey) {
    try {
      if (peerKey) {
        const peer = peers.get(String(peerKey));
        if (peer) {
          clearPeerTimers(peer);
          clearPeerMessages(peer);
          peers.delete(String(peerKey));
        }
        return;
      }
      clearAll();
    } catch (err) {
      log.warn('adaptive clear 失败: ' + errText(err));
    }
  }

  /** 清空全部 peer 缓冲与定时器（bot stop / 模式切换 / 卸载时调用）。 */
  function clearAll() {
    try {
      for (const peer of peers.values()) {
        clearPeerTimers(peer);
        clearPeerMessages(peer);
      }
      peers.clear();
    } catch (err) {
      log.warn('adaptive clearAll 失败: ' + errText(err));
    }
  }

  /** 缓冲快照（形状与 gate.pendingSnapshot 一致，便于 botState().pending 合并）。 */
  function pendingSnapshot() {
    const current = now();
    const out = [];
    for (const [peerKey, peer] of peers) {
      if (!peer || peer.messages.length === 0) continue;
      const oldestAt = Number.isFinite(peer.firstAt) && peer.firstAt > 0 ? peer.firstAt : current;
      out.push({
        peerKey: peerKey,
        scope: 'group',
        peerId: peer.peerId,
        count: peer.messages.length,
        oldestAt: oldestAt,
        waitingMs: Math.max(0, current - oldestAt),
        lastSkipAt: Number(peer.lastAt) || 0,
      });
    }
    out.sort((a, b) => b.waitingMs - a.waitingMs);
    return out;
  }

  /** 卸载：清理全部定时器并停止接受新缓冲。 */
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearAll();
  }

  return {
    buffer: buffer,
    noteForcedTrigger: noteForcedTrigger,
    clear: clear,
    clearAll: clearAll,
    pendingSnapshot: pendingSnapshot,
    dispose: dispose,
  };
}

export default createAdaptiveScheduler;
