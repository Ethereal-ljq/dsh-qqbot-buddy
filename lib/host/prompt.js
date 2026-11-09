/**
 * host/prompt —— 声明式 prompt 契约（v2 核心修复）。
 *
 * 规则（DESIGN-v2 §0.3）：
 *  1. 所有 prompt 段都在 **agent scope** 用唯一名字注册（qqbot:*），不与宿主段同名；
 *  2. 动态内容一律走 systemPrompt.variable()，每次 assembly 重新求值；
 *  3. 不监听 system-prompt/assemble、不改 assembly 数组、不改 provider 对象；
 *  4. 需要隐藏运行时上下文时用官方 suppressRuntimeContext()。
 *
 * 这样冷会话（resume/持久化恢复）与热会话走同一套注册，不会出现"prompt 被覆盖导致掉工具"。
 */
import { getService, errText } from './services.js';
import { buildToolGuide, collectDiscovered } from './tools.js';

/** 段名常量（外部测试/文档引用）。 */
export const PROMPT_SECTIONS = {
  persona: 'qqbot:persona',
  members: 'qqbot:members',
  memory: 'qqbot:memory',
  knowledge: 'qqbot:knowledge',
  guide: 'qqbot:guide',
};

export const PROMPT_VARIABLES = {
  persona: 'qqbot_persona',
  members: 'qqbot_members',
  memory: 'qqbot_memory',
  knowledge: 'qqbot_knowledge',
  guide: 'qqbot_guide',
};

function readOrder(service, name, fallback) {
  try {
    const value = typeof service.getSectionOrder === 'function' ? service.getSectionOrder(name) : undefined;
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 创建 prompt 组装器。
 * state 约定（由 session 层维护，允许热更新）：
 *   personaText() / memberText() / memoryText() / knowledgeText() / settings() / toolsGuide(agent)
 */
export function createPromptComposer({ logger } = {}) {
  return {
    /**
     * 在 agent scope 安装 prompt 段。可重复调用（setup 每次 create/resume 都会跑）。
     * @returns {boolean} 是否安装成功
     */
    mount(agentCtx, agent, state) {
      const service = getService(agentCtx, 'systemPrompt') || (agentCtx && agentCtx.systemPrompt);
      if (!service || typeof service.section !== 'function' || typeof service.variable !== 'function') {
        logger?.warn?.('systemPrompt 服务不可用，跳过 prompt 组装');
        return false;
      }
      const base = readOrder(service, 'DEPLOYMENT_PERSONA_PREFIX', 0);
      const read = (fn, fallback = '') => {
        try { const value = fn(); return typeof value === 'string' ? value : fallback; } catch { return fallback; }
      };

      try {
        service.variable(PROMPT_VARIABLES.persona, () => read(state.personaText));
        service.variable(PROMPT_VARIABLES.members, () => read(state.membersText));
        service.variable(PROMPT_VARIABLES.memory, () => read(state.memoryText));
        service.variable(PROMPT_VARIABLES.knowledge, () => read(state.knowledgeText));
        service.variable(PROMPT_VARIABLES.guide, () => {
          try { return typeof state.toolsGuide === 'function' ? state.toolsGuide(agent) : ''; } catch (err) {
            logger?.warn?.('生成工具指引失败: ' + errText(err));
            return '';
          }
        });

        service.section({ name: PROMPT_SECTIONS.persona, order: base + 1, text: '{{' + PROMPT_VARIABLES.persona + '}}' });
        service.section({ name: PROMPT_SECTIONS.guide, order: base + 2, text: '{{' + PROMPT_VARIABLES.guide + '}}' });
        service.section({ name: PROMPT_SECTIONS.memory, order: base + 3, text: '{{' + PROMPT_VARIABLES.memory + '}}' });
        service.section({ name: PROMPT_SECTIONS.knowledge, order: base + 4, text: '{{' + PROMPT_VARIABLES.knowledge + '}}' });
        service.section({ name: PROMPT_SECTIONS.members, order: base + 5, text: '{{' + PROMPT_VARIABLES.members + '}}' });
      } catch (err) {
        logger?.warn?.('注册 prompt 段失败: ' + errText(err));
        return false;
      }

      // 隐藏宿主运行时上下文（team:identity / 工作目录 / 时间等），chatonly 语义
      try {
        const settings = typeof state.settings === 'function' ? state.settings() : state.settings;
        if (!settings || settings.persona?.suppressRuntimeContext !== false) {
          if (typeof service.suppressRuntimeContext === 'function') service.suppressRuntimeContext();
        }
      } catch (err) {
        logger?.warn?.('关闭运行时上下文失败: ' + errText(err));
      }
      return true;
    },
  };
}

/**
 * 生成"当前 agent 可见工具"的指引文本（给 prompt 用）。
 * 每次 assembly 调用，因此插件增删工具后指引自动跟随。
 */
export function toolsGuideFor(agentCtx, agent) {
  try {
    const view = agentCtx.tools.view(agent);
    return buildToolGuide(collectDiscovered(view));
  } catch {
    return '';
  }
}

export default createPromptComposer;
