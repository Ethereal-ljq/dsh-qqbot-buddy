/**
 * core/config/schema —— 设置项的单一真相（defaults / normalize / UI 元数据都从这里派生）。
 *
 * 每个设置项：
 *   key          点号路径，如 reply.mode
 *   section      归属分节（控制台表单分组）
 *   scope        global(全局) | bot(单机器人) | profile(配置档，可被作用域绑定覆盖)
 *   type         boolean | number | string | enum | stringArray | json
 *   default      默认值
 *   label/help   控制台文案
 *   values       enum 取值（数组 [{value,label}] 或字符串数组）
 *   min/max/step number 约束
 *   widget       UI 控件提示：switch | radio | select | number | text | textarea | tags | json
 *
 * 规则：未知 key 一律丢弃并记 warning（v1 的静默丢弃问题）；类型错误回落到默认值也记 warning。
 * 这份表同时生成控制台表单（GET /api/schema）——**新增设置只改这一个文件**。
 */

/** 分节定义（控制台左侧/表单分组）。 */
export const SECTIONS = [
  { id: 'reply', label: '回复与触发', order: 10, desc: '什么时候回、回多快、连发怎么拆' },
  { id: 'persona', label: '人设与提示', order: 20, desc: '人格、提示段与运行时上下文' },
  { id: 'model', label: '模型', order: 30, desc: 'provider / model / 推理强度' },
  { id: 'tools', label: '工具与技能', order: 40, desc: '能力白名单与外部工具放行' },
  { id: 'memory', label: '记忆', order: 50, desc: '长期记忆的采集与召回' },
  { id: 'kb', label: '知识库', order: 60, desc: '知识检索参数' },
  { id: 'vision', label: '看图', order: 70, desc: '图片入上下文与视觉兜底' },
  { id: 'stickers', label: '表情包', order: 80, desc: '收藏、配额与发送频率' },
  { id: 'admin', label: '命令与权限', order: 90, desc: '管理员命令门控' },
];

/** 设置项清单。 */
export const SETTINGS = [
  // ── reply ─────────────────────────────────────────────────
  { key: 'reply.enabled', section: 'reply', scope: 'profile', type: 'boolean', default: true, label: '启用回复', widget: 'switch',
    help: '关闭后机器人只收不发（调试/维护用）' },
  { key: 'reply.mode', section: 'reply', scope: 'profile', type: 'enum', default: 'adaptive', label: '回复模式', widget: 'radio',
    values: [
      { value: 'always', label: '每条都回' },
      { value: 'mention', label: '仅 @/引用时回' },
      { value: 'probability', label: '按概率' },
      { value: 'interval', label: '按间隔' },
      { value: 'adaptive', label: '自适应（推荐）' },
    ],
    help: '自适应 = 静默 debounce + 冷却 + 最长等待 + 只回问句/图片' },
  { key: 'reply.probability', section: 'reply', scope: 'profile', type: 'number', default: 0.3, min: 0, max: 1, step: 0.05, label: '回复概率', widget: 'number',
    help: '仅「按概率」模式生效' },
  { key: 'reply.intervalMs', section: 'reply', scope: 'profile', type: 'number', default: 60000, min: 1000, max: 3600000, step: 1000, label: '最小回复间隔（ms）', widget: 'number' },
  { key: 'reply.debounceMs', section: 'reply', scope: 'profile', type: 'number', default: 1500, min: 0, max: 30000, step: 100, label: '静默 debounce（ms）', widget: 'number' },
  { key: 'reply.cooldownMs', section: 'reply', scope: 'profile', type: 'number', default: 8000, min: 0, max: 600000, step: 500, label: '冷却（ms）', widget: 'number' },
  { key: 'reply.maxWaitMs', section: 'reply', scope: 'profile', type: 'number', default: 12000, min: 1000, max: 120000, step: 500, label: '最长等待（ms）', widget: 'number' },
  { key: 'reply.mentionAlways', section: 'reply', scope: 'profile', type: 'boolean', default: true, label: '@ 必回', widget: 'switch' },
  { key: 'reply.quoteAlways', section: 'reply', scope: 'profile', type: 'boolean', default: true, label: '引用机器人必回', widget: 'switch' },
  { key: 'reply.keywordsAlways', section: 'reply', scope: 'profile', type: 'boolean', default: true, label: '命中关键词必回', widget: 'switch' },
  { key: 'reply.keywords', section: 'reply', scope: 'profile', type: 'stringArray', default: [], label: '必回关键词', widget: 'tags' },
  { key: 'reply.splitBubbles', section: 'reply', scope: 'profile', type: 'boolean', default: true, label: '多气泡分条', widget: 'switch' },
  { key: 'reply.maxBubbles', section: 'reply', scope: 'profile', type: 'number', default: 4, min: 1, max: 10, step: 1, label: '最多气泡数', widget: 'number' },

  // ── persona ───────────────────────────────────────────────
  { key: 'persona.activeCardId', section: 'persona', scope: 'profile', type: 'string', default: '', label: '生效人格卡', widget: 'select',
    help: '留空表示使用 bot 目录下的 persona.md' },
  { key: 'persona.extraPrompt', section: 'persona', scope: 'profile', type: 'string', default: '', label: '追加提示', widget: 'textarea',
    help: '追加在人设之后，优先级高于人设' },
  { key: 'persona.suppressRuntimeContext', section: 'persona', scope: 'profile', type: 'boolean', default: true, label: '隐藏宿主运行时上下文', widget: 'switch',
    help: '开启后不把「当前时间/工作目录/团队身份」等注入给 QQ 机器人' },
  { key: 'persona.guides', section: 'persona', scope: 'profile', type: 'json', default: {}, label: '提示段覆盖', widget: 'json',
    help: '{ "段id": "覆盖文本" }，段 id 见提示段目录' },

  // ── model ─────────────────────────────────────────────────
  { key: 'model.provider', section: 'model', scope: 'profile', type: 'string', default: '', label: 'provider', widget: 'select',
    help: '留空跟随宿主默认' },
  { key: 'model.model', section: 'model', scope: 'profile', type: 'string', default: '', label: 'model', widget: 'select' },
  { key: 'model.reasoningEffort', section: 'model', scope: 'profile', type: 'string', default: '', label: '推理强度', widget: 'select',
    help: '留空跟随模型默认；可选 low/medium/high' },
  { key: 'model.preset', section: 'model', scope: 'profile', type: 'string', default: '', label: 'agent preset', widget: 'select',
    help: '留空使用内置精简组合' },

  // ── tools ─────────────────────────────────────────────────
  { key: 'tools.mode', section: 'tools', scope: 'profile', type: 'enum', default: 'allow', label: '白名单模式', widget: 'radio',
    values: [{ value: 'allow', label: '只允许列表内' }, { value: 'deny', label: '只屏蔽列表内' }],
    help: '默认拒绝：新装插件带来的工具不会自动进入 QQ 会话' },
  { key: 'tools.allow', section: 'tools', scope: 'profile', type: 'stringArray', default: [], label: '放行工具', widget: 'tags' },
  { key: 'tools.deny', section: 'tools', scope: 'profile', type: 'stringArray', default: [], label: '屏蔽工具', widget: 'tags' },
  { key: 'tools.capabilities', section: 'tools', scope: 'profile', type: 'json', default: {}, label: '能力开关', widget: 'json',
    help: '{ "workspace": true, "web": true, "memory": true, "stickers": true, "vision": true, "skills": false, "imagegen": false }' },
  { key: 'tools.skillsMode', section: 'tools', scope: 'profile', type: 'enum', default: 'allow', label: '技能过滤模式', widget: 'radio',
    values: [{ value: 'all', label: '全部可见' }, { value: 'allow', label: '仅白名单' }] },
  { key: 'tools.skills', section: 'tools', scope: 'profile', type: 'stringArray', default: [], label: '可见技能', widget: 'tags' },

  // ── memory ────────────────────────────────────────────────
  { key: 'memory.enabled', section: 'memory', scope: 'profile', type: 'boolean', default: true, label: '启用长期记忆', widget: 'switch' },
  { key: 'memory.autoExtractEvery', section: 'memory', scope: 'profile', type: 'number', default: 10, min: 0, max: 1000, step: 1, label: '每 N 轮自动提炼', widget: 'number',
    help: '0 = 关闭自动提炼' },
  { key: 'memory.recallChars', section: 'memory', scope: 'profile', type: 'number', default: 1200, min: 0, max: 8000, step: 100, label: '召回字符预算', widget: 'number' },
  { key: 'memory.recallTopK', section: 'memory', scope: 'profile', type: 'number', default: 6, min: 1, max: 30, step: 1, label: '召回条数', widget: 'number' },

  // ── kb ────────────────────────────────────────────────────
  { key: 'kb.enabled', section: 'kb', scope: 'profile', type: 'boolean', default: true, label: '启用知识库', widget: 'switch' },
  { key: 'kb.topK', section: 'kb', scope: 'profile', type: 'number', default: 5, min: 1, max: 20, step: 1, label: '检索条数', widget: 'number' },
  { key: 'kb.maxChars', section: 'kb', scope: 'profile', type: 'number', default: 1500, min: 200, max: 8000, step: 100, label: '注入字符预算', widget: 'number' },

  // ── vision ────────────────────────────────────────────────
  { key: 'vision.inlineImages', section: 'vision', scope: 'profile', type: 'boolean', default: true, label: '图片直接进上下文', widget: 'switch' },
  { key: 'vision.inlineMaxImages', section: 'vision', scope: 'profile', type: 'number', default: 4, min: 0, max: 10, step: 1, label: '每轮最多图片', widget: 'number' },
  { key: 'vision.inlineMaxBytes', section: 'vision', scope: 'profile', type: 'number', default: 20971520, min: 1048576, max: 104857600, step: 1048576, label: '图片总字节上限', widget: 'number' },

  // ── stickers ──────────────────────────────────────────────
  { key: 'stickers.enabled', section: 'stickers', scope: 'profile', type: 'boolean', default: true, label: '启用表情包', widget: 'switch' },
  { key: 'stickers.dailyQuota', section: 'stickers', scope: 'profile', type: 'number', default: 30, min: 0, max: 500, step: 1, label: '每日配额', widget: 'number' },

  // ── admin ─────────────────────────────────────────────────
  { key: 'admin.enabled', section: 'admin', scope: 'bot', type: 'boolean', default: false, label: '管理员命令门控', widget: 'switch' },
  { key: 'admin.openids', section: 'admin', scope: 'bot', type: 'stringArray', default: [], label: '管理员 openid', widget: 'tags' },

];

const BY_KEY = new Map(SETTINGS.map((item) => [item.key, item]));
const SECTION_BY_ID = new Map(SECTIONS.map((item) => [item.id, item]));

/** 取设置项定义。 */
export function settingOf(key) {
  return BY_KEY.get(key) || null;
}

/** 该 scope 允许出现的设置项。 */
function itemsForScopes(scopes) {
  const allow = new Set(scopes);
  return SETTINGS.filter((item) => allow.has(item.scope));
}

/** 由默认值生成嵌套对象。 */
export function defaults(scopes = ['global', 'bot', 'profile']) {
  const out = {};
  for (const item of itemsForScopes(scopes)) setPath(out, item.key, clone(item.default));
  return out;
}

/** 深度克隆（只处理 JSON 值）。 */
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

/** 设置嵌套值。 */
export function setPath(target, key, value) {
  const parts = key.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (node[part] === null || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
  return target;
}

/** 读取嵌套值。 */
export function getPath(target, key, fallback) {
  const parts = key.split('.');
  let node = target;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !(part in node)) return fallback;
    node = node[part];
  }
  return node === undefined ? fallback : node;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text !== '' && !out.includes(text)) out.push(text.slice(0, 500));
  }
  return out;
}

/**
 * 按 schema 归一化一层设置：类型纠正 + 边界截断 + enum 校验 + 未知键丢弃。
 * @param {object} input 原始对象（任意层）
 * @param {{scopes?: string[]}} [options] 允许的 scope 集合（global/bot/profile）
 * @returns {{value: object, warnings: string[]}}
 */
export function normalize(input, options = {}) {
  const scopes = Array.isArray(options.scopes) ? options.scopes : ['global', 'bot', 'profile'];
  const allowed = itemsForScopes(scopes);
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const value = {};
  const warnings = [];

  // 未知键：遍历叶子路径
  const known = new Set(allowed.map((item) => item.key));
  for (const leaf of leafPaths(src)) {
    if (!known.has(leaf)) warnings.push('未知设置项已忽略: ' + leaf);
  }

  for (const item of allowed) {
    const raw = getPath(src, item.key, undefined);
    if (raw === undefined) { setPath(value, item.key, clone(item.default)); continue; }
    const coerced = coerce(item, raw, warnings);
    setPath(value, item.key, coerced === undefined ? clone(item.default) : coerced);
  }
  return { value, warnings };
}

function coerce(item, raw, warnings) {
  switch (item.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      warnings.push(item.key + ' 需要布尔值，已回落默认');
      return undefined;
    case 'number': {
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(num)) { warnings.push(item.key + ' 需要数字，已回落默认'); return undefined; }
      let out = num;
      if (item.min !== undefined) out = Math.max(item.min, out);
      if (item.max !== undefined) out = Math.min(item.max, out);
      if (item.step !== undefined && item.step > 0) out = Math.round(out / item.step) * item.step;
      if (out !== num) warnings.push(item.key + ' 已按边界/步长调整为 ' + out);
      return out;
    }
    case 'string':
      if (typeof raw !== 'string') { warnings.push(item.key + ' 需要字符串，已回落默认'); return undefined; }
      return raw.slice(0, 4000);
    case 'enum': {
      const values = Array.isArray(item.values) ? item.values.map((v) => (typeof v === 'string' ? v : v.value)) : [];
      if (typeof raw === 'string' && values.includes(raw)) return raw;
      warnings.push(item.key + ' 取值不在枚举内，已回落默认');
      return undefined;
    }
    case 'stringArray': {
      const arr = asStringArray(raw);
      if (arr === null) { warnings.push(item.key + ' 需要字符串数组，已回落默认'); return undefined; }
      return arr;
    }
    case 'json': {
      if (raw === null || typeof raw !== 'object') { warnings.push(item.key + ' 需要 JSON 对象，已回落默认'); return undefined; }
      try { return JSON.parse(JSON.stringify(raw)); } catch { return undefined; }
    }
    default:
      return undefined;
  }
}

/** 收集对象的所有叶子路径。 */
export function leafPaths(input, prefix = '') {
  const out = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    if (prefix !== '') out.push(prefix);
    return out;
  }
  for (const key of Object.keys(input)) {
    const path = prefix === '' ? key : prefix + '.' + key;
    const child = input[key];
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) out.push(...leafPaths(child, path));
    else out.push(path);
  }
  return out;
}

/** 深合并：patch 里的叶子覆盖 base（对象递归，数组替换）。 */
export function deepMerge(base, patch) {
  const out = clone(base && typeof base === 'object' ? base : {});
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    const prev = out[key];
    if (next !== null && typeof next === 'object' && !Array.isArray(next)
      && prev !== null && typeof prev === 'object' && !Array.isArray(prev)) {
      out[key] = deepMerge(prev, next);
    } else {
      out[key] = clone(next);
    }
  }
  return out;
}

/** 给控制台的 UI 元数据（不含默认值里的敏感信息；本表无敏感项）。 */
export function schemaPayload() {
  return {
    sections: SECTIONS.slice().sort((a, b) => a.order - b.order),
    items: SETTINGS.map((item) => ({
      key: item.key,
      section: item.section,
      scope: item.scope,
      type: item.type,
      label: item.label,
      help: item.help || '',
      widget: item.widget || 'text',
      values: item.values || null,
      min: item.min ?? null,
      max: item.max ?? null,
      step: item.step ?? null,
      default: clone(item.default),
    })),
    sectionById: Object.fromEntries(SECTION_BY_ID),
  };
}