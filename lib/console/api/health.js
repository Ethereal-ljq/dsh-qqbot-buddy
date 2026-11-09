/**
 * console/api/health —— GET /api/health：无鉴权自检（版本/在线/运行时长）。
 *
 * 用途：部署探活、浏览器在登录页判断后端是否就绪。
 */
export const routes = [
  {
    method: 'GET',
    path: '/api/health',
    auth: false,
    csrf: false,
    handler: (ctx) => ({
      ok: true,
      version: ctx.console.version,
      startedAt: ctx.console.startedAt,
      uptimeMs: ctx.console.uptimeMs,
      uptime: ctx.console.uptimeMs,
      online: ctx.console.online,
    }),
  },
];
