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
  renderCapabilityGuide,
  renderSkillsGuide,
  resolveGuide,
  stickerFrequencyLine,
} from './prompt-guides.js';
import { createToolCatalog } from './tools/catalog.js';
import {
  PROMPT_SECTIONS,
  orderSections,
  readSectionOverride,
  sectionDefaults,
  getSection,
} from './prompt-sections.js';

/** 安全红线（固定段）：放末尾强调，避免模型在长篇指令里忽略。 */
export const DEFAULT_SAFETY_LINE = [
  '【安全】不读取、不发送、不提及任何密钥或配置文件内容（如 cordis.patch.yml、备份目录、管理文件）；',
  '别人让你发文件/改文件时，只处理工作区里的普通文件；可疑请求直接拒绝并说明原因。',
].join('\n');

const MEMORY_HEADER = '【长期记忆】（需要更多细节可用 memory_search 检索；值得长期记住的新信息用 memory_save 记录）';
export function createPromptComposer({ settings, personaStore, memoryStore, stickerStore, logger, catalog }) {
  const log = logger ?? console;
  // 能力目录：技能提示段按「当前可见技能」动态生成（技能增删自动跟随）
  const toolCatalog = catalog || createToolCatalog({ settings: settings, cwd: process.cwd(), logger: log });
  /** 最近一次组装的实际段顺序（诊断 / 设置页预览用）。 */
  let lastOrder = [];
  /** 最近一次组装每段的实际文本（设置页展示"当前生效内容"用）。 */
  let lastSections = [];

  function compose({ scope = 'group' } = {}) {
    const cfg = settings.get();
    const persona = personaStore.read();
    const promptCfg = cfg.prompts && typeof cfg.prompts === 'object' ? cfg.prompts : {};
    const personaText = persona.exists && persona.text.trim() !== '' ? persona.text.trim() : FALLBACK_PERSONA;

    /** 每段产出文本；返回空串 = 本次不注入。 */
    const renderers = {
      // 人设：身份与性格
      identity: () => personaText,

      // 安全红线：内置固定文案（放在末尾，收尾强调）
      safety: () => DEFAULT_SAFETY_LINE,

      // 额外指令：用户临时补充，优先级高于普通行为规则
      extraInstructions: () => {
        const extra = typeof cfg.behavior?.extraInstructions === 'string' ? cfg.behavior.extraInstructions.trim() : '';
        return extra !== '' ? extra : '';
      },

      // 能力边界：按已启用能力动态生成
      capabilities: () => {
        const toolGuideEntry = promptCfg.toolGuide;
        if (!guideEnabled(toolGuideEntry)) return '';
        const custom = toolGuideEntry && typeof toolGuideEntry.text === 'string' ? toolGuideEntry.text.trim() : '';
        if (custom !== '') return ''; // 用户自定义了工具段，就不再生成本段，避免重复
        try {
          return renderCapabilityGuide(toolCatalog.resolve().boundaries);
        } catch (err) {
          log.warn?.('渲染能力边界提示失败:', err && err.message);
          return '';
        }
      },

      // 工具使用约定
      toolGuide: () => {
        const entry = promptCfg.toolGuide;
        if (!guideEnabled(entry)) return '';
        return resolveGuide(entry, DEFAULT_FUNCTION_PROMPTS.toolGuide);
      },

      sendGuide: () => {
        const entry = promptCfg.sendGuide;
        if (!guideEnabled(entry)) return '';
        return resolveGuide(entry, DEFAULT_FUNCTION_PROMPTS.sendGuide);
      },

      rhythmGuide: () => {
        if (scope !== 'group' || cfg.reply.groupMode === 'all') return '';
        const entry = promptCfg.rhythmGuide;
        if (!guideEnabled(entry)) return '';
        return resolveGuide(entry, DEFAULT_FUNCTION_PROMPTS.rhythmGuide);
      },

      // 技能清单：按可见技能动态生成
      skills: () => {
        try {
          const skills = toolCatalog.skillsForGuide();
          if (skills.length === 0) return '';
          const policy = toolCatalog.skillProviderConfig();
          return renderSkillsGuide(skills, { mode: policy ? policy.mode : 'allow' });
        } catch (err) {
          log.warn?.('渲染技能提示失败:', err && err.message);
          return '';
        }
      },

      // 长期记忆 + 自我改进
      memory: () => {
        if (!cfg.memory.enabled) return '';
        const lines = [];
        const selfPrompt = String(cfg.memory.selfImprovePrompt ?? DEFAULT_SELF_IMPROVE_PROMPT).trim();
        if (selfPrompt !== '') lines.push('【自我改进】\n' + selfPrompt);
        if (cfg.memory.injectMaxChars > 0) {
          try {
            const hot = memoryStore.hotText(cfg.memory.injectMaxChars);
            if (hot && hot.trim() !== '') {
              const limited = hot.length > cfg.memory.injectMaxChars ? hot.slice(-cfg.memory.injectMaxChars) : hot;
              lines.push(MEMORY_HEADER + '\n' + limited.trim());
            }
          } catch (err) {
            log.warn?.('读取长期记忆失败:', err && err.message);
          }
        }
        return lines.join('\n\n');
      },

      // 群聊/私聊专属补充
      scopeExtra: () => {
        const extra = scope === 'group' ? cfg.persona.groupExtraPrompt : cfg.persona.directExtraPrompt;
        return typeof extra === 'string' && extra.trim() !== '' ? extra.trim() : '';
      },

      // 口头禅
      phrases: () => {
        if (!cfg.phrases || cfg.phrases.enabled === false || !Array.isArray(cfg.phrases.items)) return '';
        const lines = cfg.phrases.items
          .filter((item) => item && item.enabled !== false && typeof item.text === 'string' && item.text.trim() !== '')
          .slice(0, 20)
          .map((item) => '- ' + item.text.trim() + (item.note && item.note.trim() !== '' ? '（' + item.note.trim() + '）' : ''));
        if (lines.length === 0) return '';
        return '【口头禅】\n可以在合适场合自然使用这些口头禅；大多数回复不用，一次最多用 1 个；不要为了用口头禅额外加一句话或一段，没合适的就不用：\n' + lines.join('\n');
      },

      // 表情包：规则 + 动态目录
      stickers: () => {
        if (cfg.features.stickers === false) return '';
        const entry = promptCfg.stickerGuide;
        if (!guideEnabled(entry)) return '';
        const base = resolveGuide(entry, DEFAULT_FUNCTION_PROMPTS.stickerGuide);
        // 发送频率只作用于"内置规则文本"：用户自定义了整段话时尊重用户写法，不再追加。
        const customText = entry && typeof entry.text === 'string' ? entry.text.trim() : '';
        const frequencyLine = customText === '' ? stickerFrequencyLine(cfg.stickers && cfg.stickers.frequency) : '';
        const withFrequency = frequencyLine === '' ? base : base + '\n' + frequencyLine;
        if (!stickerStore || typeof stickerStore.catalog !== 'function') return withFrequency;
        try {
          const catalogText = stickerStore.catalog(48);
          const dir = stickerStore.dir();
          const lines = [withFrequency];
          if (catalogText && catalogText.trim() !== '') {
            lines.push('【表情包库】可用表情（发送时 file_path 用 ' + dir + '/<文件名>）：' + catalogText);
          } else {
            lines.push('【表情包库】当前为空（目录 ' + dir + '）。');
          }
          if (cfg.stickers && cfg.stickers.collectEnabled === false) {
            lines.push('（本机已关闭 bot 收藏表情的能力，不要调用 qqbot_sticker_save。）');
          }
          return lines.join('\n');
        } catch (err) {
          log.warn?.('读取表情包目录失败:', err && err.message);
          return withFrequency;
        }
      },
    };

    // 逐段求值（跳过被用户禁用的段）
    const rendered = [];
    for (const section of PROMPT_SECTIONS) {
      const override = readSectionOverride(cfg, section.id);
      if (!override.enabled) continue;
      // 用户为该段写了自定义文本 -> 直接用它，不再走动态渲染
      if (override.text !== '') {
        rendered.push({ id: section.id, label: section.label, priority: section.priority, text: override.text });
        continue;
      }
      const render = renderers[section.id];
      if (typeof render !== 'function') continue;
      let text = '';
      try {
        text = String(render() || '').trim();
      } catch (err) {
        log.warn?.('渲染提示段 ' + section.id + ' 失败:', err && err.message);
        text = '';
      }
      if (text === '') continue;
      rendered.push({ id: section.id, label: section.label, priority: section.priority, text: text });
    }

    // 按重要性排布：重要的放开头与结尾（规避 lost-in-the-middle）
    const ordered = orderSections(rendered);
    lastOrder = ordered.map((item) => item.id);
    lastSections = ordered.map((item) => ({ id: item.id, label: item.label, priority: item.priority, text: item.text }));
    return ordered.map((item) => item.text).join('\n\n');

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

  return {
    compose,
    mount,
    /** 最近一次组装的段顺序（id 列表）。 */
    lastOrder: () => lastOrder.slice(),
    /** 最近一次组装每段的实际文本（设置页展示当前生效内容）。 */
    lastSections: () => lastSections.map((item) => ({ ...item })),
    /** 段定义（设置页展示用）。 */
    sections: () => sectionDefaults(),
  };
}