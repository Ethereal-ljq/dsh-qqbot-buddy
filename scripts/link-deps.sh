#!/usr/bin/env bash
# link-deps.sh —— 当 profile 以 link: 方式安装本插件时，给 repo 建依赖软链。
#
# 背景：profile/package.json 里 `dsh-qqbot-buddy: link:~/project/dsh-qqbot-buddy`
# 会让 dsh 从 repo 加载插件；repo 若没有 node_modules，就会报
# `Cannot find package '@tencent-connect/qqbot-nodejs'`。
# 本脚本把依赖（QQ SDK / js-yaml / qrcode / @deepseek-ai/*）链接到 repo，
# 让 link 安装也能正常启动。可重复执行。
set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
HOST_NODE_MODULES="${DSH_HOST_NODE_MODULES:-$HOME/.dsh/profiles/node_modules}"

mkdir -p "$REPO_DIR/node_modules"

link_pkg() {
  local target="$1" name="$2"
  if [[ ! -e "$target" ]]; then
    echo "[link-deps] 跳过（不存在）: $target" >&2
    return 0
  fi
  ln -sfn "$target" "$REPO_DIR/node_modules/$name"
  echo "[link-deps] $name -> $target"
}

# 本插件直接依赖
link_pkg "$PROFILE_DIR/node_modules/@tencent-connect" "@tencent-connect"
link_pkg "$PROFILE_DIR/node_modules/js-yaml" "js-yaml"
link_pkg "$PROFILE_DIR/node_modules/qrcode" "qrcode"

# 宿主 peer 依赖（dsh-llm / dsh-session / schemastery 等）
link_pkg "$HOST_NODE_MODULES/@deepseek-ai" "@deepseek-ai"

echo "[link-deps] 完成。若 dsh 已启动，重启/重新加载插件后生效。"
