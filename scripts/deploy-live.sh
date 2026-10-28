#!/usr/bin/env bash
# deploy-live.sh —— 把 dsh-qqbot-buddy 部署进 live profile（只改配置，不重启进程）。
#
# 做什么：
#   1. 备份 <profile>/cordis.patch.yml（带时间戳，0600）；
#   2. 用 node + js-yaml 从现有 im-qqbot 段解析 appId/appSecret（仅内存使用，绝不打印明文）；
#   3. 在 patch 末尾**追加**（不重写原有内容）：
#        - 停用官方 im-qqbot；
#        - 停用 chatonly preset（chatonly-persona 嵌套在其 config.plugins 内，无法按 id patch）；
#        - 插入 qqbot-buddy（凭据来自 im-qqbot）+ preset-qqbot-buddy（取自仓库模板）；
#   4. 写入前用 dsh --dump-config 预演组合，确认 qqbot-buddy 生效、im-qqbot 被停用；
#   5. 原子替换 cordis.patch.yml（tmp + fsync + rename），失败自动保留备份。
#
# 明确不做：不重启/不杀 dsh 进程（3080 live 实例保持原样），不修改 package.json。
# 回滚：bash scripts/rollback.sh
#
# 用法：
#   bash scripts/deploy-live.sh            # 部署（幂等：已部署则提示并退出）
#   bash scripts/deploy-live.sh --dry-run  # 只打印将追加的配置（secret 掩码），不写盘
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
PROFILE_DIR=${PROFILE_DIR:-$HOME/.dsh/profiles/web}
LIVE_CWD=${LIVE_CWD:-~/qqbot-workspace}
DSH_BIN=${DSH_BIN:-$(command -v dsh || echo dsh)}
PATCH="$PROFILE_DIR/cordis.patch.yml"
DRY_RUN=0
TMP_APPEND=""
TMP_NEW=""

log() { printf '[deploy-live] %s\n' "$*"; }
die() { printf '[deploy-live] 错误: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: bash scripts/deploy-live.sh [选项]

把 dsh-qqbot-buddy 写入 live profile 的 cordis.patch.yml（停用 im-qqbot/chatonly preset，
写入 qqbot-buddy 与 preset-qqbot-buddy）。只改配置，不重启进程；幂等。

选项:
  --dry-run          只打印将追加的配置（secret 已掩码），不写盘
  --profile DIR      DSH profile 目录（默认 $HOME/.dsh/profiles/web）
  --cwd DIR          bot 工作目录（默认 ~/qqbot-workspace）
  -h, --help         显示本帮助

环境变量: PROFILE_DIR、LIVE_CWD、DSH_BIN。
前置条件: 已执行 scripts/install-local.sh。
EOF
}

while (($# > 0)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --profile) [[ $# -ge 2 ]] || die "--profile 需要目录"; PROFILE_DIR=$2; shift 2 ;;
    --cwd) [[ $# -ge 2 ]] || die "--cwd 需要目录"; LIVE_CWD=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（-h 查看帮助）" ;;
  esac
done

PATCH="$PROFILE_DIR/cordis.patch.yml"

# ── 预检 ──────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "缺少 node"
[[ -d "$PROFILE_DIR" ]] || die "profile 目录不存在: $PROFILE_DIR"
[[ -f "$PATCH" ]] || die "profile 缺少 cordis.patch.yml: $PATCH"
[[ -x "$DSH_BIN" ]] || die "找不到可执行的 dsh: $DSH_BIN（可用 DSH_BIN 覆盖）"
[[ -d "$PROFILE_DIR/node_modules/dsh-qqbot-buddy" ]] \
  || die "插件未安装到 $PROFILE_DIR/node_modules/dsh-qqbot-buddy，请先执行 scripts/install-local.sh"
[[ -f "$PROFILE_DIR/node_modules/dsh-qqbot-buddy/lib/index.js" ]] \
  || die "插件入口 lib/index.js 不存在，插件包不完整，先执行 scripts/install-local.sh"

# 推导 DSH_HOME（<home>/profiles/<name>），用于 dump-config 预演。
PROFILES_PARENT=$(dirname -- "$PROFILE_DIR")
if [[ "$(basename -- "$PROFILES_PARENT")" != "profiles" ]]; then
  die "无法从 $PROFILE_DIR 推导 DSH_HOME（应形如 <DSH_HOME>/profiles/web）"
fi
DSH_HOME_DIR=$(dirname -- "$PROFILES_PARENT")
[[ -d "$DSH_HOME_DIR" ]] || die "推导出的 DSH_HOME 不存在: $DSH_HOME_DIR"

# 幂等：已部署则直接退出，不重复追加。
if grep -q 'dsh-qqbot-buddy' "$PATCH"; then
  log "检测到 profile 已包含 dsh-qqbot-buddy 部署，跳过（幂等）"
  log "如需重新部署：先执行 bash scripts/rollback.sh 回滚，再重跑本脚本"
  exit 0
fi

# live 进程状态仅用于提示，不操作。
pid_on_port() {
  ss -ltnp 2>/dev/null | awk -v port=":$1" 'index($4, port) > 0 { if (match($0, /pid=[0-9]+/)) print substr($0, RSTART + 4, RLENGTH - 4) }' | head -1
}
LIVE_PID=$(pid_on_port 3080 || true)
LIVE_PID=${LIVE_PID:-无}

# ── 备份 ──────────────────────────────────────────────────────
STAMP=$(date +%Y%m%d-%H%M%S-%3N)
BACKUP="$PATCH.bak-qqbot-buddy-$STAMP"
log "备份: $BACKUP"
cp -p -- "$PATCH" "$BACKUP"
chmod 600 -- "$BACKUP"

cleanup() {
  local code=${1:-$?}
  trap - EXIT
  [[ -z "$TMP_APPEND" ]] || rm -f -- "$TMP_APPEND"
  [[ -z "$TMP_NEW" ]] || rm -f -- "$TMP_NEW"
  exit "$code"
}
trap cleanup EXIT

# ── 生成追加块（node + js-yaml，原子写） ─────────────────────
# 追加块放 /tmp（含明文凭据，600 权限且用完即删）；完整新 patch 必须与目标同目录才能原子 rename。
TMP_APPEND=$(mktemp /tmp/dsh-qqbot-deploy-append-XXXXXX.yml)
TMP_NEW="$PROFILE_DIR/.cordis.patch.yml.tmp-deploy.$STAMP"
chmod 600 -- "$TMP_APPEND"
log "解析凭据并生成配置 ..."
node --input-type=module - "$REPO_DIR" "$PROFILE_DIR" "$LIVE_CWD" "$DRY_RUN" "$TMP_APPEND" "$TMP_NEW" <<'NODE'
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const [repoDir, profileDir, liveCwd, dryRunRaw, appendFile, newFile] = process.argv.slice(2);
const dryRun = dryRunRaw === '1';
const log = (message) => console.log('[deploy-live] ' + message);
const fail = (message) => {
  console.error('[deploy-live] 错误: ' + message);
  process.exit(1);
};

const patchFile = path.join(profileDir, 'cordis.patch.yml');
let requireFromProfile;
try {
  requireFromProfile = createRequire(path.join(profileDir, 'package.json'));
} catch (error) {
  fail('无法创建 profile 的 require 上下文: ' + error.message);
}
let yaml;
try {
  yaml = requireFromProfile('js-yaml');
} catch (error) {
  fail('profile node_modules 中找不到 js-yaml: ' + error.message);
}

const maskAppId = (id) => (id.length <= 6 ? '*'.repeat(id.length) : id.slice(0, 4) + '***' + id.slice(-2));
const maskSecret = (secret) => '*'.repeat(Math.min(secret.length, 12)) + '(长度 ' + secret.length + ')';

// 1. 读现有 patch，解析 im-qqbot 凭据。
const raw = fs.readFileSync(patchFile, 'utf8');
let entries;
try {
  entries = yaml.load(raw);
} catch (error) {
  fail('现有 cordis.patch.yml 不是合法 YAML，拒绝继续: ' + error.message);
}
if (!Array.isArray(entries)) fail('现有 cordis.patch.yml 顶层必须是 YAML 数组');
const imQqbot = entries.find((entry) => entry && typeof entry === 'object' && entry.id === 'im-qqbot');
const appId = imQqbot && imQqbot.config && typeof imQqbot.config.appId === 'string' ? imQqbot.config.appId.trim() : '';
const appSecret = imQqbot && imQqbot.config && typeof imQqbot.config.appSecret === 'string' ? imQqbot.config.appSecret.trim() : '';
if (!appId || !appSecret) {
  fail('无法从现有 im-qqbot 段解析 appId/appSecret（请确认其 config.appId / config.appSecret 仍在）');
}

// 2. 从仓库模板提取 preset-qqbot-buddy（保证 preset 插件白名单与仓库一致）。
const repoPatch = yaml.load(fs.readFileSync(path.join(repoDir, 'cordis.patch.yml'), 'utf8'));
if (!Array.isArray(repoPatch)) fail('仓库 cordis.patch.yml 顶层必须是 YAML 数组');
const inserts = repoPatch.flatMap((entry) => (Array.isArray(entry?.insert) ? entry.insert : []));
const presetRow = inserts.find((row) => row && row.id === 'preset-qqbot-buddy');
if (!presetRow) fail('仓库 cordis.patch.yml 缺少 insert: preset-qqbot-buddy');

// 3. 追加块：停用 im-qqbot / chatonly preset，插入本插件与 preset。
const appendRows = [
  { id: 'im-qqbot', disabled: true },
  { id: 'preset-chatonly', disabled: true },
  {
    insert: [
      {
        id: 'qqbot-buddy',
        name: 'dsh-qqbot-buddy',
        config: {
          appId,
          appSecret,
          cwd: liveCwd,
          preset: 'qqbot-buddy',
          autoStart: true,
        },
      },
    ],
  },
  { insert: [presetRow] },
];
const header = [
  '',
  '# ── dsh-qqbot-buddy 部署（scripts/deploy-live.sh 生成于 ' + new Date().toISOString() + '） ──',
  '# 停用官方 im-qqbot 与 chatonly preset；chatonly-persona 在 preset config.plugins 内，无法按 id patch。',
  '# 接入 dsh-qqbot-buddy（凭据取自原 im-qqbot 段）；回滚：bash scripts/rollback.sh',
  '',
].join('\n');
const appendText = header + yaml.dump(appendRows, { noRefs: true, lineWidth: 200 });
const nextText = (raw.endsWith('\n') ? raw : raw + '\n') + appendText;

// 4. 结构自检：追加后仍可解析，且条目数 = 旧 + 4。
let parsedNext;
try {
  parsedNext = yaml.load(nextText);
} catch (error) {
  fail('追加后的 YAML 无法解析（已中止）: ' + error.message);
}
if (!Array.isArray(parsedNext) || parsedNext.length !== entries.length + appendRows.length) {
  fail('追加后条目数校验失败（是否已有部署？）');
}
const newIds = parsedNext.slice(-4).map((entry) => entry && entry.id).filter(Boolean);
if (!newIds.includes('im-qqbot') || !newIds.includes('preset-chatonly')) {
  fail('追加结构校验失败: ' + JSON.stringify(newIds));
}

log('从 im-qqbot 解析凭据: appId=' + maskAppId(appId) + ', appSecret=' + maskSecret(appSecret));
if (dryRun) {
  log('dry-run：将追加以下配置（secret 已掩码，不写盘）');
  // 打印时再次脱敏，避免 secret 出现在终端/日志。
  const redacted = appendText
    .split(appSecret).join(maskSecret(appSecret))
    .split(appId).join(maskAppId(appId));
  console.log(redacted);
  process.exit(0);
}

// 5. 原子写：append-only overlay（供 dump-config 预演）+ 完整新 patch 临时文件。
try {
  fs.writeFileSync(appendFile, appendText, { mode: 0o600 });
  fs.writeFileSync(newFile, nextText, { mode: 0o600 });
  for (const file of [appendFile, newFile]) {
    const fd = fs.openSync(file, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }
} catch (error) {
  fail('写临时文件失败: ' + error.message);
}
log('临时文件已写入，等待 dump-config 预演');
NODE

if (( DRY_RUN )); then
  log "dry-run 完成：未修改 $PATCH"
  rm -f -- "$BACKUP" "$TMP_APPEND"
  TMP_APPEND=""
  TMP_NEW=""
  exit 0
fi

# ── dump-config 预演：用 append-only overlay 验证组合结果 ────
DUMP_OUT=$(mktemp "/tmp/dsh-qqbot-deploy-dump-XXXXXX.yml")
DUMP_ERR=$(mktemp "/tmp/dsh-qqbot-deploy-dump-XXXXXX.err")
chmod 600 "$DUMP_OUT" "$DUMP_ERR"
cleanup_dump() { rm -f -- "$DUMP_OUT" "$DUMP_ERR"; }
trap 'rc=$?; cleanup_dump; cleanup "$rc"' EXIT

log "dump-config 预演（DSH_HOME=$DSH_HOME_DIR）..."
if ! DSH_HOME="$DSH_HOME_DIR" "$DSH_BIN" --profile "$(basename -- "$PROFILE_DIR")" --patch "$TMP_APPEND" --dump-config >"$DUMP_OUT" 2>"$DUMP_ERR"; then
  sed -n '1,80p' "$DUMP_ERR" >&2 || true
  die "dump-config 预演失败，未写入 live 配置（备份保留: $BACKUP）"
fi

row_block() {
  awk -v want="- id: $1" '
    $0 == want { flag = 1; print; next }
    flag && /^[^ #]/ { exit }
    flag { print }
  ' "$DUMP_OUT"
}
PRECHECK=0
QROW=$(row_block qqbot-buddy)
if [[ -z "$QROW" ]] || ! grep -qF 'name: dsh-qqbot-buddy' <<<"$QROW"; then
  log "✗ 预演结果缺少 qqbot-buddy 行"
  PRECHECK=1
fi
if ! grep -qF 'id: qqbot-buddy' <<<"$(row_block preset-qqbot-buddy)"; then
  log "✗ 预演结果缺少 preset-qqbot-buddy 行"
  PRECHECK=1
fi
if ! grep -qF 'disabled: true' <<<"$(row_block im-qqbot)"; then
  log "✗ 预演结果中 im-qqbot 未停用"
  PRECHECK=1
fi
if ! grep -qF 'disabled: true' <<<"$(row_block preset-chatonly)"; then
  log "✗ 预演结果中 preset-chatonly 未停用"
  PRECHECK=1
fi
if grep -qF "$TMP_APPEND] patch: entry" "$DUMP_ERR"; then
  log "✗ 追加块存在无效 patch 目标:"
  grep -F "$TMP_APPEND] patch: entry" "$DUMP_ERR" >&2 || true
  PRECHECK=1
fi
if (( PRECHECK != 0 )); then
  die "部署预检失败，未写入 live 配置（备份保留: $BACKUP）"
fi
log "预演通过：qqbot-buddy / preset-qqbot-buddy 生效，im-qqbot / preset-chatonly 已停用"

# ── 原子替换 live patch ──────────────────────────────────────
log "写入 $PATCH ..."
if ! mv -f -- "$TMP_NEW" "$PATCH"; then
  die "替换 cordis.patch.yml 失败；备份仍在: $BACKUP"
fi
TMP_NEW=""
chmod 600 -- "$PATCH"

# 后验：内容必须可解析且包含部署标记。
if ! node --input-type=module - "$REPO_DIR" "$PROFILE_DIR" <<'NODE'
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const [repoDir, profileDir] = process.argv.slice(2);
const requireFromProfile = createRequire(path.join(profileDir, 'package.json'));
const yaml = requireFromProfile('js-yaml');
const raw = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
const entries = yaml.load(raw);
if (!Array.isArray(entries)) throw new Error('顶层不是数组');
if (!raw.includes('dsh-qqbot-buddy')) throw new Error('缺少 dsh-qqbot-buddy 标记');
const im = entries.filter((entry) => entry && entry.id === 'im-qqbot');
if (im.length < 2 || im[im.length - 1].disabled !== true) throw new Error('im-qqbot 未停用');
NODE
then
  log "后验失败，正在用备份恢复..."
  cp -p -- "$BACKUP" "$PATCH" || true
  die "部署后校验失败，已回滚到备份: $BACKUP"
fi

log "部署完成：$PATCH"
log "  - 已停用 im-qqbot / preset-chatonly"
log "  - 已插入 qqbot-buddy（凭据沿用原 im-qqbot）与 preset-qqbot-buddy"
log "  - 备份: $BACKUP"
log "  - 未重启任何进程：当前 dsh web pid=$LIVE_PID 仍在运行，配置在下次重启 dsh web 后生效"
log "  - 回滚命令: bash $SCRIPT_DIR/rollback.sh"