/**
 * inbound —— 把经过中间件管线的 QQ 消息组装成 agent 可读的一条 UserMessage。
 *
 * 组装层次（DESIGN 约定）：
 *   1. 媒体元数据行：图片 / 视频 / 文件（下载成功给本地绝对路径，失败降级为 URL）
 *   2. 引用消息块：[Quoted message begins]...[Quoted message ends][Current message]
 *   3. 群聊发送者标签：[昵称 (openid)] 内容 (@you)；私聊不加标签
 *   4. 群聊历史块：[Chat history begins]...[Chat history ends]（仅群聊、仅触发的消息）
 *   5. 频率触发提示：非强制触发（mode / flush）时加一行群聊节奏提示
 *   6. 语音：优先用中间件处理出的转写，其次 QQ 自带的 asr_refer_text；都没有则给 URL
 *
 * 同一 peer 串行由 concurrencyGuard(merge) + followup 后 await whenIdle 保证。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { classifyContentType, formatFileSize } from './attachment.js';
import { clearGroupHistory, peerInfo } from './middleware.js';

/** 无昵称时用 openid 前 N 位作为匿名标识。 */
const SENDER_SHORT_ID_LEN = 8;

function shortSenderId(senderId) {
  return String(senderId || '').slice(0, SENDER_SHORT_ID_LEN);
}

/** 发兜底提示；失败只记日志，绝不抛出。 */
async function safeSend(bot, target, text, logger) {
  if (!bot || typeof bot.sendMarkdown !== 'function' || !target) return;
  try {
    await bot.sendMarkdown(target, text);
  } catch (err) {
    logger?.warn?.('兜底回复发送失败: ' + (err && err.message));
  }
}

/** 组装媒体元数据行（当前消息 + 引用附件）。 */
function buildMediaLines(msg, state) {
  const lines = [];
  const downloaded = Array.isArray(state.downloadedFiles) ? state.downloadedFiles : [];
  const byFilename = new Map();
  for (const item of downloaded) {
    if (item && item.filename) byFilename.set(item.filename, item);
  }
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  for (const att of attachments) {
    if (!att) continue;
    const kind = classifyContentType(att.content_type);
    if (kind === 'voice') continue; // 语音单独处理
    const local = byFilename.get(att.filename);
    if (kind === 'image') {
      lines.push('[图片]');
      lines.push('Image: ' + (local ? local.localPath : (att.url || att.filename || 'image')));
    } else if (kind === 'video') {
      lines.push('[视频]');
      lines.push('Video: ' + (local ? local.localPath : (att.url || att.filename || 'video')));
    } else {
      const name = att.filename || (local ? local.filename : 'file');
      const size = local ? local.size : (Number(att.size) || 0);
      lines.push('[文件]');
      lines.push('File: ' + (local ? local.localPath : name) + ' (' + formatFileSize(size) + ')');
    }
  }

  // 引用消息的附件（独立于当前消息媒体）
  const quoteAttachments = state.quote && Array.isArray(state.quote.attachments) ? state.quote.attachments : [];
  if (quoteAttachments.length > 0) {
    const quoteDownloaded = Array.isArray(state.downloadedQuoteFiles) ? state.downloadedQuoteFiles : [];
    const quoteByFilename = new Map();
    for (const item of quoteDownloaded) {
      if (item && item.filename) quoteByFilename.set(item.filename, item);
    }
    const sub = [];
    for (const qa of quoteAttachments) {
      if (!qa) continue;
      const kind = classifyContentType(qa.contentType);
      if (kind === 'voice') {
        sub.push('  - Voice: ' + (qa.asrText || qa.url || 'voice'));
        continue;
      }
      const local = quoteByFilename.get(qa.filename || '');
      const target = local ? local.localPath : (qa.url || qa.filename || kind);
      const label = kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : 'File';
      sub.push('  - ' + label + ': ' + target);
    }
    if (sub.length > 0) {
      lines.push('[引用附件]');
      for (const line of sub) lines.push(line);
    }
  }
  return lines;
}

/** 语音转写文本（processedAttachments 优先，其次 QQ ASR，最后 URL）。 */
function buildVoicePart(msg, state) {
  const parts = [];
  const processed = Array.isArray(state.processedAttachments) ? state.processedAttachments : [];
  for (const pa of processed) {
    if (pa && pa.type === 'voice' && pa.voiceText) {
      const duration = pa.duration ? ' (' + pa.duration + 's)' : '';
      parts.push('[语音' + duration + '] ' + pa.voiceText);
    }
  }
  if (parts.length === 0) {
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    for (const att of attachments) {
      if (!att || classifyContentType(att.content_type) !== 'voice') continue;
      const asr = att.asr_refer_text ? String(att.asr_refer_text).trim() : '';
      if (asr) parts.push('[语音] ' + asr);
      else if (att.url) parts.push('[语音] ' + att.url);
    }
  }
  return parts.join('\n');
}

/** 引用块；没有可读内容时返回空串。 */
function buildQuotePart(quote) {
  if (!quote) return '';
  const text = (quote.text || (quote.entry && quote.entry.content) || '').trim();
  if (!text) return '';
  return '[Quoted message begins]\n' + text + '\n[Quoted message ends]\n[Current message]\n';
}

/** 用历史块包住当前消息。 */
function wrapWithHistory(historyLines, current) {
  const out = ['[Chat history begins]'];
  for (const line of historyLines) out.push(line);
  out.push('[Chat history ends]', '[Current message]', current);
  return out.join('\n');
}

/**
 * 组装 agentBody（纯文本）。返回空串表示「没有可处理的内容」。
 * @param {object} args
 * @param {object} args.message QQ 入站消息
 * @param {object} args.state 中间件 ctx.state（mention/quote/history/downloadedFiles/triggerReason）
 * @param {'group'|'c2c'} args.scope 会话类型
 * @param {object} [args.logger] 日志对象（预留）
 */
export function assembleAgentBody({ message, state, scope, logger } = {}) {
  const msg = message || {};
  const st = state || {};
  const isGroup = scope === 'group';
  const mention = st.mention && typeof st.mention === 'object' ? st.mention : {};
  const wasMentioned = mention.wasMentioned === true;

  const mediaLines = buildMediaLines(msg, st);
  const voicePart = buildVoicePart(msg, st);
  const quotePart = buildQuotePart(st.quote);

  const textParts = [];
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (content) textParts.push(content);
  if (voicePart) textParts.push(voicePart);
  const bodyText = textParts.join('\n');

  const hasMedia = mediaLines.length > 0;
  // 空消息：没文本、没媒体，也不是群聊 @ —— 直接忽略
  if (!bodyText && !hasMedia && !(isGroup && wasMentioned)) return '';

  let base = '';
  if (hasMedia) base += mediaLines.join('\n') + '\n\n';
  if (isGroup) {
    const senderName = msg.senderName || shortSenderId(msg.senderId);
    base += quotePart + '[' + senderName + ' (' + (msg.senderId || '') + ')] ' + bodyText
      + (wasMentioned ? ' (@you)' : '');
  } else {
    base += quotePart + bodyText;
  }

  // 群聊历史块：仅群聊、且缓冲区有内容时加
  const history = Array.isArray(st.history) ? st.history : [];
  if (isGroup && history.length > 0) {
    const lines = [];
    for (const entry of history) {
      if (!entry) continue;
      const name = entry.senderName || shortSenderId(entry.senderId);
      const body = typeof entry.content === 'string' ? entry.content : '';
      if (!body) continue;
      lines.push('[' + name + ' (' + (entry.senderId || '') + ')] ' + body);
    }
    if (lines.length > 0) base = wrapWithHistory(lines, base);
  }

  // 频率触发提示：非强制触发（mode/flush）时提示这是「一批消息」而不是一对一提问
  const reason = typeof st.triggerReason === 'string' ? st.triggerReason : '';
  const forced = st.forced === true;
  if (isGroup && !forced && (reason === 'mode' || reason === 'flush')) {
    base = '[群聊节奏采样] 这是最近群聊中的一批消息，请挑选真正需要你回应的话题回复；不必逐条回答。\n\n' + base;
  }
  return base;
}

/**
 * 创建入站消息处理器（注册到 bot.on('message')）。
 * @param {object} args
 * @param {object} args.config 部署配置（appId 用于清历史）
 * @param {object} args.logger 日志对象
 * @param {object} args.manager SessionManager
 * @param {object} args.settings settings-store
 * @param {object} args.stats 统计对象
 * @param {object} args.historyStore 群历史存储
 */
export function createInboundHandler({ config = {}, logger, manager, settings, stats, historyStore } = {}) {
  const log = logger || console;
  return async function handleInbound(mCtx) {
    try {
      const msg = mCtx && mCtx.message;
      if (!msg) return;
      const { scope, peerId } = peerInfo(msg);
      if (!peerId) return;
      const replyTarget = mCtx.replyTarget || { scope, targetId: peerId, msgId: msg.messageId };
      // 每次消息都重新读取设置（热更新立即生效）
      settings.get();
      const state = mCtx.state || {};
      const body = assembleAgentBody({ message: msg, state, scope, logger: log });
      if (!body) {
        log.debug('入站消息无有效内容，忽略');
        return;
      }
      log.info('收到消息: scope=' + scope + ' peer=' + peerId + ' reason=' + (state.triggerReason || '')
        + ' body=' + body.slice(0, 120).replace(/\n/g, ' '));

      let record;
      try {
        record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
      } catch (err) {
        log.error('创建会话失败: ' + (err && err.message));
        await safeSend(mCtx.bot, replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。', log);
        return;
      }

      const userMessage = createUserMessage({
        content: [{ type: 'text', text: body }],
        source: { kind: 'user' },
      });
      try {
        // followup 在宿主契约里是同步的，但仍然 await 一次：
        // 若未来宿主改成返回 Promise，rejection 也会被这里的 try/catch 接住，不会变成 unhandled。
        await record.agent.followup(userMessage);
      } catch (err) {
        log.error('followup 失败: ' + (err && err.message));
        await safeSend(mCtx.bot, replyTarget, '⚠️ 消息投递失败，请稍后重试。', log);
        return;
      }
      record.lastActivity = Date.now();

      // 群消息已交给 agent，清空历史缓冲，避免下次重复堆上下文
      if (scope === 'group') {
        clearGroupHistory(historyStore, config.appId, msg.groupOpenid || msg.senderId);
      }

      // 等本轮收敛，避免同一 peer 的下一条消息在 turn 运行期间打断
      try {
        await record.agent.whenIdle();
      } catch (err) {
        log.warn('whenIdle rejected: ' + (err && err.message));
      }
    } catch (err) {
      log.error('入站处理异常: ' + (err && err.message));
    }
  };
}
