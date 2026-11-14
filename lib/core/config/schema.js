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

/**
 * 一级分组：配置档编辑器顶部的组 tab。
 *
 * 分节（SECTIONS）是字段粒度的唯一真相；组只是 UI 收敛层，不参与权限与存储。
 * 15 个分节直接平铺成 15 个 tab 太碎，这里按「用户心智」合并成 5 组；
 * 组内仍按分节顺序纵向堆叠（分节标题 + 说明保留）。
 */
export const GROUPS = [
  { id: 'dialog', label: '对话与人设', order: 10, desc: '什么时候回、回多快，以及机器人的人设语气' },
  { id: 'model', label: '模型与语音', order: 20, desc: '对话模型、视觉理解、语音合成与语音识别' },
  { id: 'capability', label: '能力与权限', order: 30, desc: '工具与技能白名单、表情包，以及管理员命令门控' },
  { id: 'data', label: '记忆与数据', order: 40, desc: '长期记忆、消息流水、知识库与群友画像' },
  { id: 'daily', label: '群日报', order: 50, desc: '每天定时总结群聊，并按互动调整群友关系' },
];

/** 分节定义（组内分节：控制台表单的分节标题与说明）。 */
export const SECTIONS = [
  { id: 'reply', group: 'dialog', label: '回复与触发', order: 10, desc: '什么时候回、回多快、连发怎么拆' },
  { id: 'persona', group: 'dialog', label: '人设与提示', order: 20, desc: '人格、提示段与运行时上下文' },
  { id: 'model', group: 'model', label: '模型', order: 30, desc: 'provider / model / 推理强度' },
  { id: 'tools', group: 'capability', label: '工具与技能', order: 40, desc: '能力白名单与外部工具放行' },
  { id: 'memory', group: 'data', label: '记忆', order: 50, desc: '长期记忆的采集与召回' },
  { id: 'messages', group: 'data', label: '消息记录', order: 55, desc: '消息流水的保存与检索' },
  { id: 'kb', group: 'data', label: '知识库', order: 60, desc: '知识检索参数' },
  { id: 'members', group: 'data', label: '群友库', order: 65, desc: '群友画像注入（只注入发言人/被提到的人）' },
  { id: 'vision', group: 'model', label: '视觉', order: 70, desc: '图片入上下文、视觉模型来源与兜底' },
  { id: 'voice', group: 'model', label: '语音（TTS）', order: 75, desc: '文字转语音的供应商、音色与时长控制' },
  { id: 'asr', group: 'model', label: '语音识别（ASR）', order: 76, desc: '把收到的 QQ 语音转成文字（DeepSeek 官方 ASR，失败回退 QQ 自带识别）' },
  { id: 'stickers', group: 'capability', label: '表情包', order: 80, desc: '收藏、配额与发送频率' },
  { id: 'daily', group: 'daily', label: '群日报', order: 82, desc: '每天定时总结群聊并主动发送' },
  { id: 'relation', group: 'daily', label: '关系增量', order: 84, desc: '根据每天互动调整群友关系档位' },
  { id: 'admin', group: 'capability', label: '命令与权限', order: 35, desc: '管理员命令门控（跟着配置档走）' },
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
    optionsFrom: 'llmProviders', help: '留空跟随宿主默认；候选来自宿主 llm 服务' },
  { key: 'model.model', section: 'model', scope: 'profile', type: 'string', default: '', label: 'model', widget: 'select',
    optionsFrom: 'llmModels', help: '留空跟随宿主默认；候选来自宿主模型目录' },
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
    help: '{ "workspace": true, "web": true, "memory": true, "messages": true, "stickers": true, "vision": true, "voice": false, "skills": false, "imagegen": false, "shell": false }（shell=命令执行，默认关；messages=历史消息检索；voice=语音合成，默认关）' },
  { key: 'tools.tiers', section: 'tools', scope: 'profile', type: 'json', default: {}, label: '工具档位',
    widget: 'json',
    help: '{ "工具名或能力组": "active" 或 "passive" }。active=常驻声明；passive=默认不挂载、用户点名或 qqbot_enable 点亮。留空使用内置分档（生图/语音/卡片/文件/命令默认为 passive）' },
  { key: 'tools.skillsMode', section: 'tools', scope: 'profile', type: 'enum', default: 'allow', label: '技能过滤模式', widget: 'radio',
    values: [{ value: 'all', label: '全部可见' }, { value: 'allow', label: '仅白名单' }] },
  { key: 'tools.skills', section: 'tools', scope: 'profile', type: 'stringArray', default: [], label: '可见技能', widget: 'tags' },

  // ── memory ────────────────────────────────────────────────
  { key: 'memory.enabled', section: 'memory', scope: 'profile', type: 'boolean', default: true, label: '启用长期记忆', widget: 'switch' },
  { key: 'memory.autoExtractEvery', section: 'memory', scope: 'profile', type: 'number', default: 10, min: 0, max: 1000, step: 1, label: '每 N 轮自动提炼', widget: 'number',
    help: '0 = 关闭自动提炼' },
  { key: 'memory.recallChars', section: 'memory', scope: 'profile', type: 'number', default: 1200, min: 0, max: 8000, step: 100, label: '召回字符预算', widget: 'number' },
  { key: 'memory.recallTopK', section: 'memory', scope: 'profile', type: 'number', default: 6, min: 1, max: 30, step: 1, label: '召回条数', widget: 'number' },

  // ── messages ──────────────────────────────────────────────
  { key: 'messages.enabled', section: 'messages', scope: 'profile', type: 'boolean', default: true, label: '记录消息流水', widget: 'switch',
    help: '消息流水总开关；关闭后下面两类都不记录' },
  { key: 'messages.captureFlow', section: 'messages', scope: 'profile', type: 'boolean', default: true, label: '记录全量群消息', widget: 'switch',
    help: '群里的每条消息都写入本地 SQLite（含没 @ 机器人的发言），供群分析/日报使用；关闭后只记触发回复的轮次' },
  { key: 'messages.flowRetainDays', section: 'messages', scope: 'profile', type: 'number', default: 14, min: 1, max: 365, step: 1, label: '群消息保留天数', widget: 'number',
    help: '全量群消息流水的保留期，与「保留天数」分开；默认 14 天' },
  { key: 'messages.retainDays', section: 'messages', scope: 'profile', type: 'number', default: 14, min: 1, max: 365, step: 1, label: '保留天数', widget: 'number',
    help: '超过这个天数的对话轮次会被定期清理；默认 14 天（两周）' },
  { key: 'messages.searchLimit', section: 'messages', scope: 'profile', type: 'number', default: 20, min: 1, max: 100, step: 1, label: '检索返回条数', widget: 'number' },

  // ── kb ────────────────────────────────────────────────────
  { key: 'kb.enabled', section: 'kb', scope: 'profile', type: 'boolean', default: true, label: '启用知识库', widget: 'switch' },
  { key: 'kb.topK', section: 'kb', scope: 'profile', type: 'number', default: 5, min: 1, max: 20, step: 1, label: '检索条数', widget: 'number' },
  { key: 'kb.maxChars', section: 'kb', scope: 'profile', type: 'number', default: 1500, min: 200, max: 8000, step: 100, label: '注入字符预算', widget: 'number' },

  // ── members ───────────────────────────────────────────────
  { key: 'members.enabled', section: 'members', scope: 'profile', type: 'boolean', default: true, label: '注入群友库', widget: 'switch',
    help: '只注入当前发言人 + 本条消息里被提到的人（懒加载，不整库灌 prompt）' },
  { key: 'members.injectSender', section: 'members', scope: 'profile', type: 'boolean', default: true, label: '注入发言人画像', widget: 'switch' },
  { key: 'members.maxPerTurn', section: 'members', scope: 'profile', type: 'number', default: 3, min: 1, max: 6, step: 1, label: '每轮最多群友', widget: 'number' },
  { key: 'members.maxChars', section: 'members', scope: 'profile', type: 'number', default: 800, min: 200, max: 4000, step: 100, label: '群友段字符预算', widget: 'number' },

  // ── vision ────────────────────────────────────────────────
  { key: 'vision.mode', section: 'vision', scope: 'profile', type: 'enum', default: 'llm', label: '视觉模型来源', widget: 'radio',
    values: [
      { value: 'llm', label: '跟随 LLM 自带视觉' },
      { value: 'dedicated', label: '独立视觉模型（更精细）' },
    ],
    help: '跟随 LLM = 当前的内联视觉输入（图片直接进对话上下文）；独立视觉模型 = 图片不内联，改由下方指定的更精细模型通过 qqbot_describe_image 阅读' },
  { key: 'vision.provider', section: 'vision', scope: 'profile', type: 'string', default: '', label: '视觉 provider', widget: 'select',
    optionsFrom: 'llmProviders', help: '留空跟随宿主默认；qqbot_describe_image 与「独立视觉模型」模式都使用它' },
  { key: 'vision.model', section: 'vision', scope: 'profile', type: 'string', default: '', label: '视觉 model', widget: 'select',
    optionsFrom: 'llmModels', help: '留空跟随宿主默认；qqbot_describe_image 与「独立视觉模型」模式都使用它' },
  { key: 'vision.maxTokens', section: 'vision', scope: 'profile', type: 'number', default: 4096, min: 256, max: 32768, step: 256, label: '视觉输出 token 上限', widget: 'number',
    help: '对需要推理的图（长截图/几何题）建议 ≥4096' },
  { key: 'vision.inlineImages', section: 'vision', scope: 'profile', type: 'boolean', default: true, label: '图片直接进上下文', widget: 'switch',
    help: '「跟随 LLM」模式下生效；「独立视觉模型」模式会强制关闭内联' },
  { key: 'vision.inlineMaxImages', section: 'vision', scope: 'profile', type: 'number', default: 4, min: 0, max: 10, step: 1, label: '每轮最多图片', widget: 'number' },
  { key: 'vision.inlineMaxBytes', section: 'vision', scope: 'profile', type: 'number', default: 20971520, min: 1048576, max: 104857600, step: 1048576, label: '图片总字节上限', widget: 'number' },

  // ── voice（TTS）───────────────────────────────────────────
  { key: 'voice.enabled', section: 'voice', scope: 'profile', type: 'boolean', default: false, label: '启用语音（TTS）', widget: 'switch',
    help: '开启后模型可用 qqbot_speak 把文字合成语音发到 QQ；默认关闭，避免无谓调用' },
  { key: 'voice.provider', section: 'voice', scope: 'profile', type: 'string', default: '', label: 'TTS 供应商', widget: 'select',
    optionsFrom: 'ttsProviders', help: '留空跟随全局默认供应商；供应商在「模型 → 语音」页的配置面板里维护' },
  { key: 'voice.defaultProvider', section: 'voice', scope: 'global', type: 'string', default: '', label: '默认 TTS 供应商（全局）', widget: 'select',
    optionsFrom: 'ttsProviders', help: '配置档没有显式选择时使用它；留空则用第一个启用的供应商' },
  { key: 'voice.voice', section: 'voice', scope: 'profile', type: 'string', default: '', label: '音色覆盖', widget: 'text',
    help: '留空使用供应商默认音色；例如 zh-CN-XiaoxiaoNeural / Cherry / mimo_default' },
  { key: 'voice.style', section: 'voice', scope: 'profile', type: 'string', default: '', label: '风格指令', widget: 'textarea',
    help: 'MiMo 等支持自然语言风格控制的供应商会作为 user 指令（如「活泼、语速偏快、带笑意」）' },
  { key: 'voice.speed', section: 'voice', scope: 'profile', type: 'number', default: 1, min: 0.5, max: 2, step: 0.05, label: '语速', widget: 'number' },
  { key: 'voice.maxChars', section: 'voice', scope: 'profile', type: 'number', default: 300, min: 20, max: 2000, step: 10, label: '单次文字上限', widget: 'number',
    help: '超出会截断（并提示模型），避免语音过长/费用过高' },

  // ── asr（语音识别）─────────────────────────────────────────
  { key: 'asr.enabled', section: 'asr', scope: 'profile', type: 'boolean', default: false, label: '启用语音识别（ASR）', widget: 'switch',
    help: '开启后收到的 QQ 语音会先用 ASR 供应商转成文字；失败/未配置时回退 QQ 自带识别文本（asr_refer_text）' },
  { key: 'asr.mode', section: 'asr', scope: 'profile', type: 'enum', default: 'fallback', label: 'ASR 使用策略', widget: 'radio',
    values: [
      { value: 'fallback', label: '仅在 QQ 无识别文本时使用' },
      { value: 'always', label: '总是使用插件 ASR（覆盖 QQ 文本）' },
    ],
    help: 'fallback：QQ 自带识别有文本就用它，缺失时才调用插件 ASR；always：每条语音都调用插件 ASR，失败再回退 QQ 文本' },
  { key: 'asr.provider', section: 'asr', scope: 'profile', type: 'string', default: '', label: 'ASR 供应商', widget: 'select',
    optionsFrom: 'asrProviders', help: '留空跟随全局默认；供应商在「模型 → 语音」页的「语音识别（ASR）」区块维护' },
  { key: 'asr.defaultProvider', section: 'asr', scope: 'global', type: 'string', default: '', label: '默认 ASR 供应商（全局）', widget: 'select',
    optionsFrom: 'asrProviders', help: '配置档没有显式选择时使用；留空则用第一个启用的 ASR 供应商' },
  { key: 'asr.maxSeconds', section: 'asr', scope: 'global', type: 'number', default: 120, min: 5, max: 120, step: 5, label: '最长语音时长（秒）', widget: 'number',
    help: 'DeepSeek ASR 单次上限 120 秒；超长语音直接回退 QQ 文本，避免识别失败/超时' },

  // ── stickers ──────────────────────────────────────────────
  { key: 'stickers.enabled', section: 'stickers', scope: 'profile', type: 'boolean', default: true, label: '启用表情包', widget: 'switch' },
  { key: 'stickers.dailyQuota', section: 'stickers', scope: 'profile', type: 'number', default: 30, min: 0, max: 500, step: 1, label: '每日配额', widget: 'number' },

  // ── admin ─────────────────────────────────────────────────
  // 门控跟着配置档走：同一个群换了配置档就换了管理员名单（openid 本身仍按 bot 的 AppID 解析）。
  { key: 'admin.enabled', section: 'admin', scope: 'profile', type: 'boolean', default: true, label: '管理员命令门控', widget: 'switch',
    help: '默认开启：只要名单里有 openid，管理员命令就只对名单内的人开放；名单为空时不强制（谁都能用），所以先加人即生效。' },
  { key: 'admin.openids', section: 'admin', scope: 'profile', type: 'stringArray', default: [], label: '管理员 openid', widget: 'tags' },

  // ── daily（群日报）─────────────────────────────────────────
  // 跟着配置档走：同一个群换了配置档，日报开关/时间/范围也跟着换。
  { key: 'daily.enabled', section: 'daily', scope: 'profile', type: 'boolean', default: false, label: '启用群日报', widget: 'switch',
    help: '每天在设定时间生成群聊总结并主动发到群里；需要 QQ 主动消息权限，失败只记日志' },
  { key: 'daily.time', section: 'daily', scope: 'profile', type: 'string', default: '23:30', label: '生成时间', widget: 'text',
    help: '本地时间 HH:MM（24 小时制），默认 23:30' },
  { key: 'daily.peers', section: 'daily', scope: 'profile', type: 'stringArray', default: [], label: '作用群聊', widget: 'tags',
    help: '群 openid 或 group:<openid>；留空 = 最近 36 小时活跃的所有群。建议只填要发日报的群' },
  { key: 'daily.minMessages', section: 'daily', scope: 'profile', type: 'number', default: 20, min: 1, max: 500, step: 1, label: '最少消息数', widget: 'number',
    help: '当天消息少于此数就跳过（不发空日报）' },
  { key: 'daily.maxMessages', section: 'daily', scope: 'profile', type: 'number', default: 300, min: 20, max: 1000, step: 10, label: '抽样上限', widget: 'number',
    help: '送进模型的消息条数上限（按时间均匀抽样），控制 token' },
  { key: 'daily.catchUp', section: 'daily', scope: 'profile', type: 'boolean', default: true, label: '错过补跑', widget: 'switch',
    help: '进程在设定时间没运行时，启动后 6 小时内仍会补生成当天日报' },
  { key: 'daily.delivery', section: 'daily', scope: 'profile', type: 'enum', default: 'proactive', label: '投递方式', widget: 'radio',
    values: [
      { value: 'proactive', label: '主动发群（需权限）' },
      { value: 'off', label: '只生成不发送' },
    ],
    help: '主动消息受 QQ 平台权限/额度限制；失败只记日志，报告仍可在控制台查看' },
  { key: 'daily.template', section: 'daily', scope: 'profile', type: 'enum', default: 'journal', label: '卡片模板', widget: 'select',
    // allowCustom：除内置外还接受自定义模板名（<dataDir>/templates/<名字>/index.html），
    // 控制台会把这些模板追加进候选项（见 console/api/schema.js）。
    allowCustom: true,
    values: [
      { value: 'journal', label: '纸刊 · 暖色' },
      { value: 'dark', label: '深色 · 数据' },
      { value: 'off', label: '只发文本' },
    ],
    help: '内置 journal / dark；自定义模板放 <dataDir>/templates/<名字>/index.html，刷新控制台即可选；off 只发文本' },
  { key: 'daily.visualMode', section: 'daily', scope: 'profile', type: 'enum', default: 'auto', label: '插画氛围', widget: 'radio',
    values: [
      { value: 'auto', label: '模型选择 / 按时段' },
      { value: 'random', label: '每天随机' },
      { value: 'fixed', label: '固定指定' },
    ],
    help: '只对声明了插画槽的模板生效：auto=日报模型自己选，没选按高峰时段兜底；random=每天从模板氛围里随机一组；fixed=固定用「指定氛围」' },
  { key: 'daily.visualMood', section: 'daily', scope: 'profile', type: 'string', default: '', label: '指定氛围', widget: 'text',
    help: '仅「固定指定」生效：填模板 meta.json 里声明的氛围 id（例如 lively / calm / night，以模板声明为准）；非法或留空则回退跟随模型' },

  // ── relation（关系增量）────────────────────────────────────
  { key: 'relation.enabled', section: 'relation', scope: 'profile', type: 'boolean', default: false, label: '启用关系增量', widget: 'switch',
    help: '每天日报生成后，根据当天互动调整群友的 affinity（-2..2）；写入有冷却与证据校验' },
  { key: 'relation.allowManual', section: 'relation', scope: 'profile', type: 'boolean', default: false, label: '允许调整人工画像', widget: 'switch',
    help: '默认不改 profileSource=manual 的群友（例如你自己手动标的备注）' },

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

  // 未知键：遍历叶子路径（json 型设置项允许任意子路径，不算未知）
  const known = new Set(allowed.map((item) => item.key));
  const jsonKeys = allowed.filter((item) => item.type === 'json').map((item) => item.key);
  for (const leaf of leafPaths(src)) {
    if (known.has(leaf)) continue;
    if (jsonKeys.some((key) => leaf.startsWith(key + '.'))) continue;
    warnings.push('未知设置项已忽略: ' + leaf);
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
      if (item.step !== undefined && item.step > 0) {
        // 按步长小数位取整，避免 0.3/0.05 这类浮点尾数（0.30000000000000004）
        const decimals = (String(item.step).split('.')[1] || '').length;
        out = Number((Math.round(out / item.step) * item.step).toFixed(decimals));
      }
      if (out !== num) warnings.push(item.key + ' 已按边界/步长调整为 ' + out);
      return out;
    }
    case 'string':
      if (typeof raw !== 'string') { warnings.push(item.key + ' 需要字符串，已回落默认'); return undefined; }
      return raw.slice(0, 4000);
    case 'enum': {
      const values = Array.isArray(item.values) ? item.values.map((v) => (typeof v === 'string' ? v : v.value)) : [];
      if (typeof raw === 'string' && values.includes(raw)) return raw;
      // 允许自定义模板名一类的扩展值：只接受安全 slug，避免把路径写进配置。
      if (typeof raw === 'string' && item.allowCustom === true && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(raw)) return raw;
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
    groups: GROUPS.slice().sort((a, b) => a.order - b.order),
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
      allowCustom: item.allowCustom === true,
      optionsFrom: item.optionsFrom || null,
      min: item.min ?? null,
      max: item.max ?? null,
      step: item.step ?? null,
      default: clone(item.default),
    })),
    sectionById: Object.fromEntries(SECTION_BY_ID),
  };
}