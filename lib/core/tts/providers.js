/**
 * core/tts/providers —— TTS 供应商「种类（kind）」的唯一真相。
 *
 * 这里只放**纯声明 + 纯函数**，不 import 任何其它模块，四类消费者共用：
 *   1. lib/core/tts/store.js      —— 按 kinds 校验/归一化 provider 配置；
 *   2. lib/core/tts/index.js      —— 按 kind 找适配器、分段/格式等策略；
 *   3. lib/console/api/models.js  —— GET /api/models/tts/kinds 给前端渲染表单；
 *   4. 控制台前端                  —— 用 fields 元数据通用渲染「新增/编辑供应商」抽屉。
 *
 * 新增一种供应商 = 在这里加一个 kind + 在 lib/core/tts/adapters/ 加一个适配器，
 * 控制台表单与 API 自动获得，不需要改前端。
 *
 * 安全约定：config 里**只放非敏感配置**；API Key 等一律走 secret 字段（单独存储、
 * 只写不读）。自定义 HTTP 若需要额外鉴权头，用 secretHeader/secretPrefix 注入，
 * 不要把密钥写进 headers JSON。
 */

/** 常用中文音色（Edge TTS）。 */
const EDGE_VOICES = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女 · 大陆' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女 · 大陆' },
  { value: 'zh-CN-YunxiNeural', label: '云希 · 男 · 大陆' },
  { value: 'zh-CN-YunyangNeural', label: '云扬 · 男 · 新闻' },
  { value: 'zh-CN-YunjianNeural', label: '云健 · 男 · 体育' },
  { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 女 · 东北' },
  { value: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 女 · 陕西' },
  { value: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 女 · 台湾' },
  { value: 'zh-HK-HiuMaanNeural', label: '曉曼 · 女 · 粤语' },
  { value: 'en-US-AriaNeural', label: 'Aria · 女 · 英语' },
  { value: 'en-US-GuyNeural', label: 'Guy · 男 · 英语' },
];

/** MiMo 内置音色。 */
const MIMO_VOICES = [
  { value: 'mimo_default', label: '默认（mimo_default）' },
  { value: '冰糖', label: '冰糖 · 女 · 中文' },
  { value: '茉莉', label: '茉莉 · 女 · 中文' },
  { value: '苏打', label: '苏打 · 男 · 中文' },
  { value: '白桦', label: '白桦 · 男 · 中文' },
  { value: 'Mia', label: 'Mia · 女 · 英语' },
  { value: 'Chloe', label: 'Chloe · 女 · 英语' },
  { value: 'Milo', label: 'Milo · 男 · 英语' },
  { value: 'Dean', label: 'Dean · 男 · 英语' },
];

/** 百炼 Qwen-TTS 常见音色。 */
const BAILIAN_VOICES = [
  { value: 'Cherry', label: 'Cherry · 女 · 中英' },
  { value: 'Serena', label: 'Serena · 女 · 中文' },
  { value: 'Ethan', label: 'Ethan · 男 · 中英' },
  { value: 'Chelsie', label: 'Chelsie · 女 · 中英' },
  { value: 'Dylan', label: 'Dylan · 男 · 中文' },
  { value: 'Jada', label: 'Jada · 女 · 中文' },
  { value: 'Sunny', label: 'Sunny · 女 · 中文' },
  { value: 'Nofish', label: 'Nofish · 男 · 中文' },
];

/** OpenAI 兼容 /audio/speech 常见音色。 */
const OPENAI_VOICES = [
  { value: 'alloy', label: 'alloy' },
  { value: 'echo', label: 'echo' },
  { value: 'fable', label: 'fable' },
  { value: 'onyx', label: 'onyx' },
  { value: 'nova', label: 'nova' },
  { value: 'shimmer', label: 'shimmer' },
  { value: 'coral', label: 'coral' },
  { value: 'sage', label: 'sage' },
];

const LANGUAGES = [
  { value: 'Auto', label: '自动' },
  { value: 'Chinese', label: '中文' },
  { value: 'English', label: '英语' },
  { value: 'Japanese', label: '日语' },
  { value: 'Korean', label: '韩语' },
  { value: 'French', label: '法语' },
  { value: 'German', label: '德语' },
  { value: 'Spanish', label: '西班牙语' },
  { value: 'Italian', label: '意大利语' },
  { value: 'Portuguese', label: '葡萄牙语' },
  { value: 'Russian', label: '俄语' },
];

/** MiniMax 系统音色（常用子集，完整列表见官方「系统音色列表」）。 */
const MINIMAX_VOICES = [
  { value: 'female-shaonv', label: '少女音色 · 女 · 中文' },
  { value: 'female-yujie', label: '御姐音色 · 女 · 中文' },
  { value: 'female-tianmei', label: '甜美女性音色 · 女 · 中文' },
  { value: 'female-chengshu', label: '成熟女性音色 · 女 · 中文' },
  { value: 'male-qn-qingse', label: '青涩青年音色 · 男 · 中文' },
  { value: 'male-qn-jingying', label: '精英青年音色 · 男 · 中文' },
  { value: 'male-qn-badao', label: '霸道青年音色 · 男 · 中文' },
  { value: 'male-qn-daxuesheng', label: '青年大学生音色 · 男 · 中文' },
  { value: 'lovely_girl', label: '萌萌女童 · 中文' },
  { value: 'clever_boy', label: '聪明男童 · 中文' },
  { value: 'cute_boy', label: '可爱男童 · 中文' },
  { value: 'English_Graceful_Lady', label: 'Graceful Lady · 女 · 英语' },
  { value: 'English_radiant_girl', label: 'Radiant Girl · 女 · 英语' },
  { value: 'English_Persuasive_Man', label: 'Persuasive Man · 男 · 英语' },
];

/** MiniMax T2A 模型。 */
const MINIMAX_MODELS = [
  { value: 'speech-2.8-hd', label: 'speech-2.8-hd · 最新高清' },
  { value: 'speech-2.8-turbo', label: 'speech-2.8-turbo · 最新快速' },
  { value: 'speech-2.6-hd', label: 'speech-2.6-hd' },
  { value: 'speech-2.6-turbo', label: 'speech-2.6-turbo' },
  { value: 'speech-02-hd', label: 'speech-02-hd' },
  { value: 'speech-02-turbo', label: 'speech-02-turbo' },
  { value: 'speech-01-hd', label: 'speech-01-hd' },
  { value: 'speech-01-turbo', label: 'speech-01-turbo' },
];

/** MiniMax 情绪参数。 */
const MINIMAX_EMOTIONS = [
  { value: '', label: '（自动匹配）' },
  { value: 'happy', label: '高兴' },
  { value: 'sad', label: '悲伤' },
  { value: 'angry', label: '愤怒' },
  { value: 'fearful', label: '害怕' },
  { value: 'disgusted', label: '厌恶' },
  { value: 'surprised', label: '惊讶' },
  { value: 'calm', label: '中性' },
  { value: 'fluent', label: '生动（2.6 系）' },
  { value: 'whisper', label: '低语（2.6 系）' },
];

/** MiniMax 默认接入地址（中国区）。 */
const MINIMAX_BASE_URL = 'https://api.minimax.cn';

/** DeepSeek 官方接入地址。 */
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** DeepSeek 官方 TTS 音色（/v1/tools/tts）。 */
const DEEPSEEK_TTS_VOICES = [
  { value: 'stella', label: 'stella · 海星 · 女声（默认）' },
  { value: 'tide', label: 'tide · 暗潮 · 男声' },
];

/** 常见 ASR 语言选项（各供应商支持范围不同，填了不支持的会由上游报错）。 */
const ASR_LANGUAGES = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英语' },
  { value: 'yue', label: '粤语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
];

/** DeepSeek 账号凭证文件（DSH 账号登录写入的本地凭证）。 */
const DEEPSEEK_CREDENTIALS_PATH = '~/.dsh/.credentials.yaml';

/** 字段元数据：控制台抽屉按 type 通用渲染。 */
const FIELD_BASE_URL = {
  key: 'baseUrl',
  label: 'Base URL',
  type: 'text',
  placeholder: 'https://...',
  help: '留空使用供应商默认地址；可填自建代理/中转地址',
  maxLength: 400,
};
const FIELD_VOICE_FREE = {
  key: 'voice',
  label: '默认音色',
  type: 'text',
  placeholder: '留空使用供应商默认',
  help: '可填音色 ID；配置档里也能再覆盖',
  maxLength: 200,
};
const FIELD_STYLE = {
  key: 'style',
  label: '默认风格指令',
  type: 'textarea',
  placeholder: '例如：活泼一点、语速稍快、带点笑意',
  help: '支持自然语言风格控制的供应商（MiMo 等）会把它作为 user 指令；配置档里的风格优先',
  maxLength: 1000,
};

/** 克隆样本音频：类型 audio 由控制台渲染成「只读路径 + 选择音频」文件选择器（不允许手输）。 */
const FIELD_CLONE_SAMPLE = {
  key: 'samplePath',
  label: '克隆样本音频',
  type: 'audio',
  required: true,
  placeholder: '点击「选择音频」从本机目录选择',
  help: 'mp3 / wav 直接使用；m4a/aac/ogg/flac/webm 等会自动用 ffmpeg 转成 wav（需本机有 ffmpeg）；≤10MB',
  maxLength: 1000,
  accept: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm'],
};

/** MiniMax 克隆样本（mp3/m4a/wav，10s–5min，≤20MB）。 */
const FIELD_MINIMAX_SAMPLE = {
  key: 'samplePath',
  label: '待克隆音频',
  type: 'audio',
  required: true,
  placeholder: '点击「选择音频」从本机目录选择',
  help: 'mp3 / m4a / wav，时长 10 秒–5 分钟，≤20MB；从本机目录选择，不会上传到第三方',
  maxLength: 1000,
  accept: ['mp3', 'm4a', 'wav'],
};

/** MiniMax 克隆示例音频（可选，<8s）。 */
const FIELD_MINIMAX_PROMPT_SAMPLE = {
  key: 'promptSamplePath',
  label: '示例音频（可选）',
  type: 'audio',
  placeholder: '可选：选择一段 <8 秒的示例音频',
  help: '提供示例音频 + 对应文本可提升相似度与稳定性；两者必须同时填写',
  maxLength: 1000,
  accept: ['mp3', 'm4a', 'wav'],
};

/** 克隆/设计生成的音色 ID（clone/design 生成后自动回填，也可预先自定义）。 */
const FIELD_MINIMAX_VOICE_ID = {
  key: 'voiceId',
  label: '音色 ID',
  type: 'text',
  placeholder: '留空则自动生成',
  help: '8–256 字符，首字符为字母，可含数字、-、_；克隆/设计成功后自动回填，T2A 合成时使用',
  maxLength: 256,
};

/** MiniMax 情绪下拉。 */
const FIELD_MINIMAX_EMOTION = {
  key: 'emotion',
  label: '情绪',
  type: 'select',
  options: MINIMAX_EMOTIONS,
  help: '可选：指定合成情绪；留空由模型自动匹配（2.6 系支持 fluent / whisper）',
};

/** TTS 供应商分组：控制台「语音」页按组拆成独立区块（默认 / 克隆 / 文字设计）。 */
export const TTS_GROUPS = [
  { id: 'default', label: '默认音色 TTS', order: 1, desc: '内置/预置音色直接合成；配置档里选一个作为默认语音供应商（也可作为回退）。' },
  { id: 'clone', label: '音色克隆', order: 2, desc: '选一段本机音频作为样本，按该音色合成；每次合成都会带上样本。' },
  { id: 'design', label: '文字设计音色', order: 3, desc: '用自然语言描述想要的声音（音色/情绪/语速），由模型设计与合成。' },
  {
    id: 'asr',
    label: '语音识别（ASR）',
    order: 4,
    desc: '把 QQ 语音转成文字（只用于入站识别，不参与 TTS 合成）。'
      + '需在「设置 → 语音识别（ASR）」开启并选择供应商；识别失败时回退 QQ 自带识别文本。',
  },
];

/**
 * 供应商种类表。
 *
 * 每个 kind：
 *   label/desc          控制台展示
 *   needsSecret         是否必须 API Key（只控制 UI 提示，非必填也行）
 *   secretLabel/secretPlaceholder/secretHelp
 *   defaultConfig       新建时预填
 *   models/voices       下拉候选（select 字段引用 'models'/'voices'）
 *   fields              可编辑配置字段（不含 secret）
 *   outputFormat        适配器产出的音频格式：mp3 | wav
 *   maxCharsPerRequest  单次请求文字上限（引擎按句切成多段再拼接）
 *   timeoutMs           单次 HTTP 超时
 */
export const TTS_KINDS = {
  edge: {
    id: 'edge',
    label: '微软 Edge 语音（本地/免 Key）',
    short: 'Edge TTS',
    group: 'default',
    desc: '微软 Edge 语音合成的兼容实现：无需 API Key、中文音色自然，适合“本地/自带”语音。',
    needsSecret: false,
    secretLabel: '',
    secretPlaceholder: '',
    secretHelp: '该供应商不需要 API Key',
    defaultConfig: { voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz', volume: '+0%' },
    models: [],
    voices: EDGE_VOICES,
    fields: [
      { key: 'voice', label: '默认音色', type: 'select', optionsFrom: 'voices', required: true, help: '每个配置档还可以再覆盖' },
      { key: 'rate', label: '语速', type: 'text', placeholder: '+0%', help: '例如 +10% / -10%' },
      { key: 'pitch', label: '音调', type: 'text', placeholder: '+0Hz', help: '例如 +5Hz / -5Hz' },
      { key: 'volume', label: '音量', type: 'text', placeholder: '+0%', help: '例如 +10% / -10%' },
    ],
    outputFormat: 'mp3',
    maxCharsPerRequest: 2000,
    timeoutMs: 30000,
  },
  mimo: {
    id: 'mimo',
    label: '小米 MiMo TTS（默认音色）',
    short: 'MiMo',
    group: 'default',
    fixedModel: 'mimo-v2.5-tts',
    desc: 'MiMo-V2.5-TTS 内置音色：选音色直接合成；克隆 / 文字设计是独立的供应商类型（见下方对应区块）。',
    needsSecret: true,
    secretLabel: 'MiMo API Key',
    secretPlaceholder: '填写小米 MiMo 平台的 API Key',
    secretHelp: '请求头会以 api-key: <key> 发送',
    defaultConfig: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      voice: 'mimo_default',
      style: '',
    },
    models: [],
    voices: MIMO_VOICES,
    fields: [
      FIELD_BASE_URL,
      { key: 'voice', label: '默认音色', type: 'select', optionsFrom: 'voices', required: true, help: '内置音色；配置档里还能再覆盖' },
      { key: 'style', label: '默认风格指令', type: 'textarea', maxLength: 1000, help: '可选：自然语言控制语气/情绪（如「活泼、语速偏快」）' },
    ],
    outputFormat: 'wav',
    maxCharsPerRequest: 2000,
    timeoutMs: 120000,
  },
  'mimo-clone': {
    id: 'mimo-clone',
    label: '小米 MiMo 音色克隆',
    short: 'MiMo 克隆',
    group: 'clone',
    fixedModel: 'mimo-v2.5-tts-voiceclone',
    desc: '选一段本机音频（mp3/wav 等，≤10MB）作为样本，按该音色合成；样本随每次请求发送。',
    needsSecret: true,
    secretLabel: 'MiMo API Key',
    secretPlaceholder: '填写小米 MiMo 平台的 API Key',
    secretHelp: '请求头会以 api-key: <key> 发送',
    defaultConfig: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      samplePath: '',
      style: '',
    },
    models: [],
    voices: [],
    fields: [
      FIELD_BASE_URL,
      FIELD_CLONE_SAMPLE,
      { key: 'style', label: '风格指令（可选）', type: 'textarea', maxLength: 1000, help: '可选：额外的语气/情绪要求；通常由样本本身决定' },
    ],
    outputFormat: 'wav',
    maxCharsPerRequest: 2000,
    timeoutMs: 120000,
  },
  'mimo-design': {
    id: 'mimo-design',
    label: '小米 MiMo 文字设计音色',
    short: 'MiMo 设计',
    group: 'design',
    fixedModel: 'mimo-v2.5-tts-voicedesign',
    desc: '用一段自然语言描述想要的音色 / 情绪 / 语速，MiMo 会「设计」出这个声音并合成。',
    needsSecret: true,
    secretLabel: 'MiMo API Key',
    secretPlaceholder: '填写小米 MiMo 平台的 API Key',
    secretHelp: '请求头会以 api-key: <key> 发送',
    defaultConfig: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      description: '',
    },
    models: [],
    voices: [],
    fields: [
      FIELD_BASE_URL,
      { key: 'description', label: '音色描述', type: 'textarea', required: true, maxLength: 1000, placeholder: '例如：18 岁女生，清亮偏软，语速偏快，带一点不耐烦', help: '描述声音本身（性别/年龄/音色/口音/情绪/语速）；不做夸张表演腔' },
    ],
    outputFormat: 'wav',
    maxCharsPerRequest: 2000,
    timeoutMs: 120000,
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax 语音（T2A）',
    short: 'MiniMax',
    group: 'default',
    desc: 'MiniMax T2A 同步语音合成：使用系统音色 / 复刻音色 / 设计音色合成；中国区接口 api.minimax.cn。',
    needsSecret: true,
    secretLabel: 'MiniMax API Key',
    secretPlaceholder: '填写 MiniMax 开放平台 API Key',
    secretHelp: '请求头以 Authorization: Bearer <key> 发送（不是 api-key）',
    defaultConfig: {
      baseUrl: MINIMAX_BASE_URL,
      model: 'speech-2.8-hd',
      voice: 'female-shaonv',
      speed: 1,
      pitch: 0,
      vol: 1,
      emotion: '',
    },
    models: MINIMAX_MODELS,
    voices: MINIMAX_VOICES,
    fields: [
      FIELD_BASE_URL,
      { key: 'model', label: '模型', type: 'select', optionsFrom: 'models', required: true, help: 'speech-2.8-hd 最新高清；turbo 更快更便宜' },
      { key: 'voice', label: '默认音色', type: 'select', optionsFrom: 'voices', required: true, help: '系统音色 ID；配置档里还能再覆盖' },
      { key: 'speed', label: '语速', type: 'number', min: 0.5, max: 2, step: 0.05, help: '0.5–2，默认 1' },
      { key: 'pitch', label: '音调', type: 'number', min: -12, max: 12, step: 1, help: '-12–12，默认 0' },
      { key: 'vol', label: '音量', type: 'number', min: 0.1, max: 10, step: 0.1, help: '0.1–10，默认 1（T2A 语音消息建议 1）' },
      FIELD_MINIMAX_EMOTION,
    ],
    outputFormat: 'mp3',
    maxCharsPerRequest: 2000,
    timeoutMs: 120000,
  },
  'minimax-clone': {
    id: 'minimax-clone',
    label: 'MiniMax 音色克隆',
    short: 'MiniMax 克隆',
    group: 'clone',
    desc: '上传 10 秒–5 分钟的 mp3/m4a/wav 样本（≤20MB）复刻音色：点「克隆音色」生成 voice_id，之后用 T2A 合成。',
    needsSecret: true,
    secretLabel: 'MiniMax API Key',
    secretPlaceholder: '填写 MiniMax 开放平台 API Key',
    secretHelp: '请求头以 Authorization: Bearer <key> 发送；克隆前需完成个人/企业认证',
    defaultConfig: {
      baseUrl: MINIMAX_BASE_URL,
      model: 'speech-2.8-hd',
      samplePath: '',
      promptSamplePath: '',
      promptText: '',
      voiceId: '',
      emotion: '',
    },
    models: MINIMAX_MODELS,
    voices: [],
    fields: [
      FIELD_BASE_URL,
      { key: 'model', label: '合成模型', type: 'select', optionsFrom: 'models', required: true, help: '克隆出的 voice_id 用这个模型合成' },
      FIELD_MINIMAX_SAMPLE,
      FIELD_MINIMAX_PROMPT_SAMPLE,
      { key: 'promptText', label: '示例音频文本', type: 'textarea', maxLength: 1000, help: '必须与示例音频内容一致（句末带标点）；填了示例音频就必须填它' },
      FIELD_MINIMAX_VOICE_ID,
      FIELD_MINIMAX_EMOTION,
    ],
    prepareLabel: '克隆音色',
    prepareHint: '上传样本并创建 voice_id（成功后自动回填「音色 ID」）',
    outputFormat: 'mp3',
    maxCharsPerRequest: 2000,
    timeoutMs: 120000,
  },
  'minimax-design': {
    id: 'minimax-design',
    label: 'MiniMax 文字设计音色',
    short: 'MiniMax 设计',
    group: 'design',
    desc: '用自然语言描述想要的音色，调用 voice_design 生成 voice_id（附试听音频）；之后用 T2A 合成。',
    needsSecret: true,
    secretLabel: 'MiniMax API Key',
    secretPlaceholder: '填写 MiniMax 开放平台 API Key',
    secretHelp: '请求头以 Authorization: Bearer <key> 发送',
    defaultConfig: {
      baseUrl: MINIMAX_BASE_URL,
      model: 'speech-2.8-hd',
      description: '',
      previewText: '你好，这是 MiniMax 音色设计的试听。',
      voiceId: '',
      emotion: '',
    },
    models: MINIMAX_MODELS,
    voices: [],
    fields: [
      FIELD_BASE_URL,
      { key: 'model', label: '合成模型', type: 'select', optionsFrom: 'models', required: true, help: '生成出的 voice_id 用这个模型合成' },
      { key: 'description', label: '音色描述', type: 'textarea', required: true, maxLength: 1000, placeholder: '例如：讲述悬疑故事的播音员，声音低沉富有磁性，语速时快时慢', help: '描述声音本身（性别/年龄/音色/语速/情绪）；越具体越稳' },
      { key: 'previewText', label: '试听文本', type: 'text', required: true, maxLength: 500, help: '生成音色时的试听文本（按字符计费，2 元/万字符）' },
      FIELD_MINIMAX_VOICE_ID,
      FIELD_MINIMAX_EMOTION,
    ],
    prepareLabel: '生成设计音色',
    prepareHint: '调用 voice_design 生成 voice_id，并返回试听音频',
    outputFormat: 'mp3',
    maxCharsPerRequest: 2000,
    timeoutMs: 120000,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek 官方 TTS（语音合成）',
    short: 'DeepSeek TTS',
    group: 'default',
    desc: 'DeepSeek 官方语音合成（POST /v1/tools/tts）：stella（女声）/ tide（男声），自动识别中英日韩等语种，流式返回音频。',
    needsSecret: true,
    secretLabel: 'DeepSeek API Key',
    secretPlaceholder: 'sk-...（DeepSeek 开放平台 API Key）',
    secretHelp: '请求头以 Authorization: Bearer <key> 发送',
    defaultConfig: {
      baseUrl: DEEPSEEK_BASE_URL,
      voice: 'stella',
      format: 'wav',
    },
    models: [],
    voices: DEEPSEEK_TTS_VOICES,
    fields: [
      FIELD_BASE_URL,
      { key: 'voice', label: '音色', type: 'select', optionsFrom: 'voices', required: true, help: 'stella（海星，女声）/ tide（暗潮，男声）；语种由文本自动识别' },
      {
        key: 'format',
        label: '输出格式',
        type: 'select',
        options: [{ value: 'wav', label: 'WAV（推荐）' }, { value: 'pcm', label: 'PCM 24k 16bit（自动封装 WAV）' }],
        help: 'QQ 语音消息需要 wav；选 pcm 时插件会补 WAV 头再发送',
      },
    ],
    outputFormat: 'wav',
    maxCharsPerRequest: 2000,
    timeoutMs: 120000,
  },
  'deepseek-asr': {
    id: 'deepseek-asr',
    label: 'DeepSeek 官方 ASR（语音识别）',
    short: 'DeepSeek ASR',
    group: 'asr',
    capability: 'asr',
    desc: 'DeepSeek 官方语音识别（POST /v1/tools/asr）：把 QQ 语音转成文字，自动识别语种；支持 API Key 或 DSH 账号登录 token 两种鉴权。',
    needsSecret: true,
    secretLabel: 'DeepSeek API Key（API Key 鉴权时填）',
    secretPlaceholder: 'sk-...（DeepSeek 开放平台 API Key）',
    secretHelp: 'authMode=API Key 时以 Authorization: Bearer <key> 发送；authMode=账号登录时读取本机凭证文件的 x-dsh-auth-token，无需填 Key',
    defaultConfig: {
      baseUrl: DEEPSEEK_BASE_URL,
      authMode: 'apikey',
      credentialPath: DEEPSEEK_CREDENTIALS_PATH,
    },
    models: [],
    voices: [],
    fields: [
      FIELD_BASE_URL,
      {
        key: 'authMode',
        label: '鉴权方式',
        type: 'select',
        options: [
          { value: 'apikey', label: 'API Key（Authorization: Bearer）' },
          { value: 'account', label: 'DSH 账号登录（x-dsh-auth-token）' },
        ],
        help: '账号登录会从 credentialPath 读取 DSH 已登录的账号 token；若上游不支持账号鉴权会报错，可切回 API Key',
      },
      {
        key: 'credentialPath',
        label: '账号凭证文件',
        type: 'text',
        maxLength: 500,
        help: '仅账号登录鉴权使用；默认 ~/.dsh/.credentials.yaml（DSH 登录后自动写入）',
      },
    ],
    outputFormat: '',
    maxCharsPerRequest: 0,
    timeoutMs: 120000,
  },
  'mimo-asr': {
    id: 'mimo-asr',
    label: '小米 MiMo 语音识别（ASR）',
    short: 'MiMo ASR',
    group: 'asr',
    capability: 'asr',
    desc: 'MiMo-V2.5-ASR：OpenAI 兼容 /v1/chat/completions，支持中英、粤语/吴语/闽南语/四川话等方言与歌词转写；音频 base64 ≤10MB。',
    needsSecret: true,
    secretLabel: 'MiMo API Key',
    secretPlaceholder: '填写小米 MiMo 平台的 API Key',
    secretHelp: '请求头会以 api-key: <key> 发送',
    defaultConfig: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      language: 'auto',
    },
    models: [],
    voices: [],
    fields: [
      FIELD_BASE_URL,
      { key: 'language', label: '语言', type: 'select', options: ASR_LANGUAGES.slice(0, 3), help: 'auto 自动识别；确认语言时选 zh/en 更准' },
    ],
    outputFormat: '',
    maxCharsPerRequest: 0,
    timeoutMs: 120000,
  },
  'openai-asr': {
    id: 'openai-asr',
    label: 'OpenAI 兼容语音识别（/audio/transcriptions）',
    short: 'OpenAI ASR',
    group: 'asr',
    capability: 'asr',
    desc: '任何兼容 OpenAI /v1/audio/transcriptions 的服务（OpenAI Whisper、Groq、SiliconFlow、本地 faster-whisper-server / whisper.cpp server 等）。',
    needsSecret: false,
    secretLabel: 'API Key（本地服务可留空）',
    secretPlaceholder: 'sk-...（本地无鉴权服务留空）',
    secretHelp: '有 Key 时以 Authorization: Bearer <key> 发送；本地服务可留空',
    defaultConfig: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'whisper-1',
      language: '',
      prompt: '',
    },
    models: [],
    voices: [],
    fields: [
      FIELD_BASE_URL,
      { key: 'model', label: '模型', type: 'text', required: true, maxLength: 200, placeholder: 'whisper-1', help: '兼容服务填自己的模型名（如 whisper-large-v3 / SenseVoiceSmall）' },
      { key: 'language', label: '语言', type: 'text', maxLength: 20, placeholder: '留空自动，zh / en / ja...', help: '留空自动识别；部分服务只接受 ISO-639-1' },
      { key: 'prompt', label: '提示词（可选）', type: 'textarea', maxLength: 1000, help: '给模型的上下文提示（专有名词/标点风格），不是所有兼容服务都支持' },
    ],
    outputFormat: '',
    maxCharsPerRequest: 0,
    timeoutMs: 120000,
  },
  'faster-whisper': {
    id: 'faster-whisper',
    label: '本地 faster-whisper（离线）',
    short: 'faster-whisper',
    group: 'asr',
    capability: 'asr',
    desc: '调用本机 faster-whisper（Python venv + CTranslate2 模型），完全离线、不产生 API 费用；耗时取决于 CPU/模型大小。',
    needsSecret: false,
    secretLabel: '',
    secretPlaceholder: '',
    secretHelp: '本地运行，不需要 API Key',
    defaultConfig: {
      pythonPath: '~/.dsh/asr-venv/bin/python',
      modelPath: '~/.dsh/asr-models/faster-whisper-base',
      device: 'auto',
      computeType: 'default',
      language: 'auto',
      beamSize: 5,
    },
    models: [],
    voices: [],
    fields: [
      { key: 'pythonPath', label: 'Python 路径', type: 'text', required: true, maxLength: 500, help: '装好 faster-whisper 的 venv python，例如 ~/.dsh/asr-venv/bin/python' },
      { key: 'modelPath', label: '模型目录 / 模型名', type: 'text', required: true, maxLength: 500, help: '本地 CTranslate2 模型目录（含 model.bin），或 faster-whisper 能下载的模型名（如 small）' },
      {
        key: 'device',
        label: '设备',
        type: 'select',
        options: [{ value: 'auto', label: '自动' }, { value: 'cpu', label: 'CPU' }, { value: 'cuda', label: 'CUDA' }],
      },
      {
        key: 'computeType',
        label: '计算精度',
        type: 'select',
        options: [{ value: 'default', label: '默认' }, { value: 'int8', label: 'int8（CPU 推荐）' }, { value: 'float16', label: 'float16（GPU）' }, { value: 'float32', label: 'float32' }],
      },
      { key: 'language', label: '语言', type: 'select', options: ASR_LANGUAGES, help: 'auto 自动识别；指定语言更快更准' },
      { key: 'beamSize', label: 'beam size', type: 'number', min: 1, max: 10, step: 1, help: '默认 5；越小越快' },
    ],
    outputFormat: '',
    maxCharsPerRequest: 0,
    timeoutMs: 180000,
  },
  bailian: {
    id: 'bailian',
    label: '阿里云百炼（Qwen-TTS）',
    short: '百炼',
    group: 'default',
    desc: '阿里云百炼 / DashScope 非实时语音合成（qwen3-tts-flash / qwen-tts），返回音频 URL 后自动下载。',
    needsSecret: true,
    secretLabel: 'DashScope API Key',
    secretPlaceholder: 'sk-...',
    secretHelp: '请求头会以 Authorization: Bearer <key> 发送',
    defaultConfig: {
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      model: 'qwen3-tts-flash',
      voice: 'Cherry',
      languageType: 'Auto',
    },
    models: [
      { value: 'qwen3-tts-flash', label: 'qwen3-tts-flash · 推荐' },
      { value: 'qwen-tts', label: 'qwen-tts · 兼容' },
    ],
    voices: BAILIAN_VOICES,
    fields: [
      { ...FIELD_BASE_URL, help: '北京地域默认 dashscope.aliyuncs.com；新加坡用 dashscope-intl.aliyuncs.com' },
      { key: 'model', label: '模型', type: 'select', optionsFrom: 'models', required: true },
      { key: 'voice', label: '默认音色', type: 'select', optionsFrom: 'voices', help: '可填自定义音色 ID' },
      { key: 'languageType', label: '语言', type: 'select', options: LANGUAGES, help: '单语文本指定语言效果更好；混合语言用「自动」' },
    ],
    outputFormat: 'wav',
    maxCharsPerRequest: 600,
    timeoutMs: 120000,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI 兼容（/audio/speech）',
    short: 'OpenAI 兼容',
    group: 'default',
    desc: '任何兼容 OpenAI /v1/audio/speech 的服务（OpenAI、国内中转、本地 vLLM/IndexTTS 网关等）。',
    needsSecret: true,
    secretLabel: 'API Key',
    secretPlaceholder: 'sk-...（本地服务可留空）',
    secretHelp: '请求头会以 Authorization: Bearer <key> 发送；无鉴权的本地服务可留空',
    defaultConfig: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'mp3',
      speed: 1,
      instructions: '',
    },
    models: [
      { value: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts' },
      { value: 'tts-1', label: 'tts-1' },
      { value: 'tts-1-hd', label: 'tts-1-hd' },
    ],
    voices: OPENAI_VOICES,
    fields: [
      FIELD_BASE_URL,
      { key: 'model', label: '模型', type: 'text', required: true, help: '兼容服务可以填自家模型名', maxLength: 200 },
      { key: 'voice', label: '默认音色', type: 'select', optionsFrom: 'voices', help: '可填服务商自有音色名' },
      {
        key: 'format',
        label: '输出格式',
        type: 'select',
        options: [{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }],
        help: 'QQ 语音消息只支持 mp3/wav/silk，选这两个',
      },
      { key: 'speed', label: '语速', type: 'number', min: 0.25, max: 4, step: 0.05 },
      { key: 'instructions', label: '默认风格指令', type: 'textarea', maxLength: 1000, help: 'gpt-4o-mini-tts 等支持 instructions 的模型生效' },
    ],
    outputFormat: 'mp3',
    maxCharsPerRequest: 4000,
    timeoutMs: 120000,
  },
  custom: {
    id: 'custom',
    label: '自定义 HTTP 接口',
    short: '自定义 HTTP',
    group: 'default',
    desc: '完全自定义的 HTTP 语音合成接口：模板化 URL/Body/Header，响应可直接是音频字节、JSON 里的 base64 或音频 URL。',
    needsSecret: false,
    secretLabel: '鉴权密钥（可选）',
    secretPlaceholder: '需要鉴权时填写',
    secretHelp: '按下方「密钥请求头/前缀」注入，不会出现在任何读接口里',
    defaultConfig: {
      url: '',
      method: 'POST',
      headers: {},
      bodyTemplate: '{"text":"{{text}}","voice":"{{voice}}","style":"{{style}}"}',
      responseType: 'json_base64',
      responsePath: 'data.audio',
      format: 'mp3',
      secretHeader: 'Authorization',
      secretPrefix: 'Bearer ',
    },
    models: [],
    voices: [],
    fields: [
      { key: 'url', label: '接口 URL', type: 'text', required: true, placeholder: 'https://example.com/tts', help: '支持 http(s)；URL 里也可用 {{text}} 等占位符（会自动 URL 编码）', maxLength: 1000 },
      {
        key: 'method',
        label: '请求方法',
        type: 'select',
        options: [{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }],
      },
      { key: 'headers', label: '请求头（JSON）', type: 'json', help: '{"X-My-Header":"value"}；敏感头请用下面的密钥字段' },
      {
        key: 'bodyTemplate',
        label: '请求体模板',
        type: 'textarea',
        help: 'POST 用。占位符：{{text}} {{voice}} {{style}} {{speed}}；字符串自动做 JSON 转义',
        maxLength: 4000,
      },
      {
        key: 'responseType',
        label: '响应类型',
        type: 'select',
        options: [
          { value: 'audio', label: '直接返回音频字节（audio/*）' },
          { value: 'json_base64', label: 'JSON 里的 base64 音频' },
          { value: 'json_url', label: 'JSON 里的音频 URL' },
        ],
        required: true,
      },
      { key: 'responsePath', label: 'JSON 字段路径', type: 'text', placeholder: 'data.audio', help: 'json_base64 / json_url 必填，点号路径，例如 output.audio.url' },
      {
        key: 'format',
        label: '音频格式',
        type: 'select',
        options: [{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }],
        help: '供应商实际返回的格式（QQ 语音只支持 mp3/wav/silk）',
      },
      { key: 'secretHeader', label: '密钥请求头', type: 'text', placeholder: 'Authorization', maxLength: 200 },
      { key: 'secretPrefix', label: '密钥值前缀', type: 'text', placeholder: 'Bearer ', maxLength: 100 },
    ],
    outputFormat: 'mp3',
    maxCharsPerRequest: 2000,
    timeoutMs: 120000,
  },
  command: {
    id: 'command',
    label: '本地命令行模型',
    short: '本地命令',
    group: 'default',
    desc: '调用本机已安装的 TTS 命令（piper / sherpa-onnx / edge-tts CLI / say 等）：把文字写成参数、把音频写进指定文件。',
    needsSecret: false,
    secretLabel: '',
    secretPlaceholder: '',
    secretHelp: '本地命令不需要密钥',
    defaultConfig: {
      command: 'edge-tts --voice {{voice}} --text {{text}} --write-media {{output}}',
      outputFormat: 'mp3',
      timeoutMs: 120000,
    },
    models: [],
    voices: [],
    fields: [
      {
        key: 'command',
        label: '命令模板',
        type: 'textarea',
        required: true,
        help: '占位符：{{text}}（自动 shell 转义）{{voice}} {{style}} {{output}}（音频输出路径）',
        maxLength: 4000,
      },
      {
        key: 'outputFormat',
        label: '输出格式',
        type: 'select',
        options: [{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }],
        help: '{{output}} 会以这个扩展名传给命令',
      },
      { key: 'timeoutMs', label: '超时（ms）', type: 'number', min: 1000, max: 600000, step: 1000 },
    ],
    outputFormat: 'mp3',
    maxCharsPerRequest: 2000,
    timeoutMs: 120000,
  },
};

/** 全部 kind（数组，顺序固定，控制台下拉用）。 */
export const TTS_KIND_LIST = Object.values(TTS_KINDS);

/** 取分组元数据（未知 / 缺省归 default）。 */
export function groupOf(groupId) {
  return TTS_GROUPS.find((item) => item.id === groupId) || TTS_GROUPS[0];
}

/** 取 kind 元数据（未知返回 null）。 */
export function kindOf(kind) {
  if (typeof kind !== 'string' || kind === '') return null;
  return Object.prototype.hasOwnProperty.call(TTS_KINDS, kind) ? TTS_KINDS[kind] : null;
}

/** 供应商能力：'tts'（合成）或 'asr'（语音识别，复用同一供应商表但不参与合成）。 */
export function capabilityOf(kind) {
  const meta = kindOf(kind);
  return meta && meta.capability === 'asr' ? 'asr' : 'tts';
}

/** 公开 kind 元数据（不含内部函数；克隆一份防外部改写，并补上分组展示名）。 */
export function publicKinds() {
  return TTS_KIND_LIST.map((kind) => {
    const copy = JSON.parse(JSON.stringify(kind));
    const group = TTS_GROUPS.find((item) => item.id === copy.group) || TTS_GROUPS[0];
    copy.group = group.id;
    copy.groupLabel = group.label;
    copy.capability = capabilityOf(copy.id);
    return copy;
  });
}

/** 某 kind 的默认配置（深拷贝）。 */
export function defaultConfigFor(kind) {
  const meta = kindOf(kind);
  return meta ? JSON.parse(JSON.stringify(meta.defaultConfig)) : {};
}

/** 截断字符串。 */
function clip(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 本机绝对路径（Linux / Windows）。 */
function isAbsoluteLocalPath(value) {
  return typeof value === 'string' && /^(?:\/|[A-Za-z]:[\\/])/.test(value.trim());
}

/** MiniMax 自定义 voice_id 规则（8–256、首字符字母、字母数字 - _、末位非 - _）。 */
function isValidMinimaxVoiceId(value) {
  const text = String(value || '').trim();
  if (text === '') return true;
  return text.length >= 8 && text.length <= 256
    && /^[A-Za-z]/u.test(text)
    && /^[A-Za-z0-9_-]+$/u.test(text)
    && !/[-_]$/u.test(text);
}

const MINIMAX_SAMPLE_EXTS = /\.(?:mp3|m4a|wav)$/i;

/** 按字段元数据归一化一个配置值。 */
function coerceField(field, raw, warnings, pathPrefix) {
  const key = field.key;
  const where = pathPrefix + key;
  if (raw === undefined || raw === null) {
    if (field.required) throw new Error('配置项 ' + where + ' 不能为空');
    return undefined;
  }
  switch (field.type) {
    case 'number': {
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(num)) {
        warnings.push(where + ' 需要数字，已忽略');
        return undefined;
      }
      let out = num;
      if (field.min !== undefined) out = Math.max(field.min, out);
      if (field.max !== undefined) out = Math.min(field.max, out);
      return out;
    }
    case 'select': {
      const text = clip(raw, field.maxLength || 200).trim();
      if (field.required && text === '') throw new Error('配置项 ' + where + ' 不能为空');
      return text;
    }
    case 'json': {
      if (!isPlainObject(raw)) {
        warnings.push(where + ' 需要 JSON 对象，已忽略');
        return undefined;
      }
      const entries = Object.entries(raw).slice(0, 40);
      const out = {};
      for (const [header, value] of entries) {
        if (typeof header !== 'string' || header.trim() === '') continue;
        if (value === null || value === undefined) continue;
        out[clip(header, 200)] = clip(String(value), 2000);
      }
      return out;
    }
    case 'textarea':
    case 'text':
    default: {
      const text = clip(raw, field.maxLength || 2000);
      if (field.required && text.trim() === '') throw new Error('配置项 ' + where + ' 不能为空');
      return text;
    }
  }
}

/**
 * 归一化「新增/编辑供应商」入参。
 *
 * @param {object} input { name?, kind, enabled?, config?, secret? }
 * @param {{existing?: object|null}} [options] 编辑时传 existing（用于保留未提交字段）
 * @returns {{value: {name:string, kind:string, enabled:boolean, config:object, secret?:string}, warnings:string[]}}
 * @throws {Error} 致命校验错误（kind 未知 / 必填缺失 / URL 非法 / JSON 不合法）
 */
export function normalizeProviderInput(input, options = {}) {
  const src = isPlainObject(input) ? input : {};
  const existing = options.existing && typeof options.existing === 'object' ? options.existing : null;
  const kind = typeof src.kind === 'string' && src.kind !== '' ? src.kind : (existing ? existing.kind : '');
  const meta = kindOf(kind);
  if (!meta) throw new Error('未知的 TTS 供应商类型: ' + (kind || '(空)') + '（可选：' + TTS_KIND_LIST.map((item) => item.id).join(' / ') + '）');

  const warnings = [];
  const name = clip(typeof src.name === 'string' && src.name.trim() !== '' ? src.name.trim() : (existing && existing.name) || meta.label, 80);

  const rawConfig = isPlainObject(src.config)
    ? src.config
    : (existing && isPlainObject(existing.config) ? {} : meta.defaultConfig);
  // 编辑时以现有配置为底，只覆盖本次提交的字段（控制台表单每次都提交完整 config，这里仍做合并兜底）
  const baseConfig = existing && isPlainObject(existing.config) ? existing.config : {};
  const mergedInput = src.config === undefined ? baseConfig : Object.assign({}, baseConfig, rawConfig);
  // 旧版把克隆/设计都塞在 mimo 的 model 字段里；现在拆成独立 kind，收到旧表单直接提示刷新。
  if (kind === 'mimo' && typeof mergedInput.model === 'string' && /voiceclone|voicedesign/.test(mergedInput.model)) {
    throw new Error('MiMo 的「音色克隆 / 文字设计」已拆成独立类型，请刷新控制台后在对应区块新增');
  }
  const config = {};
  const knownKeys = new Set(meta.fields.map((field) => field.key));
  // 默认值先填充，保证配置完整（老数据/手工创建也能拿到默认行为）
  const defaults = meta.defaultConfig || {};
  for (const [key, value] of Object.entries(defaults)) {
    if (knownKeys.has(key)) config[key] = JSON.parse(JSON.stringify(value));
  }
  for (const [key, value] of Object.entries(mergedInput)) {
    if (!knownKeys.has(key)) {
      warnings.push('未知配置项已忽略: ' + kind + '.' + key);
      continue;
    }
    const field = meta.fields.find((item) => item.key === key);
    const next = coerceField(field, value, warnings, kind + '.');
    if (next !== undefined) config[key] = next;
    else delete config[key];
  }
  // 必填项兜底：缺省且未在 defaults 里的字段报错
  for (const field of meta.fields) {
    if (!field.required) continue;
    const value = config[field.key];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      throw new Error('缺少必填配置项: ' + kind + '.' + field.key + '（' + field.label + '）');
    }
  }
  if (kind === 'custom') {
    let url;
    try {
      url = new URL(String(config.url || ''));
    } catch {
      throw new Error('自定义 HTTP 接口的 URL 非法: ' + (config.url || '(空)'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('自定义 HTTP 接口只支持 http(s) URL');
    if (config.responseType !== 'audio' && (typeof config.responsePath !== 'string' || config.responsePath.trim() === '')) {
      throw new Error('响应类型为 JSON 时必须填 JSON 字段路径（responsePath）');
    }
  }
  if (kind === 'mimo-clone') {
    const samplePath = typeof config.samplePath === 'string' ? config.samplePath.trim() : '';
    if (samplePath === '') throw new Error('音色克隆需要选择样本音频文件（samplePath）');
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(samplePath)) {
      throw new Error('克隆样本音频必须是本机绝对路径，请用「选择音频」按钮选择文件');
    }
  }
  if (kind === 'mimo-design' && (typeof config.description !== 'string' || config.description.trim() === '')) {
    throw new Error('文字设计音色需要填写音色描述（description）');
  }
  if (kind === 'minimax-clone') {
    const samplePath = String(config.samplePath || '').trim();
    if (samplePath === '') throw new Error('MiniMax 音色克隆需要选择待克隆音频（samplePath）');
    if (!isAbsoluteLocalPath(samplePath)) throw new Error('MiniMax 克隆样本必须是本机绝对路径，请用「选择音频」按钮选择');
    if (!MINIMAX_SAMPLE_EXTS.test(samplePath)) throw new Error('MiniMax 克隆样本只支持 mp3 / m4a / wav');
    const promptSamplePath = String(config.promptSamplePath || '').trim();
    if (promptSamplePath !== '') {
      if (!isAbsoluteLocalPath(promptSamplePath)) throw new Error('MiniMax 示例音频必须是本机绝对路径，请用「选择音频」按钮选择');
      if (!MINIMAX_SAMPLE_EXTS.test(promptSamplePath)) throw new Error('MiniMax 示例音频只支持 mp3 / m4a / wav');
      if (String(config.promptText || '').trim() === '') throw new Error('填写示例音频时必须同时填写示例音频文本（promptText）');
    }
    if (!isValidMinimaxVoiceId(config.voiceId)) {
      throw new Error('MiniMax 音色 ID 格式不合法：8–256 字符、首字符为字母、只含字母/数字/-/_、末位不能是 - 或 _');
    }
  }
  if (kind === 'minimax-design' && !isValidMinimaxVoiceId(config.voiceId)) {
    throw new Error('MiniMax 音色 ID 格式不合法：8–256 字符、首字符为字母、只含字母/数字/-/_、末位不能是 - 或 _');
  }
  if (kind === 'command' && (typeof config.command !== 'string' || config.command.trim() === '')) {
    throw new Error('本地命令模式需要填写命令模板');
  }

  const enabled = src.enabled === undefined ? (existing ? existing.enabled !== false : true) : Boolean(src.enabled);
  const value = { name, kind, enabled, config };
  if (typeof src.secret === 'string') value.secret = src.secret.trim().slice(0, 4096);
  return { value, warnings };
}

/**
 * 数据库行 → 对外视图（脱敏：不含 secret）。
 * @param {object} row { id, name, kind, enabled, config, secret, created_at, updated_at }
 */
export function providerView(row) {
  if (!row) return null;
  const meta = kindOf(row.kind);
  const config = isPlainObject(row.config) ? JSON.parse(JSON.stringify(row.config)) : {};
  const summary = [];
  if (config.model) summary.push(String(config.model));
  if (config.voice) summary.push(String(config.voice));
  if (config.description) summary.push(clip(String(config.description).replace(/\s+/g, ' '), 60));
  if (config.samplePath) summary.push('样本 · ' + String(config.samplePath).split(/[\\/]/).pop());
  if (config.voiceId) summary.push('音色 · ' + String(config.voiceId));
  if (config.url && !config.model && !config.voice) summary.push(String(config.url));
  if (config.command) summary.push(clip(String(config.command), 60));
  if (meta && meta.capability === 'asr') {
    if (config.authMode) summary.push(config.authMode === 'account' ? '账号登录鉴权' : 'API Key 鉴权');
    if (config.model) summary.push(String(config.model));
    if (config.language) summary.push('语言 · ' + String(config.language));
    if (config.pythonPath) summary.push('本地 · ' + String(config.modelPath || config.pythonPath).split(/[\\/]/).pop());
    if (!config.model && !config.pythonPath && config.baseUrl) summary.push(String(config.baseUrl));
  }
  const group = meta && meta.group ? meta.group : 'default';
  const groupMeta = TTS_GROUPS.find((item) => item.id === group) || TTS_GROUPS[0];
  return {
    id: String(row.id || ''),
    name: String(row.name || ''),
    kind: String(row.kind || ''),
    kindLabel: meta ? meta.label : String(row.kind || ''),
    kindShort: meta ? meta.short : String(row.kind || ''),
    group: groupMeta.id,
    groupLabel: groupMeta.label,
    capability: capabilityOf(row.kind),
    enabled: row.enabled !== false && row.enabled !== 0,
    config,
    hasSecret: typeof row.secret === 'string' && row.secret !== '',
    summary: summary.join(' · '),
    outputFormat: meta ? meta.outputFormat : 'mp3',
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

/**
 * 解析「字段下拉候选」：optionsFrom=voices/models 时展开，否则用 fields.options。
 * 控制台前端也可以直接用 publicKinds() 里的 voices/models 自己展开。
 */
export function fieldOptions(kind, field) {
  const meta = kindOf(kind);
  if (!meta || !field) return [];
  if (Array.isArray(field.options)) return field.options;
  if (field.optionsFrom === 'voices') return meta.voices || [];
  if (field.optionsFrom === 'models') return meta.models || [];
  return [];
}

export default {
  TTS_KINDS, TTS_KIND_LIST, TTS_GROUPS, kindOf, groupOf, capabilityOf, publicKinds, defaultConfigFor,
  normalizeProviderInput, providerView, fieldOptions,
};
