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
  // workspace 只放文件类工具；shell 单独一个能力（默认关，避免 QQ 场景误开命令执行）
  workspace: ['read', 'write', 'edit', 'glob', 'grep', 'apply_patch'],
  shell: ['bash', 'pwsh'],
  web: ['web_search', 'web_fetch'],
  memory: ['memory_save', 'memory_search', 'memory_read', 'memory_list'],
  stickers: ['qqbot_send_file', 'qqbot_sticker_save'],
  vision: ['qqbot_describe_image', 'read_image'],
  skills: ['skill'],
  imagegen: ['generate_image', 'generate_images', 'edit_image', 'find_inspiration'],
};

/**
 * 能力边界文案（v1 的 capability.boundary 机制在 v2 重写时漏了）。
 * buildToolGuide 会把「当前可见能力」的边界渲染进工具指引——打开能力即出现，
 * 关掉就不出现。新增能力时在这里补一句，模型才知道"这个能力该怎么用、结果怎么交付"。
 */
export const CAPABILITY_BOUNDARIES = {
  workspace: '能读写当前工作区里的文件（看、改、新建），工作区之外不碰。',
  shell: '能在工作区里执行命令（慎用，可能影响环境）。',
  web: '能联网搜索和抓取网页；需要最新信息时用 web_search / web_fetch。',
  memory: '能读写长期记忆（memory_save 记事实、memory_search 查记忆）；值得长期记住的再存。',
  stickers: '能收藏和发送表情包；发文件/图片用 qqbot_send_file。',
  vision: '能看图片（当前消息图片已直接给到；历史图片用 qqbot_describe_image）。',
  skills: '能加载技能（skill 工具）；遇到特定任务先看有没有对应技能。',
  imagegen: '可以生成或编辑图片（generate_image / edit_image）；生成后必须用 qqbot_send_file 把图片发给对方。',
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
  shell: false,
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

/** 宿主工具名 -> 能力（CAPABILITY_TOOLS 反向索引）。 */
const HOST_TOOL_CAPABILITY = new Map();
for (const [capability, names] of Object.entries(CAPABILITY_TOOLS)) {
  for (const name of names) HOST_TOOL_CAPABILITY.set(name, capability);
}

/** 某个工具所属能力（插件工具优先查插件表；未知工具返回 undefined）。 */
export function capabilityOfTool(name) {
  if (Object.prototype.hasOwnProperty.call(PLUGIN_TOOL_CAPABILITIES, name)) return PLUGIN_TOOL_CAPABILITIES[name];
  return HOST_TOOL_CAPABILITY.get(name);
}

/**
 * 工具策略的唯一判定（插件工具/宿主工具/全局工具共用）。
 *
 * 语义（与设置页文案对齐：allow = 只允许列表内）：
 *  1. deny 列表永远优先（任何模式）；
 *  2. mode=allow **且 allow 非空** → 只放行 allow 列表内的工具（显式放行可越过能力开关）；
 *  3. mode=allow 且 allow 为空 → 退回能力开关（默认配置的兼容行为，避免"什么都没了"）；
 *  4. mode=deny → 除 deny 外都放行，但仍受能力开关约束；
 *  5. 无能力归属的工具（MCP/第三方）不受能力开关约束。
 * @param {{settings?: object, name: string}} args
 * @returns {boolean}
 */
export function isToolAllowed({ settings, name } = {}) {
  const tools = settings && settings.tools && typeof settings.tools === 'object' ? settings.tools : {};
  const deny = Array.isArray(tools.deny) ? tools.deny : [];
  if (deny.includes(name)) return false;
  const allow = Array.isArray(tools.allow) ? tools.allow.filter((item) => typeof item === 'string' && item !== '') : [];
  const mode = tools.mode === 'deny' ? 'deny' : 'allow';
  if (mode === 'allow' && allow.length > 0) return allow.includes(name);
  const capability = capabilityOfTool(name);
  if (capability === undefined || capability === null) return true;
  return resolveCapabilities(settings)[capability] === true;
}

/** 某个插件工具是否应注册（兼容旧名；实际走 isToolAllowed）。 */
export function isPluginToolEnabled({ settings, name } = {}) {
  return isToolAllowed({ settings, name });
}

/**
 * 该能力开关下应注册的插件工具名（factory 装配用）。
 * @param {object} settings
 * @returns {string[]}
 */
export function enabledPluginTools(settings) {
  return PLUGIN_TOOL_NAMES.filter((name) => isPluginToolEnabled({ settings, name }));
}

export default {
  CAPABILITY_TOOLS, CAPABILITY_BOUNDARIES, DEFAULT_CAPABILITIES, PLUGIN_TOOL_CAPABILITIES, PLUGIN_TOOL_NAMES,
  resolveCapabilities, capabilityOfTool, isToolAllowed, isPluginToolEnabled, enabledPluginTools,
};
