/**
 * host/presets —— 装配期：按配置档的能力组合注册 agent preset（2026-11-14 渐进披露）。
 *
 * 为什么要把「常驻工具集」放进 preset：
 *   - preset 的 composition 对一个 live agent 是**稳定**的（官方语义：new agents 才会用新定义），
 *     所以声明面不会每轮变化 → 提示词前缀稳定（缓存命中）、模型记忆与声明一致（不再出现幻影工具）；
 *   - session 里记录 preset id，重启/恢复按同一定义重建，不需要把激活状态持久化；
 *   - 工具可见性从「运行时命令式收放」变成「声明式组合」，控制台/排障都看得见。
 *
 * 失败处理：preset 服务不可用、注册失败、或 mount 失败时一律返回空 id，
 * 由 host/agent.js 回落到原来的动态挂载（mountFeatureTools），保证机器人不会因为新机制不可用而掉工具。
 */
import { getService, errText } from './services.js';
import { activeMountPlan } from './tool-mounts.js';

const CACHE = Symbol.for('qqbot-buddy.presetCache');
const OWN = Symbol.for('qqbot-buddy.ownPresetIds');
const LIFECYCLE = Symbol.for('qqbot-buddy.presetLifecycle');
const NO_SERVICE_WARNED = Symbol.for('qqbot-buddy.presetNoServiceWarned');

/** 压缩策略（与 cordis.patch.yml 里的 preset-qqbot-buddy 保持一致）。 */
const COMPACTION_ROWS = Object.freeze([
  {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
    ],
  },
]);

/** 模块名 → 稳妥的 id 片段（'@deepseek-ai/dsh-tool-fs-search' → 'fs-search'）。 */
function moduleShort(moduleName) {
  const base = String(moduleName || '').split('/').pop() || 'tool';
  return base.replace(/^dsh-tool-/, '').replace(/^dsh-/, '') || 'tool';
}

/**
 * 该设置了下的装配 key：只由「要挂哪些宿主工具插件」决定（与 per-peer 无关）。
 * 同一 key 的配置档共用同一个 preset。
 * @param {object} settings 生效设置
 * @returns {string}
 */
export function presetKeyFor(settings) {
  let plan = [];
  try { plan = activeMountPlan(settings); } catch { plan = []; }
  const parts = [...new Set(plan.map((item) => moduleShort(item.moduleName)))].sort();
  const key = parts.join('-').replace(/[^a-z0-9-]+/gi, '').slice(0, 60);
  return key === '' ? 'core' : key;
}

/** preset id（带命名空间前缀，便于识别是我们注册的）。 */
export function presetIdFor(settings) {
  return 'qqbot-buddy-' + presetKeyFor(settings);
}

/** @returns {Map<string, any>} */
function cacheOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return new Map();
  if (!(ctx[CACHE] instanceof Map)) {
    try { ctx[CACHE] = new Map(); } catch { return new Map(); }
  }
  return ctx[CACHE];
}

/** 我们注册过的 preset id 集合。 */
export function ownPresetIds(ctx) {
  if (!ctx || typeof ctx !== 'object') return new Set();
  if (!(ctx[OWN] instanceof Set)) {
    try { ctx[OWN] = new Set(); } catch { return new Set(); }
  }
  return ctx[OWN];
}

/** 某个 id 是否是我们注册的（决定要不要回落到动态挂载）。 */
export function isOwnPreset(ctx, id) {
  return typeof id === 'string' && ownPresetIds(ctx).has(id);
}

/** 把注册 disposer 绑到插件生命周期上（只绑一次）。 */
function bindLifecycle(ctx) {
  if (!ctx || typeof ctx !== 'object' || ctx[LIFECYCLE]) return;
  try { ctx[LIFECYCLE] = true; } catch { return; }
  if (typeof ctx.effect !== 'function') return;
  try {
    ctx.effect(() => () => {
      const cache = ctx[CACHE];
      if (!(cache instanceof Map)) return;
      for (const entry of cache.values()) {
        try { if (entry && typeof entry.dispose === 'function') entry.dispose(); } catch { /* ignore */ }
      }
      cache.clear();
      try { ctx[OWN] = new Set(); } catch { /* ignore */ }
    }, 'qqbot-buddy.presets');
  } catch { /* effect 不可用就不绑 */ }
}

/**
 * 生成一个 preset 定义（纯函数，便于单测）。
 * @param {object} settings
 * @param {string} id
 * @returns {{id: string, name: string, description: string, order: number, plugins: object[]}}
 */
export function presetDefinitionFor(settings, id = presetIdFor(settings)) {
  // 只装配常驻档：被动档工具不声明，等 qqbot_enable 点亮后再动态挂载
  const plan = activeMountPlan(settings);
  const plugins = [];
  for (const row of COMPACTION_ROWS) plugins.push(JSON.parse(JSON.stringify(row)));
  plan.forEach((item, index) => {
    if (!item || typeof item.moduleName !== 'string' || item.moduleName === '') return;
    plugins.push({
      id: 'tool-' + index + '-' + moduleShort(item.moduleName),
      name: item.moduleName,
      config: item.config && typeof item.config === 'object' ? item.config : {},
    });
  });
  return {
    id,
    name: 'QQ 机器人 · ' + presetKeyFor(settings),
    description: 'dsh-qqbot-buddy 按配置档能力组合的常驻工具集（装配期决定，运行期不变）',
    order: 12,
    plugins,
  };
}

/**
 * 确保该设置对应的 preset 已注册。
 *
 * 幂等：同一 ctx 下同一 key 只注册一次；并发调用复用同一个 Promise。
 *
 * @param {{ctx: object, settings: object, logger?: object}} args
 * @returns {Promise<{id: string, own: boolean, reason?: string}>} id 为空表示应回落动态挂载
 */
export async function ensurePreset({ ctx, settings, logger } = {}) {
  const service = getService(ctx, 'agentPresets');
  if (!service || typeof service.register !== 'function') {
    // 只告警一次：没有 preset 服务时回落动态挂载（老路径），功能不受影响
    if (!ctx || !ctx[NO_SERVICE_WARNED]) {
      try { if (ctx) ctx[NO_SERVICE_WARNED] = true; } catch { /* ignore */ }
      logger?.warn?.('agentPresets 服务不可用，工具装配回落动态挂载（不影响功能）');
    }
    return { id: '', own: false, reason: 'agentPresets 服务不可用' };
  }
  bindLifecycle(ctx);
  const cache = cacheOf(ctx);
  const id = presetIdFor(settings);
  const hit = cache.get(id);
  if (hit && hit.pending) return hit.pending;
  if (hit && hit.dispose !== undefined) return { id, own: true };

  const definition = presetDefinitionFor(settings, id);
  const pending = (async () => {
    try {
      const dispose = await service.register(definition);
      cache.set(id, { dispose });
      ownPresetIds(ctx).add(id);
      logger?.debug?.('已注册 agent preset: ' + id + '（' + definition.plugins.length + ' 行）');
      return { id, own: true };
    } catch (err) {
      cache.delete(id);
      logger?.warn?.('注册 agent preset 失败（回落动态挂载）: ' + errText(err));
      return { id: '', own: false, reason: errText(err) };
    }
  })();
  cache.set(id, { pending });
  return pending;
}

export default { presetKeyFor, presetIdFor, presetDefinitionFor, ensurePreset, isOwnPreset, ownPresetIds };
