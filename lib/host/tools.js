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
import {
  CAPABILITY_TOOLS, CAPABILITY_BOUNDARIES, DEFAULT_CAPABILITIES, isToolAllowed,
} from '../tools/catalog.js';

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
  const explicitDeny = uniq(toolsSettings.deny);
  // 只有「全局注册」的工具能交给 tools.restrict；agent scope 的工具靠挂载/注册阶段过滤
  const restrictable = uniq((Array.isArray(discovered) ? discovered : [])
    .filter((item) => item && item.restrictable)
    .map((item) => item.name));
  const allow = restrictable.filter((name) => isToolAllowed({ settings, name }));
  return { mode, allow, deny: explicitDeny, allowSet: new Set(allow) };
}

/**
 * 生成写进 system prompt 的工具指引（纯函数）。
 * 只列可见工具里"对 QQ 场景有意义"的部分，并给出使用约定。
 */
export function buildToolGuide(discovered) {
  const names = new Set((Array.isArray(discovered) ? discovered : []).map((item) => item.name));
  const lines = [];
  const qq = ['qqbot_send_file', 'qqbot_send_card', 'qqbot_describe_image', 'qqbot_sticker_save', 'qqbot_speak', 'memory_save', 'memory_search', 'memory_read', 'memory_list']
    .filter((name) => names.has(name));
  if (qq.length > 0) lines.push('你可以使用这些工具完成 QQ 侧动作：' + qq.join('、') + '。');
  if (names.has('qqbot_send_file')) lines.push('要发图片/文件时用 qqbot_send_file；表情包用 qqbot_sticker_save 收藏后可直接发送。');
  if (names.has('qqbot_send_card')) lines.push('需要图文卡片时用 qqbot_send_card。');
  if (names.has('qqbot_describe_image')) lines.push('看历史图片或需要精读时用 qqbot_describe_image；当前消息里的图片已经直接给你了。');
  // 语音合成（TTS）：只有用户真的想「听」时才用，且只念短句，避免又长又贵又打断。
  if (names.has('qqbot_speak')) {
    lines.push('需要朗读/发语音回复时用 qqbot_speak（只适合一两句短句，长文会被截断）；'
      + '用户没要语音时不要主动发，同一段内容不要重复合成发送。');
  }
  // 能力边界（v1 机制）：按"当前真的可见"的能力渲染，关掉的能力不会出现
  const enabledCapabilities = [];
  for (const [capability, toolNames] of Object.entries(CAPABILITY_TOOLS)) {
    // voice 没有宿主全局工具（CAPABILITY_TOOLS.voice = []），只能按插件工具名判定，
    // 否则能力边界永远渲染不出来。
    if (capability === 'voice') {
      if (names.has('qqbot_speak')) enabledCapabilities.push(capability);
      continue;
    }
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
  // 历史消息检索：与记忆互补——记忆是提炼结论，消息是原始记录。
  // 明确「什么时候用」而不只是「怎么用」，否则模型不会主动翻（实测 member_lookup 就是这样）。
  if (names.has('chat_history_search') || names.has('chat_history_recent')) {
    lines.push('当有人提到「上次说的」「之前谁提过」「前几天」这类需要回溯具体原话的事，'
      + '先用 chat_history_search 查历史消息（可跨会话，支持时间范围），不要凭印象编；'
      + '若只需要本会话最近的内容，用 chat_history_recent。'
      + '注意：这两者是原始消息记录（默认保留两周），与 memory_search 的「提炼后的长期记忆」不同，'
      + '问具体原话/时间用前者，问长期偏好/约定用后者。');
  }
  const dataTools = ['member_lookup', 'member_note', 'memory_search', 'memory_read', 'memory_list', 'knowledge_search', 'knowledge_read'].filter((name) => names.has(name));
  if (dataTools.length > 0) {
    lines.push('群友库/长期记忆/知识库都存在 SQLite 里，是权威数据：查群友用 member_lookup（不传参数=列出群友库名单，传 nickname=搜索），'
      + '查记忆用 memory_search / memory_list，查知识用 knowledge_search（不传 query=列出文档标题，多个关键词会拆开分别搜）。'
      + '不要用 grep/glob/read 去翻工作区里的 members/、memory/、knowledge/ 等旧 JSON 目录，那是 v1 遗留副本，可能过时。');
  }
  if (names.has('skill')) lines.push('遇到特定任务时先检查是否有可用技能（skill 工具）。');
  if (names.has('web_search')) lines.push('需要最新信息时用 web_search / web_fetch。');
  if (names.has('read')) lines.push('工作区内的文件可以 read/write/edit/glob/grep；路径相对你的工作目录。');
  // 反「臆造工具」硬规则：线上实测模型会按兄弟工具命名习惯猜名字（qqbot_send_voice 等），
  // 调用失败后还可能向用户编造成功。工具名单是唯一权威，失败必须如实说。
  if (lines.length > 0) {
    lines.push('【工具调用规则】只能使用工具列表里确切存在的工具名（拼写、下划线敏感），不要臆造或改写工具名；'
      + '工具返回 unknown tool 或其它错误时必须如实告诉用户失败原因，不要假装成功、不要编造执行结果。'
      + (names.has('qqbot_speak') ? '语音合成工具名是 qqbot_speak（qqbot_send_voice 只是兼容别名）。' : ''));
  }
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
