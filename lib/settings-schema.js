/**
 * settings-schema —— 设置页结构声明（单一真相）。
 *
 * 组织模型（v0.15 重设计）：**工作区（workspace）→ 页面（page）**。
 *   工作区回答一个用户问题（现在怎么样 / 怎么回话 / 能干什么 / 它是谁 / 攒了什么 / 谁能动它），
 *   页面是工作区里的一页一页设置，左栏可切换。只有一页的工作区不显示左栏。
 *
 * 设计取舍：
 *   - 每个功能只有一个"家"，不重复摆。例：
 *       · 「怎么把回复拆成多条」= 设置，在 对话 → 语气与格式；
 *       · 「怎么说话、说多长」= 提示词文本，在 提示词 → 说话方式；两页互相链接。
 *   - 安全红线属于"约束"，从提示词里移出，归到 权限 工作区；
 *   - 模型不再和"能力开关"混在一页，能力开关也不再叫"Agent"。
 *
 * 字段类型（简单设置项可只写 fields，由前端自动渲染）：
 *   switch / text / number / area / select（options: [{value,label}]）/ list
 *
 * 兼容：旧 tab id（reply / tools / persona / prompts / content ...）由 client/client.js
 * 的 VIEW_ALIASES 映射到新的 (工作区, 页面)。
 */

/** 工作区顺序（顶部导航）。 */
export const SETTINGS_GROUPS = Object.freeze([
  { id: 'runtime', label: '概览', desc: '连接、统计与运维' },
  { id: 'dialog', label: '对话', desc: '什么时候回、怎么回' },
  { id: 'ability', label: '能力', desc: '用哪个模型、开哪些工具' },
  { id: 'prompt', label: '提示词', desc: '它是谁、怎么说话' },
  { id: 'content', label: '内容', desc: '表情包与长期记忆' },
  { id: 'security', label: '权限', desc: '命令、管理员与安全红线' },
]);

/**
 * 工作区声明。
 *   icon     预留字段（当前 UI 不用图标，payload 里恒为空串）
 *   landing  进入该工作区时默认打开的页面（缺省取第一页）
 *   items    页面列表：{id, label, widget, desc, hotspot?}
 *            hotspot = 高频使用，左栏带圆点标记（只是提示，不改变顺序）
 */
export const SETTINGS_SECTIONS = Object.freeze([
  {
    id: 'overview',
    label: '概览',
    group: 'runtime',
    desc: '连接状态、扫码绑定、收发统计与维护操作',
    keywords: ['状态', '连接', '扫码', '绑定', '统计', '重启', '维护', '路径', '版本'],
    items: [
      { id: 'overview', label: '状态总览', widget: 'overview', desc: '连接、统计、生效策略、维护与运行路径', hotspot: true },
    ],
  },
  {
    id: 'dialog',
    label: '对话',
    group: 'dialog',
    desc: '什么时候回复、回复多快、怎么分条',
    keywords: ['频率', '概率', '自适应', '触发', '@', '关键词', '气泡', '私聊', '群聊', '节奏'],
    landing: 'reply',
    items: [
      { id: 'reply', label: '回复策略', widget: 'frequency', desc: '总开关、群聊/私聊策略与节奏参数', hotspot: true },
      { id: 'triggers', label: '触发规则', widget: 'triggers', desc: '@、引用回复、必回关键词', hotspot: true },
      { id: 'messageStyle', label: '语气与分条', widget: 'messageStyle', desc: '气泡拆分开关 + 消息格式与群聊节奏提示词' },
    ],
  },
  {
    id: 'ability',
    label: '能力',
    group: 'ability',
    desc: '模型路由、能力边界、技能与工具放行',
    settingsPath: 'tools',
    keywords: ['能力', '工具', '技能', 'shell', 'imagegen', '模型', 'provider', '预设', '放行'],
    landing: 'model',
    items: [
      { id: 'model', label: '模型与预设', widget: 'model', desc: 'provider / model / 推理强度与 Agent 预设', hotspot: true },
      { id: 'tools', label: '能力与工具', widget: 'tools', desc: '能力开关、技能白名单、未归类工具放行', hotspot: true },
    ],
  },
  {
    id: 'prompts',
    label: '提示词',
    group: 'prompt',
    desc: '它是谁、怎么说话、记得什么',
    settingsPath: 'prompts',
    keywords: ['提示词', '分段', '顺序', '人设', '人格卡', '口头禅', '工具约定', '预览'],
    landing: 'promptOrder',
    items: [
      { id: 'promptOrder', label: '组装顺序', widget: 'promptOrder', desc: '看 12 段各在第几位、本次是否注入', hotspot: true },
      { id: 'identity', label: '身份与人格', widget: 'persona', desc: '人设正文、人格卡、人设模式与场景补充', hotspot: true },
      { id: 'speech', label: '说话方式', widget: 'speech', desc: '消息格式与长短 + 群聊节奏' },
      { id: 'phrases', label: '口头禅', widget: 'phrases', desc: '从对话里学到的口癖' },
      { id: 'toolGuide', label: '工具约定', widget: 'toolGuide', desc: '每个工具该怎么用' },
      { id: 'finalPrompt', label: '最终提示词', widget: 'promptFinal', desc: '拼好的完整 prompt（只读，用来校验）' },
    ],
  },
  {
    id: 'content',
    label: '内容',
    group: 'content',
    desc: '表情库与长期记忆',
    keywords: ['表情', '收藏', '记忆', '自我改进', '提炼', '手记'],
    landing: 'stickers',
    items: [
      { id: 'stickers', label: '表情包', widget: 'stickers', desc: '使用规则、表情库、收藏上限与上传', hotspot: true },
      { id: 'memory', label: '记忆与自我改进', widget: 'memory', desc: '记忆注入、记忆文件、自动提炼与 prompt 预览', hotspot: true },
    ],
  },
  {
    id: 'security',
    label: '权限',
    group: 'security',
    desc: 'QQ 命令、管理员与安全红线',
    settingsPath: 'admin',
    keywords: ['命令', '管理员', '权限', 'openid', '安全', '红线'],
    landing: 'commands',
    items: [
      { id: 'commands', label: '命令与管理员', widget: 'commands', desc: '全部 / 命令；谁可以执行会改变状态的命令', hotspot: true },
      { id: 'safety', label: '安全红线', widget: 'safety', desc: '不泄露密钥配置、不越权操作' },
    ],
  },
]);

const BY_ID = new Map(SETTINGS_SECTIONS.map((item) => [item.id, item]));

/** 页面 id -> {section, item}（跨工作区反查）。 */
const ITEM_INDEX = new Map();
for (const section of SETTINGS_SECTIONS) {
  for (const item of section.items || []) ITEM_INDEX.set(item.id, { section: section, item: item });
}

/** 取单个工作区声明。 */
export function getSection(id) {
  return BY_ID.get(id) || null;
}

/** 取单个页面声明（含所属工作区）。 */
export function getItem(id) {
  const hit = ITEM_INDEX.get(id);
  if (!hit) return null;
  return {
    id: hit.item.id,
    label: hit.item.label,
    widget: hit.item.widget || '',
    desc: hit.item.desc || '',
    hotspot: hit.item.hotspot === true,
    sectionId: hit.section.id,
    group: hit.section.group,
  };
}

/** 工作区的落地页 id。 */
export function landingOf(sectionId) {
  const section = BY_ID.get(sectionId);
  if (!section) return null;
  const items = Array.isArray(section.items) ? section.items : [];
  if (section.landing && items.some((item) => item.id === section.landing)) return section.landing;
  return items.length > 0 ? items[0].id : null;
}

/** 导出给前端的最小结构（去掉函数等不可序列化内容）。 */
export function schemaPayload() {
  return {
    version: 2,
    groups: SETTINGS_GROUPS.map((item) => ({
      id: item.id,
      label: item.label,
      icon: item.icon || '',
      desc: item.desc || '',
    })),
    sections: SETTINGS_SECTIONS.map((item) => {
      const items = Array.isArray(item.items) ? item.items : [];
      return {
        id: item.id,
        label: item.label,
        group: item.group,
        icon: item.icon || '',
        desc: item.desc || '',
        widget: item.widget || '',
        landing: landingOf(item.id) || '',
        keywords: Array.isArray(item.keywords) ? item.keywords.slice() : [],
        items: items.map((child) => ({
          id: child.id,
          label: child.label,
          widget: child.widget || '',
          desc: child.desc || '',
          hotspot: child.hotspot === true,
        })),
        // 兼容旧字段名：旧客户端读 children 也能拿到页面列表
        children: items.map((child) => ({
          id: child.id,
          label: child.label,
          widget: child.widget || '',
          desc: child.desc || '',
        })),
        fields: Array.isArray(item.fields) ? item.fields.map((field) => ({ ...field })) : [],
      };
    }),
  };
}

export default SETTINGS_SECTIONS;
