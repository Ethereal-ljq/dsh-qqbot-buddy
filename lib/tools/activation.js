/**
 * tools/activation —— 「被动工具」的激活状态与确定性路由。
 *
 * 两档模型（见 catalog.js）：
 *   active   常驻声明，随时可调；
 *   passive  默认不声明（零 schema 成本），需要时按「分组」或「点名」点亮。
 *
 * 状态挂在 BotRuntime 上（runtime.activation: Map<peer, {groups:Set, tools:Set}>），
 * 一轮一次：followup 前由 route 写入，工具侧用 when / restrict 读取。
 * 任何读取都必须容错——when 抛错会让整个 step 准备失败。
 */
import {
  ACTIVATION_GROUPS, groupOfTool, isToolAllowed, resolveCapabilities, tierOf, toolsOfGroup,
} from './catalog.js';

/**
 * 某个分组的工具在「生效策略」下是否至少有一个可用。
 *
 * 注意（2026-11-14 修复）：不能只看能力开关——策略的语义是「显式 allow 可越过能力开关」
 * （catalog.isToolAllowed 第 2 条）。线上就是这样：白名单里放行了 qqbot_speak，
 * 但能力开关是默认拒绝，结果工具页显示「索引中」，qqbot_enable 却报「能力未开启」。
 * 激活路由、索引、装载校验、控制台分组可用性必须统一用这一个判定。
 *
 * @param {object} settings 生效设置
 * @param {string} groupId 分组 id
 * @returns {boolean}
 */
export function groupAllowed(settings, groupId) {
  const group = ACTIVATION_GROUPS[groupId];
  if (!group) return false;
  const names = toolsOfGroup(groupId);
  if (names.length === 0) return false;
  return names.some((name) => {
    try { return isToolAllowed({ settings, name }); } catch { return false; }
  });
}

/** 某能力是否开启（null/undefined 视为无关能力，恒真）。 */
export function capabilityEnabled(settings, capability) {
  if (typeof capability !== 'string' || capability === '') return true;
  try {
    return resolveCapabilities(settings)[capability] === true;
  } catch {
    return false;
  }
}

/**
 * 从一条用户原话里解析出要激活的分组（纯函数）。
 *
 * 只吃「本轮用户原话」：绝不能吃拼了 [Chat history] 的整包文本，
 * 否则别人聊天里的词会把工具点亮（动因错误）。
 * @param {string} text 用户原话
 * @param {object} [settings] 生效设置（用于能力过滤）
 * @returns {string[]} 分组 id
 */
export function matchGroups(text, settings) {
  const raw = typeof text === 'string' ? text : '';
  if (raw === '') return [];
  const haystack = raw.toLowerCase();
  const out = [];
  for (const [groupId, group] of Object.entries(ACTIVATION_GROUPS)) {
    // 策略判定（白名单可越过能力开关），与装载校验/索引同一口径
    if (!groupAllowed(settings, groupId)) continue;
    const triggers = Array.isArray(group.triggers) ? group.triggers : [];
    if (triggers.some((trigger) => typeof trigger === 'string' && trigger !== '' && haystack.includes(trigger.toLowerCase()))) {
      out.push(groupId);
    }
  }
  return out;
}

/** 取（必要时创建）某 peer 的激活状态。 */
function stateOf(runtime, peer, create = true) {
  if (!runtime || typeof runtime !== 'object') return null;
  if (!(runtime.activation instanceof Map)) {
    if (!create) return null;
    runtime.activation = new Map();
  }
  const key = String(peer || '');
  let state = runtime.activation.get(key);
  if (!state && create) {
    state = { groups: new Set(), tools: new Set(), at: 0 };
    runtime.activation.set(key, state);
  }
  return state || null;
}

/** 读取快照（只读副本，供诊断/预览）。 */
export function activationOf(runtime, peer) {
  const state = stateOf(runtime, peer, false);
  if (!state) return { groups: [], tools: [] };
  return { groups: [...state.groups].sort(), tools: [...state.tools].sort() };
}

/** 覆盖某 peer 的激活集合（每轮调用一次）。 */
export function setActivation(runtime, peer, { groups = [], tools = [] } = {}) {
  const state = stateOf(runtime, peer, true);
  if (!state) return { groups: [], tools: [] };
  state.groups = new Set((Array.isArray(groups) ? groups : []).filter((item) => typeof item === 'string' && item !== ''));
  state.tools = new Set((Array.isArray(tools) ? tools : []).filter((item) => typeof item === 'string' && item !== ''));
  state.at = Date.now();
  return activationOf(runtime, peer);
}

/** 追加激活（元工具用：本 turn 内继续生效）。 */
export function addActivation(runtime, peer, { groups = [], tools = [] } = {}) {
  const state = stateOf(runtime, peer, true);
  if (!state) return { groups: [], tools: [] };
  for (const item of Array.isArray(groups) ? groups : []) {
    if (typeof item === 'string' && item !== '') state.groups.add(item);
  }
  for (const item of Array.isArray(tools) ? tools : []) {
    if (typeof item === 'string' && item !== '') state.tools.add(item);
  }
  state.at = Date.now();
  return activationOf(runtime, peer);
}

/** 清空（会话重置/释放时）。 */
export function clearActivation(runtime, peer) {
  if (!runtime || !(runtime.activation instanceof Map)) return;
  runtime.activation.delete(String(peer || ''));
}

/**
 * 某工具此刻是否可用（主动恒真；被动看激活集合）。
 *
 * 性能注意：每个 step 会对每个注册了 when 的工具调用一次，
 * 所以这里只做内存判断，不做 IO。
 * @param {{runtime?: object, peer?: string, name: string, settings?: object}} args
 * @returns {boolean}
 */
export function isToolActive({ runtime, peer, name, settings } = {}) {
  if (typeof name !== 'string' || name === '') return false;
  try {
    if (tierOf(name, settings) === 'active') return true;
    const state = stateOf(runtime, peer, false);
    if (!state) return false;
    if (state.tools.has(name)) return true;
    const group = groupOfTool(name);
    return group !== undefined && state.groups.has(group);
  } catch {
    return false;
  }
}

/**
 * 该设置 + 该激活状态下，某个分组是否「可被点亮」：
 * 能力开关打开、组内至少有一个工具在允许列表里。
 * @param {{settings?: object, groupId: string}} args
 * @returns {boolean}
 */
export function groupAvailable({ settings, groupId } = {}) {
  return groupAllowed(settings, groupId);
}

/** 控制台/诊断：分组清单（含工具与开关状态）。 */
export function listGroups(settings) {
  return Object.entries(ACTIVATION_GROUPS).map(([id, group]) => ({
    id,
    label: group.label,
    capability: group.capability || null,
    tools: toolsOfGroup(id),
    available: groupAvailable({ settings, groupId: id }),
  }));
}

export default {
  matchGroups, activationOf, setActivation, addActivation, clearActivation,
  isToolActive, groupAvailable, groupAllowed, listGroups, capabilityEnabled,
};
