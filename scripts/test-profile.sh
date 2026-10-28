#!/usr/bin/env bash
# test-profile.sh —— 隔离 DSH_HOME 验证插件：dump-config 组合检查 +（可选）启动测试 web 实例。
#
# 隔离原则（DESIGN「质量与验收」第 6/7 条）：
#   - DSH_HOME 指向 /tmp 下的临时目录，profile 以软链指向 live profile（只读使用）；
#   - 叠加 overlay 停用 im-qqbot，qqbot-buddy 用空凭据 + autoStart=false，绝不连接真实 QQ；
#   - 只用 3099 端口，绝不触碰 3080 的 live 实例（并校验其 PID 前后不变）；
#   - 结束时只清理本次自己启动的进程（按 PID 树），测试目录默认删除。
#
# 用法：
#   bash scripts/test-profile.sh                 # 只做 dump-config 校验
#   bash scripts/test-profile.sh --serve         # 再启动 127.0.0.1:3099 断言 /api/state ok:true
#   bash scripts/test-profile.sh --serve --keep  # 保留测试目录与日志供排查
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
DSH_BIN=${DSH_BIN:-$(command -v dsh || echo dsh)}
LIVE_PROFILE=${LIVE_PROFILE:-$HOME/.dsh/profiles/web}
TESTHOME=${TESTHOME:-/tmp/dsh-qqbot-buddy-test}
TEST_CWD=${TEST_CWD:-/tmp/dsh-qqbot-buddy-cwd}
LIVE_CWD=${LIVE_CWD:-~/qqbot-workspace}
PORT=${PORT:-3099}
READY_TIMEOUT=${READY_TIMEOUT:-180}
SERVE=0
SHOTS=0
PROBE=0
KEEP=0
SKIP_INSTALL=0
SERVE_PID=""
SERVE_LOG=""

log() { printf '[test-profile] %s\n' "$*"; }
die() { printf '[test-profile] 错误: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: bash scripts/test-profile.sh [选项]

在隔离 DSH_HOME 中验证 dsh-qqbot-buddy 的加载与 HTTP API。

选项:
  --serve             dump-config 校验后再启动测试 web 实例并 curl /api/state
  --shots             配合 --serve：state 校验后用 Playwright 截取设置页各 tab 到 test/artifacts
  --probe             配合 --serve：挂载 test/e2e/features-probe.js，在实例内断言功能开关对工具集的影响
  --keep              保留测试目录/日志（默认成功后删除）
  --skip-install      跳过 install-local.sh（仅调试脚本自身用）
  --port N            测试实例端口（默认 3099，禁止 3080）
  --testhome DIR      测试 DSH_HOME（默认 /tmp/dsh-qqbot-buddy-test，必须在 /tmp 或 /var/tmp 下）
  --profile DIR       live profile 目录（默认 $HOME/.dsh/profiles/web）
  --timeout N         等待实例就绪的秒数（默认 180）
  -h, --help          显示本帮助

环境变量: DSH_BIN、LIVE_PROFILE、TESTHOME、TEST_CWD、PORT、READY_TIMEOUT。
EOF
}

while (($# > 0)); do
  case "$1" in
    --serve) SERVE=1; shift ;;
    --shots) SHOTS=1; shift ;;
    --probe) PROBE=1; shift ;;
    --keep) KEEP=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --port) [[ $# -ge 2 ]] || die "--port 需要端口号"; PORT=$2; shift 2 ;;
    --testhome) [[ $# -ge 2 ]] || die "--testhome 需要目录"; TESTHOME=$2; shift 2 ;;
    --profile) [[ $# -ge 2 ]] || die "--profile 需要目录"; LIVE_PROFILE=$2; shift 2 ;;
    --timeout) [[ $# -ge 2 ]] || die "--timeout 需要秒数"; READY_TIMEOUT=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（-h 查看帮助）" ;;
  esac
done

# ── 安全预检 ──────────────────────────────────────────────────
log "参数: SERVE=$SERVE SHOTS=$SHOTS KEEP=$KEEP PORT=$PORT TESTHOME=$TESTHOME"
case "$TESTHOME" in
  /tmp/?*|/var/tmp/?*) ;;
  *) die "TESTHOME 必须位于 /tmp 或 /var/tmp 下（当前: $TESTHOME），避免 rm -rf 误伤" ;;
esac
[[ "$TESTHOME" != *$'\n'* ]] || die "TESTHOME 不能含换行"
[[ ! -L "$TESTHOME" ]] || die "TESTHOME 不能是符号链接: $TESTHOME"
[[ -x "$DSH_BIN" ]] || die "找不到可执行的 dsh: $DSH_BIN"
[[ -d "$LIVE_PROFILE" ]] || die "live profile 不存在: $LIVE_PROFILE"
[[ -f "$LIVE_PROFILE/package.json" ]] || die "live profile 缺少 package.json: $LIVE_PROFILE"
[[ -f "$REPO_DIR/cordis.patch.yml" ]] || die "仓库缺少 cordis.patch.yml: $REPO_DIR"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "端口必须是数字: $PORT"
if [[ "$PORT" == "3080" ]]; then die "禁止使用 3080（那是 live 实例端口）"; fi

# 端口探测（bash /dev/tcp，不依赖 lsof）。
port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
pid_on_port() {
  ss -ltnp 2>/dev/null | awk -v port=":$1" 'index($4, port) > 0 { if (match($0, /pid=[0-9]+/)) print substr($0, RSTART + 4, RLENGTH - 4) }' | head -1
}

if port_in_use "$PORT"; then
  die "端口 $PORT 已被占用（pid=$(pid_on_port "$PORT" 2>/dev/null || echo '?')），请先清理或换 --port"
fi

# live profile 关键文件的校验快照：测试结束必须原样（只允许 dsh 重写内容等价的 cordis.yml）。
sha256_of() { [[ -f "$1" ]] && sha256sum "$1" | awk '{print $1}' || echo "missing"; }
LIVE_PATCH_SHA=$(sha256_of "$LIVE_PROFILE/cordis.patch.yml")
LIVE_PKG_SHA=$(sha256_of "$LIVE_PROFILE/package.json")
LIVE_CORDIS_SHA=$(sha256_of "$LIVE_PROFILE/cordis.yml")
# live 工作区 stickers/ 快照：表情包验收必须在隔离 cwd 下进行，绝不动 live。
live_stickers_snapshot() {
  if [[ -d "$LIVE_CWD/stickers" ]]; then
    ( cd "$LIVE_CWD/stickers" && find . -type f -printf '%P %s\n' 2>/dev/null | LC_ALL=C sort | sha256sum | awk '{print $1}' )
  else
    echo "missing"
  fi
}
LIVE_STICKERS_BEFORE=$(live_stickers_snapshot)
PID_3080_BEFORE=$(pid_on_port 3080 || true)
PID_3080_BEFORE=${PID_3080_BEFORE:-none}

check_live_profile() {
  local ok=0
  [[ "$(sha256_of "$LIVE_PROFILE/cordis.patch.yml")" == "$LIVE_PATCH_SHA" ]] || { log "错误: live profile 的 cordis.patch.yml 被修改了！"; ok=1; }
  [[ "$(sha256_of "$LIVE_PROFILE/package.json")" == "$LIVE_PKG_SHA" ]] || { log "错误: live profile 的 package.json 被修改了！"; ok=1; }
  [[ "$(sha256_of "$LIVE_PROFILE/cordis.yml")" == "$LIVE_CORDIS_SHA" ]] || { log "警告: live profile 的 cordis.yml 内容变化（dsh 启动时会重写该空列表文件）"; ok=1; }
  [[ "$(live_stickers_snapshot)" == "$LIVE_STICKERS_BEFORE" ]] || { log "错误: live 工作区 stickers/ 被修改了（本测试必须只用隔离 cwd 的 stickers）！"; ok=1; }
  return "$ok"
}

# 递归杀掉自己启动的进程树（只接受本次记录的 PID）。
kill_tree() {
  local pid=$1 sig=${2:-TERM} child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child" "$sig"; done
  kill -s "$sig" "$pid" 2>/dev/null || true
}

stop_serve() {
  [[ -n "$SERVE_PID" ]] || return 0
  log "停止本次启动的测试实例 pid=$SERVE_PID"
  kill_tree "$SERVE_PID" TERM
  for _ in $(seq 1 60); do kill -0 "$SERVE_PID" 2>/dev/null || break; sleep 0.25; done
  if kill -0 "$SERVE_PID" 2>/dev/null; then
    log "实例未在 15 秒内退出，发送 SIGKILL（仍只针对本次 PID 树）"
    kill_tree "$SERVE_PID" KILL
  fi
  for _ in $(seq 1 60); do port_in_use "$PORT" || break; sleep 0.25; done
  if port_in_use "$PORT"; then
    log "警告: 端口 $PORT 仍被占用（pid=$(pid_on_port "$PORT" 2>/dev/null || echo '?')），请人工确认是否残留"
  fi
  SERVE_PID=""
}

cleanup() {
  local code=$?
  trap - EXIT
  set +e
  stop_serve
  # 端口残留兜底：只杀 cmdline 明确指向本次 TESTHOME 的进程。
  local leftover
  leftover=$(pid_on_port "$PORT" 2>/dev/null || true)
  if [[ -n "${leftover:-}" ]] && [[ -r "/proc/$leftover/cmdline" ]]; then
    if tr '\0' ' ' < "/proc/$leftover/cmdline" 2>/dev/null | grep -qF "$TESTHOME"; then
      log "清理残留测试进程 pid=$leftover"
      kill -9 "$leftover" 2>/dev/null || true
    else
      log "警告: 端口 $PORT 被 pid=$leftover 占用，但它不像本次测试进程，未处理"
    fi
  fi
  check_live_profile || code=1
  local pid_3080_after
  pid_3080_after=$(pid_on_port 3080 2>/dev/null || true)
  pid_3080_after=${pid_3080_after:-none}
  if [[ "$pid_3080_after" != "$PID_3080_BEFORE" ]]; then
    log "错误: 3080 实例 PID 发生变化（before=$PID_3080_BEFORE after=$pid_3080_after）"
    code=1
  else
    log "3080 live 实例未受影响（pid=${PID_3080_BEFORE}）"
  fi
  if (( code == 0 && KEEP == 0 )); then
    rm -rf -- "$TESTHOME"
    log "已清理测试目录 $TESTHOME（--keep 可保留）"
  else
    log "保留测试目录供排查: $TESTHOME"
  fi
  exit "$code"
}
trap cleanup EXIT

# ── 1. 准备隔离 DSH_HOME ─────────────────────────────────────
log "准备隔离 DSH_HOME: $TESTHOME"
rm -rf -- "$TESTHOME"
mkdir -p "$TESTHOME/profiles" "$TEST_CWD"
# 表情包样例：内嵌 1x1 PNG（70 字节，IHDR/IDAT/IEND CRC 校验通过），放到隔离 sandbox cwd 下，
# 避免依赖/污染 live 工作区的 stickers/。
QA_PNG_B64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
mkdir -p "$TEST_CWD/stickers"
printf '%s' "$QA_PNG_B64" | base64 -d > "$TEST_CWD/stickers/laugh.png"
{ printf '%s' "$QA_PNG_B64" | base64 -d; printf '\nQA-HEHE'; } > "$TEST_CWD/stickers/hehe.png"
chmod 600 "$TEST_CWD/stickers/laugh.png" "$TEST_CWD/stickers/hehe.png"
log "已准备隔离表情包样例: $TEST_CWD/stickers/{laugh,hehe}.png"
# 预置隔离 settings.json：把群聊模式设为 adaptive（追加需求 2026-10-26 晚），
# 其余字段由 settings-store 归一化补默认值。只写 TESTHOME，不碰 live。
mkdir -p "$TESTHOME/state"
cat > "$TESTHOME/state/settings.json" <<'JSON'
{"version":1,"reply":{"groupMode":"adaptive"},"admin":{"enabled":true,"openids":["qa-admin-openid"],"names":["QA管理员"]}}
JSON
chmod 600 "$TESTHOME/state/settings.json"
log "已预置隔离 settings.json（groupMode=adaptive）"
ln -s "$LIVE_PROFILE" "$TESTHOME/profiles/web"
[[ -f "$TESTHOME/profiles/web/package.json" ]] || die "profile 软链创建失败"
log "profile 软链: $TESTHOME/profiles/web -> $LIVE_PROFILE"
mkdir -p "$REPO_DIR/test/artifacts"

# ── 2. 安装插件到 profile node_modules ───────────────────────
if (( SKIP_INSTALL )); then
  log "跳过 install-local.sh（--skip-install）"
else
  log "同步插件到 profile node_modules ..."
  SRC="$REPO_DIR" PROFILE_DIR="$LIVE_PROFILE" bash "$SCRIPT_DIR/install-local.sh"
fi

# ── 3. 生成 overlay.yml（隔离测试叠加层） ────────────────────
# preset 的 plugins 直接从仓库 cordis.patch.yml 提取，保证与 template 一致、不手工漂移。
OVERLAY="$TESTHOME/overlay.yml"
log "生成 overlay: $OVERLAY"
node --input-type=module - "$REPO_DIR" "$LIVE_PROFILE" "$TEST_CWD" "$OVERLAY" "$PROBE" <<'NODE'
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const [repoDir, liveProfile, testCwd, outFile, probeFlag] = process.argv.slice(2);
const requireFromProfile = createRequire(path.join(liveProfile, 'package.json'));
let yaml;
try {
  yaml = requireFromProfile('js-yaml');
} catch (error) {
  console.error('[test-profile] 找不到 js-yaml（应在 profile node_modules 中）:', error.message);
  process.exit(1);
}

// 从仓库 patch 模板提取 preset-qqbot-buddy 行（含 plugins 白名单/压缩配置）。
const repoPatch = yaml.load(fs.readFileSync(path.join(repoDir, 'cordis.patch.yml'), 'utf8'));
if (!Array.isArray(repoPatch)) {
  console.error('[test-profile] 仓库 cordis.patch.yml 必须是 YAML 数组');
  process.exit(1);
}
const inserts = repoPatch.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []));
const presetRow = inserts.find((row) => row && row.id === 'preset-qqbot-buddy');
if (!presetRow) {
  console.error('[test-profile] 仓库 cordis.patch.yml 缺少 insert: preset-qqbot-buddy');
  process.exit(1);
}

// 状态目录/媒体目录也放进 TESTHOME：避免测试实例写真实 ~/.dsh-qqbot。
const testHome = path.dirname(outFile);
const safeConfig = {
  appId: '',
  appSecret: '',
  autoStart: false,
  cwd: testCwd,
  preset: 'qqbot-buddy',
  stateDir: path.join(testHome, 'state'),
  mediaDir: path.join(testHome, 'media'),
  settingsFile: path.join(testHome, 'state', 'settings.json'),
  // 绑定服务写 cordis.patch.yml 的沙箱目录：绝不指向 live profile。
  profileDir: path.join(testHome, 'binding-profile'),
  // 隔离实例绝不发起真实扫码网络请求（绑定功能用假 service 单测覆盖）。
  bindOnMissingCredentials: false,
};
// 绑定沙箱目录：空目录即可（persist 只在真正绑定/解绑时才创建 patch 文件）。
fs.mkdirSync(path.join(testHome, 'binding-profile'), { recursive: true });

// live profile 可能已经被 deploy-live.sh 部署过（含真实凭据 + autoStart:true）。
// 这种情况下再 insert 同名 entry 会产生重复行，还会把真实凭据带进测试实例；
// 因此改为按 id 配置 patch（dsh 的 config patch 是整段替换）把配置覆盖为隔离安全值。
let livePatch = [];
try {
  livePatch = yaml.load(fs.readFileSync(path.join(liveProfile, 'cordis.patch.yml'), 'utf8')) || [];
} catch (error) {
  console.error('[test-profile] 读取 live profile cordis.patch.yml 失败: ' + (error && error.message));
  process.exit(1);
}
const liveRows = Array.isArray(livePatch)
  ? livePatch.flatMap((entry) => [entry, ...(Array.isArray(entry?.insert) ? entry.insert : [])])
  : [];
const hasBuddy = liveRows.some((row) => row && row.id === 'qqbot-buddy');
const hasPreset = liveRows.some((row) => row && row.id === 'preset-qqbot-buddy');

// 判断官方 im-qqbot 是否真实存在：看 profile 的 bundle 列表 / patch 里的 name，
// 不能只看 patch 里是否有 `- id: im-qqbot`（迁移后可能残留失效的 disable 行，导致 overlay 目标不存在）。
let liveBundles = [];
try {
  const livePkg = JSON.parse(fs.readFileSync(path.join(liveProfile, 'package.json'), 'utf8'));
  liveBundles = Array.isArray(livePkg?.dsh?.profile?.bundles) ? livePkg.dsh.profile.bundles : [];
} catch {
  liveBundles = [];
}
const hasImQqbot = liveBundles.includes('@tencent-connect/dsh-qqbot')
  || liveRows.some((row) => row && row.name === '@tencent-connect/dsh-qqbot');
const overlay = [];
if (hasImQqbot) overlay.push({ id: 'im-qqbot', disabled: true });
if (hasBuddy) {
  overlay.push({ id: 'qqbot-buddy', config: safeConfig });
} else {
  overlay.push({ insert: [{ id: 'qqbot-buddy', name: 'dsh-qqbot-buddy', config: safeConfig }] });
}
if (hasPreset) {
  // live 可能还是旧版 preset（含 tool-fs/guard）：用仓库模板按 id 覆盖 config，
  // 让隔离实例始终验证「迁移后」的精简 preset（只含 compaction）。
  overlay.push({ id: 'preset-qqbot-buddy', config: presetRow.config || {} });
} else {
  overlay.push({ insert: [presetRow] });
}

// --probe：插入 QA 探针插件（绝对路径；只读写 TESTHOME，不碰 live/网络）。
if (probeFlag === '1') {
  overlay.push({
    insert: [
      {
        id: 'qa-features-probe',
        name: path.join(repoDir, 'test/e2e/features-probe.js'),
        config: {
          outFile: path.join(testHome, 'features-probe-result.json'),
          pluginEntry: path.join(liveProfile, 'node_modules/dsh-qqbot-buddy/lib/index.js'),
        },
      },
    ],
  });
}

const header = [
  '# 由 scripts/test-profile.sh 自动生成：隔离测试用叠加层，勿提交。',
  hasImQqbot
    ? '# 停用 im-qqbot；qqbot-buddy 强制空凭据 + autoStart=false + bindOnMissingCredentials=false（不连真实 QQ/不发起扫码）。'
    : '# live profile 已迁移（无 im-qqbot 行）；qqbot-buddy 强制空凭据 + autoStart=false（不连真实 QQ）。',
  '# profileDir 指向 TESTHOME/binding-profile（绑定写盘沙箱，绝不写 live profile）。',
  hasBuddy
    ? '# live profile 已部署 qqbot-buddy：用 id 配置 patch 覆盖真实凭据，避免重复 insert。'
    : '# live profile 未部署 qqbot-buddy：insert 一个隔离用的插件行。',
  '',
].join('\n');
const tmp = outFile + '.tmp-' + process.pid;
fs.writeFileSync(tmp, header + yaml.dump(overlay, { noRefs: true, lineWidth: 200 }), { mode: 0o600 });
fs.renameSync(tmp, outFile);

// 自检：落盘后必须能重新解析，且 qqbot-buddy 的隔离配置生效。
const parsed = yaml.load(fs.readFileSync(outFile, 'utf8'));
if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 4) {
  console.error('[test-profile] overlay.yml 自检失败：顶层条目数异常 (' + (Array.isArray(parsed) ? parsed.length : 'not-array') + ')');
  process.exit(1);
}
const buddyEntry = parsed.find((entry) => entry && entry.id === 'qqbot-buddy')
  || parsed.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : [])).find((row) => row && row.id === 'qqbot-buddy');
if (!buddyEntry || !buddyEntry.config) {
  console.error('[test-profile] overlay.yml 自检失败：缺少 qqbot-buddy 条目/config');
  process.exit(1);
}
const buddyConfig = buddyEntry.config;
if (buddyConfig.appId !== '' || buddyConfig.appSecret !== '' || buddyConfig.autoStart !== false
  || buddyConfig.bindOnMissingCredentials !== false) {
  console.error('[test-profile] overlay.yml 自检失败：qqbot-buddy 隔离配置不安全: ' + JSON.stringify(buddyConfig));
  process.exit(1);
}
const profileDirValue = typeof buddyConfig.profileDir === 'string' ? buddyConfig.profileDir : '';
if (!profileDirValue.startsWith(testHome + path.sep)) {
  console.error('[test-profile] overlay.yml 自检失败：profileDir 必须指向 TESTHOME 沙箱，实际: ' + JSON.stringify(profileDirValue));
  process.exit(1);
}
const presetCovered = parsed.some((entry) => entry && entry.id === 'preset-qqbot-buddy' && entry.config)
  || parsed.some((entry) => Array.isArray(entry?.insert) && entry.insert.some((row) => row && row.id === 'preset-qqbot-buddy'));
if (!presetCovered) {
  console.error('[test-profile] overlay.yml 自检失败：缺少 preset-qqbot-buddy（insert 或 id config patch）');
  process.exit(1);
}
console.log('[test-profile] overlay 校验通过：' + parsed.length + ' 个顶层条目（live 已部署=' + hasBuddy
  + '），preset 含 ' + (presetRow.config?.plugins?.length ?? 0) + ' 个插件');
NODE

# ── 4. dump-config 组合校验 ──────────────────────────────────
DUMP="$TESTHOME/dump-config.yml"
DUMP_ERR="$TESTHOME/dump-config.err"
log "dump-config 组合校验 ..."
if ! DSH_HOME="$TESTHOME" "$DSH_BIN" --profile web --patch "$OVERLAY" --dump-config >"$DUMP" 2>"$DUMP_ERR"; then
  sed -n '1,80p' "$DUMP_ERR" >&2 || true
  die "dump-config 执行失败"
fi
chmod 600 "$DUMP" "$DUMP_ERR" 2>/dev/null || true

# 取 dump 中某个顶层 entry（"- id: <id>"）的完整块用于断言。
row_block() {
  awk -v want="- id: $1" '
    $0 == want { flag = 1; print; next }
    flag && /^[^ #]/ { exit }
    flag { print }
  ' "$DUMP"
}

FAIL=0
check_row() {
  local id=$1; shift
  local block
  block=$(row_block "$id")
  if [[ -z "$block" ]]; then
    log "✗ dump 中缺少 entry: $id"
    FAIL=1
    return
  fi
  local pattern
  for pattern in "$@"; do
    if ! grep -qF -- "$pattern" <<<"$block"; then
      log "✗ entry $id 缺少: $pattern"
      FAIL=1
    fi
  done
}

check_row_not_contains() {
  local id=$1; shift
  local block
  block=$(row_block "$id")
  local pattern
  for pattern in "$@"; do
    if grep -qF -- "$pattern" <<<"$block"; then
      log "✗ entry $id 不应包含: $pattern"
      FAIL=1
    fi
  done
}

check_row qqbot-buddy \
  'name: dsh-qqbot-buddy' \
  "cwd: $TEST_CWD" \
  'preset: qqbot-buddy' \
  'autoStart: false' \
  'bindOnMissingCredentials: false' \
  "profileDir: $TESTHOME/binding-profile" \
  "appId: ''" \
  "appSecret: ''"
check_row preset-qqbot-buddy \
  'id: qqbot-buddy' \
  'plugins:' \
  'id: compaction-basic' \
  'id: command-compact'
# 迁移后 preset 必须只含 compaction：不应再出现 fs/web/guard（防回退）
check_row_not_contains preset-qqbot-buddy 'tool-fs' 'tool-web' 'preset-guard'
check_row_not_contains qqbot-buddy 'preset-guard'
if grep -q '^- id: im-qqbot$' "$DUMP"; then
  check_row im-qqbot 'disabled: true'
else
  log "live profile 已迁移（dump 中无 im-qqbot 行），跳过 im-qqbot 停用断言"
fi

# overlay 自身不能有无效 patch 目标（例如按 id patch 并不存在的树节点）。
if grep -qF "$OVERLAY] patch: entry" "$DUMP_ERR"; then
  log "✗ overlay 存在无效的 patch 目标:"
  grep -F "$OVERLAY] patch: entry" "$DUMP_ERR" >&2 || true
  FAIL=1
fi
# live profile 里已有两条与当前 bundle 不相干的历史 patch 警告，容忍但提示。
KNOWN_WARNINGS=$(grep -cF 'patch: entry' "$DUMP_ERR" || true)
if (( FAIL != 0 )); then
  die "dump-config 组合校验失败（dump: $DUMP）"
fi
log "dump-config 校验通过：qqbot-buddy / preset-qqbot-buddy / im-qqbot disabled 均在组合结果中"
if (( KNOWN_WARNINGS > 0 )); then
  log "（已知无害告警 $KNOWN_WARNINGS 条，来自 live profile 历史 patch，见 $DUMP_ERR）"
fi
check_live_profile || die "live profile 在测试期间被意外修改"

# ── 5.（可选）启动隔离测试 web 实例 ─────────────────────────
if (( SERVE )); then
  [[ -f "$LIVE_PROFILE/node_modules/dsh-qqbot-buddy/lib/index.js" ]] \
    || die "插件入口不存在: $LIVE_PROFILE/node_modules/dsh-qqbot-buddy/lib/index.js（先完成 lib/index.js）"
  SERVE_LOG="$TESTHOME/serve.log"
  log "启动隔离测试实例: http://127.0.0.1:$PORT （autoStart=false / 空凭据 / DSH_HOME=$TESTHOME）"
  env DSH_HOME="$TESTHOME" "$DSH_BIN" --profile web --patch "$OVERLAY" --port "$PORT" --no-open \
    >"$SERVE_LOG" 2>&1 &
  SERVE_PID=$!
  printf '%s\n' "$SERVE_PID" >"$TESTHOME/serve.pid"

  deadline=$((SECONDS + READY_TIMEOUT))
  ready=0
  http_code=""
  while ((SECONDS < deadline)); do
    if ! kill -0 "$SERVE_PID" 2>/dev/null; then
      log "测试实例已退出，最近日志："
      tail -n 80 "$SERVE_LOG" >&2 || true
      die "测试实例启动失败（进程提前退出，见 $SERVE_LOG）"
    fi
    # 插件激活失败时不必干等超时：立即 dump 日志并失败。
    if grep -qE 'qqbot-buddy.*(Error|error)' "$SERVE_LOG" 2>/dev/null; then
      log "检测到 qqbot-buddy 激活/运行报错，提前结束等待。最近日志："
      tail -n 80 "$SERVE_LOG" >&2 || true
      die "插件启动报错（见 $SERVE_LOG）"
    fi
    http_code=$(curl -sS -o "$TESTHOME/state.json.tmp" -w '%{http_code}' --max-time 2 \
      "http://127.0.0.1:$PORT/qqbot-buddy/api/state" 2>/dev/null || true)
    if [[ "$http_code" == "200" ]]; then
      mv -f "$TESTHOME/state.json.tmp" "$TESTHOME/state.json"
      ready=1
      break
    fi
    sleep 0.5
  done
  if (( ready == 0 )); then
    log "等待 $READY_TIMEOUT 秒仍未就绪（最后 HTTP 状态码: ${http_code:-无}），最近日志："
    tail -n 80 "$SERVE_LOG" >&2 || true
    die "测试实例未就绪"
  fi
  chmod 600 "$TESTHOME/state.json" 2>/dev/null || true

  log "校验 GET /qqbot-buddy/api/state ..."
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    let state;
    try {
      state = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      console.error("[test-profile] state.json 不是合法 JSON:", error.message);
      process.exit(1);
    }
    const problems = [];
    if (state.ok !== true) problems.push("ok !== true");
    if (typeof state.version !== "string" || state.version === "") problems.push("version 缺失");
    if (!state.settings || !state.settings.reply) problems.push("settings.reply 缺失");
    if (!state.paths || typeof state.paths.cwd !== "string") problems.push("paths.cwd 缺失");
    if (state.bot && state.bot.ready === true) problems.push("bot.ready=true（测试实例不应连接真实 QQ）");
    if (state.bot && state.bot.appId) problems.push("bot.appId 非空（测试实例不应带真实凭据）");
    if (!state.settings || !state.settings.reply || state.settings.reply.groupMode !== "adaptive") {
      problems.push("隔离 settings.json 的 reply.groupMode 未生效为 adaptive");
    }
    if (!state.settings.reply.adaptive || typeof state.settings.reply.adaptive.debounceSeconds !== "number") {
      problems.push("reply.adaptive 参数缺失");
    }
    // adaptive 生效摘要：至少包含自适应参数（静默/冷却/最长等待）；若文案带上“自适应”字样更好。
    if (!state.effective || typeof state.effective.summary !== "string"
      || !(state.effective.summary.includes("自适应")
        || (state.effective.summary.includes("静默") && state.effective.summary.includes("冷却") && state.effective.summary.includes("最长等待")))) {
      problems.push("effective.summary 未体现自适应参数（当前: " + (state.effective && state.effective.summary) + "）");
    }
    if (!state.model || typeof state.model !== "object") problems.push("state.model 缺失（本期追加需求）");
    else {
      if (!state.model.selected || typeof state.model.selected.provider !== "string") problems.push("state.model.selected 结构异常");
      if (!("effective" in state.model)) problems.push("state.model.effective 缺失");
      if (typeof state.model.source !== "string" || state.model.source === "") problems.push("state.model.source 缺失");
    }
    if (state.stats && typeof state.stats.received !== "number") problems.push("stats.received 不是数字");
    if (problems.length > 0) {
      console.error("[test-profile] state 校验失败: " + problems.join("; "));
      process.exit(1);
    }
    console.log("[test-profile] state 校验通过: ok=true, version=" + state.version +
      ", bot.ready=" + Boolean(state.bot && state.bot.ready) +
      ", bot.appId=" + JSON.stringify(state.bot ? state.bot.appId : undefined));
  ' "$TESTHOME/state.json" || die "state API 校验失败"

  # 模型/绑定 API 冒烟（追加需求 2026-10-25）：结构校验 + 存证到 TESTHOME。
  for api in models bind/state; do
    api_file="$TESTHOME/api-$(printf '%s' "$api" | tr '/' '-').json"
    if ! curl -fsS --max-time 10 "http://127.0.0.1:$PORT/qqbot-buddy/api/$api" -o "$api_file"; then
      die "GET /qqbot-buddy/api/$api 失败"
    fi
    chmod 600 "$api_file" 2>/dev/null || true
  done
  node -e '
    const fs = require("node:fs");
    const [modelsFile, bindFile] = process.argv.slice(1);
    const problems = [];
    let models;
    let bind;
    try { models = JSON.parse(fs.readFileSync(modelsFile, "utf8")); } catch (e) { problems.push("models 不是合法 JSON: " + e.message); }
    try { bind = JSON.parse(fs.readFileSync(bindFile, "utf8")); } catch (e) { problems.push("bind/state 不是合法 JSON: " + e.message); }
    if (models) {
      if (models.ok !== true) problems.push("models.ok !== true");
      if (!Array.isArray(models.providers)) problems.push("models.providers 不是数组");
      if (!models.selected || typeof models.selected.provider !== "string") problems.push("models.selected 结构异常");
      if (typeof models.source !== "string" || !["settings", "config", "host"].includes(models.source)) problems.push("models.source 非法: " + models.source);
    }
    if (bind) {
      if (bind.ok !== true) problems.push("bind/state ok !== true");
      if (typeof bind.phase !== "string" || bind.phase === "") problems.push("bind/state phase 缺失");
      if (Object.prototype.hasOwnProperty.call(bind, "appSecret")) problems.push("bind/state 泄漏 appSecret");
      if (bind.phase === "bound") problems.push("隔离实例不应处于 bound（可能带真实凭据）");
    }
    if (problems.length > 0) { console.error("[test-profile] API 冒烟失败: " + problems.join("; ")); process.exit(1); }
    console.log("[test-profile] models API: providers=" + models.providers.length + ", source=" + models.source
      + "；bind/state: phase=" + bind.phase);
  ' "$TESTHOME/api-models.json" "$TESTHOME/api-bind-state.json" || die "模型/绑定 API 结构校验失败"

  # 人格卡 / 命令目录 / 管理员设置 API（第四批 UI 与权限改造）
  log "人格卡/命令/管理员 API 校验 ..."
  node --input-type=module - "$PORT" "$TESTHOME/persona-admin-api-result.json" <<'NODE'
import fs from 'node:fs';

const [port, outFile] = process.argv.slice(2);
const API = 'http://127.0.0.1:' + port + '/qqbot-buddy/api';
const checks = [];
const pass = (name, detail) => checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
const fail = (name, detail) => checks.push({ name, ok: false, ...(detail === undefined ? {} : { detail }) });
async function req(pathname, options = {}) {
  const response = await fetch(API + pathname, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}
function post(pathname, payload) {
  return req(pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

const created = [];
try {
  // 1) 命令目录 + admin 回显（settings.json 预置了 qa-admin-openid）
  const commands = await req('/commands');
  const cmdBody = commands.body || {};
  const names = Array.isArray(cmdBody.commands) ? cmdBody.commands.map((item) => item.name) : [];
  if (commands.status === 200 && cmdBody.ok === true && names.includes('id') && names.includes('new') && names.includes('help')) {
    pass('GET /commands 返回命令目录', { count: names.length });
  } else {
    fail('GET /commands 返回命令目录', { status: commands.status, names });
  }
  const newCmd = (cmdBody.commands || []).find((item) => item.name === 'new');
  if (newCmd && newCmd.adminOnly === true) pass('/new 标记为管理员命令');
  else fail('/new 标记为管理员命令', newCmd);
  const adminEcho = cmdBody.admin || {};
  if (adminEcho.enabled === true && Array.isArray(adminEcho.openids) && adminEcho.openids.includes('qa-admin-openid')) {
    pass('commands 回显隔离 settings.json 的管理员配置', adminEcho);
  } else {
    fail('commands 回显隔离 settings.json 的管理员配置', adminEcho);
  }

  // 2) 管理员设置保存 + 回显
  const saved = await post('/settings', { patch: { admin: { openids: ['qa-admin-openid', 'qa-admin-2'] } } });
  const savedAdmin = saved.body && saved.body.settings && saved.body.settings.admin;
  if (saved.status === 200 && saved.body && saved.body.ok === true && savedAdmin && savedAdmin.openids.length === 2) {
    pass('POST /settings 保存 admin.openids（深合并）');
  } else {
    fail('POST /settings 保存 admin.openids（深合并）', { status: saved.status, admin: savedAdmin });
  }
  const commands2 = await req('/commands');
  const adminEcho2 = (commands2.body && commands2.body.admin) || {};
  if (Array.isArray(adminEcho2.openids) && adminEcho2.openids.length === 2 && adminEcho2.enabled === true) {
    pass('保存后 /commands 回显新管理员名单');
  } else {
    fail('保存后 /commands 回显新管理员名单', adminEcho2);
  }

  // 3) 人格卡 CRUD + activate → 当前 persona 内容切换
  const list0 = await req('/persona/cards');
  if (list0.status === 200 && list0.body && list0.body.ok === true && Array.isArray(list0.body.cards)) {
    pass('GET /persona/cards 可用', { count: list0.body.cards.length });
  } else {
    fail('GET /persona/cards 可用', { status: list0.status, body: list0.body });
  }
  const cardA = await post('/persona/cards', { name: 'QA 卡 A', description: '隔离测试', content: 'QA 人格卡 A（隔离测试）' });
  const aId = cardA.body && cardA.body.card && cardA.body.card.id;
  if (cardA.status === 200 && aId) { created.push(aId); pass('创建人格卡 A'); }
  else fail('创建人格卡 A', { status: cardA.status, body: cardA.body });
  const cardB = await post('/persona/cards', { name: 'QA 卡 B', content: 'QA 人格卡 B（隔离测试）' });
  const bId = cardB.body && cardB.body.card && cardB.body.card.id;
  if (cardB.status === 200 && bId) { created.push(bId); pass('创建人格卡 B'); }
  else fail('创建人格卡 B', { status: cardB.status, body: cardB.body });

  const activated = await post('/persona/cards/activate', { id: bId });
  if (activated.status === 200 && activated.body && activated.body.ok === true) pass('激活人格卡 B');
  else fail('激活人格卡 B', { status: activated.status, body: activated.body });
  const persona = await req('/persona');
  const personaText = (persona.body && persona.body.text) || '';
  if (personaText.includes('QA 人格卡 B')) pass('激活后 /persona 内容切换为卡片 B');
  else fail('激活后 /persona 内容切换为卡片 B', personaText.slice(0, 80));
  const list1 = await req('/persona/cards');
  const activeId = list1.body && list1.body.activeId;
  if (activeId === bId) pass('人格卡列表 activeId 指向卡片 B');
  else fail('人格卡列表 activeId 指向卡片 B', { activeId, bId });

  const updated = await post('/persona/cards/update', { id: aId, content: 'QA 人格卡 A2（隔离测试）' });
  if (updated.status === 200 && updated.body && updated.body.ok === true) pass('更新人格卡 A 内容');
  else fail('更新人格卡 A 内容', { status: updated.status, body: updated.body });

  // 4) 删除卡片；删除激活卡不影响当前 persona 文件
  const delA = await post('/persona/cards/delete', { id: aId });
  if (delA.status === 200 && delA.body && delA.body.ok === true) { created.splice(created.indexOf(aId), 1); pass('删除人格卡 A'); }
  else fail('删除人格卡 A', { status: delA.status, body: delA.body });
  const delB = await post('/persona/cards/delete', { id: bId });
  if (delB.status === 200 && delB.body && delB.body.ok === true) { created.splice(created.indexOf(bId), 1); pass('删除人格卡 B（激活卡）'); }
  else fail('删除人格卡 B（激活卡）', { status: delB.status, body: delB.body });
  const personaAfter = await req('/persona');
  const personaTextAfter = (personaAfter.body && personaAfter.body.text) || '';
  if (personaTextAfter.includes('QA 人格卡 B')) pass('删除激活卡后当前 persona 内容保持不变');
  else fail('删除激活卡后当前 persona 内容保持不变', personaTextAfter.slice(0, 80));
} catch (error) {
  checks.push({ name: '人格卡/命令 API 异常', ok: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  for (const id of created) {
    try { await post('/persona/cards/delete', { id }); } catch { /* ignore */ }
  }
  const ok = checks.length > 0 && checks.every((item) => item.ok);
  try { fs.writeFileSync(outFile, JSON.stringify({ ok, checks }, null, 2) + '\n', { mode: 0o600 }); }
  catch (error) { console.error('[test-profile] 写人格卡/命令结果失败: ' + (error && error.message)); }
  for (const item of checks) console.log('[test-profile] cards ' + (item.ok ? '✓' : '✗') + ' ' + item.name);
  if (!ok) { console.error('[test-profile] 人格卡/命令 API 校验失败'); process.exit(1); }
}
NODE
  mkdir -p "$REPO_DIR/test/artifacts"
  cp "$TESTHOME/persona-admin-api-result.json" "$REPO_DIR/test/artifacts/persona-admin-api-result.json"
  chmod 644 "$REPO_DIR/test/artifacts/persona-admin-api-result.json" 2>/dev/null || true
  log "人格卡/命令/管理员 API 通过：结果已保存到 test/artifacts/persona-admin-api-result.json"

  # 截图前把隔离实例的当前人设恢复为中性文案（persona API 走真实写盘，但只写 TEST_CWD）。
  curl -fsS --max-time 10 -X POST -H 'content-type: application/json' \
    --data '{"text":"（隔离验收用临时人设，非 live）"}' \
    "http://127.0.0.1:$PORT/qqbot-buddy/api/persona" >/dev/null \
    || log "警告: 恢复隔离人设失败（不影响后续校验）"

  # 表情包 API 闭环（追加需求 2026-10-26）：GET 列表 → file → upload → update → delete → GET 列表。
  # 全程只操作隔离 sandbox cwd 下的 stickers/；任何写 live 都会在 check_live_profile 里失败。
  log "表情包 API 闭环校验 ..."
  node --input-type=module - "$PORT" "$TEST_CWD/stickers" "$TESTHOME/stickers-api-result.json" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [port, stickersDir, outFile] = process.argv.slice(2);
const BASE = 'http://127.0.0.1:' + port + '/qqbot-buddy/api/stickers';
/** 1x1 PNG（与 test-profile 写入样例相同，用于 upload dataURL）。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 上传内容加唯一标记字节：与两张隔离样例不同，避免被内容去重命中。
const PNG_DATA_URL = 'data:image/png;base64,'
  + Buffer.concat([Buffer.from(PNG_B64, 'base64'), Buffer.from('\nQA-UPLOAD')]).toString('base64');

const checks = [];
const pass = (name, detail) => checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
const fail = (name, detail) => checks.push({ name, ok: false, ...(detail === undefined ? {} : { detail }) });

async function req(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') || '';
  let body = null;
  if (contentType.includes('application/json')) {
    try { body = await response.json(); } catch { body = null; }
  } else {
    body = new Uint8Array(await response.arrayBuffer());
  }
  return { status: response.status, headers: response.headers, body, contentType };
}

function post(pathname, payload) {
  return req(BASE + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

let uploadedCreated = false;
try {
  // 1. 列表：样例贴纸 + 目录/开关契约值
  const list = await req(BASE);
  const listBody = list.body || {};
  const items = Array.isArray(listBody.items) ? listBody.items : [];
  const names = items.map((item) => item.name);
  if (list.status === 200 && listBody.ok === true) pass('GET /stickers 返回 ok', { count: items.length });
  else fail('GET /stickers 返回 ok', { status: list.status, body: listBody });
  if (names.includes('laugh.png') && names.includes('hehe.png')) pass('隔离样例贴纸出现在列表中', names);
  else fail('隔离样例贴纸出现在列表中', names);
  if (listBody.dir && path.resolve(listBody.dir) === path.resolve(stickersDir)) pass('dir 指向隔离 sandbox cwd/stickers', listBody.dir);
  else fail('dir 指向隔离 sandbox cwd/stickers', listBody.dir);
  if (listBody.collectEnabled === true && listBody.featuresStickers === true && listBody.maxMB === 8) {
    pass('collectEnabled/featuresStickers/maxMB 契约值');
  } else {
    fail('collectEnabled/featuresStickers/maxMB 契约值', {
      collectEnabled: listBody.collectEnabled, featuresStickers: listBody.featuresStickers, maxMB: listBody.maxMB,
    });
  }
  const itemsSafe = items.every((item) => typeof item.name === 'string' && item.name === path.basename(item.name)
    && typeof item.url === 'string' && item.url.startsWith('/qqbot-buddy/api/stickers/file?name='));
  if (itemsSafe) pass('列表项只暴露 basename 与 file url（不泄漏绝对路径）');
  else fail('列表项只暴露 basename 与 file url（不泄漏绝对路径）', items.map((item) => ({ name: item.name, url: item.url })));
  const noLeak = items.every((item) => !Object.prototype.hasOwnProperty.call(item, 'path'));
  if (noLeak) pass('列表项不包含绝对 path 字段');
  else fail('列表项不包含绝对 path 字段');

  // 2. 读取图片二进制
  const file = await req(BASE + '/file?name=laugh.png');
  const png = file.body instanceof Uint8Array ? file.body : new Uint8Array();
  const pngSig = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  const fileType = file.headers.get('content-type') || '';
  if (file.status === 200 && pngSig && fileType.includes('image/png')) pass('GET /stickers/file 返回 PNG 二进制', { bytes: png.length });
  else fail('GET /stickers/file 返回 PNG 二进制', { status: file.status, contentType: fileType, bytes: png.length });

  // 3. 路径穿越（file/update-renameTo/delete）必须被拒绝
  const traversalFile = await req(BASE + '/file?name=' + encodeURIComponent('../index.json'));
  if (traversalFile.status === 400 || traversalFile.status === 404) pass('GET file 路径穿越被拒绝', traversalFile.status);
  else fail('GET file 路径穿越被拒绝', traversalFile.status);

  // 4. 上传 dataURL（1x1 PNG）
  const upload = await post('/upload', {
    name: 'qa-upload.png',
    dataUrl: PNG_DATA_URL,
    emotion: 'qa-e2e',
    tags: ['qa', 'e2e'],
    note: 'isolation test',
  });
  if (upload.status === 200 && upload.body && upload.body.ok === true && upload.body.item && upload.body.item.name === 'qa-upload.png') {
    uploadedCreated = true;
    pass('POST /upload 成功', upload.body.item.name);
  } else {
    fail('POST /upload 成功', { status: upload.status, body: upload.body });
  }
  const afterUpload = await req(BASE);
  const uploadedNames = ((afterUpload.body && afterUpload.body.items) || []).map((item) => item.name);
  if (uploadedNames.includes('qa-upload.png')) pass('上传后 list 包含新表情', uploadedNames);
  else fail('上传后 list 包含新表情', uploadedNames);
  const uploadedFile = await req(BASE + '/file?name=qa-upload.png');
  if (uploadedFile.status === 200) pass('上传的文件可通过 file 接口访问', uploadedFile.status);
  else fail('上传的文件可通过 file 接口访问', uploadedFile.status);

  // 4.5 内容去重 + API 上传不受每日配额限制（追加需求 2026-10-26 晚）
  const apiSettings = await req('http://127.0.0.1:' + port + '/qqbot-buddy/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { stickers: { dailyLimit: 1 } } }),
  });
  if (apiSettings.status === 200 && apiSettings.body && apiSettings.body.ok === true) {
    pass('API 设置 stickers.dailyLimit=1（用于验证 API 上传不受配额限制）');
  } else {
    fail('API 设置 stickers.dailyLimit=1', { status: apiSettings.status, body: apiSettings.body });
  }
  const dupBefore = await req(BASE);
  const dupBeforeCount = ((dupBefore.body && dupBefore.body.items) || []).length;
  const dupUpload = await post('/upload', { name: 'qa-upload-copy.png', dataUrl: PNG_DATA_URL, emotion: '重复' });
  if (dupUpload.status === 200 && dupUpload.body && dupUpload.body.ok === true
    && dupUpload.body.item && dupUpload.body.item.name === 'qa-upload.png') {
    pass('同一内容再次 upload 按内容去重返回已有文件名', dupUpload.body.item.name);
  } else {
    fail('同一内容再次 upload 按内容去重返回已有文件名', { status: dupUpload.status, body: dupUpload.body });
  }
  const dupAfter = await req(BASE);
  const dupAfterCount = ((dupAfter.body && dupAfter.body.items) || []).length;
  if (dupAfterCount === dupBeforeCount && !fs.existsSync(path.join(stickersDir, 'qa-upload-copy.png'))) {
    pass('重复 upload 不新增文件/列表项（dailyLimit=1 也允许 API 上传）');
  } else {
    fail('重复 upload 不新增文件/列表项', { before: dupBeforeCount, after: dupAfterCount });
  }

  // 5. 更新元数据
  const update = await post('/update', { name: 'qa-upload.png', emotion: 'qa-updated', tags: ['updated'], note: 'changed' });
  if (update.status === 200 && update.body && update.body.ok === true
    && update.body.item && update.body.item.emotion === 'qa-updated') {
    pass('POST /update 修改 emotion 生效');
  } else {
    fail('POST /update 修改 emotion 生效', { status: update.status, body: update.body });
  }
  const renameTraversal = await post('/update', { name: 'qa-upload.png', renameTo: '../evil.png' });
  if (renameTraversal.status === 400) pass('update renameTo 穿越被拒绝', renameTraversal.status);
  else fail('update renameTo 穿越被拒绝', { status: renameTraversal.status, body: renameTraversal.body });

  // 6. 非法图片（magic bytes 不符）必须拒绝
  const badUpload = await post('/upload', { name: 'bad.png', dataUrl: 'data:image/png;base64,AAAA' });
  if (badUpload.status === 400) pass('upload 非法图片被拒绝', badUpload.status);
  else fail('upload 非法图片被拒绝', { status: badUpload.status, body: badUpload.body });

  // 7. 删除 + 列表/磁盘同步
  const del = await post('/delete', { name: 'qa-upload.png' });
  if (del.status === 200 && del.body && del.body.ok === true) {
    uploadedCreated = false;
    pass('POST /delete 成功');
  } else {
    fail('POST /delete 成功', { status: del.status, body: del.body });
  }
  const afterDelete = await req(BASE);
  const deletedNames = ((afterDelete.body && afterDelete.body.items) || []).map((item) => item.name);
  if (!deletedNames.includes('qa-upload.png')) pass('删除后 list 不含该表情', deletedNames);
  else fail('删除后 list 不含该表情', deletedNames);
  if (!fs.existsSync(path.join(stickersDir, 'qa-upload.png'))) pass('删除后磁盘文件已移除');
  else fail('删除后磁盘文件已移除');
  const deleteTraversal = await post('/delete', { name: '../x.png' });
  if (deleteTraversal.status === 400) pass('delete 路径穿越被拒绝', deleteTraversal.status);
  else fail('delete 路径穿越被拒绝', { status: deleteTraversal.status, body: deleteTraversal.body });
} catch (error) {
  checks.push({ name: '表情包 API 闭环异常', ok: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  if (uploadedCreated) {
    try { await post('/delete', { name: 'qa-upload.png' }); } catch { /* ignore */ }
  }
  const ok = checks.length > 0 && checks.every((item) => item.ok);
  try {
    fs.writeFileSync(outFile, JSON.stringify({ ok, checks }, null, 2) + '\n', { mode: 0o600 });
  } catch (error) {
    console.error('[test-profile] 写表情包闭环结果失败: ' + (error && error.message));
  }
  for (const item of checks) console.log('[test-profile] stickers ' + (item.ok ? '✓' : '✗') + ' ' + item.name);
  if (!ok) {
    console.error('[test-profile] 表情包 API 闭环失败');
    process.exit(1);
  }
}
NODE
  mkdir -p "$REPO_DIR/test/artifacts"
  cp "$TESTHOME/stickers-api-result.json" "$REPO_DIR/test/artifacts/stickers-api-result.json"
  chmod 644 "$REPO_DIR/test/artifacts/stickers-api-result.json" 2>/dev/null || true
  log "表情包 API 闭环通过：结果已保存到 test/artifacts/stickers-api-result.json"

  # 可选：功能开关探针（--probe）：等实例内探针写出结果并断言。
  if (( PROBE )); then
    PROBE_RESULT="$TESTHOME/features-probe-result.json"
    log "等待功能开关探针结果 ..."
    probe_wait=0
    while (( probe_wait < 300 )); do
      [[ -f "$PROBE_RESULT" ]] && break
      if ! kill -0 "$SERVE_PID" 2>/dev/null; then
        tail -n 80 "$SERVE_LOG" >&2 || true
        die "测试实例提前退出（功能开关探针未产出结果）"
      fi
      sleep 0.3
      probe_wait=$((probe_wait + 1))
    done
    [[ -f "$PROBE_RESULT" ]] || { tail -n 80 "$SERVE_LOG" >&2 || true; die "功能开关探针 90 秒内未产出结果"; }
    chmod 600 "$PROBE_RESULT" 2>/dev/null || true
    node -e '
      const fs = require("node:fs");
      const file = process.argv[1];
      let result;
      try { result = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
        console.error("[test-profile] 探针结果不是合法 JSON: " + e.message); process.exit(1);
      }
      const problems = [];
      if (result.ok !== true) problems.push("探针整体 ok != true");
      if (!Array.isArray(result.checks) || result.checks.length === 0) problems.push("探针没有 checks");
      const failed = (result.checks || []).filter((item) => !item.ok);
      for (const item of failed) problems.push("失败断言: " + item.name + " -> " + item.error);
      if (Array.isArray(result.errors) && result.errors.length > 0) problems.push("探针异常: " + result.errors.join("; "));
      if (problems.length > 0) { console.error("[test-profile] 功能开关探针失败: " + problems.join(" | ")); process.exit(1); }
      for (const item of result.checks) console.log("[test-profile] probe ✓ " + item.name);
    ' "$PROBE_RESULT" || die "功能开关探针断言失败（结果: $PROBE_RESULT）"
    mkdir -p "$REPO_DIR/test/artifacts"
    cp "$PROBE_RESULT" "$REPO_DIR/test/artifacts/features-probe.json"
    chmod 644 "$REPO_DIR/test/artifacts/features-probe.json" 2>/dev/null || true
    log "功能开关探针通过：结果已保存到 test/artifacts/features-probe.json"
  fi

  # 可选：浏览器验收（Playwright 截图设置页各 tab）。
  if (( SHOTS )); then
    # 等待 dsh 把带 token 的访问 URL 写进日志（启动日志与 HTTP 就绪存在竞态）。
    TOKEN_URL=""
    for _ in $(seq 1 50); do
      TOKEN_URL=$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$SERVE_LOG" 2>/dev/null | head -1 || true)
      [[ -n "$TOKEN_URL" ]] && break
      sleep 0.2
    done
    TOKEN_URL=${TOKEN_URL:-http://127.0.0.1:$PORT/}
    mkdir -p "$REPO_DIR/test/artifacts"
    # 清掉上一版 tab 命名的旧截图，避免产物混淆（本次会重新生成全部 8 张）。
    rm -f "$REPO_DIR"/test/artifacts/*.png
    log "浏览器验收：打开 $TOKEN_URL 并截图到 test/artifacts ..."
    if ! ( cd "$REPO_DIR" && NODE_PATH="$(npm root -g)" node test/e2e/settings-screenshots.cjs \
      --url "$TOKEN_URL" --out "$REPO_DIR/test/artifacts" \
      --state-url "http://127.0.0.1:$PORT/qqbot-buddy/api/state" \
      --bind-state-url "http://127.0.0.1:$PORT/qqbot-buddy/api/bind/state" ); then
      die "浏览器验收失败（明细见 test/artifacts/browser-report.json）"
    fi
    log "浏览器验收通过：截图与 browser-report.json 已写入 test/artifacts"
  fi

  # 断言后立刻停掉本次实例（只杀自己的 PID 树）。
  stop_serve
fi

check_live_profile || die "live profile 在测试期间被意外修改"

# ── 6. 汇总 ──────────────────────────────────────────────────
log "完成：隔离加载校验通过"
printf '  DSH_HOME    : %s\n' "$TESTHOME"
printf '  dump-config : %s\n' "$DUMP"
if (( SERVE )); then
  printf '  state API   : http://127.0.0.1:%s/qqbot-buddy/api/state （已断言 ok:true 并停止实例）\n' "$PORT"
  printf '  serve 日志  : %s\n' "$SERVE_LOG"
  if (( PROBE )); then printf '  probe 结果  : %s\n' "$REPO_DIR/test/artifacts/features-probe.json"; fi
fi
printf '  截图目录    : %s\n' "$REPO_DIR/test/artifacts"