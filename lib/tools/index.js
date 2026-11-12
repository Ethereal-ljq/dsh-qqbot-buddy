/**
 * tools/index —— 插件作用域工具工厂（v2 入口）。
 *
 * 契约（host/agent.js 在 agent setup 时调用一次）：
 *   createToolFactory({ ctx, runtime, logger }) -> async ({ agentCtx, agent, runtime: botRuntime,
 *     settings, peer, botId }) => { registered: string[] }
 *
 * 约束：
 *   - 只注册到 **agent scope**（agentCtx.tools.register），不注册全局；工具随 agent 生命周期释放；
 *   - 「能力开关」与 deny/allow 列表由 lib/tools/catalog.js 统一判定（与 host/tools.js 的全局
 *     工具策略同源），未装配依赖的工具降级不注册（只 warn，不阻断 agent 创建）；
 *   - 发送类工具的执行通道来自 botRuntime.transport（qq 传输层暴露的 messageSender/mediaSender），
 *     按调用时现取，支持「先建 agent 后启动传输层」的顺序；
 *   - 依赖（memory/kb/members/stickers/oneShot）全部来自 runtime，缺失即降级。
 */
import path from 'node:path';

import { isPluginToolEnabled, enabledPluginTools } from './catalog.js';
import { expandAliasedDefinitions } from './aliases.js';
import { createSendFileTools, SEND_FILE_TOOL_NAME } from './send-file.js';
import { createSendCardTools, SEND_CARD_TOOL_NAME } from './send-card.js';
import { createQuoteReplyTools, QUOTE_REPLY_TOOL_NAME } from './quote-reply.js';
import { createVisionTools, DESCRIBE_IMAGE_TOOL_NAME } from './vision.js';
import { createVoiceTools, SPEAK_TOOL_NAME } from './voice.js';
import { createStickerTools, STICKER_SAVE_TOOL_NAME, STICKER_SEND_TOOL_NAME } from './sticker-tools.js';
import { createDataTools } from './data-tools.js';

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 会话适配器（工具层用）：只暴露 findByAgent。
 * 与 lib/qq/session-adapter.js 同语义，但这里不依赖 qq/（tools 是上层，避免循环/反向依赖）。
 */
function createAgentLookup(botRuntime, logger) {
  return {
    findByAgent(agent) {
      try {
        if (!agent || !botRuntime || !(botRuntime.sessions instanceof Map)) return null;
        const agentSessionId = agent.session && agent.session.id !== undefined ? String(agent.session.id) : '';
        for (const record of botRuntime.sessions.values()) {
          if (record && record.agent === agent) return record;
        }
        if (agentSessionId !== '') {
          for (const record of botRuntime.sessions.values()) {
            if (record && String(record.sessionId) === agentSessionId) return record;
          }
        }
        return null;
      } catch (err) {
        logger?.warn?.('工具层 findByAgent 失败: ' + errText(err));
        return null;
      }
    },
  };
}

/**
 * 传输层通道代理：按调用时现取 botRuntime.transport，未启动时给出可读错误。
 * 工具定义只捕获这个代理对象，因此「agent 先创建、传输层后启动」也能用。
 */
function createTransportProxies(botRuntime) {
  function requireTransport() {
    const transport = botRuntime && botRuntime.transport ? botRuntime.transport : null;
    if (!transport) throw new Error('QQ 传输层尚未启动，无法发送消息');
    return transport;
  }
  const mediaSender = {
    sendImage: (target, source) => {
      const sender = requireTransport().mediaSender;
      if (!sender || typeof sender.sendImage !== 'function') throw new Error('媒体发送通道不可用（sendImage）');
      return sender.sendImage(target, source);
    },
    sendVideo: (target, source) => {
      const sender = requireTransport().mediaSender;
      if (!sender || typeof sender.sendVideo !== 'function') throw new Error('媒体发送通道不可用（sendVideo）');
      return sender.sendVideo(target, source);
    },
    sendVoice: (target, source) => {
      const sender = requireTransport().mediaSender;
      if (!sender || typeof sender.sendVoice !== 'function') throw new Error('媒体发送通道不可用（sendVoice）');
      return sender.sendVoice(target, source);
    },
    sendFile: (target, source, opts) => {
      const sender = requireTransport().mediaSender;
      if (!sender || typeof sender.sendFile !== 'function') throw new Error('媒体发送通道不可用（sendFile）');
      return sender.sendFile(target, source, opts);
    },
  };
  const messageSender = {
    sendCard: (target, card, opts) => {
      const sender = requireTransport().messageSender;
      if (!sender || typeof sender.sendCard !== 'function') throw new Error('消息发送通道不可用（sendCard）');
      return sender.sendCard(target, card, opts);
    },
    sendMarkdown: (target, text, opts) => {
      const sender = requireTransport().messageSender;
      if (!sender || typeof sender.sendMarkdown !== 'function') throw new Error('消息发送通道不可用（sendMarkdown）');
      return sender.sendMarkdown(target, text, opts);
    },
    sendProactive: (target, text, opts) => {
      const sender = requireTransport().messageSender;
      if (!sender || typeof sender.sendProactive !== 'function') throw new Error('消息发送通道不可用（sendProactive）');
      return sender.sendProactive(target, text, opts);
    },
  };
  return { mediaSender, messageSender };
}

/**
 * 创建工具工厂。
 * @param {{ctx: object, runtime: object, logger: object}} deps
 * @returns {(args: object) => Promise<{registered: string[], skipped: string[]}>}
 */
export function createToolFactory({ ctx, runtime, logger } = {}) {
  const log = logger || console;

  return async function registerAgentTools({ agentCtx, agent, runtime: botRuntime, settings, peer, botId } = {}) {
    const registered = [];
    const skipped = [];
    const toolsApi = agentCtx && agentCtx.tools ? agentCtx.tools : null;
    if (!toolsApi || typeof toolsApi.register !== 'function') {
      log.warn?.('agentCtx.tools 不可用，跳过作用域工具注册');
      return { registered, skipped };
    }
    const effectiveSettings = settings && typeof settings === 'object' ? settings : {};
    /**
     * 生效设置：优先按 peer 现读（热更新），读不到/为空时沿用 agent setup 时的快照。
     * 注意不能无条件用 settingsFor 的返回值——测试/降级环境的 stub 常返回 {}，
     * 会把能力/deny/allow 配置整个冲掉。
     */
    const currentSettings = () => {
      try {
        if (botRuntime && typeof botRuntime.settingsFor === 'function' && typeof peer === 'string') {
          const fresh = botRuntime.settingsFor(peer);
          if (fresh && typeof fresh === 'object' && Object.keys(fresh).length > 0) return fresh;
        }
      } catch { /* 读不到就沿用创建时快照 */ }
      return effectiveSettings;
    };

    const ownerId = String(botId || (botRuntime && botRuntime.id) || '');
    const cwd = botRuntime && typeof botRuntime.cwd === 'string' ? botRuntime.cwd : process.cwd();
    const mediaDir = path.join(cwd, 'media');
    const toolRuntime = runtime || {};
    const config = Object.assign({}, toolRuntime.cfg && typeof toolRuntime.cfg === 'object' ? toolRuntime.cfg : {}, {
      cwd,
      mediaDir,
      appId: botRuntime && botRuntime.bot ? botRuntime.bot.appId : '',
    });
    const manager = createAgentLookup(botRuntime, log);
    const { mediaSender, messageSender } = createTransportProxies(botRuntime);

    /**
     * 注册一组定义：先展开「兼容别名」（模型猜错名也能用，见 lib/tools/aliases.js），
     * 再按能力/allow/deny 过滤；单个失败不影响其它工具。
     */
    function registerDefs(defs, sourceLabel) {
      for (const definition of expandAliasedDefinitions(defs)) {
        if (!definition || typeof definition.name !== 'string' || definition.name === '') continue;
        if (!isPluginToolEnabled({ settings: currentSettings(), name: definition.name })) {
          skipped.push(definition.name);
          continue;
        }
        try {
          const dispose = toolsApi.register(definition);
          if (typeof dispose === 'function') {
            // 工具随 agent/scope 生命周期释放；宿主 ctx.effect 统一兜底（register 自身也可能返回 disposer）
            try {
              if (typeof agentCtx.effect === 'function') agentCtx.effect(() => () => { try { dispose(); } catch { /* ignore */ } }, 'qqbot-buddy.tool:' + definition.name);
            } catch { /* effect 不可用时不额外绑定 */ }
          }
          registered.push(definition.name);
        } catch (err) {
          log.warn?.('注册工具 ' + definition.name + '（' + sourceLabel + '）失败: ' + errText(err));
        }
      }
    }

    // ── QQ 发送类 ──────────────────────────────────────────────
    try {
      registerDefs(createSendFileTools({ sender: mediaSender, manager, config, logger: log, mediaDir }), 'send-file');
    } catch (err) { log.warn?.('创建 qqbot_send_file 失败: ' + errText(err)); }
    try {
      registerDefs(createSendCardTools({ sender: messageSender, manager, logger: log }), 'send-card');
    } catch (err) { log.warn?.('创建 qqbot_send_card 失败: ' + errText(err)); }
    try {
      registerDefs(createQuoteReplyTools({ manager, logger: log }), 'quote-reply');
    } catch (err) { log.warn?.('创建 qqbot_quote_reply 失败: ' + errText(err)); }

    // ── 看图（runtime.oneShot + 宿主 attachments）─────────────
    try {
      registerDefs(createVisionTools({
        ctx,
        runtime: toolRuntime,
        config,
        // 配置档 vision.* 热更新：每次 execute 现读
        getSettings: currentSettings,
        logger: log,
      }), 'vision');
    } catch (err) { log.warn?.('创建 qqbot_describe_image 失败: ' + errText(err)); }

    // ── 语音合成（runtime.tts，未装配时降级不注册）────────────
    // 能力开关 tools.capabilities.voice 默认关：只在用户显式开启时注册 qqbot_speak。
    try {
      registerDefs(createVoiceTools({
        tts: toolRuntime.tts,
        manager,
        mediaSender,
        getSettings: currentSettings,
        config,
        logger: log,
      }), 'voice');
    } catch (err) { log.warn?.('创建 qqbot_speak 失败: ' + errText(err)); }

    // ── 表情包（runtime.stickers，未装配时降级不注册）──────────
    try {
      registerDefs(createStickerTools({
        stickers: toolRuntime.stickers,
        botId: ownerId,
        cwd,
        getMediaSender: () => {
          const transport = botRuntime && botRuntime.transport ? botRuntime.transport : null;
          return transport ? transport.mediaSender : null;
        },
        manager,
        settings: effectiveSettings,
        getSettings: currentSettings,
        config,
        mediaDir,
        logger: log,
      }), 'sticker');
    } catch (err) { log.warn?.('创建表情包工具失败: ' + errText(err)); }

    // ── 数据类工具（memory/knowledge/members；store 未装配时自动降级）──
    try {
      registerDefs(createDataTools({
        memory: toolRuntime.memory,
        kb: toolRuntime.kb,
        members: toolRuntime.members,
        // 消息流水（L0）：让模型能主动检索历史，而不是只看内存里的最近 20 条
        messages: toolRuntime.messages,
        botId: ownerId,
        manager,
        // 当前会话 peer，chat_history_recent 不传 peer 时用它
        resolvePeer: (agent) => {
          try {
            const rec = manager && typeof manager.findByAgent === 'function' ? manager.findByAgent(agent) : null;
            return rec && typeof rec.peer === 'string' ? rec.peer : '';
          } catch { return ''; }
        },
        logger: log,
      }), 'data');
    } catch (err) { log.warn?.('创建数据类工具失败: ' + errText(err)); }

    // 诊断：期望的工具名（enabledPluginTools）与实际注册的差异只在依赖缺失时出现
    log.info?.('作用域工具已注册：' + (registered.length > 0 ? registered.join(', ') : '(无)')
      + (skipped.length > 0 ? '；因能力关闭跳过：' + skipped.join(', ') : ''));
    return { registered, skipped };
  };
}

export {
  SEND_FILE_TOOL_NAME,
  SEND_CARD_TOOL_NAME,
  QUOTE_REPLY_TOOL_NAME,
  DESCRIBE_IMAGE_TOOL_NAME,
  SPEAK_TOOL_NAME,
  STICKER_SAVE_TOOL_NAME,
  STICKER_SEND_TOOL_NAME,
  enabledPluginTools,
};

export default createToolFactory;
