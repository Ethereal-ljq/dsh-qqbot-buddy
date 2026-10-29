/**
 * prompt-sections —— 提示词分段注册表 + 组装顺序（单一真相）。
 *
 * 背景：原来 compose() 里用一串 if 顺序 push，段与段的先后是"写代码的顺序"，
 * 既不可独立配置，也不考虑模型注意力（中段内容最容易被忽略）。
 *
 * 现在每个段都声明：
 *   id        稳定标识（设置里按 id 覆盖/开关）
 *   label     中文名（设置页）
 *   priority  重要性 0-100（越大越重要）
 *   storage   该段文本存在哪里（persona | prompts.<key> | memory.<key> | behavior | dynamic）
 *   render()  产出文本（返回空串表示本次不注入）
 *
 * 组装时按 priority 降序，再把序列交替分配到**首部与尾部**，
 * 让最重要的内容落在开头和结尾（primacy + recency），次要的留在中间。
 */

/** 段定义（顺序无关，组装时按 priority 排）。 */
export const PROMPT_SECTIONS = Object.freeze([
  {
    id: 'identity',
    label: '人设（身份与性格）',
    priority: 100,
    storage: 'persona',
    note: '决定"你是谁、什么脾气"，来自 persona.md（或人格卡）。',
  },
  {
    id: 'safety',
    label: '安全红线',
    priority: 95,
    storage: 'builtin',
    note: '不泄露密钥/配置、不越权操作；内置固定文案。',
  },
  {
    id: 'extraInstructions',
    label: '额外指令',
    priority: 90,
    storage: 'behavior',
    note: '临时补充要求，优先于普通行为规则。',
  },
  {
    id: 'capabilities',
    label: '能力边界',
    priority: 85,
    storage: 'dynamic',
    note: '按已启用能力自动生成（能做什么）。',
  },
  {
    id: 'toolGuide',
    label: '工具使用约定',
    priority: 80,
    storage: 'prompts.toolGuide',
    note: '每个工具该怎么用。',
  },
  {
    id: 'sendGuide',
    label: '消息格式与长短',
    priority: 70,
    storage: 'prompts.sendGuide',
    note: '怎么说话、分几条、emoji。',
  },
  {
    id: 'rhythmGuide',
    label: '群聊节奏',
    priority: 65,
    storage: 'prompts.rhythmGuide',
    note: '什么时候该接话。',
  },
  {
    id: 'skills',
    label: '技能清单',
    priority: 60,
    storage: 'dynamic',
    note: '当前可见技能，按白名单自动生成。',
  },
  {
    id: 'memory',
    label: '长期记忆',
    priority: 55,
    storage: 'memory',
    note: '记忆注入 + 自我改进规则。',
  },
  {
    id: 'scopeExtra',
    label: '群聊/私聊专属补充',
    priority: 50,
    storage: 'persona.scopeExtra',
    note: '只在群聊或只在私聊生效的补充说明。',
  },
  {
    id: 'phrases',
    label: '口头禅',
    priority: 40,
    storage: 'phrases',
    note: '从对话里学到的口癖。',
  },
  {
    id: 'stickers',
    label: '表情包规则与库',
    priority: 35,
    storage: 'prompts.stickerGuide',
    note: '表情包怎么用 + 当前表情库目录。',
  },
]);

const BY_ID = new Map(PROMPT_SECTIONS.map((item) => [item.id, item]));

/** 取段定义。 */
export function getSection(id) {
  return BY_ID.get(id) || null;
}

/**
 * 按重要性排布：最重要的放开头和结尾，次要的放中间。
 *
 * 算法：priority 降序后，按下标奇偶分到 head/tail 两组，
 * head 正序在前、tail 逆序在后，于是：
 *   第 1 重要 -> 最前
 *   第 2 重要 -> 最后
 *   第 3 重要 -> 第 2 位
 *   第 4 重要 -> 倒数第 2 位
 * @param {Array<{priority:number}>} sections
 * @returns {Array} 排好序的副本
 */
export function orderSections(sections) {
  const sorted = sections.slice().sort((a, b) => {
    const pa = Number(a && a.priority) || 0;
    const pb = Number(b && b.priority) || 0;
    return pb - pa;
  });
  const head = [];
  const tail = [];
  sorted.forEach((item, index) => {
    if (index % 2 === 0) head.push(item);
    else tail.push(item);
  });
  return head.concat(tail.reverse());
}

/**
 * 读取某段的用户覆盖（settings.prompts.sections[id]）。
 * @param {object} cfg settings 快照
 * @param {string} id 段 id
 * @returns {{enabled:boolean, text:string}}
 */
export function readSectionOverride(cfg, id) {
  const prompts = cfg && cfg.prompts && typeof cfg.prompts === 'object' ? cfg.prompts : {};
  const sections = prompts.sections && typeof prompts.sections === 'object' ? prompts.sections : {};
  const entry = sections[id] && typeof sections[id] === 'object' ? sections[id] : {};
  return {
    enabled: entry.enabled !== false,
    text: typeof entry.text === 'string' ? entry.text : '',
  };
}

/** 稳定的默认优先级（设置页展示 / 恢复默认用）。 */
export function sectionDefaults() {
  return PROMPT_SECTIONS.map((item) => ({
    id: item.id,
    label: item.label,
    priority: item.priority,
    storage: item.storage,
    note: item.note,
  }));
}

export default PROMPT_SECTIONS;
