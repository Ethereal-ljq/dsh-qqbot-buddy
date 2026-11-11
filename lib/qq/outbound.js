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
import { appendAssistantRecord, appendMessageRecord } from './message-log.js';
import { appendTranscript, transcriptOf } from './transcript.js';

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
      // 引用回复的 ref_idx（REFIDX_*）：用户引用机器人消息时事件里给的是这个索引，
      // 记下来 replyProbe 才能稳定判断「在回复机器人」，而不是只靠文本包含匹配。
      const refIdx = resultOrId && typeof resultOrId === 'object' && resultOrId.ext_info
        ? resultOrId.ext_info.ref_idx
        : undefined;
      if (refIdx) {
        ids.set(String(refIdx), Date.now());
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
export function createOutboundHandler({ config = {}, logger, manager, stats, sentTracker, getBot, getMediaSender, collector, settings, getSender, messages } = {}) {
  const log = logger || console;
  const limit = Number(config.textChunkLimit) > 0 ? Number(config.textChunkLimit) : 4500;

  // 生图/改图工具产出的图片：工具结果里的「附件」只进模型上下文，QQ 用户看不到。
  // 模型有时只说一句「喏」忘了调 qqbot_send_file，所以这里在 turn/end 兜底补发。
  const IMAGE_GEN_TOOLS = new Set(['generate_image', 'generate_images', 'edit_image']);
  const SAVED_PATH_RE = /(?:saved to the workspace as|saved to|written to|savedTo["']?\s*[:=])\s*["']?(\/[^\s"')\]，。]+?\.(?:png|jpe?g|webp|gif))/giu;
  /** sessionId -> { generated:Set, sent:Set, callNames:Map, manualSends:Map<callId,path> } */
  const imageTurns = new Map();
  function imageState(sessionId) {
    let state = imageTurns.get(sessionId);
    if (!state) {
      state = { generated: new Set(), sent: new Set(), callNames: new Map(), manualSends: new Map() };
      imageTurns.set(sessionId, state);
    }
    return state;
  }
  function extractSavedPaths(text) {
    const out = [];
    const body = String(text || '');
    SAVED_PATH_RE.lastIndex = 0;
    let match;
    while ((match = SAVED_PATH_RE.exec(body)) !== null) {
      if (match[1]) out.push(match[1]);
    }
    return out;
  }
  /** 模型自己用 qqbot_send_file 发过的路径（避免兜底重复发）——只有发送成功才算。 */
  function rememberManualSend(state, raw) {
    const data = raw && raw.data ? raw.data : {};
    if (data.name !== 'qqbot_send_file') return;
    try {
      const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
      const filePath = args && typeof args.file_path === 'string' ? args.file_path : '';
      const callId = data.callId;
      if (filePath !== '' && callId !== undefined) state.manualSends.set(callId, filePath);
    } catch { /* 参数不是 JSON 时忽略 */ }
  }
  /** 手动发送的工具结果回来了：成功才标记 sent；失败留给 turn/end 兜底补发。 */
  function resolveManualSend(state, raw) {
    const data = raw && raw.data ? raw.data : {};
    const message = data.message || {};
    const callId = data.toolCallId || message.toolCallId || (message.source && message.source.callId);
    if (callId === undefined || !state.manualSends.has(callId)) return;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks.map((block) => (block && block.type === 'text' ? String(block.text || '') : '')).join('\n').trim();
    if (!/^error/i.test(text)) state.sent.add(state.manualSends.get(callId));
    state.manualSends.delete(callId);
  }
  function rememberGenerated(state, raw) {
    const data = raw && raw.data ? raw.data : {};
    const message = data.message || {};
    const callId = data.toolCallId || message.toolCallId || (message.source && message.source.callId);
    const toolName = callId !== undefined ? state.callNames.get(callId) : undefined;
    if (!toolName || !IMAGE_GEN_TOOLS.has(toolName)) return;
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!block || block.type !== 'text') continue;
      for (const filePath of extractSavedPaths(block.text)) state.generated.add(filePath);
    }
  }
  /** turn/end 兜底：把本 turn 生成但没发出去的图片补发给用户。 */
  async function autoSendGeneratedImages(record, sessionId) {
    const state = imageTurns.get(sessionId);
    if (!state || state.generated.size === 0) return;
    const mediaSender = typeof getMediaSender === 'function' ? getMediaSender() : undefined;
    if (!mediaSender || typeof mediaSender.sendImage !== 'function') {
      log.warn?.('生成了图片但媒体发送器不可用，跳过自动补发');
      return;
    }
    const target = targetOf(record);
    let count = 0;
    for (const filePath of state.generated) {
      if (state.sent.has(filePath)) continue;
      if (count >= 5) break;
      try {
        await mediaSender.sendImage(target, { localPath: filePath });
        stats.images = (Number(stats.images) || 0) + 1;
        state.sent.add(filePath);
        count += 1;
        log.info?.('自动补发生成图片: ' + filePath);
      } catch (err) {
        log.warn?.('生成图片自动补发失败（' + filePath + '）: ' + errText(err));
      }
    }
  }
  /**
   * 出站目标：优先本 turn 入站时记下的 replyTarget（带 msgId，走被动回复）；
   * 没有（如互动投喂创建的新会话）时按 record.peer 推导主动目标。
   */
  function targetOf(record) {
    if (record && record.replyTarget && record.replyTarget.targetId) return record.replyTarget;
    if (record && typeof record.peer === 'string') {
      const sep = record.peer.indexOf(':');
      if (sep > 0) return { scope: record.peer.slice(0, sep), targetId: record.peer.slice(sep + 1) };
    }
    return {};
  }

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

  /** 发送单个 chunk：优先交给统一 sender（被动预算/错误码分类/主动频控/引用），无 sender 时走旧逻辑。 */
  async function sendChunk(bot, record, chunk, opts = {}) {
    // target 由 sendText 在开头发快照后传进来（见 sendText 的注释），避免逐条现读。
    const target = opts.target || targetOf(record);
    const sender = typeof getSender === 'function' ? getSender() : undefined;
    if (sender && typeof sender.sendMarkdown === 'function') {
      const res = await sender.sendMarkdown(target, chunk, { quote: opts.quote === true });
      if (res && res.ok) {
        if (sentTracker) sentTracker.record(res.result, chunk);
        return true;
      }
      log.error('发送失败（code=' + (res && res.code) + '）：' + (res && res.error));
      return false;
    }
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

  /** 读设置：v2 按 peer 生效（record.peer），兼容 v1 settings.get()。 */
  function readSettings(record) {
    try {
      const peer = record && typeof record.peer === 'string' && record.peer !== ''
        ? record.peer
        : (record && record.replyTarget ? String(record.replyTarget.scope || '') + ':' + String(record.replyTarget.targetId || '') : '');
      if (settings && typeof settings.forPeer === 'function') return settings.forPeer(peer) || {};
      return (settings && typeof settings.get === 'function' ? settings.get() : null) || {};
    } catch {
      return {};
    }
  }

  /** 读取气泡拆分模式：auto=空行自动拆 / marker=只认 [[msg]] / off=永不拆。 */
  function bubbleSplitMode(record) {
    try {
      const cfg = readSettings(record);
      const mode = cfg && cfg.reply ? cfg.reply.bubbleSplit : '';
      return mode === 'auto' || mode === 'marker' || mode === 'off' ? mode : 'auto';
    } catch {
      return 'auto';
    }
  }

  /** 单 turn 最多气泡数（v2 reply.maxBubbles；v1 默认 4）。 */
  function maxBubblesOf(record) {
    try {
      const cfg = readSettings(record);
      const raw = cfg && cfg.reply ? Number(cfg.reply.maxBubbles) : NaN;
      return Number.isFinite(raw) && raw >= 1 ? Math.min(10, Math.floor(raw)) : 4;
    } catch {
      return 4;
    }
  }

  /** 发送一条完整文本（按气泡拆分设置分条，再按长度切分）。 */
  async function sendText(record, text, opts = {}) {
    const bot = typeof getBot === 'function' ? getBot() : undefined;
    if (!bot || typeof bot.sendMarkdown !== 'function') {
      log.warn('bot 未就绪，跳过发送');
      return false;
    }
    let sentAny = false;
    text = convertEmojiTokens(text);
    const mode = bubbleSplitMode(record);
    let segments;
    if (mode === 'off') {
      segments = [text];
    } else {
      const explicit = splitSegments(text);
      if (explicit.length > 1) segments = explicit;
      else if (mode === 'marker') segments = [text];
      else segments = splitBlankLineSegments(explicit[0] || '', { maxSegments: maxBubblesOf(record) });
    }
    // 引用回复由模型决定：只有本轮调用了 qqbot_quote_reply（record.quoteNext=true）才引用，
    // 且只加在首条成功发出的消息上，避免每条气泡都带引用框。
    const wantQuote = !!(record && record.quoteNext === true) && opts.quote !== false;
    if (record && record.quoteNext === true) record.quoteNext = false;
    let quotePending = wantQuote;
    // 同一 turn 的所有气泡钉在同一个 replyTarget 上：turn/end 是异步发送（可能持续数秒到
    // 数分钟），期间新入站消息会覆盖 record.replyTarget；逐条现读会让本轮气泡挂到下一轮的
    // msg_id 上——既白吃对方的 5 次被动额度，也让两条长回复在同一 msg_id 上互相挤占。
    const target = targetOf(record);
    for (const segment of segments) {
      if (!segment.trim()) continue;
      for (const chunk of chunkMarkdownText(segment, limit)) {
        if (!chunk.trim()) continue;
        const ok = await sendChunk(bot, record, chunk, { quote: quotePending, target });
        if (ok) {
          sentAny = true;
          quotePending = false;
        }
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
      // 助手侧消息也进消息流水（L0）：只存用户侧的话会让提炼缺上下文，
      // 比如「约定发🌶🕊回飞八分钱」这类事实必须看到机器人的回应才能确认。
      if (record) {
        appendAssistantRecord({
          messages,
          botId: record.botId || (record.state && record.state.botId) || '',
          peer: typeof record.peer === 'string' ? record.peer : '',
          content: pending,
          logger: log,
        });
      }
    }
    // 生图/改图工具产出的图片：模型可能忘了 qqbot_send_file，这里兜底补发
    if (completed) {
      await autoSendGeneratedImages(record, sessionId);
      imageTurns.delete(sessionId);
    }
    if (record && collector && typeof collector.noteTurnEnd === 'function') {
      try {
        // 把本 turn 的助手最终文本并入转录，再把完整对话交给记忆提炼器
        // （core/memory/collect.js 的 noteTurnEnd 支持 { botId, transcript }，优先于逐轮缓冲）。
        if (completed && pending) appendTranscript(record, '助手: ' + pending);
        const transcript = transcriptOf(record);
        collector.noteTurnEnd(record, transcript !== '' ? { transcript } : {});
      } catch (err) {
        log.warn('memory collector.noteTurnEnd 失败: ' + errText(err));
      }
    }
    if (!failure) return;
    if (SILENT_TURN_ERROR_CODES.has(failure.code)) return;
    log.warn('本轮异常结束: ' + failure.code + ': ' + failure.message);
    if (record) {
      const notice = '⚠️ 本轮异常结束\n**' + failure.code + '**: ' + failure.message;
      await sendText(record, notice, { quote: false });
    }
  }

  return function outboundHandler(session, raw) {
    try {
      if (!session || !raw || typeof raw !== 'object') return;
      const header = session.header && typeof session.header === 'object' ? session.header : {};
      const sessionId = header.id || session.id;
      if (!sessionId) return;
      // 工具事件先于 record 处理：生图结果 / 手动发送记录都与 agent 无关
      if (raw.type === 'tool/call' || raw.type === 'tool/result') {
        const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
        const state = imageState(sessionId);
        if (raw.type === 'tool/call') {
          rememberManualSend(state, raw);
          if (IMAGE_GEN_TOOLS.has(String(data.name || ''))) state.callNames.set(data.callId, data.name);
        } else {
          rememberGenerated(state, raw);
          resolveManualSend(state, raw);
        }
        return;
      }
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