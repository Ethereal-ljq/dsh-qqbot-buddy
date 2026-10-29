/**
 * memory/collector —— 自动记忆提炼（LLM 从最近对话中抽取长期事实并写入 memoryStore）。
 *
 * 数据流：
 *   turn/end → outbound 调 noteTurnEnd(record) → 每 everyRounds 轮后台 collectNow()
 *     → 取 record 里 user/assistant 消息 → llm.stream() + BlockAssembler 收文本
 *     → 容忍 markdown 代码块/多余文字的 JSON 解析 → 逐条 memoryStore.saveFact()
 *
 * 健壮性约定：
 * - collectNow 永不 reject（内部全部 try/catch），失败只记 logger.warn/error + stats.lastError，
 *   绝不影响 QQ 回复链路；
 * - 同一时刻只允许一个提炼在跑（in-flight 锁），并发触发直接返回 skipped；
 * - 宿主依赖 @deepseek-ai/dsh-llm 采用惰性动态 import：部署环境正常解析；
 *   开发仓库没有 node_modules 时回退到本文件内最小实现（仅供测试/预览，不参与生产）。
 */
/** 送入模型的消息条数下限（DESIGN 的 2*everyRounds 与任务要求的“最近 40 条”取较大者） */
const MIN_MESSAGES = 40;
/** 送入模型的对话摘录字符上限 */
import { buildCollectorPrompt } from '../self-improve.js';

const MAX_TRANSCRIPT_CHARS = 12000;
/** 单次提炼的模型调用超时（毫秒），防止 in-flight 锁永久占用 */
const LLM_TIMEOUT_MS = 60_000;
/** 单次提炼的 maxTokens 预算区间（按 maxFacts 估算，防止长事实被输出上限截断） */
const MIN_MAX_TOKENS = 1024;
const MAX_MAX_TOKENS = 4096;

// ── 宿主依赖的最小回退实现（仅当 @deepseek-ai/dsh-llm 无法解析时使用） ──
let fallbackId = 0;

/** 回退版 createUserMessage（真实模块不可用时的替身，字段与官方保持一致） */
function fallbackCreateUserMessage(input) {
  fallbackId += 1;
  return {
    id: `fallback-user-${Date.now()}-${fallbackId}`,
    role: 'user',
    content: Array.isArray(input?.content) ? input.content : [],
    source: input?.source ?? { kind: 'user' },
  };
}

/** 回退版 BlockAssembler：只实现本模块用到的 text-delta/block-end/finish 语义 */
class FallbackBlockAssembler {
  constructor() {
    this.parts = new Map();
    this.order = [];
    this.finishReason = undefined;
  }

  ensure(index, type) {
    let part = this.parts.get(index);
    if (!part) {
      part = { type, text: '', block: undefined };
      this.parts.set(index, part);
      this.order.push(index);
    }
    return part;
  }

  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return;
    switch (chunk.type) {
      case 'block-start':
        this.ensure(chunk.index, chunk.blockType);
        return;
      case 'text-delta': {
        const part = this.ensure(chunk.index, 'text');
        if (!part.block) part.text += String(chunk.text ?? '');
        return;
      }
      case 'reasoning-delta':
        this.ensure(chunk.index, 'reasoning');
        return;
      case 'tool-call-delta':
        this.ensure(chunk.index, 'tool-call');
        return;
      case 'block-end': {
        const part = this.ensure(chunk.index, chunk.block?.type ?? 'text');
        if (chunk.block) part.block = chunk.block;
        return;
      }
      case 'finish':
        this.finishReason = chunk.reason;
        return;
      default:
        return;
    }
  }

  blocks() {
    return this.order.map((index) => {
      const part = this.parts.get(index);
      if (!part) return { type: 'text', text: '' };
      if (part.block) return part.block;
      return { type: part.type, text: part.text };
    });
  }
}

const FALLBACK_LLM_MODULE = Object.freeze({
  createUserMessage: fallbackCreateUserMessage,
  BlockAssembler: FallbackBlockAssembler,
});

/** 宿主 LLM 模块的惰性加载缓存（跨 collector 实例共享） */
let llmModulePromise;

/**
 * 加载 @deepseek-ai/dsh-llm。
 * @param {object} [injected] 测试/预览注入的替代模块
 */
async function loadLlmModule(injected) {
  if (injected && typeof injected === 'object') return injected;
  if (llmModulePromise !== undefined) return llmModulePromise;
  llmModulePromise = import('@deepseek-ai/dsh-llm')
    .then((mod) => mod)
    .catch(() => FALLBACK_LLM_MODULE);
  return llmModulePromise;
}

// ── 配置小工具 ────────────────────────────────────────────────
function intOr(value, def, min, max) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 取字符串尾部 <=max 字符，且不切开代理对 */
function tailChars(text, max) {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  let start = text.length - max;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

/** 把消息内容块里的文本拼起来（忽略图片/工具调用等非文本块） */
function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * 从 record 中取 session 事件数组。
 * 不同宿主版本/装配方式下 record 形状略有差异，这里做兼容探测：
 *   record.session.events / record.agent.session.events / record.events
 *   events 可能是数组、getter 函数，或 session 只提供 snapshotEvents()。
 */
function getEvents(record) {
  if (!record || typeof record !== 'object') return [];
  const safeGet = (target, key) => {
    if (!target || typeof target !== 'object') return undefined;
    try {
      return target[key];
    } catch { /* getter 抛错时视为不可用 */ }
    return undefined;
  };
  const sessions = [];
  const directSession = safeGet(record, 'session');
  if (directSession && typeof directSession === 'object') sessions.push(directSession);
  const agent = safeGet(record, 'agent');
  const agentSession = safeGet(agent, 'session');
  if (agentSession && typeof agentSession === 'object') sessions.push(agentSession);

  const readCandidate = (candidate, receiver) => {
    if (Array.isArray(candidate)) return candidate;
    if (typeof candidate === 'function') {
      try {
        const value = candidate.call(receiver);
        if (Array.isArray(value)) return value;
      } catch { /* 忽略，尝试下一个来源 */ }
    }
    return undefined;
  };

  const direct = readCandidate(safeGet(record, 'events'), record);
  if (direct) return direct;
  for (const session of sessions) {
    const events = readCandidate(session.events, session);
    if (events) return events;
  }
  for (const session of sessions) {
    const events = readSessionEvents(session);
    if (events) return events;
  }
  // 有些宿主把 Session 本体直接传给回调：record 自身即 Session
  const selfEvents = readSessionEvents(record);
  if (selfEvents) return selfEvents;
  return [];
}

/** 从 Session 对象上读取事件数组（snapshotEvents() 优先，兼容 .events / .log） */
function readSessionEvents(session) {
  if (!session || typeof session !== 'object') return undefined;
  const direct = Array.isArray(session.events) ? session.events : undefined;
  if (direct) return direct;
  if (typeof session.events === 'function') {
    try {
      const value = session.events();
      if (Array.isArray(value)) return value;
    } catch { /* 忽略 */ }
  }
  if (typeof session.snapshotEvents === 'function') {
    try {
      const value = session.snapshotEvents();
      if (Array.isArray(value)) return value;
    } catch { /* 忽略 */ }
  }
  if (Array.isArray(session.log)) return session.log;
  return undefined;
}

/** 从事件数组中提取 user/assistant 消息文本 */
function extractMessages(events) {
  const messages = [];
  if (!Array.isArray(events)) return messages;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    const data = event.data;
    const message = data && typeof data === 'object' && data.message ? data.message : data;
    if (!message || typeof message !== 'object') continue;
    const text = blocksToText(message.content);
    if (text === '') continue;
    messages.push({ role: event.type === 'user/message' ? 'user' : 'assistant', text });
  }
  return messages;
}

/** 解析模型输出中的 JSON（容忍 markdown 代码块与前后多余文字） */
function parseFacts(text, maxFacts, maxFactChars) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1]);
  candidates.push(text);
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) candidates.push(text.slice(objStart, objEnd + 1));
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(text.slice(arrStart, arrEnd + 1));

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray(parsed.facts)
        ? parsed.facts
        : null;
    if (!list) continue;

    const facts = [];
    for (const item of list) {
      if (facts.length >= maxFacts) break;
      let textValue = '';
      let tags = [];
      let importance = 'normal';
      if (typeof item === 'string') {
        textValue = item;
      } else if (item && typeof item === 'object') {
        if (typeof item.text === 'string') textValue = item.text;
        if (Array.isArray(item.tags)) {
          tags = item.tags.filter((tag) => typeof tag === 'string').slice(0, 8);
        }
        if (item.importance === 'high') importance = 'high';
      }
      textValue = textValue.replace(/\s+/g, ' ').trim();
      if (textValue === '') continue;
      if (textValue.length > maxFactChars) textValue = [...textValue].slice(0, maxFactChars).join('');
      facts.push({ text: textValue, tags, importance });
    }
    return facts;
  }
  return null;
}

/**
 * 创建自动记忆提炼器。
 * @param {{
 *   ctx: object,
 *   settings: {get: () => any},
 *   memoryStore: {saveFact: (input: any) => any},
 *   logger?: any,
 *   getRoute?: () => any,
 *   onStats?: (stats: any) => void,
 *   llmModule?: object, // 可选：测试注入的 {createUserMessage, BlockAssembler}
 * }} options
 */
export function createCollector({ ctx, settings, memoryStore, logger, getRoute, onStats, llmModule } = {}) {
  const log = logger ?? console;

  let lastRecord = null;
  let roundsSinceCollect = 0;
  let lastCollectAt = 0;
  let lastResult = null;
  let lastError = '';
  let totalCollected = 0;
  /** 当前正在跑的提炼 Promise；非 null 表示有提炼在跑 */
  let inFlight = null;

  /** 读取 memory 配置段（每次读取，设置页改动立即生效） */
  function readCfg() {
    try {
      const s = typeof settings?.get === 'function' ? settings.get() : {};
      return s && typeof s.memory === 'object' && s.memory !== null ? s.memory : {};
    } catch (err) {
      log.warn?.('collector: 读取 memory 设置失败:', err && err.message);
      return {};
    }
  }

  /** 自动提炼是否开启（memory 总开关 + autoCollect 开关） */
  function isEnabled(cfg) {
    const auto = cfg && cfg.autoCollect && typeof cfg.autoCollect === 'object' ? cfg.autoCollect : {};
    return cfg?.enabled === true && auto.enabled === true;
  }

  /** 安全取宿主服务 */
  function getService(name) {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
    } catch (err) {
      log.warn?.(`collector: 取服务 ${name} 失败:`, err && err.message);
      return undefined;
    }
  }

  /** 解析提炼用的 provider/model：配置 → getRoute() → agentDefaultModel 默认选择 */
  async function resolveRoute(auto) {
    let provider = typeof auto?.provider === 'string' ? auto.provider.trim() : '';
    let model = typeof auto?.model === 'string' ? auto.model.trim() : '';

    if ((provider === '' || model === '') && typeof getRoute === 'function') {
      try {
        const route = await getRoute();
        if (route && typeof route === 'object') {
          if (provider === '' && typeof route.provider === 'string') provider = route.provider.trim();
          if (model === '' && typeof route.model === 'string') model = route.model.trim();
        }
      } catch (err) {
        log.warn?.('collector: getRoute() 解析模型失败:', err && err.message);
      }
    }

    if (provider === '' || model === '') {
      try {
        const selection = getService('agentDefaultModel')?.currentSelection?.();
        if (selection && typeof selection === 'object') {
          if (provider === '' && typeof selection.provider === 'string') provider = selection.provider.trim();
          if (model === '' && typeof selection.model === 'string') model = selection.model.trim();
        }
      } catch (err) {
        log.warn?.('collector: 读取默认模型失败:', err && err.message);
      }
    }
    return { provider, model };
  }

  /** 通知 UI 刷新统计（失败忽略） */
  function notifyStats() {
    if (typeof onStats !== 'function') return;
    try {
      const result = onStats(stats());
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (err) {
      log.warn?.('collector: onStats 回调失败:', err && err.message);
    }
  }

  /** 记录失败并返回标准结果 */
  function fail(message, scannedMessages = 0) {
    const error = message instanceof Error ? message.message : String(message ?? '未知错误');
    lastError = error;
    lastResult = { ok: false, error, at: new Date().toISOString(), scannedMessages };
    log.warn?.('collector: 记忆提炼失败:', error);
    notifyStats();
    return { ok: false, error, added: [], scannedMessages };
  }

  /** 真正的提炼流程（collectNow 内部使用；错误由外层兜底） */
  async function runCollect(record) {
    const cfg = readCfg();
    if (cfg.enabled !== true) return fail('记忆功能已关闭');

    const events = getEvents(record);
    const messages = extractMessages(events);
    if (messages.length === 0) return fail('没有可提炼的消息');

    const auto = cfg.autoCollect && typeof cfg.autoCollect === 'object' ? cfg.autoCollect : {};
    const everyRounds = intOr(auto.everyRounds, 6, 1, 100);
    const maxFacts = intOr(auto.maxFacts, 5, 1, 20);
    const maxFactChars = intOr(auto.maxFactChars, 400, 50, 2000);
    // 最近若干条消息；至少 40 条，同时兼容 DESIGN 的 2*everyRounds（取较大者）
    const limit = Math.max(MIN_MESSAGES, everyRounds * 2);
    const recent = messages.slice(-limit);
    const scannedMessages = recent.length;
    let transcript = recent
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.text}`)
      .join('\n');
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      transcript = tailChars(transcript, MAX_TRANSCRIPT_CHARS);
    }

    const route = await resolveRoute(auto);
    if (route.provider === '' || route.model === '') {
      return fail('未配置可用的提炼模型（memory.autoCollect.provider/model 为空且无默认模型）', scannedMessages);
    }

    const llm = getService('llm');
    if (!llm || typeof llm.stream !== 'function') {
      return fail('llm 服务不可用', scannedMessages);
    }

    const { createUserMessage, BlockAssembler } = await loadLlmModule(llmModule);
    if (typeof createUserMessage !== 'function' || typeof BlockAssembler !== 'function') {
      return fail('LLM 模块缺少 createUserMessage/BlockAssembler', scannedMessages);
    }

    const prompt = buildCollectorPrompt({ transcript, maxFacts, maxFactChars, override: cfg.collectorPrompt });
    const maxTokens = Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, maxFacts * 300 + 400));
    const message = createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-qqbot-buddy:memory-collector' },
    });

    // 60s 超时保护：超时后 abort 流，循环自然结束，in-flight 锁被释放
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    timer.unref?.();
    let modelText = '';
    let finishReason;
    try {
      const assembler = new BlockAssembler();
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [message],
        maxTokens,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'finish') finishReason = chunk.reason;
        assembler.push(chunk);
      }
      if (finishReason && finishReason.kind === 'error') {
        const failure = finishReason.failure;
        return fail(`模型调用失败: ${failure?.message ?? 'unknown'}`, scannedMessages);
      }
      if (finishReason && finishReason.kind === 'aborted') {
        return fail('记忆提炼被中止或超时', scannedMessages);
      }
      let blocks;
      try {
        blocks = assembler.blocks();
      } catch (err) {
        return fail(`模型响应不完整: ${err && err.message}`, scannedMessages);
      }
      modelText = blocks
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    } finally {
      clearTimeout(timer);
    }

    if (modelText === '') return fail('模型未返回可解析内容', scannedMessages);

    const facts = parseFacts(modelText, maxFacts, maxFactChars);
    if (facts === null) return fail('模型返回的 JSON 无法解析', scannedMessages);

    const added = [];
    for (const fact of facts) {
      try {
        const saved = memoryStore.saveFact({
          text: fact.text,
          tags: fact.tags,
          importance: fact.importance,
          source: 'auto',
        });
        if (saved && saved.ok && !saved.duplicate) {
          added.push({ text: fact.text, tags: fact.tags, importance: fact.importance });
        }
      } catch (err) {
        // 单条保存失败不影响其它事实
        log.warn?.('collector: 保存记忆事实失败:', err && err.message);
      }
    }

    totalCollected += added.length;
    roundsSinceCollect = 0;
    lastCollectAt = Date.now();
    lastError = '';
    lastResult = {
      ok: true,
      added: added.length,
      scannedMessages,
      at: new Date(lastCollectAt).toISOString(),
    };
    notifyStats();
    if (added.length > 0) {
      log.info?.(`collector: 自动提炼完成，新增 ${added.length} 条记忆（扫描 ${scannedMessages} 条消息）`);
    }
    return { ok: true, added, scannedMessages };
  }

  /**
   * 立即提炼一次（UI 手动触发或 noteTurnEnd 后台触发）。
   * 永远不会 reject；并发时返回 skipped。
   */
  function collectNow(record) {
    if (inFlight) {
      return Promise.resolve({
        ok: false,
        skipped: true,
        error: '记忆提炼正在进行中',
        added: [],
        scannedMessages: 0,
      });
    }
    const target = record ?? lastRecord;
    const run = (async () => {
      try {
        return await runCollect(target);
      } catch (err) {
        return fail(err && err.message ? err.message : String(err));
      } finally {
        inFlight = null;
      }
    })();
    inFlight = run;
    return run;
  }

  /** 每轮回复结束时调用：计数并在达到 everyRounds 时后台触发提炼 */
  function noteTurnEnd(record) {
    if (record && typeof record === 'object') lastRecord = record;
    // 轮次计数始终 +1（UI 可看到距上次提炼的轮数），是否触发由开关决定
    roundsSinceCollect += 1;
    const cfg = readCfg();
    if (!isEnabled(cfg)) return;

    const everyRounds = intOr(cfg.autoCollect?.everyRounds, 6, 1, 100);
    if (roundsSinceCollect < everyRounds) return;
    if (inFlight) return; // 有提炼在跑：保留计数，下一轮再试

    roundsSinceCollect = 0;
    // 后台触发，不 await；collectNow 内部已兜底，这里再挂一次 catch 防止 unhandled rejection
    try {
      const pending = collectNow(record ?? lastRecord);
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => log.warn?.('collector: 后台提炼异常:', err && err.message));
      }
    } catch (err) {
      log.warn?.('collector: 触发后台提炼失败:', err && err.message);
    }
  }

  /** 当前统计（供 UI） */
  function stats() {
    const cfg = readCfg();
    return {
      enabled: isEnabled(cfg),
      roundsSinceCollect,
      lastCollectAt,
      lastResult,
      lastError,
      totalCollected,
    };
  }

  return { noteTurnEnd, collectNow, stats };
}