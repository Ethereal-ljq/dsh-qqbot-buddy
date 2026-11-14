#!/usr/bin/env node
/**
 * scripts/verify-standalone-install.mjs —— 独立环境安装验收（发版前必跑）。
 *
 * 目标：站在「全新机器上的新用户」角度，用**发布包本身**（npm pack 产物）走一遍
 * 安装 → 启动 → 控制台 → dsh Web 客户端入口 的全链路，证明这个包脱离仓库也能独立运行。
 *
 * 隔离手段：
 *   - 独立 HOME（npm/pnpm 缓存、pnpm store 全在临时目录，不读写真实 ~/.npm）
 *   - 独立 DSH_HOME（用 dsh plugin add 从零创建 profile，走用户真实安装路径）
 *   - 独立 dataDir / workspaceRoot / 控制台端口（不碰线上 ~/.dsh-qqbot）
 *
 * 用法：
 *   node scripts/verify-standalone-install.mjs                    # 打包 → 隔离安装 → 启动验收
 *   node scripts/verify-standalone-install.mjs --keep             # 保留临时目录（排查用）
 *   node scripts/verify-standalone-install.mjs --spec dsh-qqbot-buddy@next   # 验收 npm 上的包
 *   node scripts/verify-standalone-install.mjs --skip-boot        # 只验安装与 dump-config
 *
 * 退出码：0 = 全部通过；1 = 有失败项（逐项打印 PASS/FAIL，报告写到 --json）。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REQUIRED_IN_TARBALL = [
  'package/package.json',
  'package/lib/index.js',
  'package/lib/client.js',
  'package/lib/console/server.js',
  'package/cordis.patch.yml',
  'package/web/dist/index.html',
  'package/README.md',
  'package/LICENSE',
  'package/scripts/install.mjs',
  'package/scripts/verify-standalone-install.mjs',
  'package/docs/USER-GUIDE.md',
  'package/custom/templates/minimal/index.html',
  'package/custom/templates/minimal/meta.json',
];

const FORBIDDEN_IN_TARBALL = [
  'package/test/',
  'package/.work/',
  'package/node_modules/',
  'package/web/src/',
  'package/web/node_modules/',
  'package/dsh-image-gen/',
  'package/.git/',
  // 文档截图只在 GitHub / CDN 上服务；本地自定义模板（可能带第三方素材）不随包
  'package/docs/images/',
  'package/custom/templates/anime/',
];

const RUNTIME_DEPS = ['@tencent-connect/qqbot-nodejs', 'qrcode', 'ws'];

function parseArgs(argv) {
  const out = {
    root: '',
    spec: '',
    profile: 'web',
    consolePort: 0,
    webPort: 0,
    keep: false,
    skipBoot: false,
    timeoutMs: 180000,
    json: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') out.root = String(argv[++i] || '');
    else if (arg === '--spec' || arg === '-s') out.spec = String(argv[++i] || '');
    else if (arg === '--profile' || arg === '-p') out.profile = String(argv[++i] || '');
    else if (arg === '--console-port') out.consolePort = Number(argv[++i]);
    else if (arg === '--web-port') out.webPort = Number(argv[++i]);
    else if (arg === '--timeout') out.timeoutMs = Number(argv[++i]);
    else if (arg === '--json') out.json = String(argv[++i] || '');
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--skip-boot') out.skipBoot = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else {
      console.error('[standalone] 未知参数: ' + arg);
      printHelp();
      process.exit(1);
    }
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) out.timeoutMs = 180000;
  return out;
}

function printHelp() {
  console.log([
    '用法: node scripts/verify-standalone-install.mjs [选项]',
    '',
    '  --root <dir>          临时根目录（默认 /tmp/qqbot-standalone-<时间戳>）',
    '  --spec <spec>         安装源；默认对当前仓库 npm pack 出的 tarball',
    '                        传 npm 规格可验收线上包，例如 dsh-qqbot-buddy@next',
    '  --profile <name>      dsh profile 名（默认 web）',
    '  --console-port <n>    控制台端口（默认挑空闲端口）',
    '  --web-port <n>        dsh Web 端口（默认挑空闲端口）',
    '  --timeout <ms>        启动等待超时（默认 180000）',
    '  --json <file>         报告路径（默认 <root>/standalone-report.json）',
    '  --keep                跑完保留临时目录',
    '  --skip-boot           只验证安装/包内容/dump-config，不启动实例',
    '  -h, --help            显示本帮助',
  ].join('\n'));
}

/** 隔离环境：HOME/DSH_HOME/各种缓存全部落在临时根目录。 */
function isolatedEnv(root) {
  const home = path.join(root, 'home');
  return Object.assign({}, process.env, {
    HOME: home,
    DSH_HOME: path.join(home, '.dsh'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    npm_config_cache: path.join(home, '.npm'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  });
}

function findDsh() {
  const explicit = String(process.env.DSH_BIN || '').trim();
  if (explicit !== '') return explicit;
  const which = spawnSync('which', ['dsh'], { encoding: 'utf8' });
  return String(which.stdout || '').trim();
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(400);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(true));
  });
}

async function findFreePort(start) {
  for (let port = start; port < start + 200; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('找不到空闲端口（从 ' + start + ' 起）');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function tail(text, lines = 20) {
  return String(text || '').trim().split('\n').filter(Boolean).slice(-lines).join('\n');
}

function walkFiles(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/** 简易 HTTP 客户端：带 cookie，改状态方法自动补 CSRF 头。 */
function createHttp(baseUrl) {
  let cookie = '';
  async function request(method, route, body) {
    const headers = { 'content-type': 'application/json' };
    if (cookie !== '') {
      headers.cookie = cookie;
      headers['x-qqbot-csrf'] = '1';
    }
    const response = await fetch(baseUrl + route, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const item of cookies) {
      const match = /qqbot_console_sid=([^;]*)/.exec(item);
      if (match) cookie = 'qqbot_console_sid=' + match[1];
    }
    const text = await response.text();
    let json = null;
    try { json = text === '' ? null : JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, headers: response.headers };
  }
  return { request, get cookie() { return cookie; } };
}

/**
 * 手动跟随重定向并携带 cookie。
 *
 * dsh Web 的鉴权是「带 token 的根路径 → 302 到 ./ 并 set-cookie」，
 * 而 Node 自带 fetch 没有 cookie jar，直接 redirect:'follow' 会在第二跳丢 cookie 拿到 401。
 */
async function fetchWithCookieJar(url, options = {}) {
  const jar = new Map();
  let current = url;
  let response = null;
  for (let hop = 0; hop < 6; hop += 1) {
    const headers = Object.assign({}, options.headers || {});
    if (jar.size > 0) headers.cookie = [...jar].map(([key, value]) => key + '=' + value).join('; ');
    response = await fetch(current, Object.assign({}, options, { headers, redirect: 'manual' }));
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const item of setCookies) {
      const pair = String(item).split(';')[0] || '';
      const index = pair.indexOf('=');
      if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    break;
  }
  return response;
}

async function waitForHealth(baseUrl, timeoutMs, state) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exited) return false;
    try {
      const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) return true;
    } catch { /* 还没起来 */ }
    await SLEEP(400);
  }
  return false;
}

function writePatchFile(root, dataDir, workspaceRoot, consolePort) {
  const file = path.join(root, 'standalone.patch.yml');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(file, [
    '# 独立安装验收用的覆盖层（临时目录，不提交）',
    '- id: qqbot-buddy',
    '  config:',
    '    dataDir: ' + JSON.stringify(dataDir),
    '    workspaceRoot: ' + JSON.stringify(workspaceRoot),
    '    debug: true',
    '    autoStart: true',
    '    console:',
    '      enabled: true',
    '      host: 127.0.0.1',
    '      port: ' + consolePort,
    "      token: ''",
    '',
  ].join('\n'), 'utf8');
  return file;
}

function startInstance(dshBin, env, opts, patchFile, logFile) {
  const stream = fs.createWriteStream(logFile, { flags: 'w' });
  const child = spawn(dshBin, [
    '--profile', opts.profile,
    '--patch', patchFile,
    '--port', String(opts.webPort),
    '--no-open',
  ], { cwd: opts.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, stream, logFile, exited: false, exit: null };
  child.stdout.on('data', (chunk) => stream.write(chunk));
  child.stderr.on('data', (chunk) => stream.write(chunk));
  child.on('exit', (code, signal) => { state.exited = true; state.exit = { code, signal }; });
  return state;
}

async function stopInstance(state) {
  if (!state || state.exited) return;
  try { state.child.kill('SIGTERM'); } catch { /* ignore */ }
  const deadline = Date.now() + 12000;
  while (!state.exited && Date.now() < deadline) await SLEEP(200);
  if (!state.exited) { try { state.child.kill('SIGKILL'); } catch { /* ignore */ } }
  try { state.stream.end(); } catch { /* ignore */ }
  await SLEEP(400);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  opts.root = path.resolve(opts.root !== '' ? opts.root : path.join(os.tmpdir(), 'qqbot-standalone-' + stamp));
  opts.consolePort = opts.consolePort > 0 ? await findFreePort(opts.consolePort) : await findFreePort(6240);
  opts.webPort = opts.webPort > 0 ? await findFreePort(opts.webPort) : await findFreePort(3390);

  const env = isolatedEnv(opts.root);
  const dataDir = path.join(opts.root, 'data');
  const workspaceRoot = path.join(opts.root, 'workspace');
  const tarballDir = path.join(opts.root, 'tarball');
  const logDir = path.join(opts.root, 'logs');
  const jsonFile = opts.json !== '' ? path.resolve(opts.json) : path.join(opts.root, 'standalone-report.json');
  for (const dir of [dataDir, workspaceRoot, tarballDir, logDir, env.HOME]) fs.mkdirSync(dir, { recursive: true });

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail: String(detail || '') });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
    return Boolean(ok);
  };

  console.log('[standalone] 根目录 : ' + opts.root);
  console.log('[standalone] HOME   : ' + env.HOME);
  console.log('[standalone] DSH_HOME: ' + env.DSH_HOME);
  console.log('[standalone] 端口    : 控制台 ' + opts.consolePort + ' / dsh web ' + opts.webPort);

  const dshBin = findDsh();
  if (!check('dsh 可执行文件可用', dshBin !== '', dshBin)) throw new Error('找不到 dsh（可用 DSH_BIN 指定）');

  const nodeMajor = Number(process.version.replace(/^v/, '').split('.')[0]);
  check('Node 版本 ≥ 24', nodeMajor >= 24, process.version);

  const distIndex = path.join(REPO_ROOT, 'web', 'dist', 'index.html');
  const distReady = check('控制台前端产物已构建（web/dist/index.html）', fs.existsSync(distIndex), distIndex);
  if (!distReady) throw new Error('先执行 npm run console:build 再跑独立安装验收');

  // 1) 发布包：npm pack
  let spec = opts.spec;
  let tarball = '';
  if (spec === '') {
    console.log('[standalone] npm pack ...');
    const pack = spawnSync('npm', ['pack', '--pack-destination', tarballDir, '--loglevel', 'error'], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      timeout: 300000,
    });
    const packOut = String(pack.stdout || '');
    const fileName = packOut.trim().split('\n').filter(Boolean).pop() || '';
    tarball = path.join(tarballDir, fileName.replace(/^.*\//, ''));
    if (!check('npm pack 生成 tarball', pack.status === 0 && fs.existsSync(tarball), tarball + (pack.status === 0 ? '' : '\n' + tail(pack.stderr, 8)))) {
      throw new Error('npm pack 失败');
    }
    spec = tarball;
  } else {
    console.log('[standalone] 使用指定安装源: ' + spec);
  }

  // 2) 包内容断言（tarball 里该有的有、不该有的没有）
  if (tarball !== '') {
    const sizeKb = Math.round(fs.statSync(tarball).size / 1024);
    console.log('[standalone] tarball: ' + tarball + ' (' + sizeKb + ' KB)');
    const list = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', env });
    const files = String(list.stdout || '').split('\n').filter(Boolean);
    const missing = REQUIRED_IN_TARBALL.filter((item) => !files.includes(item));
    check('包内含发布必需文件', missing.length === 0, missing.length === 0 ? '共 ' + files.length + ' 个文件' : '缺少: ' + missing.join(', '));
    const unwanted = files.filter((item) => FORBIDDEN_IN_TARBALL.some((prefix) => item.startsWith(prefix)));
    check('包内不含测试/临时/源码依赖目录', unwanted.length === 0, unwanted.length === 0 ? '' : unwanted.slice(0, 6).join(', '));
    const distAssets = files.filter((item) => /^package\/web\/dist\/assets\/index-.*\.(js|css)$/.test(item));
    check('包内带控制台 dist 资产', distAssets.length >= 2, distAssets.join(', '));
    const repoAssets = fs.readdirSync(path.join(REPO_ROOT, 'web', 'dist', 'assets'));
    const sameAssets = repoAssets.every((name) => files.includes('package/web/dist/assets/' + name));
    check('包内 dist 与仓库当前构建一致', sameAssets, repoAssets.join(', '));
    const minimal = files.filter((item) => item.startsWith('package/custom/templates/minimal/')).length;
    check('包内自带最简示例模板（template:install 可用）', minimal >= 2, minimal + ' 个文件');
    const shippedImages = files.filter((item) => item.startsWith('package/docs/images/')).length;
    check('包内不含文档截图（只走 GitHub / CDN）', shippedImages === 0, String(shippedImages));
    const testFiles = files.filter((item) => item.startsWith('package/test/')).length;
    check('包内不含单元测试目录', testFiles === 0, String(testFiles));
    const pkgJson = JSON.parse(String(spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }).stdout));
    check('包内版本号与仓库一致', pkgJson.version === PKG.version, pkgJson.version + ' vs ' + PKG.version);
    check('包内声明 dsh.bundle.patch', pkgJson.dsh?.bundle?.patch === './cordis.patch.yml', String(pkgJson.dsh?.bundle?.patch));
    check('包内声明客户端半（exports["./client"]）', pkgJson.exports?.['./client'] === './lib/client.js', String(pkgJson.exports?.['./client']));
  }

  // 3) 安装：全新 DSH_HOME 走 dsh plugin add（用户真实安装路径）
  const profileDir = path.join(env.DSH_HOME, 'profiles', opts.profile);
  console.log('[standalone] dsh plugin --profile ' + opts.profile + ' add ' + spec + ' ...');
  const install = spawnSync(dshBin, ['plugin', '--profile', opts.profile, 'add', spec], {
    cwd: opts.root,
    env,
    encoding: 'utf8',
    timeout: 600000,
  });
  const installLog = String(install.stdout || '') + String(install.stderr || '');
  fs.writeFileSync(path.join(logDir, 'dsh-plugin-add.log'), installLog, 'utf8');
  if (!check('dsh plugin add 成功（含运行期依赖安装）', install.status === 0, 'exit=' + install.status + (install.status === 0 ? '' : '\n' + tail(installLog, 12)))) {
    throw new Error('安装失败，详见 ' + path.join(logDir, 'dsh-plugin-add.log'));
  }

  // 4) profile 状态断言
  const manifest = JSON.parse(readText(path.join(profileDir, 'package.json')) || '{}');
  const bundles = manifest?.dsh?.profile?.bundles || [];
  check('profile 自动登记插件为 bundle', bundles.includes('dsh-qqbot-buddy'), bundles.join(', '));
  check('profile 保留 dsh 基础 bundle', bundles.includes('@deepseek-ai/dsh-base') && bundles.includes('@deepseek-ai/dsh-web-app'), bundles.join(', '));
  check('profile 依赖表包含插件', Boolean((manifest.dependencies || {})['dsh-qqbot-buddy']), (manifest.dependencies || {})['dsh-qqbot-buddy'] || '');
  const pluginDir = path.join(profileDir, 'node_modules', 'dsh-qqbot-buddy');
  const pluginManifest = JSON.parse(readText(path.join(pluginDir, 'package.json')) || '{}');
  check('安装目录是可执行的包（非仓库符号链接）', pluginManifest.name === 'dsh-qqbot-buddy' && !fs.lstatSync(pluginDir).isSymbolicLink(), pluginDir);
  check('安装版本与发布包一致', pluginManifest.version === PKG.version, String(pluginManifest.version));
  const depMissing = RUNTIME_DEPS.filter((dep) => !fs.existsSync(path.join(profileDir, 'node_modules', dep, 'package.json')));
  check('运行期依赖已装好（ws/qrcode/qqbot-nodejs）', depMissing.length === 0, depMissing.length === 0 ? RUNTIME_DEPS.join(', ') : '缺少: ' + depMissing.join(', '));
  const pluginFiles = walkFiles(pluginDir);
  const hasDist = pluginFiles.includes(path.join('web', 'dist', 'index.html'));
  check('安装目录带控制台前端产物', hasDist, 'files=' + pluginFiles.length);
  const hasTests = pluginFiles.some((item) => item.split(path.sep)[0] === 'test');
  check('安装目录不含单元测试', !hasTests, '');

  // 5) dump-config：插件与 preset 都进了插件树
  const dump = spawnSync(dshBin, ['--profile', opts.profile, '--dump-config'], { cwd: opts.root, env, encoding: 'utf8', timeout: 180000 });
  const dumpText = String(dump.stdout || '') + String(dump.stderr || '');
  fs.writeFileSync(path.join(logDir, 'dump-config.log'), dumpText, 'utf8');
  check('dump-config 退出码 0', dump.status === 0, 'exit=' + dump.status);
  check('dump-config 含 qqbot-buddy 插件', /qqbot-buddy/.test(dumpText), '');
  check('dump-config 含 agent preset', /preset-qqbot-buddy/.test(dumpText), '');
  check('dump-config 无兼容性告警', !/incompatible with dsh/i.test(dumpText), /incompatible with dsh/i.test(dumpText) ? '出现 incompatible 告警' : '');

  if (opts.skipBoot) {
    finish(results, jsonFile, { root: opts.root, version: PKG.version, spec, skippedBoot: true }, opts.keep ? '' : opts.root);
    return;
  }

  // 6) 启动隔离实例
  const patchFile = writePatchFile(opts.root, dataDir, workspaceRoot, opts.consolePort);
  const baseUrl = 'http://127.0.0.1:' + opts.consolePort;
  console.log('[standalone] 启动 dsh（web 端口 ' + opts.webPort + '，控制台 ' + baseUrl + '）...');
  const state = startInstance(dshBin, env, opts, patchFile, path.join(logDir, 'dsh-web.log'));
  let stopped = false;
  try {
    const healthy = await waitForHealth(baseUrl, opts.timeoutMs, state);
    check('控制台随 dsh 启动（/api/health 200）', healthy, healthy ? baseUrl + '/api/health' : '超时/进程退出\n' + tail(readText(path.join(logDir, 'dsh-web.log')), 20));
    if (!healthy) throw new Error('控制台未启动');

    const tokenFile = path.join(dataDir, 'console-token.txt');
    const token = readText(tokenFile).trim();
    check('首次启动生成 console-token.txt', token.length > 0, tokenFile);
    check('数据目录生成 buddy.db', fs.existsSync(path.join(dataDir, 'buddy.db')), path.join(dataDir, 'buddy.db'));

    const http = createHttp(baseUrl);
    check('未登录访问 API 被拒（401）', (await http.request('GET', '/api/state')).status === 401, '');

    const login = await http.request('POST', '/api/auth/login', { token });
    check('token 登录成功', login.status === 200 && http.cookie !== '', 'HTTP ' + login.status);

    const stateRes = await http.request('GET', '/api/state');
    const body = stateRes.json || {};
    check('/api/state 可用', stateRes.status === 200, 'HTTP ' + stateRes.status);
    check('/api/state 版本号来自发布包', body.version === PKG.version, String(body.version));
    check('/api/state 控制台端口与配置一致', body.console?.port === opts.consolePort, String(body.console?.port));
    check('机器人列表为空（全新数据目录）', Array.isArray(body.bots) && body.bots.length === 0, 'bots=' + (Array.isArray(body.bots) ? body.bots.length : '?'));

    const tools = await http.request('GET', '/api/tools');
    const toolItems = tools.json?.items || [];
    check('/api/tools 发现宿主工具', tools.status === 200 && toolItems.length > 0, 'items=' + toolItems.length);

    const schema = await http.request('GET', '/api/schema');
    const items = schema.json?.items || [];
    check('/api/schema 可读（含 voice/vision 等设置项）', schema.status === 200 && items.length > 30, 'items=' + items.length);

    const slots = await http.request('GET', '/api/models/slots');
    check('/api/models/slots 可用', slots.status === 200, 'ready=' + JSON.stringify(slots.json?.ready));

    const templates = await http.request('GET', '/api/reports/templates');
    check('/api/reports/templates 含内置模板', templates.status === 200 && /journal/.test(templates.text) && /dark/.test(templates.text), 'HTTP ' + templates.status);

    // 用安装包里自带的一次性脚本装模板：证明 template:install 这条路径在 npm 安装后也可用
    const templateInstaller = path.join(pluginDir, 'scripts', 'install-template.mjs');
    const installTemplate = spawnSync(process.execPath, [templateInstaller, 'minimal', '--data-dir', dataDir], {
      cwd: opts.root,
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    const installedTpl = path.join(dataDir, 'templates', 'minimal', 'index.html');
    check('安装包里的 template:install 可用（minimal）', installTemplate.status === 0 && fs.existsSync(installedTpl),
      'exit=' + installTemplate.status + ' ' + installedTpl + (installTemplate.status === 0 ? '' : '\n' + tail(String(installTemplate.stderr || ''), 6)));
    const templatesAfter = await http.request('GET', '/api/reports/templates');
    check('装好的自定义模板被控制台发现', templatesAfter.status === 200 && /"minimal"/.test(templatesAfter.text), 'HTTP ' + templatesAfter.status);
    if (fs.existsSync(installedTpl)) {
      // 注意：meta=1 时后端只回元数据、不带 HTML，所以这里不要传 meta
      const preview = await http.request('GET', '/api/reports/templates/preview?name=minimal');
      check('自定义模板预览可渲染（示例数据 + 高度上报协议）',
        preview.status === 200 && /__CARD_DATA__/.test(preview.text) && /qqbot:report-preview/.test(preview.text),
        'HTTP ' + preview.status);
    }

    const listOf = (response) => (Array.isArray(response.json) ? response.json : (response.json?.items || []));
    const profilesBefore = await http.request('GET', '/api/profiles');
    check('/api/profiles 可用', profilesBefore.status === 200 && Array.isArray(listOf(profilesBefore)),
      'items=' + listOf(profilesBefore).length + '（全新安装为空是预期：配置档跟着 bot 走）');

    // 真的建一个 bot 和一个配置档：验证写入链路而不只是读接口
    const createdBot = await http.request('POST', '/api/bots', { name: '独立安装验收', appId: '', appSecret: '' });
    const botId = createdBot.json?.id || '';
    check('控制台可新建机器人', createdBot.status === 200 && botId !== '', 'id=' + botId);
    const expectedCwd = path.join(workspaceRoot, 'bots', botId);
    check('机器人工作目录在 workspaceRoot 下', createdBot.json?.cwd === expectedCwd, String(createdBot.json?.cwd));

    const stateAfter = await http.request('GET', '/api/state');
    check('新机器人出现在 /api/state', (stateAfter.json?.bots || []).some((bot) => bot.id === botId), 'bots=' + (stateAfter.json?.bots || []).length);

    const createdProfile = await http.request('POST', '/api/profiles', { botId, name: '验收配置档', isDefault: true });
    check('控制台可新建配置档', createdProfile.status === 200 && typeof createdProfile.json?.id === 'string', 'id=' + (createdProfile.json?.id || ''));
    const profilesAfter = await http.request('GET', '/api/profiles');
    check('/api/profiles 列出新建的配置档', listOf(profilesAfter).length > 0, 'items=' + listOf(profilesAfter).length);

    const startRes = await http.request('POST', '/api/actions/start-bot', { botId });
    check('无 QQ 凭据时启动机器人优雅失败', startRes.status >= 400, 'HTTP ' + startRes.status + ' ' + String(startRes.json?.error?.message || '').slice(0, 100));
    const healthAfter = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(5000) });
    check('动作失败后控制台仍健康（进程没崩）', healthAfter.status === 200, 'HTTP ' + healthAfter.status);
    if (fs.existsSync(expectedCwd)) console.log('      · 机器人工作目录已建立: ' + expectedCwd);

    const index = await fetch(baseUrl + '/', { signal: AbortSignal.timeout(15000) }).then((res) => res.text());
    const assetMatch = /\/assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(index);
    check('控制台首页来自安装包 dist', Boolean(assetMatch), assetMatch ? assetMatch[1] : '未找到 assets/index-*.js');
    const repoAssets = fs.readdirSync(path.join(REPO_ROOT, 'web', 'dist', 'assets'));
    check('控制台实际加载的资产与仓库构建一致', Boolean(assetMatch) && repoAssets.includes(assetMatch[1]), assetMatch ? assetMatch[1] : '');
    if (assetMatch) {
      const asset = await fetch(baseUrl + '/assets/' + assetMatch[1], { signal: AbortSignal.timeout(15000) });
      check('静态资产可正常下载', asset.status === 200 && Number(asset.headers.get('content-length') || 0) > 10000, 'HTTP ' + asset.status + ' bytes=' + asset.headers.get('content-length'));
    }

    check('workspaceRoot 已就绪且可写', fs.existsSync(workspaceRoot) && fs.statSync(workspaceRoot).isDirectory(), workspaceRoot);

    // 7) dsh Web 集成：客户端半进 boot 图 + 同源跳转路由
    const dshWebUrl = body.dshWeb?.url || '';
    check('/api/state 给出 dsh Web 入口 URL', typeof dshWebUrl === 'string' && dshWebUrl.startsWith('http'), dshWebUrl);
    if (dshWebUrl !== '') {
      const page = await fetchWithCookieJar(dshWebUrl, { signal: AbortSignal.timeout(20000) });
      const html = await page.text();
      fs.writeFileSync(path.join(opts.root, 'dsh-web-index.html'), html, 'utf8');
      check('dsh Web 可访问（带鉴权 URL）', page.status === 200, 'HTTP ' + page.status);
      check('dsh Web 页面含客户端模块 boot 图', html.includes('__DSH_BOOT__'), 'len=' + html.length);
      check('客户端半已进入 boot 图（dsh-qqbot-buddy）', html.includes('dsh-qqbot-buddy'), '');
    }
    const dashboard = await fetch('http://127.0.0.1:' + opts.webPort + '/qqbot-dashboard', {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const location = dashboard.headers.get('location') || '';
    check('/qqbot-dashboard 302 跳到控制台', dashboard.status === 302 && location.includes('127.0.0.1:' + opts.consolePort), 'HTTP ' + dashboard.status + ' → ' + location);
  } finally {
    await stopInstance(state);
    stopped = true;
    check('隔离实例可正常停止', stopped && state.exited, JSON.stringify(state.exit));
  }

  finish(results, jsonFile, { root: opts.root, version: PKG.version, spec, tarball, consolePort: opts.consolePort, webPort: opts.webPort }, opts.keep ? '' : opts.root);
}

/**
 * 收尾：先写报告再清理临时目录（否则报告会跟着目录一起被删，或者把删掉的目录又建回来）。
 * @param {Array} results 检查项
 * @param {string} jsonFile 报告路径
 * @param {object} meta 元信息
 * @param {string} cleanupRoot 非空 = 写完报告后删除这个临时根目录
 */
function finish(results, jsonFile, meta, cleanupRoot = '') {
  const failed = results.filter((item) => !item.ok);
  const report = {
    at: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    meta,
    results,
  };
  try {
    fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('[standalone] 报告写入失败: ' + err.message);
  }
  console.log('\n==== ' + report.passed + '/' + report.total + ' 通过' + (failed.length > 0 ? '，失败 ' + failed.length + ' 项' : '') + ' ====');
  console.log('[standalone] 报告: ' + jsonFile);
  if (cleanupRoot !== '') {
    try { fs.rmSync(cleanupRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log('[standalone] 临时目录已清理（--keep 可保留）');
  } else if (meta.root && fs.existsSync(meta.root)) {
    console.log('[standalone] 临时目录: ' + meta.root);
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('[standalone] 中断: ' + (err instanceof Error ? err.stack || err.message : String(err)));
  process.exitCode = 1;
});
