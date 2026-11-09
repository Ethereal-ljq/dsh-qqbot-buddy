/**
 * console/api/preview —— GET /api/preview/prompt：提示词拼合预览（只读）。
 *
 * 参数：?bot=<botId>（或 ?profile=<profileId> 单独预览某配置档）&peer=&query=&scope=
 * 返回 {ok, source, sections[{name,label,text,chars,empty}], text, notes, toolNames, skillNames}
 */
import { badRequest, notFound, queryString, requireConfig, safeCall } from './helpers.js';
import { buildPromptPreview } from '../../host/preview.js';

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
      const skills = safeCall(() => {
        const service = ctx.deps.toolsDiscover;
        if (service && typeof service.listSkills === 'function') return service.listSkills();
        return [];
      }, []);
      return await buildPromptPreview({
        settings,
        botId: resolvedBotId,
        cwd,
        peer,
        query,
        db: ctx.deps.db,
        memory: ctx.deps.memory,
        knowledge: ctx.deps.kb,
        members: ctx.deps.members,
        skills,
      });
    },
  },
];
