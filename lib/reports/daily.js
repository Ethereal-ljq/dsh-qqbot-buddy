/**
 * reports/daily —— 群日报：取数 → 统计 → 抽样 → LLM 抽取 → 校验 → 落库 → 文本。
 *
 * 设计原则：
 *   - 数字只来自确定性统计（模型不许自己写数字）；
 *   - 引号只来自原文（生成后逐条回查 flow_messages，对不上就丢）；
 *   - 同一 (bot, peer, day) 只生成一次，重复调用走已有结果（force 可重跑）；
 *   - payload 是稳定契约（version/meta/report/stats），后续卡片模板只读它，不再改库。
 */
import { createHash } from 'node:crypto';

import { normalizeVisual, visualCatalogText } from './visuals.js';

/** 单次注入 transcript 的字符上限（控制 token）。 */
export const MAX_TRANSCRIPT_CHARS = 14000;
/** 默认抽样条数上限。 */
export const DEFAULT_MAX_MESSAGES = 300;
/** 默认低于多少条就不生成（避免空群报告）。 */
export const DEFAULT_MIN_MESSAGES = 20;
/** 单条消息进 transcript 的正文上限。 */
const MAX_LINE_CHARS = 220;

/** 本地日期 YYYY-MM-DD。 */
export function localDay(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 本地某天的 [start, end) 毫秒区间；day 非法时回退今天。 */
export function dayBounds(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  const base = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0)
    : (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  const start = base.getTime();
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1).getTime();
  return { start, end, day: localDay(base) };
}

function clean(text, max = MAX_LINE_CHARS) {
  const value = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return value.slice(0, max) + '…';
}

function displayName(row) {
  const name = String(row && row.senderName ? row.senderName : '').trim();
  return name !== '' ? name : String((row && row.senderId) || '').slice(0, 8);
}

/** 是否值得进分析（去掉命令、纯标点/空白、超短寒暄）。 */
function worthAnalyzing(row) {
  const text = String(row && row.content ? row.content : '').trim();
  if (text === '') return false;
  if (text.startsWith('/')) return false;
  const meaningful = text.replace(/[\s\p{P}\p{S}\p{Emoji_Presentation}]/gu, '');
  return meaningful.length >= 1;
}

/** 确定性统计：总数 / 发言人数 / Top 发言人 / 小时分布。 */
export function buildStats(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  const speakers = new Map();
  const hours = new Array(24).fill(0);
  let firstAt = 0;
  let lastAt = 0;
  for (const row of rows) {
    const name = displayName(row);
    const key = String(row.senderId || name);
    if (!speakers.has(key)) speakers.set(key, { name, count: 0 });
    const item = speakers.get(key);
    item.count += 1;
    const at = Number(row.createdAt) || 0;
    if (at > 0) {
      const hour = new Date(at).getHours();
      if (hour >= 0 && hour < 24) hours[hour] += 1;
      if (firstAt === 0 || at < firstAt) firstAt = at;
      if (at > lastAt) lastAt = at;
    }
  }
  const topSpeakers = [...speakers.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  return { total: rows.length, speakers: speakers.size, topSpeakers, hours, firstAt, lastAt };
}

/** 按时间步长抽样：保持时间分布，最多 max 条。 */
export function selectSample(messages = [], max = DEFAULT_MAX_MESSAGES) {
  const limit = Math.max(1, Math.floor(Number(max)) || DEFAULT_MAX_MESSAGES);
  const rows = (Array.isArray(messages) ? messages : []).filter(worthAnalyzing);
  if (rows.length <= limit) return rows;
  const step = Math.max(1, Math.floor(rows.length / limit));
  const out = [];
  for (let i = 0; i < rows.length && out.length < limit; i += step) out.push(rows[i]);
  return out;
}

/** 拼 transcript：[HH:MM 昵称] 正文（超长截断）。 */
export function buildTranscript(sample = [], maxChars = MAX_TRANSCRIPT_CHARS) {
  const lines = [];
  let used = 0;
  for (const row of Array.isArray(sample) ? sample : []) {
    const at = Number(row.createdAt) || 0;
    const d = at > 0 ? new Date(at) : null;
    const hhmm = d ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : '';
    const line = '[' + hhmm + ' ' + displayName(row) + '] ' + clean(row.content);
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * 构造提示词（JSON only）。
 * visualConfig 来自当前卡片模板的 meta.json；模板没声明插画槽时不提 visual。
 */
export function buildPrompt({ day, transcript, stats, visualConfig = null } = {}) {
  const top = (stats && stats.topSpeakers ? stats.topSpeakers : []).slice(0, 8)
    .map((item) => item.name + ' ' + item.count + ' 条').join('、');
  const moods = visualConfig && Array.isArray(visualConfig.moods) ? visualConfig.moods : [];
  const moodHint = moods.map((mood) => mood.id + (mood.label ? ' ' + mood.label : '')).join(' / ');
  const visualExample = visualConfig
    ? ',"visual":{"mood":"' + (visualConfig.defaultMood || (moods[0] ? moods[0].id : '') || '') + '"}'
    : '';
  const visualLines = visualConfig
    ? [
      'visual 可选：按当天氛围挑卡片插画' + (moodHint ? '；mood 可选 ' + moodHint : '')
        + '，' + visualConfig.slots.join('/') + ' 可再单独点名覆盖，不填就按高峰时段自动选。',
      '可选插画：' + visualCatalogText(visualConfig) + '。',
    ]
    : [];
  return [
    '你要为 QQ 群写一份「当日群聊日报」。只根据下面提供的群聊记录写，不得编造。',
    '',
    '硬规则：',
    '1) 所有数字/时间/人名只能来自材料；不要自己统计或推算。',
    '2) quotes 里的 text 必须是材料里出现过的原话（逐字，可截断后半句），对不上会被系统丢弃。',
    '3) 没把握的名字写“有人”，不要猜身份。',
    '4) 只输出 JSON，不要 Markdown 代码围栏，不要解释。',
    '',
    '日期：' + day,
    '统计（系统算好的，可直接引用）：共 ' + (stats ? stats.total : 0) + ' 条，'
      + (stats ? stats.speakers : 0) + ' 人发言' + (top ? '；发言最多：' + top : '') + '。',
    '',
    '输出格式：',
    '{"title":"不超过 16 字","lead":"一句话总结（不超过 60 字，不写数字）",'
      + '"topics":[{"title":"话题标题","summary":"一到两句说明","quotes":[{"name":"发言人","text":"原话"}]}],'
      + '"quotes":[{"name":"发言人","text":"原话","why":"一句为什么好玩/重要"}]'
      + visualExample + '}',
    'topics 2-4 个；每个话题 quotes 最多 2 条；quotes 单独再给 2-4 条（可与话题重复）。',
    ...visualLines,
    '',
    '【群聊记录开始】',
    transcript,
    '【群聊记录结束】',
  ].join('\n');
}

/**
 * 从生效设置里取旁路模型路由：不传 provider 会被宿主 llm 服务以 NO_ADAPTER 拒绝。
 * @returns {{provider:string, model:string}|null}
 */
export function routeOf(settings) {
  const model = settings && settings.model && typeof settings.model === 'object' ? settings.model : {};
  const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
  const name = typeof model.model === 'string' ? model.model.trim() : '';
  if (provider === '' || name === '') return null;
  return { provider, model: name };
}

/** 日报生成的 token 预算：推理模型会把预算全花在思考上（实测 1600 全进 reasoning_tokens、正文为空），
 *  所以首轮就给足，仍无正文时再翻倍重试一次（与 tools/vision.js 的兜底策略一致）。 */
export const REPORT_MAX_TOKENS = 4096;
export const REPORT_MAX_TOKENS_RETRY = 8192;
/** 「模型只思考、不产出」。只有这种错误值得加大预算重试，网络/鉴权错误重试无用。 */
const NO_TEXT_RE = /未返回文本|no text|empty response/i;

/**
 * 调旁路模型生成日报；预算递增重试。
 * @returns {Promise<{ok:boolean,text?:string,error?:string}>}
 */
async function generateReport(oneShot, { prompt, route, logger, day = '', budgets = [REPORT_MAX_TOKENS, REPORT_MAX_TOKENS_RETRY] } = {}) {
  let last = null;
  for (let i = 0; i < budgets.length; i += 1) {
    const maxTokens = budgets[i];
    last = (await oneShot.generate({
      prompt,
      maxTokens,
      timeoutMs: 120000,
      plugin: 'dsh-qqbot-buddy:daily-report',
      ...(route ? { provider: route.provider, model: route.model } : {}),
    })) || { ok: false, text: '', error: '模型调用失败' };
    if (last.ok === true) return last;
    if (!NO_TEXT_RE.test(String(last.error || ''))) break;
    if (i < budgets.length - 1) {
      logger?.warn?.('群日报 ' + day + '：maxTokens=' + maxTokens + ' 时模型没有正文（推理吃满预算），提到 ' + budgets[i + 1] + ' 重试');
    }
  }
  return last;
}

/** 从模型输出里抠出第一个 JSON 对象（容忍代码围栏/前后废话）。 */
export function extractJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 归一化文本用于逐字比对（去空白与常见全角标点差异）。 */
function normalizeQuote(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

/**
 * 校验并清洗模型输出：
 *   - quotes 必须能在材料里逐字找到，否则丢弃；
 *   - 字段类型/长度兜底；
 *   - 一个字符都不剩时返回 null（视为失败）。
 */
export function sanitizeReport(parsed, messages = [], { visualConfig = null } = {}) {
  if (!parsed || typeof parsed !== 'object') return null;
  const corpus = (Array.isArray(messages) ? messages : []).map((row) => normalizeQuote(row.content)).filter(Boolean);
  const hasQuote = (text) => {
    const needle = normalizeQuote(text);
    if (needle.length < 2) return false;
    return corpus.some((body) => body.includes(needle));
  };
  const cleanQuote = (item, withWhy = false) => {
    if (!item || typeof item !== 'object') return null;
    const text = clean(item.text, 160);
    if (!text || !hasQuote(text)) return null;
    const out = { name: clean(item.name, 40) || '有人', text };
    if (withWhy) {
      const why = clean(item.why, 120);
      if (why) out.why = why;
    }
    return out;
  };
  const topics = (Array.isArray(parsed.topics) ? parsed.topics : [])
    .slice(0, 5)
    .map((topic) => {
      if (!topic || typeof topic !== 'object') return null;
      const title = clean(topic.title, 60);
      const summary = clean(topic.summary, 300);
      if (!title && !summary) return null;
      const quotes = (Array.isArray(topic.quotes) ? topic.quotes : []).map((q) => cleanQuote(q)).filter(Boolean).slice(0, 3);
      return { title: title || summary.slice(0, 20), summary, quotes };
    })
    .filter(Boolean);
  const quotes = (Array.isArray(parsed.quotes) ? parsed.quotes : [])
    .map((q) => cleanQuote(q, true)).filter(Boolean).slice(0, 6);
  if (topics.length === 0 && quotes.length === 0) return null;
  // 标题兜底：去掉「群聊日报：」前缀；纯日期/纯数字不算标题（模型偶尔会这么给）
  let title = clean(parsed.title, 40).replace(/^群聊?日报[：:·\s]+/, '');
  if (/^[\d\s./年月日号-]+$/.test(title)) title = '';
  const visual = normalizeVisual(parsed.visual, visualConfig);
  return {
    title,
    lead: clean(parsed.lead, 120),
    topics,
    quotes,
    ...(visual ? { visual } : {}),
  };
}

/** 纯文本版（>= 稳定契约；后续卡片模板读 payload，不读这段）。 */
export function renderText(report, stats, { day } = {}) {
  const lines = [];
  lines.push('📊 群日报 · ' + day);
  const top = (stats && stats.topSpeakers ? stats.topSpeakers : []).slice(0, 3)
    .map((item) => item.name + '（' + item.count + '）').join('、');
  lines.push('共 ' + (stats ? stats.total : 0) + ' 条消息 · ' + (stats ? stats.speakers : 0) + ' 人发言'
    + (top ? ' · 最活跃：' + top : ''));
  lines.push('');
  if (report && report.title) lines.push('「' + report.title + '」');
  if (report && report.lead) lines.push(report.lead);
  const topics = report && Array.isArray(report.topics) ? report.topics : [];
  if (topics.length > 0) {
    lines.push('');
    lines.push('【今日话题】');
    topics.forEach((topic, index) => {
      lines.push((index + 1) + '. ' + topic.title + (topic.summary ? '：' + topic.summary : ''));
      for (const quote of topic.quotes || []) lines.push('   「' + quote.text + '」— ' + quote.name);
    });
  }
  const quotes = report && Array.isArray(report.quotes) ? report.quotes : [];
  if (quotes.length > 0) {
    lines.push('');
    lines.push('【群聊金句】');
    for (const quote of quotes) {
      lines.push('- 「' + quote.text + '」— ' + quote.name + (quote.why ? '（' + quote.why + '）' : ''));
    }
  }
  return lines.join('\n').trim();
}

/**
 * 生成（或复用）某天某群的日报。
 * @param {object} args
 * @param {object} args.flow createFlowStore()
 * @param {object} args.reports createReportStore()
 * @param {object} args.oneShot runtime.oneShot
 * @param {string} args.botId
 * @param {string} args.peer
 * @param {string} [args.day] 默认今天（本地）
 * @param {object} [args.settings] 生效设置（daily.maxMessages / minMessages）
 * @param {boolean} [args.force]
 * @param {object} [args.logger]
 */
export async function generateDaily({
  flow, reports, oneShot, botId, peer, day, settings, force = false, logger, visualConfig = null,
  /** 强制氛围 id（由 daily.visualMode=random/fixed 决定）；非法或配置没有该氛围时忽略。 */
  forcedMood = '',
} = {}) {
  const log = logger || console;
  const owner = String(botId || '');
  const key = String(peer || '');
  if (!owner || !key) return { ok: false, reason: 'invalid-peer' };
  if (!flow || typeof flow.list !== 'function') return { ok: false, reason: 'no-flow' };
  if (!reports || typeof reports.save !== 'function') return { ok: false, reason: 'no-store' };

  const target = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : localDay();
  const existing = reports.get({ botId: owner, peer: key, day: target });
  if (existing && existing.status === 'done' && !force) return { ok: true, reused: true, report: existing };

  // 强制重跑失败时不能把已有的好报告冲掉（模型偶发超时/断网很常见）：
  // 保留 done 的 payload/text/图片，只把 error 记下来。
  const keepPrevious = !!(existing && existing.status === 'done' && existing.payload
    && existing.payload.report && existing.text);
  const preservePrevious = (error) => reports.save({
    botId: owner, peer: key, day: target, status: 'done',
    payload: existing.payload, text: existing.text,
    messageCount: existing.messageCount, speakerCount: existing.speakerCount,
    imagePath: existing.imagePath, delivered: existing.delivered,
    error,
  });

  const { start, end } = dayBounds(target);
  const messages = flow.list({ botId: owner, peer: key, since: start, until: end - 1, limit: 5000 }) || [];
  const dailyCfg = (settings && settings.daily) || {};
  const minMessages = Number(dailyCfg.minMessages) > 0 ? Number(dailyCfg.minMessages) : DEFAULT_MIN_MESSAGES;
  const maxMessages = Number(dailyCfg.maxMessages) > 0 ? Number(dailyCfg.maxMessages) : DEFAULT_MAX_MESSAGES;
  const stats = buildStats(messages);

  if (messages.length < minMessages) {
    const reason = '低于阈值（' + messages.length + ' < ' + minMessages + '）';
    const skipped = keepPrevious
      ? preservePrevious(reason + '，保留上一次结果')
      : reports.save({
        botId: owner, peer: key, day: target, status: 'skipped',
        payload: { version: 1, botId: owner, peer: key, day: target, stats },
        text: '', messageCount: messages.length, speakerCount: stats.speakers,
        error: reason,
      });
    return { ok: false, reason: 'below-threshold', report: skipped };
  }

  if (!oneShot || typeof oneShot.generate !== 'function') {
    const failed = reports.save({
      botId: owner, peer: key, day: target, status: 'failed', payload: { version: 1, stats },
      messageCount: messages.length, speakerCount: stats.speakers, error: '旁路模型不可用',
    });
    return { ok: false, reason: 'no-llm', report: failed };
  }

  const sample = selectSample(messages, maxMessages);
  const transcript = buildTranscript(sample);
  const prompt = buildPrompt({ day: target, transcript, stats, visualConfig });
  const route = routeOf(settings);
  let output;
  try {
    output = await generateReport(oneShot, { prompt, route, logger: log, day: target });
  } catch (err) {
    output = { ok: false, text: '', error: (err && err.message) || String(err) };
  }
  if (!output || output.ok !== true) {
    const reason = clean(output && output.error ? output.error : '模型调用失败', 300);
    // 失败过去只落库不吭声，日志里完全看不出「今天没有日报」——这里补一条 warn。
    log.warn?.('群日报生成失败 ' + target + '：' + reason);
    const failed = keepPrevious
      ? preservePrevious(reason)
      : reports.save({
        botId: owner, peer: key, day: target, status: 'failed',
        payload: { version: 1, botId: owner, peer: key, day: target, stats },
        messageCount: messages.length, speakerCount: stats.speakers,
        error: reason,
      });
    return { ok: false, reason: 'llm-failed', report: failed };
  }

  const parsed = extractJson(output.text);
  const report = sanitizeReport(parsed, messages, { visualConfig });
  // 配置强制氛围（每天随机 / 固定指定）优先于模型自己的 visual.mood，但保留模型点名的槽位素材。
  const forced = String(forcedMood || '').trim();
  if (report && forced !== '' && visualConfig && Array.isArray(visualConfig.moods)
    && visualConfig.moods.some((mood) => mood.id === forced)) {
    report.visual = { ...(report.visual || {}), mood: forced };
  }
  if (!report) {
    const reason = '模型输出无法解析或引文全部对不上原文';
    const failed = keepPrevious
      ? preservePrevious(reason)
      : reports.save({
        botId: owner, peer: key, day: target, status: 'failed',
        payload: { version: 1, botId: owner, peer: key, day: target, stats },
        messageCount: messages.length, speakerCount: stats.speakers,
        error: reason,
      });
    return { ok: false, reason: 'bad-output', report: failed };
  }

  const payload = {
    version: 1,
    botId: owner,
    peer: key,
    day: target,
    generatedAt: Date.now(),
    stats,
    report,
    meta: { sampleSize: sample.length, transcriptChars: transcript.length, digest: createHash('sha1').update(transcript).digest('hex').slice(0, 12) },
  };
  const text = renderText(report, stats, { day: target });
  const saved = reports.save({
    botId: owner, peer: key, day: target, status: 'done',
    payload, text, messageCount: messages.length, speakerCount: stats.speakers,
  });
  log.info?.('群日报已生成: ' + key + ' ' + target + '（' + messages.length + ' 条 / ' + sample.length + ' 条样本）');
  return { ok: true, reused: false, report: saved, text, payload };
}

export default generateDaily;
