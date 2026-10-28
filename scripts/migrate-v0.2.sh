#!/usr/bin/env bash
# migrate-v0.2.sh —— 迁移为不依赖官方 @tencent-connect/dsh-qqbot 的独立自用插件形态。
# 只改 profile package.json 与 cordis.patch.yml：不跑 pnpm、不动 node_modules、不重启进程。
#   1. 备份 package.json / cordis.patch.yml / pnpm-lock.yaml；
#   2. package.json 显式声明 4 个运行时依赖，移除官方插件依赖 + bundle；
#   3. patch 删除 im-qqbot / preset-chatonly / chatonly-* / 旧 qqbot-buddy 块，重建精简部署块；
#   4. 用临时 profile 做 dsh --dump-config 预演，通过后原子替换；失败自动恢复。
# 用法: bash scripts/migrate-v0.2.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
PROFILE_DIR=${PROFILE_DIR:-$HOME/.dsh/profiles/web}
DSH_BIN=${DSH_BIN:-$(command -v dsh || echo dsh)}
LIVE_CWD=${LIVE_CWD:-~/qqbot-workspace}
DRY_RUN=0
log() { printf "[migrate-v0.2] %s\n" "$*"; }
die() { printf "[migrate-v0.2] 错误: %s\n" "$*" >&2; exit 1; }

while (($# > 0)); do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n "2,10p" "$0"; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

command -v node >/dev/null 2>&1 || die "缺少 node"
[[ -d "$PROFILE_DIR" ]] || die "profile 目录不存在: $PROFILE_DIR"
[[ -f "$PROFILE_DIR/package.json" ]] || die "缺少 profile package.json"
[[ -f "$PROFILE_DIR/cordis.patch.yml" ]] || die "缺少 profile cordis.patch.yml"
[[ -d "$PROFILE_DIR/node_modules" ]] || die "缺少 profile node_modules"
[[ -x "$DSH_BIN" ]] || die "找不到可执行 dsh: $DSH_BIN"
[[ -f "$PROFILE_DIR/node_modules/dsh-qqbot-buddy/lib/index.js" ]] || die "插件未安装到 profile node_modules，请先执行 scripts/install-local.sh"

PROFILES_PARENT=$(dirname -- "$PROFILE_DIR")
[[ "$(basename -- "$PROFILES_PARENT")" == "profiles" ]] || die "无法从 $PROFILE_DIR 推导 DSH_HOME"
PROFILE_NAME=$(basename -- "$PROFILE_DIR")

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$PROFILE_DIR/.migrate-v0.2-$STAMP"
NEW_PKG="$PROFILE_DIR/.package.json.migrate-$STAMP"
NEW_PATCH="$PROFILE_DIR/.cordis.patch.yml.migrate-$STAMP"
CHECK_HOME=$(mktemp -d /tmp/qqb-migrate-home-XXXXXX)
DUMP_OUT=$(mktemp /tmp/qqb-migrate-dump-XXXXXX.yml)
DUMP_ERR=$(mktemp /tmp/qqb-migrate-dump-XXXXXX.err)
BACKUP_MADE=0

cleanup() {
  rc=$?
  rm -f -- "$NEW_PKG" "$NEW_PATCH" "$DUMP_OUT" "$DUMP_ERR"
  rm -rf -- "$CHECK_HOME"
  if [ "$rc" != "0" ] && [ "$BACKUP_MADE" = "1" ]; then
    log "失败，正在恢复迁移前配置..."
    cp -p -- "$BACKUP_DIR/package.json.bak" "$PROFILE_DIR/package.json" || true
    cp -p -- "$BACKUP_DIR/cordis.patch.yml.bak" "$PROFILE_DIR/cordis.patch.yml" || true
  fi
  exit $rc
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
cp -p -- "$PROFILE_DIR/package.json" "$BACKUP_DIR/package.json.bak"
cp -p -- "$PROFILE_DIR/cordis.patch.yml" "$BACKUP_DIR/cordis.patch.yml.bak"
if [ -f "$PROFILE_DIR/pnpm-lock.yaml" ]; then cp -p -- "$PROFILE_DIR/pnpm-lock.yaml" "$BACKUP_DIR/pnpm-lock.yaml.bak"; fi
chmod 600 "$BACKUP_DIR"/*.bak 2>/dev/null || true
BACKUP_MADE=1
log "备份目录: $BACKUP_DIR"

log "生成迁移后的 package.json / cordis.patch.yml ..."
node --input-type=module - "$REPO_DIR" "$PROFILE_DIR" "$LIVE_CWD" "$DRY_RUN" "$NEW_PKG" "$NEW_PATCH" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [repoDir, profileDir, liveCwd, dryRunRaw, newPkgFile, newPatchFile] = process.argv.slice(2);
const dryRun = dryRunRaw === '1';
const log = (m) => console.log('[migrate-v0.2] ' + m);
const fail = (m) => { console.error('[migrate-v0.2] 错误: ' + m); process.exit(1); };
const requireFromProfile = createRequire(path.join(profileDir, 'package.json'));
let yaml;
try { yaml = requireFromProfile('js-yaml'); } catch (e) { fail('profile node_modules 缺少 js-yaml: ' + e.message); }

const pkgPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
const SDK_DEPS = {
  '@tencent-connect/qqbot-nodejs': '^1.0.5',
  '@tencent-connect/qqbot-connector': '1.2.0',
  'js-yaml': '^4.1.0',
  'qrcode': '^1.5.4',
};
for (const [name, version] of Object.entries(SDK_DEPS)) {
  if (typeof pkg.dependencies[name] !== 'string' || pkg.dependencies[name].trim() === '') pkg.dependencies[name] = version;
}
delete pkg.dependencies['@tencent-connect/dsh-qqbot'];
const profileDsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : (pkg.dsh = {});
const profileMeta = profileDsh.profile && typeof profileDsh.profile === 'object' ? profileDsh.profile : (profileDsh.profile = {});
const bundles = Array.isArray(profileMeta.bundles) ? profileMeta.bundles : (profileMeta.bundles = []);
profileMeta.bundles = bundles.filter((n) => n !== '@tencent-connect/dsh-qqbot');

const patchPath = path.join(profileDir, 'cordis.patch.yml');
const raw = fs.readFileSync(patchPath, 'utf8');
let rows;
try { rows = yaml.load(raw); } catch (e) { fail('现有 cordis.patch.yml 不是合法 YAML: ' + e.message); }
if (!Array.isArray(rows)) fail('现有 cordis.patch.yml 顶层不是数组');

const DROP_INSERTS = new Set(['preset-chatonly', 'chatonly-admin', 'chatonly-ops', 'chatonly-diag', 'qqbot-buddy', 'preset-qqbot-buddy']);
const DROP_IDS = new Set(['im-qqbot', 'preset-chatonly']);
const creds = { appId: '', appSecret: '', cwd: liveCwd };
const kept = [];
const dropped = [];
for (const row of rows) {
  if (!row || typeof row !== 'object') { kept.push(row); continue; }
  if (typeof row.id === 'string' && DROP_IDS.has(row.id)) { dropped.push('id:' + row.id); continue; }
  if (Array.isArray(row.insert)) {
    const hit = row.insert.some((item) => item && typeof item === 'object' && DROP_INSERTS.has(item.id));
    if (hit) {
      for (const item of row.insert) {
        if (item && item.id === 'qqbot-buddy' && item.config && typeof item.config === 'object') {
          if (typeof item.config.appId === 'string' && item.config.appId.trim() !== '') creds.appId = item.config.appId;
          if (typeof item.config.appSecret === 'string' && item.config.appSecret.trim() !== '') creds.appSecret = item.config.appSecret;
          if (typeof item.config.cwd === 'string' && item.config.cwd.trim() !== '') creds.cwd = item.config.cwd;
        }
      }
      dropped.push('insert:' + row.insert.map((i) => (i && i.id) || '?').join(','));
      continue;
    }
  }
  kept.push(row);
}
if (creds.appId === '' || creds.appSecret === '') fail('无法从现有 patch 解析 qqbot-buddy 凭据（请确认部署块仍在）');

const repoRows = yaml.load(fs.readFileSync(path.join(repoDir, 'cordis.patch.yml'), 'utf8'));
if (!Array.isArray(repoRows)) fail('仓库 cordis.patch.yml 顶层不是数组');
const repoInserts = repoRows.flatMap((r) => (Array.isArray(r && r.insert) ? r.insert : []));
const presetRow = repoInserts.find((r) => r && r.id === 'preset-qqbot-buddy');
if (!presetRow) fail('仓库 cordis.patch.yml 缺少 preset-qqbot-buddy');

const pluginRow = {
  insert: [{
    id: 'qqbot-buddy',
    name: 'dsh-qqbot-buddy',
    config: {
      appId: creds.appId,
      appSecret: creds.appSecret,
      cwd: creds.cwd,
      preset: 'qqbot-buddy',
      autoStart: true,
    },
  }],
};
const presetInsert = { insert: [presetRow] };
const nextRows = [...kept, pluginRow, presetInsert];
const header = [
  '',
  '# ── dsh-qqbot-buddy v0.2 独立部署（scripts/migrate-v0.2.sh 生成于 ' + new Date().toISOString() + '）──',
  '# 不依赖官方 @tencent-connect/dsh-qqbot；凭据由 qqbot-buddy 条目持有，扫码绑定会原地更新。',
  '# 回滚：用 .migrate-v0.2-<时间戳>/ 下的备份恢复后重启 dsh web。',
  '',
].join('\n');
const nextPatch = header + yaml.dump(nextRows, { noRefs: true, lineWidth: -1 });

log('新增依赖: ' + Object.keys(SDK_DEPS).join(', '));
log('移除依赖/bundle: @tencent-connect/dsh-qqbot');
log('删除旧 patch 行: ' + (dropped.length ? dropped.join(' ; ') : '(无)'));
log('保留 patch 行: ' + kept.length + '，新增 2 行（qqbot-buddy + preset-qqbot-buddy）');
log('凭据: appId=' + creds.appId.slice(0, 4) + '***' + creds.appId.slice(-2) + ' / appSecret 已保留（不打印）');

if (dryRun) {
  console.log('');
  console.log('[migrate-v0.2] dry-run：迁移后新增块预览（secret 已掩码）');
  const preview = yaml.dump([pluginRow, presetInsert], { noRefs: true, lineWidth: -1 })
    .split(creds.appSecret).join('***');
  console.log(preview);
  process.exit(0);
}
fs.writeFileSync(newPkgFile, JSON.stringify(pkg, null, 2) + '\n', { mode: 0o600 });
fs.writeFileSync(newPatchFile, nextPatch, { mode: 0o600 });
NODE

if [ "$DRY_RUN" = "1" ]; then
  log "dry-run 完成：未修改 profile"
  BACKUP_MADE=0
  rm -rf -- "$BACKUP_DIR"
  trap - EXIT
  exit 0
fi

mkdir -p "$CHECK_HOME/profiles/$PROFILE_NAME"
cp -p -- "$NEW_PKG" "$CHECK_HOME/profiles/$PROFILE_NAME/package.json"
cp -p -- "$NEW_PATCH" "$CHECK_HOME/profiles/$PROFILE_NAME/cordis.patch.yml"
ln -s "$PROFILE_DIR/node_modules" "$CHECK_HOME/profiles/$PROFILE_NAME/node_modules"
log "dump-config 预演（临时 profile）..."
if ! DSH_HOME="$CHECK_HOME" "$DSH_BIN" --profile "$PROFILE_NAME" --dump-config >"$DUMP_OUT" 2>"$DUMP_ERR"; then
  sed -n "1,60p" "$DUMP_ERR" >&2 || true
  die "dump-config 预演失败，未修改 profile"
fi
grep -qF "name: dsh-qqbot-buddy" "$DUMP_OUT" || die "预演结果缺少 dsh-qqbot-buddy"
grep -qF "id: preset-qqbot-buddy" "$DUMP_OUT" || die "预演结果缺少 preset-qqbot-buddy"
if grep -qE "^- id: (im-qqbot|preset-chatonly)$" "$DUMP_OUT"; then
  echo "[migrate-v0.2] 调试：dump 命中行（前 12 行）：" >&2
  grep -nE "im-qqbot|preset-chatonly" "$DUMP_OUT" | sed -n "1,12p" >&2 || true
  echo "[migrate-v0.2] 调试：临时 package.json 命中：" >&2
  grep -nE "im-qqbot|dsh-qqbot" "$CHECK_HOME/profiles/$PROFILE_NAME/package.json" | sed -n "1,8p" >&2 || true
  echo "[migrate-v0.2] 调试：临时 patch 命中：" >&2
  grep -nE "im-qqbot|preset-chatonly" "$CHECK_HOME/profiles/$PROFILE_NAME/cordis.patch.yml" | sed -n "1,8p" >&2 || true
  die "预演结果仍包含 im-qqbot/preset-chatonly"
fi
if grep -qF "patch: entry \"im-qqbot\"" "$DUMP_ERR" || grep -qF "patch: entry \"preset-chatonly\"" "$DUMP_ERR"; then
  die "预演出现 im-qqbot/preset-chatonly 的 patch 目标警告"
fi
log "预演通过"

mv -f -- "$NEW_PKG" "$PROFILE_DIR/package.json"
mv -f -- "$NEW_PATCH" "$PROFILE_DIR/cordis.patch.yml"
chmod 600 -- "$PROFILE_DIR/cordis.patch.yml"
NEW_PKG=""; NEW_PATCH=""
node -e "const p=require('$PROFILE_DIR/package.json');const ok=!p.dependencies['@tencent-connect/dsh-qqbot']&&!p.dsh.profile.bundles.includes('@tencent-connect/dsh-qqbot');process.exit(ok?0:1)" || die "迁移后校验失败"
BACKUP_MADE=0
log "迁移完成：$PROFILE_DIR"
log "  - 4 个运行时依赖已显式声明；官方插件已从依赖与 bundle 移除"
log "  - patch 已清理并重建 qqbot-buddy / preset-qqbot-buddy"
log "  - 备份: $BACKUP_DIR"
log "  - 未重启任何进程；请重启 dsh web 生效"
log "  - 回滚: cp -p $BACKUP_DIR/package.json.bak $PROFILE_DIR/package.json && cp -p $BACKUP_DIR/cordis.patch.yml.bak $PROFILE_DIR/cordis.patch.yml ; 然后重启 dsh web"