/**
 * host/discovery —— 工具/技能发现（控制台「工具与技能」页的数据源）。
 *
 * 宿主全局工具视图只包含「全局注册」的工具；v2 的 fs/web/skill/bash 是**按 agent 挂载**的，
 * 插件工具也是 agent scope 注册的，所以全局视图几乎为空（只有一个 working_directory）。
 * 控制台需要的是「QQ 会话里可能出现的全部工具」，因此这里做三路合并：
 *   1) 插件自带工具（lib/tools/catalog.js 的 PLUGIN_TOOL_NAMES）；
 *   2) 能力挂载的宿主工具（CAPABILITY_TOOLS：fs/web/skill/bash…）；
 *   3) 宿主全局视图里的其它工具（MCP/第三方插件）；它们的可见性走 tools.restrict。
 * 技能：ctx.skills.list() 是异步的，控制台发现接口同步，因此缓存快照（refresh 预热）。
 */
import { getService, errText } from './services.js';
import { collectDiscovered, computePolicy } from './tools.js';
import { CAPABILITY_TOOLS, PLUGIN_TOOL_NAMES, isToolAllowed } from '../tools/catalog.js';
import { CAPABILITY_MOUNTS } from './tool-mounts.js';

function emptyName(name) {
  return typeof name !== 'string' || name === '';
}

export function createDiscovery({ ctx, runtime, logger, cwd } = {}) {
  let skillCache = [];
  let lastRefresh = 0;
  let refreshing = null;

  /** 宿主全局视图（同步）。 */
  function globalTools() {
    try {
      const tools = getService(ctx, 'tools');
      if (!tools || typeof tools.view !== 'function') return [];
      return collectDiscovered(tools.view());
    } catch (err) {
      logger?.warn?.('工具发现失败: ' + errText(err));
      return [];
    }
  }

  /** 同步：QQ 会话可能出现工具的全集。 */
  function list() {
    const out = new Map();
    for (const name of PLUGIN_TOOL_NAMES) {
      if (emptyName(name)) continue;
      out.set(name, { name, source: 'qqbot', restrictable: false, control: 'policy', capability: null, description: '' });
    }
    for (const [capability, names] of Object.entries(CAPABILITY_TOOLS)) {
      for (const name of names) {
        if (emptyName(name) || out.has(name)) continue;
        out.set(name, { name, source: 'host', restrictable: true, control: 'capability', capability, description: '' });
      }
    }
    for (const item of globalTools()) {
      if (out.has(item.name)) continue;
      out.set(item.name, { ...item, control: 'global', capability: null });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 异步：刷新技能快照。 */
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const skills = getService(ctx, 'skills');
        if (!skills || typeof skills.list !== 'function') { skillCache = []; return; }
        // skills.list() 返回数组（老契约是 {skills}），两种都兼容
        const lookup = cwd !== undefined ? { cwd } : {};
        const result = await skills.list(lookup);
        const entries = Array.isArray(result) ? result : (result && Array.isArray(result.skills) ? result.skills : []);
        skillCache = entries.map((entry) => ({
          name: String(entry && entry.name ? entry.name : ''),
          source: String(entry && entry.source ? entry.source : 'skill'),
          description: String(entry && entry.description ? entry.description : '').slice(0, 300),
        })).filter((entry) => entry.name !== '');
        lastRefresh = Date.now();
      } catch (err) {
        logger?.warn?.('技能发现失败: ' + errText(err));
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** 同步：技能快照。 */
  function listSkills() {
    return skillCache.slice();
  }

  function settingsForProfile(profileId) {
    try {
      if (!runtime || !runtime.config) return null;
      if (profileId) return runtime.config.getSettingsForProfile(profileId);
      return runtime.config.getSettings('');
    } catch { return null; }
  }

  /**
   * 某个 profile 下「实际可见」的工具名（能力开关 + 策略 + restrict 三条通道合并）。
   * 控制台工具页用它给每行打「当前可见」标记。
   */
  function visibleNames({ profileId } = {}) {
    const settings = settingsForProfile(profileId);
    if (!settings) return [];
    const names = new Set();
    // 统一策略：能力 + 白名单/黑名单（isToolAllowed），插件/宿主/全局工具同一套判定
    for (const [capability, mounts] of Object.entries(CAPABILITY_MOUNTS)) {
      if (!Array.isArray(mounts) || mounts.length === 0) continue;
      for (const name of CAPABILITY_TOOLS[capability] || []) {
        try {
          if (isToolAllowed({ settings, name })) names.add(name);
        } catch { /* ignore */ }
      }
    }
    for (const name of PLUGIN_TOOL_NAMES) {
      try {
        if (isToolAllowed({ settings, name })) names.add(name);
      } catch { /* ignore */ }
    }
    // 全局工具（MCP/第三方）：同样走统一策略；无能力归属的工具默认放行
    try {
      for (const item of list()) {
        if (names.has(item.name)) continue;
        if (isToolAllowed({ settings, name: item.name })) names.add(item.name);
      }
    } catch { /* ignore */ }
    return [...names].sort();
  }


  return { list, listSkills, refresh, visibleNames, get lastRefresh() { return lastRefresh; } };
}

export default createDiscovery;