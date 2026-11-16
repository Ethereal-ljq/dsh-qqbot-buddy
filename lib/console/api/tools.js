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
import {
  ACTIVATION_GROUPS, DEFAULT_CAPABILITIES, capabilityOfTool, groupOfTool, isClassifiedTier, isToolAllowed,
  resolveCapabilities, tierOf,
} from '../../tools/catalog.js';
import { TOOL_ALIASES } from '../../tools/aliases.js';
import { listGroups } from '../../tools/activation.js';
import { activeMountPlan } from '../../host/tool-mounts.js';
import { presetIdFor } from '../../host/presets.js';
import { buildLivePromptPreview } from '../../host/preview.js';

/**
 * 策略里引用了「已经不存在」的工具/分组（插件卸载、改名、能力删掉）。
 *
 * 三态（已装载/已声明/索引中）描述“发现的工具现在什么状态”；
 * 这里的失效条目描述反向问题：策略指向了发现清单里没有的东西——它们永远不会生效，
 * 通常意味着插件没了或当初写错了名字，控制台应提示清理。
 *
 * 合法 key 的白名单：发现清单里的工具名、兼容别名、激活分组 id、能力 key（tiers 允许按能力覆盖）。
 *
 * @param {{allow?: string[], deny?: string[], tiers?: Record<string,string>}} policy
 * @param {string[]} discoveredNames
 * @returns {Array<{name: string, where: 'allow'|'deny'|'tiers'}>}
 */
export function stalePolicyEntries(policy, discoveredNames = []) {
  const known = new Set(Array.isArray(discoveredNames) ? discoveredNames : []);
  const groupIds = new Set(Object.keys(ACTIVATION_GROUPS));
  const capabilityKeys = new Set(Object.keys(DEFAULT_CAPABILITIES));
  const aliasTarget = (name) => (typeof TOOL_ALIASES[name] === 'string' ? TOOL_ALIASES[name] : '');
  const discovered = (name) => {
    const target = aliasTarget(name);
    return known.has(name) || (target !== '' && known.has(target));
  };
  const out = [];
  const push = (rawName, where) => {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name === '' || discovered(name) || groupIds.has(name)) return;
    if (where === 'tiers' && capabilityKeys.has(name)) return;
    out.push({ name, where });
  };
  for (const name of Array.isArray(policy?.allow) ? policy.allow : []) push(name, 'allow');
  for (const name of Array.isArray(policy?.deny) ? policy.deny : []) push(name, 'deny');
  const tiers = policy?.tiers && typeof policy.tiers === 'object' ? policy.tiers : {};
  for (const name of Object.keys(tiers)) push(name, 'tiers');
  return out;
}

/**
 * 清理策略里「当前环境已不存在」的条目（纯函数，便于单测）。
 *
 * 语义：只动 allow/deny/tiers 里指向发现清单没有的工具/分组/能力的 key，
 * 不碰其它策略，不改能力开关。tiers 里要删除的对象键用 null 覆盖（deepMerge 会保留旧键，
 * 置 null 后 toolsOf 读出来会自动丢弃）。
 *
 * @param {{policy: object, discoveredNames: string[]}} args
 * @returns {{next: {mode:string, allow:string[], deny:string[], tiers:object}, removed: Array<{name:string, where:string}>}}
 */
export function cleanupToolsPolicy({ policy, discoveredNames = [] } = {}) {
  const current = policy && typeof policy === 'object' ? policy : {};
  const removed = stalePolicyEntries(current, discoveredNames);
  const removedNames = new Set(removed.map((item) => item.name));
  const allow = (Array.isArray(current.allow) ? current.allow : []).filter((name) => !removedNames.has(name));
  const deny = (Array.isArray(current.deny) ? current.deny : []).filter((name) => !removedNames.has(name));
  const currentTiers = current.tiers && typeof current.tiers === 'object' ? current.tiers : {};
  const tiers = { ...currentTiers };
  for (const name of removedNames) {
    if (Object.prototype.hasOwnProperty.call(tiers, name)) tiers[name] = null;
  }
  return {
    next: { mode: current.mode === 'deny' ? 'deny' : 'allow', allow, deny, tiers },
    removed,
  };
}

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
function discoverTools(deps, profileId) {
  const service = deps?.toolsDiscover;
  if (!service) return [];
  const raw = safeCall(() => {
    if (typeof service.list === 'function') return service.list({ profileId: profileId || null });
    if (typeof service.discover === 'function') return service.discover({ profileId: profileId || null });
    return [];
  }, [], (err) => deps?.logger?.warn?.('[console] 工具发现失败：' + err.message));
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      name: String(item?.name || ''),
      source: String(item?.source || 'host'),
      description: String(item?.description || ''),
      restrictable: item?.restrictable !== false,
      capability: item?.capability || null,
      tier: String(item?.tier || ''),
      group: item?.group || null,
      classified: item?.classified !== false,
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
  const tiers = isPlainObject(tools.tiers) ? tools.tiers : {};
  const cleanTiers = {};
  for (const [key, value] of Object.entries(tiers)) {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (text === 'active' || text === 'passive') cleanTiers[key] = text;
  }
  return {
    mode: tools.mode === 'deny' ? 'deny' : 'allow',
    allow: stringList(tools.allow),
    deny: stringList(tools.deny),
    extra: Array.isArray(tools.extra) ? tools.extra : [],
    tiers: cleanTiers,
  };
}

/** 某 profile 的生效设置（档位覆盖/能力开关都从这里算）。 */
function settingsFor(config, profile) {
  if (!profile) return null;
  try { return config.getSettingsForProfile(profile.id); } catch { return null; }
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

/** 工具为什么不可用（给控制台 tooltip 用；与 host/agent.js 的判定同源）。 */
export function disabledReasonOf(settings, name) {
  const tools = settings && settings.tools && typeof settings.tools === 'object' ? settings.tools : {};
  const deny = Array.isArray(tools.deny) ? tools.deny : [];
  if (deny.includes(name)) return '被黑名单屏蔽';
  const mode = tools.mode === 'deny' ? 'deny' : 'allow';
  const allow = Array.isArray(tools.allow) ? tools.allow.filter((item) => typeof item === 'string' && item !== '') : [];
  if (mode === 'allow' && allow.length > 0 && !allow.includes(name)) return '不在白名单';
  const capability = capabilityOfTool(name);
  if (capability !== undefined && capability !== null) {
    const capabilities = resolveCapabilities(settings);
    if (capabilities[capability] !== true) return '能力「' + capability + '」未开启';
  }
  return '被工具策略过滤';
}

/** 显式 deny 判定（含兼容别名归一）：force 注册的元工具仍会被 deny 拦住。 */
function explicitlyDenied(settings, name) {
  const deny = Array.isArray(settings?.tools?.deny) ? settings.tools.deny : [];
  const names = [name];
  const target = TOOL_ALIASES[name];
  if (typeof target === 'string') names.push(target);
  for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
    if (canonical === name) names.push(alias);
  }
  return names.some((item) => deny.includes(item));
}

/**
 * 工具「装配状态」（2026-11-16 修正；控制台只展示一个状态列）：
 *   declared 每轮发送 —— 会出现在每次请求的 tools schema 里（常驻档 + 白名单放行）；
 *   indexed  待唤醒 —— 默认不进 schema，只在提示词【按需能力】索引里；触发词 / qqbot_enable 后本会话可用；
 *   disabled 不可用 —— 能力关闭 / 不在白名单 / 插件未装配 / 按需档但没有可激活分组。
 *
 * 纯函数，便于单测；settings 为 null（没有配置档）时返回 unknown。
 * @param {{settings: object|null, name: string, source?: string, capability?: string|null,
 *   tier?: string, group?: string|null, restrictable?: boolean,
 *   mountedCapabilities?: Set<string>}} args
 * @returns {{state: 'declared'|'indexed'|'disabled'|'unknown', loaded: boolean|null,
 *   declared: boolean|null, indexed: boolean|null, reason?: string}}
 */
export function toolStateOf({
  settings, name, source = '', capability = null, tier = '', group = null,
  restrictable = true, mountedCapabilities = null,
} = {}) {
  if (!settings) return { state: 'unknown', loaded: null, declared: null, indexed: null };
  const toolName = typeof name === 'string' ? name : '';
  let allowed = false;
  try { allowed = isToolAllowed({ settings, name: toolName }); } catch { allowed = false; }
  const effectiveTier = tier === 'active' || tier === 'passive' ? tier : tierOf(toolName, settings);
  const effectiveCapability = capability || capabilityOfTool(toolName) || null;
  const effectiveGroup = group || groupOfTool(toolName) || null;
  // 元工具 qqbot_enable 是 force 注册的：白名单/能力都不拦它，只有显式 deny 才真的没有。
  // 否则控制台会把它标成「不可用」，而实际每轮都在 schema 里（线上就是这种矛盾）。
  const metaTool = toolName === 'qqbot_enable';
  if (!allowed) {
    if (!(metaTool && !explicitlyDenied(settings, toolName))) {
      return {
        state: 'disabled', loaded: false, declared: false, indexed: false,
        reason: disabledReasonOf(settings, toolName),
      };
    }
    allowed = true;
  }
  // 插件自带工具：agent 启动时按能力注册；被动档靠 when 收放，所以「已装载」为真
  if (source === 'qqbot') {
    const declared = effectiveTier === 'active' || metaTool;
    return {
      state: declared ? 'declared' : (effectiveGroup ? 'indexed' : 'disabled'),
      loaded: true,
      declared,
      indexed: !declared && Boolean(effectiveGroup),
      reason: declared ? undefined : (effectiveGroup ? '按需档：装载后下一步才进 schema' : '按需档但没有激活分组，无法点亮'),
    };
  }
  // 宿主能力工具：模块是否进「装配计划」= 已装载（同能力至少一个常驻档工具才会装配）
  if (effectiveCapability) {
    const mounted = mountedCapabilities instanceof Set ? mountedCapabilities.has(effectiveCapability) : false;
    const declared = mounted && effectiveTier === 'active';
    return {
      state: declared ? 'declared' : (effectiveGroup ? 'indexed' : 'disabled'),
      loaded: mounted,
      declared,
      indexed: !declared && Boolean(effectiveGroup),
      reason: mounted
        ? (declared ? undefined : '同模块按需档：装载后下一步才进 schema')
        : '所属插件未装配（同能力没有常驻档工具）',
    };
  }
  // 全局工具（MCP / 第三方 / 画布 / 工作目录等）：只有可 restrict 的名字才受档位约束；
  // 旧实现一律标「已声明」，导致画布工具明明不在 schema 里却显示每轮发送。
  const declared = restrictable === false ? true : effectiveTier === 'active';
  const indexed = !declared && Boolean(effectiveGroup);
  return {
    state: declared ? 'declared' : (indexed ? 'indexed' : 'disabled'),
    loaded: declared,
    declared,
    indexed,
    reason: declared ? undefined
      : (indexed
        ? '按需档：触发词 / qqbot_enable 后本会话可用（下次创建会话时生效）'
        : '按需档但没有可激活分组：要固定可用请把档位改成常驻'),
  };
}

function getTools(ctx) {
  const { config, profile } = resolveProfileFor(ctx, null);
  const settings = settingsFor(config, profile);
  const plan = settings ? safeCall(() => activeMountPlan(settings), [], (err) => {
    ctx.logger?.warn?.('[console] 装配计划计算失败：' + err.message);
  }) : [];
  const mountedCapabilities = new Set((Array.isArray(plan) ? plan : []).map((item) => item.capability));
  const items = discoverTools(ctx.deps, profile?.id || null).map((item) => {
    const base = {
      ...item,
      tier: item.tier || tierOf(item.name, settings),
      group: item.group || groupOfTool(item.name) || null,
      capability: item.capability || capabilityOfTool(item.name) || null,
      classified: item.classified !== false && isClassifiedTier(item.name),
    };
    return {
      ...base,
      ...toolStateOf({
        settings,
        name: base.name,
        source: base.source,
        capability: base.capability,
        tier: base.tier,
        group: base.group,
        restrictable: base.restrictable,
        mountedCapabilities,
      }),
    };
  });
  // 装配摘要：三态计数 + 该配置档应使用的 preset（控制台「工具与技能」页顶部展示）
  const stateSummary = { declared: 0, indexed: 0, disabled: 0, unknown: 0 };
  for (const item of items) {
    const key = item && typeof item.state === 'string' ? item.state : 'unknown';
    stateSummary[key] = (stateSummary[key] || 0) + 1;
  }
  // 「失效」判定：策略里引用了已经不存在的工具/分组（插件卸载、改名、能力被删）。
  // 与工具三态互补：三态描述“发现的工具现在什么状态”，这里描述“策略指向了不存在的工具”。
  const stale = {
    policy: stalePolicyEntries(
      profile ? toolsOf(profile) : { ...DEFAULT_TOOLS_POLICY },
      items.map((item) => item.name),
    ),
  };
  const preset = settings ? safeCall(() => ({
    id: presetIdFor(settings),
    modules: (Array.isArray(plan) ? plan : []).map((item) => item.moduleName),
  }), null, (err) => ctx.logger?.warn?.('[console] preset 计算失败：' + err.message)) : null;
  return {
    items,
    stateSummary,
    stale,
    preset,
    policy: profile ? toolsOf(profile) : { ...DEFAULT_TOOLS_POLICY },
    visible: visibleNames(ctx, profile),
    groups: Object.entries(ACTIVATION_GROUPS).map(([id, group]) => ({
      id,
      label: group.label,
      capability: group.capability || null,
      tools: group.tools.slice(),
    })),
    // 诊断：当前 profile 下每组是否可用（能力开关 + 工具存在）
    groupState: listGroups(settings || {}),
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
  // 档位覆盖：{ 工具名或分组 id: 'active' | 'passive' }；非法值丢弃而不是整体报错
  if (isPlainObject(policy.tiers)) {
    const tiers = {};
    for (const [key, value] of Object.entries(policy.tiers)) {
      const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (text === 'active' || text === 'passive') tiers[String(key).slice(0, 120)] = text;
    }
    data.tools.tiers = tiers;
  }
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

/**
 * 会话诊断：GET /api/tools/sessions?bot=…
 *
 * 每个 live 会话给出「会话内已装载的能力组 / 点名工具 / 真正声明的工具 / 系统提示词字符数」，
 * 回答"为什么这个群这轮用不了生图"这类问题。会话多时按 peer 逐条 assemble，属只读诊断。
 *
 * 注意（2026-11-14）：激活改成会话级粘滞后，groups/tools 是「本会话累计装载」，
 * 不再是「本轮临时激活」——排查时要按这个语义读。
 */
async function getToolSessions(ctx) {
  const botId = queryString(ctx.query, 'bot');
  if (!botId) throw badRequest('缺少 bot 参数');
  const host = safeCall(() => (typeof ctx.deps.getHost === 'function' ? ctx.deps.getHost() : null), null);
  const instance = host && typeof host.runtimeOf === 'function' ? safeCall(() => host.runtimeOf(botId), null) : null;
  if (!instance || !(instance.sessions instanceof Map)) {
    return { items: [], count: 0, note: '该机器人没有运行中的会话（未启动或还没收到消息）' };
  }
  const items = [];
  for (const [peer, record] of instance.sessions.entries()) {
    const state = instance.activation instanceof Map ? instance.activation.get(peer) : null;
    const entry = {
      peer,
      sessionId: record && record.sessionId ? String(record.sessionId) : '',
      groups: state ? [...state.groups].sort() : [],
      tools: state ? [...state.tools].sort() : [],
      declared: [],
      passiveDeclared: [],
      promptChars: 0,
    };
    try {
      const live = await buildLivePromptPreview({ host, rootCtx: ctx.deps.rootCtx, botId, peer, logger: ctx.logger });
      if (live && live.ok) {
        entry.declared = live.tools.map((tool) => tool.name).sort();
        entry.passiveDeclared = live.tools.filter((tool) => tool.tier === 'passive').map((tool) => tool.name).sort();
        entry.promptChars = live.chars;
        entry.sections = live.sections.length;
      }
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    }
    items.push(entry);
  }
  items.sort((a, b) => a.peer.localeCompare(b.peer));
  return { items, count: items.length };
}

/**
 * POST /api/tools/cleanup —— 一键清理「当前环境已不存在」的工具条目。
 *
 * 页面上的失效提示只是诊断；这个接口真正把它们从配置档策略里删掉并落库，
 * 不需要再点一次保存。审计记 tools.cleanup。
 */
async function cleanupTools(ctx) {
  const body = ctx.body || {};
  const profileId = typeof body.profileId === 'string' ? body.profileId : '';
  if (profileId === '') throw badRequest('缺少 profileId');
  const { config, profile } = resolveProfileFor(ctx, profileId);
  const discovered = discoverTools(ctx.deps, profile.id);
  const policy = toolsOf(profile);
  const { next, removed } = cleanupToolsPolicy({ policy, discoveredNames: discovered.map((item) => item.name) });
  if (removed.length === 0) {
    return { ok: true, profileId: profile.id, removed: [], policy };
  }
  const updated = guard(() => config.updateProfile(profile.id, { data: { tools: next } }));
  audit(ctx.deps, { kind: 'tools.cleanup', botId: profile.botId, detail: profile.id + ':' + removed.map((item) => item.name).join(',') });
  return { ok: true, profileId: profile.id, removed, policy: toolsOf(updated) };
}

export const routes = [
  { method: 'GET', path: '/api/tools', handler: getTools },
  { method: 'GET', path: '/api/tools/sessions', handler: getToolSessions },
  { method: 'PUT', path: '/api/tools/policy', handler: putToolsPolicy },
  { method: 'POST', path: '/api/tools/cleanup', handler: cleanupTools },
  { method: 'GET', path: '/api/skills', handler: getSkills },
  { method: 'PUT', path: '/api/skills/policy', handler: putSkillsPolicy },
];
