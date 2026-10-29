/**
 * memory/store —— self-improve 长期记忆的文件层（同步 API、原子写）。
 *
 * 文件布局（root = settings.memory.dir）：
 * - MEMORY.md           热记忆，每条一行 `- [YYYY-MM-DD] 文本（#tag）`，注入 prompt 用；
 *                       最多保留 800 条，超出从最旧裁剪（index.json 不受影响）。
 * - notes/YYYY-MM-DD.md  当日全量记录，带时间与来源，供 search/read。
 * - index.json          去重索引 {version:1, facts:[{hash,text,tags,at,file}]}；
 *                       hash = sha256(normalize(text)).slice(0,16)。
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
const INDEX_VERSION = 1;

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
  function validateIndex(raw) {
    const facts = [];
    const list = raw && Array.isArray(raw.facts) ? raw.facts : [];
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const hash = typeof item.hash === 'string' ? item.hash : '';
      const text = typeof item.text === 'string' ? item.text : '';
      if (hash === '' || text === '') continue;
      const tags = Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === 'string') : [];
      facts.push({
        hash,
        text,
        tags,
        at: typeof item.at === 'string' ? item.at : '',
        file: typeof item.file === 'string' ? item.file : '',
      });
    }
    return { version: INDEX_VERSION, facts };
  }

  /** 读取去重索引；文件不存在/损坏时回退空索引（坏文件先备份） */
  function loadIndex() {
    const file = path.join(root(), INDEX_FILE);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') log.warn?.('读取 index.json 失败:', err.message);
      return { version: INDEX_VERSION, facts: [] };
    }
    try {
      return validateIndex(JSON.parse(raw));
    } catch (err) {
      log.warn?.('index.json 损坏，已回退为空索引:', err && err.message);
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch { /* 备份失败不影响主流程 */ }
      return { version: INDEX_VERSION, facts: [] };
    }
  }

  function saveIndex(index) {
    writeAtomic(
      path.join(root(), INDEX_FILE),
      JSON.stringify({ version: INDEX_VERSION, facts: index.facts }, null, 2) + '\n',
    );
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
   * @returns {{ok:boolean, duplicate:boolean, file:string, entry:string, path:string}}
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
    const existing = index.facts.find((f) => f.hash === hash);
    if (existing) {
      const file = existing.file || '';
      return {
        ok: true,
        duplicate: true,
        file,
        entry: existing.text,
        path: file === '' ? root() : joinRelative(root(), file),
      };
    }

    const now = new Date();
    const date = formatDate(now);
    const dailyRel = `${NOTES_DIR}/${date}.md`;
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
    writeAtomic(memoryAbs, `${hotLines.join('\n')}\n`);

    // 3) 去重索引（裁剪 MEMORY.md 时 index 保留，保证之后仍能识别重复）
    index.facts.push({ hash, text: cleaned, tags, at: now.toISOString(), file: dailyRel });
    saveIndex(index);

    return { ok: true, duplicate: false, file: dailyRel, entry: memoryLine, path: dailyAbs };
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

  /** 读取去重索引（返回副本） */
  function index() {
    return loadIndex();
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
  };
}
