/**
 * console/api/reports —— 群日报查询与卡片模板管理。
 *
 * 查询（GET /api/reports*）只读：生成入口在 /api/actions/daily（lib/index.js 的 actions.run），
 * 这样「生成一个可能很慢的 LLM 任务」走 action 的超时/取消语义，列表接口保持轻量。
 *
 * 模板管理（UI 适配契约 §3）：
 *   - GET    /api/reports/templates/preview  模板 + 示例数据 → 自包含预览 HTML
 *   - POST   /api/reports/templates/install  base64 文件数组 → <dataDir>/templates/<name>/
 *   - DELETE /api/reports/templates/:name    只允许删除自定义模板目录
 * 安装/删除的路径一律 resolve 后校验仍在 <dataDir>/templates 根下（防路径穿越）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { buildPreviewHtml } from '../../reports/preview.js';
import {
  BUILTIN_NAMES, OFF_TEMPLATE, TEMPLATE_NAME_RE, listTemplates, resolveTemplate,
} from '../../reports/template-registry.js';
import { visualSummary } from '../../reports/visuals.js';
import {
  HttpError, badRequest, guard, isPlainObject, notFound, notReady, queryInt, queryString,
} from './helpers.js';

function storeOf(ctx) {
  const store = ctx.deps?.reports;
  if (!store || typeof store.list !== 'function') {
    throw Object.assign(new Error('日报存储未装配'), { status: 501 });
  }
  return store;
}

function botIdOf(ctx) {
  const botId = queryString(ctx.query, 'bot');
  if (!botId) throw badRequest('缺少 bot 参数');
  return botId;
}

function listReports(ctx) {
  const botId = botIdOf(ctx);
  const peer = queryString(ctx.query, 'peer');
  const limit = queryInt(ctx.query, 'limit', 30, { min: 1, max: 200 });
  const offset = queryInt(ctx.query, 'offset', 0, { min: 0, max: 1_000_000 });
  const items = guard(() => storeOf(ctx).list({ botId, peer, limit, offset }));
  return { items, count: items.length, botId, peer };
}

function latestReport(ctx) {
  const botId = botIdOf(ctx);
  const peer = queryString(ctx.query, 'peer');
  if (!peer) throw badRequest('缺少 peer 参数');
  const report = guard(() => storeOf(ctx).latest({ botId, peer }));
  return { report: report || null };
}

/** 可用模板：内置 + 数据目录下的自定义模板（模板选择插槽的调试/展示入口）。 */
function templateList(ctx) {
  const paths = (ctx.deps && ctx.deps.paths) || {};
  const items = guard(() => listTemplates({ dataDir: paths.dataDir || '' }));
  return {
    items: (Array.isArray(items) ? items : []).map((item) => ({
      name: item.name,
      label: item.label,
      description: item.description,
      builtin: item.builtin,
      // 模板自带插画槽的精简声明；没有 visuals 的模板为 null（没有氛围切换）。
      visuals: visualSummary(item.visuals),
    })),
    dataDir: paths.dataDir || '',
  };
}

/** 日报卡片图（jpg）：路径来自报告行；文件缺失 404。 */
function reportImage(ctx) {
  const store = storeOf(ctx);
  const botId = botIdOf(ctx);
  const peer = queryString(ctx.query, 'peer');
  const day = queryString(ctx.query, 'day');
  if (!peer || !day) throw badRequest('需要 peer 与 day 参数');
  const report = guard(() => store.get({ botId, peer, day }));
  if (!report || !report.imagePath) throw notFound('该日报没有卡片图');
  const file = path.resolve(report.imagePath);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw notFound('卡片图不存在（可能已被清理）: ' + report.imagePath);
  }
  if (!stat.isFile()) throw notFound('卡片图不是普通文件');
  ctx.res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(ctx.res);
  return ctx.raw;
}

// ---------------------------------------------------------------------------
// 卡片模板：预览 / 安装 / 删除（UI 适配契约 §3）
// ---------------------------------------------------------------------------

/** 模板安装请求体上限（与 server.js 里 install 路由的 maxBodyBytes 一致）。 */
const INSTALL_BODY_LIMIT = 16 * 1024 * 1024;
/** 单个安装包最多文件数。 */
const MAX_INSTALL_FILES = 64;
/** 单文件解码后上限 8MB（base64 文本更长，但整个请求体仍受 16MB 限制）。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 一次安装解码后总大小上限 16MB。 */
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** install 允许的静态资源扩展名（模板渲染能用的类型）。 */
const ASSET_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'json', 'webp', 'png', 'jpg', 'jpeg', 'gif', 'svg',
  'woff', 'woff2', 'ttf', 'otf',
]);
/** 不能当自定义模板的保留名：内置两套 + 只发文本的 off。 */
const RESERVED_TEMPLATE_NAMES = new Set([...BUILTIN_NAMES, OFF_TEMPLATE]);

/** 数据目录（未装配时 501）：安装/删除都以它为根。 */
function dataDirOf(ctx) {
  const dataDir = ctx.deps?.paths?.dataDir;
  if (typeof dataDir !== 'string' || dataDir.trim() === '') throw notReady('未配置数据目录');
  return dataDir;
}

/** 自定义模板根目录：<dataDir>/templates（resolve 后的绝对路径）。 */
function templatesRootOf(ctx) {
  return path.resolve(dataDirOf(ctx), 'templates');
}

/** 模板名校验：合法返回去空白后的名字，否则 400 invalid_name。 */
function templateNameOf(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!TEMPLATE_NAME_RE.test(name)) {
    throw new HttpError(400, 'invalid_name',
      '模板名非法：只能由字母、数字、下划线、连字符组成，以字母或数字开头，最长 32 个字符');
  }
  return name;
}

/** 目标路径必须落在 root 内（防路径穿越的最后一道检查）。 */
function ensureInside(root, target) {
  const base = path.resolve(root);
  const full = path.resolve(target);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new HttpError(400, 'invalid_files', '文件名非法（路径越界）：' + target);
  }
  return full;
}

/** 严格 base64 解码：非法字符/长度不对返回 null（Node 的宽松解码会静默吞字符）。 */
function decodeBase64(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, '');
  if (text === '') return Buffer.alloc(0);
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  const buffer = Buffer.from(text, 'base64');
  if (buffer.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) return null;
  return buffer;
}

/**
 * 安装包里的相对路径白名单：index.html、meta.json、assets/**（扩展名白名单）。
 * 绝对路径、..、反斜杠、空段一律拒绝；写入前还会再 resolve 校验一次。
 */
function templateFilePathOf(value) {
  if (typeof value !== 'string') return null;
  const rel = value;
  if (rel === '' || rel.trim() !== rel || rel.includes('\\') || /[\u0000-\u001f]/.test(rel)) return null;
  if (path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  if (rel === 'index.html' || rel === 'meta.json') return rel;
  if (parts.length < 2 || parts[0] !== 'assets') return null;
  const ext = path.posix.extname(parts[parts.length - 1]).slice(1).toLowerCase();
  return ASSET_EXTENSIONS.has(ext) ? rel : null;
}

/** 预览查询参数 → 预览视图（JSON 路由此处返回元数据，HTML 路由直接吐出文档）。 */
function previewViewOf(ctx) {
  const rawName = queryString(ctx.query, 'name');
  if (!rawName) throw badRequest('缺少 name 参数');
  const name = rawName.trim();
  const paths = (ctx.deps && ctx.deps.paths) || {};
  const dataDir = paths.dataDir || '';
  const rawMood = queryString(ctx.query, 'mood');
  const mood = rawMood === null ? '' : rawMood.trim();
  // 氛围是模板自己声明的（meta.json 的 visuals.moods）：没有插画槽的模板忽略 mood，
  // 有插画槽的模板才校验取值。
  const entry = resolveTemplate(name, { dataDir });
  if (!entry) throw notFound('模板不存在：' + name);
  const moods = entry.visuals ? entry.visuals.moods : [];
  if (mood !== '' && mood !== 'random' && moods.length > 0 && !moods.some((item) => item.id === mood)) {
    throw badRequest('mood 参数非法（可选：random / ' + moods.map((item) => item.id).join(' / ') + '）');
  }
  const view = buildPreviewHtml({
    name,
    mood: mood === '' ? undefined : mood,
    day: queryString(ctx.query, 'day') || undefined,
    dataDir,
  });
  if (!view.ok) {
    if (view.reason === 'no-template') throw notFound('模板不存在：' + name);
    throw new HttpError(500, 'preview_failed', '模板预览失败：' + (view.error || view.reason));
  }
  return { name, view };
}

/** GET /api/reports/templates/preview：模板 + 示例数据 → 预览元数据（meta=1 时不带 HTML）。 */
function previewTemplate(ctx) {
  const { name, view } = previewViewOf(ctx);
  const metaOnly = queryString(ctx.query, 'meta') === '1';
  return {
    name,
    label: view.label,
    description: view.description,
    builtin: view.builtin,
    width: view.width,
    visuals: view.visuals,
    mood: view.mood,
    day: view.day,
    html: metaOnly ? '' : view.html,
  };
}

/**
 * GET /api/reports/templates/preview/html：直接吐出自包含预览文档（iframe src 用）。
 *
 * 为什么不走 JSON + srcdoc：控制台页面 CSP 是 script-src 'self'，srcdoc 会继承父文档 CSP，
 * 模板里的内联脚本会被拦掉。独立响应用自己的窄 CSP（只允许内联脚本与 data: 图片、
 * 禁止任何网络请求），配合 sandbox + X-Frame-Options: SAMEORIGIN 把模板 JS 限制在
 * 一个拿不到 cookie、也发不出请求的隔离文档里。
 */
function previewTemplateHtml(ctx) {
  const { view } = previewViewOf(ctx);
  ctx.res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(view.html),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'",
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
  });
  ctx.res.end(view.html);
  return ctx.raw;
}

/** POST /api/reports/templates/install：base64 文件数组 → <dataDir>/templates/<name>/。 */
function installTemplate(ctx) {
  const root = templatesRootOf(ctx);
  const body = ctx.body;
  if (!isPlainObject(body)) {
    throw new HttpError(400, 'invalid_name', '请求体必须是 JSON 对象（含 name 与 files）');
  }
  const name = templateNameOf(body.name);
  if (RESERVED_TEMPLATE_NAMES.has(name)) {
    throw new HttpError(409, 'template_reserved', '该名字被内置模板保留，不能用作自定义模板：' + name);
  }
  if (!Array.isArray(body.files) || body.files.length === 0 || body.files.length > MAX_INSTALL_FILES) {
    throw new HttpError(400, 'invalid_files', 'files 必须是 1-' + MAX_INSTALL_FILES + ' 个文件的数组');
  }
  const files = [];
  const seen = new Set();
  let totalBytes = 0;
  for (const item of body.files) {
    if (!isPlainObject(item)) {
      throw new HttpError(400, 'invalid_files', 'files 里的每一项必须是 { path, content(base64) } 对象');
    }
    const rel = templateFilePathOf(item.path);
    if (!rel) throw new HttpError(400, 'invalid_files', '文件路径非法：' + String(item.path));
    if (seen.has(rel)) throw new HttpError(400, 'invalid_files', '文件路径重复：' + rel);
    const buffer = decodeBase64(item.content);
    if (!buffer) throw new HttpError(400, 'invalid_files', '文件内容不是合法 base64：' + rel);
    if (buffer.length > MAX_FILE_BYTES) {
      throw new HttpError(400, 'invalid_files', '单个文件解码后超过 8MB：' + rel);
    }
    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new HttpError(400, 'invalid_files', '模板解码后总大小超过 16MB');
    }
    seen.add(rel);
    files.push({ path: rel, buffer });
  }
  if (!seen.has('index.html')) throw new HttpError(400, 'missing_index', '模板缺少 index.html');
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const targetDir = ensureInside(root, path.join(root, name));
  if (fs.existsSync(targetDir)) {
    if (body.replace !== true) {
      throw new HttpError(409, 'template_exists',
        '同名模板已存在：' + name + '（如需覆盖请传 replace: true）');
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  let written = 0;
  let bytes = 0;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of files) {
      const dest = ensureInside(targetDir, path.join(targetDir, ...file.path.split('/')));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.buffer);
      written += 1;
      bytes += file.buffer.length;
    }
    if (!seen.has('meta.json') && (label !== '' || description !== '')) {
      const meta = JSON.stringify({ label, description }, null, 2) + '\n';
      fs.writeFileSync(ensureInside(targetDir, path.join(targetDir, 'meta.json')), meta, 'utf8');
      written += 1;
      bytes += Buffer.byteLength(meta);
    }
  } catch (err) {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (err instanceof HttpError) throw err;
    throw new HttpError(500, 'install_failed', '写入模板失败：' + ((err && err.message) || String(err)));
  }
  const listed = listTemplates({ dataDir: dataDirOf(ctx) }).find((item) => item.name === name) || null;
  return {
    ok: true,
    name,
    label: (listed && listed.label) || label || name,
    description: (listed && listed.description) || description || '',
    builtin: false,
    files: written,
    bytes,
  };
}

/** DELETE /api/reports/templates/:name：只删自定义模板目录。 */
function deleteTemplate(ctx) {
  const name = templateNameOf(ctx.params && ctx.params.name);
  if (RESERVED_TEMPLATE_NAMES.has(name)) {
    throw new HttpError(400, 'template_reserved', '内置/保留模板不可删除：' + name);
  }
  const root = templatesRootOf(ctx);
  const targetDir = ensureInside(root, path.join(root, name));
  let stat = null;
  try { stat = fs.statSync(targetDir); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) throw notFound('模板不存在：' + name);
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
  } catch (err) {
    throw new HttpError(500, 'delete_failed', '删除模板失败：' + ((err && err.message) || String(err)));
  }
  return { ok: true, name };
}

export const routes = [
  { method: 'GET', path: '/api/reports', handler: listReports },
  { method: 'GET', path: '/api/reports/latest', handler: latestReport },
  { method: 'GET', path: '/api/reports/templates', handler: templateList },
  { method: 'GET', path: '/api/reports/templates/preview', handler: previewTemplate },
  { method: 'GET', path: '/api/reports/templates/preview/html', handler: previewTemplateHtml },
  {
    method: 'POST',
    path: '/api/reports/templates/install',
    handler: installTemplate,
    maxBodyBytes: INSTALL_BODY_LIMIT,
  },
  { method: 'DELETE', path: '/api/reports/templates/:name', handler: deleteTemplate },
  { method: 'GET', path: '/api/reports/image', handler: reportImage },
];
