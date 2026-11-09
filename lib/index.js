/**
 * index —— dsh-qqbot-buddy v2 插件入口。
 *
 * 装配顺序：logger → 目录/DB → 配置 store → 事件总线 → 数据能力(kb/memory)
 *   → 控制台服务 → 机器人宿主 → 生命周期 effect。
 * 任一子模块缺失/失败都只告警，保证插件本身能加载（设置页/控制台仍可用）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigSchema } from './config-schema.js';
import { createLogger } from './logger.js';
import { openDb, closeDb } from './core/db.js';
import { createConfigStore } from './core/config/store.js';
import { createEvents } from './core/events.js';
import { VERSION } from './version.js';

export const name = 'qqbot-buddy';
export const inject = ['agents'];
export const Config = ConfigSchema;

let lastRuntime = null;

/** 最近一次装配的 runtime（测试/调试用）。 */
export function getRuntime() {
  return lastRuntime;
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function expandHome(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function resolveDir(value, fallback) {
  const expanded = expandHome(value);
  return path.resolve(expanded !== '' ? expanded : fallback);
}

function ensureDir(dir, logger, mode = 0o700) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode });
    try { fs.chmodSync(dir, mode); } catch { /* 非 POSIX 忽略 */ }
  } catch (err) {
    logger.warn('建目录失败 ' + dir + ': ' + errText(err));
  }
}

/** 取宿主服务（带异常保护）。 */
function getService(ctx, serviceName) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(serviceName);
    if (ctx && ctx[serviceName]) return ctx[serviceName];
  } catch { /* ignore */ }
  return undefined;
}

export async function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const logger = createLogger(getService(ctx, 'logger') || console, 'qqbot-buddy', { debug: cfg.debug === true });

  const dataDir = resolveDir(cfg.dataDir, path.join(os.homedir(), '.dsh-qqbot', 'v2'));
  const workspaceRoot = resolveDir(cfg.workspaceRoot, process.cwd());
  ensureDir(dataDir, logger);
  ensureDir(workspaceRoot, logger, 0o755);

  const dbPath = path.join(dataDir, 'buddy.db');
  let db;
  try {
    db = openDb(dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch { /* ignore */ }
  } catch (err) {
    logger.error('打开数据库失败，插件降级为不可用: ' + errText(err));
    throw err;
  }

  const configStore = createConfigStore({ db, workspaceRoot });
  const events = createEvents({ logger });
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const paths = {
    dataDir,
    dbPath,
    workspaceRoot,
    tokenFile: path.join(dataDir, 'console-token.txt'),
    webDist: path.join(repoRoot, 'web', 'dist'),
    botCwd: (botId) => configStore.defaultCwd(botId),
  };

  const runtime = {
    version: VERSION,
    logger,
    db,
    config: configStore,
    events,
    paths,
    cfg,
    console: null,
    host: null,
    startedAt: Date.now(),
    dispose: [],
  };

  // ── 数据能力（kb / memory）──
  try {
    const kbMod = await import('./core/kb/store.js');
    runtime.kb = kbMod.createKbStore({ db });
  } catch (err) { logger.warn('知识库模块不可用: ' + errText(err)); runtime.kb = null; }
  try {
    const memMod = await import('./core/memory/store.js');
    runtime.memory = memMod.createMemoryStore({ db });
  } catch (err) { logger.warn('记忆模块不可用: ' + errText(err)); runtime.memory = null; }

  // ── 控制台 ──
  if (cfg.console?.enabled !== false) {
    try {
      const mod = await import('./console/server.js');
      runtime.console = await mod.createConsoleServer({
        deps: {
          db,
          config: configStore,
          kb: runtime.kb,
          memory: runtime.memory,
          events,
          paths,
          logger,
          getHost: () => runtime.host,
          runtime: {
            getStatus() {
              const snapshots = runtime.host && typeof runtime.host.snapshot === 'function' ? runtime.host.snapshot() : [];
              const bots = {};
              for (const item of snapshots) bots[item.id] = item;
              return { online: snapshots.some((item) => item.status === 'ready'), bots };
            },
          },
        },
        host: cfg.console?.host || '127.0.0.1',
        // 注意：port=0 表示随机端口（测试用），不能用 || 兜底
        port: cfg.console?.port !== undefined && cfg.console?.port !== null ? Number(cfg.console.port) : 6198,
        token: typeof cfg.console?.token === 'string' ? cfg.console.token : '',
        logger,
      });
      await runtime.console.start();
      logger.info('控制台已启动: ' + String(runtime.console.address()));
    } catch (err) {
      logger.warn('控制台启动失败（不影响机器人）: ' + errText(err));
      runtime.console = null;
    }
  }

  // ── 机器人宿主 ──
  try {
    const mod = await import('./host/agent.js');
    runtime.host = await mod.createBotHost({ ctx, runtime, config: cfg, logger });
    // QQ 传输层：lib/qq/gateway.js 提供 createQqTransportFactory，按 bot 注册
    try {
      const gw = await import('./qq/gateway.js');
      if (gw && typeof gw.createQqTransportFactory === 'function') {
        const factory = gw.createQqTransportFactory({ ctx, runtime, logger });
        for (const bot of runtime.host.list()) {
          runtime.host.registerTransport(bot.id, (instance) => factory(instance));
        }
      }
    } catch (err) {
      logger.warn('QQ 传输层未就绪: ' + errText(err));
    }
    if (cfg.autoStart !== false) await runtime.host.startAll();
  } catch (err) {
    logger.warn('机器人宿主不可用: ' + errText(err));
    runtime.host = null;
  }

  // ── 生命周期 ──
  if (ctx && typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        (async () => {
          try { await runtime.host?.disposeAll?.(); } catch (err) { logger.warn('停止机器人失败: ' + errText(err)); }
          try { await runtime.console?.stop?.(); } catch (err) { logger.warn('停止控制台失败: ' + errText(err)); }
          try { events.clear(); } catch { /* ignore */ }
          try { closeDb(db); } catch { /* ignore */ }
        })();
      }, 'qqbot-buddy.v2.lifecycle');
    } catch (err) {
      logger.warn('注册生命周期失败: ' + errText(err));
    }
  }

  lastRuntime = runtime;
  apply.lastRuntime = runtime;
  if (cfg.debug === true) {
    try { globalThis.__QQBOT_V2_DEBUG__ = { runtime, at: Date.now() }; } catch { /* ignore */ }
  }
  logger.info('qqbot-buddy v2 已加载 (dataDir=' + dataDir + ', workspace=' + workspaceRoot + ')');
  return runtime;
}

export { VERSION };
