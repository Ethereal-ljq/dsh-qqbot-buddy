/**
 * knowledge/auto-extract —— 知识库自动提炼（阶段一：只提炼知识，不改群友备注）。
 *
 * 触发：每轮回复结束（outbound turn/end）计数，达到 settings.knowledge.autoExtract.everyRounds
 * 轮后，用与记忆提炼相同的“取最近消息 → 调模型 → 解析 JSON → 落库”管线后台跑一次；
 * 也支持设置页/API 手动「立即提炼一次」（可传 transcript 试跑，不需要真实会话）。
 *
 * 入库策略（避免乱塞）：
 * - 只收“长期有效的群/机器人知识”：群规、长期约定、活动安排、FAQ、重要结论、群梗；
 *   FAQ 式闲聊、一次性信息、隐私/密钥一律不记（写进 prompt 约束）；
 * - 单轮最多 settings.autoExtract.maxEntries 条；
 * - 先按标题/作用域查重，命中已有条目就合并标签/重要度，不重复建条目；
 * - 置信度 >= minConfidence 直接 approved；低于阈值写 pending，**不参与检索/涌现注入**，
 *   等用户在设置页「待确认」里采纳或丢弃；
 * - 失败只记日志，绝不阻塞聊天；60s 超时 + 单机器人并发锁。
 */
import { createHash } from 'node:crypto';

const DEFAULT_EXTRACT = Object.freeze({
  enabled: false,
  everyRounds: 6,
  maxEntries: 3,
  minConfidence: 0.8,
  provider: '',
  model: '',
});
const MIN_MESSAGES = 4;
const MAX_TRANSCRIPT_CHARS = 12000;
const LLM_TIMEOUT_MS = 60000;
const MIN_MAX_TOKENS = 700;
const MAX_MAX_TOKENS = 3000;
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 2000;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 24;

function errText(err) { return err instanceof Error ? err.message : String(err); }
function asString(value) { return typeof value === 'string' ? value : ''; }
function isObj(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nowIso() { return new Date().toISOString(); }

function clampChars(value, max) {
  const text = String(value ?? '');
  if (!Number.isFinite(max) || max <= 0) return '';
  return text.length <= max ? text : [...text].slice(0, max).join('');
}

function tailChars(value, max) {
  const text = String(value ?? '');
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  let start = text.length - max;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function clampNum(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** 归一化用于查重：NFKC + 折叠空白 + 小写。 */
function normalizeForCompare(text) {
  return String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 容错取 session 事件（与 memory/collector 相同的兼容姿势）。 */
function getEvents(record) {
  const safe = (obj, key) => {
    try { return obj ? obj[key] : undefined; } catch { return undefined; }
  };
  const candidates = [];
  const recordEvents = safe(record, 'events');
  if (Array.isArray(recordEvents)) candidates.push(recordEvents);
  const sessions = [];
  const direct = safe(record, 'session');
  if (direct && typeof direct === 'object') sessions.push(direct);
  const agent = safe(record, 'agent');
  if (agent && typeof agent === 'object') {
    const agentSession = safe(agent, 'session');
    if (agentSession && typeof agentSession === 'object') sessions.push(agentSession);
  }
  for (const session of sessions) {
    const events = safe(session, 'events');
    if (Array.isArray(events)) candidates.push(events);
    else if (typeof events === 'function') {
      try {
        const value = events();
        if (Array.isArray(value)) candidates.push(value);
      } catch { /* ignore */ }
    }
    if (typeof safe(session, 'snapshotEvents') === 'function') {
      try {
        const value = session.snapshotEvents();
        if (Array.isArray(value)) candidates.push(value);
      } catch { /* ignore */ }
    }
    if (Array.isArray(safe(session, 'log'))) candidates.push(safe(session, 'log'));
  }
  for (const events of candidates) {
    if (Array.isArray(events) && events.length > 0) return events;
  }
  return [];
}

/** 从事件里抽 user/assistant 文本。 */
function extractMessages(events) {
  const messages = [];
  if (!Array.isArray(events)) return messages;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const type = asString(event.type);
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    const payload = isObj(event.message) ? event.message : event;
    const content = payload.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
    }
    text = asString(text).trim();
    if (text === '') continue;
    messages.push({ role: type === 'user/message' ? 'user' : 'assistant', text });
  }
  return messages;
}

/** 构造提炼 prompt。 */
function buildPrompt({ transcript, maxEntries, groupHint }) {
  return [
    '你是 QQ 群聊知识整理助手。下面是一段群聊（user=群友/用户，assistant=机器人）。',
    '请从里面提炼【值得长期保留的群知识】。只输出一个 JSON 对象，不要解释、不要代码围栏。',
    '',
    '可以记录（有就记，没有就返回空数组）：',
    '- 群规/约定/禁止事项',
    '- 长期活动安排（固定时间、固定玩法）',
    '- 反复出现的 FAQ（大家常问怎么处理的事）',
    '- 重要决定、长期有效的结论',
    '- 群梗/称呼（简短说明，不要冒犯）',
    '',
    '不要记录：',
    '- 寒暄、一次性闲聊、临时话题',
    '- 隐私信息（手机号、住址、身份证、账号密码）、密钥、配置文件内容',
    '- 你无法确认的猜测（宁可不记）',
    '',
    '输出格式（严格 JSON）：',
    '{"knowledge":[{"title":"不超过 30 字","body":"1-3 句，具体、可执行","tags":["中文标签"],"importance":0-3,"confidence":0-1,"scope":"group"}]}',
    '- scope 固定 "group"（这段对话来自群聊）；私聊场景由调用方决定，但你也统一填 "group" 即可；',
    '- importance：0 琐碎 / 1 一般 / 2 重要 / 3 群规级；',
    '- confidence：你对该信息长期有效且准确的把握（0-1）；',
    '- 最多 ' + maxEntries + ' 条，宁少勿多；同一条不要重复。',
    groupHint !== '' ? '（当前会话：' + groupHint + '）' : '',
    '',
    '【群聊记录开始】',
    transcript,
    '【群聊记录结束】',
  ].filter((line) => line !== '').join('\n');
}

/** 从模型输出里抽取 JSON 并校验成知识条目；解析失败返回 null。 */
export function parseExtractedKnowledge(text, { maxEntries = 3 } = {}) {
  const raw = asString(text).trim();
  if (raw === '') return null;
  const cleaned = raw.replace(/^\uFEFF/, '');
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidateText = fenced ? fenced[1] : cleaned;
  const start = candidateText.indexOf('{');
  const end = candidateText.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(candidateText.slice(start, end + 1));
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : (isObj(parsed) && Array.isArray(parsed.knowledge) ? parsed.knowledge : null);
  if (rows === null) return null;
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!isObj(row)) continue;
    const title = clampChars(asString(row.title).replace(/\s+/g, ' ').trim(), MAX_TITLE_CHARS);
    const body = clampChars(asString(row.body).trim(), MAX_BODY_CHARS);
    if (title === '' || body === '') continue;
    const key = normalizeForCompare(title);
    if (seen.has(key)) continue;
    seen.add(key);
    const tags = [];
    for (const tag of Array.isArray(row.tags) ? row.tags : []) {
      const value = clampChars(asString(tag).replace(/[\s,，;；#]+/g, '-').replace(/^-+|-+$/g, ''), MAX_TAG_CHARS);
      if (value === '' || tags.includes(value)) continue;
      tags.push(value);
      if (tags.length >= MAX_TAGS) break;
    }
    out.push({
      title,
      body,
      tags,
      importance: clampInt(row.importance, 0, 3, 1),
      confidence: clampNum(row.confidence, 0, 1, 0.6),
      scope: asString(row.scope) === 'global' ? 'global' : 'group',
    });
    if (out.length >= Math.max(1, clampInt(maxEntries, 1, 10, 3))) break;
  }
  return out;
}

/**
 * 创建知识库自动提炼器。
 * @param {object} options
 * @param {object} options.ctx cordis 上下文（取 llm / agentDefaultModel）
 * @param {object} options.settings settings-store
 * @param {object} options.knowledge createKnowledgeStore 实例
 * @param {object} [options.logger]
 * @param {() => {provider?:string, model?:string}|null} [options.getRoute] 当前模型路由
 * @param {(args:{prompt:string,maxTokens:number,route:object,signal:AbortSignal}) => Promise<string>} [options.callModel]
 *   注入模型调用（测试用）；缺省走宿主 llm 服务
 */
export function createKnowledgeExtractor({ ctx, settings, knowledge, logger, getRoute, callModel } = {}) {
  const log = logger || console;
  let roundsSinceExtract = 0;
  let lastRecord = null;
  let inFlight = null;
  let lastExtractAt = 0;
  let lastResult = null;
  let lastError = '';
  let totalExtracted = 0;
  let totalPending = 0;

  function getService(name) {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  }

  function readSnapshot() {
    try {
      const snapshot = typeof settings?.get === 'function' ? settings.get() : {};
      return isObj(snapshot) ? snapshot : {};
    } catch (err) {
      log.warn?.('knowledge-extractor: 读取设置失败，使用默认值:', err && err.message);
      return {};
    }
  }

  /** 当前生效的 autoExtract 配置（容错 + 缺省）。 */
  function config() {
    const snapshot = readSnapshot();
    const knowledgeCfg = isObj(snapshot.knowledge) ? snapshot.knowledge : {};
    const raw = knowledgeCfg.autoExtract;
    if (raw === true) return { ...DEFAULT_EXTRACT, enabled: true };
    if (!isObj(raw)) return { ...DEFAULT_EXTRACT };
    return {
      enabled: raw.enabled === true,
      everyRounds: clampInt(raw.everyRounds, 1, 100, DEFAULT_EXTRACT.everyRounds),
      maxEntries: clampInt(raw.maxEntries, 1, 10, DEFAULT_EXTRACT.maxEntries),
      minConfidence: clampNum(raw.minConfidence, 0, 1, DEFAULT_EXTRACT.minConfidence),
      provider: asString(raw.provider).trim(),
      model: asString(raw.model).trim(),
    };
  }

  /** 解析提炼模型：配置 → 机器人当前模型路由 → 宿主默认模型。 */
  function resolveRoute(cfg) {
    let provider = cfg.provider;
    let model = cfg.model;
    if ((provider === '' || model === '') && typeof getRoute === 'function') {
      try {
        const route = getRoute();
        if (isObj(route)) {
          if (provider === '' && asString(route.provider).trim() !== '') provider = asString(route.provider).trim();
          if (model === '' && asString(route.model).trim() !== '') model = asString(route.model).trim();
        }
      } catch { /* ignore */ }
    }
    if (provider === '' || model === '') {
      try {
        const defaultModel = getService('agentDefaultModel');
        const selection = defaultModel && typeof defaultModel.currentSelection === 'function'
          ? defaultModel.currentSelection()
          : undefined;
        if (isObj(selection)) {
          if (provider === '' && asString(selection.provider).trim() !== '') provider = asString(selection.provider).trim();
          if (model === '' && asString(selection.model).trim() !== '') model = asString(selection.model).trim();
        }
      } catch { /* ignore */ }
    }
    return { provider, model };
  }

  /** 默认模型调用：走宿主 llm.stream 收集文本（与 memory/collector 同款）。 */
  async function defaultCallModel({ prompt, maxTokens, route, signal }) {
    const llm = getService('llm');
    if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用');
    const mod = await import('@deepseek-ai/dsh-llm');
    const { createUserMessage, BlockAssembler } = mod;
    if (typeof createUserMessage !== 'function' || typeof BlockAssembler !== 'function') {
      throw new Error('LLM 模块缺少 createUserMessage/BlockAssembler');
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-qqbot-buddy:knowledge-extractor' },
    });
    const assembler = new BlockAssembler();
    let finishReason;
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [message],
      maxTokens,
      signal,
    });
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'finish') finishReason = chunk.reason;
      assembler.push(chunk);
    }
    if (finishReason && finishReason.kind === 'error') {
      throw new Error('模型调用失败: ' + ((finishReason.failure && finishReason.failure.message) || 'unknown'));
    }
    if (finishReason && finishReason.kind === 'aborted') throw new Error('提炼被中止或超时');
    const blocks = typeof assembler.blocks === 'function' ? assembler.blocks() : [];
    return blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  function notifyFailure(message, scannedMessages) {
    lastError = message;
    lastResult = { ok: false, error: message, at: nowIso(), scannedMessages: scannedMessages || 0, added: 0, pending: 0 };
    log.warn?.('knowledge-extractor: 自动提炼失败:', message);
    return { ok: false, error: message, added: [], pending: [], scannedMessages: scannedMessages || 0 };
  }

  /** 合并近重复条目：同标题 + 同作用域时只更新标签/重要度。 */
  function mergeDuplicate(candidate, record, scope, groupId) {
    let rows = [];
    try {
      const listed = knowledge.list({ q: candidate.title, groupId: scope === 'group' ? groupId : '', limit: 8 });
      rows = Array.isArray(listed && listed.items) ? listed.items : [];
    } catch (err) {
      log.warn?.('knowledge-extractor: 查重失败（继续新建）:', err && err.message);
      rows = [];
    }
    const wanted = normalizeForCompare(candidate.title);
    for (const row of rows) {
      if (normalizeForCompare(row.title) !== wanted) continue;
      if (row.scope !== scope) continue;
      if (scope === 'group' && row.groupId !== groupId) continue;
      let existing;
      try { existing = knowledge.get(row.id); } catch { existing = null; }
      if (!existing) continue;
      const tags = Array.from(new Set([...(existing.tags || []), ...candidate.tags])).slice(0, MAX_TAGS);
      try {
        knowledge.save({
          id: existing.id,
          tags,
          importance: Math.max(Number(existing.importance) || 0, candidate.importance),
          status: existing.status === 'pending' ? 'pending' : 'approved',
        });
      } catch (err) {
        log.warn?.('knowledge-extractor: 合并已有条目失败:', err && err.message);
      }
      return existing.id;
    }
    return null;
  }

  /**
   * 真正跑一次提炼。
   * @param {object|null} record 会话 record（可空：用 transcript 试跑）
   * @param {{transcript?: string, groupHint?: string}} [options]
   */
  async function runExtract(record, options = {}) {
    const cfg = config();
    if (knowledge && knowledge.available === false) return notifyFailure('知识库不可用', 0);
    let transcript = asString(options.transcript).trim();
    let scannedMessages = 0;
    if (transcript === '') {
      const events = getEvents(record);
      const messages = extractMessages(events);
      scannedMessages = messages.length;
      if (messages.length === 0) return notifyFailure('没有可提炼的消息', 0);
      if (messages.length < MIN_MESSAGES) return notifyFailure('消息太少（至少 ' + MIN_MESSAGES + ' 条）', scannedMessages);
      transcript = messages
        .slice(-Math.max(MIN_MESSAGES, cfg.everyRounds * 2))
        .map((message) => (message.role === 'user' ? '用户' : '助手') + ': ' + message.text)
        .join('\n');
      if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = tailChars(transcript, MAX_TRANSCRIPT_CHARS);
    }

    const route = resolveRoute(cfg);
    if (route.provider === '' || route.model === '') {
      return notifyFailure('未配置可用的提炼模型（autoExtract.provider/model 为空且无默认模型）', scannedMessages);
    }

    const prompt = buildPrompt({
      transcript,
      maxEntries: cfg.maxEntries,
      groupHint: asString(options.groupHint),
    });
    const maxTokens = Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, cfg.maxEntries * 320 + 400));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    timer.unref?.();
    let modelText = '';
    try {
      const invoke = typeof callModel === 'function' ? callModel : defaultCallModel;
      modelText = await invoke({ prompt, maxTokens, route, signal: controller.signal });
    } catch (err) {
      return notifyFailure('模型调用失败: ' + errText(err), scannedMessages);
    } finally {
      clearTimeout(timer);
    }
    if (asString(modelText).trim() === '') return notifyFailure('模型未返回可解析内容', scannedMessages);

    const rows = parseExtractedKnowledge(modelText, { maxEntries: cfg.maxEntries });
    if (rows === null) return notifyFailure('模型返回的 JSON 无法解析', scannedMessages);

    const requestedScope = asString(options.scope);
    const scope = requestedScope === 'global' || requestedScope === 'group' || requestedScope === 'c2c'
      ? requestedScope
      : (record && record.scope === 'group' ? 'group' : (record ? 'c2c' : 'global'));
    const groupId = asString(options.groupId) || (record && scope === 'group' ? asString(record.peerId) : '');
    const groupName = asString(options.groupHint);
    const added = [];
    const pending = [];
    const merged = [];

    for (const row of rows) {
      if (knowledge && knowledge.available === false) break;
      const status = row.confidence >= cfg.minConfidence ? 'approved' : 'pending';
      const candidate = {
        title: row.title,
        body: row.body,
        tags: row.tags,
        importance: row.importance,
        confidence: row.confidence,
        scope: scope === 'global'
          ? 'global'
          : (scope === 'group' ? (row.scope === 'global' ? 'global' : 'group') : 'c2c'),
        status,
      };
      try {
        const existingId = mergeDuplicate(candidate, record, candidate.scope, groupId);
        if (existingId !== null) {
          merged.push({ id: existingId, title: candidate.title });
          continue;
        }
        const saved = knowledge.save({
          title: candidate.title,
          body: candidate.body,
          tags: candidate.tags,
          scope: candidate.scope,
          groupId: candidate.scope === 'global' ? '' : groupId,
          groupName: candidate.scope === 'group' ? groupName : '',
          importance: candidate.importance,
          source: 'auto',
          status: candidate.status,
          meta: { confidence: candidate.confidence, extractor: 'knowledge-auto-extract' },
        });
        if (candidate.status === 'pending') {
          pending.push({ id: saved.id, title: saved.title });
          totalPending += 1;
        } else {
          added.push({ id: saved.id, title: saved.title });
          totalExtracted += 1;
        }
      } catch (err) {
        log.warn?.('knowledge-extractor: 保存条目失败:', err && err.message);
      }
    }

    lastExtractAt = Date.now();
    lastError = '';
    lastResult = {
      ok: true,
      at: new Date(lastExtractAt).toISOString(),
      scannedMessages,
      added: added.length,
      pending: pending.length,
      merged: merged.length,
    };
    if (added.length > 0 || pending.length > 0 || merged.length > 0) {
      log.info?.('knowledge-extractor: 自动提炼完成（新增 ' + added.length + ' / 待确认 ' + pending.length
        + ' / 合并 ' + merged.length + '，扫描 ' + scannedMessages + ' 条消息）');
    }
    return { ok: true, added, pending, merged, scannedMessages, route };
  }

  /** 手动/后台触发；并发时返回 skipped。 */
  function extractNow(record, options = {}) {
    if (inFlight) {
      return Promise.resolve({ ok: false, skipped: true, error: '知识提炼正在进行中', added: [], pending: [], scannedMessages: 0 });
    }
    const target = record || lastRecord;
    const run = (async () => {
      try {
        return await runExtract(target, options);
      } catch (err) {
        return notifyFailure(errText(err), 0);
      } finally {
        inFlight = null;
      }
    })();
    inFlight = run;
    return run;
  }

  /** 每轮回复结束调用：计数并在达到 everyRounds 时后台触发。 */
  function noteTurnEnd(record) {
    if (record && typeof record === 'object') lastRecord = record;
    roundsSinceExtract += 1;
    const cfg = config();
    if (!cfg.enabled) return;
    if (inFlight) return;
    if (roundsSinceExtract < cfg.everyRounds) return;
    roundsSinceExtract = 0;
    try {
      const pendingRun = extractNow(record || lastRecord);
      if (pendingRun && typeof pendingRun.catch === 'function') {
        pendingRun.catch((err) => log.warn?.('knowledge-extractor: 后台提炼异常:', err && err.message));
      }
    } catch (err) {
      log.warn?.('knowledge-extractor: 触发后台提炼失败:', err && err.message);
    }
  }

  function stats() {
    const cfg = config();
    return {
      enabled: cfg.enabled,
      everyRounds: cfg.everyRounds,
      maxEntries: cfg.maxEntries,
      minConfidence: cfg.minConfidence,
      roundsSinceExtract,
      lastExtractAt,
      lastResult,
      lastError,
      totalExtracted,
      totalPending,
    };
  }

  return { config, extractNow, noteTurnEnd, stats };
}

export default createKnowledgeExtractor;
