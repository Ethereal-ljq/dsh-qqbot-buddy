/**
 * members/profile-extract —— 群友画像自动提炼（专用提示词 + 频率控制 + 提及匹配）。
 *
 * 和「记忆/知识」不同：这里不搬运 MEMORY.md，而是每隔 N 轮把最近群聊交给一个专用 prompt，
 * 让模型输出结构化画像（常见称呼/性格/做过的事/与 bot 的关系好感），再按规则合并：
 * - 只更新**已知群友**（openid 优先，其次昵称/别名精确匹配），不凭空建人；
 * - 每人最多 N 条性格/事迹，字段有长度上限，信息不宜过多；
 * - 同一成员 perMemberHours 内只更新一次；低置信直接丢弃；
 * - 画像写入 members.updateProfile（manual 画像只做并集补充，不会被覆盖）。
 */
const DEFAULT_EXTRACT = Object.freeze({
  enabled: true,
  everyRounds: 6,
  maxMembers: 3,
  minConfidence: 0.7,
  perMemberHours: 2,
  minNewMessages: 12,
  minIntervalMinutes: 10,
  provider: '',
  model: '',
});
const MIN_MESSAGES = 4;
const MAX_TRANSCRIPT_CHARS = 10000;
const LLM_TIMEOUT_MS = 60000;
const MIN_MAX_TOKENS = 600;
const MAX_MAX_TOKENS = 1600;
const MAX_CANDIDATES = 12;
const MAX_NAME_CHARS = 40;
const MAX_NICKNAMES = 4;
const MAX_PERSONALITY = 3;
const MAX_DEEDS = 4;
const MAX_ITEM_CHARS = 60;
const MAX_TAGS = 6;

import { getEvents, extractMessages } from '../context/session-events.js';

const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const strOf = (value) => (typeof value === 'string' ? value.trim() : '');
const errText = (error) => (error instanceof Error ? error.message : String(error));

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

function strList(value, maxItems, maxChars) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[，,;；\n]+/) : [];
  const out = [];
  for (const item of source) {
    const text = strOf(item).replace(/\s+/g, ' ').slice(0, maxChars);
    if (text === '') continue;
    const key = text.normalize('NFKC').toLowerCase();
    if (out.some((existing) => existing.normalize('NFKC').toLowerCase() === key)) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function tailChars(value, max) {
  const text = String(value ?? '');
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  return text.slice(text.length - max);
}

/** 内置提炼提示词模板（UI 可覆盖；支持 {{candidates}}/{{maxMembers}}/{{groupHint}}/{{transcript}} 占位符）。 */
export const PROFILE_PROMPT_TEMPLATE = `你是 QQ 群聊的群友画像整理助手。
任务：从下面的对话里，提炼「这几位已知群友」的结构化画像。
只输出 JSON，不要解释、不要代码围栏。

规则：
1) 只能输出候选列表里的群友（按 openid 对应），不要新建不在列表里的人；
2) 只写「这个群友本人」的信息：nicknames 是别人怎么称呼他/他怎么自称，personality 是性格特点，deeds 是他做过的事；群内通用约定、别人的事、机器人自己的事都不要写进任何人的画像；
3) 每条都短（≤30 字）；personality 最多 3 条，deeds 最多 4 条，nicknames 最多 4 条；
4) affinity 是这个群友和机器人（助手）的关系/好感：level -2..2（-2 警惕、-1 不熟、0 普通、1 亲近、2 很亲近），note ≤30 字；没依据就 level 0、note 留空；
5) 不写隐私（手机号/住址/账号密码）、不猜测、不写一次性闲聊；没有可写内容就返回空数组；
6) 每条给 confidence（0-1），低于 0.7 的不要输出；
7) 只要候选本人在对话里出现（有标签/被称呼），且能看出称呼、性格、说话方式或做过的事，就至少写 1 条，不要整条留空；
8) openid 尽量填候选列表里的值；确实不确定时可以只填 name（系统会按昵称匹配）。

候选群友（openid | 昵称 | 已知称呼）：
{{candidates}}

输出格式：{"members":[{"openid":"候选里的 openid（可空）","name":"昵称","nicknames":["称呼"],"personality":["性格"],"deeds":["做过的事"],"affinity":{"level":0,"note":""},"tags":["标签"],"confidence":0.9}]}
最多输出 {{maxMembers}} 位群友。
{{groupHint}}

【群聊记录开始】
{{transcript}}
【群聊记录结束】`;

function fillTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : match
  ));
}

function candidatesText(candidates) {
  const lines = [];
  for (const member of Array.isArray(candidates) ? candidates.slice(0, MAX_CANDIDATES) : []) {
    const nicknames = Array.isArray(member.nicknames) ? member.nicknames.slice(0, 4).join('、') : '';
    lines.push('- ' + strOf(member.openid) + ' | ' + strOf(member.name) + (nicknames !== '' ? ' | ' + nicknames : ''));
  }
  return lines.join('\n');
}

function buildPrompt({ transcript, candidates, maxMembers, groupHint, template }) {
  const chosen = strOf(template) !== '' ? template : PROFILE_PROMPT_TEMPLATE;
  return fillTemplate(chosen, {
    candidates: candidatesText(candidates),
    maxMembers: maxMembers,
    groupHint: strOf(groupHint) !== '' ? '（当前群：' + strOf(groupHint) + '）' : '',
    transcript: transcript,
  }).trim();
}

export function parseProfileResult(text, { maxMembers = 2 } = {}) {
  const raw = strOf(text);
  if (raw === '') return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  const rows = isObj(parsed) && Array.isArray(parsed.members) ? parsed.members : [];
  const members = [];
  const seen = new Set();
  for (const row of rows) {
    if (!isObj(row)) continue;
    const openid = strOf(row.openid).slice(0, 120);
    const name = strOf(row.name).replace(/\s+/g, ' ').slice(0, MAX_NAME_CHARS);
    if (openid === '' && name === '') continue;
    const key = openid !== '' ? 'openid:' + openid : 'name:' + name;
    if (seen.has(key)) continue;
    seen.add(key);
    const affinitySrc = isObj(row.affinity) ? row.affinity : {};
    const hasAffinity = row.affinity !== undefined && row.affinity !== null;
    members.push({
      openid: openid,
      name: name,
      nicknames: strList(row.nicknames, MAX_NICKNAMES, MAX_NAME_CHARS),
      personality: strList(row.personality, MAX_PERSONALITY, MAX_ITEM_CHARS),
      deeds: strList(row.deeds, MAX_DEEDS, MAX_ITEM_CHARS),
      hasAffinity: hasAffinity,
      affinity: {
        level: clampInt(affinitySrc.level, -2, 2, 0),
        note: strOf(affinitySrc.note).replace(/\s+/g, ' ').slice(0, 60),
      },
      tags: strList(row.tags, MAX_TAGS, 24),
      confidence: clampNum(row.confidence, 0, 1, 0.6),
    });
    if (members.length >= Math.max(1, clampInt(maxMembers, 1, 10, 2))) break;
  }
  return { members };
}

export function createMemberProfileExtractor({ ctx, settings, members, logger, getRoute, getRecord, callModel } = {}) {
  const log = logger || console;
  let roundsSinceExtract = 0;
  let inFlight = false;
  let lastMessageCount = 0;
  let lastExtractAt = 0;
  let lastError = '';
  let lastResult = null;
  let totalUpdated = 0;
  let lastRecord = null;

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
    } catch (error) {
      log.warn?.('member-profile: 读取设置失败，使用默认值:', errText(error));
      return {};
    }
  }

  function config() {
    const snapshot = readSnapshot();
    const memberSection = isObj(snapshot.members) ? snapshot.members : {};
    const raw = memberSection.profileExtract;
    if (raw === true) return { ...DEFAULT_EXTRACT, enabled: true, prompt: '' };
    if (!isObj(raw)) return { ...DEFAULT_EXTRACT };
    return {
      enabled: raw.enabled !== false,
      everyRounds: clampInt(raw.everyRounds, 1, 100, DEFAULT_EXTRACT.everyRounds),
      maxMembers: clampInt(raw.maxMembers, 1, 5, DEFAULT_EXTRACT.maxMembers),
      minConfidence: clampNum(raw.minConfidence, 0, 1, DEFAULT_EXTRACT.minConfidence),
      perMemberHours: clampInt(raw.perMemberHours, 0, 720, DEFAULT_EXTRACT.perMemberHours),
      minNewMessages: clampInt(raw.minNewMessages, 0, 200, DEFAULT_EXTRACT.minNewMessages),
      minIntervalMinutes: clampInt(raw.minIntervalMinutes, 0, 1440, DEFAULT_EXTRACT.minIntervalMinutes),
      provider: strOf(raw.provider),
      model: strOf(raw.model),
      prompt: typeof raw.prompt === 'string' ? raw.prompt.slice(0, 8000) : '',
    };
  }

  function resolveRoute(cfg) {
    let provider = cfg.provider;
    let model = cfg.model;
    if ((provider === '' || model === '') && typeof getRoute === 'function') {
      try {
        const route = getRoute();
        if (isObj(route)) {
          if (provider === '' && strOf(route.provider) !== '') provider = strOf(route.provider);
          if (model === '' && strOf(route.model) !== '') model = strOf(route.model);
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
          if (provider === '' && strOf(selection.provider) !== '') provider = strOf(selection.provider);
          if (model === '' && strOf(selection.model) !== '') model = strOf(selection.model);
        }
      } catch { /* ignore */ }
    }
    return { provider: provider, model: model };
  }

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
      source: { kind: 'plugin', plugin: 'dsh-qqbot-buddy:member-profile' },
    });
    const assembler = new BlockAssembler();
    let finishReason;
    const stream = llm.stream({ provider: route.provider, model: route.model, messages: [message], maxTokens, signal });
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
    return blocks.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').trim();
  }

  function statsPrompt() {
    const cfg = config();
    return {
      default: PROFILE_PROMPT_TEMPLATE,
      override: cfg.prompt,
      resolved: cfg.prompt !== '' ? cfg.prompt : PROFILE_PROMPT_TEMPLATE,
      placeholders: ['{{candidates}}', '{{maxMembers}}', '{{groupHint}}', '{{transcript}}'],
    };
  }

  function notifyFailure(message, scannedMessages) {
    lastError = message;
    lastResult = { ok: false, error: message, at: new Date().toISOString(), scannedMessages: scannedMessages || 0, updated: 0 };
    log.warn?.('member-profile: 画像提炼失败:', message);
    return { ok: false, error: message, updated: [], skipped: [], scannedMessages: scannedMessages || 0 };
  }

  /**
   * 懒加载候选：优先取「这段消息里真正出现过的人」——
   * 1) [昵称 (openid)] 标签（群里每条消息都带，用 openid 精确匹配，最可靠）；
   * 2) 昵称/别名出现在文本里的人；
   * 3) 不够 3 个时，补当前群最近活跃的群友（让模型有机会覆盖到）。
   */
  function collectCandidates(transcript, groupId) {
    if (!members || typeof members.list !== 'function') return [];
    let items = [];
    try {
      const listed = members.list({ groupId: groupId, limit: 200 });
      items = Array.isArray(listed && listed.items) ? listed.items : [];
    } catch (error) {
      log.warn?.('member-profile: 读取群友库失败:', errText(error));
      return [];
    }
    const matched = [];
    const seen = new Set();
    const add = (item) => {
      if (!item || !item.id || seen.has(item.id)) return;
      seen.add(item.id);
      matched.push({
        openid: strOf(item.openid),
        name: strOf(item.name),
        nicknames: Array.isArray(item.profile && item.profile.nicknames) ? item.profile.nicknames : [],
      });
    };
    const byOpenid = new Map();
    const byKey = new Map();
    const keysOf = (item) => [strOf(item.name), ...(Array.isArray(item.aliases) ? item.aliases : []), ...(Array.isArray(item.profile && item.profile.nicknames) ? item.profile.nicknames : [])]
      .map((text) => strOf(text).normalize('NFKC').toLowerCase())
      .filter((key) => key !== '');
    for (const item of items) {
      const openid = strOf(item.openid);
      if (openid !== '') byOpenid.set(openid, item);
      for (const key of keysOf(item)) if (!byKey.has(key)) byKey.set(key, item);
    }
    // 1) 消息里的 [昵称 (openid)] 标签
    const labelRe = /\[([^\[\]()]{1,40})\s*\(([A-Za-z0-9_-]{6,120})\)\]/g;
    let label;
    while ((label = labelRe.exec(transcript)) !== null) {
      const openid = label[2];
      const item = byOpenid.get(openid) || byKey.get(strOf(label[1]).normalize('NFKC').toLowerCase());
      if (item) add(item);
    }
    // 2) 文本里出现的昵称/别名
    for (const item of items) {
      const keys = keysOf(item).filter((key) => key.length >= 2);
      if (keys.some((key) => transcript.normalize('NFKC').toLowerCase().includes(key))) add(item);
    }
    // 3) 补最近活跃的（当前群）
    if (matched.length < 3) {
      const sorted = items.slice().sort((a, b) => (Date.parse(b.lastSeenAt || '') || 0) - (Date.parse(a.lastSeenAt || '') || 0));
      for (const item of sorted) {
        if (matched.length >= 6) break;
        add(item);
      }
    }
    return matched.slice(0, MAX_CANDIDATES);
  }

  function resolveMember(row, groupId) {
    if (!members) return null;
    if (typeof members.getByOpenid === 'function' && row.openid !== '') {
      const found = members.getByOpenid(row.openid);
      if (found) {
        if (groupId !== '') {
          const groups = found.meta && found.meta.groups && typeof found.meta.groups === 'object' ? found.meta.groups : {};
          if (!groups[groupId]) return null;
        }
        return found;
      }
    }
    if (typeof members.list !== 'function') return null;
    let items = [];
    try {
      items = members.list({ groupId: groupId, limit: 200 }).items || [];
    } catch { items = []; }
    const wanted = normalizeKey(row.name);
    for (const item of items) {
      const keys = [item.name, ...(Array.isArray(item.aliases) ? item.aliases : []), ...(Array.isArray(item.profile && item.profile.nicknames) ? item.profile.nicknames : [])]
        .map(normalizeKey);
      if (keys.includes(wanted)) return members.get(item.id);
    }
    return null;
  }

  function normalizeKey(text) {
    return strOf(text).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  }

  async function runExtract(record, options = {}) {
    const cfg = config();
    if (!cfg.enabled) return notifyFailure('群友画像提炼未开启', 0);
    if (!members || typeof members.updateProfile !== 'function') return notifyFailure('群友库不可用', 0);
    let transcript = strOf(options.transcript);
    let scannedMessages = 0;
    if (transcript === '') {
      // 手动「立即提炼」留空时 record 为 null：退回最近一次会话，否则永远拿不到消息
      const fallbackRecord = record || lastRecord || (typeof getRecord === 'function' ? getRecord() : null);
      const messages = extractMessages(getEvents(fallbackRecord));
      scannedMessages = messages.length;
      if (messages.length < MIN_MESSAGES) return notifyFailure('消息太少（至少 ' + MIN_MESSAGES + ' 条）', scannedMessages);
      transcript = messages
        .slice(-Math.max(MIN_MESSAGES, cfg.everyRounds * 2))
        .map((message) => (message.role === 'user' ? '用户' : '助手') + ': ' + message.text)
        .join('\n');
      if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = tailChars(transcript, MAX_TRANSCRIPT_CHARS);
    }
    const groupId = strOf(options.groupId);
    const candidates = collectCandidates(transcript, groupId);
    const manual = options.manual === true || strOf(options.transcript) !== '';
    const maxRows = manual ? Math.min(8, Math.max(cfg.maxMembers, candidates.length)) : cfg.maxMembers;
    if (candidates.length === 0) {
      lastError = '';
      lastResult = { ok: true, at: new Date().toISOString(), scannedMessages, updated: 0, candidates: 0, note: '没有匹配到已知群友' };
      return { ok: true, updated: [], skipped: [], scannedMessages, candidates: 0 };
    }
    const route = resolveRoute(cfg);
    if (route.provider === '' || route.model === '') return notifyFailure('未配置可用的提炼模型', scannedMessages);
    const prompt = buildPrompt({
      transcript,
      candidates,
      maxMembers: maxRows,
      groupHint: strOf(options.groupHint),
      template: cfg.prompt,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    timer.unref?.();
    let modelText = '';
    try {
      const invoke = typeof callModel === 'function' ? callModel : defaultCallModel;
      modelText = await invoke({ prompt, maxTokens: MAX_MAX_TOKENS, route, signal: controller.signal });
    } catch (error) {
      return notifyFailure('模型调用失败: ' + errText(error), scannedMessages);
    } finally {
      clearTimeout(timer);
    }
    const parsed = parseProfileResult(modelText, { maxMembers: maxRows });
    if (parsed === null) return notifyFailure('模型返回的 JSON 无法解析', scannedMessages);

    const updated = [];
    const skipped = [];
    for (const row of parsed.members) {
      if (row.confidence < cfg.minConfidence) {
        skipped.push({ name: row.name, reason: 'low-confidence' });
        continue;
      }
      const existing = resolveMember(row, groupId);
      if (!existing) {
        skipped.push({ name: row.name, reason: 'not-found' });
        continue;
      }
      const profile = existing.meta && existing.meta.profile && typeof existing.meta.profile === 'object' ? existing.meta.profile : {};
      const updatedAt = Date.parse(strOf(existing.meta && existing.meta.profileUpdatedAt));
      if (cfg.perMemberHours > 0 && Number.isFinite(updatedAt) && Date.now() - updatedAt < cfg.perMemberHours * 3600 * 1000) {
        skipped.push({ name: row.name, reason: 'throttled' });
        continue;
      }
      try {
        const result = members.updateProfile(existing.id, {
          profile: {
            nicknames: row.nicknames,
            personality: row.personality,
            deeds: row.deeds,
            affinity: row.hasAffinity ? row.affinity : undefined,
          },
          tags: row.tags,
          source: 'auto',
        });
        if (result && result.ok === true) updated.push({ id: existing.id, name: existing.title, profile: profile });
        else skipped.push({ name: row.name, reason: (result && result.reason) || 'update-failed' });
      } catch (error) {
        skipped.push({ name: row.name, reason: 'error:' + errText(error) });
      }
    }
    lastExtractAt = Date.now();
    lastError = '';
    lastResult = {
      ok: true,
      at: new Date(lastExtractAt).toISOString(),
      scannedMessages,
      candidates: candidates.length,
      updated: updated.length,
      skipped: skipped.length,
    };
    totalUpdated += updated.length;
    if (updated.length > 0) {
      log.info?.('member-profile: 画像更新 ' + updated.map((row) => row.name).join('、') + '（扫描 ' + scannedMessages + ' 条消息）');
    }
    return {
      ok: true,
      updated,
      skipped,
      scannedMessages,
      candidates: candidates.map((row) => row.name),
      maxRows,
    };
  }

  function extractNow(record, options = {}) {
    if (inFlight) return Promise.resolve({ ok: false, skipped: true, reason: 'busy' });
    inFlight = true;
    const task = (async () => {
      try {
        return await runExtract(record, options);
      } catch (error) {
        return notifyFailure('提炼异常: ' + errText(error), 0);
      } finally {
        inFlight = false;
      }
    })();
    return task;
  }

  function noteTurnEnd(record) {
    if (record && typeof record === 'object') lastRecord = record;
    roundsSinceExtract += 1;
    const cfg = config();
    if (!cfg.enabled) return;
    if (inFlight) return;
    // 双条件触发：够 N 轮，或者这段会话里新增了足够多的群消息（群聊很活跃时不必等轮次）
    const messages = extractMessages(getEvents(record)).length;
    const grew = messages - lastMessageCount;
    const dueRounds = roundsSinceExtract >= cfg.everyRounds;
    const dueMessages = cfg.minNewMessages > 0
      && grew >= cfg.minNewMessages
      && roundsSinceExtract >= 2
      && (lastExtractAt === 0 || Date.now() - lastExtractAt >= cfg.minIntervalMinutes * 60 * 1000);
    if (!dueRounds && !dueMessages) return;
    roundsSinceExtract = 0;
    lastMessageCount = messages;
    try {
      const task = extractNow(record || lastRecord);
      if (task && typeof task.catch === 'function') task.catch((error) => log.warn?.('member-profile: 后台提炼异常:', errText(error)));
    } catch (error) {
      log.warn?.('member-profile: 触发后台提炼失败:', errText(error));
    }
  }

  function stats() {
    const cfg = config();
    return {
      enabled: cfg.enabled,
      everyRounds: cfg.everyRounds,
      maxMembers: cfg.maxMembers,
      minConfidence: cfg.minConfidence,
      perMemberHours: cfg.perMemberHours,
      roundsSinceExtract: roundsSinceExtract,
      lastExtractAt: lastExtractAt,
      lastResult: lastResult,
      lastError: lastError,
      totalUpdated: totalUpdated,
      prompt: statsPrompt(),
    };
  }

  return { config, extractNow, noteTurnEnd, stats };
}

export default createMemberProfileExtractor;
