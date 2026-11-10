/**
 * console/api/state —— GET /api/state：控制台首屏全局快照（DESIGN-v2 §3）。
 *
 * 返回 {version,online,uptime,bots,profiles,bindings,activeProfiles,console,runtime}：
 * - bot 一律脱敏（appSecret 不出现）；
 * - 运行状态由可选 deps.runtime 提供，未装配时 online=false、runtime.bots={}；
 * - 配置服务未装配时返回空列表而不是 500（首屏不崩）。
 */
import { publicBot, runtimeStatus, safeCall } from './helpers.js';

function collect(ctx) {
  const { deps } = ctx;
  const config = deps?.config;
  const bots = [];
  const profiles = [];
  const bindings = [];
  const activeProfiles = {};

  if (config && typeof config === 'object') {
    const botRows = safeCall(() => config.listBots(), [], (err) => ctx.logger?.warn?.('[console] state 读取 bots 失败：' + err.message)) || [];
    for (const bot of botRows) {
      bots.push(publicBot(bot));
      const profileRows = safeCall(() => config.listProfiles(bot.id), []) || [];
      for (const profile of profileRows) {
        profiles.push(profile);
        if (profile && profile.isDefault) activeProfiles[bot.id] = profile.id;
      }
      const bindingRows = safeCall(() => config.listBindings(bot.id), []) || [];
      for (const binding of bindingRows) bindings.push(binding);
    }
  }

  const runtime = runtimeStatus(deps);
  return { bots, profiles, bindings, activeProfiles, runtime };
}

/**
 * dsh Web 入口：优先用启动时缓存，为空时向插件根 ctx 现算一次（解决 web-app/connection 就绪时序问题）。
 * @param {object} ctx 控制台请求上下文
 * @returns {{url:string, ready:boolean, error:string, hasWebApp:boolean, hasConnection:boolean}|null}
 */
function readDshWeb(ctx) {
  const cached = ctx.deps && ctx.deps.dshWeb ? ctx.deps.dshWeb : null;
  let info = cached
    ? {
      url: typeof cached.url === 'string' ? cached.url : '',
      ready: cached.ready === true,
      error: typeof cached.error === 'string' ? cached.error : '',
      hasWebApp: cached.hasWebApp === true,
      hasConnection: cached.hasConnection === true,
    }
    : null;
  if ((!info || info.url === '') && ctx.deps && typeof ctx.deps.resolveDshWeb === 'function') {
    try {
      const live = ctx.deps.resolveDshWeb();
      if (live && !info) info = live;
      else if (live && live.url !== '') info = live;
    } catch { /* 保持 cached */ }
  }
  return info;
}

export const routes = [
  {
    method: 'GET',
    path: '/api/state',
    handler: (ctx) => {
      const { bots, profiles, bindings, activeProfiles, runtime } = collect(ctx);
      const uptimeMs = ctx.console.uptimeMs;
      return {
        version: ctx.console.version,
        online: runtime.online,
        uptime: uptimeMs,
        uptimeMs,
        startedAt: ctx.console.startedAt,
        bots,
        profiles,
        bindings,
        activeProfiles,
        console: {
          version: ctx.console.version,
          host: ctx.console.host,
          port: ctx.console.port,
          startedAt: ctx.console.startedAt,
          uptimeMs,
        },
        runtime: { online: runtime.online, bots: runtime.bots },
        dshWeb: readDshWeb(ctx),
      };
    },
  },
];
