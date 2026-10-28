#!/usr/bin/env bash
# install-package.sh —— 把本插件打包成 tarball，并以「独立包」形式装进 profile。
#
# 与 install-local.sh 的区别：
# - install-local.sh 复制 repo 到 profile，适合源码改动后的快速同步；
# - 本脚本生成 dsh-qqbot-buddy-<version>.tgz，放进 <profile>/vendor/，
#   profile/package.json 依赖改成 file:./vendor/<tgz>，profile/node_modules 里是解包后的真实包。
#   之后即使 repo 被移动/删除，插件也能独立运行；卸载/更新走插件管理或重跑本脚本。
set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
STAMP=$(date +%Y%m%d-%H%M%S)
VERSION=$(cd "$REPO_DIR" && node -p "require('./package.json').version")

TMP_DIR=$(mktemp -d /tmp/qqb-pack.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[install-package] 打包 $VERSION ..."
(cd "$REPO_DIR" && npm pack --pack-destination "$TMP_DIR" >/dev/null)
TGZ="$TMP_DIR/dsh-qqbot-buddy-$VERSION.tgz"
[[ -f "$TGZ" ]] || { echo "[install-package] 打包失败：$TGZ 不存在" >&2; exit 1; }

mkdir -p "$PROFILE_DIR/vendor"
cp "$TGZ" "$PROFILE_DIR/vendor/dsh-qqbot-buddy-$VERSION.tgz"

# 备份 package.json
cp -p "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak-pkg-$STAMP"

node - "$PROFILE_DIR" "$VERSION" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [profileDir, version] = process.argv.slice(2);
const pkgPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
pkg.dependencies['dsh-qqbot-buddy'] = 'file:./vendor/dsh-qqbot-buddy-' + version + '.tgz';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', { mode: 0o600 });
console.log('[install-package] dependency -> ' + pkg.dependencies['dsh-qqbot-buddy']);
NODE

DEST="$PROFILE_DIR/node_modules/dsh-qqbot-buddy"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  mv "$DEST" "$DEST.bak-$STAMP"
fi
mkdir -p "$DEST"
tar -xzf "$PROFILE_DIR/vendor/dsh-qqbot-buddy-$VERSION.tgz" -C "$DEST" --strip-components=1
chmod -R u+rwX "$DEST"

echo "[install-package] 已解包到 $DEST"
echo "[install-package] 如需让运行中的 dsh 加载，请重启 dsh web（本脚本不会动进程）"
