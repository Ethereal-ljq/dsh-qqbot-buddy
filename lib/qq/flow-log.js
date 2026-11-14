/**
 * qq/flow-log —— 把一条群消息写入全量流水（core/messages/flow）。
 *
 * 为什么单独一层：
 *   middleware 里只做「取 ctx、判开关、组装正文」，落库的字段归一/裁剪/异常兜底放这里，
 *   与 message-log.js（对话轮次）保持同一套风格，便于单测。
 *
 * 约定：
 *   - 只存文本正文，附件在正文里是占位行（[图片]/[语音]/[文件]）；
 *   - messageId 缺失时传空串（store 侧不去重）；
 *   - 写入失败只 warn，绝不阻塞消息管线。
 */

/** 从 QQ 消息时间戳（ISO 字符串）取毫秒；解析失败用当前时间。 */
function createdAtOf(message, now = Date.now) {
  const raw = message && message.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now();
}

/**
 * 追加一条群消息流水。
 * @param {object} args
 * @param {object} args.flow createFlowStore() 返回的 store
 * @param {string} args.botId
 * @param {string} args.peer 'group:<openid>'
 * @param {object} args.message QQ 入站消息
 * @param {string} args.body 已组装好的正文（assembleAgentBody 的 c2c 形态：无发言人前缀/历史块）
 * @param {object} [args.logger]
 * @returns {{ok:boolean, created?:boolean, reason?:string}}
 */
export function appendFlowRecord({ flow, botId, peer, message, body, logger } = {}) {
  const log = logger || console;
  if (!flow || typeof flow.append !== 'function') return { ok: false, reason: 'no-store' };
  const msg = message && typeof message === 'object' ? message : {};
  try {
    return flow.append({
      botId: String(botId || ''),
      peer: String(peer || ''),
      messageId: typeof msg.messageId === 'string' ? msg.messageId : '',
      senderId: typeof msg.senderId === 'string' ? msg.senderId : '',
      senderName: typeof msg.senderName === 'string' ? msg.senderName : '',
      msgType: Number(msg.msgType) || 0,
      content: typeof body === 'string' ? body.trim() : '',
      createdAt: createdAtOf(msg),
    });
  } catch (err) {
    log.warn?.('群消息流水写入失败（忽略）: ' + (err && err.message));
    return { ok: false, reason: 'error' };
  }
}

export default appendFlowRecord;
