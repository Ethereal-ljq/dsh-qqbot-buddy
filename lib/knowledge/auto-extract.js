/**
 * knowledge/auto-extract —— 知识与群友备注自动提炼（阶段二：群友备注只补充、不覆盖人工备注）。
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
/** 群友备注自动提炼默认值（阶段二；只补充、不覆盖人工备注） */
const DEFAULT_MEMBERS_EXTRACT = Object.freeze({
  enabled: false,
  maxNotes: 2,
  minConfidence: 0.8,
});
const MAX_MEMBER_ALIASES = 4;
const MAX_MEMBER_NOTE_CHARS = 500;
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

/** 构造提炼 prompt（知识 + 群友备注两类输出）。 */
/** 内置提炼提示词模板（UI 可覆盖；支持 {{maxEntries}}/{{maxMembers}}/{{groupHint}}/{{transcript}}/{{memberSection}}）。 */
export const KNOWLEDGE_PROMPT_TEMPLATE = `你是 QQ 群聊信息整理助手。下面是一段群聊（user=群友/用户，assistant=机器人）。
请从里面提炼值得长期保留的信息。只输出一个 JSON 对象，不要解释、不要代码围栏。

【知识库】可以记录：群规/约定、长期活动安排、FAQ、重要决定/结论、群梗。
不要记录：寒暄、一次性闲聊、临时话题、隐私信息、密钥。
knowledge 条目格式：{"title":"不超过30字","body":"1-3句具体可执行","tags":["中文标签"],"importance":0-3,"confidence":0-1,"scope":"group"}
最多 {{maxEntries}} 条，宁少勿多；同一条不要重复。
{{memberSection}}
输出格式（严格 JSON）：{"knowledge":[...],"members":[...]，未涉及的数组返回 []}
{{groupHint}}

【群聊记录开始】
{{transcript}}
【群聊记录结束】`;

function fillTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : match
  ));
}

function buildPrompt({ transcript, maxEntries, maxMembers, wantKnowledge, wantMembers, groupHint, template }) {
  const memberSection = wantMembers
    ? [
      '【群友备注】可以记录群聊里明确透露的、长期有效的群友信息：称呼/别名、身份职业、长期偏好、固定约定、忌讳。',
      '不要记录：隐私（手机号/住址/身份证/账号密码）、猜测、一次性的情绪或玩笑；只写能从对话里确认的内容。',
      'members 条目格式：{"name":"群昵称","openid":"消息里 [昵称 (openid)] 的 openid，没有就留空","aliases":["别名"],"tags":["标签"],"note":"1-2句事实，不要主观评价","confidence":0-1}',
      '最多 ' + maxMembers + ' 条；只列在这段对话里出现过的群友。',
    ].join('\n')
    : '';
  const chosen = asString(template).trim() !== '' ? template : KNOWLEDGE_PROMPT_TEMPLATE;
  return fillTemplate(chosen, {
    maxEntries: maxEntries,
    maxMembers: maxMembers,
    groupHint: asString(groupHint) !== '' ? '（当前会话：' + asString(groupHint) + '）' : '',
    transcript: transcript,
    memberSection: memberSection,
  }).trim();
}

/** 从模型输出里抽取 JSON，并分别校验知识条目与群友备注。解析失败返回 null。 */
export function parseExtractedResult(text, { maxEntries = 3, maxMembers = 2 } = {}) {
  const raw = asString(text).trim();
  if (raw === '') return null;
  const cleaned = raw.replace(/^\uFEFF/, '');
  const fenced = cleaned.match(/\u0060\u0060\u0060(?:json)?\s*([\s\S]*?)\u0060\u0060\u0060/i);
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
  const knowledgeRows = Array.isArray(parsed) ? parsed : (isObj(parsed) && Array.isArray(parsed.knowledge) ? parsed.knowledge : []);
  const memberRows = isObj(parsed) && Array.isArray(parsed.members) ? parsed.members : [];

  const knowledge = [];
  const seenKnowledge = new Set();
  for (const row of knowledgeRows) {
    if (!isObj(row)) continue;
    const title = clampChars(asString(row.title).replace(/\s+/g, ' ').trim(), MAX_TITLE_CHARS);
    const body = clampChars(asString(row.body).trim(), MAX_BODY_CHARS);
    if (title === '' || body === '') continue;
    const key = normalizeForCompare(title);
    if (seenKnowledge.has(key)) continue;
    seenKnowledge.add(key);
    const tags = [];
    for (const tag of Array.isArray(row.tags) ? row.tags : []) {
      const value = clampChars(asString(tag).replace(/[\s,，;；#]+/g, '-').replace(/^-+|-+$/g, ''), MAX_TAG_CHARS);
      if (value === '' || tags.includes(value)) continue;
      tags.push(value);
      if (tags.length >= MAX_TAGS) break;
    }
    knowledge.push({
      title,
      body,
      tags,
      importance: clampInt(row.importance, 0, 3, 1),
      confidence: clampNum(row.confidence, 0, 1, 0.6),
      scope: asString(row.scope) === 'global' ? 'global' : 'group',
    });
    if (knowledge.length >= Math.max(1, clampInt(maxEntries, 1, 10, 3))) break;
  }

  const members = [];
  const seenMembers = new Set();
  for (const row of memberRows) {
    if (!isObj(row)) continue;
    const name = clampChars(asString(row.name).replace(/\s+/g, ' ').trim(), MAX_TITLE_CHARS);
    const note = clampChars(asString(row.note).replace(/\s+/g, ' ').trim(), MAX_MEMBER_NOTE_CHARS);
    if (name === '' || note === '') continue;
    const openid = asString(row.openid).trim().slice(0, 120);
    const key = normalizeForCompare(openid !== '' ? 'openid:' + openid : 'name:' + name);
    if (seenMembers.has(key)) continue;
    seenMembers.add(key);
    const aliases = [];
    for (const alias of Array.isArray(row.aliases) ? row.aliases : []) {
      const value = clampChars(asString(alias).trim(), MAX_TAG_CHARS);
      if (value === '' || aliases.includes(value)) continue;
      aliases.push(value);
      if (aliases.length >= MAX_MEMBER_ALIASES) break;
    }
    const tags = [];
    for (const tag of Array.isArray(row.tags) ? row.tags : []) {
      const value = clampChars(asString(tag).replace(/[\s,，;；#]+/g, '-').replace(/^-+|-+$/g, ''), MAX_TAG_CHARS);
      if (value === '' || tags.includes(value)) continue;
      tags.push(value);
      if (tags.length >= MAX_TAGS) break;
    }
    members.push({ name, openid, aliases, tags, note, confidence: clampNum(row.confidence, 0, 1, 0.6) });
    if (members.length >= Math.max(1, clampInt(maxMembers, 1, 10, 2))) break;
  }

  return { knowledge, members };
}

/** 兼容入口：只取知识条目。 */
export function parseExtractedKnowledge(text, options = {}) {
  const parsed = parseExtractedResult(text, options);
  return parsed === null ? null : parsed.knowledge;
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
export function createKnowledgeExtractor({ ctx, settings, knowledge, members, logger, getRoute, getRecord, callModel } = {}) {
  const log = logger || console;
  let roundsSinceExtract = 0;
  let lastRecord = null;
  let inFlight = null;
  let lastExtractAt = 0;
  let lastResult = null;
  let lastError = '';
  let totalExtracted = 0;
  let totalPending = 0;
  let totalMemberNotes = 0;

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
    const knowledgeSection = isObj(snapshot.knowledge) ? snapshot.knowledge : {};
    const kRaw = knowledgeSection.autoExtract;
    let knowledgeCfg = { ...DEFAULT_EXTRACT };
    if (kRaw === true) knowledgeCfg = { ...knowledgeCfg, enabled: true, prompt: '' };
    else if (isObj(kRaw)) {
      knowledgeCfg = {
        enabled: kRaw.enabled === true,
        everyRounds: clampInt(kRaw.everyRounds, 1, 100, DEFAULT_EXTRACT.everyRounds),
        maxEntries: clampInt(kRaw.maxEntries, 1, 10, DEFAULT_EXTRACT.maxEntries),
        minConfidence: clampNum(kRaw.minConfidence, 0, 1, DEFAULT_EXTRACT.minConfidence),
        provider: asString(kRaw.provider).trim(),
        model: asString(kRaw.model).trim(),
      };
    }
    const membersSection = isObj(snapshot.members) ? snapshot.members : {};
    const mRaw = membersSection.autoExtract;
    let membersCfg = { ...DEFAULT_MEMBERS_EXTRACT };
    if (mRaw === true) membersCfg.enabled = true;
    else if (isObj(mRaw)) {
      membersCfg = {
        enabled: mRaw.enabled === true,
        maxNotes: clampInt(mRaw.maxNotes, 1, 10, DEFAULT_MEMBERS_EXTRACT.maxNotes),
        minConfidence: clampNum(mRaw.minConfidence, 0, 1, DEFAULT_MEMBERS_EXTRACT.minConfidence),
      };
    }
    return {
      ...knowledgeCfg,
      enabled: knowledgeCfg.enabled || membersCfg.enabled,
      knowledge: knowledgeCfg,
      members: membersCfg,
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
    lastResult = { ok: false, error: message, at: nowIso(), scannedMessages: scannedMessages || 0, added: 0, pending: 0, membersUpdated: 0 };
    log.warn?.('knowledge-extractor: 自动提炼失败:', message);
    return { ok: false, error: message, added: [], pending: [], merged: [], membersUpdated: [], scannedMessages: scannedMessages || 0 };
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
  /** 在成员库里定位本条备注对应的成员：openid 优先，其次同名/别名（限当前群）。 */
  function findMemberForRow(row, groupId) {
    if (!members || typeof members.get !== 'function') return null;
    const openid = asString(row.openid);
    if (openid !== '' && typeof members.getByOpenid === 'function') {
      const found = members.getByOpenid(openid);
      if (found) {
        const groups = found.meta && found.meta.groups && typeof found.meta.groups === 'object' ? found.meta.groups : {};
        if (groupId !== '' && !groups[groupId]) return null;
        return found;
      }
    }
    const wanted = normalizeForCompare(row.name);
    if (wanted === '') return null;
    let listed = null;
    try { listed = members.list({ q: row.name, groupId: groupId, limit: 10 }); } catch { listed = null; }
    const items = listed && Array.isArray(listed.items) ? listed.items : [];
    for (const item of items) {
      const names = [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])].map(normalizeForCompare);
      if (!names.includes(wanted)) continue;
      const entry = members.get(item.id);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * 真正跑一次提炼。
   * @param {object|null} record 会话 record（可空：用 transcript 试跑）
   * @param {{transcript?: string, groupHint?: string, scope?: string, groupId?: string}} [options]
   */
  async function runExtract(record, options = {}) {
    const cfg = config();
    const kCfg = cfg.knowledge;
    const mCfg = cfg.members;
    const wantKnowledge = kCfg.enabled && knowledge && knowledge.available !== false;
    const wantMembers = mCfg.enabled && members && typeof members.applyAutoNote === 'function';
    if (!wantKnowledge && !wantMembers) return notifyFailure('自动提炼未开启（知识或群友备注）', 0);

    let transcript = asString(options.transcript).trim();
    let scannedMessages = 0;
    if (transcript === '') {
      // 手动「立即提炼」留空时 record 为 null：退回最近一次会话
      const fallbackRecord = record || lastRecord || (typeof getRecord === 'function' ? getRecord() : null);
      const events = getEvents(fallbackRecord);
      const messages = extractMessages(events);
      scannedMessages = messages.length;
      if (messages.length === 0) return notifyFailure('没有可提炼的消息', 0);
      if (messages.length < MIN_MESSAGES) return notifyFailure('消息太少（至少 ' + MIN_MESSAGES + ' 条）', scannedMessages);
      transcript = messages
        .slice(-Math.max(MIN_MESSAGES, kCfg.everyRounds * 2))
        .map((message) => (message.role === 'user' ? '用户' : '助手') + ': ' + message.text)
        .join('\n');
      if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = tailChars(transcript, MAX_TRANSCRIPT_CHARS);
    }

    const route = resolveRoute(kCfg);
    if (route.provider === '' || route.model === '') {
      return notifyFailure('未配置可用的提炼模型（autoExtract.provider/model 为空且无默认模型）', scannedMessages);
    }

    const prompt = buildPrompt({
      transcript,
      maxEntries: kCfg.maxEntries,
      maxMembers: mCfg.maxNotes,
      wantKnowledge,
      wantMembers,
      groupHint: asString(options.groupHint),
      template: kCfg.prompt,
    });
    const maxTokens = Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, kCfg.maxEntries * 320 + mCfg.maxNotes * 240 + 500));
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

    const parsed = parseExtractedResult(modelText, { maxEntries: kCfg.maxEntries, maxMembers: mCfg.maxNotes });
    if (parsed === null) return notifyFailure('模型返回的 JSON 无法解析', scannedMessages);

    const requestedScope = asString(options.scope);
    const scope = requestedScope === 'global' || requestedScope === 'group' || requestedScope === 'c2c'
      ? requestedScope
      : (record && record.scope === 'group' ? 'group' : (record ? 'c2c' : 'global'));
    const groupId = asString(options.groupId) || (record && scope === 'group' ? asString(record.peerId) : '');
    const groupName = asString(options.groupHint);

    const added = [];
    const pending = [];
    const merged = [];
    const membersUpdated = [];
    const membersSkipped = [];

    if (wantKnowledge) {
      for (const row of parsed.knowledge) {
        const status = row.confidence >= kCfg.minConfidence ? 'approved' : 'pending';
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
    }

    if (wantMembers) {
      for (const row of parsed.members) {
        if (row.confidence < mCfg.minConfidence) {
          membersSkipped.push({ name: row.name, reason: 'low-confidence' });
          continue;
        }
        const existing = findMemberForRow(row, groupId);
        if (!existing) {
          membersSkipped.push({ name: row.name, reason: 'not-found' });
          continue;
        }
        try {
          const applied = members.applyAutoNote({
            id: existing.id,
            note: row.note,
            tags: row.tags,
            confidence: row.confidence,
            at: nowIso(),
          });
          if (applied && applied.ok === true && applied.mode !== 'skipped') {
            membersUpdated.push({ id: existing.id, name: existing.title, mode: applied.mode });
            totalMemberNotes += 1;
          } else if (applied && applied.mode === 'skipped') {
            membersSkipped.push({ name: row.name, reason: applied.reason || 'no-change' });
          }
        } catch (err) {
          log.warn?.('knowledge-extractor: 更新群友备注失败:', err && err.message);
        }
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
      membersUpdated: membersUpdated.length,
    };
    if (added.length > 0 || pending.length > 0 || merged.length > 0 || membersUpdated.length > 0) {
      log.info?.('knowledge-extractor: 自动提炼完成（新增 ' + added.length + ' / 待确认 ' + pending.length
        + ' / 合并 ' + merged.length + ' / 群友备注 ' + membersUpdated.length + '，扫描 ' + scannedMessages + ' 条消息）');
    }
    return { ok: true, added, pending, merged, membersUpdated, membersSkipped, scannedMessages, route };
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
    const every = clampInt(cfg.knowledge.everyRounds, 1, 100, 6);
    if (roundsSinceExtract < every) return;
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
      everyRounds: cfg.knowledge.everyRounds,
      maxEntries: cfg.knowledge.maxEntries,
      minConfidence: cfg.knowledge.minConfidence,
      knowledge: { ...cfg.knowledge },
      members: { ...cfg.members },
      roundsSinceExtract,
      lastExtractAt,
      lastResult,
      lastError,
      totalExtracted,
      totalPending,
      totalMemberNotes,
      prompt: (function () {
        const cfg = config();
        return {
          default: KNOWLEDGE_PROMPT_TEMPLATE,
          override: cfg.knowledge.prompt || '',
          resolved: cfg.knowledge.prompt !== '' ? cfg.knowledge.prompt : KNOWLEDGE_PROMPT_TEMPLATE,
          placeholders: ['{{maxEntries}}', '{{maxMembers}}', '{{groupHint}}', '{{transcript}}', '{{memberSection}}'],
        };
      })(),
    };
  }

  return { config, extractNow, noteTurnEnd, stats };
}

export default createKnowledgeExtractor;
