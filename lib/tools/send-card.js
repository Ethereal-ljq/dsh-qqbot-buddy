/**
 * send-card —— 内置工具 qqbot_send_card：给当前 QQ 会话发一张图文卡片（msg_type=8 / tuwen）。
 *
 * QQ 限制（官方文档）：
 *   - title 1–50 字、description 1–200 字；
 *   - url / pic_url 必须是 https，长度 ≤ 1024；
 *   - 卡片仅支持 tuwen（图文）类型。
 *
 * 卡片是"锦上添花"：发送失败（内容审核/客户端不支持/权限）时 sender 会自动降级成
 * 纯文本（标题 + 摘要 + 链接），保证信息必达。
 *
 * 发送目标默认自动定位（exec.agent -> SessionManager.findByAgent -> replyTarget），
 * 显式 target 参数（c2c:openid / group:openid）作为覆盖。
 */
/** 工具名（qqbot_ 前缀避免与其它通道的同名工具冲突）。 */
export const SEND_CARD_TOOL_NAME = 'qqbot_send_card';

const DESCRIPTION = 'Send a QQ rich card (图文卡片 / msg_type=8) to the current conversation. '
  + 'A card shows a title, a short description, a clickable https link and an optional https cover image. '
  + 'Use it only when a link/recommendation/news item really benefits from a card (e.g. sharing an article, '
  + 'a knowledge entry with a URL, a product/event recommendation). Do NOT use it for ordinary chat replies, '
  + 'and do not send cards on every message.';

const MAX_TITLE = 50;
const MAX_DESCRIPTION = 200;
const MAX_URL = 1024;

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/** 安全获取可选服务。 */
function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** 解析显式 target（c2c:openid / group:openid），非法返回 undefined。 */
function parseTarget(input) {
  if (typeof input !== 'string') return undefined;
  const idx = input.indexOf(':');
  if (idx <= 0) return undefined;
  const scope = input.slice(0, idx);
  const targetId = input.slice(idx + 1);
  if (!targetId || (scope !== 'c2c' && scope !== 'group')) return undefined;
  return { scope, targetId };
}

/** 按字符（码点）计长度，避免 emoji 被算成两个。 */
function charLength(text) {
  return Array.from(text).length;
}

/** https + 长度校验。 */
function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  if (charLength(value) > MAX_URL) return false;
  return /^https:\/\//i.test(value.trim());
}

/** 校验并归一化卡片字段；非法时抛出可读错误。 */
export function normalizeCardArgs(args) {
  const input = args && typeof args === 'object' ? args : {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const title = text(input.title);
  const description = text(input.description);
  const url = text(input.url);
  const picUrl = text(input.pic_url) || text(input.picUrl);

  if (charLength(title) < 1 || charLength(title) > MAX_TITLE) {
    throw new Error('qqbot_send_card: title 需要 1–' + MAX_TITLE + ' 个字符');
  }
  if (charLength(description) < 1 || charLength(description) > MAX_DESCRIPTION) {
    throw new Error('qqbot_send_card: description 需要 1–' + MAX_DESCRIPTION + ' 个字符');
  }
  if (!isHttpsUrl(url)) {
    throw new Error('qqbot_send_card: url 必须是 https 链接且不超过 ' + MAX_URL + ' 字符');
  }
  if (picUrl !== '' && !isHttpsUrl(picUrl)) {
    throw new Error('qqbot_send_card: pic_url 必须是 https 链接且不超过 ' + MAX_URL + ' 字符');
  }

  const card = { title, description, url };
  if (picUrl) card.pic_url = picUrl;
  return card;
}

/** 构造工具定义（供体内测试）。 */
function makeDefinition({ sender, manager, logger } = {}) {
  const log = logger || console;

  return {
    name: SEND_CARD_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Card title, 1–50 characters.',
        },
        description: {
          type: 'string',
          description: 'Card summary, 1–200 characters. Keep it short and concrete.',
        },
        url: {
          type: 'string',
          description: 'Click-through URL. Must start with https:// and be ≤1024 characters.',
        },
        pic_url: {
          type: 'string',
          description: 'Optional cover image URL. Must start with https:// and be ≤1024 characters.',
        },
        target: {
          type: 'string',
          description: 'Optional send target as "c2c:openid" or "group:openid". Omit to send to the current conversation.',
        },
      },
      required: ['title', 'description', 'url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          target: { type: 'string' },
          mode: { type: 'string' },
          degraded: { type: 'boolean' },
          degradedReason: { type: 'string' },
          messageId: { type: 'string' },
        },
        required: ['title', 'target', 'mode', 'degraded'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已发送图文卡片：' + value.title + ' -> ' + value.target
          + (value.degraded
            ? '（卡片不可用，已降级为纯文本' + (value.degradedReason ? '，原因 ' + value.degradedReason : '') + '）'
            : ''),
      }],
    },
    async execute(args, exec) {
      const runCtx = exec && typeof exec === 'object' ? exec : {};
      if (!sender || typeof sender.sendCard !== 'function') {
        throw new Error('qqbot_send_card: 发送通道不可用（sender.sendCard 缺失）');
      }
      const card = normalizeCardArgs(args);
      const explicitTarget = args && args.target !== undefined && args.target !== '' ? args.target : undefined;

      // 1. 解析发送目标：显式 target > 当前会话（exec.agent -> session record）
      let replyTarget;
      if (explicitTarget !== undefined) {
        replyTarget = parseTarget(explicitTarget);
        if (!replyTarget) {
          throw new Error('qqbot_send_card: target 需要 c2c:openid 或 group:openid，收到: ' + explicitTarget);
        }
      } else if (runCtx.agent !== undefined) {
        const record = manager && typeof manager.findByAgent === 'function' ? manager.findByAgent(runCtx.agent) : undefined;
        replyTarget = record ? record.replyTarget : undefined;
      }
      if (!replyTarget) throw new Error('qqbot_send_card: 无法确定发送目标，请显式传 target 参数');

      const fallbackText = [card.title, card.description, card.url].join('\n');
      const result = await sender.sendCard(replyTarget, card, { fallbackText });
      if (!result || result.ok !== true) {
        throw new Error('qqbot_send_card: 发送失败（' + (result && result.code ? result.code : 'unknown') + '）'
          + (result && result.error ? ': ' + result.error : ''));
      }

      const target = replyTarget.scope + ':' + replyTarget.targetId;
      log.info('qqbot_send_card 发送卡片「' + card.title + '」 -> ' + target
        + '（' + (result.mode || 'unknown') + (result.degraded ? ', 已降级纯文本' : '') + '）');
      const value = {
        title: card.title,
        target,
        mode: result.mode || 'unknown',
        degraded: result.degraded === true,
      };
      if (typeof result.degradedReason === 'string' && result.degradedReason !== '') {
        value.degradedReason = result.degradedReason;
      }
      const messageId = result.result && typeof result.result === 'object' ? result.result.id : undefined;
      if (messageId !== undefined && messageId !== null && messageId !== '') value.messageId = String(messageId);
      return value;
    },
  };
}

/**
 * 注册 qqbot_send_card 工具（tools 服务缺失时优雅降级，不阻断插件启动）。
 * @param {object} args
 * @param {object} args.ctx 插件上下文
 * @param {object} args.sender 统一 sender（需 sendCard）
 * @param {object} args.manager SessionManager
 * @param {object} [args.logger] 日志对象
 * @returns {Function|undefined} tools.register 返回的注销函数
 */
export function registerSendCardTool({ ctx, sender, manager, logger } = {}) {
  const log = logger || console;
  const tools = getService(ctx, 'tools');
  if (!tools || typeof tools.register !== 'function') {
    log.warn('tools 服务不可用，qqbot_send_card 工具未注册');
    return undefined;
  }
  let definition;
  try {
    definition = makeDefinition({ sender, manager, logger: log });
  } catch (err) {
    log.warn('qqbot_send_card 工具定义构造失败: ' + errText(err));
    return undefined;
  }
  try {
    const dispose = tools.register(definition);
    log.info('qqbot_send_card 工具已注册');
    return dispose;
  } catch (err) {
    log.warn('注册 qqbot_send_card 失败: ' + errText(err));
    return undefined;
  }
}

export default registerSendCardTool;
