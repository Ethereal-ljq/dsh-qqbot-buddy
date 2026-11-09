/**
 * core/peer —— 会话标识（peer）与作用域（scope）的纯函数。
 *
 * peer 是插件内部的会话标识：'group:<id>' / 'c2c:<openid>' / 'channel:<id>'（预留）。
 * scope 是配置绑定用的 UMO 风格模式：'qq:group:123' / 'qq:group:*' / '*'。
 */
const PEER_RE = /^(group|c2c|channel):([A-Za-z0-9_-]{1,128})$/;

/** 解析 peer；非法返回 null。 */
export function parsePeer(peer) {
  if (typeof peer !== 'string') return null;
  const m = PEER_RE.exec(peer.trim());
  if (!m) return null;
  return { platform: 'qq', type: m[1], id: m[2] };
}

/** 由类型与 id 构造 peer。 */
export function formatPeer(type, id) {
  const cleanType = String(type || '').trim();
  const cleanId = String(id || '').trim();
  if (!['group', 'c2c', 'channel'].includes(cleanType) || cleanId === '') return '';
  return cleanType + ':' + cleanId;
}

/** peer → 精确 scope。 */
export function scopeOf(peer) {
  const parsed = parsePeer(peer);
  return parsed === null ? '' : 'qq:' + parsed.type + ':' + parsed.id;
}

/** 类型级通配 scope。 */
export function typeScope(type) {
  return ['group', 'c2c', 'channel'].includes(type) ? 'qq:' + type + ':*' : '';
}

/** 校验并归一化 scope（允许 qq:* / qq:group:* / qq:group:123 / *）。 */
export function normalizeScope(scope) {
  if (typeof scope !== 'string') return '';
  const raw = scope.trim();
  if (raw === '*') return '*';
  if (raw === 'qq:*') return 'qq:*';
  const m = /^qq:(group|c2c|channel):(\*|[A-Za-z0-9_-]{1,128})$/.exec(raw);
  if (!m) return '';
  return 'qq:' + m[1] + ':' + m[2];
}

/**
 * 计算 scope 相对某个 peer 的匹配等级（数值越大越精确，0 = 不匹配）。
 *  4 精确 / 3 类型通配 / 2 平台通配 / 1 全局
 */
export function matchLevel(scope, peer) {
  const parsed = parsePeer(peer);
  if (parsed === null) return 0;
  const norm = normalizeScope(scope);
  if (norm === '') return 0;
  if (norm === '*') return 1;
  if (norm === 'qq:*') return 2;
  const parts = norm.split(':');
  if (parts[1] !== parsed.type) return 0;
  return parts[2] === '*' ? 3 : (parts[2] === parsed.id ? 4 : 0);
}

/**
 * 在一组绑定里挑出最匹配 peer 的一条。
 * 排序：匹配等级 desc → priority desc → 创建时间 asc（稳定）。
 * @param {Array<{scope:string, profileId:string, priority?:number, createdAt?:number}>} bindings
 * @param {string} peer
 * @returns {{binding:object, level:number}|null}
 */
export function pickBinding(bindings, peer) {
  let best = null;
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const level = matchLevel(binding.scope, peer);
    if (level === 0) continue;
    if (best === null) { best = { binding, level }; continue; }
    const bp = Number(binding.priority || 0);
    const cp = Number(best.binding.priority || 0);
    if (level > best.level) { best = { binding, level }; continue; }
    if (level === best.level) {
      if (bp > cp) { best = { binding, level }; continue; }
      if (bp === cp) {
        const bt = Number(binding.createdAt || 0);
        const ct = Number(best.binding.createdAt || 0);
        if (bt < ct) best = { binding, level };
      }
    }
  }
  return best;
}
