/**
 * console/api/audit —— GET /api/audit：最近审计记录（只读，失败降级为空列表）。
 *
 * 记录由 core/config.audit() 写入（登录、bot/profile/binding/设置变更等）。
 */
import { queryInt, queryString, safeCall } from './helpers.js';

function mapRow(row) {
  return {
    id: row.id,
    at: row.at,
    botId: row.bot_id ?? row.botId ?? null,
    kind: row.kind,
    detail: row.detail || '',
  };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/audit',
    handler: (ctx) => {
      const limit = queryInt(ctx.query, 'limit', 100, { min: 1, max: 500 });
      const botId = queryString(ctx.query, 'bot');
      const config = ctx.deps?.config;
      if (!config || typeof config.listAudit !== 'function') return [];
      const rows = safeCall(() => config.listAudit({ limit, botId: botId || null }), [], (err) => {
        ctx.logger?.warn?.('[console] 读取审计失败：' + err.message);
      });
      return Array.isArray(rows) ? rows.map(mapRow) : [];
    },
  },
];
