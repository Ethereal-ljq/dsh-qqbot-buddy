/**
 * session-adapter —— 把 v2 host（BotRuntime + agent host）适配成 v1 协议模块认识的
 * SessionManager 接口。
 *
 * 只做转接，不重复实现会话逻辑：v2 的会话创建/恢复/销毁由 host/agent.js 的
 * BotRuntime 承担（v1 的 session-manager.js 不移植）。协议模块（inbound/outbound/
 * commands/adaptive/interaction）历史上调用这些方法：
 *
 *   getOrCreate(scope, peerId, senderId, replyTarget) -> record
 *   getSessionRecord(scope, peerId) -> record | null
 *   findBySessionId(sessionId) -> record | null   （出站 session/event 反查）
 *   reset(scope, peerId) -> {resumable:number}
 *   previousCount(scope, peerId) -> number
 *   resolveModelRoute(record?) -> {route:{provider,model}} | undefined
 *   size / ctx
 *
 * record 就是 BotRuntime.sessions 里的那条记录（agent/sessionId/peer/handle/...），
 * 协议层会在上面挂 replyTarget / quoteNext / turn 等运行期字段，与 v1 行为一致。
 */
import { formatPeer } from '../core/peer.js';

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * @param {object} args
 * @param {object} args.botRuntime BotRuntime 实例
 * @param {object} args.logger 日志
 */
export function createSessionAdapter({ botRuntime, logger } = {}) {
  const log = logger || console;
  const host = botRuntime && botRuntime.host ? botRuntime.host : null;

  /** scope/peerId（v1 参数）-> v2 peer（'group:<openid>' / 'c2c:<openid>'）。 */
  function peerOf(scope, peerId) {
    return formatPeer(scope, peerId);
  }

  function settingsOf(peer) {
    try {
      return botRuntime && typeof botRuntime.settingsFor === 'function' ? botRuntime.settingsFor(peer) : {};
    } catch {
      return {};
    }
  }

  /** 从 v2 设置里的 model.provider/model.model 解析路由（inline-image 门控用）。 */
  function resolveModelRouteFor(record) {
    try {
      const settings = record && record.settings && typeof record.settings === 'object'
        ? record.settings
        : settingsOf(record && record.peer);
      const model = settings && settings.model && typeof settings.model === 'object' ? settings.model : {};
      const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
      const name = typeof model.model === 'string' ? model.model.trim() : '';
      if (provider === '' || name === '') return undefined;
      return { route: { provider, model: name }, source: 'settings' };
    } catch {
      return undefined;
    }
  }

  return {
    /** 宿主 ctx（inline-image 取 attachments/llm 服务用）。 */
    ctx: host ? host.ctx : undefined,

    get size() {
      return botRuntime && botRuntime.sessions instanceof Map ? botRuntime.sessions.size : 0;
    },

    /** v1 的 manager.getSessionRecord：只查，不创建。 */
    getSessionRecord(scope, peerId) {
      const peer = peerOf(scope, peerId);
      if (peer === '' || !botRuntime || !(botRuntime.sessions instanceof Map)) return null;
      return botRuntime.sessions.get(peer) || null;
    },

    /**
     * v1 的 manager.getOrCreate：v2 交给 BotRuntime（确定性 sessionId，重启可 resume）。
     * 额外参数 senderId/replyTarget 在 v2 不需要（peer 由 scope+peerId 决定）。
     */
    async getOrCreate(scope, peerId) {
      const peer = peerOf(scope, peerId);
      if (peer === '') throw new Error('非法会话标识: ' + String(scope) + ':' + String(peerId));
      return botRuntime.getOrCreate(peer);
    },

    /** 出站事件用：dsh sessionId -> BotRuntime 会话记录。未知 session 返回 null。 */
    findBySessionId(sessionId) {
      try {
        const found = host && typeof host.findSession === 'function' ? host.findSession(String(sessionId)) : null;
        if (!found || !found.runtime) return null;
        const sessions = found.runtime.sessions;
        if (!(sessions instanceof Map)) return null;
        return sessions.get(found.peer) || null;
      } catch (err) {
        log.warn?.('findBySessionId 失败: ' + errText(err));
        return null;
      }
    },

    /**
     * /new：释放当前 agent 并从运行期映射里移除。
     * TODO(v2-host): BotRuntime 的 sessionId 是 (botId, peer) 的确定性哈希，重建会 resume
     * 旧上下文，真正的「清空会话」需要 host 提供 sessionId 轮换/epoch 能力。当前实现
     * 只保证释放 + 重新创建，命令文案已相应弱化（见 commands.js）。
     */
    async reset(scope, peerId) {
      const peer = peerOf(scope, peerId);
      if (peer === '' || !botRuntime || !(botRuntime.sessions instanceof Map)) return { resumable: 0 };
      const record = botRuntime.sessions.get(peer);
      if (!record) return { resumable: 0 };
      botRuntime.sessions.delete(peer);
      try {
        if (host && host.sessionIndex) host.sessionIndex.delete(String(record.sessionId));
      } catch { /* 索引清理失败不影响主流程 */ }
      try {
        await record.handle?.dispose?.();
      } catch (err) {
        log.warn?.('释放会话失败（忽略）: ' + errText(err));
      }
      return { resumable: 0 };
    },

    /** v2 没有「上一个被 /new 替换掉的会话」栈。 */
    previousCount() {
      return 0;
    },

    /** v2 没有会话恢复栈。 */
    async resumePrevious() {
      return { ok: false };
    },

    resolveModelRouteFor,
    resolveModelRoute() {
      return resolveModelRouteFor(null);
    },
  };
}

export default createSessionAdapter;
