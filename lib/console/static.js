/**
 * console/static —— 托管 web/dist 静态资源（SPA fallback），dist 未构建时返回占位页。
 *
 * 规则：
 * - 非 /api 的 GET/HEAD 都走这里；真实文件优先，找不到且无扩展名 → index.html（前端路由）；
 * - 扩展名缺失的资源（如 /assets/app-xxx.js）404，避免把 HTML 当 JS 返回；
 * - 未 build（web/dist/index.html 不存在）时返回 200 占位 HTML，提示 npm run console:build；
 * - 路径按段 decode 并禁止 .. / 反斜杠 / NUL，防目录穿越。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { HttpError } from './api/helpers.js';

/** 常见静态资源 MIME。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** 控制台前端 CSP（单页应用只需要自己 + 内联样式）。 */
const HTML_CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

/** dist 未构建时的占位页（数组拼接避免嵌套模板字符串）。 */
function placeholderHtml() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>QQBot 控制台 · 前端未构建</title>',
    '  <style>',
    '    body { margin: 0; min-height: 100vh; display: grid; place-items: center;',
    '      font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;',
    '      background: #0f1115; color: #e6e8ee; }',
    '    main { max-width: 620px; padding: 40px; }',
    '    h1 { font-size: 20px; margin: 0 0 16px; }',
    '    p { line-height: 1.7; color: #aab2c5; margin: 8px 0; }',
    '    code { background: #1c2230; color: #7ee0a8; padding: 2px 8px; border-radius: 6px;',
    '      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
    '    pre { background: #1c2230; padding: 14px 16px; border-radius: 10px; overflow: auto; }',
    '  </style>',
    '</head>',
    '<body>',
    '<main>',
    '  <h1>控制台服务已启动，但前端尚未构建</h1>',
    '  <p>后端接口可用（可访问 <code>/api/health</code> 自检）。请先构建前端静态产物：</p>',
    '  <pre>npm run console:build</pre>',
    '  <p>构建完成后刷新本页即可；产物目录为 <code>web/dist</code>。</p>',
    '  <p>登录 token 见数据目录下的 <code>console-token.txt</code>，也可在 DSH 插件设置页复制/重置。</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n');
}

/** 构造静态托管处理器。 */
export function createStaticHandler({ distDir, logger = null } = {}) {
  const root = path.resolve(distDir || path.join(process.cwd(), 'web', 'dist'));
  const indexPath = path.join(root, 'index.html');

  function log(level, message) {
    try { logger?.[level]?.(message); } catch { /* ignore */ }
  }

  async function statFile(file) {
    try { return await fsp.stat(file); } catch { return null; }
  }

  function insideRoot(file) {
    return file === root || file.startsWith(root + path.sep);
  }

  /** 路径 → 安全的相对路径；含穿越/非法字符返回 null。 */
  function safeRelative(pathname) {
    if (typeof pathname !== 'string' || pathname === '') return '';
    const parts = pathname.split('/').filter((part) => part !== '');
    const out = [];
    for (const part of parts) {
      let segment;
      try { segment = decodeURIComponent(part); } catch { return null; }
      if (segment === '' || segment === '.') continue;
      if (segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\u0000')) return null;
      out.push(segment);
    }
    return out.join('/');
  }

  function cacheControl(relative) {
    return relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  }

  function servePlaceholder(req, res) {
    const html = placeholderHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': HTML_CSP,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(html);
    log('debug', '[console] web/dist 不存在，已返回占位页（提示先构建前端）');
  }

  async function serveFile(req, res, file, stat, relative) {
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl(relative),
      'Content-Length': String(stat.size),
      'X-Content-Type-Options': 'nosniff',
    };
    if (ext === '.html') headers['Content-Security-Policy'] = HTML_CSP;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    try {
      const data = await fsp.readFile(file);
      res.end(data);
    } catch (err) {
      log('warn', '[console] 读取静态文件失败：' + file + ' ' + (err?.message || err));
      try { res.destroy(); } catch { /* ignore */ }
    }
  }

  /**
   * 处理非 /api 请求（server 在 API 路由都不匹配时调用）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{url?: URL}} context
   */
  async function handle(req, res, { url } = {}) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', '静态资源只支持 GET/HEAD');
    }
    const pathname = url?.pathname || '/';
    const relative = safeRelative(pathname);
    if (relative === null) throw new HttpError(400, 'bad_path', '非法资源路径');

    const indexStat = await statFile(indexPath);
    if (!indexStat || !indexStat.isFile()) {
      servePlaceholder(req, res);
      return;
    }
    if (relative === '') {
      await serveFile(req, res, indexPath, indexStat, 'index.html');
      return;
    }
    const resolved = path.resolve(root, relative);
    if (!insideRoot(resolved)) throw new HttpError(400, 'bad_path', '非法资源路径');
    const stat = await statFile(resolved);
    if (stat && stat.isFile()) {
      await serveFile(req, res, resolved, stat, relative);
      return;
    }
    if (stat && stat.isDirectory()) {
      const dirIndex = path.join(resolved, 'index.html');
      const dirStat = await statFile(dirIndex);
      if (dirStat && dirStat.isFile()) {
        await serveFile(req, res, dirIndex, dirStat, relative + '/index.html');
        return;
      }
    }
    // 带扩展名的资源缺失 → 404；无扩展名视为前端路由 → SPA fallback 到 index.html
    if (path.extname(relative) !== '') throw new HttpError(404, 'not_found', '资源不存在: /' + relative);
    await serveFile(req, res, indexPath, indexStat, 'index.html');
  }

  return { handle, root, indexPath };
}
