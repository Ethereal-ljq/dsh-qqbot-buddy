/**
 * stickers/store —— 可发送表情包库的文件层（同步 API、原子写）。
 *
 * 目录布局（root = settings.stickers.dir）：
 * - <root>/<name>.png|.jpg|.jpeg|.gif|.webp  表情图片本体（只认这五种扩展名）；
 * - <root>/index.json                       元数据 {version:1, items:{name:{emotion,tags,note,addedAt,source,hash}}}；
 *                                           addedAt 为 epoch 毫秒（与 UI 路由 items.addedAt 数值契约一致）；
 *                                           hash = sha256(图片内容) 前 16 位，用于内容去重；
 *                                           原子写（tmp + rename，权限 0600）。
 *
 * 设计约束：
 * - 全部同步 fs：list/catalog 被 prompt 每轮组装调用，工具与 UI 路由也共用；
 *   同步 + 单线程保证进程内不会互相踩写；跨进程仍靠 tmp+rename 原子替换兜底。
 * - 文件名一律 basename：拒绝 .. / 斜杠 / 反斜杠 / 控制字符 / 隐藏文件，只允许图片扩展名；
 *   读/改/删前用 realpath 校验真实路径仍落在表情包目录内（防符号链接逃逸）。
 * - 图片类型只信 magic bytes（png/jpeg/gif/webp），不信扩展名；大小 <= settings.stickers.maxMB。
 * - 没有元数据的历史文件（手工放进目录的图片）也算表情包：
 *   emotion 取「文件名去扩展名」，source 标记 legacy，list 时与 index 合并。
 * - 内容去重：saveBuffer 先算 buffer 的 sha256 前 16 位，扫描现有条目（历史文件按需读文件
 *   补算 hash，进程内缓存 Map<name,{size,mtimeMs,hash}>，文件变化自动失效）——命中则返回
 *   {ok:true, duplicate:true, name:已有名, item}，不写文件也不改 index。
 * - 每日配额：countAddedSince(24h) 与 settings.stickers.dailyLimit（默认 10，1..100）供
 *   collectQuota() 使用；配额只由工具层对 source='tool' 的收藏执行，API 上传不受限制。
 * - 错误尽量返回 {ok:false, error}（与 DESIGN 契约一致），不抛给路由；
 *   只有 read() 按契约返回 Buffer，失败时抛带 code 的 Error，由路由转 400/404。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

/** 允许的表情图片扩展名（小写） */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/** 元数据文件名（目录内保留，不作为表情展示） */
const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;
/** 文件名长度上限（含扩展名） */
const MAX_NAME_CHARS = 120;
/** emotion / note / tag 的长度上限 */
const MAX_EMOTION_CHARS = 40;
const MAX_NOTE_CHARS = 300;
const MAX_TAGS = 8;
const MAX_TAG_CHARS = 24;
const MAX_SOURCE_CHARS = 24;
/** 内容去重指纹长度：sha256 前 16 位 */
const HASH_CHARS = 16;
/** 每日收藏配额默认值（settings.stickers.dailyLimit 归一化后为 1..100） */
const DEFAULT_DAILY_LIMIT = 10;
/** 配额统计窗口：最近 24 小时 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** 计算历史文件 hash 时的读块大小 */
const HASH_CHUNK_BYTES = 64 * 1024;

// ── 小工具 ────────────────────────────────────────────────────
/** 安全取日志方法（logger 失败不能影响主流程） */
function warn(logger, ...args) {
  try {
    (logger ?? console).warn?.(...args);
  } catch { /* 忽略 */ }
}

/** 按码点截断，避免切坏 emoji 等代理对 */
function clampText(text, max) {
  if (max <= 0 || text === '') return '';
  if (text.length <= max) return text;
  return [...text].slice(0, max).join('');
}

/** 去掉首尾与连续空白，统一成单行 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 图片扩展名归一化：.jpeg 视作 .jpg（同一格式，允许互改） */
function extGroup(ext) {
  const e = String(ext ?? '').toLowerCase();
  return e === '.jpeg' ? '.jpg' : e;
}

/**
 * magic bytes 嗅探：只信任文件头，返回 {ext, mime} 或 null。
 * 最小样本可能只有 8 字节（PNG 魔数），因此各格式分别判断长度。
 */
function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const len = buffer.length;
  if (len >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (len >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (len >= 6) {
    const head6 = buffer.toString('latin1', 0, 6);
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return { ext: '.gif', mime: 'image/gif' };
  }
  if (len >= 12
    && buffer.toString('latin1', 0, 4) === 'RIFF'
    && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

/** 把 Buffer / Uint8Array / ArrayBuffer 统一成 Buffer；其它返回 null */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return null;
}

/** 读取文件头若干字节（rename 前校验真实图片格式，避免扩展名与内容不符） */
function readHead(file, length = 32) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    try { fs.closeSync(fd); } catch { /* 关闭失败忽略 */ }
  }
}

/** 内容指纹：sha256 前 16 位（十六进制小写），用于表情内容去重 */
function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, HASH_CHARS);
}

/** hash 字段归一化：只接受 16 位小写十六进制，其它一律视为无 hash */
function normalizeHash(raw) {
  if (typeof raw !== 'string') return '';
  const hash = raw.trim().toLowerCase();
  return /^[0-9a-f]{16}$/.test(hash) ? hash : '';
}

/** 是否位于 root 内（含 root 本身） */
function isWithinRoot(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ── 字段归一化 ────────────────────────────────────────────────
function normEmotion(input) {
  return clampText(oneLine(input), MAX_EMOTION_CHARS);
}

function normNote(input) {
  if (input === undefined || input === null) return '';
  return clampText(String(input).replace(/\r\n?/g, '\n').trim(), MAX_NOTE_CHARS);
}

function normTags(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = clampText(oneLine(raw).replace(/^#+/, ''), MAX_TAG_CHARS);
    if (tag === '' || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function normSource(input) {
  const source = clampText(oneLine(input), MAX_SOURCE_CHARS);
  return source === '' ? 'manual' : source;
}

/**
 * 表情文件名校验：必须是裸 basename + 允许的图片扩展名。
 * @returns {{ok:true,name:string,ext:string,stem:string}|{ok:false,error:string}}
 */
function validateName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '文件名必须是字符串' };
  const name = raw.trim();
  if (name === '') return { ok: false, error: '文件名不能为空' };
  if (name.length > MAX_NAME_CHARS) return { ok: false, error: `文件名过长（最多 ${MAX_NAME_CHARS} 字符）` };
  if (name.includes('\0')) return { ok: false, error: '文件名包含非法字符' };
  if (name.includes('/') || name.includes('\\')) return { ok: false, error: `文件名只允许 basename，不能包含路径分隔符: ${name}` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: '文件名包含控制字符' };
  if (name === '.' || name === '..' || name.startsWith('.')) {
    return { ok: false, error: `不允许隐藏文件或 . / .. 开头的文件名: ${name}` };
  }
  if (path.basename(name) !== name) return { ok: false, error: `文件名只允许 basename: ${name}` };
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) {
    return { ok: false, error: `只允许图片扩展名（png/jpg/jpeg/gif/webp）: ${name}` };
  }
  const stem = name.slice(0, name.length - ext.length);
  if (stem === '') return { ok: false, error: `文件名缺少主体: ${name}` };
  return { ok: true, name, ext, stem };
}

/** 把任意文本变成安全文件名片段（用于默认命名里的 emotion 前缀） */
function sanitizeSegment(text, fallback) {
  const cleaned = String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_EMOTION_CHARS);
  return cleaned === '' ? fallback : cleaned;
}

/** 4 位随机十六进制后缀 */
function randomSuffix() {
  return randomBytes(2).toString('hex');
}

/** 收藏时间归一化成 epoch 毫秒（兼容手写 index 里的 ISO 字符串） */
function normalizeAddedAt(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** index.json 里的单条元数据（结构严格对齐 DESIGN；addedAt 为 epoch 毫秒） */
function normalizeMeta(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    emotion: normEmotion(src.emotion),
    tags: normTags(src.tags),
    note: normNote(src.note),
    addedAt: normalizeAddedAt(src.addedAt),
    source: clampText(oneLine(src.source), MAX_SOURCE_CHARS),
    hash: normalizeHash(src.hash),
  };
}

// ── 主入口 ────────────────────────────────────────────────────
/**
 * 创建表情包文件层。
 * @param {{settings: {get: () => any}, logger?: any}} options
 */
export function createStickerStore({ settings, logger } = {}) {
  const log = logger ?? console;
  /**
   * 历史文件（index 里没有 hash）的指纹缓存：name → { size, mtimeMs, hash }。
   * 命中后 list/get/去重扫描都不再重复读文件；文件大小或 mtime 变化时自动重新计算。
   * 刻意不落盘：避免每次收藏都重写 index，进程重启后按需重算即可。
   */
  const legacyHashes = new Map();

  /** 当前 settings.stickers 段（每次读取，设置页改目录后立即生效） */
  function cfg() {
    try {
      const s = typeof settings?.get === 'function' ? settings.get() : {};
      return s && typeof s.stickers === 'object' && s.stickers !== null ? s.stickers : {};
    } catch (err) {
      warn(log, '读取 stickers 设置失败，使用默认值:', err && err.message);
      return {};
    }
  }

  /** 表情包目录绝对路径（不创建） */
  function dir() {
    const configured = cfg().dir;
    if (typeof configured === 'string' && configured.trim() !== '' && !configured.includes('\0')) {
      return path.resolve(configured.trim());
    }
    return path.join(process.cwd(), 'stickers');
  }

  /** 单张表情大小上限（字节；settings.stickers.maxMB 已归一化到 1..50，这里再兜底一次） */
  function maxBytes() {
    const mb = Number(cfg().maxMB);
    const normalized = Number.isFinite(mb) ? Math.min(50, Math.max(1, Math.round(mb))) : 8;
    return normalized * 1024 * 1024;
  }

  /** 分块读文件算 sha256 前 16 位（历史文件可能较大，避免一次性整读进内存） */
  function hashFile(file) {
    const hash = createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
      const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
      let read;
      while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
        hash.update(chunk.subarray(0, read));
      }
    } finally {
      try { fs.closeSync(fd); } catch { /* 关闭失败忽略 */ }
    }
    return hash.digest('hex').slice(0, HASH_CHARS);
  }

  /** 取某个表情图片的 hash：index 有就用；历史文件按需读文件补算并缓存 */
  function imageHash(name, abs, stat) {
    const cached = legacyHashes.get(name);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.hash;
    let hash = '';
    try {
      hash = hashFile(abs);
    } catch (err) {
      warn(log, '计算表情 hash 失败（' + name + '）:', err && err.message);
      return '';
    }
    legacyHashes.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
    return hash;
  }

  /** 内部使用：确保目录存在，失败抛给调用方 */
  function ensureDirOrThrow() {
    const base = dir();
    fs.mkdirSync(base, { recursive: true });
    return base;
  }

  /** 确保表情包目录存在（不抛错） */
  function ensure() {
    const base = dir();
    const existed = fs.existsSync(base);
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch (err) {
      return { ok: false, error: 'ensure: 创建表情包目录失败: ' + (err && err.message), created: false };
    }
    return { ok: true, created: !existed };
  }

  /** 原子写：同目录临时文件 + rename，权限 0o600；失败清理临时文件 */
  function writeAtomic(file, data) {
    const parent = path.dirname(file);
    fs.mkdirSync(parent, { recursive: true });
    const tmp = path.join(
      parent,
      '.' + path.basename(file) + '.tmp-' + process.pid + '-' + Date.now() + '-' + randomSuffix(),
    );
    try {
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
      throw err;
    }
  }

  // ── index.json ──────────────────────────────────────────────
  /** 读取并校验 index；文件不存在 → 空索引 */
  function loadIndex() {
    const file = path.join(dir(), INDEX_FILE);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') warn(log, '读取表情包 index.json 失败:', err && err.message);
      return { version: INDEX_VERSION, items: {} };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      warn(log, '表情包 index.json 损坏，已回退为空索引:', err && err.message);
      try {
        fs.renameSync(file, file + '.corrupt-' + Date.now());
      } catch { /* 备份失败不影响主流程 */ }
      return { version: INDEX_VERSION, items: {} };
    }
    const items = {};
    const srcItems = parsed && typeof parsed.items === 'object' && parsed.items !== null && !Array.isArray(parsed.items)
      ? parsed.items
      : {};
    for (const [name, meta] of Object.entries(srcItems)) {
      if (!validateName(name).ok) continue; // 丢弃非法文件名条目（防御手工改坏 index）
      items[name] = normalizeMeta(meta);
    }
    return { version: INDEX_VERSION, items };
  }

  function saveIndex(index) {
    const body = JSON.stringify({ version: INDEX_VERSION, items: index.items }, null, 2) + '\n';
    writeAtomic(path.join(dir(), INDEX_FILE), body);
  }

  /** 删除某个 name 的索引条目（best effort） */
  function cleanupIndexKey(name) {
    try {
      const index = loadIndex();
      if (!index.items[name]) return;
      delete index.items[name];
      saveIndex(index);
    } catch (err) {
      warn(log, '同步表情包索引失败:', err && err.message);
    }
  }

  // ── 展示对象 ────────────────────────────────────────────────
  /** 合并「index 元数据 + 磁盘 stat」成 list/get 的展示对象（含内容 hash） */
  function shapeItem(name, abs, stat, meta) {
    const ext = path.extname(name).toLowerCase();
    const stem = name.slice(0, name.length - ext.length);
    const m = meta && typeof meta === 'object' ? meta : {};
    const addedAt = typeof m.addedAt === 'number' && Number.isFinite(m.addedAt) && m.addedAt > 0
      ? m.addedAt
      : Math.round(stat.mtimeMs);
    const metaHash = normalizeHash(m.hash);
    return {
      name,
      path: abs,
      size: stat.size,
      mtime: stat.mtimeMs,
      emotion: typeof m.emotion === 'string' && m.emotion !== '' ? m.emotion : stem,
      tags: Array.isArray(m.tags) ? [...m.tags] : [],
      note: typeof m.note === 'string' ? m.note : '',
      addedAt,
      source: typeof m.source === 'string' && m.source !== '' ? m.source : 'legacy',
      hash: metaHash !== '' ? metaHash : imageHash(name, abs, stat),
    };
  }

  /** 在现有表情（index + 磁盘历史文件）中查找相同内容 hash；找不到返回 undefined */
  function findByHash(hash) {
    if (hash === '') return undefined;
    return list().find((item) => item.hash === hash);
  }

  // ── 对外 API ────────────────────────────────────────────────
  /** 读取 index.json（返回带 version 的副本） */
  function index() {
    return loadIndex();
  }

  /**
   * 列出全部表情（磁盘图片 + index 元数据合并；无元数据的历史文件 emotion=文件名去扩展名）。
   * 目录不存在/读取失败时返回 []，不抛错。
   */
  function list() {
    const base = dir();
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (err) {
      if (!err || err.code !== 'ENOENT') warn(log, '读取表情包目录失败:', err && err.message);
      return [];
    }
    const indexData = loadIndex();
    const items = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue; // 跳过目录与符号链接
      const name = entry.name;
      if (name.startsWith('.')) continue; // 隐藏文件 / 原子写残留
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue; // index.json 等内部文件不展示
      const abs = path.join(base, name);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch { continue; }
      if (!stat.isFile()) continue;
      items.push(shapeItem(name, abs, stat, indexData.items[name] || {}));
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
  }

  /**
   * prompt 注入用的目录摘要："name=emotion, ..."（name 含扩展名，方便直接拼 absolute path）。
   * @param {number} maxItems 最多条数（默认 48）
   */
  function catalog(maxItems = 48) {
    let max = Number(maxItems);
    if (!Number.isFinite(max)) max = 48;
    max = Math.floor(max);
    if (max <= 0) return '';
    return list()
      .slice(0, max)
      .map((item) => item.name + '=' + item.emotion)
      .join(', ');
  }

  /** 取单个表情（非法/不存在返回 undefined） */
  function get(name) {
    const checked = validateName(name);
    if (!checked.ok) return undefined;
    const base = dir();
    const abs = path.join(base, checked.name);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return undefined;
    }
    if (!isWithinRoot(real, base)) return undefined; // 符号链接逃逸
    let stat;
    try {
      stat = fs.statSync(real);
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;
    return shapeItem(checked.name, abs, stat, loadIndex().items[checked.name] || {});
  }

  /**
   * 读取表情图片二进制（契约返回 Buffer）。
   * 失败抛 Error（带 code: EINVAL / ENOENT / ETOOBIG），由路由转 400/404。
   */
  function read(name) {
    const checked = validateName(name);
    if (!checked.ok) {
      const error = new Error('sticker-store: ' + checked.error);
      error.code = 'EINVAL';
      throw error;
    }
    const base = dir();
    const abs = path.join(base, checked.name);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch (err) {
      const error = new Error('sticker-store: 表情不存在: ' + checked.name);
      error.code = err && err.code === 'ENOENT' ? 'ENOENT' : 'EIO';
      throw error;
    }
    if (!isWithinRoot(real, base)) {
      const error = new Error('sticker-store: 路径越界: ' + checked.name);
      error.code = 'EINVAL';
      throw error;
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) {
      const error = new Error('sticker-store: 不是普通文件: ' + checked.name);
      error.code = 'EINVAL';
      throw error;
    }
    if (stat.size > maxBytes()) {
      const error = new Error('sticker-store: 图片超过大小上限: ' + checked.name);
      error.code = 'ETOOBIG';
      throw error;
    }
    return fs.readFileSync(real);
  }

  /** 目录内同基础名重名时依次尝试 -2 / -3 ... */
  function uniqueName(base, stem, ext) {
    let candidate = stem + ext;
    if (!fs.existsSync(path.join(base, candidate))) return candidate;
    for (let i = 2; i <= 999; i += 1) {
      candidate = stem + '-' + i + ext;
      if (!fs.existsSync(path.join(base, candidate))) return candidate;
    }
    return stem + '-' + Date.now() + '-' + randomSuffix() + ext;
  }

  /**
   * 解析保存目标文件名。
   * - 显式 name：可带安全图片扩展名（与 magic 嗅探同格式组），也可不带扩展名（自动补）；
   * - 默认 name：<emotion 或 sticker>-<时间戳>-<随机4位>.<嗅探扩展名>。
   */
  function resolveSaveName(rawName, sniff, emotion) {
    if (rawName !== undefined && rawName !== null && String(rawName).trim() !== '') {
      const name = String(rawName).trim();
      const ext = path.extname(name).toLowerCase();
      if (ext === '') {
        // 没给扩展名：补 magic 嗅探出来的规范扩展名
        const stem = name;
        const checked = validateName(stem + sniff.ext);
        if (!checked.ok) return { ok: false, error: 'saveBuffer: ' + checked.error };
        return { ok: true, stem: checked.stem, ext: sniff.ext };
      }
      const checked = validateName(name);
      if (!checked.ok) return { ok: false, error: 'saveBuffer: ' + checked.error };
      if (extGroup(checked.ext) !== extGroup(sniff.ext)) {
        return { ok: false, error: 'saveBuffer: 文件名扩展名与图片内容不符（' + checked.ext + ' vs ' + sniff.ext + '）' };
      }
      return { ok: true, stem: checked.stem, ext: checked.ext };
    }
    const prefix = sanitizeSegment(emotion, 'sticker');
    return { ok: true, stem: prefix + '-' + Date.now() + '-' + randomSuffix(), ext: sniff.ext };
  }

  /**
   * 保存一份图片二进制：嗅探格式 → 校验大小/文件名 → 内容 hash 去重 → 重名去重 → 原子写 → 原子更新 index。
   * 内容已存在时返回 {ok:true, duplicate:true, name:已有名, item, created:false}，不写文件、不改 index。
   * @returns {{ok:true,duplicate:boolean,name:string,item:object,created:boolean}|{ok:false,error:string}}
   */
  function saveBuffer(buffer, opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    try {
      const buf = toBuffer(buffer);
      if (!buf) return { ok: false, error: 'saveBuffer: buffer 必须是 Buffer / Uint8Array / ArrayBuffer' };
      if (buf.length === 0) return { ok: false, error: 'saveBuffer: 图片内容为空' };
      const limit = maxBytes();
      if (buf.length > limit) {
        return {
          ok: false,
          error: 'saveBuffer: 图片超过大小上限 ' + Math.round(limit / 1024 / 1024) + 'MB',
        };
      }
      const sniff = sniffImage(buf);
      if (!sniff) return { ok: false, error: 'saveBuffer: 不是支持的图片格式（png/jpeg/gif/webp）' };
      // 先校验显式 name（安全校验优先），再按内容 hash 去重：重复内容不写文件、不改 index。
      const resolved = resolveSaveName(options.name, sniff, options.emotion);
      if (!resolved.ok) return resolved;

      const hash = hashBuffer(buf);
      const existing = findByHash(hash);
      if (existing) {
        return { ok: true, duplicate: true, name: existing.name, item: existing, created: false };
      }

      const base = ensureDirOrThrow();
      const finalName = uniqueName(base, resolved.stem, resolved.ext);
      const abs = path.join(base, finalName);
      writeAtomic(abs, buf);

      const meta = {
        emotion: normEmotion(options.emotion),
        tags: normTags(options.tags),
        note: normNote(options.note),
        addedAt: Date.now(),
        source: normSource(options.source),
        hash,
      };
      try {
        const indexData = loadIndex();
        indexData.items[finalName] = meta;
        saveIndex(indexData);
      } catch (err) {
        // index 写失败 → 回滚已写文件，避免出现无法管理的孤儿图片
        try { fs.unlinkSync(abs); } catch { /* 回滚失败忽略 */ }
        return { ok: false, error: 'saveBuffer: 写入表情包索引失败: ' + (err && err.message) };
      }
      const stat = fs.statSync(abs);
      return {
        ok: true,
        duplicate: false,
        name: finalName,
        item: shapeItem(finalName, abs, stat, meta),
        created: true,
      };
    } catch (err) {
      return { ok: false, error: 'saveBuffer: ' + (err && err.message) };
    }
  }

  /**
   * 从任意本地文件导入（收藏用；路径白名单由调用方/工具层校验）。
   * 读入内存后走 saveBuffer 的同一套 magic/大小/命名/索引校验。
   */
  function importFile(absPath, opts = {}) {
    try {
      if (typeof absPath !== 'string' || absPath.trim() === '') {
        return { ok: false, error: 'importFile: 路径不能为空' };
      }
      if (absPath.includes('\0')) return { ok: false, error: 'importFile: 路径包含非法字符' };
      const abs = path.resolve(absPath.trim());
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (err) {
        if (err && err.code === 'ENOENT') return { ok: false, error: 'importFile: 文件不存在: ' + abs };
        return { ok: false, error: 'importFile: 无法读取文件: ' + (err && err.message) };
      }
      if (!stat.isFile()) return { ok: false, error: 'importFile: 不是普通文件: ' + abs };
      if (stat.size === 0) return { ok: false, error: 'importFile: 文件为空: ' + abs };
      const limit = maxBytes();
      if (stat.size > limit) {
        return {
          ok: false,
          error: 'importFile: 图片超过大小上限 ' + Math.round(limit / 1024 / 1024) + 'MB',
        };
      }
      let buffer;
      try {
        buffer = fs.readFileSync(abs);
      } catch (err) {
        return { ok: false, error: 'importFile: 读取失败: ' + (err && err.message) };
      }
      return saveBuffer(buffer, opts);
    } catch (err) {
      return { ok: false, error: 'importFile: ' + (err && err.message) };
    }
  }

  /** 删除表情：只删目录内图片并同步 index；不存在时 removed=false（幂等） */
  function deleteSticker(name) {
    const checked = validateName(name);
    if (!checked.ok) return { ok: false, error: 'delete: ' + checked.error };
    const base = dir();
    const abs = path.join(base, checked.name);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        cleanupIndexKey(checked.name); // 文件已不在：顺手清理残留索引
        return { ok: true, removed: false };
      }
      return { ok: false, error: 'delete: ' + (err && err.message) };
    }
    if (!isWithinRoot(real, base)) return { ok: false, error: 'delete: 路径越界: ' + checked.name };
    let stat;
    try {
      stat = fs.statSync(real);
    } catch (err) {
      return { ok: false, error: 'delete: ' + (err && err.message) };
    }
    if (!stat.isFile()) return { ok: false, error: 'delete: 不是普通文件: ' + checked.name };
    try {
      fs.unlinkSync(real);
    } catch (err) {
      return { ok: false, error: 'delete: 删除失败: ' + (err && err.message) };
    }
    cleanupIndexKey(checked.name);
    cleanupIndexKey(path.basename(real));
    legacyHashes.delete(checked.name);
    legacyHashes.delete(path.basename(real));
    return { ok: true, removed: true };
  }

  /**
   * 更新元数据 / 重命名。
   * - 只传 emotion / tags / note 时原地更新 index；
   * - renameTo 同样受 basename + 图片扩展名限制，且扩展名必须与真实图片格式一致；
   * - 目标文件已存在则拒绝。
   * @returns {{ok:true,item:object}|{ok:false,error:string}}
   */
  function update(name, changes = {}) {
    const checked = validateName(name);
    if (!checked.ok) return { ok: false, error: 'update: ' + checked.error };
    const opts = changes && typeof changes === 'object' ? changes : {};
    const base = dir();
    const abs = path.join(base, checked.name);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return { ok: false, error: 'update: 表情不存在: ' + checked.name };
    }
    if (!isWithinRoot(real, base)) return { ok: false, error: 'update: 路径越界: ' + checked.name };
    let stat;
    try {
      stat = fs.statSync(real);
    } catch (err) {
      return { ok: false, error: 'update: ' + (err && err.message) };
    }
    if (!stat.isFile()) return { ok: false, error: 'update: 不是普通文件: ' + checked.name };

    const indexData = loadIndex();
    const currentName = path.basename(real);
    const meta = normalizeMeta(indexData.items[currentName] || {});
    if (!(meta.addedAt > 0)) meta.addedAt = Math.round(stat.mtimeMs);
    if (meta.source === '') meta.source = 'legacy';
    // 历史条目第一次被 update 时补算 hash 并落进 index（改名后仍能参与去重）
    if (meta.hash === '') {
      try {
        meta.hash = hashFile(real);
      } catch (err) {
        warn(log, 'update: 计算表情 hash 失败（' + currentName + '）:', err && err.message);
      }
    }
    if ('emotion' in opts) meta.emotion = normEmotion(opts.emotion);
    if ('tags' in opts) meta.tags = normTags(opts.tags);
    if ('note' in opts) meta.note = normNote(opts.note);

    let finalName = currentName;
    const wantsRename = opts.renameTo !== undefined && opts.renameTo !== null && String(opts.renameTo).trim() !== '';
    if (wantsRename) {
      const target = String(opts.renameTo).trim();
      const targetChecked = validateName(target);
      if (!targetChecked.ok) return { ok: false, error: 'update: renameTo ' + targetChecked.error };
      // 扩展名必须和真实图片格式同组，避免把 png 改成 .gif 这种骗人的名字
      let head;
      try {
        head = readHead(real);
      } catch (err) {
        return { ok: false, error: 'update: 读取图片失败: ' + (err && err.message) };
      }
      const sniff = sniffImage(head);
      if (!sniff) return { ok: false, error: 'update: 当前文件不是支持的图片格式' };
      if (extGroup(targetChecked.ext) !== extGroup(sniff.ext)) {
        return { ok: false, error: 'update: renameTo 扩展名与图片内容不符: ' + targetChecked.ext };
      }
      if (targetChecked.name !== currentName) {
        const targetAbs = path.join(base, targetChecked.name);
        if (fs.existsSync(targetAbs)) {
          return { ok: false, error: 'update: 目标文件名已存在: ' + targetChecked.name };
        }
        try {
          fs.renameSync(path.join(base, currentName), targetAbs);
        } catch (err) {
          return { ok: false, error: 'update: 重命名失败: ' + (err && err.message) };
        }
        delete indexData.items[currentName];
        finalName = targetChecked.name;
      }
    }

    indexData.items[finalName] = meta;
    try {
      saveIndex(indexData);
    } catch (err) {
      if (finalName !== currentName) {
        try { fs.renameSync(path.join(base, finalName), path.join(base, currentName)); } catch { /* 回滚失败忽略 */ }
      }
      return { ok: false, error: 'update: 写入表情包索引失败: ' + (err && err.message) };
    }
    let finalStat;
    try {
      finalStat = fs.statSync(path.join(base, finalName));
    } catch (err) {
      return { ok: false, error: 'update: 保存后读取失败: ' + (err && err.message) };
    }
    return { ok: true, item: shapeItem(finalName, path.join(base, finalName), finalStat, meta) };
  }

  /**
   * 统计 addedAt > sinceMs 的表情数量（默认配额窗口用 24h）。
   * 轻量实现：只 readdir + stat + index 元数据，不算图片 hash，避免配额检查也去读大文件。
   */
  function countAddedSince(sinceMs, sourceFilter) {
    const since = Number(sinceMs);
    if (!Number.isFinite(since)) return 0;
    const onlySource = typeof sourceFilter === 'string' && sourceFilter !== '' ? sourceFilter : '';
    const base = dir();
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (err) {
      if (!err || err.code !== 'ENOENT') warn(log, '统计表情新增数量失败:', err && err.message);
      return 0;
    }
    const indexData = loadIndex();
    let count = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (name.startsWith('.')) continue;
      if (!IMAGE_EXTS.has(path.extname(name).toLowerCase())) continue;
      let stat;
      try {
        stat = fs.statSync(path.join(base, name));
      } catch { continue; }
      if (!stat.isFile()) continue;
      const meta = indexData.items[name] || {};
      // 配额只该统计「bot 工具收藏」：历史文件/手动上传的 source 不是 tool，
      // 不能因为文件 mtime 是今天就把机器人额度占满（live 实测踩过：18 张 legacy 占掉 21/10）。
      if (onlySource !== '' && meta.source !== onlySource) continue;
      const addedAt = typeof meta.addedAt === 'number' && Number.isFinite(meta.addedAt) && meta.addedAt > 0
        ? meta.addedAt
        : Math.round(stat.mtimeMs);
      if (addedAt > since) count += 1;
    }
    return count;
  }

  /** settings.stickers.dailyLimit（默认 10，归一化到 1..100） */
  function dailyLimit() {
    const raw = cfg().dailyLimit;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(value)) return DEFAULT_DAILY_LIMIT;
    return Math.min(100, Math.max(1, Math.round(value)));
  }

  /**
   * 每日收藏配额：最近 24h 新增数量 vs settings.stickers.dailyLimit。
   * 只给工具层对 source='tool' 的收藏做限制；API 上传不经过这里。
   * @param {number} [nowMs] 测试可注入当前时间（默认 Date.now()）
   * @returns {{todayCount:number, dailyLimit:number, allowed:boolean}}
   */
  function collectQuota(nowMs) {
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    // 只统计 source='tool'（机器人收藏）；API 上传/历史文件不占机器人配额。
    const todayCount = countAddedSince(now - DAY_MS, 'tool');
    const limit = dailyLimit();
    return { todayCount, dailyLimit: limit, allowed: todayCount < limit };
  }

  return {
    dir,
    ensure,
    index,
    list,
    catalog,
    get,
    read,
    saveBuffer,
    importFile,
    delete: deleteSticker,
    update,
    countAddedSince,
    collectQuota,
  };
}

export default createStickerStore;