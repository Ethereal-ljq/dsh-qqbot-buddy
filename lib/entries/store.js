/**
 * entries/store —— 通用条目库（知识库 / 群友库共用）的文件层。
 *
 * 磁盘布局（base = dir()，dir 支持字符串或 () => string，便于设置热改）：
 * - <base>/entries/<id>.md   条目文件：YAML-ish frontmatter + markdown 正文
 * - <base>/index.json        检索索引（只存检索必需字段 + 正文摘要）
 * - <base>/.index-dirty      延迟写标记：存在说明索引落后于条目文件，下次加载时全量重建
 *
 * 条目文件格式（自解析，不引入 js-yaml；字段值只允许 scalar 与字符串数组）：
 * ---
 * id: k_xxx
 * kind: knowledge
 * title: 标题
 * tags: [偏好, 咖啡]
 * scope: group
 * groupId: g1
 * importance: 2
 * source: manual
 * createdAt: 2026-10-29T12:00:00.000Z
 * updatedAt: 2026-10-29T12:00:00.000Z
 * hits: 0
 * lastHitAt: ""
 * meta: {}
 * ---
 *
 * markdown 正文
 *
 * 复杂度说明：
 * - 索引常驻内存：save/remove 只增量替换一条索引记录，写盘仍是整份 JSON（O(条目数) 字节，
 *   千条量级 < 1MB，可接受）。
 * - 索引缺失 / JSON 损坏 / 版本或 kind 不匹配 / 存在 .index-dirty 时，按 entries/*.md 全量重建
 *   （O(条目数) 次小文件读；顺序读 + 单进程缓存，千条量级在数十毫秒内）。
 * - save({...}, {deferIndex:true}) 不立即写 index.json，只落 .index-dirty 标记并延迟 flush，
 *   进程崩溃后靠标记自动重建，适合群友库 visit 这种每条消息都发生的轻量更新
 *   （每条消息只写 1 个成员小文件，索引最多延迟 FLUSH_DELAY_MS 落盘）。
 *
 * 安全 / 容错：
 * - 全部同步 fs；写盘 = 同目录临时文件 + rename 原子替换，权限 0600；单文件写 <= 256KB，读 <= 1MB。
 * - id 只允许 [A-Za-z0-9][A-Za-z0-9_-]{0,63}，天然阻挡 ../ 越界。
 * - 单个条目文件损坏只 warn + 跳过（索引重建不因此失败），坏 index.json 先备份再重建。
 */
import fs from 'node:fs';
import path from 'node:path';

const ENTRIES_DIR = 'entries';
const INDEX_FILE = 'index.json';
const DIRTY_FILE = '.index-dirty';
const INDEX_VERSION = 1;
/** 单文件写入上限（字节） */
const MAX_FILE_BYTES = 256 * 1024;
/** 单文件读取上限（字节） */
const MAX_READ_BYTES = 1024 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_TAGS = 12;
const MAX_TAG_CHARS = 24;
/** 正文摘要长度：索引里超出部分不参与检索（正文仍完整落盘，可 get 读取） */
const SUMMARY_CHARS = 800;
/** meta 序列化后上限（字节） */
const MAX_META_BYTES = 64 * 1024;
/** 延迟写索引的防抖间隔 */
const FLUSH_DELAY_MS = 600;

/** 条目作用域 */
export const ENTRY_SCOPES = Object.freeze(['global', 'group', 'c2c']);
/** 条目来源 */
export const ENTRY_SOURCES = Object.freeze(['manual', 'tool', 'auto', 'web']);
/** 条目审核状态：auto 提炼默认先 pending，人工/工具写入默认 approved */
export const ENTRY_STATUSES = Object.freeze(['approved', 'pending']);

const SCOPES = ENTRY_SCOPES;
const SOURCES = ENTRY_SOURCES;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 新建 id 前缀：知识 k_、群友 m_、其它 e_ */
const ID_PREFIX = Object.freeze({ knowledge: 'k', member: 'm' });
/** 可单独直接写出的 scalar（含中文）；否则用 JSON 字符串转义 */
const PLAIN_SCALAR = /^[^\s"'#\[\]{},:&*!|>%@`\\][^"#\r\n]*$/;
/** 可放进 [a, b] 简写数组的标签（标签本身已归一化，不含逗号/引号/括号） */
const PLAIN_TAG = /^[^\s"',#\[\]{}\\]+$/;
/** 其它 CJK 区段（日文假名 / 韩文）也按 2-gram 切分 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;

// ── 小工具 ────────────────────────────────────────────────────
function asString(value) {
  return typeof value === 'string' ? value : '';
}

function nowIso() {
  return new Date().toISOString();
}

/** 任意时间输入 → ISO 字符串；解析失败返回 fallback */
function asIso(value, fallback = '') {
  if (typeof value === 'string' && value.trim() !== '') {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return fallback;
}

/** 按码点截断，避免切坏 emoji 代理对 */
function clampChars(text, max) {
  const value = String(text ?? '');
  if (max <= 0) return '';
  if (value.length <= max) return value;
  return [...value].slice(0, max).join('');
}

function clampInt(value, min, max, fallback) {
  let num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) return fallback;
  num = Math.trunc(num);
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** 检索归一化：NFKC + 折叠空白 + 小写 */
function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 标签清洗：去 #、空白转 -、限长限量（与 memory store 语义一致） */
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

function normalizeScope(value) {
  return SCOPES.includes(value) ? value : '';
}

function normalizeSource(value) {
  return SOURCES.includes(value) ? value : '';
}

function normalizeStatus(value) {
  return ENTRY_STATUSES.includes(value) ? value : '';
}

function normalizeKind(value) {
  const kind = asString(value).trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(kind) ? kind : '';
}

/**
 * 中文（2-gram）+ 英文（整词）切词。
 * - ASCII 单词整体保留（大小写已归一化）；
 * - CJK / 假名 / 韩文连续串按 2-gram 切分，单字串保留单字；
 * - 返回去重后的 token 数组，顺序稳定。
 */
export function tokenize(text) {
  const norm = normalizeText(text);
  if (norm === '') return [];
  const tokens = [];
  const seen = new Set();
  const push = (token) => {
    if (token === '' || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const word of norm.match(/[a-z0-9][a-z0-9_.+-]*/g) ?? []) push(word);
  for (const run of norm.match(CJK_RUN) ?? []) {
    if (run.length <= 1) {
      push(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) push(run.slice(i, i + 2));
  }
  return tokens;
}

/**
 * 文本匹配分（0 表示不匹配）。
 * @param {string} query 查询串
 * @param {{title?:string, tags?:string[], summary?:string}} fields 权重：标题 3 / 标签 2.5 / 摘要 1
 * @returns {number} 0..13（覆盖率 * 10 + 整串命中奖励）
 */
export function matchScore(query, fields = {}) {
  const q = normalizeText(query);
  if (q === '') return 0;
  const tokens = tokenize(q);
  if (tokens.length === 0) return 0;
  const title = normalizeText(fields.title);
  const summary = normalizeText(fields.summary);
  const tags = Array.isArray(fields.tags) ? fields.tags.map((tag) => normalizeText(tag)).join(' ') : '';
  let hits = 0;
  for (const token of tokens) {
    let best = 0;
    if (title.includes(token)) best = 3;
    if (tags.includes(token)) best = Math.max(best, 2.5);
    if (summary.includes(token)) best = Math.max(best, 1);
    hits += best;
  }
  const coverage = hits / (tokens.length * 3);
  if (coverage <= 0) return 0;
  let bonus = 0;
  if (title.includes(q)) bonus += 3;
  else if (summary.includes(q)) bonus += 1.5;
  return coverage * 10 + bonus;
}

/** 新近度：指数衰减，返回 0..1（越新越接近 1） */
export function recencyScore(isoOrMs, halfLifeDays = 30) {
  const time = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(time)) return 0;
  const days = Math.max(0, (Date.now() - time) / 86_400_000);
  return Math.pow(0.5, days / Math.max(1, halfLifeDays));
}

// ── frontmatter 解析 / 序列化（无第三方依赖） ──────────────────
/** scalar → frontmatter 值文本；需要转义时用 JSON 字符串 */
function serializeScalar(value) {
  const text = String(value ?? '');
  if (text === '') return '""';
  if (PLAIN_SCALAR.test(text) && !text.includes(': ') && !text.endsWith(':')) return text;
  return JSON.stringify(text);
}

/** 字符串数组 → 值文本；简单标签用 [a, b] 简写，否则 JSON 数组 */
function serializeArray(values) {
  const list = Array.isArray(values) ? values.map((value) => String(value)) : [];
  if (list.length === 0) return '[]';
  if (list.every((item) => PLAIN_TAG.test(item))) return `[${list.join(', ')}]`;
  return JSON.stringify(list);
}

/** 解析单个 scalar / 数组原子值 */
function parseScalarAtom(raw) {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '""' || text === "''") return '';
  if (text.startsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === 'string' ? parsed : text;
    } catch {
      return text.replace(/^"|"$/g, '');
    }
  }
  if (text.startsWith("'")) return text.replace(/^'|'$/g, '').replace(/''/g, "'");
  return text;
}

function parseScalar(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) return [parseScalarAtom(text)];
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(parseScalarAtom).filter((item) => item !== '');
  }
  return parseScalarAtom(text);
}

/**
 * 解析 frontmatter + 正文；文件不以 --- 开头或缺少结束行时返回 null（视为损坏）。
 * 容忍 BOM、开头空行、CRLF、坏行（跳过）。
 * @returns {{data: Record<string, string|string[]>, body: string} | null}
 */
function parseFrontmatter(text) {
  let source = String(text ?? '');
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let cursor = 0;
  while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
  if (cursor >= lines.length || lines[cursor].trim() !== '---') return null;
  const data = {};
  let closed = false;
  cursor += 1;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim() === '---') {
      closed = true;
      cursor += 1;
      break;
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const matched = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!matched) continue;
    data[matched[1]] = parseScalar(matched[2].trim());
  }
  if (!closed) return null;
  const body = lines.slice(cursor).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return { data, body };
}

/** meta 是单行 JSON 字符串标量（frontmatter 只允许 scalar / 字符串数组） */
function parseMeta(value) {
  const raw = asString(value);
  if (raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeMeta(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return {};
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return {};
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_META_BYTES) {
    throw new Error(`entries-store: meta 超过 ${MAX_META_BYTES} 字节`);
  }
  const parsed = JSON.parse(json);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/** 正文归一化：统一换行、去掉首尾空行 */
function normalizeBody(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

/** 标题缺省时用正文首行 / id 兜底 */
function deriveTitle(body, id) {
  const firstLine = String(body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine) {
    const cleaned = clampChars(firstLine.replace(/^#{1,6}\s*/, ''), MAX_TITLE_CHARS);
    if (cleaned !== '') return cleaned;
  }
  return `未命名条目 ${id}`;
}

/** 正文 → 索引摘要（压平 markdown 标题标记与空白） */
function excerptOf(body) {
  const flat = String(body ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
  return flat.length <= SUMMARY_CHARS ? flat : flat.slice(0, SUMMARY_CHARS);
}

/** 索引记录（只存检索 / 列表必需字段） */
function summaryOf(entry) {
  return {
    id: entry.id,
    title: entry.title,
    tags: [...entry.tags],
    scope: entry.scope,
    groupId: entry.groupId,
    groupName: entry.groupName,
    importance: entry.importance,
    source: entry.source,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    hits: entry.hits,
    lastHitAt: entry.lastHitAt,
    summary: excerptOf(entry.body),
  };
}

/** 按更新时间倒序（相同则按 id，保证排序稳定） */
function sortByUpdatedDesc(a, b) {
  const at = Date.parse(a.updatedAt);
  const bt = Date.parse(b.updatedAt);
  const aTime = Number.isFinite(at) ? at : 0;
  const bTime = Number.isFinite(bt) ? bt : 0;
  if (aTime !== bTime) return bTime - aTime;
  return a.id.localeCompare(b.id);
}

/** 从摘要里截取查询附近的片段 */
function makeSnippet(summary, query) {
  const text = asString(summary);
  if (text === '') return '';
  const lower = text.toLowerCase();
  let index = -1;
  let length = 0;
  for (const token of tokenize(query)) {
    const found = lower.indexOf(token);
    if (found >= 0 && token.length > length) {
      index = found;
      length = token.length;
    }
  }
  if (index < 0) {
    return text.length <= 120 ? text : `${text.slice(0, 120)}…`;
  }
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, start + 160);
  const head = start > 0 ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return `${head}${text.slice(start, end)}${tail}`;
}

// ── 文件工具 ──────────────────────────────────────────────────
/** 读取文本，最多读 limit 字节（超大文件只读前缀，避免整读进内存） */
function readTextLimited(file, limit) {
  const stat = fs.statSync(file);
  if (stat.size <= limit) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const read = fs.readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    try {
      fs.closeSync(fd);
    } catch { /* 关闭失败忽略 */ }
  }
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
    try {
      fs.unlinkSync(tmp);
    } catch { /* 清理失败忽略 */ }
    throw err;
  }
}

/** 条目 → 文件文本 */
function serializeEntry(entry) {
  const lines = [
    '---',
    `id: ${serializeScalar(entry.id)}`,
    `kind: ${serializeScalar(entry.kind)}`,
    `title: ${serializeScalar(entry.title)}`,
    `tags: ${serializeArray(entry.tags)}`,
    `scope: ${serializeScalar(entry.scope)}`,
    `groupId: ${serializeScalar(entry.groupId)}`,
    `groupName: ${serializeScalar(entry.groupName)}`,
    `importance: ${clampInt(entry.importance, 0, 3, 0)}`,
    `source: ${serializeScalar(entry.source)}`,
    `status: ${serializeScalar(entry.status || 'approved')}`,
    `createdAt: ${serializeScalar(entry.createdAt)}`,
    `updatedAt: ${serializeScalar(entry.updatedAt)}`,
    `hits: ${clampInt(entry.hits, 0, Number.MAX_SAFE_INTEGER, 0)}`,
    `lastHitAt: ${serializeScalar(entry.lastHitAt)}`,
    `meta: ${JSON.stringify(entry.meta ?? {})}`,
    '---',
  ];
  const body = String(entry.body ?? '');
  const head = lines.join('\n');
  return body === '' ? `${head}\n` : `${head}\n\n${body}\n`;
}

/** 文件文本 → 条目；损坏返回 null */
function parseEntryText(text, fileId, fallbackKind) {
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;
  const data = parsed.data;
  const basedId = asString(fileId) !== '' ? asString(fileId) : asString(data.id);
  if (!ID_RE.test(basedId)) return null;
  const body = parsed.body;
  const groupId = asString(data.groupId);
  return {
    id: basedId,
    kind: normalizeKind(data.kind) || fallbackKind,
    title: clampChars(asString(data.title), MAX_TITLE_CHARS) || deriveTitle(body, basedId),
    body,
    tags: normalizeTags(Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : [])),
    scope: normalizeScope(asString(data.scope)) || (groupId !== '' ? 'group' : 'global'),
    groupId,
    groupName: clampChars(asString(data.groupName), MAX_TITLE_CHARS),
    importance: clampInt(data.importance, 0, 3, 0),
    source: normalizeSource(asString(data.source)) || 'manual',
    status: normalizeStatus(asString(data.status)) || 'approved',
    meta: parseMeta(data.meta),
    createdAt: asIso(data.createdAt) || nowIso(),
    updatedAt: asIso(data.updatedAt) || asIso(data.createdAt) || nowIso(),
    hits: clampInt(data.hits, 0, Number.MAX_SAFE_INTEGER, 0),
    lastHitAt: asIso(data.lastHitAt),
  };
}

/** 扫描 entries 目录（stderr 只 warn，不抛错）；返回完整条目 */
function scanEntryDir(base, storeKind, log) {
  const dir = path.join(base, ENTRIES_DIR);
  const out = [];
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code !== 'ENOENT') log.warn?.('entries-store: 遍历条目目录失败:', err && err.message);
    return out;
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    if (!item.isFile() || item.name.startsWith('.') || !item.name.endsWith('.md')) continue;
    const id = item.name.slice(0, -3);
    if (!ID_RE.test(id)) {
      log.warn?.(`entries-store: 忽略非法条目文件名: ${item.name}`);
      continue;
    }
    let text;
    try {
      text = readTextLimited(path.join(dir, item.name), MAX_READ_BYTES);
    } catch (err) {
      log.warn?.(`entries-store: 读取条目文件失败（${item.name}）:`, err && err.message);
      continue;
    }
    const entry = parseEntryText(text, id, storeKind);
    if (!entry) {
      log.warn?.(`entries-store: 条目文件损坏，已忽略: ${item.name}`);
      continue;
    }
    if (entry.kind !== storeKind) continue;
    out.push(entry);
  }
  return out;
}

/** 校验索引结构；结构不合法返回 null（触发重建） */
function validateIndex(raw, storeKind) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.version !== undefined && raw.version !== INDEX_VERSION) return null;
  if (!Array.isArray(raw.entries)) return null;
  const entries = [];
  for (const item of raw.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = asString(item.id);
    if (!ID_RE.test(id)) continue;
    entries.push({
      id,
      title: asString(item.title),
      tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [],
      scope: normalizeScope(asString(item.scope)) || 'global',
      groupId: asString(item.groupId),
      groupName: asString(item.groupName),
      importance: clampInt(item.importance, 0, 3, 0),
      source: normalizeSource(asString(item.source)) || 'manual',
      status: normalizeStatus(asString(item.status)) || 'approved',
      createdAt: asString(item.createdAt),
      updatedAt: asString(item.updatedAt),
      hits: clampInt(item.hits, 0, Number.MAX_SAFE_INTEGER, 0),
      lastHitAt: asString(item.lastHitAt),
      summary: asString(item.summary),
    });
  }
  return { version: INDEX_VERSION, kind: storeKind, updatedAt: asString(raw.updatedAt) || nowIso(), entries };
}

/** 全量重建索引（不写盘，由调用方决定） */
function buildIndex(base, storeKind, log) {
  const entries = scanEntryDir(base, storeKind, log).map(summaryOf);
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { version: INDEX_VERSION, kind: storeKind, updatedAt: nowIso(), entries };
}

/** 写索引（原子写 + 清除 .index-dirty） */
function writeIndexFile(base, index) {
  const payload = {
    version: INDEX_VERSION,
    kind: index.kind,
    updatedAt: index.updatedAt || nowIso(),
    entries: Array.isArray(index.entries) ? index.entries : [],
  };
  writeAtomic(path.join(base, INDEX_FILE), `${JSON.stringify(payload, null, 2)}\n`);
  try {
    fs.unlinkSync(path.join(base, DIRTY_FILE));
  } catch { /* 标记不存在或清理失败忽略 */ }
}

/**
 * 创建通用条目库。
 * @param {{dir?: string|(() => string), kind?: string, logger?: any}} options
 */
export function createEntryStore({ dir, kind, logger } = {}) {
  const log = logger ?? console;
  const storeKind = normalizeKind(kind) || 'entry';
  /** dirKey = 缓存对应目录；index = null 表示未加载 */
  let state = { dirKey: '', index: null };
  let flushTimer = null;

  /** 当前目录（每次读取，支持设置热改）；缺省 <cwd>/<kind> */
  function currentDir() {
    let raw;
    try {
      raw = typeof dir === 'function' ? dir() : dir;
    } catch (err) {
      log.warn?.('entries-store: 解析目录失败，使用默认目录:', err && err.message);
      raw = '';
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    return text === '' ? path.join(process.cwd(), storeKind) : path.resolve(text);
  }

  /** 目录字符串（绝对路径） */
  function dirPath() {
    return currentDir();
  }

  function entriesDir(base = currentDir()) {
    return path.join(base, ENTRIES_DIR);
  }

  function entryFile(id, base = currentDir()) {
    return path.join(entriesDir(base), `${id}.md`);
  }

  // ── 索引加载 / 重建 / 写盘 ──────────────────────────────────
  function loadIndex() {
    const base = currentDir();
    if (state.index !== null && state.dirKey === base) return state.index;
    state.dirKey = base;
    state.index = loadOrRebuildIndex(base);
    return state.index;
  }

  function loadOrRebuildIndex(base) {
    const dir = entriesDir(base);
    if (!fs.existsSync(dir)) return { version: INDEX_VERSION, kind: storeKind, updatedAt: '', entries: [] };
    // 存在延迟写标记：索引落后于条目文件，按文件全量重建（进程崩溃恢复路径）
    if (fs.existsSync(path.join(base, DIRTY_FILE))) {
      const rebuilt = buildIndex(base, storeKind, log);
      try {
        writeIndexFile(base, rebuilt);
      } catch (err) {
        log.warn?.('entries-store: 重建后写索引失败:', err && err.message);
      }
      return rebuilt;
    }
    const file = path.join(base, INDEX_FILE);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') log.warn?.('entries-store: 读取 index.json 失败:', err.message);
      const rebuilt = buildIndex(base, storeKind, log);
      try {
        writeIndexFile(base, rebuilt);
      } catch (writeErr) {
        log.warn?.('entries-store: 写索引失败:', writeErr && writeErr.message);
      }
      return rebuilt;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn?.('entries-store: index.json 损坏，已备份并按条目文件重建:', err && err.message);
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch { /* 备份失败不影响主流程 */ }
      const rebuilt = buildIndex(base, storeKind, log);
      try {
        writeIndexFile(base, rebuilt);
      } catch (writeErr) {
        log.warn?.('entries-store: 写索引失败:', writeErr && writeErr.message);
      }
      return rebuilt;
    }
    if (parsed && typeof parsed === 'object' && parsed.kind && parsed.kind !== storeKind) {
      const rebuilt = buildIndex(base, storeKind, log);
      try {
        writeIndexFile(base, rebuilt);
      } catch (err) {
        log.warn?.('entries-store: 写索引失败:', err && err.message);
      }
      return rebuilt;
    }
    const index = validateIndex(parsed, storeKind);
    if (index) return index;
    log.warn?.('entries-store: index.json 结构不合法，按条目文件重建');
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch { /* 备份失败忽略 */ }
    const rebuilt = buildIndex(base, storeKind, log);
    try {
      writeIndexFile(base, rebuilt);
    } catch (err) {
      log.warn?.('entries-store: 写索引失败:', err && err.message);
    }
    return rebuilt;
  }

  /** 延迟写：标记 + 防抖 flush（定时器 unref，不阻塞进程退出；崩溃后靠标记重建） */
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try {
        flush();
      } catch (err) {
        log.warn?.('entries-store: 延迟写索引失败:', err && err.message);
      }
    }, FLUSH_DELAY_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  /**
   * 立即写索引（把内存缓存落到它所属的目录，避免目录热改后写错位置）。
   * 目录已被删除（工作区被移除 / 测试清理）时只丢弃缓存，不重建目录。
   */
  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (state.index === null || state.dirKey === '') return { ok: true, flushed: false };
    if (!fs.existsSync(state.dirKey)) {
      state = { dirKey: '', index: null };
      return { ok: true, flushed: false, missing: true };
    }
    writeIndexFile(state.dirKey, state.index);
    return { ok: true, flushed: true };
  }

  /** 索引变更落盘；defer=true 时只落标记 + 延迟 flush */
  function persistIndex(defer) {
    if (defer) {
      const base = currentDir();
      try {
        fs.mkdirSync(base, { recursive: true });
        const dirty = path.join(base, DIRTY_FILE);
        if (!fs.existsSync(dirty)) writeAtomic(dirty, '');
      } catch (err) {
        log.warn?.('entries-store: 写延迟标记失败:', err && err.message);
      }
      scheduleFlush();
      return;
    }
    writeIndexFile(currentDir(), loadIndex());
  }

  function upsertIndexEntry(entry, defer) {
    const index = loadIndex();
    const item = summaryOf(entry);
    const at = index.entries.findIndex((row) => row.id === item.id);
    if (at >= 0) index.entries[at] = item;
    else index.entries.push(item);
    index.entries.sort((a, b) => a.id.localeCompare(b.id));
    index.updatedAt = nowIso();
    persistIndex(defer === true);
  }

  // ── 校验 ────────────────────────────────────────────────────
  function validateId(raw) {
    const id = asString(raw).trim();
    if (id === '') throw new Error('entries-store: id 不能为空');
    if (!ID_RE.test(id)) throw new Error(`entries-store: 非法 id: ${raw}`);
    return id;
  }

  function newId() {
    const prefix = ID_PREFIX[storeKind] || 'e';
    for (let i = 0; i < 5; i += 1) {
      const id = `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      if (!fs.existsSync(entryFile(id))) return id;
    }
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  // ── 对外 API ────────────────────────────────────────────────
  /** 确保根目录与 entries 目录存在；索引缺失时顺手重建 */
  function ensure() {
    const base = currentDir();
    const existed = fs.existsSync(base);
    fs.mkdirSync(entriesDir(base), { recursive: true });
    if (!fs.existsSync(path.join(base, INDEX_FILE))) {
      try {
        writeIndexFile(base, buildIndex(base, storeKind, log));
      } catch (err) {
        log.warn?.('entries-store: 初始化索引失败:', err && err.message);
      }
    }
    return { ok: true, created: !existed };
  }

  /** 读取一个条目；不存在/损坏返回 null，id 非法抛错 */
  function get(id) {
    const safe = validateId(id);
    let text;
    try {
      text = readTextLimited(entryFile(safe), MAX_READ_BYTES);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      log.warn?.(`entries-store: 读取条目失败（${safe}）:`, err && err.message);
      return null;
    }
    const entry = parseEntryText(text, safe, storeKind);
    if (!entry) {
      log.warn?.(`entries-store: 条目文件损坏，已忽略: ${safe}.md`);
      return null;
    }
    return entry;
  }

  /**
   * 保存条目（无 id = 新建；有 id = 更新，保留 createdAt / hits）。
   * @param {object} input 条目字段
   * @param {{deferIndex?: boolean}} [options] deferIndex=true 时延迟写索引（群友库 visit 用）
   * @returns {object} 完整条目
   */
  function save(input = {}, options = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('entries-store: save 参数必须是对象');
    }
    ensure();
    const hasId = asString(input.id).trim() !== '';
    const existing = hasId ? get(input.id) : null;
    const id = existing ? existing.id : (hasId ? validateId(input.id) : newId());
    const now = nowIso();

    const pick = (key, fallback) => (input[key] !== undefined ? input[key] : fallback);
    const body = normalizeBody(pick('body', existing?.body ?? ''));
    const groupId = asString(pick('groupId', existing?.groupId ?? ''));
    const scope = normalizeScope(asString(pick('scope', existing?.scope))) || (groupId !== '' ? 'group' : 'global');
    const title = clampChars(asString(pick('title', existing?.title ?? '')), MAX_TITLE_CHARS) || deriveTitle(body, id);
    const tags = normalizeTags(pick('tags', existing?.tags ?? []));
    const entry = {
      id,
      kind: normalizeKind(input.kind) || existing?.kind || storeKind,
      title,
      body,
      tags,
      scope,
      groupId,
      groupName: clampChars(asString(pick('groupName', existing?.groupName ?? '')), MAX_TITLE_CHARS),
      importance: clampInt(pick('importance', existing?.importance), 0, 3, 0),
      source: normalizeSource(asString(pick('source', existing?.source))) || 'manual',
      status: normalizeStatus(asString(pick('status', existing?.status))) || 'approved',
      meta: normalizeMeta(pick('meta', existing?.meta)),
      createdAt: asIso(pick('createdAt', existing?.createdAt)) || now,
      updatedAt: now,
      hits: clampInt(pick('hits', existing?.hits), 0, Number.MAX_SAFE_INTEGER, 0),
      lastHitAt: asIso(pick('lastHitAt', existing?.lastHitAt)),
    };

    const text = serializeEntry(entry);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`entries-store: 条目文件超过 ${MAX_FILE_BYTES} 字节（当前 ${bytes}），请精简正文`);
    }
    writeAtomic(entryFile(id), text);
    upsertIndexEntry(entry, options.deferIndex === true);
    return entry;
  }

  /** 删除条目，返回 {ok, id, removed} */
  function remove(id) {
    const safe = validateId(id);
    let removed = false;
    try {
      fs.unlinkSync(entryFile(safe));
      removed = true;
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
    const index = loadIndex();
    const before = index.entries.length;
    index.entries = index.entries.filter((row) => row.id !== safe);
    if (index.entries.length !== before) index.updatedAt = nowIso();
    persistIndex(false);
    return { ok: true, id: safe, removed };
  }

  /**
   * 列出条目（摘要，不含正文）。
   * @param {{q?:string, tag?:string, scope?:string, groupId?:string, limit?:number, offset?:number}} options
   */
  function list(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const query = asString(opts.q);
    const tag = asString(opts.tag);
    const scope = normalizeScope(asString(opts.scope));
    const status = normalizeStatus(asString(opts.status));
    const groupId = asString(opts.groupId);
    const index = loadIndex();
    let rows = index.entries.filter((row) => {
      if (status !== '' && row.status !== status) return false;
      if (tag !== '' && !row.tags.includes(tag)) return false;
      if (scope !== '' && row.scope !== scope) return false;
      if (groupId !== '' && row.groupId !== groupId && row.scope !== 'global') return false;
      return true;
    });
    if (query !== '') {
      rows = rows
        .map((row) => ({ row, matched: matchScore(query, row) }))
        .filter((item) => item.matched > 0)
        .map((item) => ({
          row: item.row,
          score: item.matched + item.row.importance * 0.5 + recencyScore(item.row.updatedAt) * 1.5,
        }))
        .sort((a, b) => b.score - a.score || sortByUpdatedDesc(a.row, b.row))
        .map((item) => item.row);
    } else {
      rows = [...rows].sort(sortByUpdatedDesc);
    }
    const total = rows.length;
    const offset = clampInt(opts.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = clampInt(opts.limit, 1, 200, 20);
    return { total, items: rows.slice(offset, offset + limit).map((row) => ({ ...row, tags: [...row.tags] })) };
  }

  /**
   * 检索：返回 [{id,title,tags,score,snippet}]。
   * @param {string} query 查询串（中文按 2-gram、英文按词匹配）
   * @param {{limit?:number, scope?:string, groupId?:string}} [options]
   */
  function search(query, options = {}) {
    const queryText = asString(query);
    if (queryText.trim() === '') return [];
    const opts = options && typeof options === 'object' ? options : {};
    const scope = normalizeScope(asString(opts.scope));
    const groupId = asString(opts.groupId);
    const limit = clampInt(opts.limit, 1, 50, 8);
    const index = loadIndex();
    const matches = [];
    for (const row of index.entries) {
      // 待确认条目不参与检索/注入，避免未经人工确认的自动内容影响回答
      if (row.status === 'pending') continue;
      if (scope !== '' && row.scope !== scope) continue;
      if (groupId !== '' && row.groupId !== groupId && row.scope !== 'global') continue;
      const base = matchScore(queryText, row);
      if (base <= 0) continue;
      matches.push({ row, score: round3(base + row.importance * 0.5 + recencyScore(row.updatedAt) * 1.5) });
    }
    matches.sort((a, b) => b.score - a.score || sortByUpdatedDesc(a.row, b.row));
    return matches.slice(0, limit).map(({ row, score }) => ({
      id: row.id,
      title: row.title,
      tags: [...row.tags],
      score,
      snippet: makeSnippet(row.summary, queryText),
    }));
  }

  /**
   * 相关性召回（供每轮上下文注入）：作用域优先级 当前群 > global > 其它群（其它群默认不返回）。
   * @param {{query?:string, scope?:string, groupId?:string, limit?:number}|string} input
   * @returns {Array<object>} 完整条目 + score
   */
  function recall(input = {}) {
    const opts = typeof input === 'string' ? { query: input } : (input && typeof input === 'object' ? input : {});
    const query = asString(opts.query);
    const groupId = asString(opts.groupId);
    const scope = normalizeScope(asString(opts.scope));
    const limit = clampInt(opts.limit, 1, 50, 6);
    const index = loadIndex();
    const rows = [];
    for (const row of index.entries) {
      if (row.status === 'pending') continue;
      // 1) 作用域过滤：当前群/私聊命中 > global > 其它群（默认不返回）
      let scopeRank;
      if (row.scope === 'group' && groupId !== '' && row.groupId === groupId) scopeRank = 3;
      else if (row.scope === 'c2c' && scope === 'c2c') scopeRank = 3;
      else if (row.scope === 'global') scopeRank = 2;
      else continue;
      // scope 只表达“本轮上下文类型”：group/c2c 上下文里 global 条目仍然有效（仅在显式 scope=global 时收紧）
      if (scope === 'global' && row.scope !== 'global') continue;
      // 2) 词面/标签匹配
      const coverage = query === '' ? 0 : matchScore(query, row);
      if (query !== '' && coverage <= 0) continue;
      const score = coverage * 10 + scopeRank * 4 + row.importance * 0.6 + recencyScore(row.updatedAt) * 1.5;
      rows.push({ row, scopeRank, score: round3(score) });
    }
    rows.sort((a, b) => b.score - a.score || b.scopeRank - a.scopeRank || a.row.id.localeCompare(b.row.id));
    const out = [];
    for (const item of rows.slice(0, limit)) {
      const entry = get(item.row.id);
      if (!entry) continue;
      out.push({ ...entry, score: item.score });
    }
    return out;
  }

  /** 统计：{total, byScope, tags:[{tag,count}], updatedAt} */
  function stats() {
    const index = loadIndex();
    const byScope = {};
    for (const scope of SCOPES) byScope[scope] = 0;
    const tagCount = new Map();
    let updatedAt = '';
    for (const row of index.entries) {
      byScope[row.scope] = (byScope[row.scope] ?? 0) + 1;
      for (const tag of row.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
      if (row.updatedAt > updatedAt) updatedAt = row.updatedAt;
    }
    const tags = [...tagCount.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    const pending = index.entries.filter((row) => row.status === 'pending').length;
    return { total: index.entries.length, pending, byScope, tags, updatedAt: updatedAt || index.updatedAt || '' };
  }

  /** 群聚合：{groupId, count, name}（知识库用；群友库自行按 meta.groups 聚合） */
  function groups() {
    const index = loadIndex();
    const map = new Map();
    for (const row of index.entries) {
      if (row.groupId === '') continue;
      const item = map.get(row.groupId) || { groupId: row.groupId, count: 0, name: '' };
      item.count += 1;
      if (row.groupName !== '') item.name = row.groupName;
      map.set(row.groupId, item);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.groupId.localeCompare(b.groupId));
  }

  /** 全部条目（完整内容，群友库加载内存缓存用） */
  function all() {
    return scanEntryDir(currentDir(), storeKind, log);
  }

  /** 记录一次命中（hits + 1 / lastHitAt = now）；条目不存在返回 null */
  function noteHit(id) {
    const entry = get(id);
    if (!entry) return null;
    return save({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      tags: entry.tags,
      scope: entry.scope,
      groupId: entry.groupId,
      groupName: entry.groupName,
      importance: entry.importance,
      source: entry.source,
      meta: entry.meta,
      createdAt: entry.createdAt,
      hits: entry.hits + 1,
      lastHitAt: nowIso(),
    });
  }

  /** 按条目文件全量重建索引（写盘） */
  function rebuild() {
    const base = currentDir();
    const index = buildIndex(base, storeKind, log);
    try {
      writeIndexFile(base, index);
    } catch (err) {
      log.warn?.('entries-store: 写索引失败:', err && err.message);
    }
    state = { dirKey: base, index };
    return index;
  }

  /** 丢弃内存缓存（目录/外部变更后重新加载） */
  function reload() {
    try {
      flush();
    } catch (err) {
      log.warn?.('entries-store: reload 前 flush 失败:', err && err.message);
    }
    state = { dirKey: '', index: null };
    return { ok: true };
  }

  return {
    dir: dirPath,
    kind: () => storeKind,
    ensure,
    get,
    save,
    remove,
    list,
    search,
    recall,
    stats,
    groups,
    all,
    noteHit,
    rebuild,
    reload,
    flush,
  };
}

export default createEntryStore;
