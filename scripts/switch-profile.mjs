#!/usr/bin/env node
/**
 * 把一个装着 v1 插件的 dsh profile 原地切到 v2（可 dry-run）。
 *
 * 做的事（可重复执行、每步先备份）：
 *   1. 备份 profile 的 cordis.patch.yml / package.json 到 ~/.dsh/backups/qqbot-v2/<时间>/
 *   2. 把 v2 复制进 <profile>/node_modules/dsh-qqbot-buddy（等价 install.mjs --local）
 *   3. 把 patch 里的 `- id: qqbot-buddy` 配置块改写成 v2 配置（dataDir/workspaceRoot/console）
 *   4. 把 profile package.json 的依赖从 github v1 改成 link:<本仓库>（避免下次 pnpm install 拉回 v1）
 *   5. 跑 v1→v2 数据迁移（settings/persona/记忆/知识/表情 + 从 patch 读 appId/appSecret 写进 v2 DB）
 *   6. dump-config 自检
 *
 * 用法：
 *   node scripts/switch-profile.mjs --dry-run            # 只看会改什么（默认）
 *   node scripts/switch-profile.mjs --apply              # 真正执行
 *   node scripts/switch-profile.mjs --profile qqbot --workspace /home/qiqi/project/qqbot --apply
 *
 * 执行前建议先停掉该 profile 的 dsh 实例（脚本不会动运行中的进程）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const FLAG = '[qqbot-switch]';
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const log = (msg) => process.stdout.write(FLAG + ' ' + msg + '\n');
const warn = (msg) => process.stderr.write(FLAG + ' 警告: ' + msg + '\n');
const errText = (err) => (err instanceof Error ? err.message : String(err));

function parseArgs(argv) {
  const out = {
    // 注意：不要用 DSH_PROFILE（当前 shell 里它常指向其它 profile）；默认切 qqbot
    profile: 'qqbot',
    workspace: '/home/qiqi/project/qqbot',
    v1State: path.join(os.homedir(), '.dsh-qqbot', 'buddy'),
    dataDir: path.join(os.homedir(), '.dsh-qqbot', 'v2'),
    consolePort: 6198,
    dryRun: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--profile' || arg === '-p') out.profile = argv[++i];
    else if (arg === '--workspace') out.workspace = path.resolve(argv[++i]);
    else if (arg === '--v1-state') out.v1State = path.resolve(argv[++i]);
    else if (arg === '--data-dir') out.dataDir = path.resolve(argv[++i]);
    else if (arg === '--console-port') out.consolePort = Number(argv[++i]);
    else if (arg === '--apply') out.dryRun = false;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/switch-profile.mjs [--profile NAME] [--workspace DIR] [--v1-state DIR] [--data-dir DIR] [--console-port N] [--apply]');
      process.exit(0);
    } else { console.error(FLAG + ' 未知参数: ' + arg); process.exit(1); }
  }
  return out;
}

const dshHome = () => path.resolve((process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh'));
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** v2 配置块（替换 patch 里的 qqbot-buddy 段）。 */
function v2Block(opts) {
  return [
    '- id: qqbot-buddy',
    '  config:',
    '    dataDir: ' + JSON.stringify(opts.dataDir),
    '    workspaceRoot: ' + JSON.stringify(opts.workspace),
    '    autoStart: true',
    '    debug: false',
    '    console:',
    '      enabled: true',
    '      host: 127.0.0.1',
    '      port: ' + opts.consolePort,
    "      token: ''",
    '  disabled: false',
    '',
  ].join('\n');
}

/** 用 v2 块替换 patch 里的 qqbot-buddy 段；找不到则追加。 */
function rewritePatch(text, opts) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^- id:\s*qqbot-buddy\s*$/.test(line));
  if (start < 0) return { text: text.replace(/\n*$/, '\n') + '\n' + v2Block(opts), replaced: false };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) { end = i; break; }
  }
  const head = lines.slice(0, start).join('\n');
  const tail = lines.slice(end).join('\n');
  const body = v2Block(opts);
  return { text: (head === '' ? '' : head + '\n') + body + (tail === '' ? '' : tail + '\n'), replaced: true };
}

function backupFiles(profileDir, files) {
  const dir = path.join(dshHome(), 'backups', 'qqbot-v2', stamp());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    fs.copyFileSync(file, path.join(dir, path.basename(file)));
  }
  return dir;
}

function updateProfileManifest(profileDir) {
  const file = path.join(profileDir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.dependencies = manifest.dependencies || {};
  manifest.dependencies['dsh-qqbot-buddy'] = 'link:' + REPO_ROOT;
  const tmp = file + '.switch-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = dshHome();
  const profileDir = path.join(home, 'profiles', opts.profile);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const pkgFile = path.join(profileDir, 'package.json');
  const pluginDir = path.join(profileDir, 'node_modules', 'dsh-qqbot-buddy');

  log('DSH_HOME : ' + home);
  log('profile  : ' + opts.profile + '  (' + profileDir + ')');
  log('v1 状态   : ' + opts.v1State);
  log('v1 工作区 : ' + opts.workspace);
  log('v2 数据   : ' + opts.dataDir + '（控制台 127.0.0.1:' + opts.consolePort + '）');

  if (!fs.existsSync(profileDir)) { console.error(FLAG + ' profile 不存在: ' + profileDir); process.exit(1); }
  if (!fs.existsSync(patchFile)) { console.error(FLAG + ' 找不到 ' + patchFile); process.exit(1); }

  const current = fs.existsSync(path.join(pluginDir, 'package.json'))
    ? JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).version
    : '(未安装)';
  log('当前插件 : dsh-qqbot-buddy ' + current);

  const patchText = fs.readFileSync(patchFile, 'utf8');
  const rewritten = rewritePatch(patchText, opts);
  log('配置改写 : ' + (rewritten.replaced ? '替换已有 qqbot-buddy 块' : '未找到块，将追加'));
  if (opts.dryRun) {
    log('dry-run：不写盘。将执行：');
    log('  1) 备份 cordis.patch.yml / package.json → ' + path.join(home, 'backups', 'qqbot-v2', '<ts>') + '/');
    log('  2) 复制 ' + REPO_ROOT + ' → ' + pluginDir);
    log('  3) package.json dependency: dsh-qqbot-buddy = link:' + REPO_ROOT);
    log('  4) patch 新块:\n' + v2Block(opts).split('\n').map((line) => '       ' + line).join('\n'));
    log('  5) node scripts/migrate-v1.mjs --apply --patch <备份的 patch> --v1-bots ' + path.join(opts.workspace, 'bots.json')
      + ' --workspace ' + opts.workspace + ' --to ' + opts.dataDir);
    log('  6) dsh --profile ' + opts.profile + ' --dump-config（自检）');
    return;
  }

  // 1. 备份
  const backupDir = backupFiles(profileDir, [patchFile, pkgFile]);
  log('1/6 已备份 → ' + backupDir);

  // 2. 安装 v2（复用 install.mjs --local，跳过其 dump-config 自检，最后统一做）
  log('2/6 复制 v2 到 profile node_modules ...');
  const install = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'install.mjs'), '--local', '--profile', opts.profile, '--skip-check'], { stdio: 'inherit' });
  if (install.status !== 0) { console.error(FLAG + ' 安装失败，已保留备份：' + backupDir); process.exit(1); }

  // 3. 改写 patch
  const tmpPatch = patchFile + '.switch-' + process.pid;
  fs.writeFileSync(tmpPatch, rewritten.text, 'utf8');
  fs.renameSync(tmpPatch, patchFile);
  log('3/6 patch 已改写（v2 配置块）');

  // 4. package.json dependency → link
  updateProfileManifest(profileDir);
  log('4/6 package.json dependency 已改为 link:' + REPO_ROOT);

  // 5. 数据迁移（凭据从备份 patch 读，避免密码写进新 patch）
  log('5/6 迁移 v1 数据 ...');
  const backupPatch = path.join(backupDir, 'cordis.patch.yml');
  const migrateArgs = [path.join(REPO_ROOT, 'scripts', 'migrate-v1.mjs'), '--apply', '--to', opts.dataDir, '--workspace', opts.workspace,
    '--patch', backupPatch, '--v1-bots', path.join(opts.workspace, 'bots.json')];
  const migrate = spawnSync(process.execPath, migrateArgs, { stdio: 'inherit' });
  if (migrate.status !== 0) warn('数据迁移非 0 退出（可重跑，不会重复写入）');

  // 6. dump-config 自检
  log('6/6 dump-config 自检 ...');
  const check = spawnSync('dsh', ['--profile', opts.profile, '--dump-config'], { encoding: 'utf8' });
  const text = String(check.stdout || '') + String(check.stderr || '');
  if (check.status !== 0 || !/qqbot-buddy/.test(text)) {
    warn('dump-config 未确认 qqbot-buddy；请手动检查。备份：' + backupDir);
  } else {
    log('    已确认 qqbot-buddy 在插件树中');
  }

  log('');
  log('切换完成 ✅  备份目录: ' + backupDir);
  log('下一步：');
  log('  1. 停掉旧实例：  ps aux | grep "profile ' + opts.profile + '"  → kill <pid>'.replace('profile ' + opts.profile, '--profile ' + opts.profile));
  log('  2. 同样命令重启：dsh --profile ' + opts.profile + ' --port 3081 --no-open');
  log('  3. 打开控制台 http://127.0.0.1:' + opts.consolePort + '（token: ' + path.join(opts.dataDir, 'console-token.txt') + '）');
  log('  4. 控制台里确认机器人凭据/记忆/知识库已迁移，再启动机器人');
  log('回滚：把 ' + backupDir + ' 里的 cordis.patch.yml 和 package.json 拷回 profile，再重新安装 v1 包即可。');
}

main();
