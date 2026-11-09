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

  // dsh Web 入口（带鉴权 token 的 URL）：控制台顶栏「dsh Web」按钮用。
  // web-app/connection 服务可能晚于本插件就绪，用 ctx.inject 等待后回填。
  runtime.dshWeb = { url: '', ready: false, error: '' };
  try {
    ctx.inject(['webApp', 'connection'], (wctx) => {
      try {
        const root = wctx.webApp && typeof wctx.webApp.getAdvertisedUrl === 'function' ? wctx.webApp.getAdvertisedUrl() : '';
        const connection = wctx.connection;
        const url = root !== '' && connection && typeof connection.authenticatedUrl === 'function'
          ? connection.authenticatedUrl(root)
          : root;
        runtime.dshWeb = { url: typeof url === 'string' ? url : '', ready: true, error: '' };
      } catch (err) {
        runtime.dshWeb = { url: '', ready: true, error: errText(err) };
        logger.warn('dsh Web 入口获取失败: ' + errText(err));
      }
    });
  } catch (err) {
    logger.warn('dsh Web 入口注入失败: ' + errText(err));
  }

  // 技能 provider（v1 的 lib/skills/provider.js 等价物）：
  // qqbot profile 不带 dsh-skill-filesystem，宿主 skills 服务没有 provider →
  // 技能目录为空、dsh-tool-skill 的 <available_skills> 也不会出现（bili-get / summary-card 消失的根因）。
  // 这里用自研 provider（host/skills.js）而不是宿主 filesystem provider：
  // dsh-skill 调 provider.list({ scope: agent, cwd }) 时能按该 agent 的生效设置过滤技能白名单，
  // 宿主的 filesystem provider 没有这个钩子（只能全量）。
  try {
    const skillMod = await import('./host/skills.js');
    runtime.skillsProvider = skillMod.createSkillProvider({ runtime, workspaceRoot, logger });
    const registerInto = (svc) => {
      try {
        if (!svc || typeof svc.registerProvider !== 'function') throw new Error('skills.registerProvider 不可用');
        svc.registerProvider(() => runtime.skillsProvider);
        runtime.skillProvider = true;
      } catch (err) {
        logger.warn('技能 provider 注册失败（技能将不可用）: ' + errText(err));
      }
    };
    const existing = typeof ctx.get === 'function' ? ctx.get('skills') : undefined;
    if (existing && typeof existing.registerProvider === 'function') registerInto(existing);
    else ctx.inject(['skills'], (sctx) => registerInto(sctx.skills));
  } catch (err) {
    logger.warn('技能 provider 初始化失败（技能将不可用）: ' + errText(err));
  }

  // ── 数据能力（kb / memory）──
  try {
    const kbMod = await import('./core/kb/store.js');
    runtime.kb = kbMod.createKbStore({ db });
  } catch (err) { logger.warn('知识库模块不可用: ' + errText(err)); runtime.kb = null; }
  try {
    const memMod = await import('./core/memory/store.js');
    runtime.memory = memMod.createMemoryStore({ db });
  } catch (err) { logger.warn('记忆模块不可用: ' + errText(err)); runtime.memory = null; }

  // 群友库 / 人格卡 / 表情包（bot 级数据）
  try {
    const mod = await import('./core/members/store.js');
    runtime.members = mod.createMembersStore({ db });
  } catch (err) { logger.warn('群友库不可用: ' + errText(err)); runtime.members = null; }
  try {
    const mod = await import('./core/personas/store.js');
    runtime.personas = mod.createPersonasStore({ db, logger });
  } catch (err) { logger.warn('人格卡不可用: ' + errText(err)); runtime.personas = null; }
  try {
    const mod = await import('./core/stickers/store.js');
    runtime.stickers = mod.createStickersStore({ db, logger });
  } catch (err) { logger.warn('表情包不可用: ' + errText(err)); runtime.stickers = null; }

  // 旁路 LLM（记忆提炼/知识抽取共用）与自动提炼器
  try {
    const llmMod = await import('./host/llm.js');
    runtime.oneShot = llmMod.createOneShot({ ctx, logger });
  } catch (err) { logger.warn('one-shot LLM 不可用: ' + errText(err)); runtime.oneShot = null; }
  if (runtime.memory && runtime.oneShot) {
    try {
      const colMod = await import('./core/memory/collect.js');
      runtime.memoryCollector = colMod.createMemoryCollector({
        memory: runtime.memory, oneShot: runtime.oneShot, db, logger,
      });
    } catch (err) { logger.warn('记忆提炼器不可用: ' + errText(err)); runtime.memoryCollector = null; }
  }

  // ── 工具/技能发现（控制台 + 工具策略共用）──
  let discovery = null;
  try {
    const mod = await import('./host/discovery.js');
    discovery = mod.createDiscovery({ ctx, runtime, logger, cwd: workspaceRoot });
    await discovery.refresh();
  } catch (err) { logger.warn('工具发现模块不可用: ' + errText(err)); }

  // 控制台 deps 用常量持有：start() 会把内建 auth 回填到 deps.auth，设置页需要读 token
  const consoleDeps = {
    db,
    config: configStore,
    kb: runtime.kb,
    memory: runtime.memory,
    members: runtime.members,
    personas: runtime.personas,
    stickers: runtime.stickers,
    events,
    paths,
    logger,
    toolsDiscover: discovery || undefined,
    dshWeb: runtime.dshWeb,
    getHost: () => runtime.host,
    actions: {
      async run(name, body = {}) {
        const host = runtime.host;
        const botId = typeof body.botId === 'string' ? body.botId : '';
        const requireHost = () => {
          if (!host) throw new Error('机器人宿主尚未装配');
          return host;
        };
        switch (String(name)) {
          // 诊断用：工具/技能可见性与 skills 服务状态
          case 'debug-skills': {
            const instance = requireHost().ensureRuntime(botId || (host && host.bots && [...host.bots.keys()][0]) || '');
            const peer = typeof body.peer === 'string' && body.peer !== '' ? body.peer : [...((instance && instance.sessions && instance.sessions.keys()) || [])][0] || '';
            const out = { botId: instance ? instance.id : '', peer, hasService: false, names: null, error: null, visibleTools: [], discoverySkills: [] };
            try {
              const rootCtx = host && host.ctx ? host.ctx : null;
              const svc = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('skills') : rootCtx && rootCtx.skills;
              out.hasService = Boolean(svc && typeof svc.list === 'function');
              const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : '/home/qiqi/project/qqbot';
              if (out.hasService) {
                const res = await svc.list({ cwd });
                out.names = (Array.isArray(res) ? res : res && Array.isArray(res.skills) ? res.skills : []).map((item) => item && item.name);
                const res2 = await svc.list({});
                out.namesNoCwd = (Array.isArray(res2) ? res2 : res2 && Array.isArray(res2.skills) ? res2.skills : []).map((item) => item && item.name);
              }
            } catch (err) { out.error = String((err && err.message) || err); }
            try {
              const ref = instance && instance.promptRefs ? instance.promptRefs.get(peer) : null;
              if (ref && ref.agentCtx && typeof ref.agentCtx.tools?.view === 'function') {
                const view = ref.agentCtx.tools.view(ref.agent);
                out.visibleTools = [...(view.visible ? view.visible.keys() : [])];
              }
            } catch (err) { out.visibleError = String((err && err.message) || err); }
            try { out.discoverySkills = discovery ? discovery.listSkills().map((item) => item.name) : []; } catch { /* ignore */ }
            // /tools /skills 命令共用同一数据源：顺便把 visibility 暴露给控制台诊断
            try {
              out.visibility = instance && typeof instance.visibility === 'function'
                ? await instance.visibility(peer)
                : { source: 'none', tools: [], skills: [] };
            } catch (err) { out.visibilityError = String((err && err.message) || err); }
            return out;
          }
          // 诊断用：注入一条"假入站消息"，返回本轮召回结果，便于在不发 QQ 的情况下验证 prompt 注入。
          case 'debug-followup': {
            const peer = typeof body.peer === 'string' && body.peer !== '' ? body.peer : '';
            const text = typeof body.text === 'string' ? body.text : '';
            if (botId === '' || peer === '' || text === '') throw new Error('debug-followup 需要 botId/peer/text');
            const instance = requireHost().ensureRuntime(botId);
            if (!instance) throw Object.assign(new Error('bot 不存在: ' + botId), { code: 'bot_not_found' });
            const recallQuery = typeof body.recallQuery === 'string' && body.recallQuery !== '' ? body.recallQuery : text;
            const senderId = typeof body.senderId === 'string' ? body.senderId : undefined;
            const result = await instance.followup(peer, { text, recallQuery, senderId });
            return {
              ok: true,
              ...(result || {}),
              recallQuery,
              memoryText: instance.memoryText ? instance.memoryText.get(peer) || '' : '',
              knowledgeText: instance.knowledgeText ? instance.knowledgeText.get(peer) || '' : '',
              memberText: instance.membersText ? instance.membersText.get(peer) || '' : '',
            };
          }
          case 'extract': {
            if (!runtime.memoryCollector) throw new Error('记忆提炼器未装配');
            const peer = typeof body.peer === 'string' && body.peer !== '' ? body.peer : 'console';
            const transcript = typeof body.transcript === 'string' ? body.transcript : '';
            if (botId === '') throw new Error('extract 需要 botId');
            return await runtime.memoryCollector.collectNow({ botId, peer, transcript });
          }
          case 'ingest-url': {
            if (!runtime.kb) throw new Error('知识库未装配');
            if (botId === '') throw new Error('ingest-url 需要 botId');
            const url = typeof body.url === 'string' ? body.url : '';
            if (url === '') throw new Error('ingest-url 需要 url');
            const { ingestUrl } = await import('./core/kb/ingest-url.js');
            return await ingestUrl({ kb: runtime.kb, botId, url, title: typeof body.title === 'string' ? body.title : '' });
          }
          case 'start-bot': {
            const instance = requireHost().ensureRuntime(botId);
            if (!instance) {
              const missing = new Error('bot 不存在: ' + botId);
              missing.code = 'bot_not_found';
              throw missing;
            }
            const ok = await instance.start();
            if (!ok) {
              const startError = new Error(instance.lastError || '机器人启动失败（详情见日志）');
              startError.code = 'start_failed';
              throw startError;
            }
            return { ok: true, status: instance.status };
          }
          case 'stop-bot': {
            const instance = requireHost().runtimeOf(botId);
            if (instance) await instance.dispose();
            return { ok: true };
          }
          case 'restart-bot': {
            const instance = requireHost().ensureRuntime(botId);
            if (!instance) throw new Error('bot 不存在: ' + botId);
            await instance.dispose();
            const ok = await instance.start();
            if (!ok) {
              const startError = new Error(instance.lastError || '机器人重启失败（详情见日志）');
              startError.code = 'restart_failed';
              throw startError;
            }
            return { ok: true, status: instance.status };
          }
          case 'reset-peer': {
            const peer = typeof body.peer === 'string' ? body.peer : '';
            if (botId === '' || peer === '') throw new Error('reset-peer 需要 botId 与 peer');
            return await requireHost().resetPeer(botId, peer);
          }
          case 'refresh-discovery': {
            if (discovery) await discovery.refresh();
            return { ok: true, tools: discovery ? discovery.list().length : 0, skills: discovery ? discovery.listSkills().length : 0 };
          }
          default:
            throw new Error('未知动作: ' + name);
        }
      },
    },
    runtime: {
      getStatus() {
        const snapshots = runtime.host && typeof runtime.host.snapshot === 'function' ? runtime.host.snapshot() : [];
        const bots = {};
        for (const item of snapshots) bots[item.id] = item;
        return { online: snapshots.some((item) => item.status === 'ready'), bots };
      },
    },
  };

  // ── 控制台 ──
  if (cfg.console?.enabled !== false) {
    try {
      const mod = await import('./console/server.js');
      runtime.console = await mod.createConsoleServer({
        deps: consoleDeps,
        host: cfg.console?.host || '127.0.0.1',
        // 注意：port=0 表示随机端口（测试用），不能用 || 兜底
        port: cfg.console?.port !== undefined && cfg.console?.port !== null ? Number(cfg.console.port) : 6198,
        token: typeof cfg.console?.token === 'string' ? cfg.console.token : '',
        logger,
      });
      await runtime.console.start();
      // start() 会把内建 auth 回填到 deps.auth：设置页/token 展示用
      runtime.consoleAuth = consoleDeps.auth || null;
      runtime.discovery = discovery;
      const address = runtime.console.address();
      logger.info('控制台已启动: ' + (address && address.url ? address.url : String(address)));
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
        // 全局工厂：控制台运行期新建的 bot 也会自动挂载
        runtime.host.setTransportFactory((instance) => factory(instance));
      }
      // 插件作用域工具（qqbot_* / memory_*）：注册到每个 agent scope
      try {
        const toolMod = await import('./tools/index.js');
        if (toolMod && typeof toolMod.createToolFactory === 'function') {
          const pluginToolFactory = toolMod.createToolFactory({ ctx, runtime, logger });
          const mountMod = await import('./host/tool-mounts.js');
          // 先按能力把宿主工具插件（fs/web/bash/skill…）挂到 agent scope，再注册插件自带工具
          runtime.toolFactory = async (args) => {
            let mounted = [];
            try {
              mounted = await mountMod.mountFeatureTools({ agentCtx: args.agentCtx, settings: args.settings, logger });
            } catch (err) {
              logger.warn('挂载宿主工具插件失败（继续）: ' + errText(err));
            }
            const registered = await pluginToolFactory(args);
            return { mounted, ...(registered && typeof registered === 'object' ? registered : {}) };
          };
          runtime.host.setToolFactory(runtime.toolFactory);
        }
      } catch { /* 工具包尚未提供时静默跳过（M2b） */ }
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
  // 注意：cordis 会把 async apply 的返回值当作 effect 收集（then(safeCollect)），
  // 返回普通对象会抛 "TypeError: Invalid effect" 并卸载整个插件。
  // 因此这里**不能 return runtime**；调试用 getRuntime() / apply.lastRuntime。
}

export { VERSION };
