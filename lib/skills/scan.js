/**
 * scan —— 技能扫描与过滤（纯函数，无 cordis 依赖，方便单测）。
 *
 * 为什么插件要自己扫：宿主 @deepseek-ai/dsh-skill-filesystem 只提供
 * includeDefaultRoots / customSkillDirs，**没有按名过滤**；而 QQ 场景需要
 * 「~/.dsh/skills 里哪些技能该进群聊」这一层。技能发现本身就是一个插件，
 * 所以这里按宿主公开的 provider 契约自己实现一个，不改宿主、不污染目录。
 *
 * 与宿主的对齐点（读 dsh-skill-filesystem 源码确认）：
 *   - 根目录只扫描一层：<root>/<name>/SKILL.md 或 <root>/<name>.md；
 *   - frontmatter 必填 name(kebab-case) + description；
 *   - disable-model-invocation -> modelInvocable=false；user-invocable=false -> userInvocable=false；
 *   - rank 排序与宿主一致（project-dsh 100 / project-agents 200 / custom 300 / user-dsh 400 / user-agents 500）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';

/** 与宿主 dsh-skill 完全一致的 skill 名规范。 */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 根目录来源与优先级（数值越小越优先）。 */
export const ROOT_RANKS = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
};

function expandHome(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

/** 找项目根：最近的含 .git 的祖先，否则用 cwd（与宿主一致）。 */
export function findProjectRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd || process.cwd());
    dir = parent;
  }
}

/**
 * 解析要扫描的根目录列表。
 * @param {object} options
 * @param {string} [options.cwd] 会话 cwd（决定 project 根）
 * @param {string} [options.dshHome] ~/.dsh
 * @param {string} [options.agentsHome] ~/.agents
 * @param {string[]} [options.customSkillDirs] 额外根目录
 * @param {boolean} [options.includeDefaultRoots] 是否含 project/user 根
 * @returns {{path:string, source:string, rank:number}[]}
 */
export function resolveSkillRoots({ cwd, dshHome, agentsHome, customSkillDirs, includeDefaultRoots = true } = {}) {
  const roots = [];
  if (includeDefaultRoots) {
    const projectRoot = findProjectRoot(cwd);
    roots.push({ path: path.join(projectRoot, '.dsh', 'skills'), source: 'project-dsh', rank: ROOT_RANKS['project-dsh'] });
    roots.push({ path: path.join(projectRoot, '.agents', 'skills'), source: 'project-agents', rank: ROOT_RANKS['project-agents'] });
  }
  for (const dir of Array.isArray(customSkillDirs) ? customSkillDirs : []) {
    const resolved = expandHome(dir);
    if (resolved !== '') roots.push({ path: path.resolve(resolved), source: 'custom', rank: ROOT_RANKS.custom });
  }
  if (includeDefaultRoots) {
    const home = expandHome(dshHome) || path.join(os.homedir(), '.dsh');
    const agents = expandHome(agentsHome) || path.join(os.homedir(), '.agents');
    roots.push({ path: path.join(home, 'skills'), source: 'user-dsh', rank: ROOT_RANKS['user-dsh'] });
    roots.push({ path: path.join(agents, 'skills'), source: 'user-agents', rank: ROOT_RANKS['user-agents'] });
  }
  return roots;
}

/** frontmatter 布尔解析：兼容 true/false、yes/no、on/off、1/0（大小写不敏感）。 */
function frontmatterBoolean(data, key) {
  const raw = data && data[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  throw new Error('invalid boolean for ' + key + ': ' + JSON.stringify(raw));
}

/** 拆分 YAML frontmatter 与正文；无 frontmatter 返回 null。 */
export function splitFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const header = text.slice(4, end);
  let body = text.slice(end + 4);
  if (body.startsWith('\n')) body = body.slice(1);
  let data;
  try {
    data = yaml.load(header);
  } catch (err) {
    throw new Error('frontmatter YAML 解析失败: ' + (err && err.message ? err.message : String(err)));
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter 不是映射');
  return { data, content: body };
}

/**
 * 从 frontmatter 抽出 skill 元数据；不合法返回 null（与宿主「跳过并警告」一致）。
 * @returns {{name:string, description:string, whenToUse?:string, invocation:object, metadata?:object}|null}
 */
export function readSkillMeta(data) {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!SKILL_NAME.test(name)) return null;
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (description === '') return null;
  const whenToUse = typeof data.whenToUse === 'string' && data.whenToUse.trim() !== '' ? data.whenToUse.trim() : undefined;
  let disableModelInvocation;
  let userInvocable;
  try {
    disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation');
    userInvocable = frontmatterBoolean(data, 'user-invocable');
  } catch {
    return null;
  }
  const meta = {
    name: name,
    description: description,
    invocation: {
      modelInvocable: disableModelInvocation !== true,
      userInvocable: userInvocable !== false,
    },
  };
  if (whenToUse !== undefined) meta.whenToUse = whenToUse;
  if (data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)) meta.metadata = data.metadata;
  return meta;
}

/**
 * 扫描单个根目录（只扫一层，与宿主一致）。
 * @returns {{candidate:object, locator:object}[]}
 */
export function scanRoot(root, providerName, warn = () => {}) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root.path, { withFileTypes: true });
  } catch (err) {
    if (err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      warn('读取技能根失败 ' + root.path + ': ' + (err.message || err));
    }
    return out;
  }
  for (const entry of entries) {
    // 跳过隐藏目录（.system/.provenance 等）与特殊目录
    if (entry.name.startsWith('.')) continue;
    let file;
    let directory;
    if (entry.isDirectory()) {
      directory = path.join(root.path, entry.name);
      file = path.join(directory, 'SKILL.md');
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      directory = root.path;
      file = path.join(root.path, entry.name);
    } else {
      continue;
    }
    let parsed;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      parsed = splitFrontmatter(raw);
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) warn('读取技能文件失败 ' + file + ': ' + (err && err.message ? err.message : String(err)));
      continue;
    }
    if (!parsed) continue;
    const meta = readSkillMeta(parsed.data);
    if (!meta) {
      warn('技能 frontmatter 不合法，已跳过: ' + file);
      continue;
    }
    out.push({
      candidate: {
        name: meta.name,
        description: meta.description,
        ...(meta.whenToUse !== undefined ? { whenToUse: meta.whenToUse } : {}),
        invocation: meta.invocation,
        source: root.source,
        rank: root.rank,
        provider: providerName,
        path: file,
        locator: { file: file, directory: directory },
      },
      locator: { file: file, directory: directory },
    });
  }
  return out;
}

/**
 * 按 name 去重（同名校验：rank 小的赢；同 rank 按根顺序）。
 * @returns {object[]} candidate 列表（不含 locator 字段）
 */
export function dedupeByName(rows) {
  const sorted = rows.slice().sort((a, b) => a.candidate.rank - b.candidate.rank);
  const seen = new Map();
  for (const row of sorted) {
    if (!seen.has(row.candidate.name)) seen.set(row.candidate.name, row);
  }
  return Array.from(seen.values()).map((row) => row.candidate);
}

/**
 * 计算最终可见技能：全部扫描 + 白名单过滤。
 * @param {object} options
 * @param {'all'|'allow'} [options.mode]
 * @param {string[]} [options.allowed]
 * @returns {{visible:object[], hidden:string[], invalid:string[]}}
 */
export function selectSkills(rows, { mode = 'all', allowed = [] } = {}) {
  const all = dedupeByName(rows);
  const allowSet = new Set((Array.isArray(allowed) ? allowed : []).map((item) => String(item).trim()).filter(Boolean));
  if (mode === 'all') {
    return { visible: all, hidden: [], invalid: [] };
  }
  const visible = [];
  const hidden = [];
  for (const candidate of all) {
    if (allowSet.has(candidate.name)) visible.push(candidate);
    else hidden.push(candidate.name);
  }
  const found = new Set(all.map((candidate) => candidate.name));
  const missing = Array.from(allowSet).filter((name) => !found.has(name));
  return { visible, hidden, invalid: missing };
}
