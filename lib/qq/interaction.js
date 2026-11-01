/**
 * interaction —— 处理 INTERACTION_CREATE（按钮点击 / 消息反馈 / 清空会话 / 授权等）。
 *
 * 旧实现（gateway.js 内联）对所有互动事件无条件 acknowledgeInteraction(id, 3)：
 * code=3 的语义是「重复操作」，对按钮点击是错的；而 type 13/14/16/18 这类事件
 * 官方本来就不需要 PUT，白发一次请求只会报错。本模块按 event.type 分流：
 *
 *   11 / 12  消息按钮 / 快捷菜单：先 ack(0)（不 ack 客户端会一直转圈，必须在 3 秒内），
 *            再按 settings.interaction.feedToAgent 把按钮数据当作一条用户消息喂给 agent；
 *   13       消息反馈：记录 feedback_opt 到 stats，不 ack；
 *   14       清空会话：settings.interaction.resetOnClearSession 开启时 manager.reset，不 ack；
 *   15/16/18/19/20  仅记日志 / 统计，不 ack；
 *   未知类型  不 ack（旧行为无条件 ack 3 是错误的）。
 *
 * ack 失败、manager.reset 抛错、feedAgent 抛错都只记日志，绝不向上抛。
 */

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
    /* 设置读取失败不影响互动回调处理 */
  }
  return {};
}

/** 互动配置段（settings.interaction），缺省按默认值（feedToAgent=true / resetOnClearSession=true）。 */
function interactionConfig(settings) {
  const value = settings && settings.interaction && typeof settings.interaction === 'object'
    ? settings.interaction
    : {};
  return value;
}

/** scene 优先；缺失时用 chat_type（1=单聊 / 2=群聊）或 openid 字段推断。 */
function resolveScope(event) {
  const scene = field(event.scene);
  if (scene === 'c2c' || scene === 'group') return scene;
  const chatType = Number(event.chat_type);
  if (chatType === 1) return 'c2c';
  if (chatType === 2) return 'group';
  if (field(event.group_openid)) return 'group';
  if (field(event.user_openid) || field(event.group_member_openid)) return 'c2c';
  return '';
}

/** 会话 peer：群聊用 group_openid，单聊用 user_openid（兜底群成员 openid）。 */
function resolvePeerId(event, scope) {
  if (scope === 'group') return field(event.group_openid);
  if (scope === 'c2c') return field(event.user_openid) || field(event.group_member_openid);
  return '';
}

/** 取 data.resolved（按钮数据都在这里）。 */
function resolvedOf(event) {
  const data = event && event.data && typeof event.data === 'object' ? event.data : {};
  const resolved = data.resolved && typeof data.resolved === 'object' ? data.resolved : {};
  return { data, resolved };
}

/**
 * 创建互动回调处理器（注册到 bot.on('interaction')）。
 *
 * @param {object} args
 * @param {object} [args.manager] SessionManager（type=14 清空会话用）
 * @param {Function} [args.getSettings] 取设置快照
 * @param {object} [args.logger] 日志对象
 * @param {object} [args.stats] 统计对象（计数字段直接惰性累加）
 * @param {Function} [args.getBot] 取当前 bot（重连后自动跟随）
 * @param {Function} [args.feedAgent] 把按钮事件喂给 agent：({scope,peerId,text,buttonId,messageId})
 * @returns {Function} async (ctx, event) => void
 */
export function createInteractionHandler({ manager, getSettings, logger, stats, getBot, feedAgent } = {}) {
  const log = logger || console;

  function bump(key, delta = 1) {
    if (!stats || typeof stats !== 'object') return;
    stats[key] = (Number(stats[key]) || 0) + delta;
  }

  /** 当前 bot：getBot 优先（手动重连会换新实例），其次 ctx.bot。 */
  function resolveBot(ctx) {
    if (typeof getBot === 'function') {
      try {
        const bot = getBot();
        if (bot) return bot;
      } catch (err) {
        log.warn('获取 bot 失败: ' + errText(err));
      }
    }
    return ctx && ctx.bot ? ctx.bot : undefined;
  }

  /** 3 秒内 ack(0)（code=0 表示「成功收到」）；失败只记日志。 */
  async function ackInteraction(ctx, event) {
    const bot = resolveBot(ctx);
    if (!bot || typeof bot.acknowledgeInteraction !== 'function') {
      bump('interactionAckSkipped');
      log.debug('互动回调缺少 bot/acknowledgeInteraction，跳过 ack');
      return false;
    }
    const id = field(event.id);
    if (!id) {
      bump('interactionAckSkipped');
      log.debug('互动回调缺少 id，跳过 ack');
      return false;
    }
    try {
      await bot.acknowledgeInteraction(id, 0);
      bump('interactionAcked');
      return true;
    } catch (err) {
      bump('interactionAckFailed');
      log.warn('互动回调 ack 失败（忽略）: ' + errText(err));
      return false;
    }
  }

  /** type 11/12：先 ack，再把按钮数据喂给 agent。 */
  async function handleButton(ctx, event) {
    await ackInteraction(ctx, event);
    const cfg = interactionConfig(readSettings(getSettings));
    if (cfg.feedToAgent === false) {
      bump('interactionFeedSkipped');
      log.debug('互动回调投喂已关闭（settings.interaction.feedToAgent=false）');
      return;
    }
    if (typeof feedAgent !== 'function') {
      bump('interactionFeedSkipped');
      log.debug('未注入 feedAgent，跳过按钮投喂');
      return;
    }
    const scope = resolveScope(event);
    const peerId = resolvePeerId(event, scope);
    if (!scope || !peerId) {
      bump('interactionFeedSkipped');
      log.debug('互动回调缺少会话标识，跳过投喂');
      return;
    }
    const { resolved } = resolvedOf(event);
    const text = field(resolved.button_data) || field(resolved.button_id);
    const payload = {
      scope: scope,
      peerId: peerId,
      text: text,
      buttonId: field(resolved.button_id),
      messageId: field(resolved.message_id),
    };
    try {
      await feedAgent(payload);
      bump('interactionFed');
      log.info('互动回调已投喂 agent: scope=' + scope + ' peer=' + peerId + ' text=' + text);
    } catch (err) {
      bump('interactionFeedFailed');
      log.warn('互动回调投喂 agent 失败（忽略）: ' + errText(err));
    }
  }

  /** type 13：消息反馈（LIKE/UNLIKE），只记统计，不 ack。 */
  function handleFeedback(event) {
    const { data, resolved } = resolvedOf(event);
    const opt = field(data.feedback_opt) || field(resolved.feedback_opt) || 'unknown';
    bump('interactionFeedback');
    if (stats && typeof stats === 'object') {
      stats.lastFeedbackOpt = opt;
      stats.lastFeedbackAt = Date.now();
    }
    log.debug('消息反馈: opt=' + opt);
  }

  /** type 14：清空会话（等价 /new）。不 ack。 */
  async function handleClearSession(event) {
    const cfg = interactionConfig(readSettings(getSettings));
    if (cfg.resetOnClearSession === false) {
      bump('interactionResetSkipped');
      log.debug('互动回调清空会话已被设置关闭');
      return;
    }
    if (!manager || typeof manager.reset !== 'function') {
      bump('interactionResetSkipped');
      log.debug('缺少 manager.reset，跳过清空会话');
      return;
    }
    const scope = resolveScope(event);
    const peerId = resolvePeerId(event, scope);
    if (!scope || !peerId) {
      bump('interactionResetSkipped');
      log.debug('互动回调缺少会话标识，跳过清空会话');
      return;
    }
    try {
      await manager.reset(scope, peerId);
      bump('interactionReset');
      log.info('互动回调已清空会话: scope=' + scope + ' peer=' + peerId);
    } catch (err) {
      bump('interactionResetFailed');
      log.warn('互动回调清空会话失败（忽略）: ' + errText(err));
    }
  }

  return async function handleInteraction(ctx, event) {
    const ev = event && typeof event === 'object' && Object.keys(event).length > 0
      ? event
      : (ctx && ctx.event && typeof ctx.event === 'object' ? ctx.event : {});
    const type = Number(ev.type);
    bump('interactions');
    try {
      if (type === 11 || type === 12) {
        await handleButton(ctx, ev);
        return;
      }
      if (type === 13) {
        handleFeedback(ev);
        return;
      }
      if (type === 14) {
        await handleClearSession(ev);
        return;
      }
      if (type === 15 || type === 16 || type === 18 || type === 19 || type === 20) {
        bump('interactionIgnored');
        log.debug('互动回调无需响应（不 ack）: type=' + type);
        return;
      }
      // 未知类型：不 ack（旧行为无条件 ack 3 是错的）
      bump('interactionUnknown');
      log.debug('未知互动回调类型（不 ack）: type=' + (Number.isFinite(type) ? type : String(ev.type)));
    } catch (err) {
      // 最外层兜底：互动回调异常不能影响网关
      log.warn('互动回调处理异常（忽略）: ' + errText(err));
    }
  };
}

export default createInteractionHandler;
