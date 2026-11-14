/**
 * reports/service —— 群日报服务：定时器 + 手动生成 + 主动投递 + 关系增量。
 *
 * 调度模型（刻意不用 dsh 的 schedule，那个只会往会话注入一条 user 消息）：
 *   - 每 30s 扫一次；按 peer 的生效设置（profile 级 daily.*）判断是否到点；
 *   - peer 发现来自 flow_messages（最近 36h 活跃的群），daily.peers 是过滤器；
 *   - 每天每群最多一次（daily_reports 唯一键 + 进程内 attempted 集合）；
 *   - catchUp：进程重启/错过时间点，6 小时内仍会补生成。
 */
import path from 'node:path';

import { generateDaily, localDay } from './daily.js';
import { renderCard as renderCardDefault } from './cards.js';
import { updateRelations } from './relation.js';
import { resolveTemplate } from './template-registry.js';

const TICK_MS = 30 * 1000;
/** 错过时间点后的补跑窗口。 */
const CATCH_UP_MS = 6 * 60 * 60 * 1000;
/** 默认投递窗口（未开 catchUp 时只在这个窗口内触发）。 */
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/** 'HH:MM' → 当天毫秒时间戳；非法返回 null。 */
export function parseTimeOfDay(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return (hour * 60 + minute) * 60 * 1000;
}

/** peer 归一化：允许只写群 openid。 */
export function normalizePeer(value) {
  const text = String(value || '').trim();
  if (text === '') return '';
  return text.includes(':') ? text : 'group:' + text;
}

/**
 * 按 daily.visualMode / daily.visualMood 决定是否强制氛围。
 *   auto   不强制（模型选，没选按高峰时段兜底）；
 *   random 从模板声明的氛围里随机一组；
 *   fixed  用指定氛围（非法/缺失回退 auto）。
 * @param {object} settings 生效设置
 * @param {{moods?: Array<{id:string}>}|null} visualConfig 模板的 visuals 声明
 * @returns {string} 合法氛围 id，或空串表示不强制
 */
export function plannedMood(settings, visualConfig) {
  const moods = visualConfig && Array.isArray(visualConfig.moods) ? visualConfig.moods : [];
  if (moods.length === 0) return '';
  const daily = (settings && settings.daily) || {};
  const mode = String(daily.visualMode || 'auto');
  const ids = moods.map((mood) => mood.id);
  if (mode === 'fixed') {
    const wanted = String(daily.visualMood || '').trim();
    return ids.includes(wanted) ? wanted : '';
  }
  if (mode === 'random') return ids[Math.floor(Math.random() * ids.length)];
  return '';
}

export function createDailyService({
  config, flow, reports, oneShot, members, host, logger, now = Date.now,
  dataDir = '', workspaceRoot = '', render = renderCardDefault,
} = {}) {
  const log = logger || console;
  const attempted = new Set(); // bot|peer|day
  const running = new Set();
  let timer = null;

  /** 当前模板声明的插画槽（meta.json 的 visuals）；没有 / 模板缺失返回 null。 */
  function visualConfigFor(templateName) {
    try {
      const entry = resolveTemplate(templateName, { dataDir });
      return entry ? entry.visuals : null;
    } catch {
      return null;
    }
  }

  function settingsFor(botId, peer) {
    try {
      return (config && typeof config.getEffectiveSettings === 'function'
        ? config.getEffectiveSettings(botId, peer)
        : {}) || {};
    } catch {
      return {};
    }
  }

  /** peer → 安全的文件名片段（group:xxx → group-xxx）。 */
  function safePeer(peer) {
    return String(peer || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'peer';
  }

  /**
   * 渲染日报卡片；失败返回 null（调用方降级为纯文本）。
   * 只在 dataDir 可用时启用，路径固定为 <dataDir>/reports/<peer>-<day>.jpg。
   */
  async function maybeRenderCard({ botId, peer, day, payload, template }) {
    const name = String(template || 'journal');
    if (name === 'off' || name === '' || !dataDir || typeof render !== 'function') return null;
    if (!payload) return null;
    const outPath = path.join(dataDir, 'reports', safePeer(peer) + '-' + day + '.jpg');
    let result;
    try {
      result = await render({ payload, template: name, outPath, workspaceRoot, dataDir, logger: log });
    } catch (err) {
      result = { ok: false, reason: 'render-error', error: (err && err.message) || String(err) };
    }
    if (!result || result.ok !== true) {
      const reason = result && result.reason ? result.reason : 'unknown';
      const detail = result && result.error ? '（' + result.error + '）' : '';
      log.warn?.('日报卡片渲染失败（降级文本）: ' + reason + detail);
      return null;
    }
    try { reports.setImage?.({ botId, peer, day, imagePath: result.path }); } catch { /* 图路径写失败不影响投递 */ }
    return result.path || null;
  }

  function peerAllowed(cfg, peer) {
    const list = Array.isArray(cfg.peers) ? cfg.peers.map(normalizePeer).filter(Boolean) : [];
    return list.length === 0 || list.includes(peer);
  }

  async function deliver({ botId, peer, text, imagePath = '' } = {}) {
    const instance = host && typeof host.runtimeOf === 'function' ? host.runtimeOf(botId) : null;
    const transport = instance && instance.transport ? instance.transport : null;
    const sender = transport ? transport.messageSender : null;
    const media = transport ? transport.mediaSender : null;
    if (!sender || typeof sender.sendProactive !== 'function') {
      log.warn?.('日报投递失败：bot 传输层未就绪 (' + botId + ')');
      return { ok: false, error: 'transport-not-ready' };
    }
    const [scope, targetId] = String(peer).split(':');
    if (!scope || !targetId) return { ok: false, error: 'invalid-peer' };
    let lastError = '';
    // 有卡片优先发图；SDK 的 sendImage 需要 { localPath } 而不是裸路径
    if (imagePath && media && typeof media.sendImage === 'function') {
      try {
        const result = await media.sendImage({ scope, targetId }, { localPath: imagePath });
        if (!result || result.ok !== false) return { ok: true };
        lastError = 'image: ' + (result.code || result.error || 'failed');
        log.warn?.('日报卡片发送失败（降级文本）: ' + lastError);
      } catch (err) {
        lastError = 'image: ' + ((err && err.message) || String(err));
        log.warn?.('日报卡片发送异常（降级文本）: ' + lastError);
      }
    }
    if (!text) return { ok: false, error: lastError || 'no-text' };
    try {
      const result = await sender.sendProactive({ scope, targetId }, text);
      if (result && result.ok === true) return { ok: true };
      const textError = (result && (result.code || result.error)) || 'failed';
      log.warn?.('日报主动发送失败: ' + textError);
      return { ok: false, error: [lastError, 'text: ' + textError].filter(Boolean).join('; ') };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      log.warn?.('日报主动发送异常: ' + msg);
      return { ok: false, error: [lastError, 'text: ' + msg].filter(Boolean).join('; ') };
    }
  }

  /**
   * 生成（可选投递）某群某天的日报；命令/控制台共用。
   */
  async function generateNow({ botId, peer, day, force = true, send = false } = {}) {
    const owner = String(botId || '');
    const key = normalizePeer(peer);
    if (!owner || !key) return { ok: false, reason: 'invalid-peer' };
    const settings = settingsFor(owner, key);
    const template = (settings.daily && settings.daily.template) || 'journal';
    const visualConfig = visualConfigFor(template);
    const forcedMood = plannedMood(settings, visualConfig);
    const result = await generateDaily({
      flow, reports, oneShot, botId: owner, peer: key, day, settings, force, logger: log, visualConfig, forcedMood,
    });
    let delivered = false;
    const targetDay = result && result.report ? result.report.day : (day || localDay());
    let imagePath = '';
    if (result && result.ok) {
      const payload = result.payload || (result.report && result.report.payload);
      imagePath = (await maybeRenderCard({ botId: owner, peer: key, day: targetDay, payload, template })) || '';
      if (imagePath) {
        result.imagePath = imagePath;
        if (result.report) result.report.imagePath = imagePath;
      }
    }
    if (result && result.ok && send) {
      const outcome = await deliver({
        botId: owner, peer: key,
        text: result.text || (result.report && result.report.text),
        imagePath,
      });
      delivered = outcome.ok === true;
      if (delivered) {
        reports.markDelivered({ botId: owner, peer: key, day: targetDay, delivered: true });
      } else {
        reports.setError?.({ botId: owner, peer: key, day: targetDay, error: '投递失败: ' + (outcome.error || 'unknown') });
      }
    }
    if (result && result.ok) {
      await runRelations({ botId: owner, peer: key, day: targetDay, settings });
    }
    return { ...result, delivered };
  }

  async function runRelations({ botId, peer, day, settings } = {}) {
    const relation = (settings && settings.relation) || {};
    if (relation.enabled !== true) return { ok: true, skipped: 'disabled', changes: [] };
    try {
      return await updateRelations({
        flow, members, oneShot, config, botId, peer, day, settings, logger: log, now,
      });
    } catch (err) {
      log.warn?.('关系增量失败（忽略）: ' + ((err && err.message) || String(err)));
      return { ok: false, reason: 'error', changes: [] };
    }
  }

  /** 每个 tick 做的事：发现活跃群 → 到点 → 生成 → 投递 → 关系。 */
  async function tick() {
    if (!flow || typeof flow.peers !== 'function' || !reports) return;
    const at = now();
    const today = localDay(new Date(at));
    // 跨午夜补跑：0–6 点之间也检查昨天（23:30 生成、进程刚好没运行的情况）
    const aroundMidnight = at - new Date(today + 'T00:00:00').getTime() <= CATCH_UP_MS;
    const days = aroundMidnight
      ? [localDay(new Date(at - 24 * 60 * 60 * 1000)), today]
      : [today];
    const jobs = [];
    const bots = (() => {
      try { return (config && typeof config.listBots === 'function' ? config.listBots() : []) || []; } catch { return []; }
    })();
    for (const bot of bots) {
      if (!bot || bot.enabled !== true) continue;
      const botId = String(bot.id || '');
      if (botId === '') continue;
      let peers = [];
      try {
        peers = (flow.peers({ botId, since: at - 36 * 60 * 60 * 1000, limit: 200 }) || [])
          .map((item) => item.peer)
          .filter((peer) => String(peer).startsWith('group:'));
      } catch { peers = []; }
      for (const peer of peers) {
        const cfg = settingsFor(botId, peer).daily || {};
        if (cfg.enabled !== true) continue;
        if (!peerAllowed(cfg, peer)) continue;
        for (const day of days) {
          if (!isDue(cfg, at, day)) continue;
          const key = botId + '|' + peer + '|' + day;
          if (attempted.has(key) || running.has(key)) continue;
          let existing = null;
          try { existing = reports.get({ botId, peer, day }); } catch { existing = null; }
          // 今天算“完成”的条件：
          //   - 已投递；或低于阈值跳过；
          //   - delivery=off 时生成即完成（不需要投递）；
          //   - 上次投递被 QQ 明确拒绝（40034105 主动消息无权限），别每轮重启都重跑模型。
          const wantsDelivery = cfg.delivery !== 'off';
          const blocked = !!(existing && /40034105|主动消息无权限/.test(existing.error || ''));
          if (existing && (existing.delivered === true || existing.status === 'skipped'
            || (!wantsDelivery && existing.status === 'done') || blocked)) continue;
          attempted.add(key);
          running.add(key);
          jobs.push(
            Promise.resolve()
              .then(() => runScheduled({ botId, peer, day, cfg }))
              .catch((err) => { log.warn?.('日报任务失败: ' + ((err && err.message) || String(err))); return null; })
              .finally(() => running.delete(key)),
          );
        }
      }
    }
    return Promise.allSettled(jobs);
  }

  /** 某天的触发时间点（毫秒）；day 非法返回 null。 */
  function scheduledAt(day, time) {
    const offset = parseTimeOfDay(time || '23:30');
    if (offset === null) return null;
    const d = new Date(day + 'T00:00:00');
    if (!Number.isFinite(d.getTime())) return null;
    return d.getTime() + offset;
  }

  /** 是否到了某天的触发窗口（catchUp 时放宽到 6 小时）。 */
  function isDue(cfg, at, day) {
    const scheduled = scheduledAt(day, cfg.time);
    if (scheduled === null) return false;
    const windowMs = cfg.catchUp === false ? DEFAULT_WINDOW_MS : CATCH_UP_MS;
    return at >= scheduled && at - scheduled <= windowMs;
  }

  async function runScheduled({ botId, peer, day, cfg }) {
    const settings = settingsFor(botId, peer);
    const template = (settings.daily && settings.daily.template) || 'journal';
    const visualConfig = visualConfigFor(template);
    const forcedMood = plannedMood(settings, visualConfig);
    const result = await generateDaily({
      flow, reports, oneShot, botId, peer, day, settings, force: true, logger: log, visualConfig, forcedMood,
    });
    let imagePath = '';
    if (result && result.ok) {
      const payload = result.payload || (result.report && result.report.payload);
      imagePath = (await maybeRenderCard({ botId, peer, day, payload, template })) || '';
    }
    if (result && result.ok && cfg.delivery !== 'off') {
      const outcome = await deliver({
        botId, peer,
        text: result.text || (result.report && result.report.text),
        imagePath,
      });
      if (outcome.ok === true) {
        reports.markDelivered({ botId, peer, day, delivered: true });
      } else {
        reports.setError?.({ botId, peer, day, error: '投递失败: ' + (outcome.error || 'unknown') });
      }
    }
    if (result && result.ok) await runRelations({ botId, peer, day, settings });
    return result;
  }

  /** 启动定时器；返回 stop()。 */
  function startScheduler({ intervalMs = TICK_MS } = {}) {
    if (timer !== null) return () => {};
    const run = () => { tick().catch((err) => log.warn?.('日报调度 tick 失败: ' + ((err && err.message) || String(err)))); };
    run();
    timer = setInterval(run, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    log.info?.('群日报调度已启动（每 ' + Math.round(intervalMs / 1000) + ' 秒扫描一次）');
    return () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };
  }

  return { generateNow, runRelations, startScheduler, deliver, tick };
}

export default createDailyService;
