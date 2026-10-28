#!/usr/bin/env bash
# rollback.sh —— 恢复最近一次 deploy-live.sh 写入前的 profile cordis.patch.yml 备份。
#
# 行为：
#   - 默认恢复最新一份 cordis.patch.yml.bak-qqbot-buddy-*（带时间戳，含部署前凭据）；
#   - 恢复前先把"当前版本"另存为 cordis.patch.yml.bak-before-rollback-*，回滚也可逆；
#   - 原子替换（tmp + rename，0600）；
#   - 只改配置，不重启/不杀 dsh 进程（重启后生效）。
#
# 用法：
#   bash scripts/rollback.sh              # 恢复最新备份
#   bash scripts/rollback.sh --list       # 列出可用备份
#   bash scripts/rollback.sh <备份文件>    # 恢复指定备份
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROFILE_DIR=${PROFILE_DIR:-$HOME/.dsh/profiles/web}
PATCH="$PROFILE_DIR/cordis.patch.yml"
LIST=0
TARGET=""

log() { printf '[rollback] %s\n' "$*"; }
die() { printf '[rollback] 错误: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: bash scripts/rollback.sh [选项] [备份文件]

恢复 profiles 的 cordis.patch.yml（默认最新一次 deploy-live.sh 的备份）。

选项:
  --list             列出可用备份（按时间从旧到新）
  --profile DIR      DSH profile 目录（默认 $HOME/.dsh/profiles/web）
  -h, --help         显示本帮助

说明: 只恢复配置，不重启进程；恢复后需你自行重启 dsh web 才会生效。
EOF
}

while (($# > 0)); do
  case "$1" in
    --list|-l) LIST=1; shift ;;
    --profile) [[ $# -ge 2 ]] || die "--profile 需要目录"; PROFILE_DIR=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --*) die "未知参数: $1（-h 查看帮助）" ;;
    *) TARGET=$1; shift ;;
  esac
done

PATCH="$PROFILE_DIR/cordis.patch.yml"
[[ -d "$PROFILE_DIR" ]] || die "profile 目录不存在: $PROFILE_DIR"

shopt -s nullglob
BACKUPS=("$PATCH".bak-qqbot-buddy-*)
shopt -u nullglob

if (( ${#BACKUPS[@]} == 0 )); then
  die "没有找到备份（$PATCH.bak-qqbot-buddy-*）；本脚本只能恢复 deploy-live.sh 生成的备份"
fi

if (( LIST )); then
  log "可用备份（旧 → 新）:"
  for file in "${BACKUPS[@]}"; do
    size=$(stat -c '%s' "$file" 2>/dev/null || echo '?')
    mtime=$(date -d "@$(stat -c '%Y' "$file" 2>/dev/null || echo 0)" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '?')
    printf '  %s  (%s bytes, %s)\n' "$file" "$size" "$mtime"
  done
  printf '  最新备份: %s\n' "${BACKUPS[-1]}"
  exit 0
fi

# 选目标：默认最新（glob 结果按文件名升序，时间戳在文件名里）。
if [[ -z "$TARGET" ]]; then
  TARGET="${BACKUPS[-1]}"
  log "未指定备份文件，使用最新备份: $(basename -- "$TARGET")"
fi

[[ -f "$TARGET" ]] || die "备份文件不存在: $TARGET"
TARGET_DIR=$(cd -- "$(dirname -- "$TARGET")" && pwd)
PROFILE_ABS=$(cd -- "$PROFILE_DIR" && pwd)
[[ "$TARGET_DIR" == "$PROFILE_ABS" ]] || die "备份文件必须位于 profile 目录内: $TARGET"
BASE=$(basename -- "$TARGET")
case "$BASE" in
  cordis.patch.yml.bak-*) ;;
  *) die "备份文件名不符合预期（应以 cordis.patch.yml.bak- 开头）: $BASE" ;;
esac

# 恢复前保护当前版本，保证回滚本身可逆。
STAMP=$(date +%Y%m%d-%H%M%S-%3N)
SAFETY="$PATCH.bak-before-rollback-$STAMP"
if [[ -f "$PATCH" ]]; then
  cp -p -- "$PATCH" "$SAFETY"
  chmod 600 -- "$SAFETY"
  log "当前配置已另存: $SAFETY"
fi

# 原子恢复：先复制到同目录临时文件，再 rename 覆盖。
TMP="$PROFILE_DIR/.cordis.patch.yml.tmp-rollback.$STAMP"
cleanup() {
  local code=${1:-$?}
  trap - EXIT
  rm -f -- "$TMP"
  exit "$code"
}
trap cleanup EXIT

cp -p -- "$TARGET" "$TMP"
chmod 600 -- "$TMP"
if [[ ! -s "$TMP" ]]; then
  die "备份内容为空，拒绝恢复: $TARGET"
fi
mv -f -- "$TMP" "$PATCH"

# 轻量后验：恢复后的文件应仍有 YAML 数组特征。
if ! grep -q -- '- id:' "$PATCH"; then
  log "警告: 恢复后的 cordis.patch.yml 未包含 '- id:' 行，请人工检查"
fi

log "已恢复: $PATCH"
log "  来源备份: $TARGET"
log "  回滚前版本: $SAFETY"
log "  未重启任何进程；如需生效请自行重启 dsh web（脚本不会动 3080 实例）"
log "  验证命令: DSH_HOME=$(cd -- "$PROFILE_DIR/../.." && pwd) dsh --profile $(basename -- "$PROFILE_DIR") --dump-config | grep -E 'qqbot-buddy|im-qqbot'"
