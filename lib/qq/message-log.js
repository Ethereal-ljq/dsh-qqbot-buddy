/**
 * message-log —— 把入站/出站消息写入 core/messages/store（L0 原始流水）。
 *
 * 为什么要单独一层：
 *   inbound.js 已经很长，落库逻辑（推导 peer、裁剪正文、异常兜底）放这里更好测；
 *   而且写入必须**绝不阻塞回复链路**——这里所有异常都吞掉只 warn。
 *
 * 约定：
 *   - peer 与 memories.peer 同构（'group:<groupOpenid>' / 'c2c:<openid>'）；
 *   - messageId 由 QQ 提供，store 侧按 (bot_id, message_id) 幂等去重；
 *   - 只存文本正文，不存附件（附件走 media 目录 + media-cleaner）。
 */

/** 单条正文上限：与 store 侧一致，避免超长转发撑爆库。 */
const MAX_BODY_CHARS = 8000;

function clip(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value === '') return '';
  const chars = Array.from(value);
  return chars.length <= MAX_BODY_CHARS ? value : chars.slice(0, MAX_BODY_CHARS).join('');
}

/**
 * 去掉正文开头的群聊发言人标签 `[昵称 (openid)] `。
 *
 * inbound 组装的 body 是「给人看的完整行」，带发言人标签；但落库时
 * senderName / senderId 已经单独成列，正文里再来一次会让 transcript 变成
 * 「院: [院 (S2)] 我是单独加的糖蒜」。这里只剥开头那一处，
 * 引用块、历史块里的标签保持不动（那些是多人的上下文，必须保留）。
 */
function stripLeadingSenderTag(text) {
  return text.replace(/^\[[^\]\n]{0,80}\([^)\]\n]{0,80}\)\]\s*/, '');
}

/**
 * 写一条用户侧消息。
 * @param {object} args
 * @param {object} [args.messages] createMessagesStore() 返回的 store；缺失时静默跳过
 * @param {string} args.botId
 * @param {'group'|'c2c'} args.scope
 * @param {string} args.peer 'group:xxx' / 'c2c:xxx'
 * @param {object} args.message QQ 入站消息（取 senderId/senderName/msgType/messageId）
 * @param {string} args.body 已组装好的正文（含卡片/转发/引用等结构化文本）
 * @param {object} [args.logger]
 * @returns {{ok:boolean, created?:boolean, reason?:string}}
 */
export function appendMessageRecord({ messages, botId, scope, peer, message, body, logger } = {}) {
  const log = logger || console;
  if (!messages || typeof messages.save !== 'function') return { ok: false, reason: 'no-store' };
  const msg = message && typeof message === 'object' ? message : {};
  const text = clip(scope === 'group' ? stripLeadingSenderTag(clip(body)) : clip(body));
  if (text.trim() === '') return { ok: false, reason: 'empty' };
  try {
    const saved = messages.save({
      botId: String(botId || ''),
      peer: String(peer || ''),
      scope: scope === 'group' ? 'group' : 'c2c',
      senderId: typeof msg.senderId === 'string' ? msg.senderId : '',
      senderName: typeof msg.senderName === 'string' ? msg.senderName : '',
      role: 'user',
      content: text,
      msgType: Number(msg.msgType) || 0,
      messageId: typeof msg.messageId === 'string' ? msg.messageId : '',
    });
    return { ok: true, created: saved.created === true };
  } catch (err) {
    // 落库失败绝不影响回复
    log.warn?.('消息流水写入失败（忽略）: ' + (err && err.message));
    return { ok: false, reason: 'error' };
  }
}

/**
 * 写一条助手侧消息（robot 自己说的话）。
 * @param {object} args
 * @param {object} [args.messages]
 * @param {string} args.botId
 * @param {string} args.peer
 * @param {string} args.content
 * @param {string} [args.messageId] 机器人消息 id（QQ 发送回执里的 id，可能为空）
 * @param {object} [args.logger]
 */
export function appendAssistantRecord({ messages, botId, peer, content, messageId = '', logger } = {}) {
  const log = logger || console;
  if (!messages || typeof messages.save !== 'function') return { ok: false, reason: 'no-store' };
  const text = clip(content);
  if (text.trim() === '') return { ok: false, reason: 'empty' };
  try {
    const saved = messages.save({
      botId: String(botId || ''),
      peer: String(peer || ''),
      scope: String(peer || '').startsWith('group:') ? 'group' : 'c2c',
      senderId: '',
      senderName: '',
      role: 'assistant',
      content: text,
      msgType: 0,
      messageId: String(messageId || ''),
    });
    return { ok: true, created: saved.created === true };
  } catch (err) {
    log.warn?.('助手消息流水写入失败（忽略）: ' + (err && err.message));
    return { ok: false, reason: 'error' };
  }
}

export default appendMessageRecord;
