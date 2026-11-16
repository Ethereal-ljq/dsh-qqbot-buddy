/**
 * tools/catalog —— 插件工具与「能力开关」的唯一真相（capability manifest）。
 *
 * 背景（v2 DESIGN §0.3）：工具可见性只走两条官方通道——宿主全局工具用
 * `agentCtx.tools.restrict({allow})` 收窄；本插件自带工具在 agent scope 注册。
 * 「能力开关」同时影响两边：
 *   - 全局工具：host/tools.js 的 CAPABILITY_TOOLS（本文件是唯一来源，host 改为 import）；
 *   - 插件工具：lib/tools/index.js 的 createToolFactory 按同样开关决定注册哪些工具。
 *
 * 本文件纯声明 + 纯函数（只 import 同样纯声明的 aliases.js），便于 host/ 与 tools/ 共用、便于单测。
 */
import { TOOL_ALIASES } from './aliases.js';

/**
 * 能力 → 宿主全局工具名（restrictable）。与 core/config/schema.js 的
 * `tools.capabilities` 的 key 对齐（workspace/web/memory/messages/stickers/vision/voice/skills/imagegen/shell）。
 */
export const CAPABILITY_TOOLS = {
  // workspace 只放文件类工具；shell 单独一个能力（默认关，避免 QQ 场景误开命令执行）
  workspace: ['read', 'write', 'edit', 'glob', 'grep', 'apply_patch'],
  shell: ['bash', 'pwsh'],
  web: ['web_search', 'web_fetch'],
  memory: ['memory_save', 'memory_update', 'memory_search', 'memory_read', 'memory_list'],
  // 消息流水检索：关掉 messages 能力后，模型也不该再看到这两个工具
  messages: ['chat_history_search', 'chat_history_recent'],
  stickers: ['qqbot_send_file', 'qqbot_sticker_save'],
  vision: ['qqbot_describe_image', 'read_image'],
  // 语音（TTS）没有宿主全局工具：能力开关只控制插件工具 qqbot_speak（见下方插件工具表）
  voice: [],
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
  memory: '能读写长期记忆（memory_save 记新事实、memory_update 改旧记忆、memory_search 查记忆）；状态变化时改旧记忆，不要叠加新状态。',
  stickers: '能收藏和发送表情包；发文件/图片用 qqbot_send_file。',
  vision: '能看图片（当前消息图片已直接给到；历史图片用 qqbot_describe_image）。',
  voice: '能朗读文字：用户想「听」时用 qqbot_speak 合成语音发送；只适合短句，长文会按配置上限截断。',
  skills: '能加载技能（skill 工具）；遇到特定任务先看有没有对应技能。',
  imagegen: '可以生成或编辑图片（generate_image / edit_image）；生成后必须用 qqbot_send_file 把图片发给对方。',
};

/**
 * 工具「用法卡」（2026-11-14 渐进披露）：
 * 按需装载的工具默认不在请求里声明（零 schema 成本），模型只能从索引知道它存在。
 * 装载成功时把这张卡随工具结果返回，模型下一步就能一次调对，不用靠猜参数。
 *
 * 约束：签名必须与真实 parameters 一致（test/tools-catalog.test.js 断言 key 集合），
 * 文案只写「怎么调、注意什么」，不重复 capability 边界里已有的能力描述。
 */
export const TOOL_USAGE = Object.freeze({
  // 生图 / 改图
  generate_image: { sig: 'prompt', hint: '生成图片；结果只进模型上下文，必须再用 qqbot_send_file 发出' },
  generate_images: { sig: 'prompts[]', hint: '一次生成多张，按顺序返回' },
  edit_image: { sig: 'prompt, source_path?', hint: '改图；原图用 source_path 或附件 id 指定' },
  find_inspiration: { sig: 'query?, category?', hint: '查现成的绘图提示词模板' },
  // 语音
  qqbot_speak: { sig: 'text', hint: '合成语音发送；只适合一两句短句' },
  qqbot_send_voice: { sig: 'text', hint: 'qqbot_speak 的兼容别名' },
  // 卡片 / 看图
  qqbot_send_card: { sig: 'title, description, url', hint: '发送图文卡片' },
  qqbot_describe_image: { sig: 'image', hint: '看历史图片或精读某张图' },
  read_image: { sig: 'file_path', hint: '读工作区里的图片文件' },
  // 文件读写
  read: { sig: 'file_path, offset?, limit?', hint: '读文本文件（带行号）' },
  write: { sig: 'file_path, content', hint: '整份覆盖写' },
  edit: { sig: 'file_path, old_string, new_string', hint: '精确替换片段' },
  apply_patch: { sig: 'input', hint: '打补丁（patch 文本）' },
  glob: { sig: 'pattern, path?', hint: '按路径模式找文件' },
  grep: { sig: 'pattern, path?, include?', hint: '搜文件内容' },
  // 命令 / 后台任务
  bash: { sig: 'description, command', hint: '在工作区执行命令' },
  pwsh: { sig: 'description, command', hint: '在 PowerShell 执行命令' },
  job_list: { sig: '', hint: '列出后台任务' },
  job_output: { sig: 'job_id, wait?', hint: '读后台任务输出' },
  job_kill: { sig: 'job_id', hint: '停掉后台任务' },
  // 画布
  view_canvas: { sig: '', hint: '查看画布上选中的内容' },
  canvas_state: { sig: '', hint: '查看画布上有什么、当前选中什么' },
  // 长期记忆
  memory_update: { sig: 'id, content?, kind?, tags?', hint: '改已有记忆（状态变化用这个，别新增）' },
  // 知识库写入
  knowledge_save: { sig: 'title, content', hint: '把内容写进知识库' },
});

/** 某个工具的用法卡（无登记返回空字符串）。 */
export function toolUsageOf(name) {
  const item = TOOL_USAGE[typeof name === 'string' ? name : ''];
  if (!item) return '';
  return (item.sig ? name + '(' + item.sig + ')' : name + '()') + ' — ' + item.hint;
}

/** 未显式配置时的能力默认值（默认拒绝：新能力不自动放开）。 */
export const DEFAULT_CAPABILITIES = {
  workspace: true,
  web: true,
  memory: true,
  messages: true,
  stickers: true,
  vision: true,
  // 语音合成默认关闭：会产生费用/文件落盘，按需在设置页开启
  voice: false,
  skills: false,
  imagegen: false,
  shell: false,
};

/**
 * 工具档位（2026-11-12 提示词瘦身）：
 *   active  —— 日常对话随时可能用，常驻声明（付 schema 成本）；
 *   passive —— 用户点名/明确任务才用，默认不声明，由「激活器」按需点亮
 *              （插件工具走 tools.register 的 when；宿主工具走 restrict 重放）。
 *
 * 唯一真相在这里。新增工具必须登记：
 *   - 插件工具由 test/tools-catalog.test.js 强制断言「每个 PLUGIN_TOOL_NAMES 都有档位」；
 *   - 宿主工具（含未来官方新增的）未登记时按 DEFAULT_TOOL_TIER 处理，控制台会标「未分类」。
 */
export const DEFAULT_TOOL_TIER = 'active';

/** 工具名（含兼容别名）→ 档位。 */
export const TOOL_TIERS = Object.freeze({
  // ── 主动：回复链路里随时会用到 ─────────────────────────────
  qqbot_send_file: 'active',
  qqbot_quote_reply: 'active',
  qqbot_send_sticker: 'active',
  qqbot_sticker_save: 'active',
  memory_save: 'active',
  memory_update: 'active',
  memory_search: 'active',
  memory_read: 'active',
  memory_list: 'active',
  member_lookup: 'active',
  member_note: 'active',
  knowledge_search: 'active',
  knowledge_read: 'active',
  chat_history_search: 'active',
  chat_history_recent: 'active',
  skill: 'active',
  web_search: 'active',
  web_fetch: 'active',
  qqbot_enable: 'active',
  // ── 被动：默认不声明，按需点亮 ─────────────────────────────
  qqbot_send_card: 'passive',
  qqbot_describe_image: 'passive',
  qqbot_speak: 'passive',
  knowledge_save: 'passive',
  generate_image: 'passive',
  generate_images: 'passive',
  edit_image: 'passive',
  find_inspiration: 'passive',
  read: 'passive',
  write: 'passive',
  edit: 'passive',
  apply_patch: 'passive',
  glob: 'passive',
  grep: 'passive',
  read_image: 'passive',
  bash: 'passive',
  pwsh: 'passive',
  job_list: 'passive',
  job_output: 'passive',
  job_kill: 'passive',
  view_canvas: 'passive',
  canvas_state: 'passive',
  working_directory: 'passive',
  // 兼容别名（lib/tools/aliases.js）与正名同档
  qqbot_send_voice: 'passive',
  qqbot_send_image: 'active',
  qqbot_send_emote: 'active',
  qqbot_save_emote: 'active',
});

/**
 * 被动工具的激活分组：一个组 = 一组工具 + 一组触发词 + 一条给模型看的说明。
 * 触发词用「包含匹配」（中文按子串），命中即本轮整组点亮。
 * capability 表示该组对应的能力开关（null = 没有独立能力开关）。
 */
export const ACTIVATION_GROUPS = Object.freeze({
  imagegen: {
    label: '生图/改图',
    capability: 'imagegen',
    tools: ['generate_image', 'generate_images', 'edit_image', 'find_inspiration'],
    triggers: ['画一', '画个', '画张', '画幅', '画图', '生图', '生成图', '生成一', '一张图', '来一张', '来张图', '出张图', '改图', '修图', 'p图', 'P图', '作图', '配图', '重绘'],
  },
  voice: {
    label: '语音',
    capability: 'voice',
    tools: ['qqbot_speak', 'qqbot_send_voice'],
    triggers: ['语音', '朗读', '念一下', '念给', '唱一', '唱首', '唱个', '听你说', '用声音'],
  },
  card: {
    label: '图文卡片',
    capability: null,
    tools: ['qqbot_send_card'],
    triggers: ['卡片', '海报', '名片'],
  },
  vision: {
    label: '看图',
    capability: 'vision',
    tools: ['qqbot_describe_image', 'read_image'],
    triggers: ['这张图', '图里', '图中', '看看图', '识别图', '截图里', '图片内容', '图上是'],
  },
  workspace: {
    label: '文件读写',
    capability: 'workspace',
    tools: ['read', 'write', 'edit', 'apply_patch', 'glob', 'grep'],
    triggers: ['文件', '目录', '代码', '脚本', '仓库', '路径', '日志'],
  },
  shell: {
    label: '命令执行',
    capability: 'shell',
    tools: ['bash', 'pwsh'],
    triggers: ['命令', '终端', '跑一下', '执行一下', '装个', '环境变量'],
  },
  jobs: {
    label: '后台任务',
    capability: null,
    tools: ['job_list', 'job_output', 'job_kill'],
    triggers: ['后台', '跑完了吗', '跑完没', '进度'],
  },
  canvas: {
    label: '画布',
    capability: null,
    tools: ['view_canvas', 'canvas_state'],
    triggers: ['画布', '白板'],
  },
  knowledge_write: {
    label: '知识库写入',
    capability: null,
    tools: ['knowledge_save'],
    triggers: ['存进知识库', '记到知识库', '加到知识库', '收录进'],
  },
});

/** 工具名（含别名）→ 激活分组 id。 */
const TOOL_GROUP = new Map();
for (const [groupId, group] of Object.entries(ACTIVATION_GROUPS)) {
  for (const name of group.tools || []) TOOL_GROUP.set(name, groupId);
}

/** 某个工具所属的激活分组（别名按正名归属；无分组返回 undefined）。 */
export function groupOfTool(name) {
  if (typeof name !== 'string' || name === '') return undefined;
  if (TOOL_GROUP.has(name)) return TOOL_GROUP.get(name);
  const target = TOOL_ALIASES[name];
  return typeof target === 'string' ? TOOL_GROUP.get(target) : undefined;
}

/** 某个分组下的全部工具名（含别名）。 */
export function toolsOfGroup(groupId) {
  const names = new Set();
  const group = ACTIVATION_GROUPS[groupId];
  if (!group) return [];
  for (const name of group.tools) {
    names.add(name);
    for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
      if (target === name) names.add(alias);
    }
  }
  return [...names];
}

/**
 * 工具档位（可被 Profile 覆盖）：settings.tools.tiers 里可以写工具名或分组 id。
 * @param {{settings?: object, name: string}} args
 * @returns {'active'|'passive'}
 */
export function tierOf(name, settings) {
  if (typeof name !== 'string' || name === '') return DEFAULT_TOOL_TIER;
  const tools = settings && settings.tools && typeof settings.tools === 'object' ? settings.tools : {};
  const overrides = tools.tiers && typeof tools.tiers === 'object' ? tools.tiers : {};
  const read = (key) => (typeof overrides[key] === 'string' ? String(overrides[key]).trim().toLowerCase() : '');
  const direct = read(name);
  if (direct === 'active' || direct === 'passive') return direct;
  const group = groupOfTool(name);
  if (group !== undefined) {
    const byGroup = read(group);
    if (byGroup === 'active' || byGroup === 'passive') return byGroup;
  }
  // 也允许按「能力」覆盖（workspace/shell/web/memory/stickers/…），与设置页的措辞一致
  const capability = capabilityOfTool(name);
  if (typeof capability === 'string' && capability !== '') {
    const byCapability = read(capability);
    if (byCapability === 'active' || byCapability === 'passive') return byCapability;
  }
  const base = TOOL_TIERS[name] ?? (TOOL_ALIASES[name] ? TOOL_TIERS[TOOL_ALIASES[name]] : undefined);
  return base === 'passive' ? 'passive' : base === 'active' ? 'active' : DEFAULT_TOOL_TIER;
}

/** 工具是否在登记表里（控制台「未分类」标记用）。 */
export function isClassifiedTier(name) {
  if (typeof name !== 'string' || name === '') return false;
  return Object.prototype.hasOwnProperty.call(TOOL_TIERS, name)
    || (TOOL_ALIASES[name] !== undefined && Object.prototype.hasOwnProperty.call(TOOL_TIERS, TOOL_ALIASES[name]));
}

/** 该设置下「常驻」的工具名（用于提示词过滤/控制台展示）。 */
export function activeTierTools(settings) {
  const out = [];
  for (const name of new Set([...Object.keys(TOOL_TIERS), ...PLUGIN_TOOL_NAMES])) {
    if (tierOf(name, settings) === 'active') out.push(name);
  }
  return out.sort();
}

/**
 * 本插件在 agent scope 注册的工具 → 所依赖的能力。
 * capability=null 表示「与能力开关无关」（有传输层就注册，执行时再校验通道可用性）。
 */
export const PLUGIN_TOOL_CAPABILITIES = Object.freeze({
  qqbot_send_file: 'stickers',
  qqbot_sticker_save: 'stickers',
  qqbot_send_sticker: 'stickers',
  qqbot_describe_image: 'vision',
  qqbot_speak: 'voice',
  // 兼容别名（lib/tools/aliases.js）：模型按兄弟工具命名习惯猜的名字。能力归属与正名一致，
  // 这样能力开关/allow/deny 对别名同样生效。
  qqbot_send_voice: 'voice',
  qqbot_send_image: 'stickers',
  qqbot_send_emote: 'stickers',
  qqbot_save_emote: 'stickers',
  qqbot_send_card: null,
  qqbot_quote_reply: null,
  // 元工具：点亮被动能力。本身必须常驻，否则"要开锁先得有钥匙"。
  qqbot_enable: null,
  // 数据类工具：memory 跟随 memory 能力；knowledge/members 在 v2 schema 里暂无独立能力开关，
  // 先用 null（装配了对应 store 就注册）。若后续 schema 增加 knowledge/members 能力，改这里即可。
  memory_save: 'memory',
  memory_update: 'memory',
  memory_search: 'memory',
  memory_read: 'memory',
  memory_list: 'memory',
  knowledge_search: null,
  knowledge_read: null,
  knowledge_save: null,
  member_lookup: null,
  member_note: null,
  // 消息流水检索：跟着 messages.enabled 走，关闭记录时这两个工具也不注册
  chat_history_search: 'messages',
  chat_history_recent: 'messages',
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
 *  5. 无能力归属的工具（MCP/第三方）不受能力开关约束；
 *  6. 兼容别名（lib/tools/aliases.js）与正名共享同一权限：allow/deny 命中任意一方都算命中，
 *     否则用户显式白名单里只写了正名时，别名永远不可用（线上就踩到了）。
 * @param {{settings?: object, name: string}} args
 * @returns {boolean}
 */
export function isToolAllowed({ settings, name } = {}) {
  const tools = settings && settings.tools && typeof settings.tools === 'object' ? settings.tools : {};
  const deny = Array.isArray(tools.deny) ? tools.deny : [];
  const relatedNames = relatedToolNames(name);
  if (relatedNames.some((item) => deny.includes(item))) return false;
  const allow = Array.isArray(tools.allow) ? tools.allow.filter((item) => typeof item === 'string' && item !== '') : [];
  const mode = tools.mode === 'deny' ? 'deny' : 'allow';
  if (mode === 'allow' && allow.length > 0) return relatedNames.some((item) => allow.includes(item));
  const capability = capabilityOfTool(name);
  if (capability === undefined || capability === null) return true;
  return resolveCapabilities(settings)[capability] === true;
}

/**
 * 与某个工具名共享权限的「正名 ∪ 别名」集合（普通工具只有自己）。
 * @param {string} name
 * @returns {string[]}
 */
export function relatedToolNames(name) {
  const target = typeof name === 'string' ? name : '';
  if (target === '') return [];
  const aliasTarget = TOOL_ALIASES[target];
  if (typeof aliasTarget === 'string' && aliasTarget !== '') return [target, aliasTarget];
  const aliases = Object.keys(TOOL_ALIASES).filter((alias) => TOOL_ALIASES[alias] === target);
  return [target, ...aliases];
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
  TOOL_TIERS, DEFAULT_TOOL_TIER, ACTIVATION_GROUPS,
  tierOf, groupOfTool, toolsOfGroup, isClassifiedTier, activeTierTools,
};
