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
    label: '小米 MiMo TTS',
    short: 'MiMo',
    desc: 'MiMo-V2.5-TTS 系列：内置音色、文字描述设计音色（voice design）、音频样本克隆音色（voice clone）。',
    needsSecret: true,
    secretLabel: 'MiMo API Key',
    secretPlaceholder: '填写小米 MiMo 平台的 API Key',
    secretHelp: '请求头会以 api-key: <key> 发送',
    defaultConfig: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-tts',
      voice: 'mimo_default',
      style: '',
      samplePath: '',
    },
    models: [
      { value: 'mimo-v2.5-tts', label: 'mimo-v2.5-tts · 内置音色（默认）' },
      { value: 'mimo-v2.5-tts-voicedesign', label: 'mimo-v2.5-tts-voicedesign · 文字设计音色' },
      { value: 'mimo-v2.5-tts-voiceclone', label: 'mimo-v2.5-tts-voiceclone · 样本克隆音色' },
    ],
    voices: MIMO_VOICES,
    fields: [
      FIELD_BASE_URL,
      { key: 'model', label: '模型', type: 'select', optionsFrom: 'models', required: true, help: '默认 mimo-v2.5-tts；克隆/设计音色选对应模型' },
      { key: 'voice', label: '默认音色', type: 'select', optionsFrom: 'voices', help: '内置音色名；clone 模型填样本音频路径时这里可留空' },
      { key: 'style', label: '默认风格指令', type: 'textarea', maxLength: 1000, help: '自然语言控制语气/情绪；voicedesign 模型必填（描述想要的声音）' },
      { key: 'samplePath', label: '克隆样本音频路径', type: 'text', maxLength: 1000, help: 'voiceclone 模型专用：本机 mp3/wav 文件绝对路径（≤10MB）' },
    ],
    outputFormat: 'wav',
    maxCharsPerRequest: 2000,
    timeoutMs: 120000,
  },
  bailian: {
    id: 'bailian',
    label: '阿里云百炼（Qwen-TTS）',
    short: '百炼',
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

/** 取 kind 元数据（未知返回 null）。 */
export function kindOf(kind) {
  if (typeof kind !== 'string' || kind === '') return null;
  return Object.prototype.hasOwnProperty.call(TTS_KINDS, kind) ? TTS_KINDS[kind] : null;
}

/** 公开 kind 元数据（不含内部函数；目前本身就是纯数据，克隆一份防外部改写）。 */
export function publicKinds() {
  return TTS_KIND_LIST.map((kind) => JSON.parse(JSON.stringify(kind)));
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
  if (kind === 'mimo') {
    const model = String(config.model || '');
    if (model === 'mimo-v2.5-tts-voiceclone' && (typeof config.samplePath !== 'string' || config.samplePath.trim() === '')) {
      throw new Error('voiceclone 模型需要填写克隆样本音频路径 (samplePath)');
    }
    if (model === 'mimo-v2.5-tts-voicedesign' && (typeof config.style !== 'string' || config.style.trim() === '')) {
      throw new Error('voicedesign 模型需要在风格指令里描述想要的声音');
    }
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
  if (config.url && !config.model && !config.voice) summary.push(String(config.url));
  if (config.command) summary.push(clip(String(config.command), 60));
  return {
    id: String(row.id || ''),
    name: String(row.name || ''),
    kind: String(row.kind || ''),
    kindLabel: meta ? meta.label : String(row.kind || ''),
    kindShort: meta ? meta.short : String(row.kind || ''),
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
  TTS_KINDS, TTS_KIND_LIST, kindOf, publicKinds, defaultConfigFor,
  normalizeProviderInput, providerView, fieldOptions,
};
