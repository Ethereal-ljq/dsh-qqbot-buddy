#!/usr/bin/env node
/**
 * smoke-dsh.mjs —— 真实 dsh 隔离实例冒烟（M5 验收：能装、能起、能管理）。
 *
 * 覆盖 task-8 第二项：
 *   1) 隔离 DSH_HOME：初始化 profile → scripts/install.mjs --local --profile web →
 *      dsh --dump-config 断言 qqbot-buddy / preset-qqbot-buddy 进入插件树；
 *   2) 后台起 dsh web（独立主端口 + 控制台端口 6222），验证 /api/health、console-token.txt；
 *   3) 登录 → /api/state、/api/tools、/api/schema；
 *   4) 控制台建 bot（不填凭据）→ start-bot 优雅失败（HTTP 200、bot status=error、进程不崩）;
 *      第二阶段重启实例验证「持久化 bot 自动启动失败但不影响插件」；
 *   5) 全流程错误可读、进程不退出；最后停掉实例。
 *
 * 用法：
 *   node scripts/smoke-dsh.mjs
 *   node scripts/smoke-dsh.mjs --dsh-home /tmp/dsh-smoke --console-port 6223 --web-port 33081
 *
 * 退出码：0 = 全部必备步骤通过；1 = 有失败步骤；2 = 环境/启动失败。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_FILE), '..');
const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errText = (err) => (err instanceof Error ? (err.stack || err.message) : String(err));

function parseArgs(argv) {
  const opts = {
    dshHome: path.join(REPO_ROOT, '.work', 'integration', 'dsh-home'),
    profile: 'web',
    consolePort: 6222,
    webPort: 33080,
    timeoutMs: 120000,
    install: true,
    reinstall: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dsh-home') opts.dshHome = path.resolve(argv[++i]);
    else if (arg === '--profile') opts.profile = argv[++i];
    else if (arg === '--console-port') opts.consolePort = Number(argv[++i]);
    else if (arg === '--web-port') opts.webPort = Number(argv[++i]);
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else if (arg === '--no-install') opts.install = false;
    else if (arg === '--reinstall') opts.reinstall = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else { console.error('[smoke] 未知参数: ' + arg); process.exit(2); }
  }
  opts.dataDir = path.join(REPO_ROOT, '.work', 'integration', 'data');
  opts.workspaceRoot = path.join(REPO_ROOT, '.work', 'integration', 'workspace');
  opts.logDir = path.join(REPO_ROOT, '.work', 'integration', 'logs');
  opts.report = path.join(REPO_ROOT, '.work', 'smoke-dsh.json');
  return opts;
}

function printHelp() {
  console.log([
    '用法: node scripts/smoke-dsh.mjs [选项]',
    '',
    '  --dsh-home <dir>      隔离 DSH_HOME（默认 .work/integration/dsh-home）',
    '  --profile <name>      目标 profile（默认 web）',
    '  --console-port <n>    控制台端口（默认 6222）',
    '  --web-port <n>        dsh web 主端口（默认 33080）',
    '  --timeout-ms <n>      单阶段启动/等待超时（默认 120000）',
    '  --no-install          profile 必须已安装插件，不自动补装',
    '  --reinstall           强制从当前仓库重装（验收当前工作树）',
    '  --keep                保留实例进程/日志（默认失败时也保留日志）',
    '',
  ].join('\n'));
}

/* ── 环境发现（与 probe-tools.mjs 同策略）── */

function findDsh() {
  const candidates = [];
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN);
  candidates.push(path.join(path.dirname(process.execPath), 'dsh'));
  candidates.push('dsh');
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmRoot)
      .filter((entry) => /^v(\d+)\./.test(entry))
      .sort((a, b) => Number(b.slice(1).split('.')[0]) - Number(a.slice(1).split('.')[0]) || b.localeCompare(a));
    for (const version of versions) candidates.push(path.join(nvmRoot, version, 'bin', 'dsh'));
  } catch { /* ignore */ }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const which = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (which.status === 0 && String(which.stdout || '').trim() !== '') return String(which.stdout).trim();
  }
  return '';
}

function nodeVersionFor(dshBin) {
  const node = path.join(path.dirname(dshBin), 'node');
  if (!fs.existsSync(node)) return '';
  const result = spawnSync(node, ['-v'], { encoding: 'utf8' });
  return String(result.stdout || '').trim();
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => { try { socket.destroy(); } catch { /* ignore */ } resolve(value); };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 从 start 起找一个空闲端口（6222+ 避让同机其他实例/队友的开发服务）。 */
async function findFreePort(start) {
  for (let port = start; port < start + 30; port += 1) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error('端口 ' + start + '~' + (start + 29) + ' 都被占用');
}

/* ── 步骤记录 ── */

function createReporter() {
  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    console.log('[smoke] ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
    return ok;
  };
  return { steps, record };
}

/* ── HTTP（带会话 cookie）── */

function createHttpClient(baseUrl) {
  let cookie = '';
  async function request(method, apiPath, body, extraHeaders) {
    const headers = Object.assign({}, extraHeaders || {});
    if (cookie !== '') headers.cookie = cookie;
    if (method !== 'GET' && method !== 'HEAD') headers['X-QQBot-CSRF'] = '1';
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(baseUrl + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie') || '';
    const first = setCookie.split(';')[0];
    if (first.includes('=')) cookie = first;
    const text = await response.text();
    let json = null;
    try { json = text === '' ? null : JSON.parse(text); } catch { /* 保留 text */ }
    return { status: response.status, json, text, headers: response.headers };
  }
  return { request, get cookie() { return cookie; } };
}

async function waitForHealth(baseUrl, timeoutMs, childState) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childState.exited) return false;
    try {
      const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) return true;
    } catch { /* 未起 */ }
    await SLEEP(400);
  }
  return false;
}

/* ── 实例生命周期 ── */

function startInstance(opts, dshBin, patchFile, label) {
  fs.mkdirSync(opts.logDir, { recursive: true });
  const logFile = path.join(opts.logDir, 'smoke-' + label + '.log');
  const stream = fs.createWriteStream(logFile, { flags: 'w' });
  const env = Object.assign({}, process.env, {
    DSH_HOME: opts.dshHome,
    PATH: path.dirname(dshBin) + path.delimiter + String(process.env.PATH || ''),
  });
  const child = spawn(dshBin, [
    '--profile', opts.profile,
    '--patch', patchFile,
    '--port', String(opts.webPort),
    '--no-open',
  ], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { exited: false, exit: null, child, logFile, stream };
  child.stdout.on('data', (chunk) => stream.write(chunk));
  child.stderr.on('data', (chunk) => stream.write(chunk));
  child.on('exit', (code, signal) => { state.exited = true; state.exit = { code, signal }; });
  return state;
}

async function stopInstance(state) {
  if (!state || state.exited) return;
  try { state.child.kill('SIGTERM'); } catch { /* ignore */ }
  const deadline = Date.now() + 10000;
  while (!state.exited && Date.now() < deadline) await SLEEP(200);
  if (!state.exited) { try { state.child.kill('SIGKILL'); } catch { /* ignore */ } }
  try { state.stream.end(); } catch { /* ignore */ }
  await SLEEP(300);
}

function readLogTail(state, lines = 25) {
  try {
    return fs.readFileSync(state.logFile, 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

function writePatchFile(opts) {
  const patchFile = path.join(REPO_ROOT, '.work', 'integration', 'smoke.patch.yml');
  fs.mkdirSync(path.dirname(patchFile), { recursive: true });
  fs.mkdirSync(opts.dataDir, { recursive: true });
  fs.mkdirSync(opts.workspaceRoot, { recursive: true });
  const yaml = [
    '# 冒烟专用覆盖层（由 scripts/smoke-dsh.mjs 生成，.work 临时目录，不提交）',
    '- id: qqbot-buddy',
    '  config:',
    '    dataDir: ' + JSON.stringify(opts.dataDir),
    '    workspaceRoot: ' + JSON.stringify(opts.workspaceRoot),
    '    debug: true',
    '    autoStart: true',
    '    console:',
    '      enabled: true',
    '      host: 127.0.0.1',
    '      port: ' + opts.consolePort,
    "      token: ''",
    '',
  ].join('\n');
  fs.writeFileSync(patchFile, yaml, 'utf8');
  return patchFile;
}

/* ── 主流程 ── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const reporter = createReporter();
  const records = reporter.steps;

  const dshBin = findDsh();
  if (dshBin === '') throw new Error('找不到 dsh 可执行文件（可用 DSH_BIN 指定）');
  const nodeVer = nodeVersionFor(dshBin);
  if (nodeVer !== '' && Number(nodeVer.replace(/^v/, '').split('.')[0]) < 24) {
    throw new Error('dsh 所在 Node ' + nodeVer + ' < 24；请用 Node 24 的 dsh（DSH_BIN 指定）');
  }
  console.log('[smoke] dsh=' + dshBin + ' node=' + nodeVer);
  console.log('[smoke] DSH_HOME=' + opts.dshHome + ' profile=' + opts.profile);

  const requestedConsolePort = opts.consolePort;
  const requestedWebPort = opts.webPort;
  opts.consolePort = await findFreePort(opts.consolePort);
  opts.webPort = await findFreePort(opts.webPort);
  if (opts.consolePort !== requestedConsolePort) {
    console.log('[smoke] 端口避让：控制台 ' + requestedConsolePort + ' 被占用 → ' + opts.consolePort);
  }
  if (opts.webPort !== requestedWebPort) {
    console.log('[smoke] 端口避让：dsh web ' + requestedWebPort + ' 被占用 → ' + opts.webPort);
  }
  const baseUrl = 'http://127.0.0.1:' + opts.consolePort;
  const consoleUrl = 'http://127.0.0.1:' + opts.webPort + '/';
  console.log('[smoke] 控制台=' + baseUrl + ' dsh web=' + consoleUrl);

  // 0. 初始化 profile（首次使用会从随附模板生成）
  const profileDir = path.join(opts.dshHome, 'profiles', opts.profile);
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    console.log('[smoke] 初始化隔离 profile ...');
    const init = spawnSync(dshBin, ['--profile', opts.profile, '--dump-default-config'], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { DSH_HOME: opts.dshHome }),
      encoding: 'utf8',
    });
    reporter.record('隔离 profile 初始化', init.status === 0, 'exit=' + init.status + ' ' + path.join(profileDir, 'package.json'));
    if (init.status !== 0) throw new Error('profile 初始化失败: ' + String(init.stderr || '').slice(-800));
  }

  // 1. 安装 + dump-config 断言
  const installedManifest = path.join(profileDir, 'node_modules', 'dsh-qqbot-buddy', 'package.json');
  if (opts.reinstall) {
    try { fs.rmSync(path.dirname(installedManifest), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (!fs.existsSync(installedManifest)) {
    if (!opts.install) throw new Error('插件未安装且指定了 --no-install');
    console.log('[smoke] 安装插件（--local）...');
    const install = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'install.mjs'), '--local', '--profile', opts.profile], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { DSH_HOME: opts.dshHome }),
      stdio: 'inherit',
    });
    if (install.status !== 0) throw new Error('安装失败（exit ' + install.status + '）');
  }
  reporter.record('插件已安装到隔离 profile', fs.existsSync(installedManifest), installedManifest);

  const patchFile = writePatchFile(opts);
  const dump = spawnSync(dshBin, ['--profile', opts.profile, '--patch', patchFile, '--dump-config'], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { DSH_HOME: opts.dshHome }),
    encoding: 'utf8',
  });
  const dumpText = String(dump.stdout || '') + String(dump.stderr || '');
  const dumpOk = dump.status === 0
    && dumpText.includes('qqbot-buddy')
    && dumpText.includes('preset-qqbot-buddy')
    && dumpText.includes(String(opts.consolePort));
  fs.writeFileSync(path.join(REPO_ROOT, '.work', 'integration', 'smoke-composed-config.yml'), String(dump.stdout || ''), 'utf8');
  reporter.record('dump-config 包含插件与 preset', dumpOk, 'exit=' + dump.status + ' qqbot-buddy=' + dumpText.includes('qqbot-buddy') + ' preset=' + dumpText.includes('preset-qqbot-buddy'));
  if (!dumpOk) throw new Error('dump-config 自检失败:\n' + dumpText.slice(-1200));

  // 2. 第一阶段：起实例 → 健康/token → 登录 → 读接口 → 建 bot → start-bot
  console.log('');
  console.log('[smoke] ── 阶段 A：启动实例并验证控制台 ──');
  const tokenFile = path.join(opts.dataDir, 'console-token.txt');
  const tokenBefore = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  let state = startInstance(opts, dshBin, patchFile, 'a');
  let healthOk = await waitForHealth(baseUrl, opts.timeoutMs, state);
  reporter.record('控制台 /api/health 可用', healthOk, healthOk ? baseUrl + '/api/health 200' : '超时/进程退出\n' + readLogTail(state));
  if (!healthOk) throw new Error('控制台未启动:\n' + readLogTail(state));

  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  reporter.record('console-token.txt 已生成', token !== '', 'len=' + token.length + ' ' + tokenFile + (tokenBefore !== '' && tokenBefore !== token ? '（已轮换）' : ''));
  if (token === '') throw new Error('缺少 console token');

  const http = createHttpClient(baseUrl);
  const login = await http.request('POST', '/api/auth/login', { token });
  reporter.record('控制台登录', login.status === 200 && http.cookie !== '', 'HTTP ' + login.status + ' cookie=' + (http.cookie !== ''));

  const stateResponse = await http.request('GET', '/api/state');
  const stateBody = stateResponse.json || {};
  const stateOk = stateResponse.status === 200 && Array.isArray(stateBody.bots)
    && stateBody.console && stateBody.console.port === opts.consolePort;
  reporter.record('/api/state 正常', stateOk, 'HTTP ' + stateResponse.status + ' bots=' + (stateBody.bots || []).length + ' version=' + stateBody.version);

  const toolsResponse = await http.request('GET', '/api/tools');
  const toolsBody = toolsResponse.json || {};
  const toolsOk = toolsResponse.status === 200 && Array.isArray(toolsBody.items) && toolsBody.items.length > 0;
  reporter.record('/api/tools 工具发现非空', toolsOk, 'HTTP ' + toolsResponse.status + ' items=' + (toolsBody.items || []).length
    + ' names=' + (toolsBody.items || []).map((item) => item.name).join(','));

  const schemaResponse = await http.request('GET', '/api/schema');
  const schemaOk = schemaResponse.status === 200 && schemaResponse.json && Array.isArray(schemaResponse.json.items)
    && schemaResponse.json.items.length > 10;
  reporter.record('/api/schema 正常', schemaOk, 'HTTP ' + schemaResponse.status + ' items=' + (schemaResponse.json && schemaResponse.json.items ? schemaResponse.json.items.length : 0));

  const botName = '冒烟测试号-' + new Date().toISOString().slice(11, 19);
  const created = await http.request('POST', '/api/bots', { name: botName });
  const bot = created.json || {};
  reporter.record('控制台建 bot（不填凭据）', created.status === 200 && typeof bot.id === 'string' && bot.id !== '',
    'HTTP ' + created.status + ' id=' + (bot.id || '-') + ' name=' + (bot.name || '-'));

  const startAction = await http.request('POST', '/api/actions/start-bot', { botId: bot.id });
  const actionBody = startAction.json || {};
  const actionError = actionBody && actionBody.error ? actionBody.error : null;
  const errorReadable = actionError
    ? (typeof actionError.code === 'string' && actionError.code !== 'internal_error'
      && typeof actionError.message === 'string' && actionError.message.length > 0)
    : (actionBody.ok === false);
  const graceful = startAction.status >= 200 && startAction.status < 500 && errorReadable;
  reporter.record('start-bot 无凭据时优雅失败（4xx 可读错误，不崩）', graceful,
    'HTTP ' + startAction.status + ' code=' + (actionError ? actionError.code : '-')
    + ' message=' + (actionError ? JSON.stringify(actionError.message).slice(0, 160) : '-')
    + (graceful ? '' : '  ← 期望 400 action_failed/start_failed + 可读 message'));

  const afterState = await http.request('GET', '/api/state');
  const afterRuntime = afterState.json && afterState.json.runtime ? afterState.json.runtime.bots[bot.id] : null;
  const botStatusAfterAction = afterRuntime ? afterRuntime.status : 'missing';
  reporter.record('start-bot 后 bot 状态可读（预期 error）', botStatusAfterAction === 'error',
    'runtime.bots[' + bot.id + '].status=' + botStatusAfterAction);

  const healthAfter = await (async () => { try { const r = await fetch(baseUrl + '/api/health'); return r.status; } catch { return 0; } })();
  reporter.record('动作失败后进程不崩（health 仍 200）', healthAfter === 200 && !state.exited, 'health=' + healthAfter + ' exited=' + state.exited);

  await stopInstance(state);
  reporter.record('阶段 A 实例可正常停止', state.exited, JSON.stringify(state.exit));

  // 3. 第二阶段：重启实例，验证「持久化 bot 自动启动失败但插件存活」
  console.log('');
  console.log('[smoke] ── 阶段 B：重启实例，验证持久化 bot 的优雅启动失败 ──');
  const token2 = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : token;
  state = startInstance(opts, dshBin, patchFile, 'b');
  healthOk = await waitForHealth(baseUrl, opts.timeoutMs, state);
  reporter.record('重启后控制台 /api/health 可用', healthOk, healthOk ? '200' : '超时/进程退出\n' + readLogTail(state));
  if (!healthOk) throw new Error('阶段 B 控制台未启动:\n' + readLogTail(state));

  const http2 = createHttpClient(baseUrl);
  const login2 = await http2.request('POST', '/api/auth/login', { token: token2 });
  reporter.record('重启后可再次登录', login2.status === 200 && http2.cookie !== '', 'HTTP ' + login2.status);

  let persistedStatus = 'missing';
  const statusDeadline = Date.now() + 30000;
  while (Date.now() < statusDeadline) {
    const current = await http2.request('GET', '/api/state');
    const runtimeBots = current.json && current.json.runtime ? current.json.runtime.bots : {};
    if (runtimeBots[bot.id]) { persistedStatus = runtimeBots[bot.id].status; break; }
    await SLEEP(500);
  }
  const autostartGraceful = persistedStatus === 'error';
  reporter.record('持久化 bot 自动启动优雅失败（status=error）', autostartGraceful, 'status=' + persistedStatus);

  const startAgain = await http2.request('POST', '/api/actions/start-bot', { botId: bot.id });
  const startAgainBody = startAgain.json || {};
  const againError = startAgainBody && startAgainBody.error ? startAgainBody.error : null;
  reporter.record('重启后 start-bot 返回可读失败（4xx start_failed）',
    startAgain.status >= 400 && startAgain.status < 500 && againError && againError.code === 'start_failed'
      && typeof againError.message === 'string' && againError.message.length > 0,
    'HTTP ' + startAgain.status + ' code=' + (againError ? againError.code : '-') + ' message=' + (againError ? JSON.stringify(againError.message).slice(0, 160) : '-'));

  const healthAfterB = await (async () => { try { const r = await fetch(baseUrl + '/api/health'); return r.status; } catch { return 0; } })();
  reporter.record('阶段 B 进程存活', healthAfterB === 200 && !state.exited, 'health=' + healthAfterB + ' exited=' + state.exited);
  await stopInstance(state);

  // 4. 汇总
  const failed = records.filter((item) => !item.ok);
  const report = {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    node: process.version,
    dsh: { bin: dshBin, node: nodeVer },
    dshHome: opts.dshHome,
    profile: opts.profile,
    consoleUrl: baseUrl,
    webUrl: consoleUrl,
    botId: bot.id || '',
    steps: records,
  };
  fs.mkdirSync(path.dirname(opts.report), { recursive: true });
  fs.writeFileSync(opts.report, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('[smoke] ===== 冒烟结论 =====');
  for (const step of records) console.log('[smoke] ' + (step.ok ? 'PASS' : 'FAIL') + ' ' + step.name);
  console.log('[smoke] 整体: ' + (report.ok ? 'PASS' : 'FAIL') + '（' + records.length + ' 步，失败 ' + failed.length + '）');
  console.log('[smoke] 报告: ' + opts.report + '；日志目录: ' + opts.logDir);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] 异常: ' + errText(err));
  process.exit(2);
});
