/**
 * host/discovery —— 工具/技能发现（控制台「工具与技能」页的数据源）。
 *
 * 工具：读 ctx.tools 的全局视图（view() 无 scope = 全局层），source 推断见 host/tools.js。
 *   注意：agent scope 注册的工具（本插件 qqbot_* 与其他插件的会话级工具）不在全局视图里，
 *   它们的可见性由 Profile 策略在 agent setup 时决定；控制台展示时以全局视图 + 内置清单为准。
 * 技能：ctx.skills.list() 是异步的，而控制台发现接口是同步 safeCall，
 *   所以这里做一层缓存：refresh() 预热，listSkills() 同步返回快照。
 */
import { getService, errText } from './services.js';
import { collectDiscovered } from './tools.js';

export function createDiscovery({ ctx, logger } = {}) {
  let skillCache = [];
  let lastRefresh = 0;
  let refreshing = null;

  /** 同步：工具发现（全局视图）。 */
  function list() {
    try {
      const tools = getService(ctx, 'tools');
      if (!tools || typeof tools.view !== 'function') return [];
      const view = tools.view();
      return collectDiscovered(view);
    } catch (err) {
      logger?.warn?.('工具发现失败: ' + errText(err));
      return [];
    }
  }

  /** 异步：刷新技能快照。 */
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const skills = getService(ctx, 'skills');
        if (!skills || typeof skills.list !== 'function') { skillCache = []; return; }
        const result = await skills.list({});
        const entries = result && Array.isArray(result.skills) ? result.skills : [];
        skillCache = entries
          .map((entry) => ({
            name: String(entry && entry.name ? entry.name : ''),
            source: String(entry && entry.source ? entry.source : 'skill'),
            description: String(entry && entry.description ? entry.description : '').slice(0, 300),
          }))
          .filter((entry) => entry.name !== '');
        lastRefresh = Date.now();
      } catch (err) {
        logger?.warn?.('技能发现失败: ' + errText(err));
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** 同步：技能快照（未 refresh 过则为空）。 */
  function listSkills() {
    return skillCache.slice();
  }

  return { list, listSkills, refresh, get lastRefresh() { return lastRefresh; } };
}

export default createDiscovery;
