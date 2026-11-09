/**
 * test/console-static —— 静态托管：真实 dist、SPA fallback、缓存/CSP 头、404、HEAD、目录穿越防护。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { createHarness, tempDir } from './console-helpers.js';

/** 造一个最小 Vite 风格 dist。 */
function buildDist() {
  const dist = tempDir('qqbot-webdist-');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'),
    '<!doctype html><html><head><title>QQBot 控制台</title></head><body><div id="app">CONSOLE_INDEX</div></body></html>');
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log("asset");');
  fs.writeFileSync(path.join(dist, 'assets', 'style-abc123.css'), 'body { color: red; }');
  fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  return dist;
}

test('静态托管：index/资源/SPA fallback/缓存与 CSP 头', async (t) => {
  const dist = buildDist();
  const h = await createHarness({ webDist: dist });
  t.after(async () => {
    await h.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  const root = await h.request('GET', '/', { auth: false });
  assert.equal(root.status, 200);
  assert.match(String(root.headers.get('content-type')), /text\/html/);
  assert.match(root.text, /CONSOLE_INDEX/);
  assert.match(String(root.headers.get('content-security-policy')), /default-src 'self'/);
  assert.equal(root.headers.get('cache-control'), 'no-cache');
  assert.equal(root.headers.get('x-content-type-options'), 'nosniff');

  const js = await h.request('GET', '/assets/app-abc123.js', { auth: false });
  assert.equal(js.status, 200);
  assert.match(String(js.headers.get('content-type')), /text\/javascript/);
  assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(js.text, 'console.log("asset");');

  const css = await h.request('GET', '/assets/style-abc123.css', { auth: false });
  assert.equal(css.status, 200);
  assert.match(String(css.headers.get('content-type')), /text\/css/);

  const svg = await h.request('GET', '/favicon.svg', { auth: false });
  assert.equal(svg.status, 200);
  assert.match(String(svg.headers.get('content-type')), /image\/svg\+xml/);

  // 前端路由（无扩展名）→ SPA fallback
  const spa = await h.request('GET', '/bots/123?tab=x', { auth: false });
  assert.equal(spa.status, 200);
  assert.match(spa.text, /CONSOLE_INDEX/);

  // 带扩展名但缺失 → 404 JSON，不能把 index.html 当 JS 返回
  const missing = await h.request('GET', '/assets/missing.js', { auth: false });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'not_found');

  // API 路径不落到静态托管
  const api404 = await h.request('GET', '/api/does-not-exist', { auth: false });
  assert.equal(api404.status, 404);
  assert.equal(api404.data.error.code, 'not_found');
});

test('静态托管：HEAD 请求与目录穿越防护', async (t) => {
  const dist = buildDist();
  const h = await createHarness({ webDist: dist });
  t.after(async () => {
    await h.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  const head = await h.request('HEAD', '/assets/app-abc123.js', { auth: false });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.match(String(head.headers.get('content-type')), /text\/javascript/);

  const target = new URL(h.baseUrl);
  const traversal = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: '/..%2F..%2Fetc%2Fpasswd',
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(traversal.status, 400);
  assert.match(traversal.data, /bad_path/);
});

test('dist 目录存在但缺 index.html 时仍返回占位页', async (t) => {
  const dist = tempDir('qqbot-webdist-broken-');
  fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1);');
  const h = await createHarness({ webDist: dist });
  t.after(async () => {
    await h.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  const root = await h.request('GET', '/', { auth: false });
  assert.equal(root.status, 200);
  assert.match(root.text, /前端尚未构建/);
  assert.match(root.text, /console:build/);
});
