#!/usr/bin/env node
/**
 * dsh-qqbot-buddy v2 安装器：把插件装进某个 dsh profile 并登记为 bundle。
 *
 * 设计原则（自包含）：
 *   - 运行时零外部服务：控制台在插件进程内、数据用 node:sqlite（Node 内置）、前端产物随包携带；
 *   - 安装阶段不构建、不联网拉前端依赖：web/dist 已在包内（--build 仅开发时用）；
 *   - @deepseek-ai/* 由宿主 profile 提供（peerDependenciesMeta.optional），不下载。
 *
 * 用法：
 *   npx -y github:Ethereal-ljq/dsh-qqbot-buddy#v2                 # 从 GitHub 安装到 web profile
 *   npx -y github:Ethereal-ljq/dsh-qqbot-buddy#v2 --profile tui   # 指定 profile
 *   node scripts/install.mjs --local                              # 从本地仓库安装（开发用，复制 + 登记）
 *   node scripts/install.mjs --dry-run                            # 只看会做什么
 *
 * 环境变量：DSH_HOME（默认 ~/.dsh）、DSH_BIN（默认 PATH 里的 dsh）、DSH_PROFILE、QQBOT_SPEC
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DEFAULT_PKG = 'dsh-qqbot-buddy';
const DEFAULT_SPEC = process.env.QQBOT_SPEC || 'github:Ethereal-ljq/dsh-qqbot-buddy#v2';
const FLAG = '[qqbot-install]';
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const log = (msg) => process.stdout.write(FLAG + ' ' + msg + '\n');
const warn = (msg) => process.stderr.write(FLAG + ' ' + msg + '\n');
const die = (msg, code = 1) => { process.stderr.write(FLAG + ' 错误: ' + msg + '\n'); process.exit(code); };
const errText = (err) => (err instanceof Error ? err.message : String(err));

function printHelp() {
  process.stdout.write([
    '用法: dsh-qqbot-buddy-install [选项]',
    '',
    '把 dsh-qqbot-buddy v2 安装进指定 dsh profile 并登记为 bundle。',
    '',
    '选项:',
    '  -p, --profile <name>  dsh profile 名（默认 web，可用 DSH_PROFILE 覆盖）',
    '  -s, --spec <spec>     安装源（默认 ' + DEFAULT_SPEC + '）',
    '      --name <name>     插件包名（默认 ' + DEFAULT_PKG + '）',
    '      --local           本地安装：复制本仓库到 profile node_modules（不经过 pnpm）',
    '      --build           安装前构建控制台前端（默认跳过：包内自带 web/dist）',
    '      --dry-run         只打印将执行的操作，不写盘',
    '      --skip-check      跳过最后的 dump-config 自检',
    '  -h, --help            显示本帮助',
    '',
  ].join('\n'));
}

function parseArgs(argv) {
  const out = {
    profile: process.env.DSH_PROFILE || 'web',
    spec: DEFAULT_SPEC,
    name: DEFAULT_PKG,
    local: false,
    build: false,
    dryRun: false,
    skipCheck: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile' || arg === '-p') out.profile = argv[++i];
    else if (arg === '--spec' || arg === '-s') out.spec = argv[++i];
    else if (arg === '--name') out.name = argv[++i];
    else if (arg === '--local') out.local = true;
    else if (arg === '--build') out.build = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--skip-check') out.skipCheck = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else die('未知参数: ' + arg + '（--help 查看用法）');
  }
  if (!out.profile) die('--profile 不能为空');
  return out;
}

/** dsh 随附 profile 必须包含的基础 bundle；缺失时说明 profile 还没初始化。 */
const REQUIRED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/** 读 profile manifest（不存在返回 null）。 */
function readProfileManifest(profileDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** profile 是否需要从 dsh 随附模板初始化。 */
function profileNeedsInit(profileDir) {
  const manifest = readProfileManifest(profileDir);
  if (!manifest) return true;
  const bundles = manifest && manifest.dsh && manifest.dsh.profile && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : [];
  return REQUIRED_BUNDLES.some((name) => !bundles.includes(name));
}

/**
 * 用 dsh 随附模板初始化 profile。
 * 全新 DSH_HOME 直接安装会生成只含本插件的最小 profile（缺 dsh-base/dsh-web-app），
 * dsh 启动时插件 pending 后退出——所以安装前必须先初始化。
 */
/**
 * 初始化一个还不存在的 profile。
 *
 * 注意：新版 dsh 的 --dump-default-config 要求 profile 已存在（不存在会报
 * "profile does not exist; create it with dsh plugin --profile <name> add <package>"），
 * 所以初始化统一走 dsh plugin add —— 它会在全新 DSH_HOME 里创建 profile 并登记基础 bundle。
 * 本地安装用仓库路径交给 pnpm（随后 copyLocal 覆盖为纯文件副本），远程安装则直接 add 安装源。
 */
function initProfile(profile, opts, root) {
  log('初始化 profile（dsh plugin add）...');
  // 本地模式也走 tarball 安装：pnpm 会一并装好插件的运行期依赖（qrcode / qqbot-nodejs 等），
  // 装完再用 copyLocal 覆盖成纯文件副本（不依赖仓库 node_modules）。
  let spec = opts.spec;
  let tarballDir = '';
  if (opts.local) {
    tarballDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-install-'));
    const pack = spawnSync('npm', ['pack', '--pack-destination', tarballDir], { cwd: root, encoding: 'utf8' });
    if (pack.status !== 0) die('本地打包失败（npm pack 退出码 ' + pack.status + '）');
    const tgz = fs.readdirSync(tarballDir).find((name) => name.endsWith('.tgz'));
    if (!tgz) die('本地打包失败（没找到 tgz）');
    spec = path.join(tarballDir, tgz);
  }
  const result = spawnDsh(['plugin', '--profile', profile, 'add', spec], { stdio: 'inherit' });
  if (tarballDir !== '') fs.rmSync(tarballDir, { recursive: true, force: true });
  if (result.status !== 0) die('profile 初始化失败（dsh plugin --profile ' + profile + ' add 退出码 ' + result.status + '）');
}

const dshHome = () => {
  const explicit = (process.env.DSH_HOME || '').trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), '.dsh');
};
const profileDirOf = (home, profile) => path.join(home, 'profiles', profile);

function spawnDsh(args, options = {}) {
  const bin = (process.env.DSH_BIN || 'dsh').trim() || 'dsh';
  const result = spawnSync(bin, args, { encoding: 'utf8', ...options });
  if (result.error && result.error.code === 'ENOENT') die('找不到 dsh 命令，请先安装 DeepSeek Harness，或用 DSH_BIN=/path/to/dsh 指定');
  return result;
}

const tail = (text, lines = 12) => String(text || '').trim().split('\n').filter(Boolean).slice(-lines).join('\n');

/** web/dist 是否已就绪（自包含安装的前提）。 */
function distReady(root) {
  const file = path.join(root, 'web', 'dist', 'index.html');
  return fs.existsSync(file);
}

/** 开发用：构建控制台前端（需要 web/node_modules；仅 --build 时执行）。 */
function buildConsole(root) {
  const webDir = path.join(root, 'web');
  if (!fs.existsSync(path.join(webDir, 'node_modules'))) {
    log('构建前端：安装 web 依赖（npm ci）...');
    const ci = spawnSync('npm', ['--prefix', webDir, 'ci', '--no-audit', '--no-fund'], { stdio: 'inherit' });
    if (ci.status !== 0) die('web 依赖安装失败');
  }
  log('构建前端：npm run build ...');
  const build = spawnSync('npm', ['--prefix', webDir, 'run', 'build'], { stdio: 'inherit' });
  if (build.status !== 0) die('控制台前端构建失败');
  if (!distReady(root)) die('构建后仍找不到 web/dist/index.html');
}

/** 本地安装：把仓库复制进 profile/node_modules（跳过 node_modules/.git/test 等）。 */
function copyLocal(repoRoot, dest) {
  // 任意层级跳过 node_modules/.git/.work；顶层再跳过 test（安装包不需要测试）
  const skipNames = new Set(['node_modules', '.git', '.work']);
  const walk = (from, to, depth) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (skipNames.has(entry.name)) continue;
      if (depth === 0 && entry.name === 'test') continue;
      const src = path.join(from, entry.name);
      const out = path.join(to, entry.name);
      if (entry.isDirectory()) walk(src, out, depth + 1);
      else if (entry.isFile()) fs.copyFileSync(src, out);
    }
  };
  walk(repoRoot, dest, 0);
}

/** 把包名登记进 profile package.json 的 dsh.profile.bundles（幂等，原子写）。 */
function registerBundle(profileDir, pkgName) {
  const file = path.join(profileDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // 本地安装时 profile 可能还没初始化：建一个最小 manifest
      manifest = { name: 'dsh-profile-' + path.basename(profileDir), private: true };
    } else {
      die('读取 profile package.json 失败（' + file + '）: ' + errText(err));
    }
  }
  manifest.dsh = manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh : {};
  manifest.dsh.profile = manifest.dsh.profile && typeof manifest.dsh.profile === 'object' ? manifest.dsh.profile : {};
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  const changed = !bundles.includes(pkgName);
  if (changed) bundles.push(pkgName);
  manifest.dsh.profile.bundles = bundles;
  fs.mkdirSync(profileDir, { recursive: true });
  const tmp = file + '.qqbot-install-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { changed, bundles, file };
}

/** 自检：dump-config 里应出现插件 id。 */
function selfCheck(opts, profile) {
  if (opts.skipCheck) return;
  log('自检（dump-config）...');
  const check = spawnDsh(['--profile', profile, '--dump-config'], { encoding: 'utf8' });
  const text = String(check.stdout || '') + String(check.stderr || '');
  if (check.status !== 0) {
    warn('dump-config 失败（退出码 ' + check.status + '）：\n' + tail(text));
  } else if (!/qqbot-buddy/.test(text)) {
    warn('dump-config 成功但没找到 qqbot-buddy 条目，可能安装没生效');
  } else {
    log('   已确认 qqbot-buddy 进入插件树');
  }
}

function printNextSteps() {
  log('');
  log('安装完成 ✅（控制台随插件启动，默认 http://127.0.0.1:6198）');
  log('');
  log('下一步：');
  log('  1. 重启 dsh（例如重新执行 dsh web）');
  log('  2. 打开控制台 → 用 <dataDir>/console-token.txt 里的 token 登录（首次启动生成）');
  log('     默认路径：~/.dsh-qqbot/v2/console-token.txt');
  log('  3. 控制台「机器人」页新建/编辑机器人（appId/appSecret），再启动');
  log('  4. 每个 bot 的工作目录在 <workspace>/bots/<botId>，独立数据、共享同一份记忆/知识库');
  log('');
  log('提示：同一个 AppID 只能有一条 WebSocket 连接；装过官方 @tencent-connect/dsh-qqbot 的话请先停用。');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = dshHome();
  const profileDir = profileDirOf(home, opts.profile);
  const root = REPO_ROOT;

  log('DSH_HOME : ' + home);
  log('profile  : ' + opts.profile + '  (' + profileDir + ')');
  log('安装源   : ' + (opts.local ? '本地仓库 ' + REPO_ROOT : opts.spec));
  log('包名     : ' + opts.name);
  log('Node     : ' + process.version + '（要求 >=24）');

  if (opts.dryRun) {
    log('dry-run 将执行：');
    log('  1) 控制台前端：' + (distReady(root) ? '已就绪，跳过构建' : (opts.build ? '构建' : '缺失（包内应有 dist；开发时可加 --build）')));
    if (opts.local) log('  2) 复制 ' + REPO_ROOT + ' → ' + path.join(profileDir, 'node_modules', opts.name));
    else log('  2) dsh plugin --profile ' + opts.profile + ' add ' + opts.spec);
    log('  3) 在 ' + path.join(profileDir, 'package.json') + ' 的 dsh.profile.bundles 追加 "' + opts.name + '"');
    log('  4) dsh --profile ' + opts.profile + ' --dump-config（自检）');
    return;
  }

  // 0. profile 初始化（全新 DSH_HOME 必须；否则会缺 dsh-base/dsh-web-app）
  if (profileNeedsInit(profileDir)) {
    if (opts.local) initProfile(opts.profile, opts, root);
    else log('profile 未初始化：由下一步的 dsh plugin add 自动创建');
  } else log('profile 已初始化，跳过');

  // 0.5 自包含前提：前端产物
  if (opts.build) buildConsole(root);
  else if (!distReady(root)) {
    warn('web/dist 不存在；将从源码构建（需要 web/node_modules）。生产包应自带 dist，跳过可用 --skip-check。');
    buildConsole(root);
  }

  // 1. 安装
  if (opts.local) {
    const dest = path.join(profileDir, 'node_modules', opts.name);
    log('1/3 本地复制 → ' + dest + ' ...');
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    copyLocal(REPO_ROOT, dest);
    // 生产依赖由宿主 profile 提供；本地装时补不了 @deepseek-ai（宿主已有），其它依赖在仓库 node_modules
  } else {
    log('1/3 安装包（dsh plugin add）...');
    const result = spawnDsh(['plugin', '--profile', opts.profile, 'add', opts.spec], { stdio: 'inherit' });
    if (result.status !== 0) die('安装失败（退出码 ' + result.status + '）');
  }

  // 2. 登记 bundle
  const registered = registerBundle(profileDir, opts.name);
  log(registered.changed ? '2/3 已登记 dsh.profile.bundles' : '2/3 bundle 已登记，跳过');

  // 3. 自检
  selfCheck(opts, opts.profile);
  printNextSteps();
}

main();
