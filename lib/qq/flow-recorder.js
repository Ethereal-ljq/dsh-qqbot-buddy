/**
 * qq/flow-recorder —— 门控之前的「全量群消息」落库中间件。
 *
 * 为什么需要它：
 *   现有的 messages 流水（message-log）只在 inbound 里写，而 inbound 位于频率门控之后，
 *   所以库里只有「触发回复的那条 + 助手回复」。群分析/日报需要的是「群里每条消息」。
 *
 * 位置：
 *   errorHandler → stats → messageFilter → accessPolicy → historyBuffer → quoteRef
 *   → mentionGate → contentSanitizer → **flowRecorder** → rateLimiter → 命令 → 频率门控
 *
 *   放在 contentSanitizer 之后：正文已去掉 @marker/表情标签；
 *   放在频率门控之前：@ 没 @ bot、会不会回复，都不影响入库。
 *
 * 正文口径：
 *   复用 inbound 的 assembleAgentBody，但以 c2c 形态组装（不带「[昵称 (openid)]」前缀、
 *   不带 [Chat history] 历史块、不带采样提示），发言人与 openid 走数据库列。
 *   这样图片/卡片/转发/引用与 agent 看到的正文一致，只是没有历史块。
 */
import { assembleAgentBody } from './inbound.js';
import { appendFlowRecord } from './flow-log.js';

/** 读 peer 生效设置（与 middleware.js 的 readSettings 同一语义）。 */
function readPeerSettings(settings, peer) {
  try {
    if (settings && typeof settings.forPeer === 'function') return settings.forPeer(peer) || {};
    return (settings && typeof settings.get === 'function' ? settings.get() : null) || {};
  } catch {
    return {};
  }
}

/**
 * 创建全量群消息流水中间件。
 * @param {object} args
 * @param {object} args.flow createFlowStore() 返回的 store（缺失时返回 null，装配侧跳过）
 * @param {string} args.botId
 * @param {object} args.settings settings-store（按 peer 读 messages.*）
 * @param {object} [args.sentTracker] 已发送消息跟踪器（过滤机器人自己的回声）
 * @param {object} [args.logger]
 * @param {Function} [args.assemble] 正文组装函数（测试可注入）
 * @returns {Function|null} 中间件；依赖不全时返回 null
 */
export function createFlowRecorder({
  flow,
  botId,
  settings,
  sentTracker,
  logger,
  assemble = assembleAgentBody,
} = {}) {
  const log = logger || console;
  const owner = String(botId || '');
  if (!flow || typeof flow.append !== 'function' || owner === '' || typeof assemble !== 'function') {
    return null;
  }

  return async function flowRecorder(ctx, next) {
    try {
      const msg = ctx && ctx.message;
      if (!msg || msg.kind !== 'group' || !msg.groupOpenid) return await next();
      const peer = 'group:' + msg.groupOpenid;
      const config = readPeerSettings(settings, peer);
      const messagesCfg = config && typeof config.messages === 'object' ? config.messages : {};
      // 总开关（messages.enabled）与全量开关（messages.captureFlow）都要开
      if (messagesCfg.enabled === false || messagesCfg.captureFlow === false) return await next();
      // 机器人自己的回声：SDK 标了 senderIsBot，或 messageId 命中已发送跟踪器
      if (msg.senderIsBot === true) return await next();
      if (msg.messageId && sentTracker && typeof sentTracker.hasId === 'function' && sentTracker.hasId(msg.messageId)) {
        return await next();
      }
      const state = ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
      // c2c 形态：只保留正文/媒体/引用/转发，不拼发言人与历史块（列里已有）
      const body = assemble({
        message: msg,
        state: {
          mention: state.mention,
          quote: state.quote,
          history: [],
          downloadedFiles: [],
          processedAttachments: [],
          triggerReason: '',
          forced: true,
        },
        scope: 'c2c',
        logger: log,
        sentTracker,
      });
      if (typeof body === 'string' && body.trim() !== '') {
        appendFlowRecord({ flow, botId: owner, peer, message: msg, body, logger: log });
      }
    } catch (err) {
      // 流水失败绝不影响消息管线
      log.warn?.('群消息流水记录失败（忽略）: ' + ((err && err.message) || String(err)));
    }
    return await next();
  };
}

export default createFlowRecorder;
