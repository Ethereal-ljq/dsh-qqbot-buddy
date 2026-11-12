/**
 * host/agent —— 机器人宿主：Bot → peer 会话的创建/恢复/投递/回收。
 *
 * 与 v1 的关键差异：
 *  - 每个 bot 有独立 agent cwd（meta.cwd 播种 + workingDirectory.set 兜底），不再共用一个目录；
 *  - prompt 走声明式契约（host/prompt.js），不再 hook assemble；
 *  - 工具策略走 tools.restrict（host/tools.js）；
 *  - 传输层与业务解耦：QQ 网关通过 registerTransport() 注入，host 不 import qq/。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import { getService, requireService, errText } from './services.js';
import { createPromptComposer, toolsGuideFor } from './prompt.js';
import { applyToolPolicy } from './tools.js';
import { recallForPeer } from './recall.js';
import { registerAgentSkillScope } from './skills.js';
import {
  CAPABILITY_TOOLS, PLUGIN_TOOL_NAMES, capabilityOfTool, isPluginToolEnabled, isToolAllowed, resolveCapabilities,
} from '../tools/catalog.js';

/** 某个已知工具为什么不在可见集里（/tools 未开启列表用）。 */
function toolDisabledReason(settings, name) {
  const tools = settings && settings.tools && typeof settings.tools === 'object' ? settings.tools : {};
  const deny = Array.isArray(tools.deny) ? tools.deny : [];
  if (deny.includes(name)) return '被黑名单屏蔽';
  const allow = Array.isArray(tools.allow) ? tools.allow.filter((item) => typeof item === 'string' && item !== '') : [];
  const mode = tools.mode === 'deny' ? 'deny' : 'allow';
  if (mode === 'allow' && allow.length > 0 && !allow.includes(name)) return '不在白名单';
  const capability = capabilityOfTool(name);
  if (capability !== undefined && resolveCapabilities(settings)[capability] !== true) {
    return '能力「' + capability + '」未开启';
  }
  return '被工具策略过滤';
}

/**
 * 确定性 sessionId：同 bot + peer + epoch 映射同一个 dsh 会话，重启可 resume。
 * epoch 由 /new 轮换：epoch 变了 = 全新会话（旧会话留在磁盘，供 /resume 找回）。
 */
/** 字符串归一（召回 query / senderId 入参容错）。 */
const strOf = (value) => (typeof value === 'string' ? value.trim() : '');

export function sessionIdFor(botId, peer, epoch = 0) {
  const digest = crypto.createHash('sha1').update(botId + '|' + peer + '|' + Number(epoch || 0)).digest('hex').slice(0, 16);
  return SessionId('qqbot-' + digest);
}

/** bot 工作目录（必须在 DSH workspace 内）。 */
export function botCwdOf(workspaceRoot, botId) {
  return path.join(path.resolve(workspaceRoot), 'bots', botId);
}

function ensureDir(dir, logger) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (err) {
    logger?.warn?.('创建 bot 目录失败 ' + dir + ': ' + errText(err));
  }
}

/**
 * agent 上「插件作用域工具已挂载」的标记。
 *
 * 为什么需要：实测发现重启后部分被 resume 的会话会丢掉全部插件工具（36 -> 7），
 * 只剩其它 bundle 自己的工具，模型于是说「这轮没挂工具」。
 * 这里加一个自愈：setup 成功挂载后打标记；每轮投递前检查，缺了就补挂一次。
 */
const TOOLS_MOUNTED = Symbol.for('qqbot-buddy.toolsMounted');

function parseSettingsModel(settings) {
  const model = (settings && settings.model) || {};
  const route = {};
  if (typeof model.provider === 'string' && model.provider.trim() !== '') route.provider = model.provider.trim();
  if (typeof model.model === 'string' && model.model.trim() !== '') route.model = model.model.trim();
  if (typeof model.reasoningEffort === 'string' && model.reasoningEffort.trim() !== '') route.reasoningEffort = model.reasoningEffort.trim();
  return Object.keys(route).length > 0 ? route : null;
}

/**
 * 单个机器人的运行时。
 */
class BotRuntime {
  constructor({ host, bot, logger }) {
    this.host = host;
    this.id = bot.id;
    this.bot = bot;
    this.logger = logger;
    this.cwd = bot.cwd || botCwdOf(host.workspaceRoot, bot.id);
    this.sessions = new Map();
    this.transport = null;
    this.status = 'idle';
    this.startedAt = 0;
    // 最近一次启动/运行错误的可读原因（控制台 actions 会透传给前端）
    this.lastError = '';
    // 每轮召回结果（prompt 变量从这里读；peer → 文本）
    this.memoryText = new Map();
    this.knowledgeText = new Map();
    this.membersText = new Map();
    this.composer = createPromptComposer({ logger });
    /** peer -> { agentCtx, agent }：setup 时保存，供提示词预览/诊断用 */
    this.promptRefs = new Map();
  }

  /**
   * 当前 peer 的工具/技能总览（/tools、/skills 命令 + 诊断用）：
   * 同时返回"已开启"与"未开启（被能力开关/白名单/黑名单/策略过滤）"，命令据此做分组 markdown。
   *
   * 工具优先取 live agent 的 tools.view（preset/restrict 之后的真实可见集）；
   * agent 还没创建时按能力开关估算（与 mountPlan 一致）。
   * @returns {Promise<{
   *   source:'agent'|'capability',
   *   tools:string[],
   *   disabledTools:{name:string, reason:string}[],
   *   skills:{name:string, description:string, modelInvocable?:boolean}[],
   *   disabledSkills:{name:string, description:string, reason:string}[]
   * }>}
   */
  async visibility(peer = '') {
    const settings = this.settingsFor(peer);
    const ref = this.promptRefs ? this.promptRefs.get(peer) : null;
    const visible = new Set();
    const known = new Set();
    let source = 'capability';
    try {
      if (ref && ref.agentCtx && ref.agentCtx.tools && typeof ref.agentCtx.tools.view === 'function') {
        const view = ref.agentCtx.tools.view(ref.agent);
        const visibleMap = view && view.visible instanceof Map ? view.visible : null;
        if (visibleMap) {
          for (const name of visibleMap.keys()) visible.add(String(name));
          if (visibleMap.size > 0) source = 'agent';
        }
        const knownNames = view && view.knownNames instanceof Set ? view.knownNames : null;
        if (knownNames) for (const name of knownNames) known.add(String(name));
      }
    } catch { /* 落到能力估算 */ }
    for (const list of Object.values(CAPABILITY_TOOLS)) for (const name of list) known.add(name);
    for (const name of PLUGIN_TOOL_NAMES) known.add(name);
    if (visible.size === 0) {
      const caps = resolveCapabilities(settings);
      for (const [capability, list] of Object.entries(CAPABILITY_TOOLS)) {
        if (caps[capability] !== true) continue;
        for (const name of list) if (isToolAllowed({ settings, name })) visible.add(name);
      }
      for (const name of PLUGIN_TOOL_NAMES) {
        if (isPluginToolEnabled({ settings, name })) visible.add(name);
      }
    }
    const disabledTools = [];
    for (const name of [...known].sort()) {
      if (visible.has(name)) continue;
      disabledTools.push({ name, reason: toolDisabledReason(settings, name) });
    }

    // 技能：agent 作用域视图 = 过滤后的（已开启）；根视图 = 全部（用于算未开启）
    const skills = [];
    const allSkills = [];
    try {
      const rootCtx = this.host && this.host.ctx;
      const scoped = ref && ref.agentCtx && typeof ref.agentCtx.get === 'function' ? ref.agentCtx.get('skills') : undefined;
      const rootService = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('skills') : undefined;
      const readList = async (service, opts) => {
        if (!service || typeof service.list !== 'function') return [];
        const res = await service.list(opts);
        return Array.isArray(res) ? res : (res && Array.isArray(res.skills) ? res.skills : []);
      };
      const scopedList = await readList(scoped, { cwd: this.cwd, ...(ref ? { scope: ref.agent } : {}) });
      for (const item of scopedList) {
        if (!item || typeof item.name !== 'string' || item.name === '') continue;
        skills.push({
          name: item.name,
          description: typeof item.description === 'string' ? item.description : '',
          modelInvocable: !(item.invocation && item.invocation.modelInvocable === false),
        });
      }
      const rootList = await readList(rootService, { cwd: this.cwd });
      for (const item of rootList) {
        if (!item || typeof item.name !== 'string' || item.name === '') continue;
        allSkills.push({
          name: item.name,
          description: typeof item.description === 'string' ? item.description : '',
          modelInvocable: !(item.invocation && item.invocation.modelInvocable === false),
        });
      }
    } catch { /* 技能服务不可用时返回空 */ }
    const enabledSkillNames = new Set(skills.map((item) => item.name));
    const toolsSettings = settings && settings.tools && typeof settings.tools === 'object' ? settings.tools : {};
    const skillAllow = Array.isArray(toolsSettings.skills) ? toolsSettings.skills.filter((name) => typeof name === 'string' && name !== '') : [];
    const disabledSkills = allSkills
      .filter((item) => !enabledSkillNames.has(item.name))
      .map((item) => ({
        ...item,
        reason: skillAllow.length > 0 && toolsSettings.skillsMode !== 'all' ? '不在技能白名单' : '技能未加载',
      }));
    skills.sort((a, b) => a.name.localeCompare(b.name));
    disabledSkills.sort((a, b) => a.name.localeCompare(b.name));
    return { source, tools: [...visible].sort(), disabledTools, skills, disabledSkills };
  }

  /** 取生效设置（按 peer）。 */
  settingsFor(peer) {
    try { return this.host.runtime.config.getEffectiveSettings(this.id, peer); } catch { return {}; }
  }

  /** 取或创建某 peer 的 agent 会话。 */
  async getOrCreate(peer) {
    const existing = this.sessions.get(peer);
    if (existing) return existing;
    const inflight = this.host.creating.get(this.id + '|' + peer);
    if (inflight) return inflight;
    const creation = this.createSession(peer).finally(() => this.host.creating.delete(this.id + '|' + peer));
    this.host.creating.set(this.id + '|' + peer, creation);
    return creation;
  }

  async createSession(peer) {
    const agents = requireService(this.host.ctx, 'agents');
    const settings = this.settingsFor(peer);
    const epoch = this.readEpoch(peer);
    const sessionId = sessionIdFor(this.id, peer, epoch);
    const route = parseSettingsModel(settings);
    const presetId = (settings.model && settings.model.preset) || 'qqbot-buddy';
    const state = this.buildPromptState(peer, settings);
    const setup = this.buildSetup(state, presetId);
    const agentOptions = route ? { agentOptions: route } : {};

    let agent;
    let handle;
    let live;
    try { live = typeof agents.get === 'function' ? agents.get(sessionId) : undefined; } catch { live = undefined; }

    if (live) {
      agent = live;
      handle = { agent: live, dispose: async () => {} };
    } else {
      try {
        const resumed = await agents.resume(Object.assign({ resumeSessionId: sessionId, setup }, agentOptions));
        agent = resumed.agent;
        handle = resumed;
      } catch (resumeErr) {
        this.logger?.debug?.('恢复会话失败，改为新建: ' + errText(resumeErr));
        const meta = { cwd: this.cwd, agentPreset: presetId };
        const created = await agents.create(Object.assign({ sessionId, meta, setup }, agentOptions));
        agent = created.agent;
        handle = created;
      }
    }

    // 兜底：确保 agent 的工作目录就是本 bot 的目录（resume 的旧会话可能还是旧 cwd）
    await this.applyWorkingDirectory(agent);

    const record = { peer, sessionId: String(sessionId), agent, handle, state, settings, lastActivity: Date.now() };
    this.sessions.set(peer, record);
    this.persistSession(record);
    this.host.indexSession(record, this);
    return record;
  }

  async applyWorkingDirectory(agent) {
    try {
      const service = getService(this.host.ctx, 'workingDirectory');
      if (!service || typeof service.ensure !== 'function') return;
      const current = await service.ensure(agent);
      if (path.resolve(String(current)) !== path.resolve(this.cwd) && typeof service.set === 'function') {
        await service.set(agent, this.cwd);
        this.logger?.info?.('已切换会话工作目录: ' + this.cwd);
      }
    } catch (err) {
      this.logger?.warn?.('设置会话工作目录失败（沿用宿主默认）: ' + errText(err));
    }
  }

  /** 读 peer 的会话 epoch（无记录 = 0）。 */
  readEpoch(peer) {
    try {
      const row = this.host.runtime.db.prepare('SELECT epoch FROM sessions WHERE bot_id = ? AND peer = ?').get(this.id, peer);
      return row && Number.isFinite(Number(row.epoch)) ? Number(row.epoch) : 0;
    } catch { return 0; }
  }

  /**
   * /new：轮换 epoch 并释放当前 agent。下一次 getOrCreate 会创建全新会话，
   * 旧会话的持久化记录仍在磁盘上（sessionId 不同），可被 /resume 找回。
   * @returns {{ok: boolean, epoch: number, oldSessionId: string, newSessionId: string}}
   */
  async reset(peer) {
    const current = this.sessions.get(peer);
    const oldSessionId = current ? String(current.sessionId) : '';
    const nextEpoch = this.readEpoch(peer) + 1;
    try {
      this.host.runtime.db.prepare(`INSERT INTO sessions(bot_id, peer, session_id, cwd, epoch, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(bot_id, peer) DO UPDATE SET session_id = excluded.session_id,
        cwd = excluded.cwd, epoch = excluded.epoch, updated_at = excluded.updated_at`)
        .run(this.id, peer, sessionIdFor(this.id, peer, nextEpoch).toString(), this.cwd, nextEpoch, Date.now(), Date.now());
    } catch (err) {
      this.logger?.warn?.('轮换会话 epoch 失败: ' + errText(err));
      return { ok: false, epoch: nextEpoch - 1, oldSessionId, newSessionId: '' };
    }
    if (current) {
      this.sessions.delete(peer);
      try { this.host.sessionIndex.delete(String(current.sessionId)); } catch { /* ignore */ }
      try { await current.handle?.dispose?.(); } catch (err) { this.logger?.warn?.('释放旧会话失败: ' + errText(err)); }
    }
    this.host.runtime.events?.emit('peer/reset', { botId: this.id, peer, epoch: nextEpoch });
    return { ok: true, epoch: nextEpoch, oldSessionId, newSessionId: sessionIdFor(this.id, peer, nextEpoch).toString() };
  }

  persistSession(record) {
    try {
      const epoch = this.readEpoch(record.peer);
      this.host.runtime.db.prepare(`INSERT INTO sessions(bot_id, peer, session_id, cwd, epoch, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(bot_id, peer) DO UPDATE SET session_id = excluded.session_id,
        cwd = excluded.cwd, updated_at = excluded.updated_at`)
        .run(this.id, record.peer, record.sessionId, this.cwd, epoch, Date.now(), Date.now());
    } catch (err) {
      this.logger?.warn?.('记录会话失败: ' + errText(err));
    }
  }

  /** 构造 prompt 状态：人设/记忆/知识都从这里按需取，支持热更新。 */
  buildPromptState(peer, settings) {
    const self = this;
    const state = {
      peer,
      botId: self.id,
      // setup 时会写入 agentCtx：工具指引必须在 agent scope 里读 view（插件 ctx 没有 tools 代理）
      agentCtx: null,
      personaText: () => self.readPersona(settings),
      membersText: () => self.membersText.get(peer) || '',
      memoryText: () => self.memoryText.get(peer) || '',
      knowledgeText: () => self.knowledgeText.get(peer) || '',
      settings: () => self.settingsFor(peer),
      toolsGuide: (agent) => toolsGuideFor(state.agentCtx || self.host.ctx, agent),
    };
    return state;
  }

  readPersona(settings) {
    try {
      const activeId = settings && settings.persona ? settings.persona.activeCardId : '';
      if (activeId) {
        const row = this.host.runtime.db.prepare('SELECT content FROM personas WHERE id = ? AND bot_id = ?').get(activeId, this.id);
        if (row && row.content) return String(row.content);
      }
      const file = path.join(this.cwd, 'persona.md');
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    } catch (err) {
      this.logger?.warn?.('读取人设失败: ' + errText(err));
    }
    return '';
  }

  /** setup 钩子：create/resume 共用，任何一步失败都不阻断 agent 创建。 */
  buildSetup(state, presetId) {
    return async (agentCtx, agent) => {
      // 供 prompt 变量在 assembly 时读取 agent scope 的工具视图
      state.agentCtx = agentCtx;
      // 供控制台「提示词拼合预览」/诊断取 agent scope 视图
      try { this.promptRefs.set(state.peer, { agentCtx, agent }); } catch { /* ignore */ }
      // 技能白名单按 agent 过滤：provider.list({scope}) 从这里查 bot/peer 的生效设置
      try {
        registerAgentSkillScope(agent, { runtime: this.host && this.host.runtime, botId: this.id, peer: state.peer });
      } catch { /* ignore */ }
      // 1. preset（工具集/压缩策略由 preset 提供；不存在则用宿主默认）
      try {
        const presets = getService(this.host.ctx, 'agentPresets');
        if (presets && typeof presets.mount === 'function') await presets.mount(agentCtx, presetId);
      } catch (err) {
        this.logger?.warn?.('preset 挂载失败（继续）: ' + errText(err));
      }
      // 2. 工具策略（agent scope 内 restrict）
      try {
        const settings = state.settings();
        if (agentCtx && agentCtx.tools) applyToolPolicy(agentCtx, agent, { settings, logger: this.logger });
      } catch (err) {
        this.logger?.warn?.('工具策略应用失败（跳过）: ' + errText(err));
      }
      // 3. prompt 契约
      try {
        this.composer.mount(agentCtx, agent, state);
      } catch (err) {
        this.logger?.warn?.('prompt 挂载失败（跳过）: ' + errText(err));
      }
      // 4. 插件作用域工具（qqbot_* / memory_* 等由工具工厂注册到本 agent scope，
      //    不受 tools.restrict 影响，随 agent 生命周期释放）
      if (typeof this.host.toolFactory === 'function') {
        try {
          await this.host.toolFactory({
            agentCtx,
            agent,
            runtime: this,
            settings: state.settings(),
            peer: state.peer,
            botId: this.id,
          });
          try { agent[TOOLS_MOUNTED] = true; } catch { /* ignore */ }
        } catch (err) {
          this.logger?.warn?.('注册作用域工具失败（跳过）: ' + errText(err));
        }
      } else {
        // 以前这里是静默跳过，导致「掉工具」时日志里什么都看不到
        this.logger?.warn?.('host.toolFactory 未就绪，本轮 agent 不会挂插件工具（等待自愈补挂）');
      }
    };
  }

  /**
   * 投递一条用户消息（text + 可选图片块）。
   * recallQuery 是本轮用户原话：prompt 召回必须用它，不能用拼了 chat history 的 text，
   * 否则 FTS 检索整段长文本基本零命中（记忆/知识"没注入"的根因）。senderId 用于群友库。
   */
  /**
   * 自愈：确保这个 agent 挂上了插件作用域工具。
   *
   * 实测（2026-11-11）：服务重启后，部分被 resume 的会话 agent 只拿到 7 个工具
   * （其它 bundle 的 image-gen 工具），我们的 qqbot_* / memory_* 全丢，
   * 模型就会说「这轮没挂工具」。这里在每轮投递前做一次廉价检查，缺了就补挂。
   *
   * @param {object} record BotRuntime 会话记录
   * @param {{force?: boolean}} [options] force=true 时无视「已挂载」标记强制重挂（手动自愈用）
   * @returns {Promise<boolean>} 是否执行了补挂
   */
  async ensureAgentTools(record, { force = false } = {}) {
    try {
      if (!record || !record.agent) return false;
      if (force !== true && record.agent[TOOLS_MOUNTED] === true) return false;
      if (typeof this.host.toolFactory !== 'function') return false;
      const ref = this.promptRefs ? this.promptRefs.get(record.peer) : null;
      const agentCtx = ref && ref.agentCtx ? ref.agentCtx : null;
      if (!agentCtx || !agentCtx.tools) {
        // 以前这里静默 return：当 resume 后的 agent 没有 setup 上下文时，插件工具会一直缺失，
        // 模型看不到 qqbot_* / memory_*，只能按命名习惯瞎猜（线上出现过连续 20+ 分钟）。
        // 每个 peer 只告警一次，提示用 /heal（强制重建）或在控制台重置会话。
        if (!this.toolScopeWarned) this.toolScopeWarned = new Set();
        if (!this.toolScopeWarned.has(record.peer)) {
          this.toolScopeWarned.add(record.peer);
          this.logger?.warn?.('插件工具自愈未执行：缺少 agent scope（peer=' + record.peer
            + '），本轮可能看不到 qqbot_* 工具；请发送 /heal 或在控制台重置会话');
        }
        return false;
      }
      if (this.toolScopeWarned) this.toolScopeWarned.delete(record.peer);
      this.logger?.warn?.('检测到 agent 缺少插件工具（peer=' + record.peer + '），正在补挂');
      await this.host.toolFactory({
        agentCtx,
        agent: record.agent,
        runtime: this,
        settings: this.settingsFor(record.peer),
        peer: record.peer,
        botId: this.id,
      });
      try { record.agent[TOOLS_MOUNTED] = true; } catch { /* ignore */ }
      this.logger?.info?.((force === true ? '插件工具已重新挂载' : '插件工具补挂完成') + '（peer=' + record.peer + '）');
      return true;
    } catch (err) {
      this.logger?.warn?.('补挂插件工具失败（不影响回复）: ' + errText(err));
      return false;
    }
  }

  async followup(peer, { text, imageBlocks = [], recallQuery, senderId } = {}) {
    const record = await this.getOrCreate(peer);
    // 工具自愈：resume 后可能丢插件工具，每轮先廉价检查一次
    await this.ensureAgentTools(record);
    // 每轮按当前消息召回长期记忆/知识库/群友库（失败不影响投递）
    try {
      const query = strOf(recallQuery) !== '' ? strOf(recallQuery) : String(text || '');
      const recalled = await recallForPeer({
        memory: this.host.runtime.memory,
        knowledge: this.host.runtime.kb,
        members: this.host.runtime.members,
        settings: this.settingsFor(peer),
        botId: this.id,
        query,
        senderId,
      });
      if (recalled.memoryText) this.memoryText.set(peer, recalled.memoryText); else this.memoryText.delete(peer);
      if (recalled.knowledgeText) this.knowledgeText.set(peer, recalled.knowledgeText); else this.knowledgeText.delete(peer);
      if (recalled.memberText) this.membersText.set(peer, recalled.memberText); else this.membersText.delete(peer);
    } catch (err) {
      this.logger?.warn?.('记忆/知识/群友召回失败（跳过）: ' + errText(err));
    }
    const content = imageBlocks.length > 0
      ? [{ type: 'text', text: String(text || '') }, ...imageBlocks]
      : [{ type: 'text', text: String(text || '') }];
    const message = createUserMessage({ content, source: { kind: 'user' } });
    try {
      await record.agent.followup(message);
      record.lastActivity = Date.now();
      return { ok: true };
    } catch (err) {
      this.logger?.error?.('followup 失败: ' + errText(err));
      return { ok: false, error: errText(err) };
    }
  }

  /** 等待当前 turn 结束（供传输层串行化）。 */
  async whenIdle(peer) {
    const record = this.sessions.get(peer);
    if (!record) return;
    const agent = record.agent;
    if (typeof agent.whenIdle === 'function') await agent.whenIdle();
  }

  async start() {
    this.status = 'starting';
    this.startedAt = Date.now();
    // 刷新最新凭据/名称（控制台可能刚改过）
    try {
      const fresh = this.host.runtime.config.getBot(this.id);
      if (fresh) this.bot = { ...this.bot, ...fresh };
    } catch { /* ignore */ }
    ensureDir(this.cwd, this.logger);
    if (this.transport && typeof this.transport.start === 'function') {
      try {
        await this.transport.start();
        this.status = 'ready';
        this.lastError = '';
        this.host.runtime.events.emit('bot/status', { botId: this.id, status: this.status });
        return true;
      } catch (err) {
        this.status = 'error';
        this.lastError = errText(err);
        this.logger?.error?.('机器人启动失败: ' + errText(err));
        this.host.runtime.events.emit('bot/status', { botId: this.id, status: this.status, error: errText(err) });
        return false;
      }
    }
    this.status = 'no-transport';
    this.lastError = '没有可用的传输层（QQ 网关未装配或启动失败）';
    this.logger?.warn?.('机器人 ' + this.id + ' 没有传输层（QQ 网关未注册）');
    return false;
  }

  async dispose() {
    try { await this.transport?.stop?.(); } catch (err) { this.logger?.warn?.('停止传输失败: ' + errText(err)); }
    for (const record of this.sessions.values()) {
      try { this.host.sessionIndex.delete(String(record.sessionId)); } catch { /* ignore */ }
      try { await record.handle?.dispose?.(); } catch (err) { this.logger?.warn?.('释放会话失败: ' + errText(err)); }
    }
    this.sessions.clear();
    this.status = 'stopped';
  }

  snapshot() {
    return {
      id: this.id,
      name: this.bot.name,
      appId: this.bot.appId,
      enabled: this.bot.enabled,
      cwd: this.cwd,
      status: this.status,
      lastError: this.lastError || null,
      startedAt: this.startedAt,
      sessions: this.sessions.size,
    };
  }
}

/**
 * 创建机器人宿主。
 * @param {{ctx: object, runtime: object, config: object, logger: object}} options
 */
export async function createBotHost({ ctx, runtime, config, logger }) {
  const host = {
    ctx,
    runtime,
    config,
    logger,
    workspaceRoot: runtime.paths.workspaceRoot,
    bots: new Map(),
    creating: new Map(),
    composers: {},
    // sessionId → { botId, peer, runtime }：出站分发（QQ 发送）按 sessionId 反查
    sessionIndex: new Map(),
  };

  function reloadBots() {
    let list = [];
    try { list = runtime.config.listBots(); } catch (err) { logger.warn('读取机器人列表失败: ' + errText(err)); }
    for (const bot of list) host.bots.set(bot.id, bot);
    return list;
  }

  host.list = () => [...host.bots.values()];
  host.get = (botId) => host.bots.get(botId) || null;
  host.runtimes = () => [...host.bots.values()].map((bot) => host.runtimeOf(bot.id)).filter(Boolean);

  const runtimes = new Map();
  host.runtimeOf = (botId) => runtimes.get(botId) || null;

  host.indexSession = (record, runtime) => {
    if (record && record.sessionId) host.sessionIndex.set(record.sessionId, { botId: runtime.id, peer: record.peer, runtime });
  };

  /** 按 dsh sessionId 反查归属（出站事件分发用）。 */
  host.findSession = (sessionId) => host.sessionIndex.get(String(sessionId)) || null;

  host.ensureRuntime = (botId) => {
    let bot = host.bots.get(botId) || null;
    if (!bot) {
      // 控制台/CLI 运行期新建的 bot 不在启动时的内存快照里：回源 DB（getBot 含 appSecret）
      try {
        const found = runtime.config.getBot(botId);
        if (found) { bot = found; host.bots.set(botId, bot); }
      } catch { /* ignore */ }
    }
    if (!bot) return null;
    let instance = runtimes.get(botId);
    if (!instance) {
      instance = new BotRuntime({ host, bot, logger: logger.child ? logger.child(botId) : logger });
      runtimes.set(botId, instance);
      // 懒挂载传输层：控制台/CLI 运行期新建的 bot 也能直接 start
      if (typeof host.transportFactory === 'function' && !instance.transport) {
        try { instance.transport = host.transportFactory(instance); } catch (err) {
          logger.warn('挂载传输层失败 ' + botId + ': ' + errText(err));
        }
      }
    }
    return instance;
  };

  /** 注册传输层工厂（qq/gateway）：对已存在与之后新建的 bot 都生效。 */
  host.registerTransport = (botId, factory) => {
    const instance = host.ensureRuntime(botId);
    if (!instance) throw new Error('bot 不存在: ' + botId);
    instance.transport = factory(instance);
    return instance.transport;
  };

  /** 设置全局传输工厂：之后 ensureRuntime 自动挂载（控制台新建的 bot 也能启动）。 */
  host.setTransportFactory = (factory) => {
    host.transportFactory = typeof factory === 'function' ? factory : null;
    for (const instance of runtimes.values()) {
      if (!instance.transport && host.transportFactory) {
        try { instance.transport = host.transportFactory(instance); } catch (err) {
          logger.warn('挂载传输层失败 ' + instance.id + ': ' + errText(err));
        }
      }
    }
  };

  /** 设置工具工厂：每个 agent setup 时调用，用于注册 qqbot_* 等作用域工具。 */
  host.setToolFactory = (factory) => {
    host.toolFactory = typeof factory === 'function' ? factory : null;
  };

  /** /new：轮换某 peer 的会话 epoch 并释放当前 agent。 */
  host.resetPeer = async (botId, peer) => {
    const instance = host.ensureRuntime(botId);
    if (!instance) throw new Error('bot 不存在: ' + botId);
    return instance.reset(peer);
  };

  host.startAll = async () => {
    const list = reloadBots();
    const results = [];
    for (const bot of list) {
      if (bot.enabled !== true) continue;
      const instance = host.ensureRuntime(bot.id);
      if (!instance) continue;
      try { results.push({ botId: bot.id, ok: await instance.start() }); } catch (err) {
        logger.warn('启动机器人异常 ' + bot.id + ': ' + errText(err));
        results.push({ botId: bot.id, ok: false });
      }
    }
    return results;
  };

  host.disposeAll = async () => {
    const jobs = [];
    for (const instance of runtimes.values()) jobs.push(instance.dispose().catch((err) => logger.warn('释放机器人失败: ' + errText(err))));
    await Promise.all(jobs);
    runtimes.clear();
  };

  host.snapshot = () => [...host.bots.values()].map((bot) => {
    const instance = runtimes.get(bot.id);
    return instance ? instance.snapshot() : { id: bot.id, name: bot.name, enabled: bot.enabled, status: 'idle', cwd: bot.cwd };
  });

  reloadBots();
  return host;
}

export default createBotHost;
