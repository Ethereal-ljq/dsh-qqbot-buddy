#!/usr/bin/env node
/**
 * dsh-qqbot-buddy 安装器：一条命令把插件装进某个 dsh profile 并登记为 bundle。
 *
 * 用法：
 *   npx -y github:Ethereal-ljq/dsh-qqbot-buddy                  # 从 GitHub 安装到 web profile
 *   npx -y github:Ethereal-ljq/dsh-qqbot-buddy --profile tui    # 指定 profile
 *   node scripts/install.mjs --spec .                           # 从本地仓库安装（开发用）
 *   node scripts/install.mjs --dry-run                          # 只看会做什么
 *
 * 它做三件事（幂等，可重复执行）：
 *   1. dsh plugin --profile <p> add <spec>   （初始化 profile + pnpm 装包）
 *   2. 把包名写进 profile package.json 的 dsh.profile.bundles（否则 dsh 不会加载）
 *   3. dsh --profile <p> --dump-config 自检，确认 qqbot-buddy 已进入插件树
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_PKG = 'dsh-qqbot-buddy';
const DEFAULT_SPEC = 'github:Ethereal-ljq/dsh-qqbot-buddy';
const FLAG = '[qqbot-install]';

function log(msg) { process.stdout.write(FLAG + ' ' + msg + '\n'); }
function warn(msg) { process.stderr.write(FLAG + ' ' + msg + '\n'); }
function die(msg, code = 1) { process.stderr.write(FLAG + ' 错误: ' + msg + '\n'); process.exit(code); }

function printHelp() {
  process.stdout.write([
    '用法: dsh-qqbot-buddy-install [选项]',
    '',
    '把 dsh-qqbot-buddy 安装进指定 dsh profile 并登记为 bundle。',
    '',
    '选项:',
    '  -p, --profile <name>  dsh profile 名（默认 web，可用 DSH_PROFILE 覆盖）',
    '  -s, --spec <spec>     安装源（默认 ' + DEFAULT_SPEC + '；本地仓库用 "." 或路径）',
    '      --name <name>     插件包名（默认 ' + DEFAULT_PKG + '）',
    '      --dry-run         只打印将执行的操作，不写盘',
    '      --skip-check      跳过最后的 dump-config 自检',
    '  -h, --help            显示本帮助',
    '',
    '环境变量: DSH_HOME（默认 ~/.dsh）、DSH_BIN（默认 PATH 里的 dsh）、DSH_PROFILE',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const out = { profile: process.env.DSH_PROFILE || 'web', spec: DEFAULT_SPEC, name: DEFAULT_PKG, dryRun: false, skipCheck: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile' || arg === '-p') out.profile = argv[++i];
    else if (arg === '--spec' || arg === '-s') out.spec = argv[++i];
    else if (arg === '--name') out.name = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--skip-check') out.skipCheck = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else die('未知参数: ' + arg + '（--help 查看用法）');
  }
  if (!out.profile) die('--profile 不能为空');
  return out;
}

function dshHome() {
  const explicit = (process.env.DSH_HOME || '').trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), '.dsh');
}

function spawnDsh(args, options = {}) {
  const bin = (process.env.DSH_BIN || 'dsh').trim() || 'dsh';
  const result = spawnSync(bin, args, { encoding: 'utf8', ...options });
  if (result.error && result.error.code === 'ENOENT') {
    die('找不到 dsh 命令，请先安装 DeepSeek Harness，或用 DSH_BIN=/path/to/dsh 指定');
  }
  return result;
}

function tail(text, lines = 12) {
  const all = String(text || '').trim().split('\n').filter(Boolean);
  return all.slice(-lines).join('\n');
}

/** pnpm 对 git 源可能要求 allowBuilds：把包名追加进 profile 的 pnpm-workspace.yaml。 */
function allowBuilds(profileDir, pkgName) {
  const file = path.join(profileDir, 'pnpm-workspace.yaml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
  if (/allowBuilds\s*:/.test(text)) {
    if (text.includes(pkgName)) return false;
    const next = text.replace(/allowBuilds\s*:(\s*\n?)/, (m) => m + '  - ' + pkgName + '\n');
    fs.writeFileSync(file, next, 'utf8');
    return true;
  }
  const block = (text.endsWith('\n') || text === '' ? text : text + '\n')
    + 'allowBuilds:\n  - ' + pkgName + '\n';
  fs.writeFileSync(file, block, 'utf8');
  return true;
}

/** 把包名登记进 profile package.json 的 dsh.profile.bundles（幂等，原子写）。 */
function registerBundle(profileDir, pkgName) {
  const file = path.join(profileDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    die('读取 profile package.json 失败（' + file + '）: ' + err.message);
  }
  manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {};
  manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {};
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  if (bundles.includes(pkgName)) return { changed: false, bundles };
  bundles.push(pkgName);
  manifest.dsh.profile.bundles = bundles;
  const tmp = file + '.qqbot-install-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { changed: true, bundles };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = dshHome();
  const profileDir = path.join(home, 'profiles', opts.profile);

  log('DSH_HOME   : ' + home);
  log('profile    : ' + opts.profile + '  (' + profileDir + ')');
  log('安装源     : ' + opts.spec);
  log('包名       : ' + opts.name);

  if (opts.dryRun) {
    log('dry-run 将执行：');
    log('  1) dsh plugin --profile ' + opts.profile + ' add ' + opts.spec);
    log('  2) 在 ' + path.join(profileDir, 'package.json') + ' 的 dsh.profile.bundles 追加 "' + opts.name + '"');
    log('  3) dsh --profile ' + opts.profile + ' --dump-config（自检）');
    return;
  }

  // 1. 装包（dsh plugin 初始化 profile 并转发给 pnpm）
  log('1/3 安装包 ...');
  let result = spawnDsh(['plugin', '--profile', opts.profile, 'add', opts.spec], { stdio: 'inherit' });
  if (result.status !== 0) {
    const detail = String(result.stderr || '') + String(result.stdout || '');
    if (/allowBuilds|build scripts|approve-builds/i.test(detail)) {
      warn('pnpm 要求允许构建脚本，正在写入 allowBuilds 后重试 ...');
      if (allowBuilds(profileDir, opts.name)) {
        result = spawnDsh(['plugin', '--profile', opts.profile, 'add', opts.spec], { stdio: 'inherit' });
      }
    }
    if (result.status !== 0) {
      const again = String(result.stderr || '') + String(result.stdout || '');
      die('安装失败（退出码 ' + result.status + '）。' + (again ? '\n' + tail(again) : ''));
    }
  }

  // 2. 登记 bundle
  const registered = registerBundle(profileDir, opts.name);
  log(registered.changed
    ? '2/3 已把 "' + opts.name + '" 登记进 dsh.profile.bundles'
    : '2/3 bundle 已登记，跳过');

  // 3. 自检
  if (!opts.skipCheck) {
    log('3/3 自检（dump-config）...');
    const check = spawnDsh(['--profile', opts.profile, '--dump-config'], { encoding: 'utf8' });
    const text = String(check.stdout || '') + String(check.stderr || '');
    if (check.status !== 0) {
      warn('dump-config 失败（退出码 ' + check.status + '），请手动检查：\n' + tail(text));
    } else if (!/qqbot-buddy/.test(text)) {
      warn('dump-config 成功但没找到 qqbot-buddy 条目，可能安装没生效，请检查上一步输出。');
    } else {
      log('   已确认 qqbot-buddy 进入插件树');
    }
  }

  log('');
  log('安装完成 ✅');
  log('');
  log('下一步：');
  log('  1. 重启 dsh（例如重新执行 dsh web），让它加载新插件');
  log('  2. 打开 dsh Web -> 设置 -> QQ 机器人');
  log('  3. 没有凭据时会显示二维码：手机 QQ 扫码完成绑定（或在 q.qq.com 建机器人后手填 appId/appSecret）');
  log('');
  log('提示：同一个 AppID 只能有一条 WebSocket 连接；如果之前装过官方 @tencent-connect/dsh-qqbot，请先停用它。');
}

main();
