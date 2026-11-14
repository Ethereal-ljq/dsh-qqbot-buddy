#!/usr/bin/env node
/**
 * scripts/install-template.mjs —— 把自定义卡片模板装到数据目录。
 *
 * 模板约定：目录里放 index.html（可选 meta.json: {label,description}、assets/），
 * 安装后位于 <dataDir>/templates/<名字>/，控制台「卡片模板」下拉即可选到。
 *
 * 用法：
 *   node scripts/install-template.mjs                        # 安装 custom/templates 下全部
 *   node scripts/install-template.mjs minimal                # 安装随包的最简示例模板
 *   node scripts/install-template.mjs ./some/template --name my-card
 *   node scripts/install-template.mjs minimal --data-dir /data/qqbot
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CUSTOM_ROOT = path.join(REPO_ROOT, 'custom', 'templates');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function usage(message) {
  if (message) console.error('✗ ' + message);
  console.error('用法：node scripts/install-template.mjs [模板名|模板目录] [--name 名字] [--data-dir 数据目录]');
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = { target: '', name: '', dataDir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--name' || arg === '-n') out.name = String(argv[++i] || '');
    else if (arg === '--data-dir' || arg === '-d') out.dataDir = String(argv[++i] || '');
    else if (!arg.startsWith('-')) out.target = arg;
  }
  return out;
}

function isTemplateDir(dir) {
  try { return fs.statSync(path.join(dir, 'index.html')).isFile(); } catch { return false; }
}

function resolveSource(target) {
  if (target) {
    const asPath = path.resolve(target);
    if (isTemplateDir(asPath)) return { dir: asPath, name: path.basename(asPath) };
    const named = path.join(CUSTOM_ROOT, target);
    if (isTemplateDir(named)) return { dir: named, name: target };
    return null;
  }
  return { dir: '', name: 'all' };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = resolveSource(args.target);
  if (!source) return usage('找不到模板：' + args.target);
  const dataDir = path.resolve(
    args.dataDir || process.env.QQBOT_DATA_DIR || path.join(os.homedir(), '.dsh-qqbot', 'v2'),
  );

  let jobs;
  if (source.name === 'all') {
    if (!fs.existsSync(CUSTOM_ROOT)) return usage('没有 custom/templates 目录');
    jobs = fs.readdirSync(CUSTOM_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isTemplateDir(path.join(CUSTOM_ROOT, entry.name)))
      .map((entry) => ({ dir: path.join(CUSTOM_ROOT, entry.name), name: entry.name }));
    if (jobs.length === 0) return usage('custom/templates 下没有可安装的模板');
  } else {
    jobs = [{ dir: source.dir, name: args.name || source.name }];
  }

  for (const job of jobs) {
    if (!NAME_RE.test(job.name)) { console.error('✗ 模板名不合法：' + job.name); process.exitCode = 1; continue; }
    const dest = path.join(dataDir, 'templates', job.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(job.dir, dest, { recursive: true });
    console.log('✓ ' + job.name + ' → ' + dest);
  }
  console.log('数据目录：' + dataDir + '；刷新控制台即可在「卡片模板」里看到。');
}

main();
