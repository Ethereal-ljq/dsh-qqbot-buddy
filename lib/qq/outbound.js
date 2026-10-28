/**
 * outbound —— 把 dsh session/event 转成 QQ 消息发送。
 *
 * 关注两类事件：
 *   assistant/message：先缓存本 step 文本（turn 内可能先说话再调工具）
 *   turn/end：只在正常完成时发送本 turn 最后一个文本块（[[msg]]/空行分条 -> markdown 切分）
 *   turn/end：异常结束时发一条提示（STREAM_CLOSED 静默），并调 collector.noteTurnEnd(record)
 *
 * 发送兜底：先用 record.replyTarget（带 msgId 的被动回复）；失败（窗口过期/超频）后
 * 去掉 msgId 再试一次主动推送，仍失败则记日志放弃，绝不让异常冒泡。
 *
 * sentTracker 记录「机器人自己发过的消息 id / 文本」，供 replyProbe 判断
 * 「这条群消息是不是在回复机器人」。
 */
import { convertEmojiTokens } from './emoji.js';

const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);
/** [[msg]] 分条标记（大小写不敏感，允许中间空白）。 */
const MSG_SEGMENT_RE = /\[\[\s*msg\s*\]\]/i;
/** QQ 代码围栏标记（用字符码构造，避免源码里出现反引号）。 */
const FENCE = String.fromCharCode(96).repeat(3);
const CODE_FENCE_OPEN = new RegExp('^' + FENCE);
const GFM_TABLE_LINE = /^\|.+\|$/;

/** 错误转字符串。 */
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 没有 [[msg]] 标记时的兜底：按「空行」把正文拆成多条 QQ 消息。
 * 默认太短/太碎的段落不拆，避免模型把每一句都写成独立气泡；
 * 可通过 minSegmentChars / minTotalChars / maxSegments 控制。
 */
export function splitBlankLineSegments(text, options = {}) {
  const input = typeof text === 'string' ? text : '';
  if (!input.includes('\n')) return [input];
  // 代码块不自动拆（空行在代码里可能是语义的一部分，拆开还会破坏围栏）
  if (input.includes(FENCE)) return [input];

  const lines = input.split('\n');
  const raw = [];
  let current = [];
  const pushCurrent = () => {
    const joined = current.join('\n').trim();
    if (joined !== '') raw.push(joined);
    current = [];
  };
  for (const line of lines) {
    if (line.trim() === '') {
      pushCurrent();
      continue;
    }
    current.push(line);
  }
  pushCurrent();
  if (raw.length < 2) return [input];

  const toInt = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  const minSegmentChars = toInt(options.minSegmentChars, 0);
  const minTotalChars = toInt(options.minTotalChars, 0);
  const maxSegments = Math.min(4, Math.max(2, toInt(options.maxSegments, 4)));

  // 太短的段先并回上一段（首段太短则并到下一段），避免"每句一个气泡"。
  const merged = [];
  for (const segment of raw) {
    if (merged.length === 0) {
      merged.push(segment);
      continue;
    }
    if (minSegmentChars > 0 && segment.length < minSegmentChars) {
      merged[merged.length - 1] = merged[merged.length - 1] + '\n' + segment;
      continue;
    }
    merged.push(segment);
  }
  if (merged.length > 1 && minSegmentChars > 0 && merged[0].length < minSegmentChars) {
    merged[1] = merged[0] + '\n' + merged[1];
    merged.shift();
  }
  if (merged.length < 2) return [input];

  // 段数超过上限就不拆（避免把 5+ 段碎句强行拼成 4 个气泡）。
  if (merged.length > maxSegments) return [input];
  const segments = merged;
  if (minTotalChars > 0 && segments.join('').length < minTotalChars) return [input];
  if (segments.some((segment) => segment.length > 420)) return [input];
  if (segments.join('').length > 900) return [input];
  return segments;
}

/** 一次回复按 [[msg]] 拆成多条 QQ 消息；没有标记时返回整段。 */
export function splitSegments(text) {
  const input = typeof text === 'string' ? text : '';
  if (!MSG_SEGMENT_RE.test(input)) return [input];
  const parts = input.split(MSG_SEGMENT_RE)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [input];
}

/**
 * Markdown 感知切分：优先在换行/空行处断开，不切断代码块和 GFM 表格；
 * 单行超长时再硬切，保证每条都不超过 QQ 限制。
 */
export function chunkMarkdownText(text, limit) {
  const input = typeof text === 'string' ? text : String(text || '');
  const max = Number(limit) > 0 ? Math.floor(Number(limit)) : 4500;
  if (input.length <= max) return [input];

  const lines = input.split('\n');
  const chunks = [];
  let current = '';
  let inCodeBlock = false;
  let tableBuffer = [];

  const pushCurrent = () => {
    if (current !== '') {
      chunks.push(current);
      current = '';
    }
  };
  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    const block = tableBuffer.join('\n');
    tableBuffer = [];
    if (current === '') {
      current = block;
      return;
    }
    const candidate = current + '\n' + block;
    if (candidate.length > max) {
      pushCurrent();
      current = block;
    } else {
      current = candidate;
    }
  };
  const appendLine = (line) => {
    if (current === '') {
      current = line;
      return;
    }
    const candidate = current + '\n' + line;
    if (candidate.length > max) {
      pushCurrent();
      current = line;
    } else {
      current = candidate;
    }
  };

  for (const line of lines) {
    if (CODE_FENCE_OPEN.test(line)) {
      flushTable();
      inCodeBlock = !inCodeBlock;
      appendLine(line);
      continue;
    }
    if (inCodeBlock) {
      appendLine(line);
      continue;
    }
    if (GFM_TABLE_LINE.test(line)) {
      tableBuffer.push(line);
      continue;
    }
    flushTable();
    appendLine(line);
  }
  flushTable();
  if (current !== '') chunks.push(current);

  // 硬切兜底：单行超长（没有换行可断）时按 limit 切
  const out = [];
  const source = chunks.length > 0 ? chunks : [input];
  for (const chunk of source) {
    if (chunk.length <= max) {
      out.push(chunk);
      continue;
    }
    let rest = chunk;
    while (rest.length > max) {
      out.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    if (rest.length > 0) out.push(rest);
  }
  return out;
}

/**
 * 已发送消息跟踪器：记录 id 与规范化文本，供 replyProbe 判断引用对象。
 * @param {object} [options]
 * @param {number} [options.maxIds] 最多保留的 id 数
 * @param {number} [options.maxTexts] 最多保留的文本数
 */
export function createSentTracker({ maxIds = 500, maxTexts = 200 } = {}) {
  const ids = new Map();
  const texts = new Map();

  const normalize = (text) => String(text || '')
    .toLowerCase()
    .replace(/[\s*_~>#[\]()（）「」【】,.!?！？。，、:：;；"'“”‘’\-]/g, '')
    .slice(0, 120);

  const trimMap = (map, max) => {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };

  return {
    /** 记录一条发送结果（MessageResponse 或 id 字符串）与可选的发送文本。 */
    record(resultOrId, text) {
      const id = typeof resultOrId === 'string' ? resultOrId : (resultOrId && resultOrId.id);
      if (id) {
        ids.set(String(id), Date.now());
        trimMap(ids, maxIds);
      }
      if (typeof text === 'string') {
        const normalized = normalize(text);
        if (normalized.length >= 4) {
          texts.set(normalized, Date.now());
          trimMap(texts, maxTexts);
        }
      }
    },
    /** 消息 id 是否是我们发过的。 */
    hasId(id) {
      if (!id) return false;
      return ids.has(String(id));
    },
    /** 文本是否命中我们发过的消息（短文本要求完全相等，长文本允许包含匹配）。 */
    hasText(text) {
      const normalized = normalize(text);
      if (normalized.length < 4) return false;
      if (texts.has(normalized)) return true;
      if (normalized.length < 8) return false;
      for (const sent of texts.keys()) {
        if (normalized.includes(sent) || sent.includes(normalized)) return true;
      }
      return false;
    },
    size() {
      return ids.size + texts.size;
    },
  };
}

/** 从 turn/end 的 reason 中提取错误信息（兼容 error/failure/顶层三种历史格式）。 */
export function extractTurnError(reason) {
  if (!reason || reason.kind !== 'error') return undefined;
  const detail = reason.error || reason.failure;
  return {
    code: (detail && detail.code) || reason.code || 'UNKNOWN',
    message: (detail && detail.message) || reason.message || 'unknown error',
  };
}

/**
 * 创建出站事件处理器，注册到 ctx.on('session/event', handler)。
 * @param {object} args
 * @param {object} args.config 部署配置（textChunkLimit）
 * @param {object} args.logger 日志对象
 * @param {object} args.manager SessionManager
 * @param {object} args.stats 统计对象
 * @param {object} args.sentTracker createSentTracker() 实例
 * @param {Function} args.getBot 返回当前 QQBot 实例
 * @param {object} [args.collector] memory collector（turn/end 时调用 noteTurnEnd）
 * @param {object} [args.settings] settings-store（读取 reply.bubbleSplit）
 */
export function createOutboundHandler({ config = {}, logger, manager, stats, sentTracker, getBot, collector, settings } = {}) {
  const log = logger || console;
  const limit = Number(config.textChunkLimit) > 0 ? Number(config.textChunkLimit) : 4500;
  // 本轮最终要发的文本：assistant/message 可能在「调用工具前」先吐一段，
  // 之后工具结果回来还会再生成最终回复；两段都发出去就会造成"重复发好几条"。
  // 因此只在 turn/end 发送本 turn 最后一个 assistant 文本（真正给用户的那段）。
  const pendingBySession = new Map();

  function rememberPending(sessionId, text) {
    if (pendingBySession.size > 200) {
      const oldest = pendingBySession.keys().next().value;
      if (oldest !== undefined && oldest !== sessionId) pendingBySession.delete(oldest);
    }
    pendingBySession.set(sessionId, text);
  }

  /** 发送单个 chunk：被动回复优先，失败降级主动推送。 */
  async function sendChunk(bot, record, chunk) {
    const target = record.replyTarget || {};
    try {
      const result = await bot.sendMarkdown(target, chunk);
      if (sentTracker) sentTracker.record(result, chunk);
      return true;
    } catch (err) {
      log.warn('被动回复失败（可能窗口过期/超频），尝试主动推送: ' + errText(err));
    }
    try {
      const proactive = { scope: target.scope, targetId: target.targetId };
      const result = await bot.sendMarkdown(proactive, chunk);
      if (sentTracker) sentTracker.record(result, chunk);
      return true;
    } catch (err) {
      log.error('主动推送也失败，放弃本条: ' + errText(err));
      return false;
    }
  }

  /** 读取气泡拆分模式：auto=空行自动拆 / marker=只认 [[msg]] / off=永不拆。 */
  function bubbleSplitMode() {
    try {
      const cfg = settings && typeof settings.get === 'function' ? settings.get() : null;
      const mode = cfg && cfg.reply ? cfg.reply.bubbleSplit : '';
      return mode === 'auto' || mode === 'marker' || mode === 'off' ? mode : 'auto';
    } catch {
      return 'auto';
    }
  }

  /** 发送一条完整文本（按气泡拆分设置分条，再按长度切分）。 */
  async function sendText(record, text) {
    const bot = typeof getBot === 'function' ? getBot() : undefined;
    if (!bot || typeof bot.sendMarkdown !== 'function') {
      log.warn('bot 未就绪，跳过发送');
      return false;
    }
    let sentAny = false;
    text = convertEmojiTokens(text);
    const mode = bubbleSplitMode();
    let segments;
    if (mode === 'off') {
      segments = [text];
    } else {
      const explicit = splitSegments(text);
      if (explicit.length > 1) segments = explicit;
      else if (mode === 'marker') segments = [text];
      else segments = splitBlankLineSegments(explicit[0] || '');
    }
    for (const segment of segments) {
      if (!segment.trim()) continue;
      for (const chunk of chunkMarkdownText(segment, limit)) {
        if (!chunk.trim()) continue;
        const ok = await sendChunk(bot, record, chunk);
        if (ok) sentAny = true;
      }
    }
    return sentAny;
  }

  /**
   * assistant/message：先记下本 step 的文本，不立即发送。
   * 理由：一个 turn 里如果先讲话再调工具，step 1 的文本只是中间话术，
   * step 2 工具回来后才是最终回复；立即发送两条几乎一样的消息就是重复。
   */
  async function onAssistantMessage(record, raw, sessionId) {
    const data = raw && raw.data ? raw.data : {};
    const message = data.message;
    if (!message || !Array.isArray(message.content)) return;
    const parts = [];
    for (const block of message.content) {
      if (block && block.type === 'text' && block.text) parts.push(block.text);
    }
    const text = parts.join('\n');
    if (!text.trim()) return;
    rememberPending(sessionId, text);
    if (record) record.lastActivity = Date.now();
  }

  /** turn/end：发送本 turn 最终文本 + 异常提示 + 记忆收集 + 活跃时间更新。 */
  async function onTurnEnd(record, raw, sessionId) {
    const data = raw && raw.data ? raw.data : {};
    const reason = data.reason || {};
    if (record) record.lastActivity = Date.now();
    const pending = pendingBySession.get(sessionId);
    pendingBySession.delete(sessionId);
    const failure = extractTurnError(reason);
    const completed = !reason.kind || reason.kind === 'completed';

    // 只有正常完成的 turn 才发送最终文本；异常/中止的残留中间话术不发，避免误导。
    if (completed && pending) {
      const sent = await sendText(record, pending);
      if (sent) {
        stats.replies = (Number(stats.replies) || 0) + 1;
        stats.lastReplyAt = Date.now();
      }
    }
    if (record && collector && typeof collector.noteTurnEnd === 'function') {
      try {
        collector.noteTurnEnd(record);
      } catch (err) {
        log.warn('memory collector.noteTurnEnd 失败: ' + errText(err));
      }
    }
    if (!failure) return;
    if (SILENT_TURN_ERROR_CODES.has(failure.code)) return;
    log.warn('本轮异常结束: ' + failure.code + ': ' + failure.message);
    if (record) {
      const notice = '⚠️ 本轮异常结束\n**' + failure.code + '**: ' + failure.message;
      await sendText(record, notice);
    }
  }

  return function outboundHandler(session, raw) {
    try {
      if (!session || !raw || typeof raw !== 'object') return;
      const header = session.header && typeof session.header === 'object' ? session.header : {};
      const sessionId = header.id || session.id;
      if (!sessionId) return;
      const record = manager.findBySessionId(sessionId);
      if (raw.type === 'assistant/message') {
        if (!record) return;
        onAssistantMessage(record, raw, sessionId).catch((err) => log.error('出站消息发送异常: ' + errText(err)));
        return;
      }
      if (raw.type === 'turn/end') {
        if (!record) return;
        onTurnEnd(record, raw, sessionId).catch((err) => log.error('出站 turn/end 处理异常: ' + errText(err)));
      }
    } catch (err) {
      log.error('出站事件分发异常: ' + errText(err));
    }
  };
}