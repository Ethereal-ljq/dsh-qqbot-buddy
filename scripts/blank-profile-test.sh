#!/usr/bin/env bash
# blank-profile-test.sh —— 在**真正空白**的 profile 里验证 dsh-qqbot-buddy。
#
# 与 test-profile.sh 的区别：那个把 live profile 软链进来（读只读），
# 本脚本用官方 web 模板生成一个**全新空白 profile**（只有 base + web-app 两个 bundle，
# 不带 market / image-gen / sidebar 等第三方插件），因此同时验证「独立安装可用」。
#
# 隔离原则：
#   - DSH_HOME 指向 /tmp 下临时目录，绝不读写 ~/.dsh；
#   - 只监听 3097，不碰 3080 的 live 实例；
#   - autoStart=false + bindOnMissingCredentials=false，绝不连接真实 QQ；
#   - 只用本地路径安装（link），不访问网络。
#
# 用法：
#   bash scripts/blank-profile-test.sh              # 跑完即清理
#   bash scripts/blank-profile-test.sh --keep       # 保留目录与日志
#   bash scripts/blank-profile-test.sh --port 3098  # 换端口
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
DSH_BIN=${DSH_BIN:-$(command -v dsh || echo dsh)}
# 安装源：默认用仓库源码；用 PKG_SPEC=<tgz 路径> 可验证发布产物本身
PKG_SPEC=${PKG_SPEC:-$REPO_DIR}

TESTHOME=${TESTHOME:-/tmp/dsh-blank-test}
PORT=3097
KEEP=0

while (($# > 0)); do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --port) [[ $# -ge 2 ]] || { echo "--port 需要端口号" >&2; exit 1; }; PORT=$2; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

[[ "$PORT" == "3080" ]] && { echo "禁止使用 3080（live 实例）" >&2; exit 1; }

WORK="${TESTHOME}-work"
STATE="$WORK/state"
CWD="$WORK/cwd"
OVERLAY="$WORK/overlay.yml"
LOG="$WORK/web.log"
PROBE_OUT="$STATE/capability-probe.json"

log() { printf '[blank-test] %s\n' "$*"; }
cleanup() {
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  if [[ "$KEEP" == "0" ]]; then rm -rf "$TESTHOME" "$WORK"; fi
}
trap cleanup EXIT

log "清理旧环境 ($TESTHOME)"
rm -rf "$TESTHOME" "$WORK"
mkdir -p "$TESTHOME" "$CWD" "$STATE"

export DSH_HOME="$TESTHOME"

# ── 1. 生成空白 profile（官方 web 模板，只含 base + web-app） ────────────
log "1/5 从官方模板生成空白 profile"
"$DSH_BIN" --profile blank --from-default-profile web --dump-config > "$WORK/dump0.yml" 2>"$WORK/dump0.err"

BUNDLES=$(node -e "const p=require('$TESTHOME/profiles/blank/package.json'); console.log(p.dsh.profile.bundles.join(','))")
log "     bundles = $BUNDLES"
case "$BUNDLES" in
  *dsh-market*|*image-gen*|*sidebar*) echo "profile 不是空白（含第三方 bundle）" >&2; exit 1 ;;
esac

# ── 2. 安装插件（本地路径；dsh plugin add 会自动登记 bundle） ────────────
log "2/5 安装插件到空白 profile（源: $PKG_SPEC）"
"$DSH_BIN" plugin --profile blank add "$PKG_SPEC" > "$WORK/install.log" 2>&1 || {
  echo "安装失败：" >&2; tail -20 "$WORK/install.log" >&2; exit 1;
}

REGISTERED=$(node -e "const p=require('$TESTHOME/profiles/blank/package.json'); console.log(p.dsh.profile.bundles.includes('dsh-qqbot-buddy')?'yes':'no')")
[[ "$REGISTERED" == "yes" ]] || { echo "插件未登记进 dsh.profile.bundles" >&2; exit 1; }

# ── 3. dump-config 组合校验 ─────────────────────────────────────────────
log "3/5 组合校验"
cat > "$OVERLAY" <<'YAML'
- id: qqbot-buddy
  config:
    cwd: __CWD__
    stateDir: __STATE__
    mediaDir: __MEDIA__
    preset: qqbot-buddy
    autoStart: false
    bindOnMissingCredentials: false
    appId: ''
    appSecret: ''
- insert:
    - id: qa-capability-probe
      name: __PROBE__
      config:
        outFile: __OUT__
        pluginEntry: __ENTRY__
YAML
ENTRY="$TESTHOME/profiles/blank/node_modules/dsh-qqbot-buddy/lib/index.js"
sed -i "s#__CWD__#$CWD#g; s#__STATE__#$STATE#g; s#__MEDIA__#$WORK/media#g; s#__PROBE__#$REPO_DIR/test/e2e/capability-probe.js#g; s#__OUT__#$PROBE_OUT#g; s#__ENTRY__#$ENTRY#g" "$OVERLAY"
mkdir -p "$WORK/media"

"$DSH_BIN" blank --patch "$OVERLAY" --dump-config > "$WORK/dump1.yml" 2>"$WORK/dump1.err"
grep -q 'qqbot-buddy' "$WORK/dump1.yml" || { echo "组合里没有 qqbot-buddy" >&2; exit 1; }
grep -q 'qa-capability-probe' "$WORK/dump1.yml" || { echo "组合里没有探针" >&2; exit 1; }
log "     qqbot-buddy + preset + 探针均已进入插件树"

# ── 4. 启动隔离实例并等探针结果 ─────────────────────────────────────────
log "4/5 启动隔离实例 127.0.0.1:$PORT"
(cd "$CWD" && exec "$DSH_BIN" blank --patch "$OVERLAY" --port "$PORT" --no-open > "$LOG" 2>&1) &
PID=$!

for _ in $(seq 1 120); do
  [[ -f "$PROBE_OUT" ]] && break
  kill -0 "$PID" 2>/dev/null || { echo "实例提前退出：" >&2; tail -30 "$LOG" >&2; exit 1; }
  sleep 1
done
[[ -f "$PROBE_OUT" ]] || { echo "探针超时（120s）" >&2; tail -30 "$LOG" >&2; exit 1; }

# ── 5. 断言 ─────────────────────────────────────────────────────────────
log "5/5 断言"
node -e '
const d = require(process.argv[1]);
if (!d.ok) {
  console.error("探针失败 " + d.failed + "/" + d.total + (d.fatal ? " fatal=" + d.fatal : ""));
  for (const r of d.results) if (!r.ok) console.error("  FAIL " + r.label + " — " + r.error);
  process.exit(1);
}
for (const r of d.results) console.log("  PASS " + r.label);
console.log("  (" + d.total + " 项全部通过)");
' "$PROBE_OUT"

TOKEN=$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG" | head -1 | cut -d= -f2 || true)
# 探针会主动结束进程，所以 HTTP 面单独起一次不带探针的实例来验收（同一空白 profile）。
if [[ -n "$TOKEN" ]]; then
  log "5.5 HTTP 验收（不带探针重启同一 profile）"
  kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true
  grep -v 'qa-capability-probe' "$OVERLAY" | sed '/^- insert:/,/^        pluginEntry:/d' > "$WORK/overlay-http.yml"
  (cd "$CWD" && exec "$DSH_BIN" blank --patch "$WORK/overlay-http.yml" --port "$PORT" --no-open > "$WORK/web-http.log" 2>&1) &
  PID=$!
  for _ in $(seq 1 60); do
    grep -q "http://127.0.0.1:$PORT" "$WORK/web-http.log" 2>/dev/null && break
    kill -0 "$PID" 2>/dev/null || { echo "HTTP 实例提前退出：" >&2; tail -20 "$WORK/web-http.log" >&2; exit 1; }
    sleep 1
  done
  TOKEN2=$(grep -o 'token=[A-Za-z0-9_-]*' "$WORK/web-http.log" | head -1 | cut -d= -f2 || true)
  # dsh 的 API 要浏览器 cookie 信任：先访问带 token 的根路径换 cookie
  curl -s -c "$WORK/cookies.txt" -o /dev/null "http://127.0.0.1:$PORT/?token=$TOKEN2" || true
  CODE=$(curl -s -b "$WORK/cookies.txt" -o "$WORK/tools.json" -w '%{http_code}' "http://127.0.0.1:$PORT/qqbot-buddy/api/tools" || echo 000)
  [[ "$CODE" == "200" ]] || { echo "GET /api/tools 返回 $CODE" >&2; exit 1; }
  node -e '
  const d = require(process.argv[1]);
  if (!d.ok || !Array.isArray(d.capabilities)) { console.error("  FAIL /api/tools 返回异常"); process.exit(1); }
  console.log("  PASS GET /api/tools（能力 " + d.capabilities.length + " 项，放行 " + d.allow.length + " 个工具）");
  ' "$WORK/tools.json"
  SCHEMA_CODE=$(curl -s -b "$WORK/cookies.txt" -o "$WORK/schema.json" -w '%{http_code}' "http://127.0.0.1:$PORT/qqbot-buddy/api/schema" || echo 000)
  [[ "$SCHEMA_CODE" == "200" ]] || { echo "GET /api/schema 返回 $SCHEMA_CODE" >&2; exit 1; }
  node -e '
  const s = require(process.argv[1]);
  const pages = (s.sections || []).reduce((n, x) => n + (x.items || []).length, 0);
  if (!Array.isArray(s.groups) || s.groups.length < 4 || pages < 10) { console.error("  FAIL /api/schema 结构异常"); process.exit(1); }
  console.log("  PASS GET /api/schema（" + s.groups.length + " 个工作区 / " + pages + " 个页面）");
  ' "$WORK/schema.json"
  STATE_CODE=$(curl -s -b "$WORK/cookies.txt" -o "$WORK/state.json" -w '%{http_code}' "http://127.0.0.1:$PORT/qqbot-buddy/api/state" || echo 000)
  [[ "$STATE_CODE" == "200" ]] || { echo "GET /api/state 返回 $STATE_CODE" >&2; exit 1; }
  node -e '
  const s = require(process.argv[1]);
  const freq = s.settings && s.settings.stickers ? s.settings.stickers.frequency : undefined;
  if (freq !== "normal") { console.error("  FAIL settings.stickers.frequency 默认应为 normal，实际 " + freq); process.exit(1); }
  console.log("  PASS GET /api/state（stickers.frequency=" + freq + "）");
  ' "$WORK/state.json"
fi

log "全部通过 ✅"
[[ "$KEEP" == "1" ]] && log "保留目录: $TESTHOME / $WORK"