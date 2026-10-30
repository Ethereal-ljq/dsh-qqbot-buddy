/**
 * web/routes —— /qqbot-buddy/api/* 管理路由（设置页数据接口）。
 *
 * 契约见 DESIGN.md「HTTP API」：前缀 /qqbot-buddy，全部 JSON 响应
 * {ok:true,...} / {ok:false,error}，并带 cache-control:no-store。
 *
 * 设计要点：
 * - runtime 由 index.js 装配后传入，任何字段都可能缺失（例如未启用 QQ 凭据、
 *   记忆模块尚未加载），每个 handler 都按需容错，绝不抛未捕获异常；
 * - 请求体一律 < 1MB，超限返回 413；非法 JSON 返回 400；
 * - 文件路径类参数在路由层先做一次越界检查，memory/persona 模块内部再兜底；
 * - 路由只挂在本地 webServer（同源、无额外鉴权，与 chatonly-* 一致）。
 */
import path from 'node:path';

const BASE = '/qqbot-buddy/api';
const MAX_BODY_BYTES = 1024 * 1024;
import { VERSION as DEFAULT_VERSION } from '../version.js';
import { DEFAULT_FUNCTION_PROMPTS } from '../prompt-guides.js';
import { schemaPayload } from '../settings-schema.js';
import { DEFAULT_SAFETY_LINE } from '../prompt.js';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

// ── 基础工具 ──────────────────────────────────────────────────
const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function messageOf(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** 构造带 HTTP 状态码的错误；handler 外层 wrapper 会把它转成 {ok:false,error}。 */
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function log(runtime, level, ...args) {
  try {
    const logger = runtime && runtime.logger;
    if (logger && typeof logger[level] === 'function') logger[level](...args);
  } catch {
    /* 日志本身失败不能影响请求处理 */
  }
}

function logWarn(runtime, message) {
  log(runtime, 'warn', message);
}

/** 从 runtime 上取一个数字字段，非法值回退 0。 */
function intOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function strOf(value) {
  return typeof value === 'string' ? value : '';
}

function sendJson(res, status, body) {
  if (!res || typeof res.writeHead !== 'function') return;
  try {
    if (res.writableEnded || res.headersSent) {
      if (typeof res.end === 'function' && !res.writableEnded) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    let payload;
    try {
      payload = JSON.stringify(body);
    } catch (error) {
      payload = JSON.stringify({ ok: false, error: '响应序列化失败：' + messageOf(error) });
    }
    res.writeHead(status, JSON_HEADERS);
    res.end(payload);
  } catch (error) {
    // 响应已断开时静默兜底，避免把异常抛回宿主
    logWarn(null, '写入 HTTP 响应失败：' + messageOf(error));
    try {
      if (typeof res.destroy === 'function') res.destroy();
    } catch {
      /* ignore */
    }
  }
}

function parseUrl(req) {
  try {
    return new URL(strOf(req && req.url) || '/', 'http://127.0.0.1');
  } catch {
    return new URL('/', 'http://127.0.0.1');
  }
}

/** 人类可读的请求体上限（413 文案用；默认 1MB，表情上传按 maxMB*1.4）。 */
function formatByteLimit(limit) {
  const mb = limit / (1024 * 1024);
  if (mb >= 1) return (Number.isInteger(mb) ? String(mb) : mb.toFixed(1)) + 'MB';
  return Math.max(1, Math.round(limit / 1024)) + 'KB';
}

/**
 * 读取并解析 JSON 请求体（默认上限 1MB，可按接口覆盖）。
 * 空 body 视为 {}；超限抛 413；非法 JSON 抛 400。
 */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function') {
      resolve({});
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      // 不要 req.destroy()：否则 handler 还没来得及写出 {ok:false,error} 连接就被重置。
      // 后续 data 事件会被上面的 settled 判断直接丢弃，不会继续累积内存。
      try {
        if (typeof req.resume === 'function') req.resume();
      } catch {
        /* ignore */
      }
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      let buffer;
      try {
        buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      } catch {
        rejectOnce(httpError(400, '请求体编码无效'));
        return;
      }
      size += buffer.length;
      if (size > limit) {
        rejectOnce(httpError(413, '请求体超过 ' + formatByteLimit(limit) + ' 限制'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'));
        return;
      }
      resolve(parsed);
    });
    req.on('error', (error) => {
      rejectOnce(httpError(400, '读取请求体失败：' + messageOf(error)));
    });
  });
}

function requireMethod(req, allowed) {
  const method = String(req && req.method ? req.method : 'GET').toUpperCase();
  if (!allowed.includes(method)) throw httpError(405, '不支持的请求方法：' + method);
  return method;
}

// ── runtime 字段容错读取 ──────────────────────────────────────
function readSettings(runtime) {
  const settings = runtime && runtime.settings;
  if (settings && typeof settings.get === 'function') {
    try {
      const value = settings.get();
      if (isObj(value)) return value;
    } catch (error) {
      logWarn(runtime, '读取设置失败：' + messageOf(error));
    }
  }
  return {};
}

function requireSettings(runtime) {
  const settings = runtime && runtime.settings;
  if (!settings || typeof settings.get !== 'function' || typeof settings.patch !== 'function') {
    throw httpError(503, '设置存储不可用');
  }
  return settings;
}

function readBotState(runtime) {
  try {
    const value = typeof runtime.botState === 'function' ? runtime.botState() : undefined;
    return isObj(value) ? value : {};
  } catch (error) {
    logWarn(runtime, '读取机器人状态失败：' + messageOf(error));
    return {};
  }
}

function readStats(runtime) {
  const source = isObj(runtime && runtime.stats) ? runtime.stats : {};
  return {
    received: intOf(source.received),
    triggered: intOf(source.triggered),
    skipped: intOf(source.skipped),
    replies: intOf(source.replies),
    lastReplyAt: intOf(source.lastReplyAt),
    lastTriggerReason: strOf(source.lastTriggerReason),
  };
}

function readPersonaMeta(runtime, settings, fallbackPath) {
  const persona = runtime && runtime.persona;
  if (persona && typeof persona.read === 'function') {
    try {
      const data = persona.read();
      if (isObj(data)) {
        return {
          path: typeof data.path === 'string' && data.path !== '' ? data.path : fallbackPath,
          exists: data.exists === true,
          bytes: intOf(data.bytes),
          lines: intOf(data.lines),
          mtime: intOf(data.mtime),
        };
      }
    } catch (error) {
      logWarn(runtime, '读取人设元信息失败：' + messageOf(error));
    }
  }
  return { path: fallbackPath, exists: false, bytes: 0, lines: 0, mtime: 0 };
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  const out = [];
  for (const item of files) {
    if (!isObj(item) || typeof item.name !== 'string' || item.name === '') continue;
    out.push({ name: item.name, size: intOf(item.size), mtime: intOf(item.mtime) });
  }
  return out;
}

/** 解析 MEMORY.md 的 `- [YYYY-MM-DD] 文本（#tag #tag）` 行。 */
function parseMemoryFacts(text) {
  const input = typeof text === 'string' ? text : '';
  const facts = [];
  for (const line of input.split('\n')) {
    const match = /^- \[(\d{4}-\d{2}-\d{2})\] (.*)$/.exec(line.trim());
    if (!match) continue;
    let body = match[2].trim();
    const tags = [];
    if (body.endsWith('）')) {
      const open = body.lastIndexOf('（');
      if (open > 0) {
        const inside = body.slice(open + 1, -1).trim();
        if (inside.startsWith('#')) {
          for (const tag of inside.split(/\s+/)) {
            const clean = tag.replace(/^#+/, '').trim();
            if (clean !== '') tags.push(clean);
          }
          body = body.slice(0, open).trim();
        }
      }
    }
    if (body !== '') facts.push({ date: match[1], text: body, tags });
  }
  return facts;
}

/** 读取 MEMORY.md 原文（文件不存在返回空串）。 */
function readMemoryText(memory) {
  try {
    if (typeof memory.readFile !== 'function') return '';
    const result = memory.readFile('MEMORY.md');
    return isObj(result) && typeof result.text === 'string' ? result.text : '';
  } catch {
    return '';
  }
}

function normalizeBackups(backups) {
  if (!Array.isArray(backups)) return [];
  const out = [];
  for (const item of backups) {
    if (!isObj(item) || typeof item.name !== 'string' || item.name === '') continue;
    out.push({ name: item.name, size: intOf(item.size), mtime: intOf(item.mtime) });
  }
  return out;
}

function readMemoryLayout(runtime, settings, fallbackDir) {
  const memory = runtime && runtime.memory;
  if (memory && typeof memory.layout === 'function') {
    try {
      const data = memory.layout();
      if (isObj(data)) {
        return {
          dir: typeof data.dir === 'string' && data.dir !== '' ? data.dir : fallbackDir,
          exists: data.exists === true,
          files: normalizeFiles(data.files),
          totalChars: intOf(data.totalChars),
        };
      }
    } catch (error) {
      logWarn(runtime, '读取记忆目录失败：' + messageOf(error));
    }
  }
  return { dir: fallbackDir, exists: false, files: [], totalChars: 0 };
}

function requireMemory(runtime) {
  const memory = runtime && runtime.memory;
  if (!memory || typeof memory.layout !== 'function') throw httpError(503, '记忆模块不可用');
  return memory;
}

function requirePersona(runtime) {
  const persona = runtime && runtime.persona;
  if (!persona || typeof persona.read !== 'function') throw httpError(503, '人设存储不可用');
  return persona;
}

function requirePersonaCards(runtime) {
  const store = runtime && runtime.personaCards;
  if (!store || typeof store.list !== 'function') throw httpError(503, '人格卡存储不可用');
  return store;
}

function resolveVersion(runtime) {
  try {
    if (runtime && typeof runtime.getVersion === 'function') {
      const value = runtime.getVersion();
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
  } catch {
    /* ignore */
  }
  const direct = runtime && typeof runtime.version === 'string' ? runtime.version.trim() : '';
  return direct !== '' ? direct : DEFAULT_VERSION;
}

function resolveCwd(runtime) {
  const cwd = runtime && typeof runtime.cwd === 'string' ? runtime.cwd.trim() : '';
  return cwd !== '' ? cwd : process.cwd();
}

function resolvePaths(runtime, settings) {
  const cwd = resolveCwd(runtime);
  const personaSettings = isObj(settings.persona) ? settings.persona : {};
  const memorySettings = isObj(settings.memory) ? settings.memory : {};
  const personaPath =
    typeof personaSettings.path === 'string' && personaSettings.path !== ''
      ? personaSettings.path
      : path.join(cwd, 'persona.md');
  const memoryDir =
    typeof memorySettings.dir === 'string' && memorySettings.dir !== ''
      ? memorySettings.dir
      : path.join(cwd, 'memory');
  const stickers = runtime && typeof runtime.stickersDir === 'string' && runtime.stickersDir !== ''
    ? runtime.stickersDir
    : path.join(cwd, 'stickers');
  return {
    cwd,
    persona: personaPath,
    memory: memoryDir,
    stickers,
    stateDir: strOf(runtime && runtime.stateDir),
    mediaDir: strOf(runtime && runtime.mediaDir),
  };
}

/** appId 脱敏：保留前 4 位与后 3 位（如 1904***298）。 */
function maskAppId(appId) {
  const value = typeof appId === 'string' ? appId.trim() : '';
  if (value === '') return '';
  if (value.length <= 4) return '***';
  if (value.length <= 8) return value.slice(0, 1) + '***' + value.slice(-1);
  return value.slice(0, 4) + '***' + value.slice(-3);
}

/** 待回复队列项只投影基础标量字段，避免把内部对象/循环引用塞进 JSON。 */
function projectPending(item) {
  if (!isObj(item)) return typeof item === 'string' || typeof item === 'number' ? String(item) : null;
  const out = {};
  for (const key of [
    'peerKey',
    'peerId',
    'peer',
    'scope',
    'reason',
    'senderId',
    'count',
    'since',
    'oldestAt',
    'waitingMs',
    'lastSkipAt',
    'lastAt',
  ]) {
    const value = item[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  if (out.count === undefined && Array.isArray(item.pending)) out.count = item.pending.length;
  return Object.keys(out).length > 0 ? out : null;
}

function normalizePendingList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const item2 = projectPending(item);
    if (item2 !== null) out.push(item2);
  }
  return out;
}

/**
 * 从 gateState 推导待回复队列快照。
 * gateState 是 qq/gate.js 的 createGateState() 实例（peers: Map<peerKey, { pending: [{at}], lastSkipAt }>）。
 * 若运行时额外挂了 pendingSnapshot() 则优先使用；结构不认识时返回空数组（UI 只是展示用途）。
 */
function pendingFromGateState(gateState) {
  if (!gateState) return [];
  try {
    if (typeof gateState.pendingSnapshot === 'function') {
      return normalizePendingList(gateState.pendingSnapshot());
    }
    const peers = gateState.peers;
    if (!(peers instanceof Map)) return [];
    const now = Date.now();
    const out = [];
    for (const [peerKey, value] of peers) {
      if (!isObj(value)) continue;
      const entries = Array.isArray(value.pending) ? value.pending : Array.isArray(value.queue) ? value.queue : [];
      if (entries.length === 0) continue;
      const first = entries[0];
      // 兼容几种历史形态：{at}、数字时间戳，或 peer 上单独记 firstPendingAt/since
      let oldestAt = now;
      if (isObj(first) && typeof first.at === 'number') oldestAt = first.at;
      else if (typeof first === 'number') oldestAt = first;
      else if (typeof value.firstPendingAt === 'number') oldestAt = value.firstPendingAt;
      else if (typeof value.since === 'number') oldestAt = value.since;
      const separator = peerKey.indexOf(':');
      const item = {
        peerKey: String(peerKey),
        scope: separator >= 0 ? peerKey.slice(0, separator) : '',
        peerId: separator >= 0 ? peerKey.slice(separator + 1) : String(peerKey),
        count: entries.length,
        oldestAt,
        waitingMs: Math.max(0, now - oldestAt),
      };
      if (typeof value.lastSkipAt === 'number') item.lastSkipAt = value.lastSkipAt;
      out.push(item);
    }
    // 等得最久的排前面，UI 一眼看到该 flush 的群
    out.sort((a, b) => b.waitingMs - a.waitingMs);
    return out;
  } catch (error) {
    return [];
  }
}

/** 把当前设置翻译成一句人话，供设置页「当前生效策略」展示。 */
function buildEffectiveSummary(settings) {
  const reply = isObj(settings.reply) ? settings.reply : {};
  const triggers = isObj(settings.triggers) ? settings.triggers : {};
  if (reply.enabled === false) return '自动回复已关闭（仅响应 /命令）';

  const parts = [];
  if (reply.groupEnabled === false) {
    parts.push('群聊自动回复已关闭');
  } else {
    const mode = typeof reply.groupMode === 'string' ? reply.groupMode : 'count';
    if (mode === 'all') {
      parts.push('每条群消息都会回复');
    } else if (mode === 'interval') {
      parts.push('距上次回复至少 ' + intOf(reply.intervalSeconds) + ' 秒才再次回复');
    } else if (mode === 'probability') {
      const probability = typeof reply.probability === 'number' ? reply.probability : 0;
      parts.push('每条群消息以 ' + Math.round(probability * 100) + '% 概率回复');
    } else if (mode === 'adaptive') {
      const adaptive = isObj(reply.adaptive) ? reply.adaptive : {};
      const debounce = typeof adaptive.debounceSeconds === 'number' ? intOf(adaptive.debounceSeconds) : 4;
      const cooldown = typeof adaptive.cooldownSeconds === 'number' ? intOf(adaptive.cooldownSeconds) : 12;
      const maxWait = typeof adaptive.maxWaitSeconds === 'number' ? intOf(adaptive.maxWaitSeconds) : 20;
      const requireRelevance = adaptive.requireRelevance !== false;
      parts.push(
        '自适应：静默 ' +
          debounce +
          ' 秒后回一次；回复后冷却 ' +
          cooldown +
          ' 秒；最长等待 ' +
          maxWait +
          ' 秒' +
          (requireRelevance ? '；只回问句/图片等需要回应的消息' : '；批次里有新信息就回'),
      );
    } else {
      const threshold = intOf(reply.countThreshold);
      const flush = intOf(reply.flushAfterSeconds);
      parts.push(
        '每累计 ' + threshold + ' 条群消息回复一次' + (flush > 0 ? '（最早一条等待超过 ' + flush + ' 秒也会回复）' : ''),
      );
    }
  }

  const forced = [];
  if (triggers.onMention !== false) forced.push('@');
  if (triggers.onReplyToBot !== false) forced.push('回复');
  const keywordCount = Array.isArray(triggers.keywords) ? triggers.keywords.length : 0;
  if (keywordCount > 0) forced.push('关键词');
  if (forced.length > 0) parts.push(forced.join('/') + '必回');

  if (reply.c2cEnabled === false) parts.push('私聊回复已关闭');
  if (intOf(reply.minGapSeconds) > 0) parts.push('全局最小间隔 ' + intOf(reply.minGapSeconds) + ' 秒');
  return parts.join('；');
}

// ── 模型路由信息（added 2026-10-25：settings.model > config > 宿主默认） ──
const EMPTY_MODEL = { provider: '', model: '', reasoningEffort: '' };

/** 归一化 provider/model/reasoningEffort 三元组（兼容字符串与缺失字段）。 */
function normalizeModel(value) {
  const src = isObj(value) ? value : {};
  return {
    provider: strOf(src.provider).trim(),
    model: strOf(src.model).trim(),
    reasoningEffort: strOf(src.reasoningEffort).trim(),
  };
}

/** 安全拿 ctx 上的可选服务（ctx / ctx.get 可能缺失或抛错）。 */
function getService(runtime, name) {
  try {
    const ctx = runtime && runtime.ctx;
    if (!ctx || typeof ctx.get !== 'function') return undefined;
    return ctx.get(name);
  } catch (error) {
    logWarn(runtime, '读取服务 ' + name + ' 失败：' + messageOf(error));
    return undefined;
  }
}

/** 读取宿主默认模型选择；服务不可用 / 抛错 / 空选择时返回 null。 */
function readHostSelection(runtime) {
  const service = getService(runtime, 'agentDefaultModel');
  if (!service || typeof service.currentSelection !== 'function') return null;
  try {
    const selection = service.currentSelection();
    if (!isObj(selection)) return null;
    const normalized = normalizeModel(selection);
    if (normalized.provider === '' && normalized.model === '' && normalized.reasoningEffort === '') return null;
    return normalized;
  } catch (error) {
    logWarn(runtime, '读取宿主默认模型失败：' + messageOf(error));
    return null;
  }
}

/** 读取 index.js 装配的 runtime.getModelInfoSync()（若存在且形状合法）。 */
function readRuntimeModelInfo(runtime) {
  if (!runtime || typeof runtime.getModelInfoSync !== 'function') return null;
  try {
    const info = runtime.getModelInfoSync();
    if (!isObj(info)) return null;
    const source = info.source === 'settings' || info.source === 'config' || info.source === 'host' ? info.source : 'host';
    return {
      selected: normalizeModel(info.selected),
      effective: isObj(info.effective) ? normalizeModel(info.effective) : { provider: '', model: '', reasoningEffort: '' },
      source,
    };
  } catch (error) {
    logWarn(runtime, '读取运行期模型信息失败：' + messageOf(error));
    return null;
  }
}

/**
 * 计算当前模型路由，优先级与 qq/session-manager.js 的 agentOptions 保持一致：
 *   1. settings.model（provider+model 均非空）
 *   2. runtime.config.provider + config.model
 *   3. 宿主 agentDefaultModel.currentSelection()
 * 返回 state.model / /api/models 所需结构。
 */
function computeModelInfo(runtime) {
  const fromManager = readRuntimeModelInfo(runtime);
  if (fromManager) return fromManager;
  const settings = readSettings(runtime);
  const selected = normalizeModel(settings.model);
  const config = runtime && isObj(runtime.config) ? runtime.config : {};
  const configModel = normalizeModel({
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  });
  const host = readHostSelection(runtime);
  let effective = EMPTY_MODEL;
  let source = 'host';
  if (selected.provider !== '' && selected.model !== '') {
    effective = selected;
    source = 'settings';
  } else if (configModel.provider !== '' && configModel.model !== '') {
    effective = configModel;
    source = 'config';
  } else if (host && host.provider !== '' && host.model !== '') {
    effective = host;
  }
  return {
    selected,
    effective: {
      provider: effective.provider,
      model: effective.model,
      reasoningEffort: effective.reasoningEffort,
    },
    source,
  };
}

// ── Agent 预设与功能开关（added 2026-10-25 深夜） ─────────────
const FEATURE_KEYS = ['workspace', 'web', 'stickers', 'vision', 'memory'];

/** 计算 preset 选择/生效值；优先 runtime.presetInfo()，规则与 session-manager.buildSetup 一致。 */
function readAgentInfo(runtime) {
  if (runtime && typeof runtime.presetInfo === 'function') {
    try {
      const info = runtime.presetInfo();
      if (isObj(info)) {
        const configPreset = isObj(runtime.config) ? strOf(runtime.config.preset).trim() : '';
        const defaultPreset = strOf(info.defaultPreset).trim() || (configPreset !== '' ? configPreset : 'qqbot-buddy');
        const selectedPreset = strOf(info.selected).trim();
        const effectivePreset = strOf(info.effective).trim() || selectedPreset || defaultPreset;
        return {
          selectedPreset,
          effectivePreset,
          defaultPreset,
          builtIn: info.builtIn === true || effectivePreset === 'qqbot-buddy',
        };
      }
    } catch (error) {
      logWarn(runtime, '读取运行期 preset 信息失败：' + messageOf(error));
    }
  }
  const settings = readSettings(runtime);
  const agentSettings = isObj(settings.agent) ? settings.agent : {};
  const selectedPreset = strOf(agentSettings.preset).trim();
  const config = runtime && isObj(runtime.config) ? runtime.config : {};
  const configPreset = strOf(config.preset).trim();
  const defaultPreset = configPreset !== '' ? configPreset : 'qqbot-buddy';
  const effectivePreset = selectedPreset !== '' ? selectedPreset : defaultPreset;
  return {
    selectedPreset,
    effectivePreset,
    defaultPreset,
    builtIn: effectivePreset === 'qqbot-buddy',
  };
}

/** 功能开关快照（缺省视为开启，与 settings-store 默认值一致）。 */
function readFeatures(settings) {
  const raw = isObj(settings.features) ? settings.features : {};
  const out = {};
  for (const key of FEATURE_KEYS) out[key] = raw[key] !== false;
  return out;
}

/** 归一化 preset 列表：只保留 id 合法的项；broken 归一为布尔。 */
function normalizePresets(rows) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isObj(row)) continue;
    const id = strOf(row.id).trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const name = strOf(row.name).trim();
    out.push({
      id,
      name: name !== '' ? name : id,
      description: strOf(row.description).trim(),
      broken: row.broken === true || (typeof row.broken === 'string' && row.broken.trim() !== ''),
    });
  }
  return out;
}

function buildState(runtime) {
  const now = Date.now();
  const settings = readSettings(runtime);
  const agentInfo = readAgentInfo(runtime);
  const features = readFeatures(settings);
  const botState = readBotState(runtime);
  const paths = resolvePaths(runtime, settings);
  const personaMeta = readPersonaMeta(runtime, settings, paths.persona);
  const memoryLayout = readMemoryLayout(runtime, settings, paths.memory);
  const startedAt = intOf(botState.startedAt);
  const appId = typeof botState.appId === 'string' ? botState.appId : '';
  let botMeta = null;
  try {
    if (runtime && typeof runtime.snapshot === 'function') botMeta = runtime.snapshot();
  } catch {
    botMeta = null;
  }
  let pathDetail = null;
  try {
    if (runtime && typeof runtime.pathSnapshot === 'function') pathDetail = runtime.pathSnapshot();
  } catch {
    pathDetail = null;
  }
  return {
    ok: true,
    version: resolveVersion(runtime),
    now,
    model: computeModelInfo(runtime),
    agent: {
      selectedPreset: agentInfo.selectedPreset,
      effectivePreset: agentInfo.effectivePreset,
      builtIn: agentInfo.builtIn,
    },
    features,
    bot: {
      appId: maskAppId(appId),
      ready: botState.ready === true,
      startedAt,
      uptimeMs: startedAt > 0 && now > startedAt ? now - startedAt : 0,
      lastError: strOf(botState.lastError),
      sessionCount: intOf(botState.sessionCount),
      pending: normalizePendingList(botState.pending),
      // v0.16 多机器人：当前请求选中的机器人身份 / 工作区
      id: botMeta ? strOf(botMeta.id) : '',
      name: botMeta ? strOf(botMeta.name) : '',
      legacy: botMeta ? botMeta.legacy === true : false,
      bound: botMeta ? botMeta.bound === true : false,
      enabled: botMeta ? botMeta.enabled !== false : true,
      workspaceDir: botMeta ? strOf(botMeta.workspaceDir) : '',
      dirs: botMeta && isObj(botMeta.dirs) ? botMeta.dirs : null,
      pathDetail: pathDetail,
    },
    stats: readStats(runtime),
    settings,
    // 功能提示词的内置默认：UI 用来在文本框里直接显示默认文案（而不是留空）
    promptDefaults: DEFAULT_FUNCTION_PROMPTS,
    paths: {
      cwd: paths.cwd,
      persona: personaMeta.path || paths.persona,
      memory: memoryLayout.dir || paths.memory,
      stickers: paths.stickers,
      stateDir: paths.stateDir,
      mediaDir: paths.mediaDir,
    },
    persona: personaMeta,
    memory: {
      dir: memoryLayout.dir,
      exists: memoryLayout.exists,
      files: memoryLayout.files,
      totalChars: memoryLayout.totalChars,
    },
    effective: {
      summary: buildEffectiveSummary(settings),
      pending: pendingFromGateState(runtime && runtime.gateState),
    },
  };
}

// ── 路径越界预检（memory/persona 内部还会再兜底一次） ─────────
function normalizeMemoryRel(input) {
  if (typeof input !== 'string') return undefined;
  const raw = input.trim();
  if (raw === '' || raw.includes('\0')) return undefined;
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/')) return undefined;
  const parts = unified.split('/').filter((part) => part !== '');
  if (parts.length === 0) return undefined;
  if (parts.some((part) => part === '.' || part === '..')) return undefined;
  return parts.join('/');
}

/** memory 模块抛出的校验类错误按 400 返回，其余按 500。 */
function memoryErrorStatus(message) {
  return /(越界|不合法|非法|不允许|不存在|仅支持|超过|过大|不能为空|必须是)/.test(String(message)) ? 400 : 500;
}

// ── handler：GET /state ───────────────────────────────────────
async function handleGetState(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  sendJson(res, 200, buildState(runtime));
}

// ── handler：GET/POST /persona ───────────────────────────────
async function handleGetPersona(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const persona = requirePersona(runtime);
  const data = persona.read();
  if (!isObj(data)) throw httpError(500, '读取人设失败');
  let backups = [];
  if (typeof persona.backups === 'function') {
    try {
      backups = normalizeBackups(persona.backups());
    } catch (error) {
      logWarn(runtime, '读取人设备份列表失败：' + messageOf(error));
    }
  }
  sendJson(res, 200, {
    ok: true,
    path: strOf(data.path),
    text: strOf(data.text),
    bytes: intOf(data.bytes),
    lines: intOf(data.lines),
    mtime: intOf(data.mtime),
    exists: data.exists === true,
    backups,
  });
}

async function handleSavePersona(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const body = await readJsonBody(req);
  if (typeof body.text !== 'string') throw httpError(400, '请求缺少人设文本 text');
  const persona = requirePersona(runtime);
  if (typeof persona.write !== 'function') throw httpError(503, '人设存储不可写');
  const result = await persona.write(body.text);
  if (!isObj(result) || result.ok === false) {
    throw httpError(400, isObj(result) && typeof result.error === 'string' ? result.error : '保存人设失败');
  }
  sendJson(res, 200, { ok: true, backup: typeof result.backup === 'string' ? result.backup : null });
}

async function handleRestorePersona(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const body = await readJsonBody(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') throw httpError(400, '请求缺少备份名 name');
  const persona = requirePersona(runtime);
  if (typeof persona.restore !== 'function') throw httpError(503, '人设备份恢复不可用');
  const result = await persona.restore(name);
  if (!isObj(result) || result.ok === false) {
    const message = isObj(result) && typeof result.error === 'string' ? result.error : '恢复备份失败';
    throw httpError(/不存在/.test(message) ? 404 : 400, message);
  }
  sendJson(res, 200, { ok: true });
}

// ── handler：人格卡 ─────────────────────────────────────────
function cardHttpError(result, fallback) {
  const message = isObj(result) && typeof result.error === 'string' && result.error !== '' ? result.error : fallback;
  return httpError(/不存在|未知/.test(message) ? 404 : 400, message);
}

async function handleGetPersonaCards(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const store = requirePersonaCards(runtime);
  let data;
  try {
    data = await store.list();
  } catch (error) {
    throw httpError(500, '读取人格卡失败：' + messageOf(error));
  }
  if (!isObj(data)) throw httpError(500, '读取人格卡失败');
  sendJson(res, 200, { ok: true, ...data });
}

async function handleGetPersonaCardContent(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const store = requirePersonaCards(runtime);
  if (typeof store.read !== 'function') throw httpError(503, '人格卡读取不可用');
  const id = strOf(url.searchParams.get('id')).trim();
  if (id === '') throw httpError(400, '请求缺少卡片 id');
  let result;
  try {
    result = await store.read(id);
  } catch (error) {
    throw httpError(400, '读取人格卡内容失败：' + messageOf(error));
  }
  if (isObj(result) && result.ok === false) throw cardHttpError(result, '读取人格卡内容失败');
  sendJson(res, 200, { ok: true, ...(isObj(result) ? result : {}) });
}

async function handleCreatePersonaCard(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const store = requirePersonaCards(runtime);
  if (typeof store.create !== 'function') throw httpError(503, '人格卡创建不可用');
  const body = await readJsonBody(req);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') throw httpError(400, '请求缺少卡片名称 name');
  let result;
  try {
    result = await store.create({
      name,
      description: typeof body.description === 'string' ? body.description : '',
      content: typeof body.content === 'string' ? body.content : undefined,
    });
  } catch (error) {
    throw httpError(400, '创建人格卡失败：' + messageOf(error));
  }
  if (isObj(result) && result.ok === false) throw cardHttpError(result, '创建人格卡失败');
  sendJson(res, 200, { ok: true, ...(isObj(result) ? result : {}) });
}

async function handleUpdatePersonaCard(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const store = requirePersonaCards(runtime);
  if (typeof store.update !== 'function') throw httpError(503, '人格卡更新不可用');
  const body = await readJsonBody(req);
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id === '') throw httpError(400, '请求缺少卡片 id');
  let result;
  try {
    result = await store.update(id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      content: typeof body.content === 'string' ? body.content : undefined,
    });
  } catch (error) {
    throw httpError(400, '更新人格卡失败：' + messageOf(error));
  }
  if (isObj(result) && result.ok === false) throw cardHttpError(result, '更新人格卡失败');
  sendJson(res, 200, { ok: true, ...(isObj(result) ? result : {}) });
}

async function handleActivatePersonaCard(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const store = requirePersonaCards(runtime);
  if (typeof store.activate !== 'function') throw httpError(503, '人格卡切换不可用');
  const body = await readJsonBody(req);
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id === '') throw httpError(400, '请求缺少卡片 id');
  let result;
  try {
    result = await store.activate(id);
  } catch (error) {
    throw httpError(400, '切换人格卡失败：' + messageOf(error));
  }
  if (isObj(result) && result.ok === false) throw cardHttpError(result, '切换人格卡失败');
  sendJson(res, 200, { ok: true, ...(isObj(result) ? result : {}) });
}

async function handleDeletePersonaCard(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const store = requirePersonaCards(runtime);
  if (typeof store.delete !== 'function') throw httpError(503, '人格卡删除不可用');
  const body = await readJsonBody(req);
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (id === '') throw httpError(400, '请求缺少卡片 id');
  let result;
  try {
    result = await store.delete(id);
  } catch (error) {
    throw httpError(400, '删除人格卡失败：' + messageOf(error));
  }
  if (isObj(result) && result.ok === false) throw cardHttpError(result, '删除人格卡失败');
  sendJson(res, 200, { ok: true, ...(isObj(result) ? result : {}) });
}

// ── handler：GET /commands ───────────────────────────────────
async function handleGetCommands(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  let commands = [];
  try {
    const mod = await import('../qq/commands.js');
    commands = Array.isArray(mod.COMMAND_CATALOG) ? mod.COMMAND_CATALOG : [];
  } catch (error) {
    logWarn(runtime, '读取命令目录失败：' + messageOf(error));
  }
  const settings = readSettings(runtime);
  const admin = isObj(settings.admin) ? settings.admin : { enabled: false, openids: [], names: [] };
  sendJson(res, 200, {
    ok: true,
    commands: commands.map((item) => ({
      name: strOf(item.name),
      aliases: Array.isArray(item.aliases) ? item.aliases.map(strOf) : [],
      usage: strOf(item.usage),
      description: strOf(item.description),
      adminOnly: item.adminOnly === true,
    })),
    admin,
  });
}

// ── handler：POST /settings ──────────────────────────────────
async function handlePostSettings(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const body = await readJsonBody(req);
  const patch = isObj(body.patch) ? body.patch : isObj(body.settings) ? body.settings : undefined;
  if (!isObj(patch)) throw httpError(400, '请求缺少 patch 对象');
  const settings = requireSettings(runtime);
  // 集合型配置必须整体替换（深合并删不掉键，会让「删除自定义能力」失效）。
  // 请求可显式声明 replacePaths；未声明时对这些已知集合字段默认整体替换。
  const DEFAULT_REPLACE_PATHS = [
    'tools.capabilityEntries',
    'tools.removedCapabilities',
    'prompts.sections',
  ];
  const requested = Array.isArray(body.replacePaths)
    ? body.replacePaths.filter((item) => typeof item === 'string')
    : [];
  const replacePaths = requested.length > 0 ? requested : DEFAULT_REPLACE_PATHS;
  const result = typeof settings.patchReplace === 'function'
    ? await settings.patchReplace(patch, replacePaths)
    : await settings.patch(patch);
  let nextSettings;
  try {
    nextSettings = isObj(result) && isObj(result.settings) ? result.settings : settings.get();
  } catch {
    nextSettings = readSettings(runtime);
  }
  sendJson(res, 200, {
    ok: true,
    settings: nextSettings,
    changed: isObj(result) && Array.isArray(result.changed) ? result.changed : [],
  });
}

// ── handler：GET /presets（Agent preset 选择 UI 的数据源） ───
/** 读取 settings.tools.extraAllowed（只取字符串、去空）。 */
function readExtraAllowed(runtime) {
  try {
    if (!runtime || !runtime.settings || typeof runtime.settings.get !== 'function') return [];
    const snap = runtime.settings.get();
    const list = snap && snap.tools && Array.isArray(snap.tools.extraAllowed) ? snap.tools.extraAllowed : [];
    return list.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  } catch {
    return [];
  }
}

/**
 * GET /tools —— 能力边界诊断：当前放行哪些工具、挂了哪些插件、技能策略与可见技能。
 * 数据全部来自 runtime.toolCatalog（唯一真相），设置页与排障共用。
 */
async function handleGetTools(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const catalog = runtime && runtime.toolCatalog;
  if (!catalog || typeof catalog.diagnose !== 'function') {
    sendJson(res, 200, { ok: false, error: '能力目录不可用（插件未完全装配）' });
    return;
  }
  try {
    const payload = Object.assign({ ok: true }, catalog.diagnose());
    // 默认空数组：即使还没有真实装配（没收到过 QQ 消息），字段也要稳定存在
    payload.unclaimed = [];
    payload.discovered = [];
    payload.candidates = [];
    // 审计信息：本次装配里「存在但被屏蔽」的工具，供设置页一键放行。
    // 新插件装好后，它的工具会出现在 unclaimed 里，不需要改代码。
    const manager = runtime && runtime.manager;
    const audit = manager && manager.toolAudit ? manager.toolAudit : null;
    if (audit) {
      const allowSet = new Set(Array.isArray(payload.allow) ? payload.allow : []);
      // 把「额外放行」已覆盖的排除掉，避免界面一直提示已经允许过的工具
      const extra = new Set(readExtraAllowed(runtime));
      payload.audit = {
        at: audit.at,
        candidateCount: Array.isArray(audit.candidates) ? audit.candidates.length : 0,
        dropped: Array.isArray(audit.dropped) ? audit.dropped : [],
      };
      payload.unclaimed = Array.isArray(audit.candidates)
        ? audit.candidates.filter((name) => !allowSet.has(name) && !extra.has(name))
        : [];
      // 「扫描发现」：本次装配里真实存在、但还没归属任何能力的工具。
      // 设置页据此让用户勾选并新建能力，不需要改代码。
      payload.discovered = Array.isArray(audit.candidates)
        ? audit.candidates.filter((name) => !allowSet.has(name) && !extra.has(name))
        : [];
      payload.candidates = Array.isArray(audit.candidates) ? audit.candidates : [];
    }
    // 还没装配过（无审计）：退化为枚举 tools 注册表的全局层工具，
    // 这样设置页的「扫描发现」在第一次收到消息之前也能用。
    if (!audit) {
      const names = listGlobalToolNames(runtime);
      const allowSet = new Set(Array.isArray(payload.allow) ? payload.allow : []);
      const extra = new Set(readExtraAllowed(runtime));
      payload.candidates = names.slice();
      payload.discovered = names.filter((name) => !allowSet.has(name) && !extra.has(name));
      payload.unclaimed = payload.discovered.slice();
      payload.audit = { at: 0, candidateCount: names.length, dropped: payload.discovered.slice(), source: 'registry' };
    }
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: messageOf(err) });
  }
}

/** 枚举 tools 注册表的全局工具名（无 agent scope 时的发现来源）。 */
function listGlobalToolNames(runtime) {
  try {
    const ctx = runtime && runtime.ctx;
    if (!ctx || typeof ctx.get !== 'function') return [];
    const tools = ctx.get('tools');
    if (!tools || typeof tools.view !== 'function') return [];
    const view = tools.view(undefined);
    const set = view && view.knownNames instanceof Set ? view.knownNames : new Set();
    return [...set].filter((name) => typeof name === 'string').sort();
  } catch {
    return [];
  }
}

async function handleGetPresets(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const info = readAgentInfo(runtime);
  let rows = [];
  let note = '';
  let served = false;

  // 1) 优先用 index.js 注入的 runtime.listPresets()（server-dev 提供，内部已做错误隔离）
  if (runtime && typeof runtime.listPresets === 'function') {
    try {
      const result = await runtime.listPresets();
      if (Array.isArray(result)) rows = result;
      else if (isObj(result) && Array.isArray(result.presets)) rows = result.presets;
      served = true;
    } catch (error) {
      note = '读取 agent preset 列表失败：' + messageOf(error);
      logWarn(runtime, note);
    }
  }

  // 2) 退化到宿主 agentPresets 服务（list() 返回 Promise<Array>）
  if (!served) {
    const service = getService(runtime, 'agentPresets');
    if (!service || typeof service.list !== 'function') {
      if (note === '') note = '宿主 agent preset 服务不可用，无法枚举预设；可手动填写 preset id';
    } else {
      try {
        const result = await service.list();
        rows = Array.isArray(result) ? result : [];
        served = true;
        note = '';
      } catch (error) {
        note = '读取 agent preset 列表失败：' + messageOf(error);
        logWarn(runtime, note);
      }
    }
  }

  // 列表为空且没有明确错误时也给一条提示：UI 据此降级为手动输入 preset id
  if (rows.length === 0 && note === '') {
    note = '宿主未提供可枚举的 agent preset 列表（服务不可用或未注册预设）；可手动填写 preset id';
  }

  sendJson(res, 200, {
    ok: true,
    presets: normalizePresets(rows),
    selected: info.selectedPreset,
    effective: info.effectivePreset,
    defaultPreset: info.defaultPreset,
    ...(note === '' ? {} : { note }),
  });
}

// ── handler：GET /models（模型切换 UI 的数据源） ─────────────
async function handleGetModels(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const info = computeModelInfo(runtime);
  // DESIGN 契约：default 始终是 {provider,model,reasoningEffort}；宿主无默认选择时用空三元组兜底（不返回 null）
  const host = readHostSelection(runtime) || { provider: '', model: '', reasoningEffort: '' };
  const llm = getService(runtime, 'llm');
  const providers = [];
  let note = '';
  if (!llm || typeof llm.listProviders !== 'function') {
    note = 'LLM 服务不可用，无法枚举模型；可手动填写 provider / model';
  } else {
    let declared = [];
    try {
      declared = await llm.listProviders();
    } catch (error) {
      note = '枚举 provider 失败：' + messageOf(error);
      logWarn(runtime, note);
      declared = [];
    }
    for (const entry of Array.isArray(declared) ? declared : []) {
      const id = typeof entry === 'string' ? entry.trim() : isObj(entry) ? strOf(entry.id).trim() : '';
      if (id === '') continue;
      const name = isObj(entry) && strOf(entry.name).trim() !== '' ? strOf(entry.name).trim() : id;
      const models = [];
      if (typeof llm.listModels === 'function') {
        try {
          const raw = await llm.listModels(id);
          for (const item of Array.isArray(raw) ? raw : []) {
            if (typeof item === 'string' && item.trim() !== '') {
              models.push({ id: item.trim(), name: item.trim() });
              continue;
            }
            if (!isObj(item) || strOf(item.id).trim() === '') continue;
            const modelId = strOf(item.id).trim();
            const modelName = strOf(item.name).trim() !== '' ? strOf(item.name).trim() : modelId;
            models.push({ id: modelId, name: modelName });
          }
        } catch (error) {
          // 单个 provider 失败只跳过它，不影响其它 provider（DESIGN 要求）
          logWarn(runtime, '枚举 provider ' + id + ' 的模型失败：' + messageOf(error));
        }
      }
      providers.push({ id, models });
    }
  }
  sendJson(res, 200, {
    ok: true,
    providers,
    default: host,
    selected: info.selected,
    source: info.source,
    ...(note === '' ? {} : { note }),
  });
}

// ── handler：GET /prompt ────────────────────────────────────
async function handleGetPrompt(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const scopeParam = url.searchParams.get('scope');
  const scope = scopeParam === 'direct' ? 'direct' : 'group';
  const composer = runtime && runtime.promptComposer;
  if (!composer || typeof composer.compose !== 'function') throw httpError(503, 'prompt 组合器不可用');
  let text;
  try {
    text = await composer.compose({ scope });
  } catch (error) {
    throw httpError(500, '组合 prompt 失败：' + messageOf(error));
  }
  // 附带分段结构：设置页展示「每段独立存储 + 实际组装顺序」。
  // 顺序按重要性排布（重要在首尾），便于排查"某段是否被埋没在中间"。
  const payload = { ok: true, text: typeof text === 'string' ? text : String(text ?? '') };
  try {
    if (typeof composer.sections === 'function') payload.sections = composer.sections();
    if (typeof composer.lastOrder === 'function') payload.order = composer.lastOrder();
    // 每段的实际文本：设置页要显示"当前生效内容"，否则用户改提示词没有参照
    if (typeof composer.lastSections === 'function') payload.details = composer.lastSections();
    // 内置默认文本：编辑时作为初始值显示（留空也能看到默认长什么样）
    if (runtime && runtime.settings && typeof runtime.settings.get === 'function') {
      const snap = runtime.settings.get();
      payload.defaults = {
        toolGuide: readPromptDefault('toolGuide'),
        sendGuide: readPromptDefault('sendGuide'),
        rhythmGuide: readPromptDefault('rhythmGuide'),
        stickerGuide: readPromptDefault('stickerGuide'),
        // 安全红线是内置固定段，没有 prompts 默认，单独给前端做编辑基线
        safety: DEFAULT_SAFETY_LINE,
      };
    }
  } catch {
    /* 结构信息缺失不影响正文 */
  }
  sendJson(res, 200, payload);
}

/**
 * GET /schema —— 设置页结构声明。
 * 前端据此渲染卡片首页与详情页，新增设置区只需改 lib/settings-schema.js。
 */
async function handleGetSchema(req, res) {
  requireMethod(req, ['GET', 'HEAD']);
  sendJson(res, 200, Object.assign({ ok: true }, schemaPayload()));
}

/** 读取内置默认提示词（与服务端 /state 的 promptDefaults 同源）。 */
function readPromptDefault(key) {
  try {
    const value = DEFAULT_FUNCTION_PROMPTS[key];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

// ── handler：memory ─────────────────────────────────────────
async function handleGetMemory(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const memory = requireMemory(runtime);
  const settings = readSettings(runtime);
  const fallbackDir = isObj(settings.memory) && typeof settings.memory.dir === 'string' ? settings.memory.dir : '';
  let layout;
  try {
    layout = memory.layout();
  } catch (error) {
    throw httpError(memoryErrorStatus(messageOf(error)), messageOf(error) || '读取记忆目录失败');
  }
  if (!isObj(layout)) throw httpError(500, '读取记忆目录失败');
  const memorySettings = isObj(settings.memory) ? settings.memory : {};
  const injectMaxChars = intOf(memorySettings.injectMaxChars);
  const hotText = typeof memory.hotText === 'function' ? strOf(memory.hotText(injectMaxChars)) : '';
  const facts = parseMemoryFacts(readMemoryText(memory));
  sendJson(res, 200, {
    ok: true,
    dir: typeof layout.dir === 'string' && layout.dir !== '' ? layout.dir : fallbackDir,
    exists: layout.exists === true,
    files: normalizeFiles(layout.files),
    totalChars: intOf(layout.totalChars),
    // 长期记忆「显式可见」：当前热记忆、注入预算与已解析事实。
    memoryEnabled: memorySettings.enabled !== false,
    injectMaxChars,
    hotChars: hotText.length,
    injectedChars: Math.min(hotText.length, injectMaxChars),
    truncated: hotText.length > injectMaxChars,
    facts,
  });
}

// ── handler：GET /phrases/suggestions ────────────────────────
async function handleGetPhraseSuggestions(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const memory = requireMemory(runtime);
  const settings = readSettings(runtime);
  const existing = new Set(
    (isObj(settings.phrases) && Array.isArray(settings.phrases.items) ? settings.phrases.items : [])
      .map((item) => (isObj(item) && typeof item.text === 'string' ? item.text.trim().toLowerCase() : ''))
      .filter((text) => text !== ''),
  );
  const facts = parseMemoryFacts(readMemoryText(memory));
  const phraseTags = new Set(['口头禅', '口头语', '口癖', '说话风格', '接梗']);
  const suggestions = [];
  const seen = new Set();
  for (const fact of facts) {
    const matched = fact.tags.some((tag) => phraseTags.has(tag));
    if (!matched) continue;
    const quotes = [];
    // 只取「口头禅/常说…」之后引号里的短语，避免把用户昵称（如“你会说大象话吗”）当成口头禅。
    const trigger = /口头禅|口头语|口癖|说话风格|常说|经常说/.exec(fact.text);
    const triggerAt = trigger === null ? -1 : trigger.index;
    const re = /[“"]([^”"]{1,30})[”"]/g;
    let m;
    while ((m = re.exec(fact.text)) !== null) {
      if (triggerAt >= 0 && m.index < triggerAt) continue;
      const text = m[1].trim();
      if (text !== '') quotes.push(text);
    }
    for (const text of quotes) {
      const key = text.toLowerCase();
      if (seen.has(key) || existing.has(key)) continue;
      seen.add(key);
      suggestions.push({ text, note: fact.text.slice(0, 160), tags: fact.tags, date: fact.date });
    }
  }
  sendJson(res, 200, { ok: true, suggestions: suggestions.slice(0, 30) });
}

async function handleGetMemoryFile(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const memory = requireMemory(runtime);
  if (typeof memory.readFile !== 'function') throw httpError(503, '记忆文件读取不可用');
  const rel = normalizeMemoryRel(url.searchParams.get('path') || 'MEMORY.md');
  if (rel === undefined) throw httpError(400, '记忆文件路径不合法（不允许绝对路径或 .. 越界）');
  let result;
  try {
    result = await memory.readFile(rel);
  } catch (error) {
    const message = messageOf(error);
    // 文件不存在用 404，其它校验类错误用 400，未知错误交给 wrapper 记 500
    const status = /不存在/.test(message) ? 404 : memoryErrorStatus(message);
    throw httpError(status, message || '读取记忆文件失败');
  }
  if (isObj(result) && result.ok === false) {
    throw httpError(isObj(result) && typeof result.error === 'string' ? 400 : 500, strOf(result.error) || '读取记忆文件失败');
  }
  if (!isObj(result) || typeof result.text !== 'string') throw httpError(404, '记忆文件不存在');
  sendJson(res, 200, { ok: true, path: strOf(result.path) || rel, text: result.text });
}

async function handlePutMemoryFile(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const body = await readJsonBody(req);
  const memory = requireMemory(runtime);
  if (typeof memory.writeFile !== 'function') throw httpError(503, '记忆文件写入不可用');
  const rel = normalizeMemoryRel(body.path);
  if (rel === undefined) throw httpError(400, '记忆文件路径不合法（不允许绝对路径或 .. 越界）');
  if (typeof body.text !== 'string') throw httpError(400, '请求缺少文件内容 text');
  let result;
  try {
    result = await memory.writeFile(rel, body.text);
  } catch (error) {
    const message = messageOf(error);
    throw httpError(memoryErrorStatus(message), message || '写入记忆文件失败');
  }
  if (!isObj(result) || result.ok === false) {
    throw httpError(400, isObj(result) && typeof result.error === 'string' ? result.error : '写入记忆文件失败');
  }
  sendJson(res, 200, { ok: true, path: strOf(result.path) || rel });
}

async function handleAppendMemory(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const body = await readJsonBody(req);
  const memory = requireMemory(runtime);
  if (typeof memory.saveFact !== 'function') throw httpError(503, '长期记忆写入不可用');
  const text = typeof body.text === 'string' ? body.text : typeof body.content === 'string' ? body.content : '';
  if (text.trim() === '') throw httpError(400, '手记内容不能为空');
  const tags = Array.isArray(body.tags)
    ? body.tags
        .filter((tag) => typeof tag === 'string' && tag.trim() !== '')
        .map((tag) => tag.trim().slice(0, 30))
        .slice(0, 20)
    : [];
  let result;
  try {
    result = await memory.saveFact({ text, tags });
  } catch (error) {
    const message = messageOf(error);
    throw httpError(memoryErrorStatus(message), message || '保存长期记忆失败');
  }
  if (!isObj(result) || result.ok === false) {
    throw httpError(400, isObj(result) && typeof result.error === 'string' ? result.error : '保存长期记忆失败');
  }
  sendJson(res, 200, {
    ok: true,
    duplicate: result.duplicate === true,
    entry: result.entry ?? result.fact ?? null,
  });
}

async function handleCollectMemory(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  // 仍然消费请求体，保证连接正常收尾（UI 会发送 {}）
  await readJsonBody(req);
  const collector = runtime && runtime.collector;
  if (!collector || typeof collector.collectNow !== 'function') throw httpError(503, '记忆收集模块不可用');
  let result;
  try {
    result = await collector.collectNow();
  } catch (error) {
    throw httpError(500, '提炼记忆失败：' + messageOf(error));
  }
  if (isObj(result) && result.ok === false) {
    throw httpError(500, strOf(result.error) || '提炼记忆失败');
  }
  let stats = {};
  if (typeof collector.stats === 'function') {
    try {
      const value = collector.stats();
      if (isObj(value)) stats = value;
    } catch (error) {
      logWarn(runtime, '读取收集统计失败：' + messageOf(error));
    }
  }
  sendJson(res, 200, {
    ok: true,
    added: isObj(result) && Array.isArray(result.added) ? result.added : [],
    scannedMessages: isObj(result) ? intOf(result.scannedMessages) : 0,
    stats,
  });
}

// ── handler：POST /action ────────────────────────────────────
async function handleAction(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const body = await readJsonBody(req);
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (action === '') throw httpError(400, '请求缺少 action');

  if (action === 'clear-pending') {
    if (!runtime || typeof runtime.clearPending !== 'function') {
      throw httpError(501, '当前版本不支持清空待回复队列');
    }
    let result;
    try {
      result = await runtime.clearPending();
    } catch (error) {
      throw httpError(500, '清空待回复队列失败：' + messageOf(error));
    }
    if (isObj(result) && result.ok === false) {
      throw httpError(400, strOf(result.error) || '清空待回复队列失败');
    }
    sendJson(res, 200, { ok: true, message: '已清空待回复队列' });
    return;
  }

  if (action === 'reconnect') {
    if (!runtime || typeof runtime.restartBot !== 'function') {
      throw httpError(501, '当前版本不支持手动重连，请重启 DSH');
    }
    let result;
    try {
      result = await runtime.restartBot();
    } catch (error) {
      throw httpError(500, '重连失败：' + messageOf(error));
    }
    if (isObj(result) && result.ok === false) {
      throw httpError(400, strOf(result.error) || '重连失败');
    }
    sendJson(res, 200, { ok: true, message: '已触发 QQ 机器人重连' });
    return;
  }

  if (action === 'apply-model') {
    if (!runtime || typeof runtime.resetAllSessions !== 'function') {
      throw httpError(501, '当前版本不支持重置 bot 会话，请重启 DSH 后再使用');
    }
    let result;
    try {
      result = await runtime.resetAllSessions();
    } catch (error) {
      throw httpError(500, '重置 bot 会话失败：' + messageOf(error));
    }
    if (isObj(result) && result.ok === false) {
      throw httpError(400, strOf(result.error) || '重置 bot 会话失败');
    }
    sendJson(res, 200, { ok: true, message: '已重置 bot 会话，下一条消息将使用新模型' });
    return;
  }

  if (action === 'reset-settings') {
    const settings = requireSettings(runtime);
    if (typeof settings.replace !== 'function') throw httpError(503, '设置存储不支持恢复默认值');
    let defaults;
    try {
      defaults = isObj(settings.defaults) ? settings.defaults : {};
    } catch {
      defaults = {};
    }
    const result = await settings.replace(defaults);
    const changed = isObj(result) && Array.isArray(result.changed) ? result.changed.length : 0;
    sendJson(res, 200, {
      ok: true,
      message: '已恢复默认设置' + (changed > 0 ? '（' + changed + ' 项变更）' : ''),
    });
    return;
  }

  throw httpError(400, '未知操作：' + action);
}

// ── 表情包管理（added 2026-10-26） ───────────────────────────
const STICKER_EXT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const STICKER_API_BASE = '/qqbot-buddy/api/stickers';

/** 最小 CSRF 防护：带 Origin 的请求必须与 Host 同源（同源 fetch / Desktop IPC 无 Origin 放行）。 */
function trustedRequest(req) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  if (origin === undefined || origin === null || origin === '') return true;
  const host = req && req.headers ? req.headers.host : undefined;
  try {
    return new URL(String(origin)).host === host;
  } catch {
    return false;
  }
}

/** 取表情包 store；缺失（sticker-dev 未装配）时 503，不让 handler 抛未捕获异常。 */
function requireStickerStore(runtime) {
  const store = runtime && runtime.stickers;
  const ok =
    store &&
    typeof store.list === 'function' &&
    typeof store.read === 'function' &&
    typeof store.saveBuffer === 'function' &&
    typeof store.update === 'function' &&
    typeof store.delete === 'function';
  if (!ok) throw httpError(503, '表情包存储不可用');
  return store;
}

/** 读取表情包相关设置（features.stickers / stickers.collectEnabled / maxMB / dir）。 */
function readStickerSettings(runtime) {
  const settings = readSettings(runtime);
  const raw = isObj(settings.stickers) ? settings.stickers : {};
  const features = isObj(settings.features) ? settings.features : {};
  let maxMB = intOf(raw.maxMB);
  if (maxMB < 1) maxMB = 8;
  if (maxMB > 50) maxMB = 50;
  return {
    settings,
    dir: strOf(raw.dir),
    collectEnabled: raw.collectEnabled !== false,
    featuresStickers: features.stickers !== false,
    maxMB,
  };
}

/**
 * 文件名/basename 预检：只接受表情包目录内的图片文件名。
 * 拒绝路径分隔符、隐藏文件、NUL 与不支持的扩展名（store 内部还会再兜底一次）。
 */
function stickerBaseName(input, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const requireExt = opts.requireExt !== false;
  if (typeof input !== 'string') return undefined;
  const raw = input.trim();
  if (raw === '' || raw.includes('\0')) return undefined;
  const unified = raw.replace(/\\/g, '/');
  if (unified.includes('/')) return undefined;
  if (unified.startsWith('.')) return undefined;
  if (requireExt) {
    const lower = unified.toLowerCase();
    const dot = lower.lastIndexOf('.');
    if (dot <= 0) return undefined;
    if (!Object.prototype.hasOwnProperty.call(STICKER_EXT_TYPES, lower.slice(dot))) return undefined;
  }
  return unified;
}

function stickerContentType(name) {
  const lower = String(name).toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? STICKER_EXT_TYPES[lower.slice(dot)] || 'application/octet-stream' : 'application/octet-stream';
}

function stickerUrl(name) {
  return STICKER_API_BASE + '/file?name=' + encodeURIComponent(name);
}

/** 统一投影 store.list()/save/update 返回的 item（不暴露绝对路径，补 url）。 */
function normalizeStickerItem(item) {
  if (!isObj(item) || typeof item.name !== 'string' || item.name.trim() === '') return null;
  const name = item.name.trim();
  const tags = Array.isArray(item.tags)
    ? item.tags
        .filter((tag) => typeof tag === 'string' && tag.trim() !== '')
        .map((tag) => tag.trim())
        .slice(0, 20)
    : [];
  return {
    name,
    emotion: strOf(item.emotion),
    tags,
    note: strOf(item.note),
    size: intOf(item.size),
    mtime: intOf(item.mtime),
    addedAt: intOf(item.addedAt),
    source: strOf(item.source),
    url: stickerUrl(name),
  };
}

/** 解析 upload 的 data URL；失败返回 undefined（不抛）。 */
function parseStickerDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return undefined;
  const match = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) return undefined;
  const base64 = match[2].replace(/\s+/g, '');
  if (base64 === '') return undefined;
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return undefined;
  }
  if (!buffer || buffer.length === 0) return undefined;
  return { mime: match[1].toLowerCase(), buffer };
}

function normalizeTagArray(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((tag) => typeof tag === 'string' && tag.trim() !== '')
    .map((tag) => tag.trim().slice(0, 30))
    .slice(0, 20);
}

// ── handler：GET /stickers ───────────────────────────────────
async function handleGetStickers(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  if (!trustedRequest(req)) throw httpError(403, 'forbidden');
  const store = requireStickerStore(runtime);
  const info = readStickerSettings(runtime);
  let dir = info.dir;
  try {
    if (typeof store.dir === 'function') {
      const value = store.dir();
      if (typeof value === 'string' && value !== '') dir = value;
    }
  } catch (error) {
    logWarn(runtime, '读取表情包目录失败：' + messageOf(error));
  }
  let items = [];
  try {
    const list = await store.list();
    items = (Array.isArray(list) ? list : []).map(normalizeStickerItem).filter(Boolean);
  } catch (error) {
    throw httpError(500, '读取表情包列表失败：' + messageOf(error));
  }

  // 近 24h 收藏数量（表情包每日配额展示用）：优先 store.countAddedSince()
  // （task-18 提供；签名不一致/异常时降级），否则按 item.addedAt 估算。
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let todayCount;
  // 优先 store.collectQuota()（sticker store 提供 {todayCount, dailyLimit, allowed}），
  // 其次 countAddedSince(sinceMs) —— 注意参数是「绝对时间戳」而不是时长。
  if (typeof store.collectQuota === 'function') {
    try {
      const quota = await store.collectQuota(nowMs);
      if (isObj(quota) && typeof quota.todayCount === 'number' && Number.isFinite(quota.todayCount)) {
        const count = Math.max(0, Math.trunc(quota.todayCount));
        if (count <= items.length) todayCount = count;
      }
    } catch (error) {
      logWarn(runtime, '读取收藏配额失败：' + messageOf(error));
    }
  }
  if (todayCount === undefined && typeof store.countAddedSince === 'function') {
    try {
      const value = await store.countAddedSince(nowMs - dayMs);
      let count;
      if (typeof value === 'number' && Number.isFinite(value)) count = Math.trunc(value);
      else if (isObj(value) && typeof value.count === 'number' && Number.isFinite(value.count)) count = Math.trunc(value.count);
      // 防御：结果不应超过库内条目数，否则大概率是单位不匹配，忽略并走估算
      if (typeof count === 'number' && count >= 0 && count <= items.length) todayCount = count;
    } catch (error) {
      logWarn(runtime, '读取今日收藏数量失败：' + messageOf(error));
    }
  }
  if (todayCount === undefined) {
    todayCount = items.filter((item) => item.addedAt > 0 && item.addedAt >= nowMs - dayMs).length;
  }

  sendJson(res, 200, {
    ok: true,
    dir,
    collectEnabled: info.collectEnabled,
    featuresStickers: info.featuresStickers,
    maxMB: info.maxMB,
    todayCount,
    items,
  });
}

// ── handler：GET /stickers/file（图片二进制，不 JSON 包装） ───
async function handleGetStickerFile(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  if (!trustedRequest(req)) throw httpError(403, 'forbidden');
  const store = requireStickerStore(runtime);
  const name = stickerBaseName(url.searchParams.get('name'));
  if (name === undefined) throw httpError(400, '表情文件名不合法（仅支持目录内 png/jpg/jpeg/gif/webp）');
  let raw;
  try {
    raw = await store.read(name);
  } catch (error) {
    const message = messageOf(error);
    throw httpError(/不存在|ENOENT/.test(message) ? 404 : 400, message || '读取表情文件失败');
  }
  let buffer;
  if (Buffer.isBuffer(raw)) buffer = raw;
  else if (raw instanceof Uint8Array) buffer = Buffer.from(raw);
  else throw httpError(404, '表情文件不存在');
  if (buffer.length === 0) throw httpError(404, '表情文件为空');
  try {
    res.writeHead(200, {
      'content-type': stickerContentType(name),
      'cache-control': 'no-store',
      'content-length': String(buffer.length),
    });
    res.end(buffer);
  } catch (error) {
    logWarn(runtime, '写出表情图片失败：' + messageOf(error));
    try {
      if (typeof res.destroy === 'function') res.destroy();
    } catch {
      /* ignore */
    }
  }
}

// ── handler：POST /stickers/upload ───────────────────────────
async function handleUploadSticker(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  if (!trustedRequest(req)) throw httpError(403, 'forbidden');
  const store = requireStickerStore(runtime);
  const info = readStickerSettings(runtime);
  // base64 体积约 4/3，body 上限按 maxMB * 1.4 给足余量（DESIGN 约定）
  const bodyLimit = Math.max(64 * 1024, Math.ceil(info.maxMB * 1.4 * 1024 * 1024));
  const body = await readJsonBody(req, bodyLimit);
  const parsed = parseStickerDataUrl(body.dataUrl);
  if (!parsed) throw httpError(400, 'dataUrl 不合法（需 data:image/(png|jpeg|gif|webp);base64,...）');
  const maxBytes = info.maxMB * 1024 * 1024;
  if (parsed.buffer.length > maxBytes) {
    throw httpError(413, '图片超过单张上限 ' + info.maxMB + 'MB');
  }
  let name;
  if (body.name !== undefined && body.name !== null && body.name !== '') {
    // 允许不带扩展名（store 会按 magic bytes 自动补）；带了扩展名则必须是支持的图片格式
    name = stickerBaseName(body.name, { requireExt: false });
    if (name === undefined) {
      throw httpError(400, 'name 不合法（仅允许目录内的图片文件名）');
    }
    if (name.includes('.')) {
      const lower = name.toLowerCase();
      const ext = lower.slice(lower.lastIndexOf('.'));
      if (!Object.prototype.hasOwnProperty.call(STICKER_EXT_TYPES, ext)) {
        throw httpError(400, 'name 扩展名不支持（仅 png/jpg/jpeg/gif/webp）');
      }
    }
  }
  const options = {
    source: 'upload',
    emotion: strOf(body.emotion).trim().slice(0, 40),
    tags: normalizeTagArray(body.tags),
    note: strOf(body.note).trim().slice(0, 500),
  };
  if (name !== undefined) options.name = name;
  let result;
  try {
    result = await store.saveBuffer(parsed.buffer, options);
  } catch (error) {
    const message = messageOf(error);
    throw httpError(/(超过|过大|不支持|不合法)/.test(message) ? 400 : 500, message || '保存表情失败');
  }
  if (!isObj(result) || result.ok === false) {
    const message = isObj(result) ? strOf(result.error) : '';
    throw httpError(400, message || '保存表情失败');
  }
  const item = normalizeStickerItem(result.item);
  sendJson(res, 200, { ok: true, item });
}

// ── handler：POST /stickers/update ───────────────────────────
async function handleUpdateSticker(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  if (!trustedRequest(req)) throw httpError(403, 'forbidden');
  const store = requireStickerStore(runtime);
  const body = await readJsonBody(req);
  const name = stickerBaseName(body.name);
  if (name === undefined) throw httpError(400, 'name 不合法（仅支持目录内图片文件名）');
  const patch = {};
  if (body.emotion !== undefined) patch.emotion = strOf(body.emotion).trim().slice(0, 40);
  if (body.tags !== undefined) patch.tags = normalizeTagArray(body.tags);
  if (body.note !== undefined) patch.note = strOf(body.note).trim().slice(0, 500);
  if (body.renameTo !== undefined && body.renameTo !== null && body.renameTo !== '') {
    const renameTo = stickerBaseName(body.renameTo);
    if (renameTo === undefined) throw httpError(400, 'renameTo 不合法（仅支持目录内图片文件名）');
    patch.renameTo = renameTo;
  }
  if (Object.keys(patch).length === 0) throw httpError(400, '没有可更新的字段');
  let result;
  try {
    result = await store.update(name, patch);
  } catch (error) {
    const message = messageOf(error);
    throw httpError(/不存在/.test(message) ? 404 : 400, message || '更新表情失败');
  }
  if (!isObj(result) || result.ok === false) {
    const message = isObj(result) ? strOf(result.error) : '';
    throw httpError(/不存在/.test(message) ? 404 : 400, message || '更新表情失败');
  }
  sendJson(res, 200, { ok: true, item: normalizeStickerItem(result.item) });
}

// ── handler：POST /stickers/delete ───────────────────────────
async function handleDeleteSticker(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  if (!trustedRequest(req)) throw httpError(403, 'forbidden');
  const store = requireStickerStore(runtime);
  const body = await readJsonBody(req);
  const name = stickerBaseName(body.name);
  if (name === undefined) throw httpError(400, 'name 不合法（仅支持目录内图片文件名）');
  let result;
  try {
    result = await store.delete(name);
  } catch (error) {
    const message = messageOf(error);
    throw httpError(/不存在/.test(message) ? 404 : 400, message || '删除表情失败');
  }
  if (!isObj(result) || result.ok === false) {
    const message = isObj(result) ? strOf(result.error) : '';
    throw httpError(/不存在/.test(message) ? 404 : 400, message || '删除表情失败');
  }
  sendJson(res, 200, { ok: true });
}


// ── handler：多机器人管理（v0.16） ──────────────────────────
/** 取多机器人宿主（旧单机器人部署没有）。 */
function hostOf(runtime) {
  return runtime && typeof runtime === 'object' ? (runtime.__host || runtime.host) : undefined;
}

function requireHost(runtime) {
  const host = hostOf(runtime);
  if (!host || typeof host.listSnapshots !== 'function') throw httpError(503, '多机器人宿主未就绪');
  return host;
}

function botIdOf(body, url) {
  const fromBody = body && isObj(body) ? strOf(body.botId).trim() : '';
  if (fromBody !== '') return fromBody;
  return url && url.searchParams ? strOf(url.searchParams.get('botId')).trim() : '';
}

async function handleGetBots(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const host = hostOf(runtime);
  if (!host || typeof host.listSnapshots !== 'function') {
    let snap = null;
    try { snap = runtime && typeof runtime.snapshot === 'function' ? runtime.snapshot() : null; } catch { snap = null; }
    sendJson(res, 200, {
      ok: true,
      supported: false,
      bots: snap ? [snap] : [],
      activeBotId: snap ? strOf(snap.id) : '',
      maxBots: 1,
      workspaceRoot: '',
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    supported: true,
    bots: host.listSnapshots(),
    activeBotId: host.registry.activeId(),
    maxBots: host.registry.maxBots,
    workspaceRoot: host.workspaceRoot,
  });
}

async function handleCreateBot(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const host = requireHost(runtime);
  const body = await readJsonBody(req);
  const result = await host.createBot({
    name: strOf(body.name),
    appId: strOf(body.appId),
    appSecret: strOf(body.appSecret),
    workspaceDir: strOf(body.workspaceDir),
    enabled: body.enabled !== false,
  });
  if (!result || result.ok === false) throw httpError(400, (result && result.error) || '创建机器人失败');
  sendJson(res, 200, { ok: true, bot: result.bot, bots: host.listSnapshots(), activeBotId: host.registry.activeId() });
}

async function handleUpdateBot(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const host = requireHost(runtime);
  const body = await readJsonBody(req);
  const botId = botIdOf(body, url);
  if (botId === '') throw httpError(400, '请求缺少 botId');
  const patch = {};
  if (body.name !== undefined) patch.name = strOf(body.name);
  if (body.enabled !== undefined) patch.enabled = body.enabled !== false;
  if (body.workspaceDir !== undefined) patch.workspaceDir = strOf(body.workspaceDir);
  if (body.appId !== undefined) patch.appId = strOf(body.appId);
  if (body.appSecret !== undefined) patch.appSecret = strOf(body.appSecret);
  const result = await host.updateBot(botId, patch);
  if (!result || result.ok === false) throw httpError(400, (result && result.error) || '更新机器人失败');
  sendJson(res, 200, { ok: true, bot: result.bot, bots: host.listSnapshots() });
}

async function handleDeleteBot(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const host = requireHost(runtime);
  const body = await readJsonBody(req);
  const botId = botIdOf(body, url);
  if (botId === '') throw httpError(400, '请求缺少 botId');
  const result = await host.deleteBot(botId);
  if (!result || result.ok === false) throw httpError(400, (result && result.error) || '删除机器人失败');
  sendJson(res, 200, { ok: true, bots: host.listSnapshots(), activeBotId: host.registry.activeId() });
}

async function handleActivateBot(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const host = requireHost(runtime);
  const body = await readJsonBody(req);
  const botId = botIdOf(body, url);
  if (botId === '') throw httpError(400, '请求缺少 botId');
  const result = host.activateBot(botId);
  if (!result || result.ok === false) throw httpError(400, (result && result.error) || '切换机器人失败');
  sendJson(res, 200, { ok: true, activeBotId: result.activeBotId });
}

// ── handler：知识库 ────────────────────────────────────────
function requireEntryStore(runtime, key, label) {
  const store = runtime && runtime[key];
  if (!store || typeof store.list !== 'function') throw httpError(503, label + '不可用');
  return store;
}

function storeResultOrThrow(result, fallback) {
  if (result && result.ok === false) throw httpError(400, strOf(result.error) || fallback);
  if (result && (result.entry || result.item)) return result.entry || result.item;
  return result;
}

function queryLimit(url, fallback) {
  const raw = Number(url && url.searchParams ? url.searchParams.get('limit') : NaN);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1, Math.min(200, Math.round(raw)));
}

async function handleGetKnowledge(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const store = requireEntryStore(runtime, 'knowledge', '知识库');
  let data;
  try {
    data = store.list({
      q: strOf(url.searchParams.get('q')),
      tag: strOf(url.searchParams.get('tag')),
      scope: strOf(url.searchParams.get('scope')),
      status: strOf(url.searchParams.get('status')),
      groupId: strOf(url.searchParams.get('groupId')),
      limit: queryLimit(url, 50),
      offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
    });
  } catch (error) {
    throw httpError(500, '读取知识库失败：' + messageOf(error));
  }
  let stats = {};
  try { stats = typeof store.stats === 'function' ? store.stats() : {}; } catch { stats = {}; }
  sendJson(res, 200, {
    ok: true,
    total: intOf(data && data.total),
    items: Array.isArray(data && data.items) ? data.items : [],
    tags: Array.isArray(stats && stats.tags) ? stats.tags : [],
    byScope: isObj(stats && stats.byScope) ? stats.byScope : {},
  });
}

async function handleGetKnowledgeEntry(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const store = requireEntryStore(runtime, 'knowledge', '知识库');
  const id = strOf(url.searchParams.get('id')).trim();
  if (id === '') throw httpError(400, '请求缺少条目 id');
  let entry = null;
  try { entry = store.get(id); } catch (error) { throw httpError(500, '读取条目失败：' + messageOf(error)); }
  if (!entry) throw httpError(404, '条目不存在: ' + id);
  sendJson(res, 200, { ok: true, entry: entry });
}

function normalizeTagsInput(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    const tag = typeof item === 'string' ? item.trim() : '';
    if (tag === '' || out.includes(tag)) continue;
    out.push(tag.slice(0, 40));
    if (out.length >= 12) break;
  }
  return out;
}

async function handleSaveKnowledge(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const store = requireEntryStore(runtime, 'knowledge', '知识库');
  const body = await readJsonBody(req);
  const id = strOf(body.id).trim();
  const title = strOf(body.title).trim();
  if (id === '' && title === '') throw httpError(400, '新建条目至少需要标题 title');
  const input = {
    id: id,
    title: title,
    body: strOf(body.body),
    tags: normalizeTagsInput(body.tags),
    scope: ['global', 'group', 'c2c'].includes(strOf(body.scope)) ? strOf(body.scope) : 'global',
    groupId: strOf(body.groupId),
  };
  if (Number.isFinite(Number(body.importance))) {
    input.importance = Math.max(0, Math.min(3, Math.round(Number(body.importance))));
  }
  let result;
  try {
    result = store.save(input);
  } catch (error) {
    throw httpError(400, '保存知识条目失败：' + messageOf(error));
  }
  sendJson(res, 200, { ok: true, entry: storeResultOrThrow(result, '保存知识条目失败') });
}

async function handleDeleteKnowledge(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const store = requireEntryStore(runtime, 'knowledge', '知识库');
  const body = await readJsonBody(req);
  const id = strOf(body.id).trim();
  if (id === '') throw httpError(400, '请求缺少条目 id');
  let result;
  try { result = store.remove(id); } catch (error) { throw httpError(500, '删除条目失败：' + messageOf(error)); }
  if (result && result.ok === false) throw httpError(400, strOf(result.error) || '删除条目失败');
  sendJson(res, 200, { ok: true });
}

// ── handler：群友库 ────────────────────────────────────────
async function handleGetMembers(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const store = requireEntryStore(runtime, 'members', '群友库');
  let data;
  try {
    data = store.list({
      q: strOf(url.searchParams.get('q')),
      groupId: strOf(url.searchParams.get('groupId')),
      limit: queryLimit(url, 100),
      offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
    });
  } catch (error) {
    throw httpError(500, '读取群友库失败：' + messageOf(error));
  }
  let groups = [];
  try { groups = typeof store.groups === 'function' ? store.groups() : []; } catch { groups = []; }
  let stats = {};
  try { stats = typeof store.stats === 'function' ? store.stats() : {}; } catch { stats = {}; }
  sendJson(res, 200, {
    ok: true,
    total: intOf(data && data.total),
    items: Array.isArray(data && data.items) ? data.items : [],
    groups: Array.isArray(groups) ? groups : [],
    tags: Array.isArray(stats && stats.tags) ? stats.tags : [],
  });
}

async function handleSaveMember(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const store = requireEntryStore(runtime, 'members', '群友库');
  const body = await readJsonBody(req);
  const id = strOf(body.id).trim();
  if (id === '') throw httpError(400, '请求缺少成员 id');
  let result;
  try {
    const memberInput = {
      id: id,
      title: strOf(body.name),
      body: strOf(body.notes),
      tags: normalizeTagsInput(body.tags),
    };
    if (Number.isFinite(Number(body.importance))) {
      memberInput.importance = Math.max(0, Math.min(3, Math.round(Number(body.importance))));
    }
    if (body.profile !== undefined && body.profile !== null && typeof body.profile === 'object') {
      memberInput.profile = body.profile;
    }
    result = store.save(memberInput);
  } catch (error) {
    throw httpError(400, '保存成员失败：' + messageOf(error));
  }
  sendJson(res, 200, { ok: true, entry: storeResultOrThrow(result, '保存成员失败') });
}

async function handleMemberExtract(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const extractor = runtime && runtime.profileExtractor;
  if (!extractor || typeof extractor.extractNow !== 'function') throw httpError(503, '群友画像提炼不可用');
  const body = await readJsonBody(req);
  let result;
  try {
    result = await extractor.extractNow(null, {
      transcript: strOf(body.transcript).trim(),
      groupId: strOf(body.groupId).trim(),
      groupHint: strOf(body.groupHint).trim(),
      manual: true,
    });
  } catch (error) {
    throw httpError(500, '群友画像提炼失败：' + messageOf(error));
  }
  if (!result || result.ok !== true) {
    throw httpError(400, strOf(result && result.error) || '群友画像提炼失败');
  }
  sendJson(res, 200, {
    ok: true,
    updated: Array.isArray(result.updated) ? result.updated : [],
    skipped: Array.isArray(result.skipped) ? result.skipped : [],
    candidates: Array.isArray(result.candidates) ? result.candidates : [],
    scannedMessages: intOf(result.scannedMessages),
  });
}

async function handleGetMemberExtractStats(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const extractor = runtime && runtime.profileExtractor;
  if (!extractor || typeof extractor.stats !== 'function') throw httpError(503, '群友画像提炼不可用');
  sendJson(res, 200, { ok: true, stats: extractor.stats() });
}

async function handleAdoptMemberNote(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const store = requireEntryStore(runtime, 'members', '群友库');
  if (typeof store.adoptAutoNote !== 'function') throw httpError(503, '群友库不支持采纳自动备注');
  const body = await readJsonBody(req);
  const id = strOf(body.id).trim();
  if (id === '') throw httpError(400, '请求缺少成员 id');
  const index = Number.isInteger(body.index) ? body.index : undefined;
  let result;
  try {
    result = store.adoptAutoNote({ id: id, index: index });
  } catch (error) {
    throw httpError(500, '采纳自动备注失败：' + messageOf(error));
  }
  if (!result || result.ok !== true) throw httpError(400, strOf(result && result.reason) || '采纳自动备注失败');
  sendJson(res, 200, { ok: true, entry: result.entry || null });
}
async function handleDeleteMember(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const store = requireEntryStore(runtime, 'members', '群友库');
  const body = await readJsonBody(req);
  const id = strOf(body.id).trim();
  if (id === '') throw httpError(400, '请求缺少成员 id');
  let result;
  try { result = store.remove(id); } catch (error) { throw httpError(500, '删除成员失败：' + messageOf(error)); }
  if (result && result.ok === false) throw httpError(400, strOf(result.error) || '删除成员失败');
  sendJson(res, 200, { ok: true });
}

// ── handler：涌现预览（「必要时涌现」调试/预览） ────────────
async function handleRecallPreview(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const emergence = runtime && runtime.emergence;
  if (!emergence || typeof emergence.recallForTurn !== 'function') throw httpError(503, '涌现检索不可用');
  const text = strOf(url.searchParams.get('text')).trim();
  if (text === '') throw httpError(400, '请求缺少 text');
  const scope = strOf(url.searchParams.get('scope')) === 'c2c' ? 'c2c' : 'group';
  let result;
  try {
    result = emergence.recallForTurn({
      text: text,
      scope: scope,
      groupId: strOf(url.searchParams.get('groupId')),
      senderId: strOf(url.searchParams.get('senderId')),
      senderName: strOf(url.searchParams.get('senderName')),
    });
  } catch (error) {
    throw httpError(500, '检索失败：' + messageOf(error));
  }
  sendJson(res, 200, {
    ok: true,
    block: strOf(result && result.text),
    counts: isObj(result && result.counts) ? result.counts : {},
    items: Array.isArray(result && result.items) ? result.items : [],
  });
}

// ── handler：知识库自动提炼（v0.16.1） ──────────────────────
async function handleKnowledgeExtract(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const extractor = runtime && runtime.knowledgeExtractor;
  if (!extractor || typeof extractor.extractNow !== 'function') throw httpError(503, '知识自动提炼不可用');
  const body = await readJsonBody(req);
  const transcript = strOf(body.transcript).trim();
  const groupHint = strOf(body.groupHint).trim();
  let result;
  try {
    result = await extractor.extractNow(null, {
      transcript: transcript,
      groupHint: groupHint,
      scope: strOf(body.scope),
      groupId: strOf(body.groupId),
    });
  } catch (error) {
    throw httpError(500, '提炼失败：' + messageOf(error));
  }
  if (!result || result.ok !== true) {
    throw httpError(400, strOf(result && result.error) || '提炼失败');
  }
  sendJson(res, 200, {
    ok: true,
    added: Array.isArray(result.added) ? result.added : [],
    pending: Array.isArray(result.pending) ? result.pending : [],
    merged: Array.isArray(result.merged) ? result.merged : [],
    membersUpdated: Array.isArray(result.membersUpdated) ? result.membersUpdated : [],
    membersSkipped: Array.isArray(result.membersSkipped) ? result.membersSkipped : [],
    scannedMessages: intOf(result.scannedMessages),
  });
}

async function handleGetKnowledgeExtractStats(req, res, url, runtime) {
  requireMethod(req, ['GET', 'HEAD']);
  const extractor = runtime && runtime.knowledgeExtractor;
  if (!extractor || typeof extractor.stats !== 'function') throw httpError(503, '知识自动提炼不可用');
  sendJson(res, 200, { ok: true, stats: extractor.stats() });
}

async function handleApproveKnowledge(req, res, url, runtime) {
  requireMethod(req, ['POST']);
  const store = requireEntryStore(runtime, 'knowledge', '知识库');
  const body = await readJsonBody(req);
  const id = strOf(body.id).trim();
  if (id === '') throw httpError(400, '请求缺少条目 id');
  const approve = body.approve !== false;
  if (!approve) {
    let removed;
    try { removed = store.remove(id); } catch (error) { throw httpError(500, '丢弃条目失败：' + messageOf(error)); }
    if (removed && removed.ok === false) throw httpError(400, strOf(removed.error) || '丢弃条目失败');
    sendJson(res, 200, { ok: true, removed: true });
    return;
  }
  const existing = store.get(id);
  if (!existing) throw httpError(404, '条目不存在: ' + id);
  let saved;
  try {
    saved = store.save({ id: id, status: 'approved' });
  } catch (error) {
    throw httpError(400, '采纳条目失败：' + messageOf(error));
  }
  sendJson(res, 200, { ok: true, entry: storeResultOrThrow(saved, '采纳条目失败') });
}
// ── 路由表与注册 ─────────────────────────────────────────────
const ROUTES = [
  { name: 'state', path: '/state', method: 'GET', handler: handleGetState },
  { name: 'persona', path: '/persona', method: 'GET', handler: handleGetPersona },
  { name: 'persona-save', path: '/persona', method: 'POST', handler: handleSavePersona },
  { name: 'persona-restore', path: '/persona/restore', method: 'POST', handler: handleRestorePersona },
  { name: 'persona-cards', path: '/persona/cards', method: 'GET', handler: handleGetPersonaCards },
  { name: 'persona-cards-content', path: '/persona/cards/content', method: 'GET', handler: handleGetPersonaCardContent },
  { name: 'persona-cards-create', path: '/persona/cards', method: 'POST', handler: handleCreatePersonaCard },
  { name: 'persona-cards-update', path: '/persona/cards/update', method: 'POST', handler: handleUpdatePersonaCard },
  { name: 'persona-cards-activate', path: '/persona/cards/activate', method: 'POST', handler: handleActivatePersonaCard },
  { name: 'persona-cards-delete', path: '/persona/cards/delete', method: 'POST', handler: handleDeletePersonaCard },
  { name: 'commands', path: '/commands', method: 'GET', handler: handleGetCommands },
  { name: 'settings', path: '/settings', method: 'POST', handler: handlePostSettings },
  { name: 'memory', path: '/memory', method: 'GET', handler: handleGetMemory },
  { name: 'memory-file-get', path: '/memory/file', method: 'GET', handler: handleGetMemoryFile },
  { name: 'memory-file-put', path: '/memory/file', method: 'POST', handler: handlePutMemoryFile },
  { name: 'memory-append', path: '/memory/append', method: 'POST', handler: handleAppendMemory },
  { name: 'memory-collect', path: '/memory/collect', method: 'POST', handler: handleCollectMemory },
  { name: 'phrase-suggestions', path: '/phrases/suggestions', method: 'GET', handler: handleGetPhraseSuggestions },
  { name: 'tools', path: '/tools', method: 'GET', handler: handleGetTools },
  { name: 'presets', path: '/presets', method: 'GET', handler: handleGetPresets },
  { name: 'models', path: '/models', method: 'GET', handler: handleGetModels },
  { name: 'schema', path: '/schema', method: 'GET', handler: handleGetSchema },
  { name: 'prompt', path: '/prompt', method: 'GET', handler: handleGetPrompt },
  { name: 'action', path: '/action', method: 'POST', handler: handleAction },
  { name: 'stickers', path: '/stickers', method: 'GET', handler: handleGetStickers },
  { name: 'sticker-file', path: '/stickers/file', method: 'GET', handler: handleGetStickerFile },
  { name: 'sticker-upload', path: '/stickers/upload', method: 'POST', handler: handleUploadSticker },
  { name: 'sticker-update', path: '/stickers/update', method: 'POST', handler: handleUpdateSticker },
  { name: 'sticker-delete', path: '/stickers/delete', method: 'POST', handler: handleDeleteSticker },
  // ── 多机器人 ──
  { name: 'bots', path: '/bots', method: 'GET', handler: handleGetBots },
  { name: 'bots-create', path: '/bots/create', method: 'POST', handler: handleCreateBot },
  { name: 'bots-update', path: '/bots/update', method: 'POST', handler: handleUpdateBot },
  { name: 'bots-delete', path: '/bots/delete', method: 'POST', handler: handleDeleteBot },
  { name: 'bots-activate', path: '/bots/activate', method: 'POST', handler: handleActivateBot },
  // ── 知识库 / 群友库 / 涌现 ──
  { name: 'knowledge', path: '/knowledge', method: 'GET', handler: handleGetKnowledge },
  { name: 'knowledge-entry', path: '/knowledge/entry', method: 'GET', handler: handleGetKnowledgeEntry },
  { name: 'knowledge-save', path: '/knowledge/save', method: 'POST', handler: handleSaveKnowledge },
  { name: 'knowledge-delete', path: '/knowledge/delete', method: 'POST', handler: handleDeleteKnowledge },
  { name: 'members', path: '/members', method: 'GET', handler: handleGetMembers },
  { name: 'members-save', path: '/members/save', method: 'POST', handler: handleSaveMember },
  { name: 'members-delete', path: '/members/delete', method: 'POST', handler: handleDeleteMember },
  { name: 'recall-preview', path: '/recall/preview', method: 'GET', handler: handleRecallPreview },
  // ── 知识库自动提炼 ──
  { name: 'knowledge-extract', path: '/knowledge/extract', method: 'POST', handler: handleKnowledgeExtract },
  { name: 'knowledge-extract-stats', path: '/knowledge/extract/stats', method: 'GET', handler: handleGetKnowledgeExtractStats },
  { name: 'knowledge-approve', path: '/knowledge/approve', method: 'POST', handler: handleApproveKnowledge },
  // ── 群友备注自动提炼（阶段二） ──
  { name: 'members-adopt', path: '/members/adopt', method: 'POST', handler: handleAdoptMemberNote },
  // ── 群友画像自动提炼 ──
  { name: 'members-extract', path: '/members/extract', method: 'POST', handler: handleMemberExtract },
  { name: 'members-extract-stats', path: '/members/extract/stats', method: 'GET', handler: handleGetMemberExtractStats },
];

/**
 * 同一个 path 可能登记了多个 handler（如 GET/POST 都挂在 /persona），按方法分派。
 * HEAD 按 GET 处理；方法不匹配时仍调用同路径第一个 handler，由它返回 405。
 */
function createPathDispatcher(entries, runtime) {
  return async (req, res) => {
    const method = String(req && req.method ? req.method : 'GET').toUpperCase();
    const wanted = method === 'HEAD' ? 'GET' : method;
    const selected = entries.find((entry) => entry.method === wanted) || entries[0];
    if (!selected) {
      sendJson(res, 404, { ok: false, error: '接口不存在' });
      return;
    }
    await runHandler(selected.name, selected.handler, runtime, req, res);
  };
}

/**
 * 按 ?botId= 把请求路由到对应机器人的运行时；缺省/找不到时用默认运行时。
 * 旧单机器人部署（runtime 没有 __host）原样返回，行为不变。
 */
function scopeRuntime(runtime, url) {
  const rt = runtime && typeof runtime === 'object' ? runtime : {};
  const host = rt.__host || rt.host;
  if (!host || typeof host.runtimeFor !== 'function') return rt;
  const botId = url && url.searchParams ? strOf(url.searchParams.get('botId')).trim() : '';
  if (botId !== '') {
    const scoped = host.runtimeFor(botId);
    if (scoped) return scoped;
  }
  return rt;
}

async function runHandler(name, handler, runtime, req, res) {
  try {
    const url = parseUrl(req);
    const scoped = scopeRuntime(runtime, url);
    await handler(req, res, url, scoped);
  } catch (error) {
    const status = Number.isInteger(error && error.status) ? error.status : 500;
    const message = messageOf(error) || '服务器内部错误';
    if (status >= 500) log(runtime, 'error', '[qqbot-buddy] ' + name + ' 处理失败：' + message);
    else log(runtime, 'debug', '[qqbot-buddy] ' + name + ' 请求被拒绝（' + status + '）：' + message);
    sendJson(res, status, { ok: false, error: message });
  }
}

/**
 * 注册全部 /qqbot-buddy/api/* 路由。
 * @param {object} ctx cordis 上下文
 * @param {object} runtime 插件装配后的运行期对象（字段均可缺失）
 * @returns {() => void} 聚合 dispose（幂等）
 */
export function registerWebRoutes(ctx, runtime) {
  const rt = runtime && typeof runtime === 'object' ? runtime : {};
  const disposers = [];
  let disposed = false;
  let registered = false;

  const registerOn = (webServer) => {
    if (disposed || registered) return false;
    if (!webServer || typeof webServer.register !== 'function') return false;
    registered = true;
    // 按 path 归组，同 path 的 GET/POST handler 合并为一个处理函数
    const byPath = new Map();
    for (const route of ROUTES) {
      const fullPath = BASE + route.path;
      if (!byPath.has(fullPath)) byPath.set(fullPath, []);
      byPath.get(fullPath).push(route);
    }
    for (const [fullPath, entries] of byPath) {
      try {
        const dispose = webServer.register({
          kind: 'exact',
          path: fullPath,
          handler: createPathDispatcher(entries, rt),
        });
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        log(rt, 'warn', '[qqbot-buddy] 注册路由 ' + fullPath + ' 失败：' + messageOf(error));
      }
    }
    return true;
  };

  const getWebServer = () => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    } catch {
      return undefined;
    }
  };

  if (!registerOn(getWebServer())) {
    // webServer 服务可能尚未就绪：用 ctx.inject 等它就绪，避免直接抛错打挂插件
    if (ctx && typeof ctx.inject === 'function') {
      try {
        const off = ctx.inject(['webServer'], (scoped) => {
          try {
            registerOn(scoped && scoped.webServer);
          } catch (error) {
            log(rt, 'warn', '[qqbot-buddy] webServer 注入回调失败：' + messageOf(error));
          }
        });
        if (typeof off === 'function') disposers.push(off);
      } catch (error) {
        log(rt, 'warn', '[qqbot-buddy] 注册 webServer 注入失败：' + messageOf(error));
      }
    } else {
      log(rt, 'warn', '[qqbot-buddy] webServer 不可用，管理 API 未注册');
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      try {
        dispose();
      } catch (error) {
        log(rt, 'warn', '[qqbot-buddy] 释放路由失败：' + messageOf(error));
      }
    }
  };
}