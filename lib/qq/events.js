/**
 * events —— 处理 QQ 网关的 rawEvent（消息之外的生命周期事件）。
 *
 * SDK（qqbot-nodejs@1.0.5）把除消息/互动外的派发统一走 `on('rawEvent')`，
 * ctx 形如 { bot, eventType, data, state, receivedAt }。本模块负责：
 *
 *   1. FRIEND_ADD / GROUP_ADD_ROBOT：按设置发欢迎语（加好友欢迎 / 入群欢迎）；
 *   2. C2C_MSG_RECEIVE / GROUP_MSG_RECEIVE：记录「用户/群已允许主动消息」；
 *      C2C_MSG_REJECT / GROUP_MSG_REJECT：记录不允许（主动兜底应据此放弃）；
 *   3. 幂等：同一事件的重连补发按 eventType + openid/group_openid + timestamp
 *      去重（LRU，TTL 10 分钟），避免重复欢迎 / 重复统计。
 *
 * 关于 event_id（被动回复事件）：官方文档允许用事件外层 id 作 event_id 回复
 * FRIEND_ADD / GROUP_ADD_ROBOT 等事件，但 qqbot-nodejs@1.0.5 的 rawEvent 只透传
 * 事件体 `data`（如 { timestamp, openid }），不透传 WS 包外层 id，data 里也没有 id，
 * 因此这里无法走 event_id 被动回复，只能用 sendProactive（主动消息）。
 *
 * 任何失败都只记日志：SDK 是 `void this.emit('rawEvent', ctx)`，这里抛出会变成
 * unhandled rejection，把整个网关拖挂。
 */

/** 去重 TTL 与容量上限（LRU 淘汰）。 */
const DEDUP_TTL_MS = 10 * 60 * 1000;
const DEDUP_MAX = 2000;

const EVENT = {
  FRIEND_ADD: 'FRIEND_ADD',
  GROUP_ADD_ROBOT: 'GROUP_ADD_ROBOT',
  C2C_MSG_RECEIVE: 'C2C_MSG_RECEIVE',
  C2C_MSG_REJECT: 'C2C_MSG_REJECT',
  GROUP_MSG_RECEIVE: 'GROUP_MSG_RECEIVE',
  GROUP_MSG_REJECT: 'GROUP_MSG_REJECT',
};

/** 内置欢迎语：温和、不自称真人；设置为空文本时用。 */
const DEFAULT_WELCOME = {
  friend: '你好呀～我是这个账号接入的 AI 助手，可以随时找我聊天、问问题。',
  group: '大家好，我是接入本群的 AI 助手，有需要的时候 @我 就行，我会尽量帮忙～',
};

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/** 取字段文本（数字转字符串），空值返回空串。 */
function field(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** 读设置快照；getSettings 可以是函数，也可以是 settings-store（带 get）。失败按空对象。 */
function readSettings(getSettings) {
  try {
    if (typeof getSettings === 'function') {
      const snapshot = getSettings();
      return snapshot && typeof snapshot === 'object' ? snapshot : {};
    }
    if (getSettings && typeof getSettings.get === 'function') {
      const snapshot = getSettings.get();
      return snapshot && typeof snapshot === 'object' ? snapshot : {};
    }
  } catch {
    /* 设置读取失败不影响事件处理 */
  }
  return {};
}

/**
 * 创建 rawEvent 处理器（注册到 bot.on('rawEvent')）。
 *
 * @param {object} args
 * @param {Function} [args.getSender] 取统一发送器（需要 sendProactive）
 * @param {Function} [args.getSettings] 取设置快照
 * @param {object} [args.logger] 日志对象
 * @param {object} [args.stats] 统计对象（计数字段直接惰性累加）
 * @returns {Function} async (ctx) => void；函数上挂 .state 便于测试/主动消息决策
 */
export function createRawEventHandler({ getSender, getSettings, logger, stats } = {}) {
  const log = logger || console;

  /**
   * 主动消息许可状态：
   *   activeAllowed:       C2C openid -> boolean（C2C_MSG_RECEIVE / C2C_MSG_REJECT）
   *   groupActiveAllowed:  group_openid -> boolean（GROUP_MSG_RECEIVE / GROUP_MSG_REJECT）
   */
  const state = {
    activeAllowed: new Map(),
    groupActiveAllowed: new Map(),
  };

  /** 已处理事件：key -> 过期时间戳（Map 插入顺序即 LRU 顺序）。 */
  const seen = new Map();

  function bump(key, delta = 1) {
    if (!stats || typeof stats !== 'object') return;
    stats[key] = (Number(stats[key]) || 0) + delta;
  }

  function resolveSender() {
    if (typeof getSender !== 'function') return undefined;
    try {
      const sender = getSender();
      return sender && typeof sender === 'object' ? sender : undefined;
    } catch (err) {
      log.warn('获取 sender 失败: ' + errText(err));
      return undefined;
    }
  }

  /** 清理过期去重记录；Map 按插入顺序，遇到未过期即可停。 */
  function pruneSeen(now) {
    for (const [key, expireAt] of seen) {
      if (expireAt > now) break;
      seen.delete(key);
    }
  }

  /** 返回 true 表示新事件；false 表示重复推送（幂等丢弃）。 */
  function markSeen(eventType, peerId, timestamp) {
    const now = Date.now();
    pruneSeen(now);
    const stamp = field(timestamp) || String(now);
    const key = eventType + ':' + peerId + ':' + stamp;
    const expireAt = seen.get(key);
    if (expireAt !== undefined && expireAt > now) return false;
    seen.delete(key); // 重新插入到 LRU 末尾
    seen.set(key, now + DEDUP_TTL_MS);
    if (seen.size > DEDUP_MAX) {
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    return true;
  }

  /** 欢迎语开关与文案；文案为空时用内置默认。 */
  function welcomeConfig(kind, settings) {
    const welcome = settings && settings.welcome && typeof settings.welcome === 'object' ? settings.welcome : {};
    const enabled = kind === 'friend' ? welcome.friendEnabled === true : welcome.groupEnabled === true;
    const custom = kind === 'friend' ? field(welcome.friendText) : field(welcome.groupText);
    return { enabled, text: custom || DEFAULT_WELCOME[kind] };
  }

  async function sendWelcome(scope, targetId, text) {
    const sender = resolveSender();
    if (!sender || typeof sender.sendProactive !== 'function') {
      bump('welcomeSkipped');
      log.debug('统一 sender 不可用（缺少 sendProactive），跳过欢迎语');
      return;
    }
    try {
      await sender.sendProactive({ scope, targetId }, text);
      bump('welcomeSent');
      log.info('已发送欢迎语: scope=' + scope + ' target=' + targetId);
    } catch (err) {
      // 欢迎语失败不应影响任何主流程
      bump('welcomeFailed');
      log.warn('欢迎语发送失败（忽略）: ' + errText(err));
    }
  }

  /** 幂等守门：重复推送只记统计并返回 false。 */
  function acceptEvent(eventType, peerId, timestamp) {
    if (markSeen(eventType, peerId, timestamp)) return true;
    bump('rawEventDuplicates');
    log.debug('重复的 rawEvent 已忽略: ' + eventType + ' peer=' + peerId);
    return false;
  }

  const handleRawEvent = async function handleRawEvent(ctx) {
    const ev = ctx && typeof ctx === 'object' ? ctx : {};
    const eventType = field(ev.eventType);
    if (!eventType) return;
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
    bump('rawEvents');
    try {
      if (eventType === EVENT.FRIEND_ADD) {
        const openid = field(data.openid) || field(data.user_openid);
        if (!openid) return;
        if (!acceptEvent(eventType, openid, data.timestamp ?? ev.receivedAt)) return;
        const welcome = welcomeConfig('friend', readSettings(getSettings));
        if (!welcome.enabled) {
          bump('welcomeDisabled');
          return;
        }
        // 事件外层 id 不透传，只能主动消息（见文件头说明）
        await sendWelcome('c2c', openid, welcome.text);
        return;
      }

      if (eventType === EVENT.GROUP_ADD_ROBOT) {
        const groupId = field(data.group_openid);
        if (!groupId) return;
        if (!acceptEvent(eventType, groupId, data.timestamp ?? ev.receivedAt)) return;
        const welcome = welcomeConfig('group', readSettings(getSettings));
        if (!welcome.enabled) {
          bump('welcomeDisabled');
          return;
        }
        await sendWelcome('group', groupId, welcome.text);
        return;
      }

      if (eventType === EVENT.C2C_MSG_RECEIVE || eventType === EVENT.C2C_MSG_REJECT) {
        const openid = field(data.openid) || field(data.user_openid);
        if (!openid) return;
        if (!acceptEvent(eventType, openid, data.timestamp ?? ev.receivedAt)) return;
        const allowed = eventType === EVENT.C2C_MSG_RECEIVE;
        state.activeAllowed.set(openid, allowed);
        bump(allowed ? 'activeAllowed' : 'activeRejected');
        log.debug((allowed ? '用户允许' : '用户拒绝') + '主动消息: openid=' + openid);
        return;
      }

      if (eventType === EVENT.GROUP_MSG_RECEIVE || eventType === EVENT.GROUP_MSG_REJECT) {
        const groupId = field(data.group_openid);
        if (!groupId) return;
        if (!acceptEvent(eventType, groupId, data.timestamp ?? ev.receivedAt)) return;
        const allowed = eventType === EVENT.GROUP_MSG_RECEIVE;
        state.groupActiveAllowed.set(groupId, allowed);
        bump(allowed ? 'groupActiveAllowed' : 'groupActiveRejected');
        log.debug((allowed ? '群允许' : '群拒绝') + '主动消息: group=' + groupId);
        return;
      }

      log.debug('未处理的 rawEvent: ' + eventType);
    } catch (err) {
      // 兜底：绝不能把异常抛给 SDK 的 emit，否则会变成 unhandled rejection
      log.warn('rawEvent 处理异常（忽略）: ' + errText(err));
    }
  };

  handleRawEvent.state = state;
  return handleRawEvent;
}

export default createRawEventHandler;
