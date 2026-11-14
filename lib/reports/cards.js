/**
 * reports/cards —— 群日报卡片渲染（HTML 模板 → JPEG）。
 *
 * 为什么复用 summary-card 技能：
 *   - 它已经解决了 Chromium 探测、字体、截图与排版体检（溢出/小字号/行首标点）；
 *   - 我们只带自己的 HTML 模板（--html 直传），不依赖它的主题与内容 schema；
 *   - 找不到技能/浏览器时直接降级为纯文本日报，不影响主流程。
 *
 * 模板契约：
 *   - 入参是 daily payload（{ day, stats, report, meta }）；
 *   - 模板读 window.__CARD_DATA__.card 渲染，完成后置 __CARD_READY__ = true；
 *   - __FONTS_CSS__ 占位符在渲染前替换成技能的字体样式表（不存在则留空）；
 *   - 带 data-slot="hero|peek|rhythm" 的 <img> 会按 payload 的 visual 选图
 *     （模型点名 → mood 预设 → 高峰时段推断，见 reports/visuals.js）；
 *   - 模板里 assets/... 的相对路径在渲染前内联成 data URI。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BUILTIN_TEMPLATES, listTemplates, resolveTemplate } from './template-registry.js';
import { selectionFromPayload } from './visuals.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(HERE, 'templates');

/** 内置模板：名字 → 文件（自定义模板见 template-registry.js）。 */
export const TEMPLATES = Object.freeze(Object.fromEntries(
  Object.entries(BUILTIN_TEMPLATES).map(([name, item]) => [name, item.file]),
));

export const TEMPLATE_NAMES = Object.freeze(Object.keys(TEMPLATES));

/** 可选项（含自定义）供控制台/调试使用。 */
export { listTemplates };

/**
 * 模板文件绝对路径：先查内置，再查 <dataDir>/templates/<name>/index.html。
 * 未知模板 / off / 文件缺失返回 null。
 */
export function templatePath(name, { exists = fs.existsSync, dataDir = '', env = process.env } = {}) {
  const key = String(name || '').trim();
  if (key === '' || key === 'off') return null;
  const builtin = TEMPLATES[key];
  if (builtin) {
    const full = path.join(TEMPLATE_DIR, builtin);
    return exists(full) ? full : null;
  }
  const custom = resolveTemplate(key, { dataDir, env, exists });
  return custom && !custom.builtin ? custom.file : null;
}

/**
 * 找 summary-card 的 render.mjs。
 * 顺序：环境变量 → workspace/.dsh → ~/.dsh → ~/.agents（含 workspace 级）。
 */
export function findRenderer({
  workspaceRoot = '',
  home = os.homedir(),
  env = process.env,
  exists = fs.existsSync,
} = {}) {
  const candidates = [];
  const explicit = String((env && env.QQBOT_CARD_RENDERER) || '').trim();
  if (explicit) candidates.push(explicit);
  const rel = path.join('.dsh', 'skills', 'summary-card', 'scripts', 'render.mjs');
  if (workspaceRoot) candidates.push(path.join(workspaceRoot, rel));
  candidates.push(path.join(home, rel));
  candidates.push(path.join(home, '.agents', 'skills', 'summary-card', 'scripts', 'render.mjs'));
  if (workspaceRoot) candidates.push(path.join(workspaceRoot, '.agents', 'skills', 'summary-card', 'scripts', 'render.mjs'));
  for (const file of candidates) {
    try { if (file && exists(file)) return file; } catch { /* ignore */ }
  }
  return '';
}

/** 字体样式表 <link>：技能 assets/fonts.css 存在时才注入。 */
export function fontLinkFor(renderer, { exists = fs.existsSync } = {}) {
  if (!renderer) return '';
  const css = path.join(path.dirname(path.dirname(renderer)), 'assets', 'fonts.css');
  try {
    if (!exists(css)) return '';
    return '<link rel="stylesheet" href="' + pathToFileURL(css).href + '">';
  } catch {
    return '';
  }
}

const ASSET_MIME = Object.freeze({
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
});

/**
 * 把模板里的相对资源（assets/...）内联成 data URI。
 *
 * 为什么内联：模板会被复制到临时目录再交给 Chromium，相对路径会断；
 * file:// 子资源在某些启动参数下会被拦；data URI 在所有情况下都能渲染。
 */
export function inlineAssets(html, { templateDir = TEMPLATE_DIR, readFile = fs.readFileSync } = {}) {
  const root = path.resolve(templateDir) + path.sep;
  const cache = new Map();
  return String(html || '').replace(/assets\/[A-Za-z0-9._\-/]+\.(?:webp|png|jpe?g|svg)/g, (ref) => {
    if (cache.has(ref)) return cache.get(ref);
    let uri = ref;
    const file = path.resolve(templateDir, ref);
    if (file.startsWith(root)) {
      try {
        const ext = path.extname(file).slice(1).toLowerCase();
        const mime = ASSET_MIME[ext] || 'application/octet-stream';
        uri = 'data:' + mime + ';base64,' + readFile(file).toString('base64');
      } catch { /* 缺图时保留原路径，Canvas 会忽略该图，不阻塞渲染 */ }
    }
    cache.set(ref, uri);
    return uri;
  });
}

/**
 * 把 data-slot 的 <img src> 换成选中插画的相对路径（后续交给 inlineAssets）。
 * 模板里 data-slot 写在 src 前面，属性顺序固定，正则只作用于单个标签。
 */
export function applySelection(html, selection, visuals) {
  if (!selection || !visuals || !Array.isArray(visuals.slots)) return String(html || '');
  let out = String(html || '');
  for (const slot of visuals.slots) {
    const item = visuals.items[selection[slot]];
    if (!item || item.slot !== slot) continue;
    const re = new RegExp('(<img\\b[^>]*\\bdata-slot="' + slot + '"[^>]*\\bsrc=")([^"]*)(")');
    out = out.replace(re, '$1' + item.file + '$3');
  }
  return out;
}

/**
 * 读模板 + 选插画 + 注入字体 + 内联插画资源，返回最终 HTML。
 * 资源按模板所在目录解析：内置在 lib/reports/templates，自定义在各自的模板目录。
 */
export function buildHtml(template, {
  renderer = '', inline = inlineAssets, selection = null, visuals = null, templateDir = '',
} = {}) {
  let html = fs.readFileSync(template, 'utf8').replace('__FONTS_CSS__', fontLinkFor(renderer));
  if (selection && visuals) html = applySelection(html, selection, visuals);
  return inline(html, { templateDir: templateDir || path.dirname(template) });
}

/** 从渲染器 stdout 里取最后一行 JSON（前面可能有其它日志）。 */
export function parseRenderOutput(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续往前找 */ }
  }
  return null;
}

/**
 * 渲染一张日报卡片。
 * @param {object} args
 * @param {object} args.payload daily payload（{ day, stats, report, meta }）
 * @param {string} [args.template] journal | dark | <dataDir>/templates 下的自定义模板名
 * @param {string} args.outPath 输出 jpg 绝对路径
 * @param {string} [args.workspaceRoot] 用于发现技能安装位置
 * @param {string} [args.dataDir] 数据目录（自定义模板 <dataDir>/templates/<name>/index.html）
 * @param {object} [args.env] 环境变量（可用 QQBOT_TEMPLATE_DIRS 追加模板目录）
 * @param {string} [args.renderer] 显式 render.mjs 路径（测试/自定义）
 * @param {Function} [args.spawn] 注入的 child_process.spawn（测试用）
 * @param {number} [args.timeoutMs]
 * @param {object} [args.logger]
 * @returns {Promise<{ok:boolean, reason?:string, path?:string, warnings?:object[], error?:string}>}
 */
export async function renderCard({
  payload,
  template = 'journal',
  outPath,
  workspaceRoot = '',
  dataDir = '',
  env = process.env,
  renderer = '',
  resolveRenderer = findRenderer,
  spawn = spawnProcess,
  timeoutMs = 120000,
  logger,
} = {}) {
  const log = logger || console;
  const entry = resolveTemplate(template, { dataDir, env });
  if (!entry) {
    const hint = dataDir ? '（查找 ' + path.join(dataDir, 'templates', String(template || ''), 'index.html') + '）' : '';
    return { ok: false, reason: 'no-template', error: '模板不存在：' + String(template || '') + hint };
  }
  const tpl = entry.file;
  if (!outPath) return { ok: false, reason: 'no-output' };
  const script = renderer || resolveRenderer({ workspaceRoot });
  if (!script) return { ok: false, reason: 'no-renderer' };

  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-card-'));
    const html = buildHtml(tpl, {
      renderer: script,
      selection: selectionFromPayload(payload, entry.visuals),
      visuals: entry.visuals,
    });
    const htmlFile = path.join(tmpDir, 'card.html');
    const dataFile = path.join(tmpDir, 'data.json');
    fs.writeFileSync(htmlFile, html, 'utf8');
    fs.writeFileSync(dataFile, JSON.stringify({ card: payload || {} }), 'utf8');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const args = [
      script,
      '--html', htmlFile,
      '--data', dataFile,
      '--out', outPath,
      '--format', 'jpeg',
      '--width', '1200',
      '--scale', '2',
      '--proof', '0',
      '--json',
    ];
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve({ code: -1, stdout, stderr: stderr + '\n[cards] 渲染超时' });
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + '\n' + ((err && err.message) || String(err)) });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });

    const parsed = parseRenderOutput(result.stdout);
    const exists = fs.existsSync(outPath);
    if (!exists) {
      return { ok: false, reason: 'render-failed', error: (parsed && parsed.error) || result.stderr.trim() || ('exit ' + result.code) };
    }
    const warnings = Array.isArray(parsed && parsed.warnings) ? parsed.warnings : [];
    if (warnings.length > 0) {
      log.debug?.('日报卡片体检: ' + warnings.map((w) => w.code).join(', '));
    }
    return {
      ok: true,
      path: outPath,
      warnings,
      width: (parsed && parsed.width) || 0,
      height: (parsed && parsed.height) || 0,
      px: (parsed && parsed.px) || '',
      bytes: (parsed && parsed.bytes) || (fs.statSync(outPath).size || 0),
    };
  } catch (err) {
    return { ok: false, reason: 'render-error', error: (err && err.message) || String(err) };
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

export default renderCard;
