/**
 * host/preview —— 控制台「提示词拼合预览」的只读拼装器。
 *
 * 为什么不是直接调 dsh 的 systemPrompt.assemble：预览需要支持"当前编辑中的配置档"
 * （还没保存、也未必绑定到任何 peer），而真实 assembly 依赖某个 live agent 的 scope。
 * 所以这里按与 host/prompt.js 完全相同的顺序/数据来源拼出本插件负责的段：
 *   qqbot:persona / qqbot:guide / qqbot:memory / qqbot:knowledge / qqbot:members
 * 宿主追加的段（身份、工具 schema、技能目录、运行时上下文）在 notes 里说明，并模拟技能目录。
 */
import fs from 'node:fs';
import path from 'node:path';

import { recallForPeer } from './recall.js';
import { buildToolGuide } from './tools.js';
import { filterSkillsBySettings } from './skills.js';
import {
  CAPABILITY_TOOLS, PLUGIN_TOOL_NAMES, isToolAllowed,
} from '../tools/catalog.js';

function strOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 该 settings 下模型可见的全局/宿主工具名（用于生成工具指引）。 */
export function visibleToolNames(settings) {
  const names = new Set();
  for (const list of Object.values(CAPABILITY_TOOLS)) {
    for (const name of list) if (isToolAllowed({ settings, name })) names.add(name);
  }
  for (const name of PLUGIN_TOOL_NAMES) {
    if (isToolAllowed({ settings, name })) names.add(name);
  }
  // 显式 allow 里可能有本插件不认识的全局工具（MCP/第三方），也纳入预览
  const tools = settings && settings.tools && typeof settings.tools === 'object' ? settings.tools : {};
  const allow = Array.isArray(tools.allow) ? tools.allow : [];
  if (tools.mode !== 'deny' && allow.length > 0) {
    for (const name of allow) names.add(name);
  }
  const deny = Array.isArray(tools.deny) ? tools.deny : [];
  for (const name of deny) names.delete(name);
  return [...names].sort();
}

/** 读人设（与 BotRuntime.readPersona 同源）：生效人格卡 > bot 目录 persona.md。 */
function readPersona({ db, botId, cwd, settings }) {
  try {
    const activeId = settings && settings.persona ? settings.persona.activeCardId : '';
    if (activeId && db) {
      const row = db.prepare('SELECT content FROM personas WHERE id = ? AND bot_id = ?').get(activeId, botId);
      if (row && row.content) return String(row.content);
    }
    const file = cwd ? path.join(cwd, 'persona.md') : '';
    if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  } catch { /* ignore */ }
  return '';
}

/** 模拟宿主技能目录（真实渲染由 dsh-tool-skill 以 <available_skills> 系统提醒追加）。 */
function renderSkillsPreview(skills) {
  const list = Array.isArray(skills) ? skills.filter((item) => item && strOf(item.name) !== '') : [];
  if (list.length === 0) return '';
  const lines = list.map((item) => {
    const desc = strOf(item.description);
    return '- ' + item.name + (desc !== '' ? '：' + (desc.length > 160 ? desc.slice(0, 160) + '…' : desc) : '');
  });
  return '【技能】可用技能（宿主追加，等价预览）：\n' + lines.join('\n');
}

/**
 * 拼合预览。
 * @param {object} args
 * @param {object} args.settings 生效设置（profile 级已合并）
 * @param {string} args.botId
 * @param {string} [args.cwd] bot 工作目录（读 persona.md）
 * @param {string} [args.peer] 预览用的 peer（决定召回作用域）
 * @param {string} [args.query] 预览用的本轮用户消息（召回 query）
 * @param {object} [args.db]
 * @param {object} [args.memory] memory store
 * @param {object} [args.knowledge] kb store
 * @param {object} [args.members] members store
 * @param {object[]} [args.skills] 可见技能列表
 * @returns {Promise<object>}
 */
export async function buildPromptPreview({
  settings, botId, cwd, peer = '', query = '', db, memory, knowledge, members, skills: rawSkills = [],
} = {}) {
  const cfg = settings && typeof settings === 'object' ? settings : {};
  const toolNames = visibleToolNames(cfg);
  const personaText = readPersona({ db, botId, cwd, settings: cfg });
  const guideText = buildToolGuide(toolNames.map((name) => ({ name })));
  let memoryText = '';
  let knowledgeText = '';
  let memberText = '';
  try {
    const recalled = await recallForPeer({
      memory, knowledge, members, settings: cfg, botId, query, senderId: '',
    });
    memoryText = recalled.memoryText || '';
    knowledgeText = recalled.knowledgeText || '';
    memberText = recalled.memberText || '';
  } catch { /* 预览失败按空段展示 */ }

  const skills = filterSkillsBySettings(settings, rawSkills);
  const sections = [
    { name: 'qqbot:persona', label: '人设', text: personaText },
    { name: 'qqbot:guide', label: '工具指引 + 能力边界', text: guideText },
    { name: 'qqbot:memory', label: '长期记忆（按 query 召回）', text: memoryText },
    { name: 'qqbot:knowledge', label: '知识库（按 query 召回）', text: knowledgeText },
    { name: 'qqbot:members', label: '群友库（发言人/被提及的人）', text: memberText },
    { name: 'host:skills', label: '技能目录（宿主追加，模拟）', text: renderSkillsPreview(skills) },
  ].map((section) => ({ ...section, chars: section.text.length, empty: section.text === '' }));

  const notes = [
    '这是本插件负责的 prompt 段拼合（qqbot:*）；真实请求里宿主还会追加身份段、工具 schema、技能目录与运行时上下文。',
    '记忆/知识/群友段按「本轮用户消息」召回；query 为空时为空段。',
    '预览只读，不写任何状态；未保存的改动不会体现（请先保存配置档）。',
  ];
  if (cfg.persona && cfg.persona.suppressRuntimeContext !== false) {
    notes.push('persona.suppressRuntimeContext=true：运行时上下文（时间/工作目录/团队身份）已被抑制。');
  }
  const text = sections
    .map((section) => '===== ' + section.name + ' (' + section.chars + ' chars) =====\n' + section.text)
    .join('\n\n');
  return {
    ok: true,
    source: 'composed',
    botId: botId || '',
    peer: peer || '',
    query: String(query || ''),
    sections,
    text,
    notes,
    toolNames,
    skillNames: (Array.isArray(skills) ? skills : []).map((item) => item && item.name).filter(Boolean),
  };
}

export default { buildPromptPreview, visibleToolNames };
