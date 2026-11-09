/**
 * host/tool-mounts —— 按「能力开关」把宿主工具插件挂载到当前 agent scope。
 *
 * 为什么不放进 cordis.patch.yml 的 preset：挂载是**按 agent** 的（不同配置档能力不同），
 * preset 是全局的；v1 已验证 agentCtx.plugin() 这条路可热挂载且随 agent 生命周期释放。
 *
 * 挂载失败只 warn（工具不可用，但不影响对话）。
 */
const M = {
  fs: '@deepseek-ai/dsh-tool-fs',
  fsSearch: '@deepseek-ai/dsh-tool-fs-search',
  web: '@deepseek-ai/dsh-tool-web',
  skill: '@deepseek-ai/dsh-tool-skill',
  bash: '@deepseek-ai/dsh-tool-bash',
  jobs: '@deepseek-ai/dsh-tool-jobs',
};

/** 能力 → 需要挂载的宿主插件（与 lib/tools/catalog.js 的 CAPABILITY_TOOLS 对齐）。 */
export const CAPABILITY_MOUNTS = {
  workspace: [
    { moduleName: M.fs, config: { read: true, readImage: true, write: true, edit: true } },
    { moduleName: M.fsSearch, config: { sampleOverCapGlobResults: false } },
  ],
  web: [{ moduleName: M.web, config: {} }],
  skills: [{ moduleName: M.skill, config: { catalogDescriptionMaxLength: 160 } }],
  shell: [
    { moduleName: M.bash, config: { enableRunInBackground: true, promoteOnTimeout: true } },
    { moduleName: M.jobs, config: {} },
  ],
};

/** 根据生效设置计算挂载计划。 */
export function mountPlan(settings) {
  const caps = (settings && settings.tools && settings.tools.capabilities) || {};
  const defaults = { workspace: true, web: true, memory: true, stickers: true, vision: true, skills: false, imagegen: false, shell: false };
  const merged = { ...defaults, ...caps };
  const plan = [];
  for (const [capability, mounts] of Object.entries(CAPABILITY_MOUNTS)) {
    if (merged[capability] !== true) continue;
    for (const mount of mounts) plan.push({ capability, ...mount });
  }
  return plan;
}

/**
 * 挂载本 agent 需要的工具插件。
 * @param {{agentCtx: object, settings: object, logger: object}} args
 * @returns {Promise<string[]>} 已挂载的 moduleName
 */
export async function mountFeatureTools({ agentCtx, settings, logger } = {}) {
  if (!agentCtx || typeof agentCtx.plugin !== 'function') return [];
  const mounted = [];
  for (const mount of mountPlan(settings)) {
    try {
      const namespace = await import(mount.moduleName);
      const fiber = agentCtx.plugin(namespace, mount.config);
      if (fiber && typeof fiber.then === 'function') await fiber;
      mounted.push(mount.moduleName);
    } catch (err) {
      logger?.warn?.('挂载工具插件失败 ' + mount.moduleName + ': ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  return mounted;
}

export default mountFeatureTools;
