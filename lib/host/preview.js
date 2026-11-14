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
import { formatNow, timeZoneName } from './prompt.js';
import { presetIdFor } from './presets.js';
import { buildToolGuide } from './tools.js';
import { getService, errText } from './services.js';
import { tierOf } from '../tools/catalog.js';
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
  const guideText = buildToolGuide({
    tools: toolNames.map((name) => ({ name })),
    settings: cfg,
    activeNames: toolNames,
  });
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
  // 2026-11-14：静态段进系统提示词，动态内容走运行时上下文快照（不进缓存前缀）
  const sections = [
    { name: 'deployment:persona-prefix', label: '人设（官方槽位）', text: personaText },
    { name: 'qqbot:guide', label: '工具指引 + 按需能力索引', text: guideText },
    { name: 'host:skills', label: '技能目录（宿主追加，模拟）', text: renderSkillsPreview(skills) },
  ].map((section) => ({ ...section, chars: section.text.length, empty: section.text === '' }));

  const contexts = [
    { name: 'qqbot:memory', label: '长期记忆（按 query 召回）', text: memoryText },
    { name: 'qqbot:knowledge', label: '知识库（按 query 召回）', text: knowledgeText },
    { name: 'qqbot:members', label: '群友库（发言人/被提及的人）', text: memberText },
    { name: 'qqbot:env', label: '时间/时区（每轮覆盖）', text: '现在是 ' + formatNow() + '（' + timeZoneName() + '）。' },
  ].map((item) => ({ ...item, chars: item.text.length, empty: item.text === '' }));

  const notes = [
    '静态段进系统提示词（同一配置档下每轮逐字节相同，缓存命中）；记忆/知识/群友/时间走运行时上下文快照（user 角色），只追加变化的那条。宿主还会自行追加身份段、工具 schema 与技能目录。',
    '记忆/知识/群友按「本轮用户消息」召回；query 为空时为空段。',
    '预览只读，不写任何状态；未保存的改动不会体现（请先保存配置档）。',
  ];
  if (cfg.persona && cfg.persona.suppressRuntimeContext !== false) {
    notes.push('persona.suppressRuntimeContext=true：运行时上下文（时间/工作目录/团队身份）已被抑制。');
  }
  const text = [...sections, ...contexts]
    .map((section) => '===== ' + section.name + ' (' + section.chars + ' chars) =====\n' + section.text)
    .join('\n\n');
  return {
    ok: true,
    source: 'composed',
    botId: botId || '',
    peer: peer || '',
    query: String(query || ''),
    sections,
    contexts,
    text,
    notes,
    toolNames,
    skillNames: (Array.isArray(skills) ? skills : []).map((item) => item && item.name).filter(Boolean),
  };
}

export default { buildPromptPreview, visibleToolNames };

/**
 * 实时（真实 assembly）提示词预览：读 live agent 的 systemPrompt.assemble。
 *
 * 与 buildPromptPreview 的区别：这里拿到的是**模型实际会收到的段**——包含宿主段、
 * 我们的槽位/遮蔽段、真实变量值、以及此刻真正声明的工具（受 restrict + when 影响）。
 * 没有 live 会话时返回 { ok:false }，调用方回落到模拟拼合。
 *
 * @param {{host: object, rootCtx: object, botId: string, peer: string, logger?: object}} args
 * @returns {Promise<object>}
 */
export async function buildLivePromptPreview({ host, rootCtx, botId, peer, logger } = {}) {
  try {
    const instance = host && typeof host.runtimeOf === 'function' ? host.runtimeOf(String(botId || '')) : null;
    if (!instance) return { ok: false, reason: 'no-runtime' };
    const record = instance.sessions instanceof Map ? instance.sessions.get(String(peer || '')) : null;
    if (!record || !record.agent) return { ok: false, reason: 'no-session' };
    const agent = record.agent;
    const service = getService(rootCtx, 'systemPrompt');
    if (!service || typeof service.assemble !== 'function') return { ok: false, reason: 'no-service' };

    const assembly = await service.assemble({ agent, scope: agent });
    const variables = assembly && assembly.variables && typeof assembly.variables === 'object' ? assembly.variables : {};
    const settings = (() => {
      try { return typeof instance.settingsFor === 'function' ? instance.settingsFor(String(peer || '')) : {}; } catch { return {}; }
    })();

    const OUR = new Set(['deployment:persona-prefix', 'deployment:persona-suffix', 'qqbot:guide', 'qqbot:memory', 'qqbot:knowledge', 'qqbot:members']);
    const render = (raw) => String(raw || '').replace(/\{\{([a-z][a-z0-9_]*)\}\}/gi, (match, key) => {
      const value = variables[key];
      return typeof value === 'string' ? value : match;
    });

    const sections = [];
    const rawSections = Array.isArray(assembly && assembly.sections) ? assembly.sections : [];
    for (let index = 0; index < rawSections.length; index += 1) {
      const section = rawSections[index] || {};
      const name = String(section.name || '');
      const raw = String(section.text || '');
      const rendered = render(raw);
      const ours = OUR.has(name) || name.startsWith('qqbot:');
      sections.push({
        name,
        label: ours ? '本插件' : (rendered === '' ? '宿主（已遮蔽）' : '宿主'),
        text: rendered,
        chars: rendered.length,
        empty: rendered === '',
        kind: ours ? 'ours' : 'host',
        order: index,
      });
    }
    const text = sections.map((section) => section.text).filter((value) => value !== '').join('\n\n');

    const tools = (Array.isArray(assembly && assembly.tools) ? assembly.tools : []).map((tool) => {
      const name = String((tool && tool.name) || '');
      return { name, tier: tierOf(name, settings) };
    }).filter((item) => item.name !== '');

    const activation = (() => {
      try {
        const state = instance.activation instanceof Map ? instance.activation.get(String(peer || '')) : null;
        if (!state) return { groups: [], tools: [] };
        return { groups: [...state.groups].sort(), tools: [...state.tools].sort() };
      } catch { return { groups: [], tools: [] }; }
    })();

    // 运行时上下文（user-role 快照）：单独一栏展示，不混进系统提示词字符数
    const rawContexts = Array.isArray(assembly && assembly.contexts) ? assembly.contexts : [];
    const contextSections = rawContexts.map((entry, index) => {
      const name = String((entry && entry.name) || '');
      const rendered = render(entry && entry.text);
      const ours = name.startsWith('qqbot:');
      return {
        name,
        label: ours ? '本插件 · 运行时上下文' : '宿主 · 运行时上下文',
        text: rendered,
        chars: rendered.length,
        empty: rendered === '',
        kind: ours ? 'ours' : 'host',
        order: index,
      };
    }).filter((item) => item.name !== '');
    const contextText = contextSections.filter((item) => item.text !== '').map((item) => item.text).join('\n\n');

    // 装配档位诊断：live agent 绑定的 preset 与「当前配置应得的 preset」是否一致。
    // 改了能力开关后，已有会话保持旧装配（preset 官方语义），新会话才换——控制台据此提示"重建会话"。
    const expectedPresetId = (() => { try { return presetIdFor(settings); } catch { return ''; } })();
    const presetId = (() => {
      try {
        const service = getService(rootCtx, 'agentPresets');
        if (service && typeof service.composedPreset === 'function') return String(service.composedPreset(agent.ctx || agent) || '');
      } catch { /* ignore */ }
      return '';
    })();
    const presetStale = presetId !== '' && expectedPresetId !== '' && presetId !== expectedPresetId;

    const shadowCount = sections.filter((section) => section.kind === 'host' && section.empty).length;
    return {
      ok: true,
      source: 'live',
      presetId,
      expectedPresetId,
      presetStale,
      botId: String(botId || ''),
      peer: String(peer || ''),
      sessionId: String(record.sessionId || ''),
      sections,
      contextSections,
      contextText,
      text,
      chars: text.length,
      tools,
      contexts: contextSections.map((entry) => entry.name),
      variables: Object.keys(variables).sort(),
      activation,
      notes: [
        '这是模型此刻真实会收到的系统提示词（含宿主段与遮蔽结果）。',
        shadowCount > 0 ? shadowCount + ' 个宿主段已被遮蔽为空（不会进入提示词）。' : '',
        '工具列表是本次 assembly 真正声明的集合：被动工具未激活就不会出现。',
      ].filter((note) => note !== ''),
    };
  } catch (err) {
    logger?.warn?.('实时提示词预览失败: ' + errText(err));
    return { ok: false, reason: 'assemble-failed', error: errText(err) };
  }
}

