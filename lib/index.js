/**
 * index —— dsh-qqbot-buddy 插件入口与 runtime 装配（v0.16 多机器人）。
 *
 * 装配顺序：
 *   logger -> 工作区根 -> profileDir -> BotHost（注册表 + N 个机器人运行时 + 全局工具一次注册）
 *   -> web 路由 + 绑定路由（总是注册，即使没凭据/没有机器人在线）
 *   -> 启动各机器人（autoStart && 有凭据）-> 缺凭据时为 active 机器人自动扫码
 *
 * 兼容性：
 * - v0.15 的部署配置（appId/appSecret/cwd/stateDir/mediaDir/settingsFile）继续有效：
 *   首次启动会迁移出一条 legacy 机器人，数据路径原地不变；
 * - 未配置 workspaceRoot 时工作区根 = cwd，行为与单机器人版本一致；
 * - runtime 仍暴露 v0.15 的字段（代理到 active 机器人），旧 web 路由零改动可用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigSchema } from './config-schema.js';
import { createLogger } from './logger.js';
import { createBotHost } from './bots/host.js';
import { VERSION, readVersion } from './version.js';

export { VERSION };

/** 插件元数据（cordis）。 */
export const name = 'qqbot-buddy';
export const inject = ['agents'];
export const Config = ConfigSchema;

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
 * 定位 DSH profile 目录（扫码绑定写 patch 的历史逻辑；v0.16 起凭据写机器人
 * stateDir/credentials.json，这里保留探测结果供旧部署/诊断使用）。
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

/** 安全获取可选服务。 */
function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** 安全读取 ctx 上的属性（cordis 对未 inject 的服务访问会抛错）。 */
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

/** 解析配置文件里的凭据（配置优先，空则环境变量）。 */
function resolveEnv(value, envName) {
  const direct = typeof value === 'string' ? value.trim() : '';
  if (direct !== '') return direct;
  const fromEnv = process.env[envName];
  return typeof fromEnv === 'string' ? fromEnv.trim() : '';
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

  // ── 1. 工作区根 / profile ───────────────────────────────
  const cwd = resolveDir(cfg.cwd, process.cwd());
  const workspaceRoot = resolveDir(cfg.workspaceRoot, cwd);
  ensureDir(cwd, logger);
  ensureDir(workspaceRoot, logger);
  const configuredProfileDir = typeof cfg.profileDir === 'string' ? cfg.profileDir.trim() : '';
  const profileDir = configuredProfileDir !== ''
    ? resolveDir(configuredProfileDir, configuredProfileDir)
    : findProfileDir();
  if (profileDir) {
    logger.debug('profile 目录: ' + profileDir + (configuredProfileDir !== '' ? '（来自 config.profileDir）' : '（自动探测）'));
  } else {
    logger.warn('未能定位 DSH profile 目录（诊断信息降级，不影响其余功能）');
  }

  // ── 2. 多机器人宿主（注册表 + 运行时 + 工具） ───────────
  const hostConfig = Object.assign({}, cfg, {
    cwd: cwd,
    workspaceRoot: workspaceRoot,
    // 配置里的凭据只用于 legacy 迁移播种（空表示没有）
    appId: resolveEnv(cfg.appId, 'QQBOT_APPID'),
    appSecret: resolveEnv(cfg.appSecret, 'QQBOT_SECRET'),
    profileDir: profileDir || '',
  });
  const host = await createBotHost({
    ctx: ctx,
    config: hostConfig,
    logger: logger,
    start: false,
  });
  const runtime = host.runtime;

  // ── 3. web 路由（总是注册，即使没凭据/没有机器人在线） ──
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

  // ── 3.5 绑定 API 路由（按 botId 路由到对应机器人的绑定服务） ──
  try {
    const mod = await import('./web/bind-routes.js');
    if (!mod || typeof mod.registerBindRoutes !== 'function') {
      throw new Error('缺少 registerBindRoutes 导出');
    }
    const disposeBindRoutes = mod.registerBindRoutes(ctx, { runtime: runtime });
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

  // ── 4. 启动各机器人 ─────────────────────────────────────
  try {
    await host.startAll();
  } catch (err) {
    logger.error('启动机器人失败: ' + errText(err));
  }

  // ── 5. 卸载清理 ─────────────────────────────────────────
  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        host.disposeAll().catch((err) => logger.warn('释放多机器人宿主失败: ' + errText(err)));
      }, 'qqbot-buddy.host');
    } catch (err) {
      logger.warn('注册宿主生命周期失败: ' + errText(err));
    }
  }

  const bots = host.listSnapshots();
  logger.info('qqbot-buddy 已加载 (workspaceRoot=' + workspaceRoot + ', bots=' + bots.length
    + ', active=' + (host.registry.activeId() || '-') + (profileDir ? ', profileDir=' + profileDir : '') + ')');
  lastRuntime = runtime;
  apply.lastRuntime = runtime;
  // debug 模式把 runtime 挂到 globalThis，供 test/e2e 探针在宿主进程内断言（生产默认关闭）
  if (cfg.debug === true) {
    try {
      globalThis.__QQBOT_BUDDY_DEBUG__ = { runtime: runtime, host: host, version: readVersion(), at: Date.now() };
    } catch { /* ignore */ }
  }
  return;
}
