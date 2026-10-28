/**
 * index —— dsh-qqbot-buddy 插件入口与 runtime 装配。
 *
 * 装配顺序（DESIGN 约定）：
 *   logger -> 目录 -> profileDir -> settings -> persona -> memory（动态 import，失败降级 stub）
 *   -> collector -> prompt -> gateState -> manager -> gateway
 *   -> memory 工具（动态 import）-> 绑定服务（动态 import，降级 null）
 *   -> web 路由 + 绑定路由（总是注册，即使无凭据/binding 未就绪）
 *   -> bot gateway（autoStart 且凭据齐全才启动）-> 缺凭据时自动扫码绑定
 *
 * 并行开发容错：memory / collector / memory-tools / web 路由都用动态 import + try/catch，
 * 对应文件还没就绪时只 warn 不崩溃（也不产生 unhandled rejection）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigSchema } from './config-schema.js';
import { createLogger } from './logger.js';
import { resolveDefaults, createSettingsStore } from './settings-store.js';
import { createPersonaStore } from './persona-store.js';
import { createPromptComposer } from './prompt.js';
import { createGateState } from './qq/gate.js';
import { SessionManager } from './qq/session-manager.js';
import { createGateway } from './qq/gateway.js';

/** 插件元数据（cordis）。 */
export const name = 'qqbot-buddy';
export const inject = ['agents'];
export const Config = ConfigSchema;
import { VERSION, readVersion } from './version.js';

export { VERSION };

/**
 * 最近一次 apply 装配出的 runtime。
 * 注意：async apply 的 resolve 值会被 cordis 当作「effect/disposer」校验，
 * 返回非函数非空值会抛 TypeError: Invalid effect，所以 runtime 不能作为返回值，
 * 只能通过 apply.lastRuntime / getRuntime() 取（测试与调试用）。
 */
let lastRuntime = null;

/** 读取最近一次装配的 runtime（测试/调试用；未加载时返回 null）。 */
export function getRuntime() {
  return lastRuntime;
}

/** 错误转字符串。 */
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/** 展开 ~ / ~/ 前缀。 */
function expandHome(input) {
  if (typeof input !== 'string') return '';
  const raw = input.trim();
  if (raw === '') return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

/** 解析目录：空值用 fallback，展开 ~ 后转绝对路径。 */
function resolveDir(value, fallback) {
  const expanded = expandHome(value);
  const selected = expanded !== '' ? expanded : fallback;
  return path.resolve(selected);
}

/**
 * 定位 DSH profile 目录（扫码绑定要把凭据写进 <profile>/cordis.patch.yml）。
 *
 * 插件安装形态是 <profile>/node_modules/dsh-qqbot-buddy，而本包自身也带
 * cordis.patch.yml + package.json，因此向上查找时必须同时满足：
 *   - 目录同时存在 cordis.patch.yml 与 package.json；
 *   - 目录路径不含 node_modules（排除 node_modules/dsh-qqbot-buddy 自身与中间层）；
 *   - 不是本包根目录（排除仓库/安装包自身）。
 * 最多向上 8 层；找不到返回 undefined（绑定功能降级，不影响其它功能）。
 */
function findProfileDir() {
  try {
    const startDir = path.dirname(fileURLToPath(import.meta.url));
    const ownPackageDir = path.resolve(startDir, '..');
    let dir = startDir;
    for (let depth = 0; depth < 8; depth += 1) {
      const resolved = path.resolve(dir);
      const insideNodeModules = resolved.split(path.sep).includes('node_modules');
      const isOwnPackage = resolved === ownPackageDir;
      if (!insideNodeModules && !isOwnPackage
        && fs.existsSync(path.join(resolved, 'cordis.patch.yml'))
        && fs.existsSync(path.join(resolved, 'package.json'))) {
        return resolved;
      }
      const parent = path.dirname(resolved);
      if (parent === resolved) break;
      dir = parent;
    }
  } catch {
    /* 向上查找失败后继续走 link 安装的回退探测 */
  }
  // link: 安装（profile/package.json 指向 repo）时，插件从 repo 加载，
  // 向上找不到 profile；反过来从 $DSH_HOME/profiles/* 里找「node_modules 链接/依赖指向本包」的 profile。
  try {
    const ownPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const home = (process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
    const profilesDir = path.join(home, 'profiles');
    let ownName = '';
    try {
      ownName = String(JSON.parse(fs.readFileSync(path.join(ownPackageDir, 'package.json'), 'utf8')).name || '');
    } catch { /* ignore */ }
    const sameReal = (left, right) => {
      try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return false; }
    };
    let names = [];
    try { names = fs.readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { names = []; }
    const preferred = (process.env.DSH_PROFILE || '').trim();
    const ordered = preferred && names.includes(preferred) ? [preferred, ...names.filter((n) => n !== preferred)] : names;
    for (const name of ordered) {
      const candidate = path.join(profilesDir, name);
      if (!fs.existsSync(path.join(candidate, 'cordis.patch.yml')) || !fs.existsSync(path.join(candidate, 'package.json'))) continue;
      const linked = path.join(candidate, 'node_modules', ownName || 'dsh-qqbot-buddy');
      if (sameReal(linked, ownPackageDir)) return candidate;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
        const spec = manifest && manifest.dependencies ? manifest.dependencies[ownName || 'dsh-qqbot-buddy'] : '';
        if (typeof spec === 'string' && spec.trim().startsWith('link:')) {
          const target = spec.trim().slice(5);
          if (sameReal(target.startsWith('/') ? target : path.join(candidate, target), ownPackageDir)) return candidate;
        }
      } catch { /* ignore */ }
    }
  } catch {
    /* 定位失败按 undefined 处理 */
  }
  return undefined;
}

/** 配置值优先，空则回退环境变量。 */
function resolveEnv(value, envName) {
  const direct = typeof value === 'string' ? value.trim() : '';
  if (direct !== '') return direct;
  const fromEnv = process.env[envName];
  return typeof fromEnv === 'string' ? fromEnv.trim() : '';
}

/** 安全获取可选服务。 */
function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 安全读取 ctx 上的属性：cordis 对「未 inject 的服务」在属性访问时会抛错，
 * 入口处的 logger / agents 允许降级，因此统一用这个包装。
 */
function safeCtxProp(ctx, name) {
  try {
    return ctx ? ctx[name] : undefined;
  } catch {
    return undefined;
  }
}

/** 确保目录存在；失败只 warn。 */
function ensureDir(dir, logger) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger.warn('创建目录失败 ' + dir + ': ' + errText(err));
  }
}

/** 记忆模块不可用时的最小 stub（保证 prompt / web / memory-tools 不炸）。 */
function createMemoryStub({ settings, logger, reason } = {}) {
  const root = () => {
    try {
      return settings.get().memory.dir;
    } catch {
      return '';
    }
  };
  const unavailable = { ok: false, error: '记忆模块不可用: ' + (reason || '未安装') };
  logger.warn('使用最小 memory stub（' + (reason || '未安装') + '）');
  return {
    root: root,
    ensure: () => ({ ok: false, created: false, error: unavailable.error }),
    hotText: () => '',
    layout: () => ({ dir: root(), exists: false, files: [], totalChars: 0 }),
    search: () => [],
    saveFact: () => unavailable,
    appendDaily: () => unavailable,
    readFile: () => {
      throw new Error(unavailable.error);
    },
    writeFile: () => unavailable,
    index: () => ({ facts: [] }),
  };
}

/** collector 模块不可用时的最小 stub。 */
function createCollectorStub({ memoryStore, reason } = {}) {
  const error = '记忆收集模块不可用: ' + (reason || '未安装');
  return {
    noteTurnEnd: () => {},
    async collectNow() {
      return { ok: false, added: [], scannedMessages: 0, error: error };
    },
    stats: () => ({
      enabled: false,
      roundsSinceCollect: 0,
      lastCollectAt: 0,
      lastResult: null,
      lastError: error,
      totalCollected: 0,
    }),
  };
}

/**
 * 插件主体。
 * @param {object} ctx cordis 插件上下文
 * @param {object} config 经 ConfigSchema 校验后的部署配置
 */
export async function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const logger = createLogger(getService(ctx, 'logger') || safeCtxProp(ctx, 'logger') || console, 'qqbot-buddy', {
    debug: cfg.debug === true,
  });

  // ── 1. 解析目录 ─────────────────────────────────────────
  const cwd = resolveDir(cfg.cwd, process.cwd());
  const stateDir = resolveDir(cfg.stateDir, path.join(os.homedir(), '.dsh-qqbot', 'buddy'));
  const mediaDir = resolveDir(cfg.mediaDir, path.join(os.homedir(), '.dsh-qqbot', 'media'));
  const settingsFile = resolveDir(cfg.settingsFile, path.join(stateDir, 'settings.json'));
  ensureDir(stateDir, logger);
  ensureDir(mediaDir, logger);
  // profile 目录：扫码绑定写 patch 用；安装形态 <profile>/node_modules/dsh-qqbot-buddy
  // profile 目录：config.profileDir 优先（测试隔离/非标准安装），否则从安装位置自动探测。
  const configuredProfileDir = typeof cfg.profileDir === 'string' ? cfg.profileDir.trim() : '';
  const profileDir = configuredProfileDir !== ''
    ? resolveDir(configuredProfileDir, configuredProfileDir)
    : findProfileDir();
  if (profileDir) {
    logger.debug('profile 目录: ' + profileDir + (configuredProfileDir !== '' ? '（来自 config.profileDir）' : '（自动探测）'));
  } else {
    logger.warn('未能定位 DSH profile 目录（扫码绑定/解绑会降级，其余功能不受影响）');
  }

  // ── 2. settings / persona ──────────────────────────────
  const defaults = resolveDefaults({ cwd: cwd });
  const settings = createSettingsStore({ file: settingsFile, defaults: defaults, logger: logger });
  const persona = createPersonaStore({ settings: settings, stateDir: stateDir, logger: logger });

  // ── 2.5 人格卡 store（动态 import + 降级） ─────────────
  let personaCards;
  try {
    const mod = await import('./persona-cards-store.js');
    if (!mod || typeof mod.createPersonaCardsStore !== 'function') throw new Error('缺少 createPersonaCardsStore 导出');
    personaCards = mod.createPersonaCardsStore({
      settings: settings,
      personaStore: persona,
      cwd: cwd,
      logger: logger,
    });
  } catch (err) {
    logger.warn('加载 persona-cards-store.js 失败，人格卡功能降级: ' + errText(err));
    personaCards = undefined;
  }

  // ── 3. memory（并行开发：动态 import + 降级） ──────────
  let memoryStore;
  let memoryReason = '';
  try {
    const mod = await import('./memory/store.js');
    if (!mod || typeof mod.createMemoryStore !== 'function') throw new Error('缺少 createMemoryStore 导出');
    memoryStore = mod.createMemoryStore({ settings: settings, logger: logger });
  } catch (err) {
    memoryReason = errText(err);
    logger.warn('加载 memory/store.js 失败，降级为最小 stub: ' + memoryReason);
    memoryStore = createMemoryStub({ settings: settings, logger: logger, reason: memoryReason });
  }
  try {
    if (memoryStore && typeof memoryStore.ensure === 'function') memoryStore.ensure();
  } catch (err) {
    logger.warn('初始化记忆目录失败: ' + errText(err));
  }

  // ── 4. collector（动态 import + 降级） ─────────────────
  let collector;
  try {
    const mod = await import('./memory/collector.js');
    if (!mod || typeof mod.createCollector !== 'function') throw new Error('缺少 createCollector 导出');
    collector = mod.createCollector({
      ctx: ctx,
      settings: settings,
      memoryStore: memoryStore,
      logger: logger,
    });
  } catch (err) {
    logger.warn('加载 memory/collector.js 失败，降级为最小 stub: ' + errText(err));
    collector = createCollectorStub({ memoryStore: memoryStore, reason: errText(err) });
  }

  // ── 4.5 表情包 store（动态 import + 降级；文件未就绪不影响其它功能） ──
  let stickerStore;
  let stickersDir = path.join(cwd, 'stickers');
  try {
    const mod = await import('./stickers/store.js');
    if (!mod || typeof mod.createStickerStore !== 'function') throw new Error('缺少 createStickerStore 导出');
    stickerStore = mod.createStickerStore({ settings: settings, logger: logger });
  } catch (err) {
    stickerStore = undefined;
    logger.warn('加载 stickers/store.js 失败，表情包功能降级: ' + errText(err));
  }
  if (stickerStore) {
    try {
      if (typeof stickerStore.ensure === 'function') stickerStore.ensure();
    } catch (err) {
      logger.warn('初始化表情包目录失败: ' + errText(err));
    }
    try {
      const fromStore = typeof stickerStore.dir === 'function' ? stickerStore.dir() : '';
      if (typeof fromStore === 'string' && fromStore.trim() !== '') stickersDir = fromStore;
    } catch (err) {
      logger.warn('读取表情包目录失败: ' + errText(err));
    }
  }

  // ── 5. prompt / gate / stats ───────────────────────────
  const promptComposer = createPromptComposer({
    settings: settings,
    personaStore: persona,
    memoryStore: memoryStore,
    stickerStore: stickerStore,
    logger: logger,
  });
  const gateState = createGateState();
  const stats = {
    received: 0,
    triggered: 0,
    skipped: 0,
    replies: 0,
    lastReplyAt: 0,
    lastTriggerReason: '',
  };

  // ── 6. 凭据与 manager ──────────────────────────────────
  const appId = resolveEnv(cfg.appId, 'QQBOT_APPID');
  const appSecret = resolveEnv(cfg.appSecret, 'QQBOT_SECRET');
  const runtimeConfig = Object.assign({}, cfg, {
    appId: appId,
    appSecret: appSecret,
    cwd: cwd,
    // 解析后的绝对 mediaDir 也放进运行期 config：qqbot_sticker_save 等工具做路径白名单时
    // 需要它（QQ 附件下载目录是收藏表情最常用的来源）；cfg.mediaDir 默认是空串。
    mediaDir: mediaDir,
  });

  const manager = new SessionManager({
    ctx: ctx,
    agents: getService(ctx, 'agents') || safeCtxProp(ctx, 'agents'),
    config: runtimeConfig,
    settings: settings,
    promptComposer: promptComposer,
    stateDir: stateDir,
    logger: logger,
  });

  // ── 7. gateway（先建对象，后启动） ─────────────────────
  const gateway = createGateway({
    ctx: ctx,
    config: runtimeConfig,
    logger: logger,
    settings: settings,
    manager: manager,
    gateState: gateState,
    stats: stats,
    stateDir: stateDir,
    mediaDir: mediaDir,
    collector: collector,
  });

  // ── 8. runtime（web 路由契约，必须传「活对象」） ───────
  const runtime = {
    version: readVersion(),
    getVersion: () => readVersion(),
    config: runtimeConfig,
    ctx: ctx,
    logger: logger,
    settings: settings,
    persona: persona,
    personaCards: personaCards,
    memory: memoryStore,
    collector: collector,
    promptComposer: promptComposer,
    gateState: gateState,
    manager: manager,
    stats: stats,
    stateDir: stateDir,
    mediaDir: mediaDir,
    cwd: cwd,
    settingsFile: settingsFile,
    /** 表情包目录（store 可用时取 store.dir()，否则 cwd/stickers）。 */
    stickersDir: stickersDir,
    /** 表情包 store 实例（lib/stickers/store.js 未就绪时为 undefined）。 */
    stickers: stickerStore,
    /** DSH profile 目录（扫码绑定写 cordis.patch.yml 用；定位失败为 undefined）。 */
    profileDir: profileDir,
    /** 绑定服务实例（lib/binding/service.js 未就绪时为 null）。 */
    binding: null,
    botState: () => gateway.botState(),
    restartBot: () => gateway.restartBot(),
    clearPending: () => gateway.clearPending(),
    /** adaptive 模式调度器（供 web 路由 / QA 观测运行期缓冲；未启用也可安全读取）。 */
    adaptive: gateway.adaptive,
    /** 应用模型：释放全部内存会话，下一条消息按新 settings.model 重建。 */
    resetAllSessions: () => manager.resetAll(),
    /** 同步模型信息（selected/effective/source/hostDefault）。 */
    getModelInfoSync: () => manager.getModelInfoSync(),
    /** 异步模型信息（额外含 providers），/api/models 用。 */
    getModelInfo: () => manager.getModelInfo(),
    /** 宿主可用模型列表：[{id, models:[{id,name}]}]。 */
    listModels: () => manager.listModels(),
    /** 宿主可用 agent preset 列表（/api/presets；服务不可用返回 []）。 */
    listPresets: () => manager.listPresets(),
    /** preset 选择信息：selected / effective / builtIn / defaultPreset。 */
    presetInfo: () => manager.presetInfo(),
    /**
     * 应用新的 QQ 凭据（扫码/手动绑定、解绑时由绑定服务回调或 web 路由调用）。
     * 返回 {ok, bound?, error?}；空凭据表示解绑（只停 bot，不报错）。
     */
    applyCredentials: async (credentials) => {
      const input = credentials && typeof credentials === 'object' ? credentials : {};
      const nextAppId = typeof input.appId === 'string' ? input.appId.trim() : '';
      const nextAppSecret = typeof input.appSecret === 'string' ? input.appSecret.trim() : '';
      // 先同步运行期 config（manager 的 sessionKey 依赖同一个对象引用）
      runtimeConfig.appId = nextAppId;
      runtimeConfig.appSecret = nextAppSecret;
      try {
        return await gateway.applyCredentials({ appId: nextAppId, appSecret: nextAppSecret });
      } catch (err) {
        logger.error('应用新凭据失败: ' + errText(err));
        return { ok: false, error: errText(err) };
      }
    },
  };

  // ── 8.5 绑定服务（扫码/手动绑定；模块未就绪时降级为 null，不影响其余功能） ──
  try {
    const mod = await import('./binding/service.js');
    if (!mod || typeof mod.createBindingService !== 'function') {
      throw new Error('缺少 createBindingService 导出');
    }
    runtime.binding = mod.createBindingService({
      logger: logger,
      profileDir: profileDir,
      getCredentials: () => ({
        appId: runtimeConfig.appId || '',
        appSecret: runtimeConfig.appSecret || '',
      }),
      onBound: async (credentials) => {
        const bound = credentials && typeof credentials === 'object' ? credentials : {};
        runtimeConfig.appId = typeof bound.appId === 'string' ? bound.appId.trim() : '';
        runtimeConfig.appSecret = typeof bound.appSecret === 'string' ? bound.appSecret.trim() : '';
        const result = await runtime.applyCredentials({
          appId: runtimeConfig.appId,
          appSecret: runtimeConfig.appSecret,
        });
        if (!result || result.ok === false) {
          logger.warn('绑定成功后启动网关失败: ' + ((result && result.error) || 'unknown'));
        }
      },
      onUnbind: async () => {
        runtimeConfig.appId = '';
        runtimeConfig.appSecret = '';
        const result = await runtime.applyCredentials({ appId: '', appSecret: '' });
        if (!result || result.ok === false) {
          logger.warn('解绑后停止网关失败: ' + ((result && result.error) || 'unknown'));
        }
      },
      source: 'dsh-qqbot-buddy',
    });
    logger.info('绑定服务已就绪' + (profileDir ? '' : '（未定位到 profileDir，写 patch 会降级）'));
    // 卸载时释放绑定服务的定时器/连接
    if (typeof runtime.binding.dispose === 'function' && ctx && typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => () => {
          try {
            runtime.binding.dispose();
          } catch (err) {
            logger.warn('释放绑定服务失败: ' + errText(err));
          }
        }, 'qqbot-buddy.binding');
      } catch (err) {
        logger.warn('注册绑定服务生命周期失败: ' + errText(err));
      }
    }
  } catch (err) {
    runtime.binding = null;
    logger.warn('绑定服务不可用（扫码绑定降级）: ' + errText(err));
  }

  // ── 9. memory 工具（动态 import；DESIGN 顺序：工具注册在 web 路由之前） ──
  try {
    const mod = await import('./tools/memory-tools.js');
    if (!mod || typeof mod.registerMemoryTools !== 'function') throw new Error('缺少 registerMemoryTools 导出');
    const disposeTools = mod.registerMemoryTools(ctx, memoryStore, logger);
    if (typeof disposeTools === 'function' && ctx && typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => disposeTools, 'qqbot-buddy.memory-tools');
      } catch (err) {
        logger.warn('注册 memory 工具生命周期失败: ' + errText(err));
      }
    }
  } catch (err) {
    logger.warn('注册 memory 工具失败: ' + errText(err));
  }

  // ── 9.5 表情包工具（动态 import；store 未就绪时由工具模块自身降级） ──
  try {
    const mod = await import('./tools/sticker-tools.js');
    if (!mod || typeof mod.registerStickerTools !== 'function') throw new Error('缺少 registerStickerTools 导出');
    const disposeStickerTools = mod.registerStickerTools(ctx, {
      stickerStore: stickerStore,
      config: runtimeConfig,
      logger: logger,
    });
    if (typeof disposeStickerTools === 'function' && ctx && typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => () => {
          try {
            disposeStickerTools();
          } catch (err) {
            logger.warn('释放表情包工具失败: ' + errText(err));
          }
        }, 'qqbot-buddy.sticker-tools');
      } catch (err) {
        logger.warn('注册表情包工具生命周期失败: ' + errText(err));
      }
    }
  } catch (err) {
    logger.warn('注册表情包工具失败: ' + errText(err));
  }

  // ── 10. web 路由（总是注册，即使没凭据/没 bot） ────────
  try {
    const mod = await import('./web/routes.js');
    if (!mod || typeof mod.registerWebRoutes !== 'function') throw new Error('缺少 registerWebRoutes 导出');
    const disposeRoutes = mod.registerWebRoutes(ctx, runtime);
    if (typeof disposeRoutes === 'function' && ctx && typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => () => {
          try {
            disposeRoutes();
          } catch (err) {
            logger.warn('释放 web 路由失败: ' + errText(err));
          }
        }, 'qqbot-buddy.web-routes');
      } catch (err) {
        logger.warn('注册 web 路由生命周期失败: ' + errText(err));
      }
    }
  } catch (err) {
    logger.warn('注册 web 路由失败（设置页不可用）: ' + errText(err));
  }

  // ── 10.5 绑定 API 路由（即使 binding 为 null 也要注册：/api/bind/state 返回 idle） ──
  try {
    const mod = await import('./web/bind-routes.js');
    if (!mod || typeof mod.registerBindRoutes !== 'function') {
      throw new Error('缺少 registerBindRoutes 导出');
    }
    const disposeBindRoutes = mod.registerBindRoutes(ctx, {
      binding: runtime.binding,
      runtime: runtime,
    });
    if (typeof disposeBindRoutes === 'function' && ctx && typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => () => {
          try {
            disposeBindRoutes();
          } catch (err) {
            logger.warn('释放绑定路由失败: ' + errText(err));
          }
        }, 'qqbot-buddy.bind-routes');
      } catch (err) {
        logger.warn('注册绑定路由生命周期失败: ' + errText(err));
      }
    }
  } catch (err) {
    logger.warn('注册绑定路由失败（扫码绑定 API 不可用）: ' + errText(err));
  }

  // ── 11. 启动 bot gateway ───────────────────────────────
  if (cfg.autoStart === false) {
    logger.warn('autoStart=false，不启动 QQ 网关（仅保留设置页）');
  } else {
    try {
      await gateway.start();
    } catch (err) {
      logger.error('QQ 网关启动失败: ' + errText(err));
    }
  }

  // ── 12. 缺少凭据且允许时，自动启动扫码绑定流程 ─────────
  // 已绑定（有凭据）时不启动；绑定服务本身仍保留，供 UI「更换绑定/解绑」使用。
  // 隔离测试/调试可用 config.bindOnMissingCredentials=false 关闭，避免真实联网取二维码。
  if (cfg.bindOnMissingCredentials !== false
    && runtime.binding
    && typeof runtime.binding.start === 'function') {
    const hasCredentials = (runtimeConfig.appId || '').trim() !== ''
      && (runtimeConfig.appSecret || '').trim() !== '';
    if (!hasCredentials) {
      try {
        runtime.binding.start();
        logger.info('未配置 QQ 凭据，已启动扫码绑定流程');
      } catch (err) {
        logger.warn('启动扫码绑定流程失败: ' + errText(err));
      }
    }
  }

  logger.info('qqbot-buddy 已加载 (cwd=' + cwd + ', stateDir=' + stateDir
    + (profileDir ? ', profileDir=' + profileDir : '') + ')');
  // async apply 的 resolve 值会被 cordis 当 effect 校验（Invalid effect），所以这里不 return runtime；
  // 需要 runtime 的调用方用 apply.lastRuntime / getRuntime()。
  lastRuntime = runtime;
  apply.lastRuntime = runtime;
  return;
}