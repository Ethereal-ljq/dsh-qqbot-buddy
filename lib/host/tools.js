/**
 * host/tools —— 工具发现与策略（v2 契约：只用官方通道，不监听 assemble 改数组）。
 *
 * 发现：ctx.tools.view(agent) 返回 { visible(Map name→definition), knownNames, restrictableNames }。
 *   - restrictableNames 里的名字属于"全局工具"，可以用 tools.restrict({allow}) 收窄；
 *   - agent scope 自己注册的工具（本插件的 qqbot_*）不受 restrict 影响，会在 visible 里出现。
 * 策略：Profile 级 settings.tools = { mode:'allow'|'deny', allow:[], deny:[], capabilities:{} }，
 *   能力开关再映射到一组工具名；最终把"应可见"的全局工具名交给 restrict。
 */
import { errText } from './services.js';
// 能力 → 工具名映射的唯一真相在 lib/tools/catalog.js（与插件作用域工具共用，避免两处漂移）
import { CAPABILITY_TOOLS, CAPABILITY_BOUNDARIES, DEFAULT_CAPABILITIES } from '../tools/catalog.js';

export { CAPABILITY_TOOLS, CAPABILITY_BOUNDARIES, DEFAULT_CAPABILITIES };

function uniq(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item === 'string' && item !== '' && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * 由宿主视图构造发现清单（纯函数，便于单测）。
 * @param {{visible: Map<string, any>, restrictableNames?: Set<string>}} view
 * @param {{botTools?: string[]}} [options] 本插件注册的作用域工具名
 * @returns {Array<{name:string, description:string, restrictable:boolean, source:string}>}
 */
export function collectDiscovered(view, options = {}) {
  const visible = view && view.visible instanceof Map ? view.visible : new Map();
  const restrictable = view && view.restrictableNames instanceof Set ? view.restrictableNames : new Set();
  const botTools = new Set(Array.isArray(options.botTools) ? options.botTools : []);
  const out = [];
  for (const [name, definition] of visible.entries()) {
    const description = definition && typeof definition.description === 'string' ? definition.description : '';
    const isRestrictable = restrictable.has(name);
    out.push({
      name,
      description: description.slice(0, 300),
      restrictable: isRestrictable,
      source: botTools.has(name) || name.startsWith('qqbot_') ? 'qqbot'
        : (name.startsWith('mcp__') || name.includes('__') ? 'mcp' : (isRestrictable ? 'host' : 'plugin')),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 计算策略：哪些全局工具应可见（纯函数）。
 * @param {{settings: object, discovered: Array<{name:string,restrictable:boolean}>, presetTools?: string[]}} args
 * @returns {{mode:string, allow:string[], deny:string[], allowSet:Set<string>}}
 */
export function computePolicy({ settings, discovered, presetTools = [] }) {
  const toolsSettings = (settings && settings.tools) || {};
  const mode = toolsSettings.mode === 'deny' ? 'deny' : 'allow';
  const capabilities = { ...DEFAULT_CAPABILITIES, ...(toolsSettings.capabilities || {}) };
  const explicitAllow = uniq(toolsSettings.allow);
  const explicitDeny = uniq(toolsSettings.deny);
  const restrictable = new Set((Array.isArray(discovered) ? discovered : []).filter((item) => item.restrictable).map((item) => item.name));

  // 能力放行的工具集合（只保留宿主真实存在的）
  const capabilityAllow = [];
  for (const [capability, names] of Object.entries(CAPABILITY_TOOLS)) {
    if (capabilities[capability] !== true) continue;
    for (const name of names) if (restrictable.has(name)) capabilityAllow.push(name);
  }
  // 直接以显式列表操作的全局工具（allow 模式）
  for (const name of explicitAllow) if (restrictable.has(name)) capabilityAllow.push(name);

  let allow = [];
  if (mode === 'allow') {
    allow = uniq(capabilityAllow);
  } else {
    // deny 模式：先全放行再剔除；restrict 只支持 allow/deny 二选一，统一转成 allow 列表
    allow = [...restrictable].filter((name) => !explicitDeny.includes(name));
    // deny 模式下能力开关也生效：关掉的能力整组剔除
    for (const [capability, names] of Object.entries(CAPABILITY_TOOLS)) {
      if (capabilities[capability] === true) continue;
      allow = allow.filter((name) => !names.includes(name));
    }
  }
  // 显式 deny 永远优先
  allow = allow.filter((name) => !explicitDeny.includes(name));
  return { mode, allow, deny: explicitDeny, allowSet: new Set(allow) };
}

/**
 * 生成写进 system prompt 的工具指引（纯函数）。
 * 只列可见工具里"对 QQ 场景有意义"的部分，并给出使用约定。
 */
export function buildToolGuide(discovered) {
  const names = new Set((Array.isArray(discovered) ? discovered : []).map((item) => item.name));
  const lines = [];
  const qq = ['qqbot_send_file', 'qqbot_send_card', 'qqbot_describe_image', 'qqbot_sticker_save', 'memory_save', 'memory_search', 'memory_read', 'memory_list']
    .filter((name) => names.has(name));
  if (qq.length > 0) lines.push('你可以使用这些工具完成 QQ 侧动作：' + qq.join('、') + '。');
  if (names.has('qqbot_send_file')) lines.push('要发图片/文件时用 qqbot_send_file；表情包用 qqbot_sticker_save 收藏后可直接发送。');
  if (names.has('qqbot_send_card')) lines.push('需要图文卡片时用 qqbot_send_card。');
  if (names.has('qqbot_describe_image')) lines.push('看历史图片或需要精读时用 qqbot_describe_image；当前消息里的图片已经直接给你了。');
  // 能力边界（v1 机制）：按"当前真的可见"的能力渲染，关掉的能力不会出现
  const enabledCapabilities = [];
  for (const [capability, toolNames] of Object.entries(CAPABILITY_TOOLS)) {
    if (!Array.isArray(toolNames) || toolNames.length === 0) continue;
    if (toolNames.some((toolName) => names.has(toolName))) enabledCapabilities.push(capability);
  }
  const boundaries = enabledCapabilities
    .map((capability) => CAPABILITY_BOUNDARIES[capability])
    .filter((text) => typeof text === 'string' && text.trim() !== '');
  if (boundaries.length > 0) {
    lines.push('【能力边界】' + boundaries.join(' '));
    if (enabledCapabilities.includes('imagegen') && names.has('qqbot_send_file')) {
      lines.push('生成/修改图片后，图片只进了模型上下文、QQ 用户看不到：必须调用 qqbot_send_file 把生成的文件发出去（系统也会在回合末自动补发漏掉的生成图）。');
    }
  }
  if (names.has('memory_save')) lines.push('值得长期记住的信息用 memory_save 写入；不确定时先 memory_search。');
  const dataTools = ['member_lookup', 'member_note', 'memory_search', 'memory_read', 'memory_list', 'knowledge_search', 'knowledge_read'].filter((name) => names.has(name));
  if (dataTools.length > 0) {
    lines.push('群友库/长期记忆/知识库都存在 SQLite 里，是权威数据：查群友用 member_lookup（不传参数=列出群友库名单，传 nickname=搜索），'
      + '查记忆用 memory_search / memory_list，查知识用 knowledge_search（不传 query=列出文档标题，多个关键词会拆开分别搜）。'
      + '不要用 grep/glob/read 去翻工作区里的 members/、memory/、knowledge/ 等旧 JSON 目录，那是 v1 遗留副本，可能过时。');
  }
  if (names.has('skill')) lines.push('遇到特定任务时先检查是否有可用技能（skill 工具）。');
  if (names.has('web_search')) lines.push('需要最新信息时用 web_search / web_fetch。');
  if (names.has('read')) lines.push('工作区内的文件可以 read/write/edit/glob/grep；路径相对你的工作目录。');
  if (lines.length === 0) return '';
  return '【工具】' + lines.join(' ');
}

/**
 * 把策略应用到某个 agent：调用 agentCtx.tools.restrict({ allow })。
 * 必须在 agent scope 里调用（宿主强制）。未知名字已被过滤，避免整体失败。
 * @returns {{applied: boolean, allow: string[], reason?: string}}
 */
export function applyToolPolicy(agentCtx, agent, { settings, logger, presetTools = [] } = {}) {
  let view;
  try {
    view = agentCtx.tools.view(agent);
  } catch (err) {
    logger?.warn?.('读取工具视图失败（跳过工具策略）: ' + errText(err));
    return { applied: false, allow: [], reason: 'view-failed' };
  }
  const discovered = collectDiscovered(view, { botTools: presetTools });
  const plan = computePolicy({ settings, discovered, presetTools });
  if (plan.allow.length === 0) {
    // 注意：空 allow 只表示「全局工具 restrict 为空」；agent scope 挂载的工具
    // （fs/web/skill 等由 host/tool-mounts.js 按能力挂载）不受 restrict 影响。
    logger?.debug?.('全局工具 restrict：无（agent scope 工具由能力开关控制）');
  }
  try {
    agentCtx.tools.restrict({ allow: plan.allow });
    return { applied: true, allow: plan.allow, discovered };
  } catch (err) {
    logger?.warn?.('应用工具策略失败（跳过）: ' + errText(err));
    return { applied: false, allow: [], reason: errText(err), discovered };
  }
}
