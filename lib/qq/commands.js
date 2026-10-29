/**
 * commands —— QQ 聊天里的管理命令（命令目录 + 管理员门控）。
 *
 * 命令在频率门控之前处理，命中后直接回复并 ctx.stop()：
 *   /help /ping /status /id   公开命令
 *   /new /reset /clear /resume /stop   管理员命令（settings.admin 启用且名单非空时强制）
 * 未知的 /xxx 不拦截，按普通消息继续走频率策略（DESIGN 约定）。
 *
 * 管理员门控规则（DESIGN 第四批需求）：
 *   - settings.admin = { enabled, openids, names }
 *   - 仅当 enabled === true 且 openids/names 至少一个非空时才强制；
 *   - 未启用或名单为空 -> 保持旧行为（所有人都能用管理员命令）；
 *   - 管理员命令：new / reset / clear / resume / stop；被拒时回复清晰提示（含自己的 openid
 *     与「请管理员在设置页把你加入名单」的指引）。
 */
/**
 * 命令目录（设置页展示 / 帮助文本 / 管理员门控共用）。
 * 顺序即 /help 中的展示顺序；usage 带斜杠，name 为小写命令名（不含斜杠）。
 * @type {ReadonlyArray<{name:string, usage:string, description:string, adminOnly:boolean}>}
 */
export const COMMAND_CATALOG = Object.freeze([
  Object.freeze({ name: 'help', usage: '/help', description: '显示可用命令与说明', adminOnly: false }),
  Object.freeze({ name: 'ping', usage: '/ping', description: '连通性测试', adminOnly: false }),
  Object.freeze({ name: 'status', usage: '/status', description: '查看回复频率、人设/会话与统计', adminOnly: false }),
  Object.freeze({ name: 'id', usage: '/id', description: '查看自己的昵称、openid 与管理员身份', adminOnly: false }),
  Object.freeze({ name: 'new', usage: '/new', description: '开启新会话（旧会话进入可恢复列表）', adminOnly: true }),
  Object.freeze({ name: 'reset', usage: '/reset', description: '同 /new（兼容旧叫法）', adminOnly: true }),
  Object.freeze({ name: 'clear', usage: '/clear', description: '同 /new（兼容旧叫法）', adminOnly: true }),
  Object.freeze({ name: 'resume', usage: '/resume', description: '恢复上一个被 /new 替换掉的会话（带回上下文）', adminOnly: true }),
  Object.freeze({ name: 'stop', usage: '/stop', description: '停止当前正在生成的回复', adminOnly: true }),
]);

/** 已实现的命令名（小写）。 */
const KNOWN_COMMANDS = new Set(COMMAND_CATALOG.map((item) => item.name));
/** name -> catalog item（含 adminOnly / usage / description）。 */
const CATALOG_BY_NAME = new Map(COMMAND_CATALOG.map((item) => [item.name, item]));

/** 错误转字符串。 */
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/** 安全读取 settings 快照（读不到按空对象 = 管理员未启用）。 */
function readSettingsSnapshot(settings) {
  try {
    return settings && typeof settings.get === 'function' ? settings.get() : {};
  } catch {
    return {};
  }
}

/**
 * 从入站消息推导 scope/peerId/peerKey（与 middleware.peerInfo 语义一致）。
 * 本模块刻意保持零依赖，便于直接 import 做单测；因此这里内联同一实现。
 */
function peerInfo(message) {
  const msg = message || {};
  const scope = msg.kind === 'group' ? 'group' : 'c2c';
  const peerId = scope === 'group' ? (msg.groupOpenid || msg.senderId) : msg.senderId;
  return { scope, peerId, peerKey: scope + ':' + (peerId || '') };
}

/** 从 ctx.message 取发送者信息（senderId/senderName）。 */
function senderFromCtx(ctx) {
  const msg = ctx && ctx.message ? ctx.message : {};
  return {
    senderId: typeof msg.senderId === 'string' ? msg.senderId : '',
    senderName: typeof msg.senderName === 'string' ? msg.senderName : '',
  };
}

/** 归一化管理员配置：兼容完整 settings 快照（含 .admin）或直接传 settings.admin。 */
function normalizeAdminConfig(cfg) {
  const root = cfg && typeof cfg === 'object' ? cfg : {};
  let source = {};
  if (root.admin && typeof root.admin === 'object') {
    source = root.admin;
  } else if (root.enabled !== undefined || root.openids !== undefined || root.names !== undefined) {
    source = root;
  }
  const list = (input, maxLen) => {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const item of input) {
      if (typeof item !== 'string') continue;
      const value = item.trim();
      if (value === '' || value.length > maxLen) continue;
      if (!out.includes(value)) out.push(value);
      if (out.length >= 100) break;
    }
    return out;
  };
  return {
    enabled: source.enabled === true,
    openids: list(source.openids, 100),
    names: list(source.names, 40),
  };
}

/**
 * 计算某个发送者的管理员状态。
 *
 * 语义：
 *   - enabled：settings.admin.enabled === true
 *   - configured：openids/names 至少一个非空
 *   - enforced：enabled 且 configured（此时才强制门控）
 *   - isAdmin / matchedBy：按 openid（优先）或昵称命中的结果；与 enabled 无关，供 /id 展示
 *   - allowed：是否可以执行管理员命令（!enforced || isAdmin）
 *
 * @param {object} cfgsettings 快照（含 admin）或 settings.admin 本身
 * @param {string} [senderId] 发送者 openid
 * @param {string} [senderName] 发送者昵称
 * @returns {{enabled:boolean, configured:boolean, enforced:boolean, isAdmin:boolean,
 *            matchedBy:'openid'|'name'|'', allowed:boolean, openidCount:number, nameCount:number}}
 */
export function adminStatus(cfg, senderId, senderName) {
  const admin = normalizeAdminConfig(cfg);
  const id = typeof senderId === 'string' ? senderId.trim() : '';
  const name = typeof senderName === 'string' ? senderName.trim() : '';
  // v0.11：只按 openid 判定管理员。
  // 昵称匹配不安全（任何人改群昵称即可冒充管理员），且同一人在不同群昵称不同会失效。
  // settings.admin.names 仍保留在配置里以兼容旧数据，但不再参与判定。
  let matchedBy = '';
  if (id !== '' && admin.openids.includes(id)) matchedBy = 'openid';
  const configured = admin.openids.length > 0;
  const enforced = admin.enabled && configured;
  const isAdmin = matchedBy !== '';
  return {
    enabled: admin.enabled,
    configured: configured,
    enforced: enforced,
    isAdmin: isAdmin,
    matchedBy: matchedBy,
    allowed: !enforced || isAdmin,
    openidCount: admin.openids.length,
    nameCount: admin.names.length,
  };
}

/** 模式的中文说明。 */
function describeMode(cfg) {
  const reply = (cfg && cfg.reply) || {};
  const mode = reply.groupMode || 'count';
  if (mode === 'all') return '每条都回';
  if (mode === 'interval') return '间隔 ' + (reply.intervalSeconds || 0) + ' 秒回一次';
  if (mode === 'probability') return '每条以 ' + Math.round((Number(reply.probability) || 0) * 100) + '% 概率回复';
  if (mode === 'adaptive') {
    const a = reply.adaptive || {};
    return '自适应（静默 ' + (a.debounceSeconds || 0) + ' 秒 / 冷却 ' + (a.cooldownSeconds || 0)
      + ' 秒 / 最长等待 ' + (a.maxWaitSeconds || 0) + ' 秒 / 只回问句与媒体 '
      + (a.requireRelevance !== false ? '开' : '关') + '）';
  }
  return '每累计 ' + (reply.countThreshold || 0) + ' 条回一次（等待超 ' + (reply.flushAfterSeconds || 0) + ' 秒也回）';
}

/** /status 文本。 */
function buildStatusText({ scope, peerId, settings, manager, stats, adaptive }) {
  const cfg = settings.get();
  const reply = cfg.reply || {};
  const triggers = cfg.triggers || {};
  const record = typeof manager.getSessionRecord === 'function' ? manager.getSessionRecord(scope, peerId) : undefined;
  const lines = [];
  lines.push('**QQ 机器人状态**');
  if (reply.enabled === false) {
    lines.push('- 自动回复：已关闭（命令仍然可用）');
  } else {
    lines.push('- 自动回复：开启');
    if (scope === 'group') {
      lines.push('- 群聊模式：' + describeMode(cfg) + (reply.groupEnabled === false ? '（群聊回复已关闭）' : ''));
      lines.push('- 强制触发：@ ' + (triggers.onMention !== false ? '开' : '关')
        + ' / 回复机器人 ' + (triggers.onReplyToBot !== false ? '开' : '关')
        + ' / 关键词 ' + ((Array.isArray(triggers.keywords) ? triggers.keywords.length : 0)) + ' 个');
      lines.push('- 最小间隔：' + (reply.minGapSeconds || 0) + ' 秒');
      if (reply.groupMode === 'adaptive') {
        const a = reply.adaptive || {};
        lines.push('- 自适应参数：静默 ' + (a.debounceSeconds || 0) + ' 秒 / 冷却 '
          + (a.cooldownSeconds || 0) + ' 秒 / 最长等待 ' + (a.maxWaitSeconds || 0) + ' 秒 / 只回问句与媒体 '
          + (a.requireRelevance !== false ? '开' : '关'));
        let batches = 0;
        let buffered = 0;
        try {
          const snapshot = adaptive && typeof adaptive.pendingSnapshot === 'function' ? adaptive.pendingSnapshot() : [];
          if (Array.isArray(snapshot)) {
            batches = snapshot.length;
            buffered = snapshot.reduce((sum, item) => sum + (Number(item && item.count) || 0), 0);
          }
        } catch {
          /* 快照失败不影响 /status */
        }
        lines.push('- 自适应缓冲：' + batches + ' 批（' + buffered + ' 条待攒）');
      }
    } else {
      lines.push('- 私聊回复：' + (reply.c2cEnabled !== false ? '开启' : '关闭'));
    }
  }
  if (record) {
    lines.push('- 会话：活跃（' + record.sessionId + '）');
  } else {
    lines.push('- 会话：未创建（发一条消息就会创建）');
  }
  if (typeof manager.previousCount === 'function') {
    const resumable = manager.previousCount(scope, peerId);
    lines.push('- 可恢复会话：' + resumable + ' 个' + (resumable > 0 ? '（/resume 恢复上一个）' : ''));
  }
  lines.push('- 统计：接收 ' + (stats.received || 0)
    + ' / 触发 ' + (stats.triggered || 0)
    + ' / 跳过 ' + (stats.skipped || 0)
    + ' / 已回复 ' + (stats.replies || 0));
  return lines.join('\n');
}

/** 管理员状态的短描述（/id 用）。 */
function describeAdmin(adminInfo) {
  if (!adminInfo.enabled) return '门控未启用（管理员命令当前所有人可用）';
  if (!adminInfo.configured) return '门控已开启但名单为空（管理员命令当前所有人可用）';
  if (adminInfo.isAdmin) {
    return '是（命中' + (adminInfo.matchedBy === 'openid' ? 'openid' : '昵称') + '名单）';
  }
  return '否';
}

/** /id 文本：公开自己的昵称/openid/管理员身份。 */
function buildIdText({ senderId, senderName, adminInfo }) {
  const lines = ['**你的身份**'];
  lines.push('- 昵称：' + (senderName || '（未提供）'));
  lines.push('- openid：' + (senderId || '（未提供）'));
  lines.push('- 管理员：' + describeAdmin(adminInfo));
  if (adminInfo.enforced && !adminInfo.isAdmin) {
    lines.push('如需管理员权限：请让管理员在「设置 → QQ 机器人 → 命令与权限 → 管理员」把上面的 openid 加入名单（或把你的昵称加入昵称名单）。');
  }
  if (adminInfo.enforced && adminInfo.isAdmin) {
    const adminCommands = COMMAND_CATALOG.filter((item) => item.adminOnly).map((item) => item.usage).join(' ');
    lines.push('你当前可执行管理员命令：' + adminCommands);
  }
  return lines.join('\n');
}

/** /help 文本：由 COMMAND_CATALOG 生成，标注管理员命令并说明门控状态。 */
function buildHelpText({ cfg, senderId, senderName }) {
  const adminInfo = adminStatus(cfg, senderId, senderName);
  const lines = ['**可用命令**'];
  for (const item of COMMAND_CATALOG) {
    lines.push('- ' + item.usage + '：' + item.description + (item.adminOnly ? '（管理员）' : ''));
  }
  lines.push('');
  if (adminInfo.enforced) {
    lines.push('管理员门控已启用：带（管理员）的命令仅管理员可用'
      + (adminInfo.isAdmin ? '（你当前是管理员）。' : '；发送 /id 查看自己的 openid。'));
  } else if (adminInfo.enabled) {
    lines.push('管理员门控已开启但名单为空：管理员命令当前所有人可用（请在设置页「管理员」添加 openid/昵称）。');
  } else {
    lines.push('管理员门控未启用：管理员命令当前所有人可用（可在设置页「QQ 机器人 → 管理员」配置）。');
  }
  return lines.join('\n');
}

/**
 * 执行一条命令，返回要回复的 markdown 文本。
 * 抛错由调用方兜底成「命令执行失败」提示。
 */
export async function handleCommand({ name, ctx, scope, peerId, settings, manager, stats, adaptive, senderId, senderName }) {
  const fromCtx = senderFromCtx(ctx);
  const effectiveSenderId = typeof senderId === 'string' ? senderId : fromCtx.senderId;
  const effectiveSenderName = typeof senderName === 'string' ? senderName : fromCtx.senderName;

  switch (name) {
    case 'new':
    case 'reset':
    case 'clear': {
      const result = await manager.reset(scope, peerId);
      const resumable = result && typeof result.resumable === 'number' ? result.resumable : 0;
      return '🆕 已开启新会话，之前的上下文不再带入。'
        + (resumable > 0 ? '想回到上一个会话可发送 /resume。' : '');
    }
    case 'resume': {
      if (typeof manager.resumePrevious !== 'function') return '当前版本不支持 /resume。';
      const result = await manager.resumePrevious(scope, peerId);
      if (!result || result.ok !== true) {
        return '没有可恢复的会话（当前就是最早的会话）。用 /new 开过新会话后，旧会话才会进入可恢复列表。';
      }
      const shortId = String(result.sessionId || '').slice(0, 8);
      return '⏪ 已恢复上一个会话（' + shortId + '…），下一条消息会继续之前的上下文。'
        + (result.remaining > 0 ? '还可继续恢复 ' + result.remaining + ' 个。' : '');
    }
    case 'stop': {
      const record = manager.getSessionRecord(scope, peerId);
      if (!record) return '当前没有进行中的对话。';
      try {
        record.agent.cancel({ kind: 'user' });
      } catch {
        /* 已经结束也视为成功 */
      }
      return '⏹️ 已停止当前生成。';
    }
    case 'status':
      return buildStatusText({ scope, peerId, settings, manager, stats, adaptive });
    case 'help':
      return buildHelpText({
        cfg: readSettingsSnapshot(settings),
        senderId: effectiveSenderId,
        senderName: effectiveSenderName,
      });
    case 'id':
      return buildIdText({
        senderId: effectiveSenderId,
        senderName: effectiveSenderName,
        adminInfo: adminStatus(readSettingsSnapshot(settings), effectiveSenderId, effectiveSenderName),
      });
    case 'ping': {
      const cost = Math.max(0, Date.now() - (ctx.receivedAt || Date.now()));
      return '🏓 pong（' + cost + 'ms）';
    }
    default:
      return '';
  }
}

/** 发送命令回复（bot 不可用/发送失败只 warn）。 */
async function sendCommandReply(ctx, text, getBot, logger) {
  if (!text) return;
  try {
    const bot = typeof getBot === 'function' ? getBot() : undefined;
    if (bot && typeof bot.sendMarkdown === 'function') {
      await bot.sendMarkdown(ctx.replyTarget, text);
    }
  } catch (err) {
    logger.warn('命令回复发送失败: ' + errText(err));
  }
}

/** 生成管理员拒绝提示（含自己的 openid 与配置指引）。 */
function buildAdminRejection({ senderId, senderName, catalogItem }) {
  return '⛔ 该命令仅管理员可用（' + catalogItem.usage + '）。\n'
    + '你的 openid：' + (senderId || '（未提供）')
    + (senderName ? '（昵称：' + senderName + '）' : '') + '。\n'
    + '请让管理员在「设置 → QQ 机器人 → 命令与权限 → 管理员」中把你的 openid 加入管理员名单'
    + '（发送 /id 可随时查看自己的 openid）；若名单已配置，请确认 settings.admin.enabled 已开启。';
}

/**
 * 创建命令中间件。命中已知命令 -> 回复并 stop；未知 /xxx 放行。
 * 管理员命令（catalog.adminOnly）在门控生效且当前用户非管理员时直接拒绝（不执行）。
 * @param {object} args
 * @param {object} args.settings settings-store
 * @param {object} args.manager SessionManager
 * @param {object} args.logger 日志对象
 * @param {object} args.stats 统计对象
 * @param {Function} args.getBot 返回当前 QQBot 实例（bot 可能被重启替换）
 * @param {object} [args.adaptive] AdaptiveScheduler（/status 展示缓冲批次数）
 */
/**
 * 去掉消息开头的 @ 提及标记。
 *
 * 为什么需要：SDK 的 contentSanitizer 只剥 **纯数字** 的 mention（<@!?\d+>），
 * 而新版 QQ 群下发的 mention 用 openid（字母数字混合，形如 <@!5F23DAE1...>），
 * 结果 content 变成 "<@!xxx> /new"，trim() 后不以 / 开头 → 所有 / 指令失效。
 * 这里做插件侧兜底：剥掉任何形态的 mention 前缀再判断命令。
 * @param {string} raw
 * @returns {string}
 */
export function stripLeadingMentions(raw) {
  let text = typeof raw === 'string' ? raw : '';
  // 反复剥：可能同时 @ 了多个人；兼容 <@id>、<@!id>、<@openid> 与 qqbot 的 <@!id,name=...> 形态
  for (let i = 0; i < 8; i += 1) {
    const next = text.replace(/^\s*<@!?[^>\s]+>\s*/, '');
    if (next === text) break;
    text = next;
  }
  return text.trim();
}

export function createCommandMiddleware({ settings, manager, logger, stats, getBot, adaptive } = {}) {
  return async function commandMiddleware(ctx, next) {
    const msg = ctx.message || {};
    const text = stripLeadingMentions(typeof msg.content === 'string' ? msg.content : '');
    if (!text.startsWith('/')) return next();

    const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return next();
    const name = match[1].toLowerCase();
    const catalogItem = CATALOG_BY_NAME.get(name);
    if (!catalogItem) return next(); // 未知命令当普通消息
    if (!KNOWN_COMMANDS.has(name)) return next();

    const { scope, peerId } = peerInfo(msg);
    const senderId = typeof msg.senderId === 'string' ? msg.senderId : '';
    const senderName = typeof msg.senderName === 'string' ? msg.senderName : '';

    // 管理员门控：只有 adminOnly 命令、且门控真正生效、且当前用户不是管理员时才拒绝
    if (catalogItem.adminOnly) {
      const adminInfo = adminStatus(readSettingsSnapshot(settings), senderId, senderName);
      if (!adminInfo.allowed) {
        logger.debug('管理员命令被拒绝: ' + name + ' sender=' + (senderId || '(unknown)'));
        await sendCommandReply(ctx, buildAdminRejection({ senderId, senderName, catalogItem }), getBot, logger);
        ctx.stop('command:' + name);
        return;
      }
    }

    let replyText = '';
    try {
      replyText = await handleCommand({
        name,
        ctx,
        scope,
        peerId,
        settings,
        manager,
        stats,
        adaptive,
        senderId,
        senderName,
      });
    } catch (err) {
      logger.error('命令 /' + name + ' 执行失败: ' + errText(err));
      replyText = '⚠️ 命令执行失败，请稍后重试。';
    }
    await sendCommandReply(ctx, replyText, getBot, logger);

    // 命令也是 DESIGN 里的「强制触发」之一：清空该群 adaptive 缓冲并进入冷却
    if (adaptive && typeof adaptive.noteForcedTrigger === 'function' && scope === 'group') {
      try {
        adaptive.noteForcedTrigger('group:' + peerId);
      } catch (err) {
        logger.warn('adaptive noteForcedTrigger 失败: ' + errText(err));
      }
    }
    // 命令必须在频率门控之前短路，不进入 agent
    ctx.stop('command:' + name);
  };
}
