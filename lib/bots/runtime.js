/**
 * bots/runtime —— 一个机器人的完整运行时（多机器人 = 多个 runtime）。
 *
 * 与旧版 index.js 的差别：这里不再读全局 config 的 appId/cwd/stateDir 作为唯一来源，
 * 而是按「机器人记录 + 工作区目录」装配一整套独立组件：
 *   settings / persona / memory / knowledge / members / stickers / collector
 *   / prompt / gateState / manager / gateway / binding
 *
 * 所有组件都保持原来的工厂签名（settings 仍然是各个 store 的唯一配置来源），
 * 因此单个机器人的行为与 v0.15 单机器人完全一致；多机器人只是把工厂调用 N 次。
 *
 * 容错原则：知识库/群友库等模块未就绪或损坏时降级为 stub，绝不让一个机器人
 * 装配失败拖垮整个插件（与旧版 memory 动态 import 降级的做法一致）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { VERSION, readVersion } from '../version.js';
import { resolveDefaults, createSettingsStore } from '../settings-store.js';
import { createPersonaStore } from '../persona-store.js';
import { createPromptComposer } from '../prompt.js';
import { createGateState } from '../qq/gate.js';
import { SessionManager } from '../qq/session-manager.js';
import { createGateway } from '../qq/gateway.js';
import { createToolCatalog } from '../tools/catalog.js';
import { createEmergence } from '../context/emergence.js';
import { createKnowledgeExtractor } from '../knowledge/auto-extract.js';
import { registerScopedTools } from './scoped-tools.js';
import {
  checkPathsWithinWorkspace, describePaths, editableDirKeys, ensureBotDirs, resolveBotPaths,
} from './paths.js';

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
function errText(err) { return err instanceof Error ? err.message : String(err); }

/** 条目类 store 不可用时的最小 stub（保证 prompt/工具/路由不炸）。 */
function createEntryStub(reason, kind) {
  const error = (kind === 'member' ? '群友库' : '知识库') + '不可用: ' + (reason || '未安装');
  const emptyList = () => ({ total: 0, items: [] });
  return {
    available: false,
    error: error,
    kind: kind || 'knowledge',
    ensure: () => ({ ok: false, error: error }),
    dir: () => '',
    get: () => null,
    save: () => ({ ok: false, error: error }),
    remove: () => ({ ok: false, error: error }),
    list: emptyList,
    search: () => [],
    recall: () => [],
    recallAlly: () => [],
    visit: () => ({ ok: false, error: error }),
    groups: () => [],
    stats: () => ({ total: 0, byScope: {}, tags: [], updatedAt: 0 }),
  };
}

/** 安全动态 import。 */
async function loadModule(specifier, exportName) {
  const mod = await import(specifier);
  if (!mod || typeof mod[exportName] !== 'function') throw new Error('缺少 ' + exportName + ' 导出');
  return mod;
}

/**
 * 装配一个机器人运行时。
 * @param {object} args
 * @param {object} args.ctx cordis 上下文
 * @param {object} args.host createBotHost 返回的宿主（提供 registry / agentMap / config）
 * @param {object} args.record 机器人记录（id/name/workspaceDir/legacy）
 * @param {object} args.config 插件部署配置（cfg）
 * @param {object} args.logger
 * @param {() => object} [args.defaultBot] 工具路由兜底（未使用）
 */
export async function createBotRuntime({ ctx, host, record, config = {}, logger } = {}) {
  const log = logger || console;
  const registry = host.registry;
  const agentMap = host.agentMap;
  const botId = record.id;
  const paths = resolveBotPaths({ workspaceDir: record.workspaceDir, config: config, record: record });
  try {
    ensureBotDirs(paths);
  } catch (err) {
    log.warn('[bot:' + botId + '] 创建工作区目录失败: ' + errText(err));
  }

  // ── settings / persona ────────────────────────────────
  const defaults = resolveDefaults({ cwd: paths.workspaceDir });
  const settings = createSettingsStore({ file: paths.settingsFile, defaults: defaults, logger: log });
  const persona = createPersonaStore({ settings: settings, stateDir: paths.stateDir, logger: log });

  let personaCards;
  try {
    const mod = await loadModule('../persona-cards-store.js', 'createPersonaCardsStore');
    personaCards = mod.createPersonaCardsStore({
      settings: settings, personaStore: persona, cwd: paths.workspaceDir, logger: log,
    });
  } catch (err) {
    log.warn('[bot:' + botId + '] 人格卡功能降级: ' + errText(err));
    personaCards = undefined;
  }

  // ── memory ────────────────────────────────────────────
  let memory;
  try {
    const mod = await loadModule('../memory/store.js', 'createMemoryStore');
    memory = mod.createMemoryStore({ settings: settings, logger: log });
    memory.ensure();
  } catch (err) {
    log.warn('[bot:' + botId + '] 记忆模块降级: ' + errText(err));
    memory = {
      available: false,
      ensure: () => ({ ok: false, created: false }),
      hotText: () => '',
      layout: () => ({ dir: '', exists: false, files: [], totalChars: 0 }),
      search: () => [],
      recall: () => [],
      stats: () => ({ facts: 0, hotEntries: 0, chars: 0 }),
      saveFact: () => ({ ok: false, error: errText(err) }),
      appendDaily: () => ({ ok: false, error: errText(err) }),
      readFile: () => { throw new Error(errText(err)); },
      writeFile: () => ({ ok: false, error: errText(err) }),
      index: () => ({ facts: [] }),
    };
  }

  // ── knowledge / members（复用条目库；模块未就绪时 stub） ──
  let knowledge;
  try {
    const mod = await loadModule('../knowledge/store.js', 'createKnowledgeStore');
    knowledge = mod.createKnowledgeStore({ settings: settings, logger: log });
    if (typeof knowledge.ensure === 'function') knowledge.ensure();
  } catch (err) {
    log.warn('[bot:' + botId + '] 知识库降级: ' + errText(err));
    knowledge = createEntryStub(errText(err), 'knowledge');
  }
  let members;
  try {
    const mod = await loadModule('../members/store.js', 'createMemberStore');
    members = mod.createMemberStore({ settings: settings, logger: log });
    if (typeof members.ensure === 'function') members.ensure();
  } catch (err) {
    log.warn('[bot:' + botId + '] 群友库降级: ' + errText(err));
    members = createEntryStub(errText(err), 'member');
  }

  // ── stickers ──────────────────────────────────────────
  let stickers;
  let stickersDir = path.join(paths.workspaceDir, 'stickers');
  try {
    const mod = await loadModule('../stickers/store.js', 'createStickerStore');
    stickers = mod.createStickerStore({ settings: settings, logger: log });
    stickers.ensure();
    const fromStore = typeof stickers.dir === 'function' ? stickers.dir() : '';
    if (typeof fromStore === 'string' && fromStore.trim() !== '') stickersDir = fromStore;
  } catch (err) {
    log.warn('[bot:' + botId + '] 表情包功能降级: ' + errText(err));
    stickers = undefined;
  }

  // ── collector ─────────────────────────────────────────
  let collector;
  try {
    const mod = await loadModule('../memory/collector.js', 'createCollector');
    collector = mod.createCollector({ ctx: ctx, settings: settings, memoryStore: memory, logger: log });
  } catch (err) {
    log.warn('[bot:' + botId + '] 记忆收集降级: ' + errText(err));
    collector = {
      noteTurnEnd: () => {},
      async collectNow() { return { ok: false, added: [], scannedMessages: 0, error: errText(err) }; },
      stats: () => ({ enabled: false, roundsSinceCollect: 0, lastCollectAt: 0, lastResult: null, lastError: errText(err), totalCollected: 0 }),
    };
  }

  // ── 能力目录 / 提示词 / 涌现 ──────────────────────────
  const toolCatalog = createToolCatalog({ settings: settings, cwd: paths.workspaceDir, logger: log });
  const emergence = createEmergence({
    settings: settings, memory: memory, knowledge: knowledge, members: members, logger: log,
  });
  const promptComposer = createPromptComposer({
    settings: settings,
    personaStore: persona,
    memoryStore: memory,
    stickerStore: stickers,
    logger: log,
    catalog: toolCatalog,
    emergence: emergence,
  });
  const gateState = createGateState();
  const stats = {
    received: 0, triggered: 0, skipped: 0, replies: 0, lastReplyAt: 0, lastTriggerReason: '',
  };

  // ── 凭据 / 每个机器人的配置视图 ───────────────────────
  const credentials = registry.credentials(botId);
  const botConfig = Object.assign({}, config, {
    botId: botId,
    appId: credentials.appId || '',
    appSecret: credentials.appSecret || '',
    cwd: paths.workspaceDir,
    stateDir: paths.stateDir,
    mediaDir: paths.mediaDir,
    settingsFile: paths.settingsFile,
  });

  const manager = new SessionManager({
    ctx: ctx,
    agents: host.agents,
    config: botConfig,
    settings: settings,
    promptComposer: promptComposer,
    stateDir: paths.stateDir,
    logger: log,
    catalog: toolCatalog,
    botId: botId,
    onAgent: (agent) => agentMap.bind(agent, runtimeRef),
    // 插件工具只注册进本 agent 的作用域（qqbot 预设专用，不污染全局）
    registerScopedTools: (agentCtx) => registerScopedTools(agentCtx, runtimeRef, log),
  });

  // 知识库自动提炼（阶段一：只提炼知识；默认关闭，可在设置页开启/手动触发）
  const knowledgeExtractor = createKnowledgeExtractor({
    ctx: ctx,
    settings: settings,
    knowledge: knowledge,
    members: members,
    logger: log,
    getRoute: () => {
      try {
        const resolved = manager.resolveModelRoute ? manager.resolveModelRoute() : null;
        return resolved && resolved.route && typeof resolved.route === 'object' ? resolved.route : null;
      } catch {
        return null;
      }
    },
  });

  const gateway = createGateway({
    ctx: ctx,
    config: botConfig,
    logger: log,
    settings: settings,
    manager: manager,
    gateState: gateState,
    stats: stats,
    stateDir: paths.stateDir,
    mediaDir: paths.mediaDir,
    collector: collector,
    knowledgeExtractor: knowledgeExtractor,
    members: members,
    registerTools: false,
  });

  // ── 绑定服务（每个机器人独立扫码/手动绑定） ────────────
  let binding = null;
  try {
    const mod = await loadModule('../binding/service.js', 'createBindingService');
    binding = mod.createBindingService({
      logger: log,
      profileDir: config.profileDir || '',
      getCredentials: () => registry.credentials(botId),
      persistCredentials: (creds) => {
        const saved = registry.setCredentials(botId, creds);
        if (!saved.ok) return { ok: false, error: saved.error };
        const next = registry.get(botId);
        if (next) { record.appId = next.appId; record.updatedAt = next.updatedAt; }
        return { ok: true, result: { path: paths.credentialsFile, appId: creds.appId } };
      },
      onBound: async (creds) => {
        botConfig.appId = creds.appId || '';
        botConfig.appSecret = creds.appSecret || '';
        await applyCredentials({ appId: botConfig.appId, appSecret: botConfig.appSecret }, { persist: false });
      },
      onUnbind: async () => {
        botConfig.appId = '';
        botConfig.appSecret = '';
        await applyCredentials({ appId: '', appSecret: '' }, { persist: false });
      },
      source: 'dsh-qqbot-buddy',
    });
  } catch (err) {
    log.warn('[bot:' + botId + '] 绑定服务不可用: ' + errText(err));
    binding = null;
  }

  /** 当前生效的路径（settings 可在运行期覆盖 5 个资源路径）。 */
  function effectivePaths() {
    const cfg = settings.get();
    return Object.assign({}, paths, {
      personaPath: cfg.persona.path,
      memoryDir: cfg.memory.dir,
      knowledgeDir: cfg.knowledge.dir,
      membersDir: cfg.members.dir,
      stickersDir: cfg.stickers.dir,
    });
  }

  /** 目录快照（UI「工作区与文件」）。 */
  function pathSnapshot() {
    const effective = effectivePaths();
    const checked = checkPathsWithinWorkspace(effective);
    return {
      workspaceDir: paths.workspaceDir,
      defaults: {
        persona: path.join(paths.workspaceDir, 'persona.md'),
        memory: path.join(paths.workspaceDir, 'memory'),
        knowledge: path.join(paths.workspaceDir, 'knowledge'),
        members: path.join(paths.workspaceDir, 'members'),
        stickers: path.join(paths.workspaceDir, 'stickers'),
        state: path.join(paths.workspaceDir, '.qqbot', 'state'),
        media: path.join(paths.workspaceDir, '.qqbot', 'media'),
      },
      effective: {
        persona: effective.personaPath,
        memory: effective.memoryDir,
        knowledge: effective.knowledgeDir,
        members: effective.membersDir,
        stickers: effective.stickersDir,
        state: paths.stateDir,
        media: paths.mediaDir,
        settings: paths.settingsFile,
      },
      editable: editableDirKeys(),
      entries: describePaths(effective),
      warnings: checked.warnings,
      withinWorkspace: checked.ok,
    };
  }

  /** 机器人快照（列表/概览用）。 */
  function snapshot() {
    let botInfo = {};
    try { botInfo = gateway.botState(); } catch { botInfo = {}; }
    return {
      id: botId,
      name: record.name,
      appId: botConfig.appId || '',
      bound: (botConfig.appId || '') !== '' && (botConfig.appSecret || '') !== '',
      enabled: record.enabled !== false,
      legacy: record.legacy === true,
      workspaceDir: paths.workspaceDir,
      ready: botInfo.ready === true,
      startedAt: botInfo.startedAt || 0,
      lastError: botInfo.lastError || '',
      sessionCount: manager && typeof manager.size === 'number' ? manager.size : 0,
      pending: Array.isArray(botInfo.pending) ? botInfo.pending : [],
      stats: Object.assign({}, stats),
      dirs: effectivePaths(),
      version: readVersion(),
      model: botInfo.model || null,
    };
  }

  /** 应用凭据：默认先落盘到该机器人，再重连网关。 */
  async function applyCredentials(creds, options = {}) {
    const input = isObj(creds) ? creds : {};
    const nextAppId = typeof input.appId === 'string' ? input.appId.trim() : '';
    const nextAppSecret = typeof input.appSecret === 'string' ? input.appSecret.trim() : '';
    if (options.persist !== false) {
      const saved = registry.setCredentials(botId, { appId: nextAppId, appSecret: nextAppSecret });
      if (!saved.ok) return { ok: false, error: saved.error };
      const next = registry.get(botId);
      if (next) { record.appId = next.appId; record.updatedAt = next.updatedAt; }
    }
    botConfig.appId = nextAppId;
    botConfig.appSecret = nextAppSecret;
    try {
      return await gateway.applyCredentials({ appId: nextAppId, appSecret: nextAppSecret });
    } catch (err) {
      log.error('[bot:' + botId + '] 应用凭据失败: ' + errText(err));
      return { ok: false, error: errText(err) };
    }
  }

  const runtime = {
    // 身份
    id: botId,
    name: record.name,
    record: record,
    botId: botId,
    host: host,
    // 与旧 runtime 同形的字段（web 路由直接复用）
    version: readVersion(),
    getVersion: () => readVersion(),
    config: botConfig,
    ctx: ctx,
    logger: log,
    settings: settings,
    persona: persona,
    personaCards: personaCards,
    memory: memory,
    knowledge: knowledge,
    knowledgeExtractor: knowledgeExtractor,
    members: members,
    emergence: emergence,
    collector: collector,
    promptComposer: promptComposer,
    gateState: gateState,
    manager: manager,
    gateway: gateway,
    stats: stats,
    stateDir: paths.stateDir,
    mediaDir: paths.mediaDir,
    cwd: paths.workspaceDir,
    settingsFile: paths.settingsFile,
    workspaceDir: paths.workspaceDir,
    paths: paths,
    stickersDir: stickersDir,
    stickers: stickers,
    toolCatalog: toolCatalog,
    profileDir: config.profileDir || '',
    binding: binding,
    botState: () => gateway.botState(),
    restartBot: () => gateway.restartBot(),
    clearPending: () => gateway.clearPending(),
    adaptive: gateway.adaptive,
    resetAllSessions: () => manager.resetAll(),
    getModelInfoSync: () => manager.getModelInfoSync(),
    getModelInfo: () => manager.getModelInfo(),
    listModels: () => manager.listModels(),
    listPresets: () => manager.listPresets(),
    presetInfo: () => manager.presetInfo(),
    applyCredentials: applyCredentials,
    snapshot: snapshot,
    pathSnapshot: pathSnapshot,
    /** 把插件工具注册进某个 agent 的 scope（SessionManager setup 调用；测试也用它）。 */
    registerToolsScoped: (agentCtx) => registerScopedTools(agentCtx, runtimeRef, log),
    effectivePaths: effectivePaths,
    /** settings 变更后确保（可能刚改过的）目录存在。 */
    ensureDirs: () => {
      try {
        const cfg = settings.get();
        for (const dir of [cfg.memory.dir, cfg.knowledge.dir, cfg.members.dir, cfg.stickers.dir]) {
          if (typeof dir === 'string' && dir !== '') fs.mkdirSync(dir, { recursive: true });
        }
      } catch (err) {
        log.warn('[bot:' + botId + '] 确保目录失败: ' + errText(err));
      }
    },
    start: async () => {
      if (record.enabled === false) return { ok: false, error: '机器人已停用' };
      return gateway.start();
    },
    stop: async () => {
      try { await gateway.dispose(); } catch (err) { log.warn('[bot:' + botId + '] 停止网关失败: ' + errText(err)); }
    },
    dispose: async () => {
      // 先 flush 条目索引（知识库/群友库延迟写），再停服务
      try { if (knowledge && typeof knowledge.flush === 'function') knowledge.flush(); } catch (err) { log.warn('[bot:' + botId + '] flush 知识库失败: ' + errText(err)); }
      try { if (members && typeof members.flush === 'function') members.flush(); } catch (err) { log.warn('[bot:' + botId + '] flush 群友库失败: ' + errText(err)); }
      try { if (binding && typeof binding.dispose === 'function') binding.dispose(); } catch (err) { log.warn('[bot:' + botId + '] 释放绑定服务失败: ' + errText(err)); }
      try { await manager.disposeAll(); } catch (err) { log.warn('[bot:' + botId + '] 释放会话失败: ' + errText(err)); }
      try { await gateway.dispose(); } catch (err) { log.warn('[bot:' + botId + '] 释放网关失败: ' + errText(err)); }
    },
  };
  // agent 映射需要在 manager 创建时就引用 runtime（onAgent 闭包）
  const runtimeRef = runtime;
  return runtime;
}

export default createBotRuntime;
