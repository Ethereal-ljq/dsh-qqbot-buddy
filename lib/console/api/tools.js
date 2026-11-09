/**
 * console/api/tools —— 工具与技能：发现项、Profile 级策略、当前可见性（DESIGN-v2 §0.3 / §3）。
 *
 * 发现项由 M2 的 deps.toolsDiscover 注入（{list()|discover()}），未装配时 items=[] 不报错；
 * 策略持久化在 Profile.data.tools：
 *   mode/allow/deny         工具白名单（schema: tools.mode/tools.allow/tools.deny）
 *   skillsMode/skills       技能白名单（schema: tools.skillsMode/tools.skills）
 */
import {
  requireConfig, guard, badRequest, notFound, queryString, safeCall, audit, isPlainObject,
} from './helpers.js';

/** 工具策略默认值（与 core/config/schema 的 tools.mode 默认一致）。 */
export const DEFAULT_TOOLS_POLICY = { mode: 'allow', allow: [], deny: [], extra: [] };
/** 技能策略默认值（与 schema 的 tools.skillsMode 默认一致）。 */
export const DEFAULT_SKILLS_POLICY = { mode: 'allow', allow: [] };

function stringList(value, maxChars = 200) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text !== '' && !out.includes(text)) out.push(text.slice(0, maxChars));
  }
  return out;
}

/** 发现工具列表；服务异常时降级为 []。 */
function discoverTools(deps) {
  const service = deps?.toolsDiscover;
  if (!service) return [];
  const raw = safeCall(() => {
    if (typeof service.list === 'function') return service.list();
    if (typeof service.discover === 'function') return service.discover();
    return [];
  }, [], (err) => deps?.logger?.warn?.('[console] 工具发现失败：' + err.message));
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      name: String(item?.name || ''),
      source: String(item?.source || 'host'),
      description: String(item?.description || ''),
      restrictable: item?.restrictable !== false,
    }))
    .filter((item) => item.name !== '');
}

/** 发现技能列表（宿主技能服务缺失时 []）。 */
function discoverSkills(deps) {
  const service = deps?.skills || deps?.toolsDiscover;
  if (!service) return [];
  const raw = safeCall(() => {
    if (typeof service.listSkills === 'function') return service.listSkills();
    if (typeof service.skills === 'function') return service.skills();
    return [];
  }, [], (err) => deps?.logger?.warn?.('[console] 技能发现失败：' + err.message));
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      name: String(item?.name || ''),
      source: String(item?.source || 'skill'),
      description: String(item?.description || ''),
    }))
    .filter((item) => item.name !== '');
}

/** 当前策略作用在哪个 profile：?profile= > ?bot=(+?peer=) > 无。 */
function resolveProfileFor(ctx, profileIdHint) {
  const config = requireConfig(ctx.deps);
  const profileId = profileIdHint || queryString(ctx.query, 'profile');
  if (profileId) {
    const profile = guard(() => config.getProfile(profileId));
    if (!profile) throw notFound('配置档不存在: ' + profileId);
    return { config, profile };
  }
  const botId = queryString(ctx.query, 'bot');
  if (botId) {
    const resolved = guard(() => config.resolveProfile(botId, queryString(ctx.query, 'peer')));
    if (!resolved || !resolved.profile) throw notFound('bot 没有可用配置档: ' + botId);
    return { config, profile: resolved.profile };
  }
  return { config, profile: null };
}

function toolsOf(profile) {
  const data = isPlainObject(profile?.data) ? profile.data : {};
  const tools = isPlainObject(data.tools) ? data.tools : {};
  return {
    mode: tools.mode === 'deny' ? 'deny' : 'allow',
    allow: stringList(tools.allow),
    deny: stringList(tools.deny),
    extra: Array.isArray(tools.extra) ? tools.extra : [],
  };
}

function skillsOf(profile) {
  const data = isPlainObject(profile?.data) ? profile.data : {};
  const tools = isPlainObject(data.tools) ? data.tools : {};
  return {
    mode: tools.skillsMode === 'allow' ? 'allow' : 'all',
    allow: stringList(tools.skills),
  };
}

function visibleNames(ctx, profile) {
  const service = ctx.deps?.toolsDiscover;
  const raw = safeCall(() => {
    if (!service) return [];
    if (typeof service.visibleNames === 'function') return service.visibleNames({ profileId: profile?.id || null });
    if (typeof service.visible === 'function') return service.visible({ profileId: profile?.id || null });
    return [];
  }, [], (err) => ctx.logger?.warn?.('[console] 可见性计算失败：' + err.message));
  return Array.isArray(raw) ? raw.filter((name) => typeof name === 'string') : [];
}

function getTools(ctx) {
  const { profile } = resolveProfileFor(ctx, null);
  return {
    items: discoverTools(ctx.deps),
    policy: profile ? toolsOf(profile) : { ...DEFAULT_TOOLS_POLICY },
    visible: visibleNames(ctx, profile),
    profileId: profile?.id || null,
  };
}

function getSkills(ctx) {
  const { profile } = resolveProfileFor(ctx, null);
  return {
    items: discoverSkills(ctx.deps),
    policy: profile ? skillsOf(profile) : { ...DEFAULT_SKILLS_POLICY },
    profileId: profile?.id || null,
  };
}

function putToolsPolicy(ctx) {
  const body = ctx.body || {};
  const profileId = typeof body.profileId === 'string' ? body.profileId : '';
  if (profileId === '') throw badRequest('缺少 profileId');
  const { config, profile } = resolveProfileFor(ctx, profileId);
  const policy = isPlainObject(body.policy) ? body.policy : null;
  if (!policy) throw badRequest('缺少 policy');
  const mode = policy.mode === 'deny' ? 'deny' : policy.mode === 'allow' ? 'allow' : '';
  if (mode === '') throw badRequest('policy.mode 必须是 allow 或 deny');
  const data = { tools: { mode, allow: stringList(policy.allow), deny: stringList(policy.deny) } };
  const updated = guard(() => config.updateProfile(profile.id, { data }));
  audit(ctx.deps, { kind: 'tools.policy', botId: profile.botId, detail: profile.id });
  return { profileId: profile.id, policy: toolsOf(updated) };
}

function putSkillsPolicy(ctx) {
  const body = ctx.body || {};
  const profileId = typeof body.profileId === 'string' ? body.profileId : '';
  if (profileId === '') throw badRequest('缺少 profileId');
  const { config, profile } = resolveProfileFor(ctx, profileId);
  const policy = isPlainObject(body.policy) ? body.policy : null;
  if (!policy) throw badRequest('缺少 policy');
  const mode = policy.mode === 'all' ? 'all' : policy.mode === 'allow' ? 'allow' : '';
  if (mode === '') throw badRequest('policy.mode 必须是 all 或 allow');
  const data = { tools: { skillsMode: mode, skills: stringList(policy.allow) } };
  const updated = guard(() => config.updateProfile(profile.id, { data }));
  audit(ctx.deps, { kind: 'skills.policy', botId: profile.botId, detail: profile.id });
  return { profileId: profile.id, policy: skillsOf(updated) };
}

export const routes = [
  { method: 'GET', path: '/api/tools', handler: getTools },
  { method: 'PUT', path: '/api/tools/policy', handler: putToolsPolicy },
  { method: 'GET', path: '/api/skills', handler: getSkills },
  { method: 'PUT', path: '/api/skills/policy', handler: putSkillsPolicy },
];
