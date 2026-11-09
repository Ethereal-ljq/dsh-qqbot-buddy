#!/usr/bin/env node
/**
 * 开发环境准备：把宿主 dsh 的 @deepseek-ai/* peer 依赖软链到本仓库 node_modules。
 * 生产安装时这些包由 profile 的 node_modules 提供，不需要本脚本。
 *
 * 用法：node scripts/setup-dev.mjs [dsh-package-dir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HIGH_PRIORITY = ['schemastery', 'cordis', 'dsh-session', 'dsh-llm', 'dsh-tools', 'dsh-agent', 'dsh-agent-preset', 'dsh-attachment'];

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(here);
const targetDir = path.join(repoRoot, 'node_modules', '@deepseek-ai');

function resolveDshDir() {
  const fromArg = process.argv[2];
  if (fromArg) return path.resolve(fromArg);
  const require = createRequire(path.join(repoRoot, 'package.json'));
  try {
    return path.dirname(require.resolve('@deepseek-ai/dsh/package.json'));
  } catch { /* fallthrough */ }
  const candidates = [
    process.env.DSH_PACKAGE_DIR,
    path.join(process.env.HOME || '', '.nvm/versions/node', process.version, 'lib/node_modules/@deepseek-ai/dsh'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return '';
}

const dshDir = resolveDshDir();
if (!dshDir) {
  console.error('找不到 dsh 安装目录；请传参：node scripts/setup-dev.mjs <dsh-package-dir>');
  process.exit(1);
}
const sourceDir = path.join(dshDir, 'node_modules', '@deepseek-ai');
if (!fs.existsSync(sourceDir)) {
  console.error('dsh 安装目录下没有 node_modules/@deepseek-ai: ' + sourceDir);
  process.exit(1);
}
fs.mkdirSync(targetDir, { recursive: true });

let linked = 0;
for (const name of fs.readdirSync(sourceDir)) {
  const source = path.join(sourceDir, name);
  if (!fs.statSync(source).isDirectory()) continue;
  if (!HIGH_PRIORITY.includes(name) && !name.startsWith('dsh-')) continue;
  const dest = path.join(targetDir, name);
  try {
    if (fs.existsSync(dest) || fs.lstatSync(dest, { throwIfNoEntry: false })) fs.rmSync(dest, { recursive: true, force: true });
  } catch { /* ignore */ }
  fs.symlinkSync(source, dest, 'dir');
  linked += 1;
}
console.log('已链接 ' + linked + ' 个 @deepseek-ai 包 → ' + targetDir);
console.log('宿主 dsh: ' + dshDir);
