/**
 * reports/template-registry —— 卡片模板注册表：内置两套 + 用户自定义模板（运行时发现）。
 *
 * 内置（随包发布）：journal / dark。
 * 自定义：<dataDir>/templates/<name>/index.html（可选 meta.json: {label,description}），
 * 资源按模板所在目录解析（模板里写 assets/xxx 即可）。
 * 开发时可额外用环境变量 QQBOT_TEMPLATE_DIRS（路径分隔符分隔）挂几个目录。
 *
 * 约定：模板名只能是 [A-Za-z0-9][A-Za-z0-9_-]{0,31}，避免路径穿越；
 * 与内置同名的自定义模板会被忽略（内置优先）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeVisualConfig } from './visuals.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = path.join(HERE, 'templates');

/** 随包发布的内置模板。 */
export const BUILTIN_TEMPLATES = Object.freeze({
  journal: Object.freeze({ file: 'daily-journal.html', label: '纸刊 · 暖色' }),
  dark: Object.freeze({ file: 'daily-dark.html', label: '深色 · 数据' }),
});

export const BUILTIN_NAMES = Object.freeze(Object.keys(BUILTIN_TEMPLATES));

/** 特殊值：只发文本，不渲染。 */
export const OFF_TEMPLATE = 'off';

/** 模板名白名单（同时用于配置校验，防止把 ../ 写进目录名）。 */
export const TEMPLATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** 自定义模板根目录：环境变量优先，随后是数据目录。 */
export function templateDirs({ dataDir = '', env = process.env } = {}) {
  const dirs = [];
  const extra = String((env && env.QQBOT_TEMPLATE_DIRS) || '').trim();
  if (extra !== '') {
    for (const part of extra.split(path.delimiter)) {
      const dir = part.trim();
      if (dir !== '') dirs.push(path.resolve(dir));
    }
  }
  if (dataDir) dirs.push(path.join(dataDir, 'templates'));
  return dirs;
}

function readMeta(dir, readFile) {
  try {
    const parsed = JSON.parse(readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      label: typeof parsed.label === 'string' ? parsed.label.trim() : '',
      description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
      // 模板自带的插画插槽声明（素材/氛围/组合），没有就是 null，宿主整条链路空转。
      visuals: normalizeVisualConfig(parsed.visuals),
    };
  } catch {
    return {};
  }
}

/**
 * 列出内置 + 自定义模板（同名去重、内置优先）。
 * @returns {Array<{name:string,label:string,description:string,builtin:boolean,file:string,dir:string,visuals:object|null}>}
 */
export function listTemplates({
  dataDir = '',
  env = process.env,
  exists = fs.existsSync,
  readdir = fs.readdirSync,
  readFile = fs.readFileSync,
} = {}) {
  const out = Object.entries(BUILTIN_TEMPLATES).map(([name, item]) => ({
    name,
    label: item.label,
    description: '',
    builtin: true,
    file: path.join(BUILTIN_DIR, item.file),
    dir: BUILTIN_DIR,
    visuals: null,
  }));
  const seen = new Set(BUILTIN_NAMES);
  for (const root of templateDirs({ dataDir, env })) {
    let entries;
    try {
      entries = readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      if (!entry || !entry.name) continue;
      const name = String(entry.name);
      if (!TEMPLATE_NAME_RE.test(name) || seen.has(name)) continue;
      let isDir = true;
      try { isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : true; } catch { isDir = true; }
      if (!isDir) continue;
      const dir = path.join(root, name);
      const file = path.join(dir, 'index.html');
      if (!exists(file)) continue;
      const meta = readMeta(dir, readFile);
      seen.add(name);
      out.push({
        name,
        label: meta.label || name,
        description: meta.description,
        builtin: false,
        file,
        dir,
        visuals: meta.visuals || null,
      });
    }
  }
  return out;
}

/** 按名字取模板；未知 / off 返回 null。 */
export function resolveTemplate(name, options = {}) {
  const key = String(name || '').trim();
  if (key === '' || key === OFF_TEMPLATE) return null;
  return listTemplates(options).find((item) => item.name === key) || null;
}

export default listTemplates;
