/**
 * quote-reply —— 内置工具 qqbot_quote_reply：让「这一轮回复」引用触发它的那条用户消息。
 *
 * 背景：QQ 的引用回复（message_reference）如果默认开启，每条机器人消息都会套一个
 * 引用框，很打扰；关掉又没法在需要时引用。现在改成**由模型自己决定**：
 *   - 需要引用时才调用本工具（一条消息多个问题、接续某个话题、避免歧义等）；
 *   - 工具只在本轮 session record 上打 quoteNext 标记；
 *   - outbound 在 turn/end 发送首条消息时读取该标记，并在发送后清零；
 *   - 每条新入站消息进入时也会清零，避免上一轮的标记泄漏到下一轮。
 */
/** 工具名（qqbot_ 前缀避免与其它通道的同名工具冲突）。 */
export const QUOTE_REPLY_TOOL_NAME = 'qqbot_quote_reply';

const DESCRIPTION = 'Mark this turn\'s reply to quote (reply-with-reference) the user message that triggered it. '
  + 'Call it only when quoting genuinely helps: the user asked several questions and you answer one of them, '
  + 'you are continuing a specific thread, or it avoids ambiguity about which message you mean. '
  + 'Do NOT call it for ordinary chat replies. It takes effect on the first message this turn sends.';

/** 构造工具定义（体内测试可直接用）。 */
function makeDefinition({ manager, logger } = {}) {
  const log = logger || console;
  return {
    name: QUOTE_REPLY_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          quoted: { type: 'boolean' },
          target: { type: 'string' },
        },
        required: ['quoted'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.quoted
          ? '已标记：本轮回复会引用触发它的消息（' + (value.target || '当前会话') + '）'
          : '未标记引用',
      }],
    },
    async execute(_args, exec) {
      const runCtx = exec && typeof exec === 'object' ? exec : {};
      if (!manager || typeof manager.findByAgent !== 'function') {
        throw new Error('qqbot_quote_reply: 会话管理器不可用');
      }
      const record = runCtx.agent !== undefined ? manager.findByAgent(runCtx.agent) : undefined;
      if (!record) throw new Error('qqbot_quote_reply: 找不到当前 QQ 会话，无法标记引用');
      record.quoteNext = true;
      const replyTarget = record.replyTarget && typeof record.replyTarget === 'object' ? record.replyTarget : {};
      const target = replyTarget.scope && replyTarget.targetId
        ? replyTarget.scope + ':' + replyTarget.targetId
        : '';
      log.info('qqbot_quote_reply: 已标记本轮引用' + (target ? ' -> ' + target : ''));
      return { quoted: true, ...(target ? { target } : {}) };
    },
  };
}

/**
 * 创建 qqbot_quote_reply 工具定义（v2：由 lib/tools/index.js 的工厂注册到 agent scope）。
 * @param {object} deps
 * @param {object} deps.manager 会话适配器（findByAgent 定位当前会话）
 * @param {object} [deps.logger]
 * @returns {object[]} 工具定义数组（失败返回 []，不抛）
 */
export function createQuoteReplyTools({ manager, logger } = {}) {
  const log = logger || console;
  try {
    return [makeDefinition({ manager, logger: log })];
  } catch (err) {
    log.warn('qqbot_quote_reply 工具定义构造失败: ' + (err && err.message));
    return [];
  }
}

export default createQuoteReplyTools;
