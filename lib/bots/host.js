/**
 * bots/host —— 多机器人宿主：注册表 + N 个运行时 + 全局工具注册 + 生命周期。
 *
 * 职责边界：
 * - registry（bots.json）是机器人元数据的唯一真相；
 * - 每个启用的机器人有独立 BotRuntime（各自 settings/memory/knowledge/gateway…）；
 * - 工具（memory_* / knowledge_* / member_* / qqbot_send_file / qqbot_sticker_save /
 *   qqbot_describe_image）只在插件层注册一次，执行时按 exec.agent 路由到所属机器人；
 * - 对外暴露一个与 v0.15 单机器人 runtime 同形的 facade（字段代理到 activeBot），
 *   旧 web 路由/绑定路由在未做 botId 解析时仍能工作。
 */
import fs from 'node:fs';
import path from 'node:path';

import { createBotRegistry } from './registry.js';
import { createAgentMap } from './agent-map.js';
import { createBotRuntime } from './runtime.js';

const RUNTIME_KEYS = [
  'config', 'settings', 'persona', 'personaCards', 'memory', 'knowledge', 'knowledgeExtractor', 'profileExtractor', 'members', 'emergence',
  'collector', 'promptComposer', 'gateState', 'manager', 'gateway', 'stats', 'stateDir', 'mediaDir',
  'cwd', 'settingsFile', 'workspaceDir', 'paths', 'stickersDir', 'stickers', 'toolCatalog',
  'profileDir', 'binding', 'adaptive', 'version',
];

function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

function errText(err) { return err instanceof Error ? err.message : String(err); }

/**
 * 装配多机器人宿主。
 * @param {object} args
 * @param {object} args.ctx cordis 上下文
 * @param {object} args.config 插件部署配置（cfg）
 * @param {object} args.logger 日志对象
 */
export async function createBotHost({ ctx, config = {}, logger, start = true } = {}) {
  const log = logger || console;
  const cfg = config && typeof config === 'object' ? config : {};
  const agents = getService(ctx, 'agents') || (ctx && ctx.agents);
  const workspaceRoot = path.resolve(
    (typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot.trim() !== '' ? cfg.workspaceRoot.trim() : '')
    || (typeof cfg.cwd === 'string' && cfg.cwd.trim() !== '' ? cfg.cwd.trim() : process.cwd()),
  );
  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  } catch (err) {
    log.warn('[host] 创建工作区根失败（降级继续）: ' + errText(err));
  }

  const registry = createBotRegistry({
    workspaceRoot: workspaceRoot,
    legacyConfig: cfg,
    maxBots: cfg.maxBots,
    logger: log,
  });
  const agentMap = createAgentMap();
  /** id -> BotRuntime */
  const runtimes = new Map();
  let disposed = false;

  const host = {
    ctx: ctx,
    config: cfg,
    logger: log,
    agents: agents,
    registry: registry,
    agentMap: agentMap,
    workspaceRoot: workspaceRoot,
    runtimes: runtimes,
  };

  /** 每个机器人一个子 logger，日志里能看出是谁。 */
  function childLogger(id) {
    const prefix = '[bot:' + id + '] ';
    const wrap = (level) => (...args) => {
      try {
        const fn = log && typeof log[level] === 'function' ? log[level] : null;
        if (fn) fn(prefix + args.map((item) => (typeof item === 'string' ? item : String(item))).join(' '));
      } catch {
        /* 日志失败忽略 */
      }
    };
    return {
      info: wrap('info'), warn: wrap('warn'), error: wrap('error'), debug: wrap('debug'),
    };
  }

  /** 创建（或复用）一个机器人运行时。 */
  async function ensureRuntime(record) {
    if (!record) return null;
    const existing = runtimes.get(record.id);
    if (existing) return existing;
    try {
      const runtime = await createBotRuntime({
        ctx: ctx,
        host: host,
        record: record,
        config: cfg,
        logger: childLogger(record.id),
      });
      runtimes.set(record.id, runtime);
      return runtime;
    } catch (err) {
      log.error('[host] 机器人 ' + record.id + ' 装配失败: ' + errText(err));
      return null;
    }
  }

  /** 停掉并移除一个机器人运行时（不删文件）。 */
  async function dropRuntime(id) {
    const runtime = runtimes.get(id);
    if (!runtime) return;
    runtimes.delete(id);
    try {
      await runtime.dispose();
    } catch (err) {
      log.warn('[host] 释放机器人 ' + id + ' 失败: ' + errText(err));
    }
  }

  // ── 启动各机器人 ──────────────────────────────────────
  async function startAll() {
    const records = registry.list();
    for (const record of records) {
      const runtime = await ensureRuntime(record);
      if (!runtime) continue;
      if (record.enabled === false) continue;
      if (cfg.autoStart === false) continue;
      const bound = (runtime.config.appId || '') !== '' && (runtime.config.appSecret || '') !== '';
      if (!bound) continue;
      try {
        await runtime.start();
      } catch (err) {
        log.error('[host] 机器人 ' + record.id + ' 启动失败: ' + errText(err));
      }
    }
    // 缺凭据时只为 active 机器人自动开扫码（避免同时弹 N 个二维码）
    if (cfg.bindOnMissingCredentials !== false) {
      const active = registry.active();
      const runtime = active ? runtimes.get(active.id) : null;
      if (runtime && runtime.binding && typeof runtime.binding.start === 'function') {
        const bound = (runtime.config.appId || '') !== '' && (runtime.config.appSecret || '') !== '';
        if (!bound) {
          try {
            runtime.binding.start();
            log.info('[host] 机器人 ' + active.id + ' 未绑定，已启动扫码流程');
          } catch (err) {
            log.warn('[host] 启动扫码流程失败: ' + errText(err));
          }
        }
      }
    }
  }

  /** 取机器人运行时：id 缺省 = active。 */
  function getBot(id) {
    const key = typeof id === 'string' && id.trim() !== '' ? id.trim() : registry.activeId();
    return runtimes.get(key) || null;
  }

  function activeBot() {
    return getBot(registry.activeId());
  }

  /** 供 web 路由用：botId → 运行时；找不到返回 null（由路由决定回退）。 */
  function runtimeFor(id) {
    return getBot(id);
  }

  /** 工具路由：exec.agent → 机器人；未登记时回退 active（旧测试/宿主内部 agent）。 */
  function resolveBot(exec) {
    const mapped = agentMap.resolve(exec);
    if (mapped) return mapped;
    return activeBot();
  }

  /** 机器人列表快照（/api/bots 用）。 */
  function listSnapshots() {
    const out = [];
    for (const record of registry.list()) {
      const runtime = runtimes.get(record.id);
      out.push(runtime ? runtime.snapshot() : {
        id: record.id,
        name: record.name,
        appId: record.appId || '',
        bound: false,
        enabled: record.enabled !== false,
        legacy: record.legacy === true,
        workspaceDir: record.workspaceDir,
        ready: false,
        lastError: '机器人未装配',
        sessionCount: 0,
        stats: {},
        version: '',
      });
    }
    return out;
  }

  async function createBot(input = {}) {
    if (disposed) return { ok: false, error: '插件已卸载' };
    const created = registry.create(input);
    if (!created.ok) return created;
    const runtime = await ensureRuntime(created.bot);
    if (!runtime) return { ok: false, error: '机器人已创建但装配失败，请检查日志' };
    if (cfg.autoStart !== false) {
      const bound = (runtime.config.appId || '') !== '' && (runtime.config.appSecret || '') !== '';
      if (bound) {
        try { await runtime.start(); } catch (err) { log.warn('[host] 新机器人启动失败: ' + errText(err)); }
      } else if (cfg.bindOnMissingCredentials !== false && created.bot.id === registry.activeId()) {
        try { runtime.binding?.start?.(); } catch { /* ignore */ }
      }
    }
    return { ok: true, bot: runtime.snapshot() };
  }

  async function updateBot(id, patch = {}) {
    if (disposed) return { ok: false, error: '插件已卸载' };
    const beforeRecord = registry.get(id);
    if (!beforeRecord) return { ok: false, error: '机器人不存在: ' + id };
    const beforeWs = beforeRecord.workspaceDir;
    const updated = registry.update(id, patch);
    if (!updated.ok) return updated;
    const record = updated.bot;
    const runtime = runtimes.get(id);
    const workspaceChanged = beforeWs !== record.workspaceDir;
    const enabledChanged = (beforeRecord.enabled !== false) !== (record.enabled !== false);
    // 工作区变了 / 启用态切换：重建运行时（文件不移动，UI 负责提示）
    if (workspaceChanged || enabledChanged) {
      await dropRuntime(id);
      const next = await ensureRuntime(record);
      if (!next) return { ok: false, error: '工作区已更新但运行时装配失败' };
      if (cfg.autoStart !== false && record.enabled !== false) {
        const bound = (next.config.appId || '') !== '' && (next.config.appSecret || '') !== '';
        if (bound) { try { await next.start(); } catch { /* ignore */ } }
      }
      return { ok: true, bot: next.snapshot() };
    }
    if (runtime) {
      runtime.record = record;
      runtime.name = record.name;
      if (patch && (patch.appId !== undefined || patch.appSecret !== undefined)) {
        // 凭据在 registry.update 时已落盘；这里只负责热重连（以磁盘为准）
        const creds = registry.credentials(id);
        try {
          await runtime.applyCredentials(creds, { persist: false });
        } catch (err) {
          log.warn('[host] 应用新凭据失败: ' + errText(err));
        }
      }
      if (record.enabled === false) {
        try { await runtime.stop(); } catch { /* ignore */ }
      } else if (record.enabled !== false && cfg.autoStart !== false) {
        const bound = (runtime.config.appId || '') !== '' && (runtime.config.appSecret || '') !== '';
        const state = runtime.botState();
        if (bound && state.ready !== true) {
          try { await runtime.start(); } catch { /* ignore */ }
        }
      }
    }
    return { ok: true, bot: runtime ? runtime.snapshot() : null };
  }

  async function deleteBot(id) {
    if (disposed) return { ok: false, error: '插件已卸载' };
    if (id === registry.activeId()) {
      const others = registry.list().filter((item) => item.id !== id);
      if (others.length === 0) return { ok: false, error: '至少保留一个机器人' };
      registry.setActive(others[0].id);
    }
    const removed = registry.remove(id);
    if (!removed.ok) return removed;
    await dropRuntime(id);
    return { ok: true, deleted: removed.deleted };
  }

  function activateBot(id) {
    return registry.setActive(id);
  }

  async function disposeAll() {
    if (disposed) return;
    disposed = true;
    for (const id of Array.from(runtimes.keys())) {
      await dropRuntime(id);
    }
  }

  host.startAll = startAll;
  host.getBot = getBot;
  host.activeBot = activeBot;
  host.runtimeFor = runtimeFor;
  host.resolveBot = resolveBot;
  host.listSnapshots = listSnapshots;
  host.createBot = createBot;
  host.updateBot = updateBot;
  host.deleteBot = deleteBot;
  host.activateBot = activateBot;
  host.disposeAll = disposeAll;
  /** 每个机器人的工作区状态（新增机器人时的默认路径提示）。 */
  host.defaultBotWorkspace = (id) => path.join(workspaceRoot, 'bots', String(id || 'bot'));

  // 先装配已有机器人（工具注册需要拿 active 机器人的 store 作兜底），再启动
  for (const record of registry.list()) {
    await ensureRuntime(record);
  }


  // ── 兼容 facade：字段代理到 active 机器人（旧路由/测试用） ──
  const facade = {
    __host: host,
    host: host,
    id: '',
    botId: '',
    name: '',
    record: null,
    version: '',
    getVersion: () => '',
  };
  for (const key of RUNTIME_KEYS) {
    Object.defineProperty(facade, key, {
      enumerable: true,
      configurable: true,
      get() { const bot = activeBot(); return bot ? bot[key] : undefined; },
    });
  }
  const delegateMethods = [
    'botState', 'restartBot', 'clearPending', 'resetAllSessions', 'getModelInfoSync', 'getModelInfo',
    'listModels', 'listPresets', 'presetInfo', 'applyCredentials', 'snapshot', 'pathSnapshot',
    'effectivePaths', 'ensureDirs', 'start', 'stop', 'dispose',
  ];
  for (const name of delegateMethods) {
    Object.defineProperty(facade, name, {
      enumerable: false,
      configurable: true,
      value: (...args) => {
        const bot = activeBot();
        if (!bot || typeof bot[name] !== 'function') {
          if (name === 'snapshot') return null;
          if (name === 'applyCredentials') return Promise.resolve({ ok: false, error: '没有可用机器人' });
          return undefined;
        }
        return bot[name](...args);
      },
    });
  }

  host.runtime = facade;
  // 首启：装配完再启动，避免网关先于运行时（index.js 会在注册完 web 路由后再启动）
  if (start !== false) {
    try {
      await startAll();
    } catch (err) {
      log.error('[host] 启动机器人失败: ' + errText(err));
    }
  }
  return host;
}

export default createBotHost;
