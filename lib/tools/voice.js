/**
 * voice —— 内置工具 qqbot_speak：把文字合成语音（TTS）并发到当前 QQ 会话。
 *
 * 契约见 docs/MODELS-CENTER.md §8，依赖 runtime.tts（core/tts 引擎，§6）：
 *   1. getSettings() 现读配置档生效设置（voice.enabled / provider / voice / style / maxChars…）；
 *   2. tts.synthesizeForSettings({ text, settings, voice, style }) 合成并落盘；
 *   3. exec.agent -> manager.findByAgent -> record.replyTarget 定位当前会话；
 *   4. mediaSender.sendVoice(target, { localPath }) 把音频发出去。
 *
 * 错误语义：
 *   - 未启用 / 无可用供应商 / 合成失败：抛可读中文错误（引擎错误原样透出，带 .code）；
 *   - 发送失败：原样抛，不包装——deliveryUnknown 的「可能已送达、别重试」语义由
 *     qq/media-send.js 的统一约定保证，工具层不能吞掉或改写成普通失败。
 *
 * TTS 引擎缺失时降级不注册（只 warn），绝不阻断插件启动。
 */

/** 工具名（qqbot 前缀避免与其它通道的同名工具冲突）。 */
export const SPEAK_TOOL_NAME = 'qqbot_speak';

const DESCRIPTION = 'Synthesize speech from text and send it as a voice message to the QQ user or group '
  + 'of the current conversation. Use it only when the user actually needs to LISTEN (e.g. asks you '
  + 'to read something aloud or send a voice reply), and keep the text short — one or two sentences. '
  + 'Do not use it for long passages; the configured character limit truncates the audio.';

/** 解析当前会话的发送目标（exec.agent -> session record -> replyTarget）。 */
function resolveTarget(manager, exec) {
  const runCtx = exec && typeof exec === 'object' ? exec : {};
  if (runCtx.agent === undefined) return undefined;
  const record = manager && typeof manager.findByAgent === 'function' ? manager.findByAgent(runCtx.agent) : undefined;
  return record && record.replyTarget ? record.replyTarget : undefined;
}

/**
 * 创建 qqbot_speak 工具定义（由 lib/tools/index.js 的工厂注册到 agent scope）。
 * @param {object} deps
 * @param {object} deps.tts TTS 引擎（runtime.tts，需 synthesizeForSettings）
 * @param {object} deps.manager 会话适配器（需 findByAgent(agent) -> record，取 record.replyTarget）
 * @param {object} deps.mediaSender 媒体发送适配器（需 sendVoice(target, { localPath })）
 * @param {Function} [deps.getSettings] () => 生效设置（优先，支持热更新；缺省按空设置）
 * @param {object} [deps.config] 部署配置（保留给后续语音参数，当前未使用）
 * @param {object} [deps.logger]
 * @returns {object[]} 工具定义数组；tts 不可用时返回 []（降级不注册）
 */
export function createVoiceTools({ tts, manager, mediaSender, getSettings, config, logger } = {}) {
  const log = logger || console;
  if (!tts || typeof tts.synthesizeForSettings !== 'function') {
    log.warn?.('TTS 引擎不可用（runtime.tts.synthesizeForSettings），qqbot_speak 工具未注册');
    return [];
  }

  /** 每次 execute 现读设置（宿主设置支持热更新，构造时的快照可能已过期）。 */
  const currentSettings = () => {
    try {
      const value = typeof getSettings === 'function' ? getSettings() : {};
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  };

  const definition = {
    name: SPEAK_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to speak. Keep it short (one or two sentences); longer text may be truncated.',
        },
        style: {
          type: 'string',
          description: 'Optional speaking-style override for this call, e.g. "活泼、语速偏快、带笑意".',
        },
        voice: {
          type: 'string',
          description: 'Optional voice id override for this call (provider-specific, e.g. zh-CN-XiaoxiaoNeural).',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          provider: { type: 'string' },
          voice: { type: 'string' },
          format: { type: 'string' },
          bytes: { type: 'integer' },
          filePath: { type: 'string' },
          target: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['ok', 'provider', 'voice', 'format', 'bytes', 'filePath', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const base = '已发送语音（' + (v.provider || 'TTS') + (v.voice ? ' / ' + v.voice : '') + '） -> ' + (v.target || '');
        return [{ type: 'text', text: v.truncated === true ? base + '；文本过长，已按配置上限截断' : base }];
      },
    },
    async execute(args, exec) {
      const runCtx = exec && typeof exec === 'object' ? exec : {};
      const text = args && typeof args.text === 'string' ? args.text.trim() : '';
      if (text === '') throw new Error(SPEAK_TOOL_NAME + ': text 不能为空');

      const settings = currentSettings();
      const voiceCfg = settings.voice && typeof settings.voice === 'object' ? settings.voice : {};
      // 能力开关（tools.capabilities.voice）只决定工具是否注册；voice.enabled 是功能总开关，
      // 两者都开启才能用。显式 allow 放行时仍要过这一关，避免用户在设置页关掉后模型还在合成。
      if (voiceCfg.enabled !== true) {
        throw new Error(SPEAK_TOOL_NAME + ': 语音合成未启用（配置档 → 语音（TTS））');
      }

      // 无可用供应商时提前给出可读错误；引擎内部同样会拒绝（TTS_PROVIDER_NOT_FOUND）。
      let selection = null;
      if (typeof tts.resolveSelection === 'function') {
        try { selection = tts.resolveSelection({ settings }); } catch { selection = null; }
        if (!selection) {
          throw new Error(SPEAK_TOOL_NAME + ': 未配置可用的 TTS 供应商（配置档 → 语音（TTS），或先在「模型 → 语音」页添加供应商）');
        }
      }

      const voiceArg = args && typeof args.voice === 'string' && args.voice.trim() !== '' ? args.voice.trim() : undefined;
      const styleArg = args && typeof args.style === 'string' && args.style.trim() !== '' ? args.style.trim() : undefined;
      const synthArgs = { text, settings };
      if (voiceArg !== undefined) synthArgs.voice = voiceArg;
      if (styleArg !== undefined) synthArgs.style = styleArg;
      if (runCtx.signal) synthArgs.signal = runCtx.signal;

      // 引擎错误统一为中文可读 Error（带 .code），原样透出便于模型/用户定位问题
      const result = await tts.synthesizeForSettings(synthArgs);
      if (!result || result.ok !== true) {
        const failure = new Error(SPEAK_TOOL_NAME + ': 语音合成失败: '
          + ((result && (result.error || result.message)) || '引擎没有返回 ok'));
        if (result && result.code) failure.code = result.code;
        throw failure;
      }
      const filePath = typeof result.filePath === 'string' ? result.filePath : '';
      if (filePath === '') throw new Error(SPEAK_TOOL_NAME + ': 语音合成没有返回音频文件（filePath 为空）');

      const target = resolveTarget(manager, exec);
      if (!target) throw new Error(SPEAK_TOOL_NAME + ': 无法确定发送目标，请先让用户发一条消息');
      if (!mediaSender || typeof mediaSender.sendVoice !== 'function') {
        throw new Error(SPEAK_TOOL_NAME + ': 媒体发送通道不可用（sendVoice）');
      }

      // 发送失败原样抛：deliveryUnknown 的「可能已送达，请勿重试」语义由网关层统一保证。
      await mediaSender.sendVoice(target, { localPath: filePath });

      const providerLabel = result.provider || result.providerId
        || (selection && (selection.provider || selection.providerId)) || '';
      const voiceLabel = result.voice || voiceArg || (selection && selection.voice) || '';
      const format = typeof result.format === 'string' ? result.format : '';
      const bytes = Number.isFinite(Number(result.bytes)) ? Number(result.bytes) : 0;
      const truncated = result.truncated === true;
      const targetLabel = target.scope + ':' + target.targetId;
      log.info?.('qqbot_speak 发送语音 ' + bytes + ' bytes -> ' + targetLabel
        + (truncated ? '（文本已截断）' : ''));
      return {
        ok: true,
        provider: String(providerLabel),
        voice: String(voiceLabel),
        format,
        bytes,
        filePath,
        target: targetLabel,
        truncated,
      };
    },
  };

  return [definition];
}

export default createVoiceTools;
