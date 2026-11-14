/**
 * test/client-entry —— dsh Web 会话头部「QQBot 大屏」入口的静态契约。
 *
 * 这个入口是「客户端半」（lib/client.js + package.json 的 dsh.client 声明）：
 * dsh 0.2.x 把会话头部按钮收进了「…」弹出菜单，旧的 index.html DOM 注入失效，
 * 改为官方 Client contextMenus（target=sessionHeader）贡献。
 * 包清单少一个字段、bundle 调错 loader API 都会静默失效，所以在这里做回归。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const clientSource = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');

test('package.json：暴露客户端半 exports["./client"] 且声明 dsh.client(web)', () => {
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.ok(pkg.files.includes('lib/**'), 'files 必须包含 lib/**，否则发布包缺客户端半');
  assert.equal(typeof pkg.dsh, 'object');
  assert.equal(pkg.dsh.client?.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh.client?.inject), 'dsh.client.inject 必须是数组');
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-context-menu'),
    '需要声明 contextMenus 所在的客户端模块依赖',
  );
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'),
    '需要在会话头部 UI 之后装配（sessionHeader 菜单由它渲染）',
  );
});

test('lib/client.js：通过 __ModuleLoader__ 注册，贡献会话头部菜单项', () => {
  assert.doesNotThrow(() => new Function(clientSource), '客户端 bundle 必须是可解析的浏览器脚本');
  assert.match(clientSource, /window\.__ModuleLoader__\.load\(/, '必须走 dsh 客户端模块 loader');
  assert.match(clientSource, /id: 'dsh-qqbot-buddy'/, 'loader id 必须与包名一致');
  assert.match(clientSource, /module\.exports = \{ apply: apply, inject: \[.*'slots'.*'contextMenus'.*\] \}/, '需要 apply + inject');
  assert.match(clientSource, /target: 'sessionHeader'/, '菜单目标必须是会话头部');
  assert.match(clientSource, /label: 'QQBot 大屏'/, '菜单文案');
  assert.match(clientSource, /ROUTE = '\/qqbot-dashboard'/, '点击必须走 Host 半的同源 302 路由');
  assert.match(clientSource, /contextMenu\.icon/, '需要注册图标 slot');
  // 只开新标签页：window.open + noopener 返回 null 会误触发当前页兜底，导致双跳转。
  assert.doesNotMatch(clientSource, /window\.location\.assign/, '不允许当前页跳转兜底（会和新标签页双开）');
  assert.doesNotMatch(clientSource, /window\.open\(/, '不用 window.open（noopener 返回 null，无法判断是否被拦截）');
  assert.match(clientSource, /link\.target = '_blank'/, '必须用 target=_blank 的新标签页链接');
  assert.match(clientSource, /link\.rel = 'noopener noreferrer'/, '新标签页必须断开 opener');
});

test('lib/index.js：Host 半保留 /qqbot-dashboard 跳转路由，不再做失效的 DOM 注入', () => {
  assert.match(indexSource, /path: '\/qqbot-dashboard'/, 'Host 半必须注册跳转路由');
  assert.match(indexSource, /res\.statusCode = 302/, '跳转必须是 302');
  assert.doesNotMatch(indexSource, /tapIndex/, '旧版 tapIndex DOM 注入已失效，不应保留');
  assert.doesNotMatch(indexSource, /qqbot-dashboard-inline-link/, '旧版内联脚本标记不应保留');
});
