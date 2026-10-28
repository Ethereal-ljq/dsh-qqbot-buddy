/**
 * binding/persist —— QQ 凭据持久化：读写 dsh profile 的 cordis.patch.yml。
 *
 * 目标条目 id 固定为 `qqbot-buddy`，必须同时兼容两种 patch 形态：
 *   1) 顶层条目：`- id: qqbot-buddy\n    config: {...}`
 *   2) insert 内嵌（当前 live 部署形态）：
 *      `- insert:\n    - id: qqbot-buddy\n      name: dsh-qqbot-buddy\n      config: {...}`
 *
 * 安全约束（DESIGN「绑定服务契约」）：
 * - 用 js-yaml 解析 → 修改 → dump 回写，输出始终是合法 YAML；
 * - 只改目标条目的 config.appId / config.appSecret，其余条目与其它 config 键原样保留；
 * - 写前在同目录留 `cordis.patch.yml.bak-bind-<ts>`（0600）；
 * - 原子写：同目录 tmp + fsync + rename，最终权限 0600；
 * - 解析失败 / 结构异常 / 凭据不完整时拒绝写入（抛可读 Error），绝不覆盖原文件；
 * - 只写目标 patch 文件（及其 .bak 备份），不碰 profile 里任何其它文件；
 * - 语义未变化（幂等写入）时不落盘，避免无意义的 mtime 变化与 HMR 重载。
 *
 * 注意：js-yaml dump 会丢失原文件注释并重排格式（语义不变）。备份文件保留原样，
 * 需要回滚注释时从 .bak-bind-* 恢复；这也是 DESIGN 指定「parse→modify→dump」的已知代价。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

/** patch 文件名（profile 根目录下）。 */
export const PATCH_FILENAME = 'cordis.patch.yml';
/** 本插件在 patch 中的条目 id。 */
export const PROFILE_ENTRY_ID = 'qqbot-buddy';

/** dump 选项：不折行（长 appId/secret/URL 保持一行），不生成锚点引用。 */
const YAML_DUMP_OPTIONS = { lineWidth: -1, noRefs: true };
/** 自动生成文件时写入的表头注释。 */
const FILE_HEADER = '# QQ 机器人凭据（扫码/手动绑定由 dsh-qqbot-buddy 自动维护）\n';

/** 备份序号：同一毫秒内多次写盘的唯一性兜底。 */
let backupSeq = 0;

function errText(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析 profile 目录并返回 patch 绝对路径。
 * profile 目录必须已存在（避免把写错的路径当成新目录凭空创建）。
 */
function resolvePatchPath(profileDir) {
  const raw = typeof profileDir === 'string' ? profileDir.trim() : '';
  if (raw === '') {
    throw new Error('未提供 profile 目录，无法读写 ' + PATCH_FILENAME);
  }
  const dir = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error('profile 目录不存在：' + dir);
  }
  if (!stat.isDirectory()) {
    throw new Error('profile 路径不是目录：' + dir);
  }
  return path.join(dir, PATCH_FILENAME);
}

/**
 * 解析 patch 文本为顶层条目数组。
 *
 * - 空文件 / 仅注释 → []（允许安全重建）；
 * - 顶层非数组 → 抛错（拒绝写入，保留原文件）；
 * - YAML 语法错误 → 抛错。
 */
function parsePatchEntries(raw, patchPath) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (error) {
    throw new Error('解析 ' + patchPath + ' 失败（YAML 语法错误）：' + errText(error));
  }
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(
      patchPath + ' 顶层必须是 YAML 数组（实际为 ' + typeof parsed + '），拒绝写入以保留原文件',
    );
  }
  return parsed;
}

/** 读取并解析 patch；文件不存在时返回空条目（允许首次创建）。 */
function readEntries(patchPath) {
  let raw;
  try {
    raw = fs.readFileSync(patchPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { entries: [], existed: false };
    throw new Error('读取 ' + patchPath + ' 失败：' + errText(error));
  }
  return { entries: parsePatchEntries(raw, patchPath), existed: true };
}

/**
 * 在条目数组里找出所有 qqbot-buddy 目标条目（顶层 id 形态 + insert 内嵌形态）。
 * 结构异常（insert 不是数组）时抛错拒绝写入。
 *
 * 注意：只认 `insert: [ ... ]` 这一层内嵌；preset config.plugins 里的同名 id
 * 不属于部署条目，不匹配也不修改。
 */
function findTargets(entries, patchPath) {
  const targets = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) continue; // 保留未知形态（如纯字符串行），不做修改
    if (entry.id === PROFILE_ENTRY_ID) {
      targets.push(entry);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'insert')) continue;
    if (!Array.isArray(entry.insert)) {
      throw new Error(
        patchPath + ' 中存在 insert 字段但不是数组的条目，结构异常，拒绝写入以保留原文件',
      );
    }
    for (const item of entry.insert) {
      if (isPlainObject(item) && item.id === PROFILE_ENTRY_ID) targets.push(item);
    }
  }
  return targets;
}

/**
 * 取（必要时创建）目标条目的 config 对象。
 * config 存在但不是对象 → 结构异常，拒绝写入。
 */
function ensureConfig(holder, patchPath) {
  if (holder.config === undefined || holder.config === null) {
    holder.config = {};
    return holder.config;
  }
  if (!isPlainObject(holder.config)) {
    throw new Error(
      patchPath + ' 中 id=' + PROFILE_ENTRY_ID + ' 条目的 config 不是对象，结构异常，拒绝写入',
    );
  }
  return holder.config;
}

/** 生成同目录备份文件名：cordis.patch.yml.bak-bind-<ts>（冲突时追加序号）。 */
function nextBackupPath(dir) {
  const stamp = Date.now() + '-' + (++backupSeq);
  return path.join(dir, PATCH_FILENAME + '.bak-bind-' + stamp);
}

/**
 * 原子写入 patch：
 *   1) 原文件存在则先写 0600 备份（失败则整体放弃）；
 *   2) 同目录 tmp（wx + 0600）写入 → fchmod → fsync → rename 覆盖；
 *   3) 失败清理 tmp，原文件保持不变；
 *   4) best-effort fsync 目录，保证 rename 落盘。
 *
 * @returns {string|null} 备份文件绝对路径（原文件不存在时为 null）
 */
function writeAtomic(patchPath, content) {
  const dir = path.dirname(patchPath);
  let existing = null;
  try {
    existing = fs.readFileSync(patchPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw new Error('备份前读取 ' + patchPath + ' 失败：' + errText(error));
    }
  }

  let backupPath = null;
  if (existing !== null) {
    backupPath = nextBackupPath(dir);
    try {
      fs.writeFileSync(backupPath, existing, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(backupPath, 0o600);
    } catch (error) {
      throw new Error('写入备份 ' + backupPath + ' 失败：' + errText(error));
    }
  }

  const tmpPath = path.join(dir, '.' + PATCH_FILENAME + '.tmp-bind-' + Date.now() + '-' + process.pid);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, patchPath);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw new Error('写入 ' + patchPath + ' 失败：' + errText(error));
  }

  // rename 落盘（best-effort：部分文件系统不支持目录 fsync，失败不影响写入结果）
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* ignore */
  }

  return backupPath;
}

/** 序列化为最终文件内容。 */
function serialize(entries) {
  return FILE_HEADER + yaml.dump(entries, YAML_DUMP_OPTIONS);
}

/**
 * 把凭据写入 profile 的 cordis.patch.yml（保留该条目其它 config 键）。
 *
 * @param {string} profileDir dsh profile 目录
 * @param {{appId: string, appSecret: string}} credentials
 * @returns {{ok: true, changed: boolean, path: string, backup: string|null}}
 * @throws {Error} 解析失败 / 结构异常 / 凭据不完整 / 写盘失败时抛出可读错误（原文件保持不变）
 */
export function updateCredentials(profileDir, credentials) {
  const patchPath = resolvePatchPath(profileDir);
  const source = isPlainObject(credentials) ? credentials : {};
  const appId = typeof source.appId === 'string' ? source.appId.trim() : '';
  const appSecret = typeof source.appSecret === 'string' ? source.appSecret.trim() : '';
  if (appId === '' || appSecret === '') {
    throw new Error('凭据不完整：appId / appSecret 均不能为空');
  }

  const { entries } = readEntries(patchPath);
  // 「修改前」快照：dump 后比较，语义相同（含幂等重复提交）时不落盘
  const beforeDump = yaml.dump(entries, YAML_DUMP_OPTIONS);

  const targets = findTargets(entries, patchPath);
  if (targets.length === 0) {
    // 条目不存在时追加顶层 id patch（dsh 会按 id 合并到已插入的插件实例上）
    entries.push({ id: PROFILE_ENTRY_ID, config: { appId, appSecret } });
  } else {
    for (const target of targets) {
      const config = ensureConfig(target, patchPath);
      config.appId = appId;
      config.appSecret = appSecret;
    }
  }

  const afterDump = yaml.dump(entries, YAML_DUMP_OPTIONS);
  if (afterDump === beforeDump) {
    return { ok: true, changed: false, path: patchPath, backup: null };
  }
  const backup = writeAtomic(patchPath, serialize(entries));
  return { ok: true, changed: true, path: patchPath, backup };
}

/**
 * 从 profile 的 cordis.patch.yml 删除 qqbot-buddy 条目的 appId/appSecret（解绑）。
 *
 * - 只删这两个字段，保留条目其它 config（cwd / preset / requireMention …）；
 * - 文件不存在 / 条目不存在 / 字段本就不存在 → 幂等成功且不落盘；
 * - 解析失败 / 结构异常 → 抛可读错误，原文件保持不变。
 *
 * @returns {{ok: true, changed: boolean, path: string, backup: string|null}}
 */
export function removeCredentials(profileDir) {
  const patchPath = resolvePatchPath(profileDir);
  const { entries, existed } = readEntries(patchPath);
  if (!existed) {
    return { ok: true, changed: false, path: patchPath, backup: null };
  }

  const beforeDump = yaml.dump(entries, YAML_DUMP_OPTIONS);
  const targets = findTargets(entries, patchPath);
  for (const target of targets) {
    if (!isPlainObject(target.config)) continue; // 无 config 或形态异常：无需删除
    delete target.config.appId;
    delete target.config.appSecret;
  }

  const afterDump = yaml.dump(entries, YAML_DUMP_OPTIONS);
  if (afterDump === beforeDump) {
    return { ok: true, changed: false, path: patchPath, backup: null };
  }
  const backup = writeAtomic(patchPath, serialize(entries));
  return { ok: true, changed: true, path: patchPath, backup };
}

/**
 * 定位 dsh profile 目录（供 index.js 装配 runtime.profileDir 用）。
 *
 * 从本文件位置向上查找「同时含 cordis.patch.yml 与 node_modules 的目录」：
 * - live 安装（<profile>/node_modules/dsh-qqbot-buddy/lib/binding/…）→ 命中 profile；
 * - 开发仓库（仓库自带 bundle 用 cordis.patch.yml，但没有 node_modules）→ 不会误判，
 *   继续向上找不到则返回 undefined（调用方应明确「无 profile」并降级）。
 *
 * @param {string} [startDir] 起始目录；省略时从本文件所在包根目录开始
 * @returns {string|undefined} profile 绝对路径
 */
export function detectProfileDir(startDir) {
  let dir;
  try {
    if (typeof startDir === 'string' && startDir.trim() !== '') {
      dir = path.resolve(startDir.trim());
    } else {
      dir = fileURLToPath(new URL('../../', import.meta.url));
    }
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      if (
        fs.existsSync(path.join(dir, PATCH_FILENAME)) &&
        fs.statSync(path.join(dir, 'node_modules')).isDirectory()
      ) {
        return dir;
      }
    } catch {
      /* 权限等异常按未命中处理，继续向上 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export default { updateCredentials, removeCredentials, detectProfileDir };
