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

/** 确定性 sessionId：同 bot + peer 永远映射同一个 dsh 会话，重启可 resume。 */
export function sessionIdFor(botId, peer) {
  const digest = crypto.createHash('sha1').update(botId + '|' + peer).digest('hex').slice(0, 16);
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
    this.composer = createPromptComposer({ logger });
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
    const sessionId = sessionIdFor(this.id, peer);
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

  persistSession(record) {
    try {
      this.host.runtime.db.prepare(`INSERT INTO sessions(bot_id, peer, session_id, cwd, created_at, updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(bot_id, peer) DO UPDATE SET session_id = excluded.session_id,
        cwd = excluded.cwd, updated_at = excluded.updated_at`)
        .run(this.id, record.peer, record.sessionId, this.cwd, Date.now(), Date.now());
    } catch (err) {
      this.logger?.warn?.('记录会话失败: ' + errText(err));
    }
  }

  /** 构造 prompt 状态：人设/记忆/知识都从这里按需取，支持热更新。 */
  buildPromptState(peer, settings) {
    const self = this;
    return {
      peer,
      botId: self.id,
      personaText: () => self.readPersona(settings),
      memoryText: () => self.memoryText.get(peer) || '',
      knowledgeText: () => self.knowledgeText.get(peer) || '',
      settings: () => self.settingsFor(peer),
      toolsGuide: (agent) => toolsGuideFor(self.host.ctx, agent),
    };
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
    };
  }

  /** 投递一条用户消息（text + 可选图片块）。 */
  async followup(peer, { text, imageBlocks = [] } = {}) {
    const record = await this.getOrCreate(peer);
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
    ensureDir(this.cwd, this.logger);
    if (this.transport && typeof this.transport.start === 'function') {
      try {
        await this.transport.start();
        this.status = 'ready';
        this.host.runtime.events.emit('bot/status', { botId: this.id, status: this.status });
        return true;
      } catch (err) {
        this.status = 'error';
        this.logger?.error?.('机器人启动失败: ' + errText(err));
        this.host.runtime.events.emit('bot/status', { botId: this.id, status: this.status, error: errText(err) });
        return false;
      }
    }
    this.status = 'no-transport';
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
    const bot = host.bots.get(botId);
    if (!bot) return null;
    let instance = runtimes.get(botId);
    if (!instance) {
      instance = new BotRuntime({ host, bot, logger: logger.child ? logger.child(botId) : logger });
      runtimes.set(botId, instance);
    }
    return instance;
  };

  /** 注册传输层工厂（qq/gateway 在 M3 调用）。 */
  host.registerTransport = (botId, factory) => {
    const instance = host.ensureRuntime(botId);
    if (!instance) throw new Error('bot 不存在: ' + botId);
    instance.transport = factory(instance);
    return instance.transport;
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
