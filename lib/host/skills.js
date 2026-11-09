/**
 * host/skills —— 技能扫描 + provider（按 profile 白名单过滤）+ agent 作用域登记。
 *
 * 为什么不用宿主 @deepseek-ai/dsh-skill-filesystem：它只按目录扫描、没有"按 agent/配置档过滤"的钩子，
 * 而 skill 白名单（tools.skillsMode/tools.skills）需要按**当前 agent 的生效设置**过滤。
 * dsh-skill 的 provider.list(options) 会收到 { scope: agent, cwd }，所以这里自己实现 provider：
 *   - scope 命中本插件的 agent（buildSetup 时登记）→ 按该 bot+peer 的生效设置过滤；
 *   - scope 为空（控制台发现 / 根视图）→ 返回全部（管理面要看到所有技能）。
 *
 * 另外 bot 的 cwd 是 <workspace>/bots/<id>，向上找 .git 找不到 workspace 根，
 * 所以除了 ~/.dsh/skills 与 ~/.agents/skills，还把 workspace 根的 .dsh/skills 显式纳入扫描。
 *
 * 前端/发现只需 name/description/source；模型侧 catalog 由 dsh-tool-skill 用同一 provider 生成。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ROOT_RANKS = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
};

/** agent -> { runtime, botId, peer }（buildSetup 登记；WeakMap 不阻止 GC）。 */
const AGENT_SCOPES = new WeakMap();

/** 登记一个 agent 的归属（供 provider 按配置档过滤）。 */
export function registerAgentSkillScope(agent, meta) {
  if (agent && meta && typeof meta.botId === 'string') AGENT_SCOPES.set(agent, meta);
}

/** 去首尾引号 + 基本转义。 */
function unquote(value) {
  const raw = String(value || '').trim();
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

/**
 * 解析 frontmatter（只覆盖本机技能用到的 YAML 子集）：
 * 简单 key: value、单双引号、`>`/`|` 块标量、嵌套 mapping（忽略二级键）、布尔。
 * @returns {{data:Record<string,unknown>, body:string}|null}
 */
export function parseFrontmatter(text) {
  const raw = typeof text === 'string' ? text : '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(raw);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/u);
  const data = {};
  let lastKey = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || /^\s*#/u.test(line)) continue;
    // 缩进行：块标量续行 / 嵌套 mapping
    if (/^\s+/u.test(line)) {
      if (lastKey !== '' && data[lastKey] !== undefined && data[lastKey] && typeof data[lastKey] === 'object') continue;
      if (lastKey !== '' && typeof data[lastKey] === 'string' && data[lastKey].__block === true) continue;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (rest === '>' || rest === '|' || rest === '>-' || rest === '|-') {
      // 块标量：收集后续缩进行
      const block = [];
      let cursor = index + 1;
      while (cursor < lines.length && (/^\s+/u.test(lines[cursor]) || lines[cursor].trim() === '')) {
        block.push(lines[cursor]);
        cursor += 1;
      }
      index = cursor - 1;
      const cleaned = block.map((item) => item.replace(/^\s{1,}/u, ''));
      data[key] = rest.startsWith('|') ? cleaned.join('\n').trim() : cleaned.filter((item) => item !== '').join(' ').trim();
      lastKey = '';
      continue;
    }
    data[key] = rest === '' ? {} : unquote(rest);
    lastKey = key;
  }
  const body = raw.slice(match[0].length);
  return { data, body };
}

/** frontmatter 布尔。 */
function boolOf(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  return undefined;
}

/** 解析一个 SKILL.md（或扁平 .md）文件。 */
function readSkillFile(filePath, source, rank) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
  const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : '';
  if (name === '' || !SKILL_NAME.test(name) || description === '') return null;
  const disableModel = boolOf(parsed.data['disable-model-invocation']);
  const userInvocable = boolOf(parsed.data['user-invocable']);
  const invocation = {
    modelInvocable: disableModel !== true,
    userInvocable: userInvocable !== false,
  };
  const whenToUse = typeof parsed.data.whenToUse === 'string' ? parsed.data.whenToUse.trim() : '';
  const directory = path.dirname(filePath);
  return {
    name,
    description,
    ...(whenToUse !== '' ? { whenToUse } : {}),
    invocation,
    source,
    rank,
    path: path.resolve(filePath),
    locator: { path: path.resolve(filePath), directory: source === 'user-dsh' || source === 'user-agents' ? directory : directory },
    content: parsed.body.trim(),
  };
}

/** 扫描某个根目录（一层：<root>/<name>/SKILL.md 或 <root>/<name>.md）。 */
function scanRoot(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root.path, { withFileTypes: true });
  } catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (entry.name === '.system' || entry.name.startsWith('.')) continue;
    const full = path.join(root.path, entry.name);
    let skill = null;
    if (entry.isDirectory()) {
      const file = path.join(full, 'SKILL.md');
      if (fs.existsSync(file)) skill = readSkillFile(file, root.source, root.rank);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      skill = readSkillFile(full, root.source, root.rank);
    }
    if (skill) out.push(skill);
  }
  return out;
}

/** 技能根目录列表（与宿主一致：project 根 + 用户根 + 显式 custom）。 */
export function resolveSkillRoots({ workspaceRoot, cwd, dshHome, agentsHome, includeDefaultRoots = true } = {}) {
  const roots = [];
  const home = dshHome || path.join(os.homedir(), '.dsh');
  const agents = agentsHome || path.join(os.homedir(), '.agents');
  if (includeDefaultRoots) {
    const workspace = workspaceRoot || cwd || process.cwd();
    roots.push({ path: path.join(workspace, '.dsh', 'skills'), source: 'project-dsh', rank: ROOT_RANKS['project-dsh'] });
    roots.push({ path: path.join(workspace, '.agents', 'skills'), source: 'project-agents', rank: ROOT_RANKS['project-agents'] });
    roots.push({ path: path.join(home, 'skills'), source: 'user-dsh', rank: ROOT_RANKS['user-dsh'] });
    roots.push({ path: path.join(agents, 'skills'), source: 'user-agents', rank: ROOT_RANKS['user-agents'] });
  }
  return roots;
}

/**
 * 按配置档设置过滤技能列表（白名单语义与工具一致）：
 * - skillsMode=allow 且 skills 列表非空 → 只保留列表内；
 * - skillsMode=allow 且列表为空 → 全部；
 * - skillsMode=all → 全部。
 * @param {object} settings 生效设置
 * @param {Array<{name:string}>} skills
 * @returns {Array<object>}
 */
export function filterSkillsBySettings(settings, skills) {
  const list = Array.isArray(skills) ? skills : [];
  const tools = settings && settings.tools && typeof settings.tools === 'object' ? settings.tools : {};
  const mode = tools.skillsMode === 'all' ? 'all' : 'allow';
  const allowed = Array.isArray(tools.skills) ? tools.skills.filter((name) => typeof name === 'string' && name !== '') : [];
  if (mode === 'all' || allowed.length === 0) return list;
  return list.filter((skill) => skill && allowed.includes(skill.name));
}

/** 某 agent 的生效设置（通过 buildSetup 登记的 runtime）。 */
function settingsForAgent(agent) {
  const meta = AGENT_SCOPES.get(agent);
  if (!meta || !meta.runtime || !meta.runtime.config) return null;
  try { return meta.runtime.config.getEffectiveSettings(meta.botId, meta.peer); } catch { return null; }
}

/**
 * 创建 provider（dsh-skill 的 registerProvider 契约）。
 * @param {{runtime:object, workspaceRoot:string, logger:object, dshHome?:string}} args
 */
export function createSkillProvider({ runtime, workspaceRoot, logger, dshHome, agentsHome } = {}) {
  const envHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : '';
  const home = dshHome || envHome || path.join(os.homedir(), '.dsh');
  const agents = agentsHome || path.join(os.homedir(), '.agents');
  const roots = () => resolveSkillRoots({
    workspaceRoot, dshHome: home, agentsHome: agents, includeDefaultRoots: true,
  });
  function allSkills(cwd) {
    const found = [];
    for (const root of roots()) found.push(...scanRoot(root));
    // cwd 自己的项目根也扫（若与 workspaceRoot 不同）
    if (typeof cwd === 'string' && cwd !== '' && workspaceRoot !== cwd) {
      const projectRoot = path.join(cwd, '.dsh', 'skills');
      if (fs.existsSync(projectRoot)) found.push(...scanRoot({ path: projectRoot, source: 'project-dsh', rank: ROOT_RANKS['project-dsh'] }));
    }
    return found;
  }
  return {
    name: 'qqbot',
    async list(options = {}) {
      const skills = allSkills(options.cwd);
      const settings = options.scope !== undefined ? settingsForAgent(options.scope) : null;
      const filtered = settings ? filterSkillsBySettings(settings, skills) : skills;
      // 同名技能按 rank 优先（project < custom < user）
      const best = new Map();
      for (const skill of filtered.sort((a, b) => a.rank - b.rank)) {
        if (!best.has(skill.name)) best.set(skill.name, skill);
      }
      return [...best.values()].map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
        invocation: skill.invocation,
        source: skill.source,
        rank: skill.rank,
        provider: 'qqbot',
        locator: skill.locator,
        resourceBase: { kind: 'directory', path: skill.locator.directory },
        path: skill.path,
      }));
    },
    async get(candidate) {
      try {
        const raw = fs.readFileSync(candidate.locator.path, 'utf8');
        const parsed = parseFrontmatter(raw);
        if (!parsed) return undefined;
        const skill = readSkillFile(candidate.locator.path, candidate.source, candidate.rank);
        if (!skill) return undefined;
        return {
          name: skill.name,
          description: skill.description,
          ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
          invocation: skill.invocation,
          source: skill.source,
          provider: 'qqbot',
          resourceBase: { kind: 'directory', path: skill.locator.directory },
          path: skill.path,
          content: skill.content,
        };
      } catch { return undefined; }
    },
  };
}

export default { createSkillProvider, filterSkillsBySettings, parseFrontmatter, registerAgentSkillScope, resolveSkillRoots };
