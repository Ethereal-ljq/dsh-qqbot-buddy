/**
 * host/tool-mounts —— 按「工具策略」（能力开关 + 白名单/黑名单）挂载宿主工具插件到当前 agent scope。
 *
 * 为什么不放进 cordis.patch.yml 的 preset：挂载是**按 agent** 的（不同配置档策略不同），
 * preset 是全局的；v1 已验证 agentCtx.plugin() 这条路可热挂载且随 agent 生命周期释放。
 *
 * 白名单真正生效的关键：能力工具是 agent scope 自己的注册，tools.restrict() 管不到，
 * 所以必须在**挂载阶段**就按 isToolAllowed 精确开关：
 *   - fs 插件支持 read/readImage/write/edit/applyPatch 逐项开关 → 精确；
 *   - web 插件支持 search/fetch 逐项开关 → 精确；
 *   - bash/skill 单工具；fs-search 的 glob/grep 无法拆开（任一放行则两者都挂，注释说明）。
 * 挂载失败只 warn（工具不可用，但不影响对话）。
 */
import { isToolAllowed, tierOf } from '../tools/catalog.js';

const M = {
  fs: '@deepseek-ai/dsh-tool-fs',
  fsSearch: '@deepseek-ai/dsh-tool-fs-search',
  web: '@deepseek-ai/dsh-tool-web',
  skill: '@deepseek-ai/dsh-tool-skill',
  bash: '@deepseek-ai/dsh-tool-bash',
  jobs: '@deepseek-ai/dsh-tool-jobs',
};

/**
 * 能力 → 需要挂载的宿主插件。
 * tools：该模块注册的工具名（用于按策略决定是否挂载/逐项开启）；
 * buildConfig(allowed)：按放行判据生成插件配置（宿主插件自己的开关字段）。
 */
export const CAPABILITY_MOUNTS = {
  workspace: [
    {
      moduleName: M.fs,
      tools: ['read', 'read_image', 'write', 'edit', 'apply_patch'],
      buildConfig: (allowed) => ({
        read: allowed('read'),
        readImage: allowed('read_image'),
        write: allowed('write'),
        edit: allowed('edit'),
        applyPatch: allowed('apply_patch'),
      }),
    },
    {
      // 已知限制：fs-search 的 glob/grep 不能单独开关，任一放行即两者都可见
      moduleName: M.fsSearch,
      tools: ['glob', 'grep'],
      buildConfig: () => ({ sampleOverCapGlobResults: false }),
    },
  ],
  web: [{
    moduleName: M.web,
    tools: ['web_search', 'web_fetch'],
    buildConfig: (allowed) => ({ search: allowed('web_search'), fetch: allowed('web_fetch') }),
  }],
  skills: [{
    moduleName: M.skill,
    tools: ['skill'],
    buildConfig: () => ({ catalogDescriptionMaxLength: 160 }),
  }],
  shell: [
    {
      moduleName: M.bash,
      tools: ['bash', 'pwsh'],
      buildConfig: () => ({ enableRunInBackground: true, promoteOnTimeout: true }),
    },
    // jobs 是 bash 的配套（后台任务查询），随 bash 一起挂
    { moduleName: M.jobs, tools: [], config: {} },
  ],
};

/**
 * 根据生效设置计算挂载计划。
 * @param {object} settings
 * @param {{isAllowed?:Function, isActive?:Function}} [options]
 *   isAllowed 自定义放行判据（默认 isToolAllowed）；
 *   isActive 给定时只装配「有常驻档工具」的模块（preset 装配用，见 activeMountPlan）
 * @returns {Array<{capability:string, moduleName:string, config:object}>}
 */
export function mountPlan(settings, options = {}) {
  const allowed = typeof options.isAllowed === 'function'
    ? options.isAllowed
    : (name) => isToolAllowed({ settings, name });
  const isActive = typeof options.isActive === 'function' ? options.isActive : null;
  const plan = [];
  for (const [capability, mounts] of Object.entries(CAPABILITY_MOUNTS)) {
    for (const mount of mounts) {
      const toolNames = Array.isArray(mount.tools) ? mount.tools : [];
      if (toolNames.length === 0) {
        // 辅助模块（jobs）：只在同能力有主模块被挂载时跟随
        if (!plan.some((item) => item.capability === capability)) continue;
        plan.push({ capability, moduleName: mount.moduleName, config: mount.config || {} });
        continue;
      }
      const hits = toolNames.filter((name) => allowed(name));
      if (hits.length === 0) continue;
      // preset 装配：模块里至少要有一个「常驻档」工具才值得声明；
      // 被动档工具等 qqbot_enable 激活后再动态挂载，避免全量 schema 注入。
      if (isActive && !hits.some((name) => isActive(name))) continue;
      // 能力开关仍是粗粒度总闸：显式 allow 可越过（见 catalog.isToolAllowed）
      const config = typeof mount.buildConfig === 'function'
        ? mount.buildConfig((name) => (toolNames.includes(name) ? allowed(name) : false))
        : (mount.config || {});
      plan.push({ capability, moduleName: mount.moduleName, config });
    }
  }
  return plan;
}

/**
 * 装配期计划：只包含「有常驻档工具」的宿主工具插件（preset 用）。
 * 被动档工具不在装配期声明，等 qqbot_enable 点亮后再动态挂载。
 * @param {object} settings 生效设置
 * @returns {Array<{capability:string, moduleName:string, config:object}>}
 */
export function activeMountPlan(settings) {
  return mountPlan(settings, { isActive: (name) => tierOf(name, settings) === 'active' });
}

/**
 * 挂载本 agent 需要的工具插件。
 *
 * 2026-11-12 两档改造：只有「此刻真的可能需要用」的工具模块才挂——
 * 工具的官方散文段是插件挂载时注册到 **agent scope** 的，不挂就没有散文，
 * 也就不会出现「提示词教模型用一个没声明的工具」。
 * 被动能力在激活时由 refreshToolPolicy 再挂一次（mounted 集合防重复挂载）。
 *
 * @param {{agentCtx: object, settings: object, logger: object, isAllowed?: Function, mounted?: Set<string>}} args
 * @returns {Promise<string[]>} 本次新挂载的 moduleName
 */
export async function mountFeatureTools({ agentCtx, settings, logger, isAllowed, mounted } = {}) {
  if (!agentCtx || typeof agentCtx.plugin !== 'function') return [];
  const done = mounted instanceof Set ? mounted : new Set();
  const mountedNow = [];
  const plan = mountPlan(settings, typeof isAllowed === 'function' ? { isAllowed } : {});
  for (const mount of plan) {
    if (done.has(mount.moduleName)) continue;
    try {
      const namespace = await import(mount.moduleName);
      const fiber = agentCtx.plugin(namespace, mount.config);
      if (fiber && typeof fiber.then === 'function') await fiber;
      done.add(mount.moduleName);
      mountedNow.push(mount.moduleName);
    } catch (err) {
      logger?.warn?.('挂载工具插件失败 ' + mount.moduleName + ': ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  return mountedNow;
}

export default mountFeatureTools;
