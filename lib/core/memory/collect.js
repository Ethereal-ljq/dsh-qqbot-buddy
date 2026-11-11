/**
 * core/memory/collect —— 长期记忆提炼 job（每 N 轮自动触发 / 控制台手动触发）。
 *
 * 职责：
 * - 轮次计数持久化到 job_state 表（migrations v2 的 (bot_id, peer, job) 主键），重启不丢；
 * - maybeCollect：按 settings.memory.autoExtractEvery 判断是否触发（0 = 关闭），
 *   触发后把本轮对话交给旁路 LLM 抽取稳定事实，再走 memory.save 去重入库；
 * - collectNow：控制台手动触发，忽略轮次阈值（仍遵守并发锁）；
 * - oneShot 由外部注入（lib/host/llm.js 的 createOneShot），本模块不 import host，便于单测；
 * - 稳定性优先：模型失败 / 解析失败 / 超时 / 转录为空都只 warn 不抛，绝不阻塞 QQ 回复链路；
 * - 并发锁：同一 (botId, peer) 同时只跑一个提炼任务；失败不重试风暴（触发时先清零计数）。
 *
 * 与 qq/outbound.js 的兼容：其 turn/end 钩子调 collector.noteTurnEnd(record)，
 * 这里提供薄适配：从 record.peer / record.botId / record.turn.current.text 取信息，
 * 聚合成最近对话后调用 maybeCollect 并 fire-and-forget；缺字段时静默跳过。
 */
import { get, run } from '../db.js';

/** job_state 里的任务名（(bot_id, peer, job) 唯一）。 */
export const JOB_NAME = 'memory-collect';
/** 自动提炼写入的记忆 source，便于控制台区分来源。 */
export const COLLECT_SOURCE = 'auto-collect';
/** 送给模型的转录上限（保留最近的字符，单位=码点）。 */
export const TRANSCRIPT_MAX_CHARS = 6000;
/** 从消息流水表取多少条消息作为转录（超过 MAX_CHARS 的部分会被 tailTranscript 截掉）。 */
export const TRANSCRIPT_DB_MESSAGES = 60;
/** 单次最多入库的条数（提示词要求 3-8 条）。 */
export const MAX_FACTS = 8;
/** 单条事实文本上限（超出截断）。 */
export const MAX_FACT_TEXT_CHARS = 200;
export const DEFAULT_MAX_TOKENS = 1024;
export const MAX_HARD_TOKENS = 2048;
export const DEFAULT_TIMEOUT_MS = 60 * 1000;
export const DEFAULT_AUTO_EVERY = 10;
export const ALLOWED_KINDS = ['fact', 'preference', 'event', 'relation', 'other'];

export const COLLECT_SYSTEM_PROMPT = '你是 QQ 群聊/私聊的记忆整理助手。'
  + '你的任务是从对话中抽取值得长期记住的稳定事实。只输出要求格式，不要解释，不要寒暄。';

const KIND_ALIASES = {
  identity: 'fact',
  info: 'fact',
  profile: 'fact',
  like: 'preference',
  dislike: 'preference',
  preference: 'preference',
  event: 'event',
  happening: 'event',
  relationship: 'relation',
  relation: 'relation',
  other: 'other',
};

/**
 * 创建记忆提炼器。
 * @param {object} args
 * @param {object} args.memory createMemoryStore() 返回的 store（必须，save/list 等）
 * @param {{generate: Function}} args.oneShot 旁路 LLM（createOneShot() 返回值）
 * @param {object} [args.db] lib/core/db.js 打开的 DatabaseSync；缺省时轮次计数退回进程内 Map
 * @param {object} [args.logger] 日志（warn/info/debug）
 * @param {Function} [args.now] 时间函数（测试注入）
 * @param {number} [args.maxTokens] 单次生成 token 上限（默认 1024，硬上限 2048）
 * @param {number} [args.timeoutMs] 单次生成超时（默认 60s）
 */
export function createMemoryCollector({
  memory,
  oneShot,
  db,
  // 消息流水（core/messages/store.js 可选）：有它就从数据库取转录，
  // 不再依赖 record.transcriptLog 这个 40 条上限、重启即丢的内存缓冲。
  messages,
  logger,
  now = Date.now,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!memory || typeof memory.save !== 'function') {
    throw new TypeError('createMemoryCollector: 需要 createMemoryStore() 返回的 memory');
  }
  if (!oneShot || typeof oneShot.generate !== 'function') {
    throw new TypeError('createMemoryCollector: 需要 oneShot.generate()（lib/host/llm.js）');
  }
  const log = logger || { warn() {}, info() {}, debug() {}, error() {} };
  const tokenBudget = clampInt(maxTokens, DEFAULT_MAX_TOKENS, 64, MAX_HARD_TOKENS);
  const timeoutBudget = clampInt(timeoutMs, DEFAULT_TIMEOUT_MS, 10, 10 * 60 * 1000);
  const timeNow = typeof now === 'function' ? now : Date.now;

  /** 轮次计数：db 不可写时的进程内后备（重启丢失，但保证功能可用）。 */
  const memoryState = new Map();
  /** 正在跑的提炼任务：key -> Promise。 */
  const inFlight = new Map();
  /** noteTurnEnd 兼容路径的最近对话缓冲：key -> string[]。 */
  const transcriptBuffers = new Map();

  function keyOf(botId, peer) {
    return botId + '\u0000' + peer;
  }

  /** 读取 job_state 里的轮次状态。 */
  function readState(botId, peer) {
    const key = keyOf(botId, peer);
    if (db) {
      try {
        const row = get(db, 'SELECT value FROM job_state WHERE bot_id = ? AND peer = ? AND job = ?', botId, peer, JOB_NAME);
        if (row) return normalizeState(parseJson(row.value));
      } catch (err) {
        log.warn?.('读取 job_state 失败（退回内存计数）: ' + errText(err));
      }
    }
    return normalizeState(memoryState.get(key));
  }

  /** 写入 job_state（同时更新内存后备）。 */
  function writeState(botId, peer, state) {
    const key = keyOf(botId, peer);
    const normalized = normalizeState(state);
    memoryState.set(key, normalized);
    if (!db) return;
    try {
      run(db,
        'INSERT INTO job_state(bot_id, peer, job, value, updated_at) VALUES(?,?,?,?,?)'
        + ' ON CONFLICT(bot_id, peer, job) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        botId, peer, JOB_NAME, JSON.stringify({
          rounds: normalized.rounds,
          lastRunAt: normalized.lastRunAt,
          lastSaved: normalized.lastSaved,
          // P0 可观测性：记录最近一次提炼的结局，便于控制台/排查区分「没触发」和「触发但失败」
          lastOutcome: normalized.lastOutcome,
          lastReason: normalized.lastReason,
          lastFacts: normalized.lastFacts,
          failureCount: normalized.failureCount,
        }), timeNow());
    } catch (err) {
      log.warn?.('写入 job_state 失败（仅内存生效）: ' + errText(err));
    }
  }

  function writeRounds(botId, peer, rounds) {
    const prev = readState(botId, peer);
    writeState(botId, peer, { ...prev, rounds });
  }

  /** 该 (botId, peer) 是否正有提炼任务在跑。 */
  function isBusy(botId, peer) {
    return inFlight.has(keyOf(botId, peer));
  }

  /**
   * 记录一次提炼的结局（P0 可观测性）。
   * 失败类结局累加 failureCount，成功类清零，方便控制台直接看「最近是不是一直在失败」。
   * @param {{botId:string, peer:string}} owner
   * @param {{outcome:string, reason?:string, facts?:number}} info
   */
  function markOutcome(owner, info = {}) {
    const prev = readState(owner.botId, owner.peer);
    const failed = info.outcome !== 'saved' && info.outcome !== 'all-deduped';
    writeState(owner.botId, owner.peer, {
      ...prev,
      lastOutcome: String(info.outcome || ''),
      lastReason: String(info.reason || ''),
      lastFacts: Number(info.facts) > 0 ? Math.floor(Number(info.facts)) : 0,
      failureCount: failed ? prev.failureCount + 1 : 0,
    });
  }

  /**
   * 解析这次提炼要用的转录：消息流水表优先，回退到调用方传入的文本。
   *
   * 为什么库优先：record.transcriptLog 是 40 条内存缓冲，重启即丢、也不含更早的上下文；
   * 消息流水（messages 表）才是权威来源，且默认保留两周。
   *
   * @param {{botId:string, peer:string}} owner
   * @param {string} provided 调用方给的转录（可能来自内存缓冲）
   * @returns {string}
   */
  function resolveTranscript(owner, provided) {
    if (messages && typeof messages.transcript === 'function') {
      try {
        const fromDb = messages.transcript({ botId: owner.botId, peer: owner.peer, limit: TRANSCRIPT_DB_MESSAGES }) || '';
        if (fromDb.trim() !== '') return fromDb;
      } catch (err) {
        log.warn?.('从消息流水取转录失败（回退调用方转录）: ' + errText(err));
      }
    }
    return typeof provided === 'string' ? provided : '';
  }

  function getRounds({ botId, peer } = {}) {
    const owner = normalizeOwner(botId, peer);
    if (!owner) return 0;
    return readState(owner.botId, owner.peer).rounds;
  }

  /**
   * 每轮调用：轮次计数 +1（rounds 为本轮增量，默认 1），达到阈值且有转录时触发提炼。
   * @returns {Promise<{triggered:boolean, reason?:string, rounds:number, every?:number, result?:object}>}
   */
  async function maybeCollect({ botId, peer, transcript, rounds = 1, settings, route } = {}) {
    const owner = normalizeOwner(botId, peer);
    if (!owner) return { triggered: false, reason: 'invalid-args', rounds: 0 };
    const memorySettings = readMemorySettings(settings, owner);
    const current = readState(owner.botId, owner.peer).rounds;

    if (memorySettings.enabled === false) {
      return { triggered: false, reason: 'disabled', rounds: current };
    }
    if (!(memorySettings.autoExtractEvery > 0)) {
      return { triggered: false, reason: 'auto-disabled', rounds: current };
    }

    const step = clampInt(rounds, 1, 1, 1000);
    const nextRounds = current + step;
    if (nextRounds < memorySettings.autoExtractEvery) {
      writeRounds(owner.botId, owner.peer, nextRounds);
      return { triggered: false, reason: 'below-threshold', rounds: nextRounds, every: memorySettings.autoExtractEvery };
    }
    const effectiveTranscript = resolveTranscript(owner, transcript);
    if (!String(effectiveTranscript).trim()) {
      // 有轮次但没有可提炼的转录：保留计数，等下一轮带上转录再触发
      writeRounds(owner.botId, owner.peer, nextRounds);
      return { triggered: false, reason: 'empty-transcript', rounds: nextRounds, every: memorySettings.autoExtractEvery };
    }
    if (inFlight.has(keyOf(owner.botId, owner.peer))) {
      return { triggered: false, reason: 'busy', rounds: nextRounds, every: memorySettings.autoExtractEvery };
    }

    // 触发前先清零：即使模型失败也不在下一轮立即重试（避免失败风暴）
    writeRounds(owner.botId, owner.peer, 0);
    // 最终路由：这次对话真实用过的 > 设置里的 model.provider/model.model
    const finalRoute = normalizeRoute(route) || resolveSettingsModelRoute(owner, settings);
    const result = await startCollect(owner, effectiveTranscript, finalRoute);
    return { triggered: true, rounds: 0, every: memorySettings.autoExtractEvery, result };
  }

  /**
   * 控制台手动触发：忽略轮次阈值与 autoExtractEvery=0，只受并发锁约束。
   * @returns {Promise<{ok:boolean, facts:number, saved:number, created:number, deduped:number,
   *                     failed?:number, error?:string, reason?:string}>}
   */
  async function collectNow({ botId, peer, transcript, settings, route } = {}) {
    const owner = normalizeOwner(botId, peer);
    const empty = { ok: false, facts: 0, saved: 0, created: 0, deduped: 0 };
    if (!owner) return { ...empty, reason: 'invalid-args' };
    const effectiveTranscript = resolveTranscript(owner, transcript);
    if (effectiveTranscript.trim() === '') {
      // manual 触发时转录为空也要留痕，否则控制台点「立即提炼」会毫无反馈
      log.warn?.('记忆提炼跳过：转录为空（bot=' + owner.botId + ' peer=' + owner.peer + '，手动触发）');
      markOutcome(owner, { outcome: 'empty-transcript', reason: '转录为空' });
      return { ...empty, reason: 'empty-transcript' };
    }
    if (inFlight.has(keyOf(owner.botId, owner.peer))) {
      markOutcome(owner, { outcome: 'busy', reason: '同一会话正在提炼中' });
      return { ...empty, reason: 'busy' };
    }
    writeRounds(owner.botId, owner.peer, 0);
    // 手动触发：同样要解析路由（控制台可能没有 live agent，就用设置里的）
    const finalRoute = normalizeRoute(route) || resolveSettingsModelRoute(owner, settings);
    return startCollect(owner, effectiveTranscript, finalRoute);
  }

  /** 启动一次提炼（先检查并发锁；返回的 Promise 内部已兜住所有异常）。 */
  function startCollect(owner, transcript, route) {
    const key = keyOf(owner.botId, owner.peer);
    if (inFlight.has(key)) {
      return Promise.resolve({ ok: false, facts: 0, saved: 0, created: 0, deduped: 0, reason: 'busy' });
    }
    const task = runCollect(owner, transcript, route)
      .catch((err) => {
        log.warn?.('记忆提炼异常（已忽略）: ' + errText(err));
        return { ok: false, facts: 0, saved: 0, created: 0, deduped: 0, error: errText(err) };
      })
      .finally(() => {
        if (inFlight.get(key) === task) inFlight.delete(key);
      });
    inFlight.set(key, task);
    return task;
  }

  /** 一次真正提炼：截断转录 -> 调旁路 LLM -> 解析 -> memory.save 去重装库。 */
  async function runCollect(owner, transcript, route) {
    const clipped = tailTranscript(transcript, TRANSCRIPT_MAX_CHARS);
    if (clipped.trim() === '') {
      // 以前这里无日志无状态，是「跑了但没结果」最难查的一种
      log.warn?.('记忆提炼跳过：转录为空（bot=' + owner.botId + ' peer=' + owner.peer + '）');
      markOutcome(owner, { outcome: 'empty-transcript', reason: '转录为空' });
      return { ok: false, facts: 0, saved: 0, created: 0, deduped: 0, reason: 'empty-transcript' };
    }
    const prompt = buildCollectPrompt(clipped);

    // 路由由 maybeCollect / collectNow 解析后传入。没有就不发请求——否则一定报
    // no adapter registered for provider "undefined"，白白消耗失败计数还掩盖真正原因。
    const callRoute = normalizeRoute(route);
    if (!callRoute) {
      const reason = '未配置模型路由：请先在控制台「模型」页设置 provider 与 model（或先正常聊一轮让插件复用该路由）';
      log.warn?.('记忆提炼跳过（' + owner.botId + ' / ' + owner.peer + '）：' + reason);
      writeState(owner.botId, owner.peer, { ...readState(owner.botId, owner.peer), rounds: 0, lastRunAt: timeNow() });
      markOutcome(owner, { outcome: 'no-route', reason });
      return { ok: false, facts: 0, saved: 0, created: 0, deduped: 0, reason: 'no-route', error: reason };
    }

    // 超时：oneShot 自身也有 timeoutMs，这里再 race 一层兜住注入实现不守时的场景
    const controller = new AbortController();
    let timer;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        try { controller.abort(new Error('memory collect timeout')); } catch { /* ignore */ }
        resolve({ ok: false, error: '模型调用超时（' + timeoutBudget + 'ms）' });
      }, timeoutBudget);
      // 不能 unref：这是本次调用的兜底计时器，事件循环空闲时也必须能触发；成功路径 finally 会 clearTimeout
    });
    let generated;
    try {
      const call = Promise.resolve()
        .then(() => oneShot.generate({
          prompt,
          system: COLLECT_SYSTEM_PROMPT,
          maxTokens: tokenBudget,
          timeoutMs: timeoutBudget,
          signal: controller.signal,
          plugin: 'dsh-qqbot-buddy:memory-collect',
          // 关键：不传 provider 会被 llm 服务以 NO_ADAPTER 拒绝（历史 bug）
          provider: callRoute.provider,
          model: callRoute.model,
        }))
        .catch((err) => ({ ok: false, error: errText(err) }));
      generated = await Promise.race([call, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    if (!generated || generated.ok !== true) {
      const error = (generated && generated.error) || '模型未返回可用文本';
      log.warn?.('记忆提炼失败（bot=' + owner.botId + ' peer=' + owner.peer + '）: ' + error);
      writeState(owner.botId, owner.peer, { ...readState(owner.botId, owner.peer), rounds: 0, lastRunAt: timeNow() });
      markOutcome(owner, { outcome: 'llm-error', reason: error });
      return { ok: false, facts: 0, saved: 0, created: 0, deduped: 0, error };
    }

    const facts = parseFacts(generated.text, { maxFacts: MAX_FACTS });
    let created = 0;
    let deduped = 0;
    let failed = 0;
    for (const fact of facts) {
      try {
        const saved = memory.save({
          botId: owner.botId,
          peer: owner.peer,
          kind: fact.kind,
          text: fact.text,
          source: COLLECT_SOURCE,
        });
        if (saved && saved.created === false) deduped += 1;
        else created += 1;
      } catch (err) {
        failed += 1;
        log.warn?.('记忆入库失败（已跳过）: ' + errText(err));
      }
    }
    const savedCount = created + deduped;
    if (facts.length === 0) {
      log.warn?.('记忆提炼解析为空（bot=' + owner.botId + ' peer=' + owner.peer + '），本轮降级为不入库');
    }
    writeState(owner.botId, owner.peer, {
      rounds: 0,
      lastRunAt: timeNow(),
      lastSaved: savedCount,
    });
    // 必须在 writeState 之后：markOutcome 会读当前状态再合并，
    // 反过来写会被上面这次 writeState 用旧值覆盖（曾导致 lastOutcome 始终为空）。
    markOutcome(owner, {
      outcome: facts.length === 0 ? 'parse-empty' : (created > 0 ? 'saved' : 'all-deduped'),
      reason: facts.length === 0
        ? '模型未产出可用事实'
        : (created > 0 ? '' : '抽出的 ' + deduped + ' 条全部命中已有记忆（近似去重）'),
      facts: facts.length,
    });
    log.debug?.('记忆提炼完成: facts=' + facts.length + ' created=' + created + ' deduped=' + deduped);
    return { ok: true, facts: facts.length, saved: savedCount, created, deduped, failed };
  }

  /**
   * qq/outbound.js 的 turn/end 兼容钩子：内部聚合最近对话并 fire-and-forget 触发提炼。
   * record 来自 BotRuntime（peer/sessionId/agent/settings...），协议层会挂 turn.current。
   * @param {object} record BotRuntime 会话记录
   * @param {{transcript?: string, botId?: string}} [extra] 宿主有完整转录时可显式传入
   */
  function noteTurnEnd(record, extra = {}) {
    try {
      if (!record || typeof record !== 'object') return;
      const botId = typeof extra.botId === 'string' && extra.botId !== ''
        ? extra.botId
        : (typeof record.botId === 'string' ? record.botId
          : (record.state && typeof record.state.botId === 'string' ? record.state.botId : ''));
      const peer = typeof record.peer === 'string' ? record.peer : '';
      if (botId === '' || peer === '') return;
      const key = keyOf(botId, peer);

      // 转录来源优先级在 maybeCollect/resolveTranscript 里统一处理（消息库 > 传入文本），
      // 这里只负责给出「调用方视角」的转录：显式传入的优先，否则用内存缓冲兜底。
      let transcript;
      if (typeof extra.transcript === 'string' && extra.transcript.trim() !== '') {
        transcript = extra.transcript;
      } else {
        const turn = record.turn && record.turn.current && typeof record.turn.current.text === 'string'
          ? record.turn.current.text.trim()
          : '';
        if (turn === '') return;
        const buffer = transcriptBuffers.get(key) || [];
        buffer.push(turn);
        if (buffer.length > 20) buffer.splice(0, buffer.length - 20);
        transcriptBuffers.set(key, buffer);
        if (transcriptBuffers.size > 200) {
          const oldest = transcriptBuffers.keys().next().value;
          if (oldest !== key) transcriptBuffers.delete(oldest);
        }
        transcript = buffer.join('\n');
      }

      // record.settings 在 BotRuntime 里是**函数**（settings: () => self.settingsFor(peer)），
      // 早期用 typeof === 'object' 判断会把它整个丢掉，导致 settings.memory.autoExtractEvery
      // / enabled 永远读不到、只能吃默认值——这是「设置了阈值却不生效」的根因。
      const settings = resolveRecordSettings(record);
      // 旁路 LLM 必须带 provider：优先复用这次对话真实用过的路由
      const route = resolveRecordRoute(record);
      const task = maybeCollect({ botId, peer, transcript, rounds: 1, settings, route });
      task.then((result) => {
        if (result && result.triggered) transcriptBuffers.delete(key);
      }).catch(() => { /* maybeCollect 内部已兜底，这里只防未处理拒绝 */ });
    } catch (err) {
      log.warn?.('memory collector.noteTurnEnd 失败: ' + errText(err));
    }
  }

  /** 等待当前所有提炼任务结束（测试/优雅停机用）。 */
  async function whenIdle() {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight.values()]);
    }
  }

  return {
    maybeCollect,
    collectNow,
    noteTurnEnd,
    whenIdle,
    isBusy,
    getRounds,
    /** 读取某 peer 的提炼状态（含 lastOutcome/lastReason/failureCount，控制台诊断用）。 */
    getState: ({ botId, peer } = {}) => {
      const owner = normalizeOwner(botId, peer);
      return owner ? readState(owner.botId, owner.peer) : null;
    },
    limits: {
      transcriptMaxChars: TRANSCRIPT_MAX_CHARS,
      maxFacts: MAX_FACTS,
      maxTokens: tokenBudget,
      timeoutMs: timeoutBudget,
      autoExtractEveryDefault: DEFAULT_AUTO_EVERY,
    },
  };
}

/* ------------------------------ 纯函数（可单测） ------------------------------ */

/**
 * 读取 settings.memory.*：兼容三种 settings 形态——
 * 1) 已合成的嵌套设置对象 { memory: { autoExtractEvery } }；
 * 2) config store（有 getEffectiveSettings / forPeer / get 方法）；
 * 3) 扁平点号键 { 'memory.autoExtractEvery': 10 }。
 */
/**
 * 归一化模型路由：provider 与 model 必须同时非空才算有效。
 * @param {object|null} value
 * @returns {{provider:string, model:string}|null}
 */
export function normalizeRoute(value) {
  if (!value || typeof value !== 'object') return null;
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (provider === '' || model === '') return null;
  return { provider, model };
}

/**
 * 设置里的 model.provider / model.model（配置档可覆盖）。
 * @param {{botId:string, peer:string}} owner
 * @param {object} [settings]
 * @returns {{provider:string, model:string}|null}
 */
function resolveSettingsModelRoute(owner, settings) {
  const bag = resolveSettingsBag(settings, owner.botId, owner.peer);
  const model = bag && typeof bag.model === 'object' && bag.model !== null ? bag.model : {};
  return normalizeRoute({
    provider: model.provider === undefined ? bag['model.provider'] : model.provider,
    model: model.model === undefined ? bag['model.model'] : model.model,
  });
}

/**
 * 从 record 里解析「这次对话实际用的模型路由」。
 *
 * 为什么必须这么做：旁路 oneShot 调 llm.stream() 时必须显式给 provider，
 * 否则报 `no adapter registered for provider "undefined"`——这正是自动提炼长期
 * 0 入库的真凶（P0 可观测性上线后才暴露出来）。
 *
 * DSH 自己的做法也是「复用最近一次请求的路由」（见 dsh-session-title-llm 的
 * request.route）。这里读 agent.session.requestHeader().config，拿到的就是
 * agent 刚刚真实用过的 provider/model，天然跟设置保持一致。
 *
 * @param {object} record BotRuntime 会话记录
 * @returns {{provider:string, model:string}|null}
 */
export function resolveRecordRoute(record) {
  try {
    const agent = record && typeof record === 'object' ? record.agent : null;
    const session = agent && agent.session;
    if (!session || typeof session.requestHeader !== 'function') return null;
    const header = session.requestHeader();
    const config = header && header.config;
    if (!config || typeof config !== 'object') return null;
    const provider = typeof config.provider === 'string' ? config.provider.trim() : '';
    const model = typeof config.model === 'string' ? config.model.trim() : '';
    if (provider === '' || model === '') return null;
    return { provider, model };
  } catch {
    return null;
  }
}

/**
 * 把 record.settings 归一成对象。
 * BotRuntime 的 record.settings 是函数（延迟读 peer 级设置），v1 遗留的是对象，
 * 两种形态都要支持；取不到或抛错一律返回 undefined（由 readMemorySettings 走默认值）。
 * @param {object} record
 * @returns {object|undefined}
 */
export function resolveRecordSettings(record) {
  const raw = record && typeof record === 'object' ? record.settings : undefined;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'function') {
    try {
      const value = raw();
      return value && typeof value === 'object' ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof raw === 'object' ? raw : undefined;
}

export function readMemorySettings(settings, { botId = '', peer = '' } = {}) {
  const bag = resolveSettingsBag(settings, botId, peer);
  const section = bag && typeof bag.memory === 'object' && bag.memory !== null ? bag.memory : {};
  const enabledRaw = section.enabled === undefined ? bag['memory.enabled'] : section.enabled;
  const everyRaw = section.autoExtractEvery === undefined ? bag['memory.autoExtractEvery'] : section.autoExtractEvery;
  const enabled = enabledRaw === undefined || enabledRaw === null ? true : Boolean(enabledRaw);
  const every = Number(everyRaw);
  return {
    enabled,
    autoExtractEvery: Number.isFinite(every) && every >= 0 ? Math.floor(every) : DEFAULT_AUTO_EVERY,
  };
}

/** 转录尾截断：保留最近 maxChars 个字符（码点），前面加省略标记。 */
export function tailTranscript(transcript, maxChars = TRANSCRIPT_MAX_CHARS) {
  const text = String(transcript ?? '').trim();
  const budget = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (text === '' || budget === 0) return '';
  const chars = Array.from(text);
  if (chars.length <= budget) return text;
  return '（前文已截断）\n' + chars.slice(chars.length - budget).join('');
}

/** 提炼提示词（固定模板；参数只在调用侧控制）。 */
export function buildCollectPrompt(transcript) {
  return [
    '下面是一段 QQ 对话记录。请抽取 3-8 条值得长期记住的稳定事实（用户偏好、身份、关系、约定、重要事件等），忽略寒暄、玩笑和临时信息。',
    '',
    '输出格式：每条一行 JSON，不要输出 JSON 数组、不要 markdown 代码块、不要任何解释：',
    '{"text":"一句话事实","kind":"fact"}',
    '',
    'kind 只能取：fact（客观事实）、preference（偏好）、event（事件）、relation（关系）、other（其他）。',
    '',
    '对话记录：',
    '"""',
    String(transcript ?? ''),
    '"""',
  ].join('\n');
}

/**
 * 解析模型输出为 [{text, kind}]：
 * - 容忍 markdown 代码块围栏、JSON 数组、{facts:[...]}、行首列表符号；
 * - 非法/解析失败的条目直接丢弃（整体解析失败 => []，由调用方降级为不入库）；
 * - kind 归一化到 ALLOWED_KINDS；text 压缩空白并截断到 MAX_FACT_TEXT_CHARS。
 */
export function parseFacts(raw, { maxFacts = MAX_FACTS } = {}) {
  const limit = clampInt(maxFacts, MAX_FACTS, 1, 50);
  const text = String(raw ?? '')
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/```[a-z]*/gi, '')
    .trim();
  if (text === '') return [];

  const collected = [];
  const seen = new Set();

  function push(item) {
    if (collected.length >= limit || !item || typeof item !== 'object') return;
    const value = typeof item.text === 'string' ? item.text : (typeof item.fact === 'string' ? item.fact : '');
    const cleaned = collapseWhitespace(value);
    if (cleaned.length < 2) return;
    const clipped = truncateChars(cleaned, MAX_FACT_TEXT_CHARS);
    const dedupeKey = clipped.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    collected.push({ text: clipped, kind: normalizeKind(item.kind) });
  }

  // 1) 整段是 JSON：数组 / {facts:[]} / 单个对象
  const whole = tryParseJson(text);
  if (whole && typeof whole === 'object') {
    if (Array.isArray(whole)) {
      for (const item of whole) push(item);
      if (collected.length > 0) return collected;
    } else if (Array.isArray(whole.facts)) {
      for (const item of whole.facts) push(item);
      if (collected.length > 0) return collected;
    } else if (typeof whole.text === 'string' || typeof whole.fact === 'string') {
      push(whole);
      return collected;
    }
  }

  // 2) 每行一条 JSON（可能带 "- " 前缀）
  for (const line of text.split('\n')) {
    if (collected.length >= limit) break;
    const stripped = line.trim().replace(/^[-*•\d.、)\s]+/, '');
    if (stripped === '') continue;
    const objectText = extractJsonObject(stripped);
    if (objectText === '') continue;
    push(tryParseJson(objectText));
  }
  return collected;
}

/* ------------------------------ 内部工具 ------------------------------ */

function resolveSettingsBag(settings, botId, peer) {
  if (!settings || typeof settings !== 'object') return {};
  try {
    if (typeof settings.getEffectiveSettings === 'function') return settings.getEffectiveSettings(botId, peer) || {};
    if (typeof settings.forPeer === 'function') return settings.forPeer(peer) || {};
    if (typeof settings.get === 'function') return settings.get() || {};
  } catch {
    return {};
  }
  return settings;
}

function normalizeOwner(botId, peer) {
  const owner = {
    botId: String(botId ?? '').trim(),
    peer: String(peer ?? '').trim(),
  };
  return owner.botId !== '' && owner.peer !== '' ? owner : null;
}

function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const rounds = Math.floor(Number(source.rounds));
  const lastRunAt = Number(source.lastRunAt);
  const lastSaved = Number(source.lastSaved);
  const lastFacts = Math.floor(Number(source.lastFacts));
  const failureCount = Math.floor(Number(source.failureCount));
  return {
    rounds: Number.isFinite(rounds) && rounds > 0 ? rounds : 0,
    lastRunAt: Number.isFinite(lastRunAt) && lastRunAt > 0 ? lastRunAt : null,
    lastSaved: Number.isFinite(lastSaved) && lastSaved >= 0 ? Math.floor(lastSaved) : 0,
    // P0：最近一次提炼的结局，控制台与排查用
    lastOutcome: typeof source.lastOutcome === 'string' ? source.lastOutcome : '',
    lastReason: typeof source.lastReason === 'string' ? source.lastReason : '',
    lastFacts: Number.isFinite(lastFacts) && lastFacts > 0 ? lastFacts : 0,
    failureCount: Number.isFinite(failureCount) && failureCount > 0 ? failureCount : 0,
  };
}

function parseJson(value) {
  if (typeof value !== 'string' || value === '') return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function normalizeKind(kind) {
  const raw = String(kind ?? '').trim().toLowerCase();
  if (ALLOWED_KINDS.includes(raw)) return raw;
  return KIND_ALIASES[raw] || 'fact';
}

function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncateChars(value, maxChars) {
  const chars = Array.from(String(value ?? ''));
  if (chars.length <= maxChars) return chars.join('');
  return chars.slice(0, maxChars).join('');
}

function extractJsonObject(line) {
  const start = line.indexOf('{');
  if (start < 0) return '';
  const end = line.lastIndexOf('}');
  if (end <= start) return '';
  return line.slice(start, end + 1);
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function clampInt(value, fallback, min, max) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num < min) return fallback;
  return Math.min(num, max);
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

export default createMemoryCollector;
