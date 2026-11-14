/**
 * tools/index-guide —— 「按需能力」索引与「用法卡」的静态渲染（2026-11-14 渐进披露）。
 *
 * 为什么单独一个模块：
 *   - 索引是**静态文本**：同一个配置档永远渲染出同一段文字，不随本轮工具可见性变化，
 *     这样系统提示词前缀稳定（缓存命中），模型也不会因为工具忽然消失而瞎猜；
 *   - 用法卡只在 qqbot_enable 成功时返回一次，替代「整份 schema 常驻」。
 *
 * 纯函数、无 IO，供 host/ 与 tools/ 共用，便于单测。
 */
import {
  ACTIVATION_GROUPS, toolUsageOf, toolsOfGroup,
} from './catalog.js';
import { TOOL_ALIASES } from './aliases.js';
import { groupAvailable } from './activation.js';

/** 组内「正名」（去掉兼容别名，索引里只列正名，避免同一工具列两遍）。 */
function canonicalNames(groupId) {
  const group = ACTIVATION_GROUPS[groupId];
  const names = Array.isArray(group && group.tools) ? group.tools : [];
  return names.filter((name) => TOOL_ALIASES[name] === undefined);
}

/**
 * 渲染「按需能力」索引行（静态、有序）。
 *
 * @param {object} args
 * @param {object} args.settings 生效设置（决定哪些组可用）
 * @param {string[]} [args.activeNames] 当前已装载的工具名（已装载的组不再进索引）
 * @param {Set<string>|null} [args.knownNames] 该 agent 已知工具名（可选；给出时过滤掉本机没装的组）
 * @returns {string[]} 每行一条，例如 "- 生图/改图（imagegen）：generate_image / edit_image"
 */
export function buildToolIndexLines({ settings, activeNames = [], knownNames = null } = {}) {
  const active = new Set(Array.isArray(activeNames) ? activeNames : []);
  const known = knownNames instanceof Set ? knownNames : null;
  const out = [];
  for (const groupId of Object.keys(ACTIVATION_GROUPS)) {
    const group = ACTIVATION_GROUPS[groupId];
    if (!group) continue;
    // 与装载校验同一判定：白名单显式放行可越过能力开关
    if (!groupAvailable({ settings, groupId })) continue;
    const names = canonicalNames(groupId).filter((name) => !active.has(name));
    if (names.length === 0) continue;
    // 本机没装这个组的任何工具（插件缺失）→ 不列，避免"索引里承诺了却点不亮"
    if (known && !names.some((name) => known.has(name))) continue;
    out.push('- ' + (group.label || groupId) + '（' + groupId + '）：' + names.join(' / '));
  }
  return out;
}

/**
 * 渲染某个组装载成功后的用法卡（只含真正可用的工具）。
 * @param {string[]} groupIds 组 id
 * @param {{names?: string[]}} [options] names=本次实际可用的工具名（缺省用组内正名）
 * @returns {string[]}
 */
export function usageLinesForGroups(groupIds, options = {}) {
  const wanted = new Set(Array.isArray(options.names) ? options.names : []);
  const lines = [];
  const seen = new Set();
  for (const groupId of Array.isArray(groupIds) ? groupIds : []) {
    const names = wanted.size > 0
      ? canonicalNames(groupId).filter((name) => wanted.has(name))
      : canonicalNames(groupId);
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      const card = toolUsageOf(name);
      if (card !== '') lines.push('- ' + card);
    }
  }
  return lines;
}

/** 组 id 列表 → 中文标签（提示词里用）。 */
export function groupLabels(groupIds) {
  return (Array.isArray(groupIds) ? groupIds : [])
    .map((id) => (ACTIVATION_GROUPS[id] && ACTIVATION_GROUPS[id].label) || id)
    .filter((label) => typeof label === 'string' && label !== '');
}

export default { buildToolIndexLines, usageLinesForGroups, groupLabels };
