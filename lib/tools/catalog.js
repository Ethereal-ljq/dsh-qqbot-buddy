/**
 * tools/catalog —— 插件工具与「能力开关」的唯一真相（capability manifest）。
 *
 * 背景（v2 DESIGN §0.3）：工具可见性只走两条官方通道——宿主全局工具用
 * `agentCtx.tools.restrict({allow})` 收窄；本插件自带工具在 agent scope 注册。
 * 「能力开关」同时影响两边：
 *   - 全局工具：host/tools.js 的 CAPABILITY_TOOLS（本文件是唯一来源，host 改为 import）；
 *   - 插件工具：lib/tools/index.js 的 createToolFactory 按同样开关决定注册哪些工具。
 *
 * 本文件纯声明 + 纯函数，无任何 import，便于 host/ 与 tools/ 共用、便于单测。
 */

/**
 * 能力 → 宿主全局工具名（restrictable）。与 core/config/schema.js 的
 * `tools.capabilities` 的 key 对齐（workspace/web/memory/stickers/vision/skills/imagegen）。
 */
export const CAPABILITY_TOOLS = {
  workspace: ['read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'bash', 'pwsh', 'list', 'list_dir'],
  web: ['web_search', 'web_fetch'],
  memory: ['memory_save', 'memory_search', 'memory_read', 'memory_list'],
  stickers: ['qqbot_send_file', 'qqbot_sticker_save'],
  vision: ['qqbot_describe_image', 'read_image'],
  skills: ['skill'],
  imagegen: ['generate_image', 'generate_images', 'edit_image', 'find_inspiration'],
};

/** 未显式配置时的能力默认值（默认拒绝：新能力不自动放开）。 */
export const DEFAULT_CAPABILITIES = {
  workspace: true,
  web: true,
  memory: true,
  stickers: true,
  vision: true,
  skills: false,
  imagegen: false,
};

/**
 * 本插件在 agent scope 注册的工具 → 所依赖的能力。
 * capability=null 表示「与能力开关无关」（有传输层就注册，执行时再校验通道可用性）。
 */
export const PLUGIN_TOOL_CAPABILITIES = Object.freeze({
  qqbot_send_file: 'stickers',
  qqbot_sticker_save: 'stickers',
  qqbot_send_sticker: 'stickers',
  qqbot_describe_image: 'vision',
  qqbot_send_card: null,
  qqbot_quote_reply: null,
  // 数据类工具：memory 跟随 memory 能力；knowledge/members 在 v2 schema 里暂无独立能力开关，
  // 先用 null（装配了对应 store 就注册）。若后续 schema 增加 knowledge/members 能力，改这里即可。
  memory_save: 'memory',
  memory_search: 'memory',
  memory_read: 'memory',
  memory_list: 'memory',
  knowledge_search: null,
  knowledge_read: null,
  knowledge_save: null,
  member_lookup: null,
  member_note: null,
});

/** 插件工具清单（控制台展示 / 测试断言用）。 */
export const PLUGIN_TOOL_NAMES = Object.freeze(Object.keys(PLUGIN_TOOL_CAPABILITIES));

/**
 * 合并能力默认值（settings.tools.capabilities 可能只覆盖部分 key）。
 * @param {object} settings v2 生效设置
 * @returns {Record<string, boolean>}
 */
export function resolveCapabilities(settings) {
  const tools = settings && settings.tools && typeof settings.tools === 'object' ? settings.tools : {};
  const source = tools.capabilities && typeof tools.capabilities === 'object' ? tools.capabilities : {};
  const out = { ...DEFAULT_CAPABILITIES };
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/**
 * 某个插件工具是否应注册（纯函数，便于单测）。
 * 优先级：显式 deny > 显式 allow > 能力开关（无能力归属则放行）。
 * @param {{settings?: object, name: string}} args
 * @returns {boolean}
 */
export function isPluginToolEnabled({ settings, name } = {}) {
  const tools = settings && settings.tools && typeof settings.tools === 'object' ? settings.tools : {};
  const deny = Array.isArray(tools.deny) ? tools.deny : [];
  if (deny.includes(name)) return false;
  const allow = Array.isArray(tools.allow) ? tools.allow : [];
  if (allow.includes(name)) return true;
  const capability = PLUGIN_TOOL_CAPABILITIES[name];
  if (capability === null || capability === undefined) return true;
  return resolveCapabilities(settings)[capability] === true;
}

/**
 * 该能力开关下应注册的插件工具名（factory 装配用）。
 * @param {object} settings
 * @returns {string[]}
 */
export function enabledPluginTools(settings) {
  return PLUGIN_TOOL_NAMES.filter((name) => isPluginToolEnabled({ settings, name }));
}

export default { CAPABILITY_TOOLS, DEFAULT_CAPABILITIES, PLUGIN_TOOL_CAPABILITIES, PLUGIN_TOOL_NAMES, resolveCapabilities, isPluginToolEnabled, enabledPluginTools };
