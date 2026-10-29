/**
 * bots/agent-map —— Agent → 机器人运行时的映射（工具路由的核心）。
 *
 * 多机器人共用一份全局工具注册（工具名不按机器人加前缀），工具执行时通过
 * exec.agent 反查它属于哪个机器人，再用该机器人的 memory/knowledge/members/gateway。
 *
 * 用 WeakMap 存，agent 被回收后条目自动释放；拿不到映射（例如旧测试、宿主内部
 * agent）时由调用方回退到默认机器人。
 */
export function createAgentMap() {
  const map = new WeakMap();
  return {
    /** 登记一个 agent 属于哪个机器人（SessionManager 建会话时调用）。 */
    bind(agent, bot) {
      if (agent && bot) map.set(agent, bot);
    },
    /** 取 agent 对应的机器人运行时；没有返回 undefined。 */
    get(agent) {
      if (!agent) return undefined;
      try {
        return map.get(agent);
      } catch {
        return undefined;
      }
    },
    /** 工具 resolveBot 的默认实现：exec.agent → bot。 */
    resolve(exec) {
      try {
        return map.get(exec && exec.agent);
      } catch {
        return undefined;
      }
    },
  };
}

export default createAgentMap;
