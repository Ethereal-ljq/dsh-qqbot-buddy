/**
 * bots/paths —— 机器人工作区目录解析（单一真相）。
 *
 * 布局（每个机器人一个工作区）：
 *   <workspaceDir>/persona.md
 *   <workspaceDir>/memory/ knowledge/ members/ stickers/
 *   <workspaceDir>/.qqbot/state/   （settings.json、credentials.json、sessions.json）
 *   <workspaceDir>/.qqbot/media/   （QQ 附件下载）
 *
 * legacy 机器人（从单机器人版本迁移来的第一条）沿用 config.stateDir / mediaDir /
 * settingsFile，保证旧数据原地可读；新建机器人一律用上面的标准布局。
 *
 * 所有函数纯同步、只读配置，不做隐式创建（ensureBotDirs 除外，由调用方显式调用）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 一个机器人工作区里的标准子目录名（UI「工作区与文件」按这个列表展示）。 */
export const BOT_SUBDIRS = Object.freeze([
  { key: 'persona', label: '人设文件', type: 'file', rel: 'persona.md', desc: 'persona.md（人设正文）' },
  { key: 'memory', label: '长期记忆', type: 'dir', rel: 'memory', desc: 'MEMORY.md、notes/、index.json' },
  { key: 'knowledge', label: '知识库', type: 'dir', rel: 'knowledge', desc: '条目 markdown + index.json' },
  { key: 'members', label: '群友库', type: 'dir', rel: 'members', desc: '成员画像 markdown + index.json' },
  { key: 'stickers', label: '表情包', type: 'dir', rel: 'stickers', desc: '收藏的表情包文件' },
  { key: 'state', label: '插件状态', type: 'dir', rel: '.qqbot/state', desc: 'settings.json、凭据、会话映射' },
  { key: 'media', label: '媒体缓存', type: 'dir', rel: '.qqbot/media', desc: 'QQ 图片/文件下载目录' },
]);

/** 默认 bot 工作区（新建机器人）：<workspaceRoot>/bots/<id>。 */
export function defaultBotWorkspace(workspaceRoot, botId) {
  return path.join(path.resolve(workspaceRoot), 'bots', String(botId));
}

/** 判断 target 是否位于 root 内（含 root 本身）。 */
export function isWithin(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 解析一个机器人的全部路径。
 * @param {object} args
 * @param {string} args.workspaceDir 工作区根（绝对路径；空则回退 config.cwd 或 process.cwd）
 * @param {object} [args.config] 插件部署配置（只对 legacy 机器人生效 stateDir/mediaDir/settingsFile）
 * @param {object} [args.record] 机器人记录（legacy 标记）
 * @returns {{workspaceDir:string,stateDir:string,mediaDir:string,settingsFile:string,personaPath:string,
 *   memoryDir:string,knowledgeDir:string,membersDir:string,stickersDir:string,legacy:boolean}}
 */
export function resolveBotPaths({ workspaceDir, config = {}, record = {} } = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const legacy = record && record.legacy === true;
  const baseRaw = typeof workspaceDir === 'string' && workspaceDir.trim() !== ''
    ? workspaceDir.trim()
    : String(cfg.cwd || '').trim() || process.cwd();
  const base = path.resolve(baseRaw);
  const pick = (value) => (typeof value === 'string' && value.trim() !== '' ? path.resolve(value.trim()) : '');
  const stateDir = legacy ? (pick(cfg.stateDir) || path.join(base, '.qqbot', 'state')) : path.join(base, '.qqbot', 'state');
  const mediaDir = legacy ? (pick(cfg.mediaDir) || path.join(base, '.qqbot', 'media')) : path.join(base, '.qqbot', 'media');
  const settingsFile = legacy ? (pick(cfg.settingsFile) || path.join(stateDir, 'settings.json')) : path.join(stateDir, 'settings.json');
  return {
    workspaceDir: base,
    stateDir: stateDir,
    mediaDir: mediaDir,
    settingsFile: settingsFile,
    personaPath: path.join(base, 'persona.md'),
    memoryDir: path.join(base, 'memory'),
    knowledgeDir: path.join(base, 'knowledge'),
    membersDir: path.join(base, 'members'),
    stickersDir: path.join(base, 'stickers'),
    credentialsFile: path.join(stateDir, 'credentials.json'),
    legacy: legacy,
  };
}

/** 创建目录（幂等）；返回 {ok,created}，失败抛错由调用方决定是否降级。 */
export function ensureBotDirs(paths) {
  const created = [];
  for (const dir of [paths.workspaceDir, paths.stateDir, paths.mediaDir, paths.memoryDir,
    paths.knowledgeDir, paths.membersDir, paths.stickersDir]) {
    if (typeof dir !== 'string' || dir === '') continue;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }
  return { ok: true, created: created };
}

/**
 * 检查覆盖路径是否都在工作区内（UI 提示用，不阻断）。
 * @returns {{ok:boolean, warnings:Array<{key:string,path:string,message:string}>}}
 */
export function checkPathsWithinWorkspace(paths) {
  const warnings = [];
  const root = paths && paths.workspaceDir ? paths.workspaceDir : '';
  if (root === '') return { ok: false, warnings: [{ key: 'workspace', path: '', message: '工作区未设置' }] };
  const labels = {
    personaPath: '人设文件', memoryDir: '长期记忆', knowledgeDir: '知识库',
    membersDir: '群友库', stickersDir: '表情包', stateDir: '插件状态', mediaDir: '媒体缓存',
  };
  for (const [key, label] of Object.entries(labels)) {
    const value = paths[key];
    if (typeof value !== 'string' || value === '') continue;
    if (!isWithin(root, value)) {
      warnings.push({ key: key, path: value, message: label + '目录不在工作区内：' + value });
    }
  }
  return { ok: warnings.length === 0, warnings: warnings };
}

/** 目录快照（UI 展示：路径 + 是否存在 + 文件数）。 */
export function describePaths(paths) {
  const out = {};
  for (const [key, value] of Object.entries(paths || {})) {
    if (typeof value !== 'string' || value === '') continue;
    if (['legacy', 'credentialsFile', 'settingsFile', 'personaPath'].includes(key)) continue;
    let exists = false;
    let entries = 0;
    try {
      const stat = fs.statSync(value);
      exists = true;
      if (stat.isDirectory()) entries = fs.readdirSync(value).length;
    } catch {
      exists = false;
    }
    out[key] = { path: value, exists: exists, entries: entries };
  }
  return out;
}

/** 4 个可被 settings 覆盖的资源目录（UI 编辑这些字段）。 */
export function editableDirKeys() {
  return [
    { key: 'persona.path', label: '人设文件', kind: 'file', settingsPath: 'persona.path' },
    { key: 'memory.dir', label: '长期记忆', kind: 'dir', settingsPath: 'memory.dir' },
    { key: 'knowledge.dir', label: '知识库', kind: 'dir', settingsPath: 'knowledge.dir' },
    { key: 'members.dir', label: '群友库', kind: 'dir', settingsPath: 'members.dir' },
    { key: 'stickers.dir', label: '表情包', kind: 'dir', settingsPath: 'stickers.dir' },
  ];
}
