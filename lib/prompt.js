/**
 * prompt —— 组合 QQ agent 的 system prompt：人设 + 长期记忆 + 行为指引 + scope 额外指令。
 *
 * 两种模式（settings.persona.mode）：
 * - replace：注册 complete section，完全替代宿主默认提示（chatonly 风格；仍保留工具 schema）
 * - append：作为普通 section 追加
 *
 * 文本在每次 assembly 时求值（函数式 text），所以设置页改了人设/记忆文件后，
 * 下一轮立即生效，无需重载插件或重建会话。
 */
import { FALLBACK_PERSONA } from './persona-store.js';
import { DEFAULT_SELF_IMPROVE_PROMPT } from './self-improve.js';
import {
  DEFAULT_FUNCTION_PROMPTS,
  guideEnabled,
  resolveGuide,
} from './prompt-guides.js';

const MEMORY_HEADER = '【长期记忆】（需要更多细节可用 memory_search 检索；值得长期记住的新信息用 memory_save 记录）';
export function createPromptComposer({ settings, personaStore, memoryStore, stickerStore, logger }) {
  const log = logger ?? console;

  function compose({ scope = 'group' } = {}) {
    const cfg = settings.get();
    const persona = personaStore.read();
    const parts = [];
    const personaText = persona.exists && persona.text.trim() !== '' ? persona.text.trim() : FALLBACK_PERSONA;
    if (cfg.persona.mode === 'replace') {
      parts.push(personaText);
    } else {
      // append 模式：仍以人设开头，但宿主自己的系统提示会保留在前
      parts.push(personaText);
    }

    // 【口头禅】独立段：从对话里学到的口癖单独管理，不写进 persona.md。
    if (cfg.phrases && cfg.phrases.enabled !== false && Array.isArray(cfg.phrases.items)) {
      const lines = cfg.phrases.items
        .filter((item) => item && item.enabled !== false && typeof item.text === 'string' && item.text.trim() !== '')
        .slice(0, 20)
        .map((item) => '- ' + item.text.trim() + (item.note && item.note.trim() !== '' ? '（' + item.note.trim() + '）' : ''));
      if (lines.length > 0) {
        parts.push('【口头禅】\n可以在合适场合自然使用这些口头禅；大多数回复不用，一次最多用 1 个；不要为了用口头禅额外加一句话或一段，没合适的就不用：\n' + lines.join('\n'));
      }
    }

    if (cfg.memory.enabled) {
      // 【自我改进】与 persona 分开：persona.md 只当人设，学习规则单独成段、可单独编辑。
      const selfPrompt = String(cfg.memory.selfImprovePrompt ?? DEFAULT_SELF_IMPROVE_PROMPT).trim();
      if (selfPrompt !== '') parts.push('【自我改进】\n' + selfPrompt);
      if (cfg.memory.injectMaxChars > 0) {
        try {
          const hot = memoryStore.hotText(cfg.memory.injectMaxChars);
          if (hot && hot.trim() !== '') {
            const limited = hot.length > cfg.memory.injectMaxChars ? hot.slice(-cfg.memory.injectMaxChars) : hot;
            parts.push(MEMORY_HEADER + '\n' + limited.trim());
          }
        } catch (err) {
          log.warn?.('读取长期记忆失败:', err && err.message);
        }
      }
    }

    // 功能性提示词（与人设分离，可在设置里分别开关/编辑）
    const promptCfg = cfg.prompts && typeof cfg.prompts === 'object' ? cfg.prompts : {};
    const pushGuide = (key) => {
      const entry = promptCfg[key];
      if (!guideEnabled(entry)) return;
      const textValue = resolveGuide(entry, DEFAULT_FUNCTION_PROMPTS[key]);
      if (textValue !== '') parts.push(textValue);
    };

    pushGuide('toolGuide');
    pushGuide('sendGuide');

    // 表情包：规则段（可编辑）+ 动态目录（名称=情绪，随库变化）
    if (cfg.features.stickers !== false && guideEnabled(promptCfg.stickerGuide)) {
      if (stickerStore && typeof stickerStore.catalog === 'function') {
        try {
          const catalog = stickerStore.catalog(48);
          const dir = stickerStore.dir();
          const lines = [resolveGuide(promptCfg.stickerGuide, DEFAULT_FUNCTION_PROMPTS.stickerGuide)];
          if (catalog && catalog.trim() !== '') {
            lines.push('【表情包库】可用表情（发送时 file_path 用 ' + dir + '/<文件名>）：' + catalog);
          } else {
            lines.push('【表情包库】当前为空（目录 ' + dir + '）。');
          }
          if (cfg.stickers && cfg.stickers.collectEnabled === false) {
            lines.push('（本机已关闭 bot 收藏表情的能力，不要调用 qqbot_sticker_save。）');
          }
          parts.push(lines.join('\n'));
        } catch (err) {
          log.warn?.('读取表情包目录失败:', err && err.message);
        }
      } else {
        const fallback = resolveGuide(promptCfg.stickerGuide, DEFAULT_FUNCTION_PROMPTS.stickerGuide);
        if (fallback !== '') parts.push(fallback);
      }
    }

    if (scope === 'group' && cfg.reply.groupMode !== 'all') pushGuide('rhythmGuide');

    const extra = scope === 'group' ? cfg.persona.groupExtraPrompt : cfg.persona.directExtraPrompt;
    if (extra && extra.trim() !== '') parts.push(extra.trim());
    if (cfg.behavior.extraInstructions && cfg.behavior.extraInstructions.trim() !== '') {
      parts.push(cfg.behavior.extraInstructions.trim());
    }
    return parts.join('\n\n');
  }

  function mount(agentCtx, { scope = 'group' } = {}) {
    const systemPrompt = agentCtx && agentCtx.systemPrompt;
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      log.warn?.('systemPrompt 服务不可用，跳过 prompt 挂载');
      return () => {};
    }
    const cfg = settings.get();
    const complete = cfg.persona.mode === 'replace';

    let order = 0;
    if (!complete) {
      try {
        order = systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX');
      } catch {
        order = 0;
      }
    }
    const section = {
      name: 'qqbot-buddy:persona',
      order,
      interpolate: false,
      complete,
      text: () => compose({ scope }),
    };

    try {
      agentCtx.effect(() => {
        const disposers = [];
        try {
          if (complete && cfg.persona.suppressRuntimeContext) {
            disposers.push(systemPrompt.suppressRuntimeContext());
          }
          disposers.push(systemPrompt.section(section));
        } catch (err) {
          log.warn?.('挂载 system prompt section 失败:', err && err.message);
        }
        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch {
              /* ignore */
            }
          }
        };
      }, 'qqbot-buddy:prompt');
    } catch (err) {
      log.warn?.('注册 prompt effect 失败:', err && err.message);
    }
    return () => {};
  }

  return { compose, mount };
}