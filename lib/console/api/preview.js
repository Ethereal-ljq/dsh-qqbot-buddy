/**
 * console/api/preview —— GET /api/preview/prompt：提示词拼合预览（只读）。
 *
 * 参数：?bot=<botId>（或 ?profile=<profileId>）&peer=&query=&scope=&live=
 *  - 有 live 会话（bot+peer）时默认返回**真实 assembly**：含宿主段、遮蔽结果、本次声明的工具；
 *  - 否则（或 live=0）回落到本插件的模拟拼合，并在 notes/liveUnavailable 里说明原因。
 */
import { badRequest, notFound, queryString, requireConfig, safeCall } from './helpers.js';
import { buildLivePromptPreview, buildPromptPreview } from '../../host/preview.js';

/** 模拟拼合（本插件负责的段 + 技能目录模拟）。 */
async function buildComposed(ctx, { settings, botId, cwd, peer, query }) {
  const skills = safeCall(() => {
    const service = ctx.deps.toolsDiscover;
    if (service && typeof service.listSkills === 'function') return service.listSkills();
    return [];
  }, []);
  return await buildPromptPreview({
    settings,
    botId,
    cwd,
    peer,
    query,
    db: ctx.deps.db,
    memory: ctx.deps.memory,
    knowledge: ctx.deps.kb,
    members: ctx.deps.members,
    skills,
  });
}

export const routes = [
  {
    method: 'GET',
    path: '/api/preview/prompt',
    handler: async (ctx) => {
      const config = requireConfig(ctx.deps);
      const botId = queryString(ctx.query, 'bot') || '';
      const profileId = queryString(ctx.query, 'profile') || '';
      const peer = queryString(ctx.query, 'peer') || '';
      const query = queryString(ctx.query, 'query') || '';
      if (botId === '' && profileId === '') throw badRequest('preview 需要 bot 或 profile');
      let settings;
      let resolvedBotId = botId;
      if (profileId !== '') {
        const profile = safeCall(() => config.getProfile(profileId), null);
        if (!profile) throw notFound('配置档不存在: ' + profileId);
        settings = safeCall(() => config.getSettingsForProfile(profileId), null);
        resolvedBotId = profile.botId || botId;
      } else {
        const bot = safeCall(() => config.getBot(botId), null);
        if (!bot) throw notFound('bot 不存在: ' + botId);
        settings = safeCall(() => config.getEffectiveSettings(botId, peer), {});
      }
      const bot = resolvedBotId !== '' ? safeCall(() => config.getBot(resolvedBotId), null) : null;
      const cwd = bot && bot.cwd ? bot.cwd : safeCall(() => config.defaultCwd(resolvedBotId), '');

      // ── 实时预览：有 live 会话时读真实 assembly ──────────────
      const liveFlag = queryString(ctx.query, 'live');
      if (liveFlag !== '0' && resolvedBotId !== '' && peer !== '') {
        const host = safeCall(() => (typeof ctx.deps.getHost === 'function' ? ctx.deps.getHost() : null), null);
        const liveResult = await buildLivePromptPreview({
          host, rootCtx: ctx.deps.rootCtx, botId: resolvedBotId, peer, logger: ctx.logger,
        });
        if (liveResult && liveResult.ok) {
          return { ...liveResult, profileId: profileId || null, liveUnavailable: null };
        }
        const composed = await buildComposed(ctx, { settings, botId: resolvedBotId, cwd, peer, query });
        return {
          ...composed,
          profileId: profileId || null,
          liveUnavailable: (liveResult && liveResult.reason) || 'unknown',
          notes: [
            '没有找到该 peer 的 live 会话，展示的是模拟拼合（发一条消息或 /new 后再刷新可看真实 assembly）。',
            ...(Array.isArray(composed.notes) ? composed.notes : []),
          ],
        };
      }

      return await buildComposed(ctx, { settings, botId: resolvedBotId, cwd, peer, query });
    },
  },
];
