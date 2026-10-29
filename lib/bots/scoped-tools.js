/**
 * bots/scoped-tools —— 把插件工具注册到「当前 agent 作用域」，而不是全局。
 *
 * 背景（v0.16.1）：插件工具（memory_* / knowledge_* / member_* / qqbot_send_file /
 * qqbot_sticker_save / qqbot_describe_image）原先注册在插件 ctx 的全局 tools 注册表里，
 * 宿主里其它 preset / 普通 Web agent 也能看到这些工具。现在改为：
 *   - 只在 SessionManager 创建 QQ 会话（qqbot preset / 用户选的 preset）时，
 *     通过 agentCtx.tools.register() 注册到该 agent 的 scope；
 *   - 作用域注册对其它 agent 不可见，且 agent 释放时随 scope 一起清理。
 *
 * 注意：tool 模块内部用 ctx.get('tools') 取注册表，而 agentCtx.get('tools') 拿到的是
 * 无 scope 绑定的宿主实例（会注册成全局）。因此这里包一层 get()，把 'tools' 固定为
 * agentCtx.tools（scope 代理）。
 */
import { registerMemoryTools } from '../tools/memory-tools.js';
import { registerSendFileTool } from '../tools/send-file.js';
import { registerVisionTool } from '../tools/vision.js';
import { registerStickerTools } from '../tools/sticker-tools.js';

function errText(err) { return err instanceof Error ? err.message : String(err); }

/** 供工具模块使用的 ctx 包装：工具的注册必须落在 agent scope 上。 */
export function createScopedToolCtx(agentCtx) {
  let scopedTools;
  try {
    scopedTools = agentCtx && typeof agentCtx === 'object' ? agentCtx.tools : undefined;
  } catch {
    scopedTools = undefined;
  }
  return {
    get tools() { return scopedTools; },
    get(name) {
      const key = typeof name === 'string' ? name : '';
      if (key === 'tools') return scopedTools;
      try {
        return agentCtx && typeof agentCtx.get === 'function' ? agentCtx.get(key) : undefined;
      } catch {
        return undefined;
      }
    },
    on: (...args) => (agentCtx && typeof agentCtx.on === 'function' ? agentCtx.on(...args) : () => {}),
    effect: (...args) => (agentCtx && typeof agentCtx.effect === 'function' ? agentCtx.effect(...args) : undefined),
  };
}

/**
 * 把插件工具注册进当前 agent scope。
 * @param {object} agentCtx agent 作用域的 cordis 上下文（setup 回调参数）
 * @param {object} bot 该 agent 所属的机器人运行时（BotRuntime）
 * @param {object} [logger]
 * @returns {Array<() => void>} 需在 agent 释放时调用的 disposer 列表
 */
export async function registerScopedTools(agentCtx, bot, logger) {
  const log = logger || console;
  const ctx = createScopedToolCtx(agentCtx);
  const tools = ctx.get('tools');
  if (!tools || typeof tools.register !== 'function') {
    log.warn?.('[scoped-tools] agent scope 没有 tools 注册表，跳过插件工具注册');
    return [];
  }
  if (!bot) {
    log.warn?.('[scoped-tools] 没有机器人运行时，跳过插件工具注册');
    return [];
  }

  const disposers = [];
  const push = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose);
  };
  /** 当前 agent 只属于这一个机器人，无需 agent 反查。 */
  const resolveBot = () => bot;

  // ── 记忆 ──
  try {
    push(registerMemoryTools(ctx, { memoryStore: bot.memory, resolveBot: resolveBot, logger: log }));
  } catch (err) {
    log.warn?.('[scoped-tools] memory_* 注册失败: ' + errText(err));
  }

  // ── 知识库 / 群友库（模块缺失时降级跳过） ──
  const registerEntryTools = async (specifier, exportName, label) => {
    let mod;
    try {
      mod = await import(specifier);
    } catch (err) {
      log.warn?.('[scoped-tools] ' + label + ' 未加载（功能降级）: ' + errText(err));
      return;
    }
    if (!mod || typeof mod[exportName] !== 'function') {
      log.warn?.('[scoped-tools] ' + specifier + ' 缺少 ' + exportName + ' 导出，跳过');
      return;
    }
    try {
      push(mod[exportName](ctx, {
        resolveBot: resolveBot,
        knowledge: bot.knowledge,
        members: bot.members,
        logger: log,
      }));
    } catch (err) {
      log.warn?.('[scoped-tools] ' + label + ' 注册失败: ' + errText(err));
    }
  };
  await registerEntryTools('../tools/knowledge-tools.js', 'registerKnowledgeTools', 'knowledge_*');
  await registerEntryTools('../tools/member-tools.js', 'registerMemberTools', 'member_*');

  // ── 表情包 ──
  try {
    push(registerStickerTools(ctx, {
      stickerStore: bot.stickers,
      config: bot.config,
      logger: log,
      mediaDir: bot.mediaDir,
      resolveBot: resolveBot,
    }));
  } catch (err) {
    log.warn?.('[scoped-tools] qqbot_sticker_save 注册失败: ' + errText(err));
  }

  // ── 发送文件 ──
  try {
    const gateway = bot.gateway;
    push(registerSendFileTool({
      ctx: ctx,
      sender: gateway && gateway.sender ? gateway.sender : undefined,
      manager: bot.manager,
      config: bot.config,
      logger: log,
      mediaDir: bot.mediaDir,
      resolveBot: resolveBot,
    }));
  } catch (err) {
    log.warn?.('[scoped-tools] qqbot_send_file 注册失败: ' + errText(err));
  }

  // ── 看图（部署级视觉配置，各机器人共用） ──
  try {
    push(registerVisionTool({ ctx: ctx, config: bot.host ? bot.host.config : bot.config, logger: log }));
  } catch (err) {
    log.warn?.('[scoped-tools] qqbot_describe_image 注册失败: ' + errText(err));
  }

  return disposers;
}

export default registerScopedTools;
