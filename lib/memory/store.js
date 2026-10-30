/**
 * memory/store —— self-improve 长期记忆的文件层（同步 API、原子写）。
 *
 * 文件布局（root = settings.memory.dir）：
 * - MEMORY.md           热记忆，每条一行 `- [YYYY-MM-DD] 文本（#tag）`，注入 prompt 用；
 *                       最多保留 800 条，超出从最旧裁剪（index.json 不受影响）。
 * - notes/YYYY-MM-DD.md  当日全量记录，带时间与来源，供 search/read。
 * - index.json          去重索引，v2：{version:2, facts:[{hash,text,tags,at,file,importance,hits,lastHitAt}]}；
 *                       v1 只有 {hash,text,tags,at,file}，读取时自动补默认字段（内存迁移，下次保存落盘）；
 *                       hash = sha256(normalize(text)).slice(0,16)。
 *
 * 相关性召回（recall）：同步只读、不写盘；按“词面匹配 + tag 精确命中 + importance + 时间衰减”打分。
 * - query 分词：英文/数字按非字母数字切分（按词边界匹配），中文等 CJK 连续段按 2-gram 滑动；
 * - 有 query 时必须至少命中词面或 tag，避免仅凭重要度/新近混入无关条目；
 * - 无 query 时按“重要度 + 新近”排序返回；
 * - 设置读取一律容错：settings.memory.recall 缺失/异常时用 DEFAULT_RECALL；
 * - 命中计数（hits/lastHitAt）只在 saveFact 重复命中时累加，recall 保持纯读。
 *
 * 设计约束：
 * - 全部使用同步 fs：本模块被 prompt 组装（每轮同步读热记忆）、工具、UI 路由共用，
 *   同步 + 单线程保证进程内不会互相踩写；跨进程仍靠 tmp+rename 原子替换兜底。
 * - saveFact 先写当日记录、再更新 MEMORY.md、最后落 index.json；单条失败会抛错，
 *   调用方（collector/工具）自行决定是否继续。
 * - 路径入参一律相对 memory 根，且必须落在根内；只允许 .md。
 * - 读 <=1MB、写 <=256KB；写文件权限 0o600。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MEMORY_FILE = 'MEMORY.md';
const NOTES_DIR = 'notes';
const INDEX_FILE = 'index.json';
/** MEMORY.md 最多保留的条目数 */
const MAX_HOT_ENTRIES = 800;
/** 单次读取上限（字节） */
const MAX_READ_BYTES = 1024 * 1024;
/** 单次写入上限（字节） */
const MAX_WRITE_BYTES = 256 * 1024;
/** 单条事实文本上限（字符）；settings.maxFactChars 最大也是 2000 */
const MAX_FACT_TEXT = 2000;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 24;
/** 近似重复判定：2-gram Jaccard 阈值 + 包含关系的最短长度 */
const NEAR_DUP_SIMILARITY = 0.62;
const NEAR_DUP_SCAN = 300;
const NEAR_DUP_MIN_CHARS = 10;
const INDEX_VERSION = 2;
/** 单次 query 最多保留的词元数，避免超长 query 拖慢打分 */
const MAX_QUERY_TOKENS = 32;
/** 召回结果条数硬上限（设置 maxItems 最大 30，这里再兜一层） */
const MAX_RECALL_LIMIT = 50;

/**
 * settings.memory.recall 缺省值（与 settings-store 默认段保持一致）。
 * 旧 workspace 没有该字段时用这里兜底，保证 store 不依赖设置层一定有 recall。
 */
const DEFAULT_RECALL = Object.freeze({
  enabled: true,
  maxItems: 6,
  maxChars: 1200,
  recencyHalfLifeDays: 30,
  importanceWeight: 2,
  minScore: 0.15,
});

/**
 * 召回打分权重（每项先归一到 0..1，再乘权重相加，便于解释）：
 *   score = 0.7*词面命中占比 + 0.2*tag 精确命中占比
 *         + (importanceWeight/10)*重要度 + 0.1*新近度
 *   无 query 时：0.5*重要度 + 0.5*新近度
 * 调用方显式传 tags 时，每命中一个 +0.15（最多 +0.30）。
 */
const RECALL_WEIGHTS = Object.freeze({
  lexical: 0.7,
  tag: 0.2,
  recency: 0.1,
  requestedTag: 0.15,
});

/** 中日韩文字范围（用于 2-gram 分词） */
const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;
const ASCII_TOKEN_RE = /[a-z0-9]+/g;
const ASCII_TOKEN_TEST = /^[a-z0-9]+$/;
const ASCII_CHAR_TEST = /[a-z0-9]/;

// ── 小工具 ────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期 YYYY-MM-DD */
function formatDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时间 YYYY-MM-DD HH:mm:ss */
function formatDateTime(d) {
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 按码点截断，避免切坏 emoji 等代理对 */
function clampText(text, max) {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  // 极长文本用 Array.from 会占内存，但事实文本上限 2000 字符，可接受
  return [...text].slice(0, max).join('');
}

/** 取字符串尾部 <=max 个字符，且不切开代理对 */
function tailChars(text, max) {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  let start = text.length - max;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1; // 跳过被切开的低位代理
  return text.slice(start);
}

/** 事实文本清洗：统一成单行、折叠空白 */
function cleanFactText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\n\v\f\u00a0\u3000 ]+/g, ' ')
    .trim();
}

/** 去重归一化：NFKC + 折叠空白 + 小写，保证“同一句话”只存一次 */
function normalizeForHash(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** sha256(normalize(text)) 前 16 位 */
function hashFact(text) {
  return createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex').slice(0, 16);
}
/** 近似重复用的归一化：去掉空白/标点，只留字母数字与 CJK。 */
function normalizeForSimilarity(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** CJK/英文通用的 2-gram 集合。 */
function bigrams(text) {
  const set = new Set();
  const chars = [...text];
  if (chars.length < 2) {
    if (chars.length === 1) set.add(chars[0]);
    return set;
  }
  for (let i = 0; i < chars.length - 1; i += 1) set.add(chars[i] + chars[i + 1]);
  return set;
}

/** 判断两条事实是否“近似重复”（措辞微调/加标点/补一句说明不应重复入库）。 */
function isNearDuplicate(a, b) {
  const left = normalizeForSimilarity(a);
  const right = normalizeForSimilarity(b);
  if (left === '' || right === '') return false;
  if (left === right) return true;
  const minLength = Math.min(left.length, right.length);
  if (minLength >= NEAR_DUP_MIN_CHARS && (left.includes(right) || right.includes(left))) {
    return minLength / Math.max(left.length, right.length) >= 0.55;
  }
  if (minLength < NEAR_DUP_MIN_CHARS) return false;
  const leftSet = bigrams(left);
  const rightSet = bigrams(right);
  let overlap = 0;
  for (const gram of leftSet) if (rightSet.has(gram)) overlap += 1;
  const union = leftSet.size + rightSet.size - overlap;
  return union > 0 && overlap / union >= NEAR_DUP_SIMILARITY;
}


/** 标签清洗：去 #、空白转 -、限长限量 */
function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw
      .replace(/^#+/, '')
      .replace(/[\s,，;；()（）\[\]【】#]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_TAG_CHARS);
    if (tag === '' || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 把字符串按系统分隔符安全拼进目录 */
function joinRelative(base, rel) {
  return path.join(base, ...String(rel).split('/'));
}

/**
 * 读取文本，最多读 limit 字节（超大文件只读前缀，避免整读进内存）。
 * 截断可能切在多字节字符中间，仅影响搜索匹配展示，不做字符修复。
 */
function readTextLimited(file, limit) {
  const stat = fs.statSync(file);
  if (stat.size <= limit) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const read = fs.readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    try { fs.closeSync(fd); } catch { /* 关闭失败忽略 */ }
  }
}

/** 读取文件；不存在返回 ''；其它错误抛给调用方处理 */
function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}

// ── 数字容错 ──────────────────────────────────────────────────
/** 取有限数字（兼容数字字符串），否则返回默认值 */
function numOr(value, def) {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : def;
}

/** 夹紧到 [min,max] 的有限数字 */
function clampNum(value, def, min, max) {
  return Math.min(max, Math.max(min, numOr(value, def)));
}

/** 夹紧到 [min,max] 的整数 */
function clampInt(value, def, min, max) {
  return Math.round(clampNum(value, def, min, max));
}

// ── recall 分词与打分 ─────────────────────────────────────────
/**
 * query 分词（供 recall 打分；导出便于测试与调试）：
 * - 英文/数字：按非字母数字切分，保留长度 >= 2 的词（纯数字保留单字符）；
 * - 中文/日文/韩文：连续段按 2-gram 滑动（单字段保留整段）；
 * - NFKC + 小写归一化后去重，最多 MAX_QUERY_TOKENS 个词元。
 */
export function tokenizeQuery(query) {
  if (typeof query !== 'string' || query.trim() === '') return [];
  const normalized = query.normalize('NFKC').toLowerCase();
  const tokens = [];
  const seen = new Set();
  const push = (token) => {
    if (typeof token !== 'string' || token === '' || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const word of normalized.match(ASCII_TOKEN_RE) ?? []) {
    if (word.length >= 2 || /^[0-9]+$/.test(word)) push(word);
  }
  for (const run of normalized.match(CJK_RUN_RE) ?? []) {
    const chars = [...run];
    if (chars.length === 1) {
      push(run);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) push(chars[i] + chars[i + 1]);
  }
  // 全是单字母/符号时退化成整段匹配，避免“有 query 却无词元”
  if (tokens.length === 0) {
    const whole = normalized.replace(/\s+/g, ' ').trim();
    if (whole !== '') push(whole);
  }
  return tokens.slice(0, MAX_QUERY_TOKENS);
}

/** 词面命中：英文/数字按词边界匹配（避免 cat 命中 concatenate），其它按子串 */
function tokenHit(haystackLower, token) {
  if (token === '') return false;
  if (!ASCII_TOKEN_TEST.test(token)) return haystackLower.includes(token);
  let from = 0;
  for (;;) {
    const at = haystackLower.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : haystackLower[at - 1];
    const after = haystackLower[at + token.length] ?? '';
    if (!ASCII_CHAR_TEST.test(before) && !ASCII_CHAR_TEST.test(after)) return true;
    from = at + 1;
  }
}

/** 重要度排序值：high=1，其它=0 */
function importanceRank(importance) {
  return importance === 'high' ? 1 : 0;
}

/** 解析时间戳为毫秒；非法返回 0 */
function timeValue(at) {
  const ms = Date.parse(String(at ?? ''));
  return Number.isFinite(ms) ? ms : 0;
}

/** 时间衰减：0.5^(ageDays / halfLifeDays)；halfLifeDays<=0 表示忽略时间（恒为 1） */
function recencyScore(at, nowMs, halfLifeDays) {
  if (!(halfLifeDays > 0)) return 1;
  const atMs = Date.parse(String(at ?? ''));
  if (!Number.isFinite(atMs)) return 0;
  const ageDays = Math.max(0, (nowMs - atMs) / 86400000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** 归一化 now 选项（Date / 毫秒 / ISO 字符串），非法回退当前时间 */
function resolveNowMs(now) {
  if (now instanceof Date) {
    const ms = now.getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (typeof now === 'string') {
    const ms = Date.parse(now);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

/**
 * 单条记忆的召回得分（返回明细，便于测试与解释）。
 * 有 query 时：0.7*词面命中占比 + 0.2*tag 命中占比 + importanceWeight/10*重要度 + 0.1*新近度；
 * 无 query 时：0.5*重要度 + 0.5*新近度。
 * @returns {{score:number, lexical:number, tag:number, recency:number}}
 */
function scoreFact(fact, { tokens, nowMs, recallCfg, requestedTags }) {
  const textLower = String(fact.text ?? '').normalize('NFKC').toLowerCase();
  const tagsLower = Array.isArray(fact.tags)
    ? fact.tags.map((tag) => String(tag).normalize('NFKC').toLowerCase())
    : [];
  const imp = importanceRank(fact.importance);
  const recency = recencyScore(fact.at, nowMs, recallCfg.recencyHalfLifeDays);

  let lexical = 0;
  let tag = 0;
  let score;
  if (tokens.length === 0) {
    // 无 query：只按“重要度 + 新近”排序，不做词面匹配
    score = 0.5 * imp + 0.5 * recency;
  } else {
    let textHits = 0;
    for (const token of tokens) {
      if (tokenHit(textLower, token)) textHits += 1;
    }
    lexical = textHits / tokens.length;

    let tagHits = 0;
    for (const token of tokens) {
      if (tagsLower.includes(token)) tagHits += 1;
    }
    tag = Math.min(1, tagHits / Math.min(tokens.length, 3));

    score = RECALL_WEIGHTS.lexical * lexical
      + RECALL_WEIGHTS.tag * tag
      + imp * (recallCfg.importanceWeight / 10)
      + RECALL_WEIGHTS.recency * recency;
  }

  // 调用方显式传入 tags：命中一个 +0.15（最多 +0.30）
  let explicit = 0;
  if (requestedTags.length > 0) {
    for (const wanted of requestedTags) {
      if (tagsLower.includes(wanted)) explicit += 1;
    }
    score += Math.min(2, explicit) * RECALL_WEIGHTS.requestedTag;
  }

  return { score, lexical, tag, recency, explicit };
}

// ── 热文件（MEMORY.md）兜底解析 ───────────────────────────────
/** MEMORY.md 单行条目：`- [YYYY-MM-DD] 文本（#tag #tag）` */
const HOT_LINE_RE = /^-\s*\[(\d{4})-(\d{2})-(\d{2})\]\s*(.+)$/;
/** 行尾全角括号里的标签后缀 */
const HOT_TAG_SUFFIX_RE = /（([^）]*)）\s*$/;

/**
 * 从 MEMORY.md 反解记忆条目（只在 index.json 为空、即旧 workspace 无索引时用于 recall 兜底）。
 * MEMORY.md 给人看、没有 importance，这里统一按 normal 处理，日期按本地 0 点解释。
 */
function parseHotFileFacts(text) {
  const facts = [];
  const seen = new Set();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const match = HOT_LINE_RE.exec(rawLine.trim());
    if (!match) continue;
    let body = match[4].trim();
    const tags = [];
    const tagMatch = HOT_TAG_SUFFIX_RE.exec(body);
    if (tagMatch) {
      body = body.slice(0, body.length - tagMatch[0].length).trim();
      for (const part of tagMatch[1].split(/\s+/)) {
        const tag = part.replace(/^#+/, '').replace(/[，,；;]+$/, '').trim();
        if (tag !== '' && !tags.includes(tag)) tags.push(tag);
      }
    }
    if (body === '') continue;
    const hash = hashFact(body);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    facts.push({
      hash,
      text: body,
      tags,
      at: Number.isFinite(at.getTime()) ? at.toISOString() : '',
      file: MEMORY_FILE,
      importance: 'normal',
      hits: 0,
      lastHitAt: '',
    });
  }
  return facts;
}

/**
 * 创建记忆文件层。
 * @param {{settings: {get: () => any}, logger?: any}} options
 */
export function createMemoryStore({ settings, logger } = {}) {
  const log = logger ?? console;

  /** 当前配置的 memory 段（每次读取，让设置页改目录后立即生效） */
  function cfg() {
    try {
      const s = typeof settings?.get === 'function' ? settings.get() : {};
      return s && typeof s.memory === 'object' && s.memory !== null ? s.memory : {};
    } catch (err) {
      log.warn?.('读取 memory 设置失败，使用默认目录:', err && err.message);
      return {};
    }
  }

  /** 记忆根目录绝对路径（不存在则只返回路径，不创建） */
  function root() {
    const dir = cfg().dir;
    if (typeof dir === 'string' && dir.trim() !== '') return path.resolve(dir.trim());
    return path.join(process.cwd(), 'memory');
  }

  /** 确保根目录与 notes 目录存在 */
  function ensure() {
    const base = root();
    const existed = fs.existsSync(base);
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(path.join(base, NOTES_DIR), { recursive: true });
    return { ok: true, created: !existed };
  }

  /** 原子写：同目录临时文件 + rename，权限 0o600；失败清理临时文件 */
  function writeAtomic(file, text) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    try {
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
      throw err;
    }
  }

  /** 递归列出文件（跳过隐藏文件与符号链接），返回 [{abs, rel}] */
  function walkFiles(dir, base = dir, out = []) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      log.warn?.('遍历记忆目录失败:', err && err.message);
      return out;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // 隐藏文件 / 原子写残留
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkFiles(full, base, out);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          out.push({
            abs: full,
            rel: path.relative(base, full).split(path.sep).join('/'),
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        } catch { /* 单个文件 stat 失败忽略 */ }
      }
    }
    return out;
  }

  /** 记忆根下所有 .md（MEMORY.md 优先，其余按名字倒序，新的日期文件靠前） */
  function listMarkdownFiles() {
    const files = walkFiles(root())
      .filter((f) => f.rel.toLowerCase().endsWith('.md'))
      .map((f) => f.rel);
    files.sort((a, b) => {
      if (a === MEMORY_FILE) return -1;
      if (b === MEMORY_FILE) return 1;
      return b.localeCompare(a);
    });
    return files;
  }

  // ── index.json ──────────────────────────────────────────────
  /** 归一化单条索引记录：v1 缺字段补默认（importance/hits/lastHitAt） */
  function normalizeIndexFact(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const hash = typeof item.hash === 'string' ? item.hash : '';
    const text = typeof item.text === 'string' ? item.text : '';
    if (hash === '' || text === '') return null;
    const tags = Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [];
    const rawHits = typeof item.hits === 'number' && Number.isFinite(item.hits) ? item.hits : 0;
    return {
      hash,
      text,
      tags,
      at: typeof item.at === 'string' ? item.at : '',
      file: typeof item.file === 'string' ? item.file : '',
      importance: item.importance === 'high' ? 'high' : 'normal',
      hits: Math.max(0, Math.floor(rawHits)),
      lastHitAt: typeof item.lastHitAt === 'string' ? item.lastHitAt : '',
    };
  }

  /**
   * 校验并迁移索引结构；返回 {version:2, facts, migrated}。
   * v1 -> v2 的迁移只在内存里补默认字段，下次 saveIndex 落盘为 v2（读取保持只读）。
   */
  function validateIndex(raw) {
    const list = raw && Array.isArray(raw.facts) ? raw.facts : [];
    let migrated = !raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== INDEX_VERSION;
    const facts = [];
    for (const item of list) {
      const fact = normalizeIndexFact(item);
      if (!fact) {
        migrated = true;
        continue;
      }
      if (!item || item.importance === undefined || item.hits === undefined || item.lastHitAt === undefined) {
        migrated = true;
      }
      facts.push(fact);
    }
    return { version: INDEX_VERSION, facts, migrated };
  }

  /** 读取去重索引；文件不存在/损坏时回退空索引（坏文件先备份为 .corrupt-<ts>） */
  function loadIndex() {
    const file = path.join(root(), INDEX_FILE);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') log.warn?.('读取 index.json 失败:', err && err.message);
      return { version: INDEX_VERSION, facts: [], migrated: false };
    }
    try {
      return validateIndex(JSON.parse(raw));
    } catch (err) {
      log.warn?.('index.json 损坏，已回退为空索引:', err && err.message);
      try {
        fs.renameSync(file, file + '.corrupt-' + Date.now());
      } catch { /* 备份失败不影响主流程 */ }
      return { version: INDEX_VERSION, facts: [], migrated: false };
    }
  }

  function saveIndex(index) {
    writeAtomic(
      path.join(root(), INDEX_FILE),
      JSON.stringify({ version: INDEX_VERSION, facts: index.facts }, null, 2) + '\n',
    );
  }

  // ── 相关性召回 ──────────────────────────────────────────────
  /** 读取召回配置（settings.memory.recall，缺字段/类型错误一律回内置默认） */
  function readRecallCfg() {
    let raw;
    try {
      raw = cfg().recall;
    } catch (err) {
      log.warn?.('读取 recall 设置失败，使用内置默认:', err && err.message);
      raw = undefined;
    }
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      enabled: r.enabled !== false,
      maxItems: clampInt(r.maxItems, DEFAULT_RECALL.maxItems, 1, MAX_RECALL_LIMIT),
      maxChars: clampInt(r.maxChars, DEFAULT_RECALL.maxChars, 0, 20000),
      recencyHalfLifeDays: clampNum(r.recencyHalfLifeDays, DEFAULT_RECALL.recencyHalfLifeDays, 0, 3650),
      importanceWeight: clampNum(r.importanceWeight, DEFAULT_RECALL.importanceWeight, 0, 10),
      minScore: clampNum(r.minScore, DEFAULT_RECALL.minScore, 0, 1),
    };
  }

  /** 读取 MEMORY.md 原文（不存在/读失败返回 ''） */
  function readHotFile() {
    try {
      return readIfExists(path.join(root(), MEMORY_FILE));
    } catch (err) {
      log.warn?.('读取 MEMORY.md 失败:', err && err.message);
      return '';
    }
  }

  /**
   * 相关性召回（同步、只读，不写盘）。
   * @param {string} query 当前消息文本；空字符串 = 按“重要度 + 新近”返回
   * @param {{limit?:number, tags?:string[], minImportance?:'high', now?:Date|number|string}} [options]
   *   limit 缺省用 settings.memory.recall.maxItems（回退 6）；tags 为额外加权（不做硬过滤）；
   *   minImportance='high' 时只返回高重要度条目；now 用于固定时间基准（便于测试）。
   * @returns {Array<{text:string, tags:string[], importance:'high'|'normal', at:string, score:number}>}
   */
  function recall(query, options = {}) {
    const recallCfg = readRecallCfg();
    if (recallCfg.enabled === false) return [];
    const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const limit = clampInt(opts.limit, recallCfg.maxItems, 1, MAX_RECALL_LIMIT);
    const maxChars = recallCfg.maxChars > 0 ? recallCfg.maxChars : Infinity;
    const tokens = tokenizeQuery(typeof query === 'string' ? query : '');
    const requestedTags = normalizeTags(opts.tags).map((tag) => tag.toLowerCase());
    const onlyHigh = opts.minImportance === 'high';
    const nowMs = resolveNowMs(opts.now);

    const idx = loadIndex();
    // 旧 workspace 可能只有 MEMORY.md、没有 index.json：用热记忆条目兜底（只读，不落盘）
    const facts = idx.facts.length > 0 ? idx.facts : parseHotFileFacts(readHotFile());
    const scored = [];
    for (const fact of facts) {
      if (!fact || typeof fact.text !== 'string' || fact.text === '') continue;
      if (onlyHigh && fact.importance !== 'high') continue;
      const detail = scoreFact(fact, { tokens, nowMs, recallCfg, requestedTags });
      if (tokens.length > 0) {
        // 有 query 时必须至少命中词面、tag 或调用方显式 tags，避免仅凭重要度/新近混入无关条目
        if (detail.lexical === 0 && detail.tag === 0 && detail.explicit === 0) continue;
        if (detail.score < recallCfg.minScore) continue;
      }
      scored.push({ fact, score: detail.score });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const impDiff = importanceRank(b.fact.importance) - importanceRank(a.fact.importance);
      if (impDiff !== 0) return impDiff;
      const atDiff = timeValue(b.fact.at) - timeValue(a.fact.at);
      if (atDiff !== 0) return atDiff;
      return String(a.fact.text).localeCompare(String(b.fact.text));
    });

    const out = [];
    let usedChars = 0;
    for (const entry of scored) {
      if (out.length >= limit) break;
      // maxChars 是软上限：至少返回 1 条，注入层还有自己的预算
      if (out.length > 0 && usedChars + entry.fact.text.length > maxChars) break;
      usedChars += entry.fact.text.length;
      out.push({
        text: entry.fact.text,
        tags: Array.isArray(entry.fact.tags) ? entry.fact.tags.slice() : [],
        importance: entry.fact.importance === 'high' ? 'high' : 'normal',
        at: typeof entry.fact.at === 'string' ? entry.fact.at : '',
        score: Math.round(entry.score * 10000) / 10000,
      });
    }
    return out;
  }

  /** 记忆统计（供 UI）：索引条数、MEMORY.md 条目数、.md 总字符、重要度分布、最后保存时间 */
  function stats() {
    const idx = loadIndex();
    const byImportance = { high: 0, normal: 0 };
    let lastMs = 0;
    let lastSavedAt = '';
    for (const fact of idx.facts) {
      if (fact.importance === 'high') byImportance.high += 1;
      else byImportance.normal += 1;
      const ms = timeValue(fact.at);
      if (ms > lastMs) {
        lastMs = ms;
        lastSavedAt = fact.at;
      }
    }
    let hotEntries = 0;
    for (const line of readHotFile().split(/\r?\n/)) {
      if (/^-\s*\[/.test(line.trim())) hotEntries += 1;
    }
    return {
      facts: idx.facts.length,
      hotEntries,
      chars: layout().totalChars,
      byImportance,
      lastSavedAt,
    };
  }

  // ── 路径校验 ────────────────────────────────────────────────
  /** 把相对路径解析到 memory 根内；拒绝绝对路径、..、非 .md */
  function resolveWithinRoot(relPath) {
    if (typeof relPath !== 'string' || relPath.trim() === '') {
      throw new Error('memory-store: 文件路径不能为空');
    }
    if (relPath.includes('\0')) throw new Error('memory-store: 路径包含非法字符');
    if (path.isAbsolute(relPath)) throw new Error(`memory-store: 不允许绝对路径: ${relPath}`);
    const segments = relPath.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
    if (segments.length === 0) throw new Error('memory-store: 文件路径不能为空');
    if (segments.includes('..')) throw new Error(`memory-store: 路径越界: ${relPath}`);
    const base = root();
    const abs = path.resolve(base, ...segments);
    const rel = path.relative(base, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`memory-store: 路径越界: ${relPath}`);
    }
    if (path.extname(abs).toLowerCase() !== '.md') {
      throw new Error(`memory-store: 只允许读写 .md 文件: ${relPath}`);
    }
    return { abs, rel: rel.split(path.sep).join('/') };
  }

  // ── 对外 API ────────────────────────────────────────────────
  /** 热记忆文本：MEMORY.md 尾部 <= maxChars；优先整行，单行过长才按字符尾部回退 */
  function hotText(maxChars = 4000) {
    let max = Number(maxChars);
    if (!Number.isFinite(max)) max = 4000;
    max = Math.floor(max);
    if (max <= 0) return '';
    let text;
    try {
      text = readIfExists(path.join(root(), MEMORY_FILE));
    } catch (err) {
      log.warn?.('读取 MEMORY.md 失败:', err && err.message);
      return '';
    }
    text = text.replace(/\s+$/, '');
    if (text === '') return '';
    if (text.length <= max) return text;
    // 按行从尾部回退，避免截出半行
    const lines = text.split('\n');
    let out = '';
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const candidate = out === '' ? lines[i] : `${lines[i]}\n${out}`;
      if (candidate.length > max) {
        if (out === '') return tailChars(lines[i], max);
        break;
      }
      out = candidate;
    }
    return out;
  }

  /** 目录概览：文件列表（相对路径、大小、mtime）与 .md 总字符数 */
  function layout() {
    const base = root();
    const exists = fs.existsSync(base);
    if (!exists) return { dir: base, exists: false, files: [], totalChars: 0 };
    const entries = walkFiles(base);
    let totalChars = 0;
    const files = [];
    for (const entry of entries) {
      // index.json 是内部去重索引（不可通过记忆文件接口读写），不对外展示
      if (!entry.rel.toLowerCase().endsWith('.md')) continue;
      files.push({ name: entry.rel, size: entry.size, mtime: entry.mtime });
      try {
        if (entry.size > MAX_READ_BYTES) continue;
        totalChars += fs.readFileSync(entry.abs, 'utf8').length;
      } catch { /* 统计失败忽略该文件 */ }
    }
    return { dir: base, exists: true, files, totalChars };
  }

  /** 纯文本包含检索（大小写不敏感），返回 [{file,line,text}] */
  function search(query, limit = 8) {
    if (typeof query !== 'string' || query.trim() === '') return [];
    let max = 8;
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      max = Math.min(20, Math.max(1, Math.floor(limit)));
    }
    const needle = query.trim().toLowerCase();
    const results = [];
    for (const rel of listMarkdownFiles()) {
      if (results.length >= max) break;
      let text;
      try {
        // 与 readFile 的 1MB 上限保持一致：超大文件只检索前 1MB，避免整读进内存
        text = readTextLimited(joinRelative(root(), rel), MAX_READ_BYTES);
      } catch (err) {
        log.warn?.(`读取记忆文件失败（${rel}）:`, err && err.message);
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (results.length >= max) break;
        if (lines[i].toLowerCase().includes(needle)) {
          results.push({ file: rel, line: i + 1, text: lines[i].trim() });
        }
      }
    }
    return results;
  }

  /** 生成 MEMORY.md 的单行条目 */
  function buildHotLine({ date, text, tags }) {
    const tagSuffix = tags.length > 0 ? `（${tags.map((t) => `#${t}`).join(' ')}）` : '';
    return `- [${date}] ${text}${tagSuffix}`;
  }

  /** 生成当日 note 的单行条目（带时间与来源） */
  function buildDailyLine({ now, text, tags, source, importance }) {
    const tagSuffix = tags.length > 0 ? `（${tags.map((t) => `#${t}`).join(' ')}）` : '';
    const high = importance === 'high' ? ' [重要]' : '';
    return `- [${formatDateTime(now)}] [${source}]${high} ${text}${tagSuffix}`;
  }

  /** 原子追加一行到当日 notes 文件（不存在/为空时补日期标题） */
  function appendDailyLine(abs, date, line) {
    const existing = readIfExists(abs);
    const header = existing.trim() === '' ? `# 记忆记录 ${date}\n\n` : '';
    const body = existing.trim() === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
    writeAtomic(abs, `${header}${body}${line}\n`);
  }

  /** 往当日 notes 追加一行（无则创建带日期标题的文件） */
  function appendDaily(text, meta = {}) {
    const cleaned = clampText(cleanFactText(text), MAX_FACT_TEXT);
    if (cleaned === '') throw new Error('memory-store: 日志文本不能为空');
    const now = meta.time instanceof Date ? meta.time : new Date();
    const tags = normalizeTags(meta.tags);
    const source = typeof meta.source === 'string' && meta.source.trim() !== '' ? meta.source.trim() : 'tool';
    const importance = meta.importance === 'high' ? 'high' : 'normal';
    ensure();
    const date = formatDate(now);
    const rel = `${NOTES_DIR}/${date}.md`;
    const line = buildDailyLine({ now, text: cleaned, tags, source, importance });
    appendDailyLine(joinRelative(root(), rel), date, line);
    return { file: rel };
  }

  /**
   * 保存一条事实：去重 → 写当日 notes → 追加 MEMORY.md（超出 800 条裁剪）→ 更新 index。
   * 重复时累加命中计数（hits/lastHitAt）、升级重要度并合并新 tag，不重复写 MEMORY.md/notes。
   * @returns {{ok:boolean, duplicate:boolean, file:string, entry:string, path:string, importance:string, hits:number}}
   */
  function saveFact(input = {}) {
    const cleaned = clampText(cleanFactText(input.text), MAX_FACT_TEXT);
    if (cleaned === '') throw new Error('memory-store: 事实文本不能为空');
    const tags = normalizeTags(input.tags);
    const importance = input.importance === 'high' ? 'high' : 'normal';
    const source = typeof input.source === 'string' && input.source.trim() !== '' ? input.source.trim() : 'tool';
    ensure();

    const index = loadIndex();
    const hash = hashFact(cleaned);
    let existing = index.facts.find((f) => f.hash === hash);
    if (!existing && index.facts.length > 0) {
      // 近似重复：同一条事实被模型换措辞/补标点重写时合并，不再写第二遍
      const recent = index.facts.slice(-NEAR_DUP_SCAN);
      for (let i = recent.length - 1; i >= 0; i -= 1) {
        const candidate = recent[i];
        if (candidate && typeof candidate.text === 'string' && isNearDuplicate(cleaned, candidate.text)) {
          existing = candidate;
          break;
        }
      }
    }
    if (existing) {
      // 重复命中：只更新索引里的计数与重要度，不重复写文件
      const now = new Date();
      existing.hits = (Number.isFinite(existing.hits) ? existing.hits : 0) + 1;
      existing.lastHitAt = now.toISOString();
      if (importance === 'high') existing.importance = 'high';
      if (tags.length > 0) existing.tags = normalizeTags(existing.tags.concat(tags));
      try {
        saveIndex(index);
      } catch (err) {
        log.warn?.('更新命中计数失败（忽略）:', err && err.message);
      }
      const file = existing.file || '';
      return {
        ok: true,
        duplicate: true,
        file,
        entry: existing.text,
        path: file === '' ? root() : joinRelative(root(), file),
        importance: existing.importance,
        hits: existing.hits,
      };
    }

    const now = new Date();
    const date = formatDate(now);
    const dailyRel = NOTES_DIR + '/' + date + '.md';
    const dailyAbs = joinRelative(root(), dailyRel);
    const dailyLine = buildDailyLine({ now, text: cleaned, tags, source, importance });

    // 1) 当日全量记录
    appendDailyLine(dailyAbs, date, dailyLine);

    // 2) 热记忆 MEMORY.md
    const memoryAbs = path.join(root(), MEMORY_FILE);
    const memoryLine = buildHotLine({ date, text: cleaned, tags });
    let hotLines = readIfExists(memoryAbs)
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '');
    hotLines.push(memoryLine);
    if (hotLines.length > MAX_HOT_ENTRIES) hotLines = hotLines.slice(-MAX_HOT_ENTRIES);
    writeAtomic(memoryAbs, hotLines.join('\n') + '\n');

    // 3) 去重索引（裁剪 MEMORY.md 时 index 保留，保证之后仍能识别重复）
    index.facts.push({
      hash,
      text: cleaned,
      tags,
      at: now.toISOString(),
      file: dailyRel,
      importance,
      hits: 0,
      lastHitAt: '',
    });
    saveIndex(index);

    return {
      ok: true,
      duplicate: false,
      file: dailyRel,
      entry: memoryLine,
      path: dailyAbs,
      importance,
      hits: 0,
    };
  }

  /** 读取记忆文件（相对根路径，<=1MB） */
  function readFile(relPath) {
    const { abs, rel } = resolveWithinRoot(relPath);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      if (err && err.code === 'ENOENT') throw new Error(`memory-store: 记忆文件不存在: ${rel}`);
      throw err;
    }
    if (!stat.isFile()) throw new Error(`memory-store: 不是普通文件: ${rel}`);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`memory-store: 文件超过 ${MAX_READ_BYTES} 字节，拒绝读取: ${rel}`);
    }
    return { path: abs, text: fs.readFileSync(abs, 'utf8') };
  }

  /** 写入记忆文件（相对根路径，仅 .md，<=256KB，原子写 + 0600） */
  function writeFile(relPath, text) {
    const { abs, rel } = resolveWithinRoot(relPath);
    if (typeof text !== 'string') throw new Error('memory-store: 文件内容必须是字符串');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      throw new Error(`memory-store: 写入内容超过 ${MAX_WRITE_BYTES} 字节: ${rel}`);
    }
    ensure();
    writeAtomic(abs, text);
    return { ok: true, path: abs };
  }

  /** 读取去重索引（返回副本；形态固定为 {version, facts}，v1 已迁移为 v2 字段） */
  function index() {
    const idx = loadIndex();
    return {
      version: idx.version,
      facts: idx.facts.map((fact) => ({ ...fact, tags: fact.tags.slice() })),
    };
  }

  return {
    root,
    ensure,
    hotText,
    layout,
    search,
    saveFact,
    appendDaily,
    readFile,
    writeFile,
    index,
    recall,
    stats,
  };
}
