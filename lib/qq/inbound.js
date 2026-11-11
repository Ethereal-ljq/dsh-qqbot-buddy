/**
 * inbound —— 把经过中间件管线的 QQ 消息组装成 agent 可读的一条 UserMessage。
 *
 * 组装层次（DESIGN 约定）：
 *   1. 媒体元数据行：图片 / 视频 / 文件（下载成功给本地绝对路径，失败降级为 URL）
 *   2. ARK 卡片行：分享的小程序 / 图文 / 链接卡片拼成 [卡片:模板名] 标题｜来源｜摘要｜链接
 *      （渲染规则见 card-render.js；卡片同时记进回查表，供群历史回填）
 *   3. 引用消息块：[Quoted message begins]...[Quoted message ends][Current message]
 *   4. 群聊发送者标签：[昵称 (openid)] 内容 (@you)；私聊不加标签
 *   5. 群聊历史块：[Chat history begins]...[Chat history ends]（仅群聊、仅触发的消息）
 *   6. 频率触发提示：非强制触发（mode / flush）时加一行群聊节奏提示
 *   7. 语音：优先用中间件处理出的转写，其次 QQ 自带的 asr_refer_text；都没有则给 URL
 *   8. 图片：下载好的图会转成 ImageBlock 与文本放进同一条 UserMessage（模型直接看图）；
 *      无法内联时降级为上面第 1 层的路径文本，模型仍可用 read_image / qqbot_describe_image。
 *
 * 同一 peer 串行由 concurrencyGuard(merge) + followup 后 await whenIdle 保证。
 */
import { classifyContentType, formatFileSize } from './attachment.js';
import { lookupCard, renderMessageCard, rememberCard } from './card-render.js';
import { hasForwardRecord, renderForwardRecord } from './forward-render.js';
import { appendMessageRecord } from './message-log.js';
import { buildInlineImageBlocks, followupWithImageFallback } from './inline-image.js';
import { renderQuoteBlock } from './quote-render.js';
import { clearGroupHistory, peerInfo } from './middleware.js';
import { appendTranscript } from './transcript.js';

/** 无昵称时用 openid 前 N 位作为匿名标识。 */
const SENDER_SHORT_ID_LEN = 8;

function shortSenderId(senderId) {
  return String(senderId || '').slice(0, SENDER_SHORT_ID_LEN);
}

/** 读某个 peer 的生效设置（v2 按作用域绑定；兼容 v1 settings.get()）。 */
function readSettings(settings, peer) {
  try {
    if (settings && typeof settings.forPeer === 'function') return settings.forPeer(peer) || {};
    return (settings && typeof settings.get === 'function' ? settings.get() : null) || {};
  } catch {
    return {};
  }
}

/** 取统一发送器（可选依赖 getSender）；异常一律降级为 undefined，绝不影响主流程。 */
function resolveSender(getSender, logger) {
  if (typeof getSender !== 'function') return undefined;
  try {
    const sender = getSender();
    return sender && typeof sender === 'object' ? sender : undefined;
  } catch (err) {
    logger?.warn?.('获取 sender 失败: ' + (err && err.message));
    return undefined;
  }
}

/**
 * 发兜底提示；失败只记日志，绝不抛出。
 *
 * 优先走统一 sender（sender.js：被动预算 / 错误码分类 / 主动频控 / 引用回复），
 * 没传 getSender 或 sender 不可用时保持旧行为 bot.sendMarkdown。
 * 兜底提示不该引用原消息，统一 quote:false。
 */
async function safeSend(bot, target, text, logger, getSender) {
  if (!target) return;
  const sender = resolveSender(getSender, logger);
  if (sender && typeof sender.sendMarkdown === 'function') {
    try {
      const result = await sender.sendMarkdown(target, text, { quote: false });
      // sender 不抛异常，用结构化结果判断是否发送成功
      if (result && result.ok === false) {
        logger?.warn?.('兜底回复经 sender 发送失败: ' + (result.code || result.error || 'unknown'));
      }
      return;
    } catch (err) {
      logger?.warn?.('兜底回复经 sender 发送失败: ' + (err && err.message));
    }
  }
  if (!bot || typeof bot.sendMarkdown !== 'function') return;
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

/**
 * 引用块；没有可读内容时返回空串。
 *
 * 交给 quote-render 统一处理：带被引用者归属（能认出「引用了机器人自己说的话」），
 * 并去掉旧实现里重复的 [Current message] 标记——那个标记是历史块尾部用的，
 * 引用块再写一次会让模型分不清哪段才是当前消息。
 */
function buildQuotePart(quote, sentTracker) {
  return renderQuoteBlock(quote, { sentTracker });
}

/**
 * ARK 卡片解析：QQ 分享的小程序 / 图文 / 链接卡片 message_type=3，
 * 正文只有 ark_data，content 往往为空。
 *
 * 渲染规则统一收在 lib/qq/card-render.js（renderCard），入站主流程与群历史回填共用同一套，
 * 保证「当前消息」和「历史里的同一条卡片」格式一致。要点：
 *   [卡片:模板名] 标题｜来源｜摘要｜链接
 *   - 摘要不再回落 fields.preview（那是 qq.ugcimg.cn 上的封面图，会挤掉 ark.prompt 里的真摘要）
 *   - 只有 fields.jump_url 存在时才输出链接，否则行尾标注「无可点击链接」
 *   - QQ 图片域名（qq.ugcimg.cn / open.gtimg.cn / miniapp.gtimg.cn / qqbot.ugcimg.cn）一律不输出
 */
function buildCardLines(msg) {
  return renderMessageCard(msg);
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
export function assembleAgentBody({ message, state, scope, logger, sentTracker } = {}) {
  const msg = message || {};
  const st = state || {};
  const isGroup = scope === 'group';
  const mention = st.mention && typeof st.mention === 'object' ? st.mention : {};
  const wasMentioned = mention.wasMentioned === true;

  const mediaLines = buildMediaLines(msg, st);
  const voicePart = buildVoicePart(msg, st);
  const quotePart = buildQuotePart(st.quote, sentTracker);
  const cardLines = buildCardLines(msg);

  const textParts = [];
  // 卡片在前：它本质上就是这条消息的正文（分享卡片通常没有 content）
  for (const line of cardLines) textParts.push(line);
  // 卡片消息的 content 是空串，SDK 的 historyBuffer 又会整条丢弃 → 按 messageId 记一份卡片行，
  // 下次组装群历史时（见下方历史块）用 lookupCard 回填。非卡片消息不写表。
  if (cardLines.length > 0) {
    try {
      rememberCard(msg.messageId, cardLines);
    } catch (err) {
      logger?.warn?.('记录卡片回查表失败（忽略）: ' + (err && err.message));
    }
  }
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
    // 合并转发的聊天记录：QQ 把「转发者」和「记录内作者」平铺成两层同格式的名字，
    // 模型常把记录内作者误当成发言人。这里重排成带归属声明的块（见 forward-render.js）。
    const shownBody = hasForwardRecord(bodyText)
      ? renderForwardRecord(bodyText, { senderName: msg.senderName, senderId: msg.senderId })
      : bodyText;
    // 引用块自身以换行收尾，与当前消息分开（不再依赖 [Current message] 占位）
    const quoteBlock = quotePart === '' ? '' : quotePart + '\n';
    base += quoteBlock + '[' + senderName + ' (' + (msg.senderId || '') + ')] ' + shownBody
      + (wasMentioned ? ' (@you)' : '');
  } else {
    const shownBody = hasForwardRecord(bodyText)
      ? renderForwardRecord(bodyText, { senderName: msg.senderName, senderId: msg.senderId })
      : bodyText;
    const quoteBlock = quotePart === '' ? '' : quotePart + '\n';
    base += quoteBlock + shownBody;
  }

  // 群聊历史块：仅群聊、且缓冲区有内容时加
  const history = Array.isArray(st.history) ? st.history : [];
  if (isGroup && history.length > 0) {
    const lines = [];
    for (const entry of history) {
      if (!entry) continue;
      const name = entry.senderName || shortSenderId(entry.senderId);
      const raw = typeof entry.content === 'string' ? entry.content.trim() : '';
      // 卡片消息的 content 是空串（SDK historyBuffer 只存 content，ark_data 已丢失），
      // 直接用回查表补回卡片行；两处都拿不到才跳过，不留空行。
      let body = raw || lookupCard(entry.messageId);
      if (!body) continue;
      // 历史里的转发同样是两层平铺结构，走同一套重排
      if (hasForwardRecord(body)) {
        body = renderForwardRecord(body, { senderName: entry.senderName, senderId: entry.senderId });
      }
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
 * @param {Function} [args.getSender] 取统一发送器（可选；不传则兜底提示走 bot.sendMarkdown）
 * @param {Function} [args.buildImageBlocks] 图片内联器（默认 qq/inline-image.js，测试可注入）
 */
export function createInboundHandler({
  config = {}, logger, manager, settings, stats, historyStore, members, botId = '', getSender,
  deliver, whenIdle, messages, sentTracker,
  buildImageBlocks = buildInlineImageBlocks,
} = {}) {
  const log = logger || console;
  return async function handleInbound(mCtx) {
    try {
      const msg = mCtx && mCtx.message;
      if (!msg) return;
      const { scope, peerId } = peerInfo(msg);
      if (!peerId) return;
      // 引用回复：优先沿用中间件给出的 replyTarget，并附上本条消息的 msg_idx。
      // sender.js 发被动首条时用它拼 message_reference（没有则不引用）。
      const replyBase = mCtx.replyTarget || { scope, targetId: peerId, msgId: msg.messageId };
      const replyTarget = { ...replyBase, refIdx: msg.msgIdx || undefined };
      // 每次消息都重新读取设置（热更新立即生效）
      const peer = scope + ':' + peerId;
      readSettings(settings, peer);
      const state = mCtx.state || {};
      const body = assembleAgentBody({ message: msg, state, scope, logger: log, sentTracker });
      if (!body) {
        log.debug('入站消息无有效内容，忽略');
        return;
      }
      log.info('收到消息: scope=' + scope + ' peer=' + peerId + ' reason=' + (state.triggerReason || '')
        + ' body=' + body.slice(0, 120).replace(/\n/g, ' '));

      let record;
      try {
        record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
        // 引用标记只对「模型在紧接着的这一轮里调用 qqbot_quote_reply」有效，新消息进来先清空
        record.quoteNext = false;
      } catch (err) {
        log.error('创建会话失败: ' + (err && err.message));
        await safeSend(mCtx.bot, replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。', log, getSender);
        return;
      }

      // 本轮上下文：prompt 的「本轮相关背景」段按这句话做相关性召回（必要时涌现）。
      try {
        record.turn = record.turn && typeof record.turn === 'object' ? record.turn : { current: null };
        record.turn.current = {
          text: typeof msg.content === 'string' ? msg.content : '',
          scope: scope,
          groupId: scope === 'group' ? (msg.groupOpenid || peerId) : '',
          senderId: typeof msg.senderId === 'string' ? msg.senderId : '',
          senderName: typeof msg.senderName === 'string' ? msg.senderName : '',
          at: Date.now(),
        };
      } catch (err) {
        log.warn('写入本轮上下文失败: ' + (err && err.message));
      }

      // 记忆提炼转录：记录用户侧原文（助手侧由 outbound 在 turn/end 追加，整段交给提炼器）
      try {
        appendTranscript(record, '用户: ' + body);
      } catch (err) {
        log.warn('写入转录缓冲失败（忽略）: ' + (err && err.message));
      }

      // 消息流水（L0）：异步落库（默认保留 14 天），失败只 warn，绝不影响回复链路
      appendMessageRecord({ messages, botId, scope, peer, message: msg, body, logger: log });

      // 群友库自动收录（v2）：runtime.members.upsert({botId, openid, nickname})。
      // v2 store 是 bot 级 (bot_id, openid) 模型（没有 groupId 列，群维度信息由人格/画像承担）；
      // 设置 schema 暂无 members.* 开关，默认收录，失败只 warn。
      if (scope === 'group' && members && typeof members.upsert === 'function' && botId !== '') {
        try {
          const openid = typeof msg.senderId === 'string' ? msg.senderId : '';
          if (openid !== '') {
            members.upsert({
              botId,
              openid,
              nickname: typeof msg.senderName === 'string' ? msg.senderName : '',
            });
          }
        } catch (err) {
          log.warn('群友库收录失败（不影响聊天）: ' + (err && err.message));
        }
      }

      // 图片直接进上下文：把这条消息已下载的图存成 durable 附件，和文本一起投递。
      // 失败/不支持图片的模型会返回空数组，自动降级为「只有路径文本」。
      let imageBlocks = [];
      try {
        // 当前消息的图 + 被引用消息里的图都要内联：只给路径的话模型看不到图，
        // 只能靠上下文猜「这张图是谁、画的是什么」（实测会张冠李戴）。
        const downloadedFiles = Array.isArray(state.downloadedFiles) ? state.downloadedFiles : [];
        const downloadedQuoteFiles = Array.isArray(state.downloadedQuoteFiles) ? state.downloadedQuoteFiles : [];
        imageBlocks = await buildImageBlocks({
          downloaded: downloadedFiles.concat(downloadedQuoteFiles),
          manager: manager,
          record: record,
          // inline-image 只认 settings.get()：按 peer 包一层，保证作用域绑定的 vision 设置生效
          settings: typeof settings?.forPeerAsStore === 'function' ? settings.forPeerAsStore(peer) : settings,
          config: config,
          logger: log,
        });
      } catch (err) {
        log.warn('图片内联失败（降级为路径文本）: ' + (err && err.message));
      }

      try {
        // v2 传输契约：统一交给 BotRuntime.followup(peer, {text, imageBlocks})（deliver 由
        // gateway 注入，内部处理「带图被拒 -> 纯文本重投」）。未注入时退回 record.agent
        // 的 v1 路径，保证单测/旧装配仍可用。
        const delivery = typeof deliver === 'function'
          ? await deliver({ peer, body, imageBlocks, record, message: msg })
          : await followupWithImageFallback({
            agent: record.agent,
            body: body,
            imageBlocks: imageBlocks,
            logger: log,
          });
        if (delivery && delivery.ok === false) throw new Error(delivery.error || 'followup 失败');
        if (delivery && delivery.degraded === true) {
          log.warn('本条带图消息已降级为纯文本投递（图仍可按路径读取）');
        }
      } catch (err) {
        log.error('followup 失败: ' + (err && err.message));
        await safeSend(mCtx.bot, replyTarget, '⚠️ 消息投递失败，请稍后重试。', log, getSender);
        return;
      }
      record.lastActivity = Date.now();

      // 群消息已交给 agent，清空历史缓冲，避免下次重复堆上下文
      if (scope === 'group') {
        clearGroupHistory(historyStore, config.appId, msg.groupOpenid || msg.senderId);
      }

      // 等本轮收敛，避免同一 peer 的下一条消息在 turn 运行期间打断
      try {
        if (typeof whenIdle === 'function') {
          await whenIdle(peer);
        } else if (record.agent && typeof record.agent.whenIdle === 'function') {
          await record.agent.whenIdle();
        }
      } catch (err) {
        log.warn('whenIdle rejected: ' + (err && err.message));
      }
    } catch (err) {
      log.error('入站处理异常: ' + (err && err.message));
    }
  };
}
