/**
 * provider —— qqbot 自己的 skill provider 插件（cordis 插件形态）。
 *
 * 这是整个方案的关键：**技能发现本身就是一个插件**，宿主
 * @deepseek-ai/dsh-skill-filesystem 没有「按名过滤」能力，但公开的
 * ctx.skills.registerProvider() 契约允许任何插件提供自己的发现逻辑。
 *
 * 于是不再需要：改宿主、给宿主加 allowList、往 ~/.dsh/skills 塞软链、
 * 或者要求用户去编辑 preset。本文件就是一个普通插件，由 qqbot 在
 * agent scope 里用 agentCtx.plugin() 挂载（和它挂 dsh-tool-fs/web 一样），
 * registerProvider 便注册进**该 agent scope 的 layer**，只影响这个会话。
 *
 * 宿主 dsh-web-app 的 patch 注释原文：
 *   "The skill REGISTRY stays in the host plane. It is host+per-scope layered
 *    ... a preset's skill-filesystem registers into that preset's layer,
 *    and each agent reads the merged catalog its scope chain selects."
 * 本插件走的正是这条被官方设计支持的路径。
 *
 * 降级策略（保证「适应所有 dsh」）：
 *   - ctx.skills 不存在（老版本/精简宿主）-> apply 只 warn，不抛错；
 *   - registerProvider 不存在或签名变化 -> try/catch 后放弃，agent 仍能创建；
 *   - 扫描/解析失败 -> 该条跳过并 warn，绝不阻断会话。
 */
import { readFileSync } from 'node:fs';

import Schema from '@deepseek-ai/schemastery';

import {
  resolveSkillRoots,
  scanRoot,
  selectSkills,
  splitFrontmatter,
} from './scan.js';

/** cordis 插件名（同一 scope 内不能重名）。 */
export const name = 'qqbot-skill-provider';

/** 只依赖技能注册表；缺失时 cordis 不会激活本插件（等价降级）。 */
export const inject = ['skills'];

export const Config = Schema.object({
  providerName: Schema.string().default('qqbot').description('注册到 ctx.skills 的 provider 名'),
  mode: Schema.union(['all', 'allow']).default('allow').description('all=全部可见；allow=只暴露白名单'),
  allowed: Schema.array(Schema.string()).default([]).description('mode=allow 时可见的技能名'),
  cwd: Schema.string().default('').description('会话工作目录（决定 project 根）'),
  dshHome: Schema.string().default('').description('DSH home；空 = $DSH_HOME 或 ~/.dsh'),
  agentsHome: Schema.string().default('').description('agents home；空 = ~/.agents'),
  customSkillDirs: Schema.array(Schema.string()).default([]).description('额外技能根目录'),
  includeDefaultRoots: Schema.boolean().default(true).description('是否扫描 project/user 默认根'),
  debug: Schema.boolean().default(false),
});

/**
 * 注册 provider 到调用方所在 scope 的 skills layer。
 * @param {object} ctx cordis 上下文（agent scope）
 * @param {object} config 见 Config
 */
export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const logger = (() => {
    try {
      if (ctx && ctx.logger) return ctx.logger;
      if (ctx && typeof ctx.get === 'function') return ctx.get('logger') || console;
    } catch {
      /* 降级到 console */
    }
    return console;
  })();
  const warn = (message) => {
    try {
      logger.warn('[qqbot-skill] ' + message);
    } catch {
      /* 日志不可用也不影响发现 */
    }
  };
  const debug = (message) => {
    if (cfg.debug !== true) return;
    try {
      logger.debug('[qqbot-skill] ' + message);
    } catch {
      /* ignore */
    }
  };

  const skills = (() => {
    try {
      return ctx.get ? ctx.get('skills') : undefined;
    } catch {
      return undefined;
    }
  })();

  if (!skills || typeof skills.registerProvider !== 'function') {
    warn('ctx.skills.registerProvider 不可用，技能过滤降级（该 agent 看不到 skill 目录）');
    return;
  }

  const providerName = typeof cfg.providerName === 'string' && cfg.providerName.trim() !== ''
    ? cfg.providerName.trim()
    : 'qqbot';
  const mode = cfg.mode === 'all' ? 'all' : 'allow';
  const roots = resolveSkillRoots({
    cwd: cfg.cwd,
    dshHome: cfg.dshHome,
    agentsHome: cfg.agentsHome,
    customSkillDirs: cfg.customSkillDirs,
    includeDefaultRoots: cfg.includeDefaultRoots !== false,
  });

  /** 扫全部根，返回 {rows, invalid}。 */
  function discover() {
    const rows = [];
    for (const root of roots) rows.push(...scanRoot(root, providerName, warn));
    return rows;
  }

  try {
    const disposer = skills.registerProvider((control) => ({
      name: providerName,
      /**
       * 返回本 provider 的候选技能（已按白名单过滤）。
       * 契约：数组 或 {candidates, complete}。
       */
      async list(options) {
        const signal = options && options.signal;
        if (signal && signal.aborted) throw signal.reason;
        const rows = discover();
        const picked = selectSkills(rows, { mode: mode, allowed: cfg.allowed });
        const hiddenText = picked.hidden.length > 0 ? '（隐藏 ' + picked.hidden.length + ' 个: ' + picked.hidden.join(', ') + '）' : '';
        debug('技能可见 ' + picked.visible.length + ' 个' + hiddenText);
        if (picked.invalid.length > 0) {
          warn('白名单里有未找到的技能: ' + picked.invalid.join(', '));
        }
        // 只暴露契约允许的字段（locator 仍需要，用于 get 定位文件）
        return picked.visible.map((candidate) => ({
          name: candidate.name,
          description: candidate.description,
          ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
          invocation: candidate.invocation,
          source: candidate.source,
          rank: candidate.rank,
          provider: providerName,
          path: candidate.path,
          locator: candidate.locator,
        }));
      },
      /**
       * 读取所选技能的正文。
       * 契约：返回 {name, description, invocation, source, provider, content, ...} 或 undefined。
       */
      async get(candidate) {
        const locator = candidate && candidate.locator;
        const file = locator && typeof locator.file === 'string' ? locator.file : '';
        if (file === '') return undefined;
        let raw;
        try {
          raw = readFileSync(file, 'utf8');
        } catch (err) {
          if (err && err.code === 'ENOENT') return undefined;
          throw err;
        }
        const parsed = splitFrontmatter(raw);
        if (!parsed) return undefined;
        return {
          name: candidate.name,
          description: candidate.description,
          ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
          invocation: candidate.invocation,
          source: candidate.source,
          provider: providerName,
          ...(candidate.path !== undefined ? { path: candidate.path } : {}),
          resourceBase: { kind: 'directory', path: locator.directory },
          content: parsed.content,
        };
      },
    }));
    if (typeof disposer === 'function') {
      // cordis 的 effect 由注册方持有；这里再挂一次，保证插件卸载时注销。
      if (typeof ctx.effect === 'function') {
        try {
          ctx.effect(() => disposer, 'qqbot-skill.provider');
        } catch {
          /* effect 注册失败不影响已注册的 provider */
        }
      }
    }
    debug('已注册 skill provider "' + providerName + '"（mode=' + mode + ', allowed=' + (cfg.allowed || []).join(',') + '）');
  } catch (err) {
    warn('注册 skill provider 失败，技能过滤降级: ' + (err && err.message ? err.message : String(err)));
  }
}
