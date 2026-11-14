/**
 * host/prompt —— 声明式 prompt 契约（v2 核心修复 + 2026-11-12 槽位化改造）。
 *
 * 规则（DESIGN-v2 §0.3）：
 *  1. 所有注册都在 **agent scope**，只影响我们创建的 session；
 *  2. 动态内容一律走 systemPrompt.variable()，每次 assembly 重新求值；
 *  3. 不监听 system-prompt/assemble、不改 assembly 数组、不改 provider 对象；
 *  4. 需要隐藏运行时上下文时用官方 suppressRuntimeContext()。
 *
 * 2026-11-12：从「新增 5 个 qqbot:* 段」改为「占官方槽位 + 遮蔽别的 surface 专属段」：
 *  - 人设写进 deployment:persona-prefix（官方给部署方替换人设的槽位，dsh-persona 同款）；
 *  - 遮蔽 harness:identity / harness:source / app:web-surface / ui:deliverable-file-references /
 *    context:file-reference——这些是 Web/开发 surface 的话术，QQ 机器人不需要；
 *  - 遮蔽「被动工具」的 tool:* 散文（工具档位见 lib/tools/catalog.js）；
 *  - 顺序按「静态前、动态后」：人设 0 → 工具指引 5100 → 记忆/知识/群友 9400-9600 → 环境后缀 10200。
 */
import { getService, errText } from './services.js';
import { buildToolGuide, collectDiscovered } from './tools.js';

/** 段名常量（外部测试/文档引用）。这些进**系统提示词**，必须是静态内容。 */
export const PROMPT_SECTIONS = {
  // 官方槽位：部署人设前缀。用官方名字 = 替换宿主默认（例如 "You are a coding agent..."），不叠加。
  persona: 'deployment:persona-prefix',
  guide: 'qqbot:guide',
  // 官方槽位：部署人设后缀，排在所有第一方指导之后（近因最好），放静态 QQ 环境事实。
  suffix: 'deployment:persona-suffix',
};

/**
 * 运行时上下文名（外部测试/文档引用）。
 *
 * 2026-11-14：记忆/知识/群友/时间改为 `systemPrompt.context()` —— 宿主把它们物化成
 * **user-role 快照消息**追加在会话末尾，不参与系统提示词前缀。
 * 为什么必须这样：这些内容每轮都变（群友变了 299 次 / 记忆 115 次），放在 system 段里
 * 等于每轮改写缓存前缀——实测 38% 的 step 整段重算，平均多付 47k input tokens；
 * 改成快照后只有变化的那一条消息是新 token（200~800），前缀始终命中。
 */
export const PROMPT_CONTEXTS = {
  memory: 'qqbot:memory',
  knowledge: 'qqbot:knowledge',
  members: 'qqbot:members',
  env: 'qqbot:env',
};

/** 系统提示词里的变量（只保留静态人设/工具指引；动态内容一律走 context）。 */
export const PROMPT_VARIABLES = {
  persona: 'qqbot_persona',
  guide: 'qqbot_guide',
};

/**
 * 段顺序：官方允许外部贡献使用任意有限 order。
 * persona 用官方 0；guide 紧跟工具区（tools:sdk=5000）之后；suffix 用官方 10200。
 * 三个都是静态段——同一配置档下每次渲染必须逐字节相同（缓存命中）。
 */
export const PROMPT_ORDERS = {
  persona: 0,
  guide: 5100,
  suffix: 10200,
};

/**
 * 运行时上下文顺序：宿主自己的 context 占 100~210，我们从 300 起，互不干扰。
 * 记忆 → 知识 → 群友 → 环境（时间放最后，变化最频繁）。
 */
export const PROMPT_CONTEXT_ORDERS = {
  memory: 300,
  knowledge: 310,
  members: 320,
  env: 340,
};

/**
 * 必须遮蔽的宿主段（agent scope 注册同名空文本 → 渲染期丢空段）。
 *
 * 每个都写明理由；遮蔽不存在的段只会多一个空段，无副作用（上游改名只漏不炸）。
 */
export const HOST_SECTION_SHADOWS = Object.freeze([
  // 身份只能是我们的：官方那句 "You are an AI agent powered by DeepSeek Harness." 与"不要自称AI"冲突
  { name: 'harness:identity', order: -1000, reason: '身份重复且与 QQ 人设冲突' },
  // 教模型在回复里写 ![](path)；QQ 收到的是字面量（生图另有出站自动补发兜底）
  { name: 'ui:deliverable-file-references', order: 9000, reason: 'QQ 不渲染 markdown 图片，交付必须走 qqbot_send_file' },
  // 本机 DSH checkout / web GUI：QQ 场景下是错误环境 + 泄露本机路径
  { name: 'harness:source', order: 10000, reason: 'QQ 机器人不在 DSH 检出目录里工作' },
  { name: 'app:web-surface', order: 10100, reason: 'QQ 机器人不在浏览器里' },
]);

/*
 * 为什么这里没有 tool:* / context:file-reference：
 * 这两类段由「挂载到 agent scope 的插件」注册（dsh-tool-fs 等、dsh-file-reference-local
 * 在 agent/created 时注册），和我们同一个 scope layer。同名注册会直接抛
 * "already registered in this scope"，把工具插件一起挂死（2026-11-12 真机探针实测）。
 * 正确做法是**不挂就不出现**：被动能力的插件在首次激活前不挂载（host/agent.js），
 * 散文段自然不存在；只有全局层注册的段才能用空文本遮蔽。
 */

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 当前时间（给 QQ 场景用；宿主 time-context 不在我们的 profile 里）。 */
export function formatNow(date = new Date()) {
  try {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
      + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  } catch {
    return '';
  }
}

/** 当前时区名（QQ 环境事实用；导出给预览复用）。 */
export function timeZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    return 'local';
  }
}

const MOUNT_DISPOSERS = Symbol.for('qqbot-buddy.promptDisposers');

function disposeMounted(agent, logger) {
  const list = agent && Array.isArray(agent[MOUNT_DISPOSERS]) ? agent[MOUNT_DISPOSERS] : null;
  if (!list) return;
  for (const dispose of list) {
    try { if (typeof dispose === 'function') dispose(); } catch (err) {
      logger?.debug?.('释放上一次 prompt 注册失败（忽略）: ' + errText(err));
    }
  }
  try { agent[MOUNT_DISPOSERS] = []; } catch { /* ignore */ }
}

/**
 * 创建 prompt 组装器。
 * state 约定（由 session 层维护，允许热更新）：
 *   personaText() / membersText() / memoryText() / knowledgeText() / settings() / toolsGuide(agent)
 */
export function createPromptComposer({ logger } = {}) {
  return {
    /**
     * 在 agent scope 安装 prompt 段。可重复调用（setup 每次 create/resume 都会跑）：
     * 先释放上一轮注册，避免同名重复注册导致整段丢失。
     * @returns {boolean} 是否安装成功
     */
    mount(agentCtx, agent, state) {
      const service = getService(agentCtx, 'systemPrompt') || (agentCtx && agentCtx.systemPrompt);
      if (!service || typeof service.section !== 'function' || typeof service.variable !== 'function') {
        logger?.warn?.('systemPrompt 服务不可用，跳过 prompt 组装');
        return false;
      }
      // 幂等：同一 agent 反复 mount（create/resume/自愈重挂）时先撤掉上一次
      disposeMounted(agent, logger);

      const disposers = [];
      const read = (fn, fallback = '') => {
        try { const value = fn(); return typeof value === 'string' ? value : fallback; } catch { return fallback; }
      };
      const settings = () => {
        try { return typeof state.settings === 'function' ? state.settings() : state.settings; } catch { return {}; }
      };

      try {
        // ── 变量（每次 assembly 重新求值，但只在配置变化时才会变）──
        const variables = [
          [PROMPT_VARIABLES.persona, () => read(state.personaText)],
          [PROMPT_VARIABLES.guide, () => {
            try { return typeof state.toolsGuide === 'function' ? state.toolsGuide(agent) : ''; } catch (err) {
              logger?.warn?.('生成工具指引失败: ' + errText(err));
              return '';
            }
          }],
        ];
        for (const [name, provider] of variables) {
          const dispose = service.variable(name, provider);
          if (typeof dispose === 'function') disposers.push(dispose);
        }

        // ── 我们的段（静态；占官方槽位 + 自有段）──────────────────
        const sections = [
          [PROMPT_SECTIONS.persona, PROMPT_ORDERS.persona, '{{' + PROMPT_VARIABLES.persona + '}}'],
          [PROMPT_SECTIONS.guide, PROMPT_ORDERS.guide, '{{' + PROMPT_VARIABLES.guide + '}}'],
          // QQ 环境事实放官方后缀槽位：替换部署后缀，且排在第一方指导之后（近因）。
          // 注意：这里**不能**放时间/群友/记忆——那些每轮都变，会把整段前缀缓存打穿。
          [PROMPT_SECTIONS.suffix, PROMPT_ORDERS.suffix,
            '你在 QQ 里和用户对话（不是网页/终端）：用户看不到你的工具调用和本地文件，'
            + '图片/文件必须用 qqbot_send_file 发出。'],
        ];
        for (const [name, order, text] of sections) {
          const dispose = service.section({ name, order, text });
          if (typeof dispose === 'function') disposers.push(dispose);
        }

        // ── 动态内容：user-role 运行时上下文快照（不进缓存前缀）────
        // required: true 保证 persona.suppressRuntimeContext 打开时这些仍然注入——
        // 它们是 QQ 场景的核心事实（这轮该记得什么、跟谁说话、现在几点）。
        const contexts = [
          [PROMPT_CONTEXTS.memory, PROMPT_CONTEXT_ORDERS.memory, () => read(state.memoryText)],
          [PROMPT_CONTEXTS.knowledge, PROMPT_CONTEXT_ORDERS.knowledge, () => read(state.knowledgeText)],
          [PROMPT_CONTEXTS.members, PROMPT_CONTEXT_ORDERS.members, () => read(state.membersText)],
          [PROMPT_CONTEXTS.env, PROMPT_CONTEXT_ORDERS.env, () => '现在是 ' + formatNow() + '（' + timeZoneName() + '）。'],
        ];
        const canContext = typeof service.context === 'function';
        for (const [name, order, provider] of contexts) {
          if (canContext) {
            const dispose = service.context({ name, order, text: provider, required: true });
            if (typeof dispose === 'function') disposers.push(dispose);
            continue;
          }
          // 老宿主没有 context 服务：退回系统段（功能不变，只是缓存不友好）
          const dispose = service.section({ name, order, text: provider });
          if (typeof dispose === 'function') disposers.push(dispose);
        }

        // ── 遮蔽其它 surface 的段（空文本 → 渲染期丢弃）──────────
        for (const shadow of HOST_SECTION_SHADOWS) {
          const dispose = service.section({ name: shadow.name, order: shadow.order, text: '' });
          if (typeof dispose === 'function') disposers.push(dispose);
        }
      } catch (err) {
        // 失败时要撤掉已注册的部分，避免留下"半个 prompt"
        for (const dispose of disposers) {
          try { if (typeof dispose === 'function') dispose(); } catch { /* ignore */ }
        }
        logger?.warn?.('注册 prompt 段失败: ' + errText(err));
        return false;
      }

      // 隐藏宿主运行时上下文（team:identity / 工作目录 / 时间等），chatonly 语义
      try {
        const current = settings();
        if (!current || current.persona?.suppressRuntimeContext !== false) {
          if (typeof service.suppressRuntimeContext === 'function') {
            const dispose = service.suppressRuntimeContext();
            if (typeof dispose === 'function') disposers.push(dispose);
          }
        }
      } catch (err) {
        logger?.warn?.('关闭运行时上下文失败: ' + errText(err));
      }

      try { if (agent) agent[MOUNT_DISPOSERS] = disposers; } catch { /* ignore */ }
      return true;
    },
  };
}

/**
 * 生成"当前 agent 可见工具"的指引文本（给 prompt 用）。
 *
 * 只写「此刻真的能调」的工具；未装载的按能力组列成索引（只有名字，没有 schema），
 * 模型用 qqbot_enable 装载后再调。每次 assembly 求值，但输入只由「配置档 + 已装载状态」决定，
 * 因此正常情况下每次渲染结果一致（提示词前缀稳定 → 缓存命中）。
 *
 * @param {object} agentCtx agent scope
 * @param {object} agent agent
 * @param {{isActive?: (name:string)=>boolean, settings?: object}} [options]
 * @returns {string}
 */
export function toolsGuideFor(agentCtx, agent, options = {}) {
  try {
    const view = agentCtx.tools.view(agent);
    const discovered = collectDiscovered(view);
    const isActive = typeof options.isActive === 'function' ? options.isActive : () => true;
    const tools = [];
    const passive = [];
    for (const item of discovered) {
      if (isActive(item.name)) tools.push(item);
      else passive.push(item);
    }
    const settings = options.settings || {};
    // 索引由 catalog 生成（配置档 + 本机已装插件决定），不依赖本轮被动脚本的临时状态
    return buildToolGuide({
      tools,
      passive,
      settings,
      activeNames: tools.map((item) => item.name),
      knownNames: view && view.knownNames instanceof Set ? view.knownNames : null,
    });
  } catch {
    return '';
  }
}

export default createPromptComposer;
