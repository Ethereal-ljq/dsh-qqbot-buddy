#!/usr/bin/env bash
# install-local.sh —— 把本仓库同步到 DSH profile 的 node_modules（开发/灰度用）。
#
# 只写 <profile>/node_modules/<包名> 一个目录：
#   - 绝不修改 profile 的 package.json / cordis.patch.yml / cordis.yml；
#   - 幂等：内容无变化时 rsync 不会重写文件（可反复执行）。
# 用法：
#   bash scripts/install-local.sh [--dry-run] [--src DIR] [--profile DIR]
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEFAULT_SRC=$(cd -- "$SCRIPT_DIR/.." && pwd)
SRC=${SRC:-$DEFAULT_SRC}
PROFILE_DIR=${PROFILE_DIR:-$HOME/.dsh/profiles/web}
DRY_RUN=0

log() { printf '[install-local] %s\n' "$*"; }
die() { printf '[install-local] 错误: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: bash scripts/install-local.sh [选项]

把本仓库复制到 DSH profile 的 node_modules/<包名>（默认 dsh-qqbot-buddy）。
不修改 package.json / cordis.patch.yml，不重启 dsh 进程。

选项:
  --dry-run          只显示将要同步的文件，不写磁盘
  --src DIR          源仓库目录（默认脚本所在仓库根目录）
  --profile DIR      DSH profile 目录（默认 $HOME/.dsh/profiles/web）
  -h, --help         显示本帮助

环境变量: SRC、PROFILE_DIR 等价于对应选项。
EOF
}

while (($# > 0)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --src) [[ $# -ge 2 ]] || die "--src 需要目录参数"; SRC=$2; shift 2 ;;
    --profile) [[ $# -ge 2 ]] || die "--profile 需要目录参数"; PROFILE_DIR=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（-h 查看帮助）" ;;
  esac
done

# ── 预检 ──────────────────────────────────────────────────────
command -v rsync >/dev/null 2>&1 || die "缺少 rsync"
command -v node >/dev/null 2>&1 || die "缺少 node（用于读取包元数据）"
[[ -d "$SRC" ]] || die "源目录不存在: $SRC"
[[ -f "$SRC/package.json" ]] || die "源目录缺少 package.json: $SRC"
[[ -d "$PROFILE_DIR" ]] || die "profile 目录不存在: $PROFILE_DIR"
[[ -f "$PROFILE_DIR/package.json" ]] || die "profile 缺少 package.json（路径不对？）: $PROFILE_DIR"
[[ -d "$PROFILE_DIR/node_modules" ]] || die "profile 缺少 node_modules: $PROFILE_DIR/node_modules"

# 读取包名/版本（用 node 解析，避免手写 jq 依赖）。
PKG_INFO=$(node -e '
  const p = require(process.argv[1]);
  if (!p || typeof p.name !== "string" || p.name === "") { process.exit(2); }
  process.stdout.write(p.name + " " + (p.version || "0.0.0"));
' "$SRC/package.json") || die "无法解析 $SRC/package.json 的 name/version"
read -r PKG_NAME PKG_VERSION <<< "$PKG_INFO"
[[ -n "${PKG_NAME:-}" ]] || die "包名为空"

DEST="$PROFILE_DIR/node_modules/$PKG_NAME"
# 如果曾是 pnpm 安装/symlink（例如跑过 pnpm install），先移除链接，再按“复制安装”覆盖，
# 保证插件从 profile/node_modules 内的真实目录加载（否则 @tencent-connect 等依赖解析不到）。
if [[ -L "$DEST" ]]; then
  log "目标 $DEST 是符号链接，先移除后按复制安装"
  rm -f -- "$DEST"
fi

# 记录受保护文件的哈希，同步后校验没被动过。
hash_of() { [[ -f "$1" ]] && sha256sum "$1" | awk '{print $1}' || echo "missing"; }
PATCH_BEFORE=$(hash_of "$PROFILE_DIR/cordis.patch.yml")
PKG_BEFORE=$(hash_of "$PROFILE_DIR/package.json")

RSYNC_OPTS=(
  -a                                  # 保留权限/时间戳/符号链接
  --delete                            # 目标目录严格等于源（清掉已删除文件）
  --itemize-changes
  --exclude='/.git/'                 # 版本库元数据
  --exclude='/node_modules/'         # 不复制依赖（profile 里有）
  --exclude='/test/artifacts/'       # 测试截图/产物
  --exclude='/test/e2e/artifacts/'
  --exclude='*.tmp-*'                # 原子写残留
  --exclude='.DS_Store'
)

mkdir -p "$PROFILE_DIR/node_modules"
log "源目录   : $SRC"
log "目标目录 : $DEST"
log "版本     : $PKG_NAME@$PKG_VERSION"

CHANGES=""
if (( DRY_RUN )); then
  log "dry-run：以下文件将被同步（不写磁盘）"
  rsync "${RSYNC_OPTS[@]}" --dry-run "$SRC/" "$DEST/"
  log "dry-run 完成，未修改任何文件"
  exit 0
fi

if ! CHANGES=$(rsync "${RSYNC_OPTS[@]}" "$SRC/" "$DEST/"); then
  die "rsync 同步失败"
fi

# 统计文件数/体积（同时确认目标目录存在）。
FILE_COUNT=$(find "$DEST" -type f | wc -l | tr -d ' ')
SIZE=$(du -sh "$DEST" 2>/dev/null | awk '{print $1}')
CHANGED_COUNT=$(printf '%s\n' "$CHANGES" | grep -cE '^[<>ch*]' || true)
# 注意：grep -c 无匹配时返回 1，上面的 || true 已兜底；这里再保证是纯数字。
CHANGED_COUNT=${CHANGED_COUNT:-0}

# 校验受保护文件未被修改。
PATCH_AFTER=$(hash_of "$PROFILE_DIR/cordis.patch.yml")
PKG_AFTER=$(hash_of "$PROFILE_DIR/package.json")
if [[ "$PATCH_BEFORE" != "$PATCH_AFTER" || "$PKG_BEFORE" != "$PKG_AFTER" ]]; then
  die "检测到 profile 的 cordis.patch.yml / package.json 被改动（本脚本不应写它们），请人工检查"
fi

log "同步完成：$FILE_COUNT 个文件，$SIZE"
if (( CHANGED_COUNT == 0 )); then
  log "内容无变化（幂等：重复执行不会产生改动）"
else
  log "本次变更条目数: $CHANGED_COUNT"
fi
log "已确认未修改 package.json / cordis.patch.yml"
log "提示：插件已就位；如需让运行中的 dsh 加载，需自行重启 dsh web（本脚本不会动任何进程）"