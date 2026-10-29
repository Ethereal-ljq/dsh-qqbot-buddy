/**
 * session-manager —— QQ peer 到 dsh agent 会话的映射与生命周期管理。
 *
 * sessionKey 格式：qqbot-buddy:<appId>:<scope>:<peerId>（DESIGN 契约）。
 * sessionId：
 *   - 优先读 <stateDir>/sessions.json 的映射（reset 后写入新 uuid，重启后仍能续上）；
 *   - 没有映射时用 sha256(sessionKey) 确定性派生（与官方 SessionManager.deriveSessionId 同形）。
 *
 * 会话创建 / 恢复都通过 setup 钩子依次做四件事（DESIGN 追加需求）：
 *   1. agentPresets.mount(agentCtx, effectivePreset()) —— 挂 preset（失败只 warn，不阻断）
 *   2. 内置组合（qqbot-buddy）下按 settings.features 动态挂载工具插件
 *      （workspace: tool-fs + tool-fs-search；web: tool-web）
 *   3. 全局工具白名单 tools.restrict（memory_* / qqbot_send_file / qqbot_sticker_save / qqbot_describe_image）
 *   4. promptComposer.mount(agentCtx, { scope }) —— 挂人设 + 记忆 system prompt
 *
 * sessions.json 一律原子写（tmp + rename, 0600）。
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SessionId } from '@deepseek-ai/dsh-session';

import { createToolCatalog } from '../tools/catalog.js';

/** 闲置回收检查间隔（毫秒）。 */
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;
/** 每个 peer 最多保留多少个可 /resume 的历史会话。 */
const MAX_SESSION_HISTORY = 10;

/** 内置 agent 组合 id（DESIGN 追加需求）：该组合下按 features 动态挂载工具。 */
export const BUILTIN_PRESET_ID = 'qqbot-buddy';

/** 安全获取可选服务：cordis 的 ctx.get 在服务缺失时可能抛错。 */
function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** 错误转字符串。 */
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 从 tools.restrict() 的 unknown-name 报错里解析宿主已知全局工具名。
 * 报错格式：...; known global tools: a, b, c（可能为 "(none)"）。
 * 用于「包含未注册工具名时与已知列表取交集后重试一次」。
 */
function parseKnownGlobalTools(err) {
  const message = errText(err);
  const marker = 'known global tools: ';
  const index = message.indexOf(marker);
  if (index < 0) return [];
  const tail = message.slice(index + marker.length).trim();
  if (tail === '' || tail === '(none)') return [];
  return tail.split(',').map((name) => name.trim()).filter(Boolean);
}

export class SessionManager {
  /**
   * @param {object} args
   * @param {object} args.ctx 插件上下文（取 agentPresets 等可选服务）
   * @param {object} [args.agents] agent 注册表（缺省 ctx.get('agents') / ctx.agents）
   * @param {object} args.config 部署配置（appId/cwd/provider/model/preset/sessionIdleTimeout）
   * @param {object} args.settings settings-store（预留，用于按会话读取运行期配置）
   * @param {object} args.promptComposer prompt 组合器
   * @param {string} args.stateDir 状态目录（sessions.json 落在这里）
   * @param {object} args.logger 日志对象
   */
  constructor({ ctx, agents, config, settings, promptComposer, stateDir, logger, catalog } = {}) {
    this.ctx = ctx;
    this.agents = agents || (ctx && ctx.agents) || getService(ctx, 'agents');
    this.config = config && typeof config === 'object' ? config : {};
    this.settings = settings;
    this.promptComposer = promptComposer;
    this.stateDir = stateDir || path.join(process.cwd(), '.qqbot-buddy');
    this.logger = logger || console;

    this.sessions = new Map();
    this.creating = new Map();
    this.persistFile = path.join(this.stateDir, 'sessions.json');
    const loadedState = this.loadPersisted();
    this.persisted = loadedState.sessions;
    this.history = loadedState.history;
    this.cwd = this.config.cwd && String(this.config.cwd).trim() !== ''
      ? path.resolve(String(this.config.cwd))
      : process.cwd();
    this.idleTimeout = Number(this.config.sessionIdleTimeout) > 0
      ? Number(this.config.sessionIdleTimeout)
      : 30 * 60 * 1000;
    // 能力边界唯一真相：挂载 / 白名单 / 装配过滤 / 技能提示 全部由它派生
    this.catalog = catalog || createToolCatalog({
      settings: this.settings,
      cwd: this.cwd,
      logger: this.logger,
    });
    this.evictTimer = null;
    this.startEvictor();
  }

  // ── 持久化 ────────────────────────────────────────────────

  /** 读取 sessions.json（坏文件按空映射处理，不抛错）。兼容 v1（只有 sessions）。 */
  loadPersisted() {
    const sessions = {};
    const history = {};
    try {
      const raw = fs.readFileSync(this.persistFile, 'utf8');
      const parsed = JSON.parse(raw);
      const parsedSessions = parsed && typeof parsed === 'object' ? parsed.sessions : undefined;
      if (parsedSessions && typeof parsedSessions === 'object' && !Array.isArray(parsedSessions)) {
        for (const [key, value] of Object.entries(parsedSessions)) {
          if (typeof key === 'string' && typeof value === 'string' && value !== '') sessions[key] = value;
        }
      }
      const parsedHistory = parsed && typeof parsed === 'object' ? parsed.previous : undefined;
      if (parsedHistory && typeof parsedHistory === 'object' && !Array.isArray(parsedHistory)) {
        for (const [key, value] of Object.entries(parsedHistory)) {
          if (typeof key !== 'string' || !Array.isArray(value)) continue;
          const ids = value.filter((id) => typeof id === 'string' && id !== '');
          if (ids.length > 0) history[key] = ids.slice(-MAX_SESSION_HISTORY);
        }
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this.logger.warn('读取 sessions.json 失败，使用空映射: ' + errText(err));
      }
    }
    return { sessions, history };
  }

  /** 原子落盘 sessions.json。 */
  persist() {
    try {
      fs.mkdirSync(path.dirname(this.persistFile), { recursive: true });
      const tmp = this.persistFile + '.tmp-' + process.pid + '-' + Date.now();
      const body = JSON.stringify({ version: 2, sessions: this.persisted, previous: this.history }, null, 2) + '\n';
      fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.persistFile);
    } catch (err) {
      this.logger.warn('写入 sessions.json 失败: ' + errText(err));
    }
  }

  /** 记录某个 sessionKey 的当前 sessionId（reset 换新 id 后必须落盘）。 */
  saveSessionId(sessionKey, sessionId) {
    if (!sessionKey || !sessionId) return;
    if (this.persisted[sessionKey] === sessionId) return;
    this.persisted[sessionKey] = sessionId;
    this.persist();
  }

  // ── 键与 id ──────────────────────────────────────────────

  /** sessionKey = qqbot-buddy:<appId>:<scope>:<peerId>。 */
  sessionKey(scope, peerId) {
    const appId = this.config.appId || 'default';
    return 'qqbot-buddy:' + appId + ':' + scope + ':' + peerId;
  }

  /** sha256 派生会话 id（8-4-4-4-12 形态，与官方实现一致）。 */
  deriveSessionId(sessionKey) {
    const hash = createHash('sha256').update(sessionKey).digest('hex');
    return hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-' + hash.slice(12, 16) + '-'
      + hash.slice(16, 20) + '-' + hash.slice(20, 32);
  }

  /** 当前应使用的 sessionId（持久化映射优先，否则派生）。 */
  currentSessionId(sessionKey) {
    const saved = this.persisted[sessionKey];
    if (typeof saved === 'string' && saved !== '') return saved;
    return this.deriveSessionId(sessionKey);
  }

  // ── 模型路由（settings.model 热生效） ────────────────────

  /** 读取运行期 settings.model（每次现读）；provider+model 都非空才算有效。 */
  readSettingsModel() {
    try {
      if (!this.settings || typeof this.settings.get !== 'function') return undefined;
      const snapshot = this.settings.get();
      const raw = snapshot && snapshot.model;
      if (!raw || typeof raw !== 'object') return undefined;
      const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
      const model = typeof raw.model === 'string' ? raw.model.trim() : '';
      if (!provider || !model) return undefined;
      const reasoningEffort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : '';
      return reasoningEffort !== ''
        ? { provider: provider, model: model, reasoningEffort: reasoningEffort }
        : { provider: provider, model: model };
    } catch (err) {
      this.logger.warn('读取 settings.model 失败: ' + errText(err));
      return undefined;
    }
  }

  /** 读取部署配置里的 provider/model（插件级默认）。 */
  readConfigModel() {
    const provider = this.config.provider ? String(this.config.provider).trim() : '';
    const model = this.config.model ? String(this.config.model).trim() : '';
    if (!provider || !model) return undefined;
    const reasoningEffort = this.config.reasoningEffort ? String(this.config.reasoningEffort).trim() : '';
    return reasoningEffort !== ''
      ? { provider: provider, model: model, reasoningEffort: reasoningEffort }
      : { provider: provider, model: model };
  }

  /** 读取宿主默认模型（agentDefaultModel.currentSelection()）。 */
  readHostModel() {
    try {
      const service = getService(this.ctx, 'agentDefaultModel');
      const selection = service && typeof service.currentSelection === 'function'
        ? service.currentSelection()
        : undefined;
      if (!selection || !selection.provider || !selection.model) return undefined;
      const route = { provider: String(selection.provider), model: String(selection.model) };
      if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '') {
        route.reasoningEffort = selection.reasoningEffort;
      }
      return route;
    } catch (err) {
      this.logger.warn('读取宿主默认模型失败: ' + errText(err));
      return undefined;
    }
  }

  /**
   * 解析模型路由与来源。
   * 优先级（DESIGN 追加需求）：settings.model > config.provider/model > 宿主 agentDefaultModel > 无。
   * @returns {{route: object|undefined, source: 'settings'|'config'|'host'|'none'}}
   */
  resolveModelRoute() {
    const fromSettings = this.readSettingsModel();
    if (fromSettings) return { route: fromSettings, source: 'settings' };
    const fromConfig = this.readConfigModel();
    if (fromConfig) return { route: fromConfig, source: 'config' };
    const fromHost = this.readHostModel();
    if (fromHost) return { route: fromHost, source: 'host' };
    return { route: undefined, source: 'none' };
  }

  /**
   * 构造 agentOptions（create/resume 时调用，每次现读设置，热生效）。
   * 不传 agentOptions 时 DSH 的 agent turn 会报 no provider/model，因此按优先级兜底。
   */
  agentOptions() {
    const resolved = this.resolveModelRoute();
    if (resolved.route) return resolved.route;
    this.logger.warn('无法解析模型路由（settings.model / config.provider+model / agentDefaultModel 均不可用），'
      + 'agent 创建后可能无法生成回复，请在设置「模型」页选择模型');
    return undefined;
  }

  /** 同步模型信息（web /api/state、设置页展示用）。 */
  getModelInfoSync() {
    let selected = { provider: '', model: '', reasoningEffort: '' };
    try {
      const snapshot = this.settings && typeof this.settings.get === 'function' ? this.settings.get() : undefined;
      const raw = snapshot && snapshot.model && typeof snapshot.model === 'object' ? snapshot.model : {};
      selected = {
        provider: typeof raw.provider === 'string' ? raw.provider.trim() : '',
        model: typeof raw.model === 'string' ? raw.model.trim() : '',
        reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : '',
      };
    } catch (err) {
      this.logger.warn('读取 settings.model 失败: ' + errText(err));
    }
    const resolved = this.resolveModelRoute();
    return {
      selected: selected,
      effective: resolved.route || null,
      source: resolved.source,
      hostDefault: this.readHostModel() || null,
    };
  }

  /** 枚举宿主可用模型（/api/models 用）；服务不可用时返回空数组。 */
  async listModels() {
    const providers = [];
    const llm = getService(this.ctx, 'llm');
    if (!llm || typeof llm.listProviders !== 'function') return providers;
    let rawProviders;
    try {
      rawProviders = await llm.listProviders();
    } catch (err) {
      this.logger.warn('枚举模型 provider 失败: ' + errText(err));
      return providers;
    }
    const list = Array.isArray(rawProviders) ? rawProviders : [];
    for (const provider of list) {
      const id = typeof provider === 'string'
        ? provider
        : (provider && typeof provider.id === 'string' ? provider.id : '');
      if (!id) continue;
      let models = [];
      if (typeof llm.listModels === 'function') {
        try {
          const rawModels = await llm.listModels(id);
          if (Array.isArray(rawModels)) {
            models = rawModels.map((model) => {
              if (typeof model === 'string') return { id: model, name: model };
              const modelId = model && typeof model.id === 'string' ? model.id : '';
              const name = model && typeof model.name === 'string' && model.name !== '' ? model.name : modelId;
              return modelId ? { id: modelId, name: name } : undefined;
            }).filter(Boolean);
          }
        } catch (err) {
          this.logger.debug('provider ' + id + ' 模型列表获取失败: ' + errText(err));
        }
      }
      providers.push({ id: id, models: models });
    }
    return providers;
  }

  /** 异步模型信息（额外含 providers），web /api/models 用。 */
  async getModelInfo() {
    const base = this.getModelInfoSync();
    let providers = [];
    try {
      providers = await this.listModels();
    } catch (err) {
      this.logger.warn('枚举模型失败: ' + errText(err));
    }
    return Object.assign({}, base, { providers: providers });
  }

  // ── preset / features / 工具白名单（DESIGN 追加需求） ──

  /**
   * 生效 preset：settings.agent.preset > config.preset > 内置组合。
   * 每次现读 settings（改设置后只影响新会话，符合契约）。
   */
  effectivePreset() {
    let selected = '';
    try {
      const snapshot = this.settings && typeof this.settings.get === 'function' ? this.settings.get() : undefined;
      const agentSettings = snapshot && snapshot.agent && typeof snapshot.agent === 'object' ? snapshot.agent : {};
      selected = typeof agentSettings.preset === 'string' ? agentSettings.preset.trim() : '';
    } catch (err) {
      this.logger.warn('读取 settings.agent.preset 失败: ' + errText(err));
    }
    const fromConfig = this.config.preset ? String(this.config.preset).trim() : '';
    return selected || fromConfig || BUILTIN_PRESET_ID;
  }

  /** preset 选择信息（web /api/presets 与 state.agent 用）。 */
  presetInfo() {
    let selected = '';
    try {
      const snapshot = this.settings && typeof this.settings.get === 'function' ? this.settings.get() : undefined;
      const agentSettings = snapshot && snapshot.agent && typeof snapshot.agent === 'object' ? snapshot.agent : {};
      selected = typeof agentSettings.preset === 'string' ? agentSettings.preset.trim() : '';
    } catch (err) {
      this.logger.warn('读取 settings.agent.preset 失败: ' + errText(err));
    }
    const effective = this.effectivePreset();
    return {
      selected: selected,
      effective: effective,
      builtIn: effective === BUILTIN_PRESET_ID,
      defaultPreset: this.config.preset || BUILTIN_PRESET_ID,
    };
  }

  /** 宿主可用 agent preset 列表；服务不可用/异常时返回 []，绝不抛错。 */
  async listPresets() {
    const presets = getService(this.ctx, 'agentPresets');
    if (!presets || typeof presets.list !== 'function') return [];
    try {
      const raw = await presets.list();
      if (!Array.isArray(raw)) return [];
      const out = [];
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (id === '') continue;
        const entry = {
          id: id,
          name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : id,
        };
        if (typeof item.description === 'string' && item.description.trim() !== '') {
          entry.description = item.description.trim();
        }
        if (item.broken !== undefined) entry.broken = item.broken;
        out.push(entry);
      }
      return out;
    } catch (err) {
      this.logger.warn('枚举 agent preset 失败: ' + errText(err));
      return [];
    }
  }

  /**
   * 内置组合下按 features 动态挂载工具插件：
   *   workspace -> @deepseek-ai/dsh-tool-fs + @deepseek-ai/dsh-tool-fs-search
   *   web       -> @deepseek-ai/dsh-tool-web
   * 用 agentCtx.plugin(moduleNamespace, config)；单个模块失败只 warn，不阻断 agent 创建。
   */
  async mountFeatureTools(agentCtx) {
    if (!agentCtx || typeof agentCtx.plugin !== 'function') {
      this.logger.warn('agentCtx.plugin 不可用，跳过功能工具动态挂载');
      return;
    }
    const plan = this.catalog.resolve();
    for (const mount of plan.mounts) {
      try {
        // 技能 provider 是本包自己的插件（替代宿主 dsh-skill-filesystem），
        // 按宿主公开的 ctx.skills.registerProvider() 契约注册过滤后的发现逻辑。
        if (mount.kind === 'skillProvider') {
          const skillConfig = this.catalog.skillProviderConfig();
          if (!skillConfig) continue;
          const namespace = await import('../skills/provider.js');
          const fiber = agentCtx.plugin(namespace, skillConfig);
          if (fiber && typeof fiber.then === 'function') await fiber;
          this.logger.debug('已挂载技能 provider: ' + skillConfig.providerName
            + '（mode=' + skillConfig.mode + ', allowed=' + skillConfig.allowed.join(',') + '）');
          continue;
        }
        const namespace = await import(mount.moduleName);
        const fiber = agentCtx.plugin(namespace, mount.config);
        // cordis 的 plugin() 返回 thenable Fiber：await 后模块才真正激活/注册工具
        if (fiber && typeof fiber.then === 'function') await fiber;
        this.logger.debug('已挂载功能工具: ' + mount.moduleName + '（能力 ' + mount.capability + '）');
      } catch (err) {
        this.logger.warn('挂载功能工具 ' + (mount.moduleName || mount.kind) + ' 失败: ' + errText(err));
      }
    }
  }

  /**
   * 全局工具白名单：**完全由能力目录派生**（lib/tools/catalog.js）。
   * 空数组表示不暴露任何工具（能力全关时是合法状态）。
   */
  buildToolAllowList() {
    return this.catalog.resolve().tools;
  }

  /** 读取 settings.tools.extraAllowed（去空、去重、仅接受安全工具名）。 */
  readExtraAllowedTools() {
    try {
      const snapshot = this.settings && typeof this.settings.get === 'function' ? this.settings.get() : {};
      const tools = snapshot && snapshot.tools && typeof snapshot.tools === 'object' ? snapshot.tools : {};
      const list = Array.isArray(tools.extraAllowed) ? tools.extraAllowed : [];
      const out = [];
      for (const item of list) {
        if (typeof item !== 'string') continue;
        const name = item.trim();
        // 工具名允许字母/数字/下划线/短横线/点（MCP 常见 a.b 形式），避免奇怪输入
        if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name)) continue;
        if (!out.includes(name)) out.push(name);
      }
      return out;
    } catch (err) {
      this.logger.warn('读取 settings.tools.extraAllowed 失败（按空处理）: ' + errText(err));
      return [];
    }
  }

  /**
   * 全局工具白名单（替代 preset 里的 guard 插件）：agentCtx.get('tools').restrict({allow})。
   * 未知工具名（某工具没注册/宿主版本差异）时解析报错里的 known global tools，
   * 与 allow 取交集后重试一次；仍失败只 warn，绝不阻断 agent 创建。
   */
  applyToolWhitelist(agentCtx, presetId) {
    // 注意：必须用 scope 代理属性 agentCtx.tools 而不是 agentCtx.get('tools')。
    // restrict() 作用于「调用方所在 agent scope」；get() 返回的是无 scope 绑定的宿主编实例，
    // 会把白名单限制装到 root scope（实测会导致 agent 仍能看到 agent-team 等全局工具）。
    let tools;
    try {
      tools = agentCtx && typeof agentCtx === 'object' ? agentCtx.tools : undefined;
    } catch {
      tools = undefined;
    }
    if (!tools || typeof tools.restrict !== 'function') {
      try {
        tools = agentCtx && typeof agentCtx.get === 'function' ? agentCtx.get('tools') : undefined;
      } catch {
        tools = undefined;
      }
    }
    if (!tools || typeof tools.restrict !== 'function') {
      this.logger.warn('tools 服务不可用，跳过全局工具白名单（preset=' + presetId + '）');
      return;
    }
    const allow = this.buildToolAllowList();
    try {
      tools.restrict({ allow: allow });
      this.logger.debug('全局工具白名单已应用（preset=' + presetId + '）: [' + allow.join(', ') + ']');
      return;
    } catch (err) {
      const known = parseKnownGlobalTools(err);
      if (known.length === 0) {
        this.logger.warn('收窄全局工具失败（跳过限制）: ' + errText(err));
        return;
      }
      const knownSet = new Set(known);
      const intersected = allow.filter((name) => knownSet.has(name));
      try {
        tools.restrict({ allow: intersected });
        this.logger.warn('白名单含未注册工具，已按交集收窄: [' + intersected.join(', ') + ']');
      } catch (retryErr) {
        this.logger.warn('白名单交集重试仍失败（跳过限制）: ' + errText(retryErr));
      }
    }
  }

  /**
   * assembly 层工具过滤计划。
   *
   * 背景：宿主的 experimental-agent-team 等插件会通过 agent/created 往**每个 agent scope**
   * 注册工具；按 dsh-tools 的文档，tools.restrict() 只收窄「全局层 + 祖先层」，
   * 管不到「agent 自己这一层」，所以 assembly 这层过滤是唯一全覆盖的闸门。
   *
   * v0.8 起**统一为 allowlist（默认拒绝）**：宿主 preset 也走同一份白名单，
   * 不再维护手写 deny 黑名单——否则新装的插件（如 image-gen 的新工具）会默认漏进来。
   * 需要额外工具时用 settings.tools.extraAllowed 显式放行，或打开对应能力开关。
   */
  buildToolFilterPlan(_presetId) {
    return this.catalog.filterPlan();
  }

  /**
   * 屏蔽宿主必填的运行时上下文（team:identity 等）。
   * systemPrompt.refreshContext 会在 assembly 之后把 required context 重新加回来；
   * 这里在每次 assembly 时把对应 provider 的 text 改写成空字符串（仅影响该 agent 的
   * 独立 provider 对象），渲染时被过滤掉，避免「You are the Team Lead」污染 QQ 人设。
   */
  suppressRequiredRuntimeTexts(agentCtx, context) {
    try {
      const systemPrompt = agentCtx && agentCtx.systemPrompt;
      const layers = systemPrompt && systemPrompt.layers;
      if (!layers || typeof layers.chainLayers !== 'function') return;
      const scope = context && context.scope !== undefined ? context.scope : agentCtx;
      const chain = layers.chainLayers(scope);
      for (const name of ['team:identity']) {
        for (const layer of chain) {
          const provider = layer && layer.contexts && typeof layer.contexts.get === 'function'
            ? layer.contexts.get(name)
            : undefined;
          if (provider && typeof provider.text === 'function') {
            provider.text = () => '';
          }
        }
      }
    } catch (err) {
      this.logger.warn('屏蔽运行时上下文失败（跳过）: ' + errText(err));
    }
  }

  /** 在 agent scope 安装 assembly 层工具过滤（自动随 agent 生命周期释放）。 */
  installToolFilter(agentCtx, presetId) {
    if (!agentCtx || typeof agentCtx.on !== 'function') {
      this.logger.warn('agentCtx.on 不可用，跳过工具过滤');
      return;
    }
    try {
      agentCtx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const assembled = await next();
        let plan;
        try {
          plan = this.buildToolFilterPlan(presetId);
        } catch {
          plan = null;
        }
        this.suppressRequiredRuntimeTexts(agentCtx, _context);
        if (plan === null || !assembled || !Array.isArray(assembled.tools)) return assembled;
        const candidates = [];
        const filtered = assembled.tools.filter((tool) => {
          const name = tool && typeof tool.name === 'string' ? tool.name : '';
          if (name === '') return false;
          candidates.push(name);
          return plan.mode === 'allow' ? plan.names.has(name) : !plan.names.has(name);
        });
        // 审计：记录本次装配里「存在但被屏蔽」的工具。
        // 这正是「装个新插件不用改代码」的关键——新插件注册的工具会出现在这里，
        // 设置页列出来后点一下即可放行（写进 settings.tools.extraAllowed）。
        try {
          const kept = new Set(filtered.map((tool) => (tool && typeof tool.name === 'string' ? tool.name : '')));
          const dropped = candidates.filter((name) => !kept.has(name));
          this.toolAudit = {
            at: Date.now(),
            presetId: presetId,
            candidates: candidates.slice().sort(),
            dropped: dropped.slice().sort(),
          };
        } catch (err) {
          this.logger.warn('记录工具审计失败（忽略）: ' + errText(err));
        }
        // 运行时上下文过滤：
        // - 宿主的 team:identity 是 required context，suppressRuntimeContext() 压不住，
        //   会把「You are the Team Lead named "lead"」注入 QQ 机器人（实测污染人设）；
        // - 因此始终剔除 team:* 上下文/段落；persona.suppressRuntimeContext !== false 时
        //   进一步清空全部 runtime context（chatonly 风格：只保留人设）。
        let contexts = Array.isArray(assembled.contexts)
          ? assembled.contexts.filter((item) => !(item && typeof item.name === 'string' && item.name.startsWith('team:')))
          : assembled.contexts;
        let sections = Array.isArray(assembled.sections)
          ? assembled.sections.filter((item) => !(item && typeof item.name === 'string' && item.name.startsWith('team:')))
          : assembled.sections;
        try {
          const cfg = this.settings && typeof this.settings.get === 'function' ? this.settings.get() : undefined;
          if (cfg && cfg.persona && cfg.persona.suppressRuntimeContext !== false) contexts = [];
        } catch {
          /* 读设置失败时只做 team 过滤 */
        }
        return { ...assembled, tools: filtered, contexts, sections };
      });
      this.logger.debug('assembly 工具过滤已安装（preset=' + presetId + '）');
    } catch (err) {
      this.logger.warn('安装 assembly 工具过滤失败（跳过）: ' + errText(err));
    }
  }

  /**
   * 构造 create/resume 共用的 setup 钩子（DESIGN 追加需求）：
   *   1. presets.mount(agentCtx, effectivePreset())（失败 warn 继续）
   *   2. 内置组合下按 features 动态挂载工具插件
   *   3. 全局工具白名单（两种 preset 模式都生效）
   *   4. promptComposer.mount（人设 + 记忆 + 行为指引）
   * 任何一步失败都只告警，保证 agent 仍能创建。
   */
  buildSetup(scope) {
    return async (agentCtx) => {
      const presetId = this.effectivePreset();
      // 1. preset（工具集 / 子插件组合）
      const presets = getService(this.ctx, 'agentPresets');
      if (presets && typeof presets.mount === 'function') {
        try {
          await presets.mount(agentCtx, presetId);
        } catch (err) {
          this.logger.warn('preset ' + presetId + ' 挂载失败（继续使用宿主组合）: ' + errText(err));
        }
      } else {
        this.logger.warn('agentPresets 服务不可用，跳过 preset ' + presetId + ' 挂载');
      }
      // 2. 内置组合：按功能开关动态挂载工具插件（宿主 preset 模式跳过）
      if (presetId === BUILTIN_PRESET_ID) {
        try {
          await this.mountFeatureTools(agentCtx);
        } catch (err) {
          this.logger.warn('动态挂载功能工具失败（继续）: ' + errText(err));
        }
      }
      // 3. 全局工具白名单（两种 preset 模式都生效：表情包/看图/记忆开关）
      try {
        this.applyToolWhitelist(agentCtx, presetId);
      } catch (err) {
        this.logger.warn('应用全局工具白名单失败（跳过）: ' + errText(err));
      }
      // 4. 人设 + 记忆 system prompt
      if (this.promptComposer && typeof this.promptComposer.mount === 'function') {
        try {
          this.promptComposer.mount(agentCtx, { scope });
        } catch (err) {
          this.logger.warn('system prompt 挂载失败: ' + errText(err));
        }
      }
      // 5. assembly 层工具过滤（兜住宿主往 agent scope 注册的团队/画布/图片生成等工具）
      try {
        this.installToolFilter(agentCtx, presetId);
      } catch (err) {
        this.logger.warn('工具过滤安装失败（跳过）: ' + errText(err));
      }
    };
  }

  // ── 获取 / 创建会话 ──────────────────────────────────────

  /**
   * 获取或创建会话（内存复用 -> agents.resume -> agents.create）。
   * @param {'group'|'c2c'} scope 会话类型
   * @param {string} peerId 群 openid 或用户 openid
   * @param {string} senderId 发送者 openid
   * @param {{scope:string,targetId:string,msgId?:string}} replyTarget 回复目标
   * @returns {Promise<object>} session record
   */
  async getOrCreate(scope, peerId, senderId, replyTarget) {
    const key = this.sessionKey(scope, peerId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.replyTarget = replyTarget;
      existing.lastActivity = Date.now();
      if (senderId) existing.senderId = senderId;
      return existing;
    }
    // 同一 peer 并发进入时只创建一次（concurrencyGuard 之外的第二道保险）
    const inflight = this.creating.get(key);
    if (inflight) return inflight;

    const creation = this.createRecord(scope, peerId, senderId, replyTarget, key)
      .finally(() => this.creating.delete(key));
    this.creating.set(key, creation);
    return creation;
  }

  /**
   * 把 QQ 会话挂到部署 cwd 对应的 DSH workspace（storages/workspace.json）。
   * 不挂的话，/new 创建的新会话不会出现在 Web 侧栏「qqbot」工作区里——
   * 只有用户从 UI 打开的会话才会被 workspaceRegistry 记录。
   */
  async attachWorkspaceSession(sessionId) {
    if (!sessionId) return;
    try {
      const registry = getService(this.ctx, 'workspaceRegistry')
        || getService(this.ctx, 'workspace');
      if (!registry || typeof registry.list !== 'function') return;
      let cwd;
      try {
        cwd = fs.realpathSync(this.config.cwd || process.cwd());
      } catch {
        cwd = this.config.cwd || process.cwd();
      }
      let workspace = registry.list().find((item) => item && item.path === cwd);
      if (!workspace && typeof registry.create === 'function') {
        workspace = await registry.create(cwd, path.basename(cwd));
      }
      if (workspace && typeof workspace.attachSession === 'function') {
        await workspace.attachSession(String(sessionId));
      }
    } catch (err) {
      this.logger.warn('登记 workspace 会话失败（不影响聊天）: ' + errText(err));
    }
  }

  /** 真正创建 / 恢复会话并登记。 */
  async createRecord(scope, peerId, senderId, replyTarget, key) {
    if (!this.agents || typeof this.agents.create !== 'function') {
      throw new Error('agent 服务不可用，无法创建 QQ 会话');
    }
    const sessionKey = key || this.sessionKey(scope, peerId);
    const sessionIdStr = this.currentSessionId(sessionKey);
    const sessionId = SessionId(sessionIdStr);
    const route = this.agentOptions();
    const setup = this.buildSetup(scope);

    this.logger.info('获取会话: key=' + sessionKey + ' sessionId=' + sessionIdStr
      + ' route=' + (route ? route.provider + '/' + route.model : 'host-default'));

    let agent;
    let handle;
    let live;
    try {
      live = typeof this.agents.get === 'function' ? this.agents.get(sessionId) : undefined;
    } catch {
      live = undefined;
    }

    if (live) {
      // 进程里已有同 id 的 agent，直接复用（与官方行为一致）
      agent = live;
      handle = { agent: live, dispose: async () => {} };
    } else {
      try {
        const resumed = await this.agents.resume(Object.assign(
          { resumeSessionId: sessionId, setup },
          route ? { agentOptions: route } : {},
        ));
        agent = resumed.agent;
        handle = resumed;
        this.logger.info('已恢复会话: key=' + sessionKey);
      } catch (resumeErr) {
        this.logger.info('恢复会话失败，创建新会话: key=' + sessionKey + ' — ' + errText(resumeErr));
        const meta = { cwd: this.cwd };
        const presetId = this.effectivePreset();
        if (presetId) meta.agentPreset = presetId;
        const created = await this.agents.create(Object.assign(
          { sessionId, meta, setup },
          route ? { agentOptions: route } : {},
        ));
        agent = created.agent;
        handle = created;
        this.logger.info('已创建会话: key=' + sessionKey);
      }
    }

    // agent/session 建好后再登记 workspace（attachSession 会校验会话已存在）；
    // 否则 /new 出来的新会话不会出现在 Web 侧栏的 qqbot 工作区里。
    await this.attachWorkspaceSession(sessionIdStr);
    const record = {
      sessionKey,
      sessionId: sessionIdStr,
      session: agent.session,
      agent,
      handle: handle || { agent, dispose: async () => {} },
      replyTarget,
      scope,
      peerId,
      senderId,
      lastActivity: Date.now(),
    };
    this.sessions.set(sessionKey, record);
    this.saveSessionId(sessionKey, sessionIdStr);
    return record;
  }

  // ── 查询 ─────────────────────────────────────────────────

  getSessionRecord(scope, peerId) {
    return this.sessions.get(this.sessionKey(scope, peerId));
  }

  findBySessionId(sessionId) {
    if (!sessionId) return undefined;
    const target = String(sessionId);
    for (const record of this.sessions.values()) {
      if (String(record.sessionId) === target) return record;
    }
    return undefined;
  }

  findByAgent(agent) {
    if (!agent) return undefined;
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record;
    }
    return undefined;
  }

  latestReplyTargetForAgent(agent) {
    const record = this.findByAgent(agent);
    return record ? record.replyTarget : undefined;
  }

  listSessions() {
    return Array.from(this.sessions.values());
  }

  get size() {
    return this.sessions.size;
  }

  // ── 重置 / 回收 ──────────────────────────────────────────

  /**
   * 重置某 peer 的会话：销毁当前 agent，并为下一次会话换一个新 uuid。
   * @returns {Promise<{ok:boolean, sessionId:string}>}
   */
  async reset(scope, peerId) {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    this.sessions.delete(key);
    if (record) {
      try {
        record.agent.cancel({ kind: 'user' });
      } catch {
        /* 忽略 */
      }
      try {
        await record.handle.dispose();
      } catch (err) {
        this.logger.warn('销毁会话失败: ' + errText(err));
      }
    }
    const previousId = this.currentSessionId(key);
    const list = Array.isArray(this.history[key]) ? this.history[key] : [];
    if (previousId && list[list.length - 1] !== previousId) list.push(previousId);
    this.history[key] = list.slice(-MAX_SESSION_HISTORY);
    const nextId = randomUUID();
    this.persisted[key] = nextId;
    this.persist();
    this.logger.info('会话已重置: key=' + key + ' -> ' + nextId + '（可恢复: ' + this.history[key].length + '）');
    return { ok: true, sessionId: nextId, resumable: this.history[key].length };
  }

  /** 当前 peer 可恢复的历史会话数量（/status 用）。 */
  previousCount(scope, peerId) {
    const key = this.sessionKey(scope, peerId);
    const list = Array.isArray(this.history[key]) ? this.history[key] : [];
    return list.length;
  }

  /**
   * 恢复上一个被 /new（reset）替换掉的会话。
   * 只切换 sessionId 映射并销毁当前 agent；下一条消息会 resume 回旧会话（保留历史上下文）。
   * @returns {Promise<{ok:boolean, sessionId?:string, remaining?:number, reason?:string}>}
   */
  async resumePrevious(scope, peerId) {
    const key = this.sessionKey(scope, peerId);
    const list = Array.isArray(this.history[key]) ? this.history[key].slice() : [];
    if (list.length === 0) return { ok: false, reason: 'none' };
    // 释放当前会话（如果有）
    const record = this.sessions.get(key);
    this.sessions.delete(key);
    if (record) {
      try {
        record.agent.cancel({ kind: 'user' });
      } catch {
        /* ignore */
      }
      try {
        await record.handle.dispose();
      } catch (err) {
        this.logger.warn('恢复会话前销毁当前会话失败: ' + errText(err));
      }
    }
    const targetId = list.pop();
    if (targetId === undefined || targetId === '') return { ok: false, reason: 'none' };
    if (list.length > 0) this.history[key] = list;
    else delete this.history[key];
    this.persisted[key] = targetId;
    this.persist();
    this.logger.info('会话已恢复: key=' + key + ' -> ' + targetId + '（剩余可恢复: ' + list.length + '）');
    return { ok: true, sessionId: targetId, remaining: list.length };
  }

  /**
   * 释放全部内存会话，但保留 sessions.json 映射。
   * 语义（DESIGN「应用模型」）：改设置只影响新会话；调用本方法后下一条消息会按
   * 新的 settings.model 重新 create/resume，历史仍由 dsh session 持久化保留。
   * @returns {Promise<{ok:boolean, count:number}>}
   */
  async resetAll() {
    const records = Array.from(this.sessions.values());
    this.sessions.clear();
    this.creating.clear();
    for (const record of records) {
      try {
        if (record.agent && typeof record.agent.cancel === 'function') record.agent.cancel({ kind: 'user' });
      } catch {
        /* 取消失败也继续 dispose */
      }
    }
    const disposals = records.map((record) => {
      try {
        return record.handle && typeof record.handle.dispose === 'function' ? record.handle.dispose() : undefined;
      } catch (err) {
        this.logger.warn('释放会话失败: ' + errText(err));
        return undefined;
      }
    }).filter(Boolean);
    await Promise.allSettled(disposals);
    this.logger.info('已释放全部内存会话（保留 sessions.json 映射）count=' + records.length);
    return { ok: true, count: records.length };
  }

  /** 启动闲置会话回收定时器。 */
  startEvictor() {
    if (!(this.idleTimeout > 0)) return;
    this.evictTimer = setInterval(() => this.evictIdle(), IDLE_CHECK_INTERVAL_MS);
    if (typeof this.evictTimer.unref === 'function') this.evictTimer.unref();
  }

  /** 回收闲置超时的会话。 */
  evictIdle() {
    const now = Date.now();
    for (const [key, record] of this.sessions) {
      if (now - record.lastActivity <= this.idleTimeout) continue;
      this.sessions.delete(key);
      this.logger.info('回收闲置会话: ' + key);
      try {
        record.agent.cancel({ kind: 'user' });
      } catch {
        /* 忽略 */
      }
      Promise.resolve()
        .then(() => record.handle.dispose())
        .catch((err) => this.logger.warn('回收会话 dispose 失败: ' + errText(err)));
    }
  }

  /** 销毁全部会话并停止定时器（插件卸载 / 网关重启时调用）。 */
  async disposeAll() {
    if (this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = null;
    }
    const records = Array.from(this.sessions.values());
    this.sessions.clear();
    this.creating.clear();
    for (const record of records) {
      try {
        record.agent.cancel({ kind: 'user' });
      } catch {
        /* 忽略 */
      }
    }
    await Promise.allSettled(records.map((record) => record.handle.dispose()));
    this.logger.info('全部会话已销毁 (count=' + records.length + ')');
  }
}

export default SessionManager;