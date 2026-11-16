/**
 * api/types —— 控制台 HTTP 契约的前端落点。
 *
 * 唯一来源：docs/DESIGN-v2.md §3 + lib/core/config/store.js 的视图字段。
 * 后端实现若在 snake_case / 包装对象上有差异，由 api/normalize.ts 统一抹平，
 * 页面代码只认这里的 camelCase 形状。
 */

/** 统一错误体：{ error: { code, message } }。 */
export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export interface SessionInfo {
  authenticated: boolean;
  createdAt?: number;
  expiresAt?: number;
  lastSeen?: number;
  ip?: string;
  userAgent?: string;
}

export interface Health {
  ok: boolean;
  version: string;
  startedAt?: number;
  uptimeMs?: number;
  online?: boolean;
}

export interface Bot {
  id: string;
  name: string;
  appId: string;
  appSecret?: string;
  hasSecret: boolean;
  enabled: boolean;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BotInput {
  name: string;
  appId?: string;
  appSecret?: string;
  cwd?: string;
  enabled?: boolean;
}

export interface Profile {
  id: string;
  botId: string;
  name: string;
  data: Record<string, unknown>;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Binding {
  id: number;
  botId: string;
  scope: string;
  profileId: string;
  profileName?: string;
  priority: number;
  createdAt: number;
}

export interface BotRuntime {
  status: string;
  startedAt?: number;
}

export interface ConsoleInfo {
  version?: string;
  startedAt?: number;
  uptimeMs?: number;
  host?: string;
  port?: number;
}

/** dsh Web 入口（带鉴权 token 的 URL；控制台顶栏按钮用）。 */
export interface DshWebInfo {
  url: string;
  ready: boolean;
  error?: string;
}

export interface StateSnapshot {
  version: string;
  online: boolean;
  bots: Bot[];
  profiles: Profile[];
  bindings: Binding[];
  activeProfiles: Record<string, string>;
  console: ConsoleInfo;
  runtime: { online: boolean; bots: Record<string, BotRuntime> };
  dshWeb?: DshWebInfo | null;
}

/** 设置项 UI 分组（GET /api/schema 的 groups；配置档编辑器的一级 tab）。 */
export interface SchemaGroup {
  id: string;
  label: string;
  order?: number;
  desc?: string;
}

/** 设置项 UI 元数据（GET /api/schema）。 */
export interface SchemaSection {
  id: string;
  label: string;
  order?: number;
  desc?: string;
  /** 所属 UI 组 id（对应 groups）；缺省时按 section 自身单独成组。 */
  group?: string;
}

export interface SchemaItem {
  key: string;
  section?: string;
  scope?: 'global' | 'bot' | 'profile';
  type?: string;
  label?: string;
  help?: string;
  description?: string;
  widget?: string;
  values?: Array<{ value: string; label: string } | string>;
  /** 动态下拉候选来源（SchemaForm 据此拉取 llmProviders / llmModels / ttsProviders）。 */
  optionsFrom?: string;
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
}

export interface SchemaPayload {
  /** 一级分组（可选：旧后端只给 sections 时前端回退为每 section 一组）。 */
  groups?: SchemaGroup[];
  sections: SchemaSection[];
  items: SchemaItem[];
}

export interface SettingsPayload {
  botId: string;
  values: Record<string, unknown>;
}

export type ToolTier = 'active' | 'passive';

export interface ToolItem {
  name: string;
  source?: string;
  description?: string;
  restrictable?: boolean;
  enabled?: boolean;
  visible?: boolean;
  capability?: string | null;
  /** 当前 profile 生效档位：active=常驻声明，passive=按需点亮 */
  tier?: ToolTier | '';
  /** 被动能力的激活分组（imagegen/voice/workspace…），没有则为 null */
  group?: string | null;
  /** 是否在 catalog 里登记过档位；false = 未分类（默认按常驻） */
  classified?: boolean;
  /** 装配状态：declared=已声明（进 schema）/ indexed=索引中 / disabled=不可用 / unknown=没配置档 */
  state?: ToolState;
  /** 已装载：插件在 agent 启动时注册，可被调用或激活。 */
  loaded?: boolean | null;
  /** 已声明：出现在每次请求的 tools schema 里。 */
  declared?: boolean | null;
  /** 索引中：只出现在提示词【按需能力】索引里，装载后下一步才进 schema。 */
  indexed?: boolean | null;
  /** 不可用/未声明的原因（tooltip 用）。 */
  reason?: string;
}

export interface ToolPolicy {
  mode: 'allow' | 'deny';
  allow: string[];
  deny: string[];
  extra: string[];
  /** 档位覆盖：工具名或能力组 → active/passive（缺省用内置分档） */
  tiers?: Record<string, ToolTier>;
}

export interface ToolGroup {
  id: string;
  label: string;
  capability: string | null;
  tools: string[];
}

export type ToolState = 'declared' | 'indexed' | 'disabled' | 'unknown';

/** 三态计数（工具页顶部摘要）。 */
export interface ToolStateSummary {
  declared: number;
  indexed: number;
  disabled: number;
  unknown: number;
}

/** 该配置档应使用的 agent preset（装配期决定常驻工具集）。 */
export interface ToolsPresetInfo {
  id: string;
  modules: string[];
}

/** 策略里引用、但发现清单里已经不存在的条目（失效条目）。 */
export interface StalePolicyEntry {
  name: string;
  where: 'allow' | 'deny' | 'tiers';
}

export interface ToolsPayload {
  items: ToolItem[];
  policy: ToolPolicy;
  visible: string[];
  groups?: ToolGroup[];
  groupState?: ToolGroup[];
  stateSummary?: ToolStateSummary;
  /** 策略里失效的条目（指向已不存在的工具/分组）。 */
  stale?: { policy: StalePolicyEntry[] };
  preset?: ToolsPresetInfo | null;
  note?: string;
}

export interface SkillItem {
  name: string;
  source?: string;
  description?: string;
}

export interface SkillPolicy {
  mode: 'all' | 'allow';
  allow: string[];
}

export interface SkillsPayload {
  items: SkillItem[];
  policy: SkillPolicy;
}

export interface KbDoc {
  id: number;
  botId: string;
  source: string;
  title: string | null;
  hash?: string;
  meta?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  chunkCount: number;
}

/** 文档分块（编辑回填用；块间有少量 overlapping 文本）。 */
export interface KbDocChunk {
  id: number;
  ord: number;
  text: string;
}

export interface KbDocDetail extends KbDoc {
  chunks: KbDocChunk[];
}

export interface KbHit {
  chunkId?: number;
  docId?: number;
  text: string;
  title?: string | null;
  score?: number;
  mode?: string;
}

export interface IngestResult {
  doc?: KbDoc;
  chunks: number;
}

export interface Memory {
  id: number;
  botId?: string;
  peer?: string | null;
  kind?: string;
  text: string;
  tags?: string[] | string | null;
  source?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/** POST /api/memories/search 返回项：实体 + 检索元数据。 */
export interface MemoryHit extends Memory {
  score?: number;
  mode?: string;
  snippet?: string;
}

/** POST /api/memories 返回：实体 + 近似去重标记。 */
export interface MemorySaveResult extends Memory {
  created?: boolean;
  deduped?: boolean;
}

export interface Member {
  id: number;
  botId?: string;
  openid: string;
  nickname?: string | null;
  note?: string | null;
  profileJson?: unknown;
  updatedAt?: number;
}

export interface MemberInput {
  botId: string;
  openid?: string;
  nickname?: string | null;
  note?: string | null;
  profileJson?: unknown;
}

export interface Persona {
  id: string;
  botId?: string;
  name: string;
  content: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PersonaInput {
  botId: string;
  name: string;
  content?: string;
}

export interface Sticker {
  id: number;
  botId?: string;
  name: string;
  file: string;
  emotion?: string | null;
  hash?: string | null;
  createdAt: number;
}

export interface StickerInput {
  botId: string;
  name: string;
  file: string;
  emotion?: string;
  hash?: string;
}

export interface StickerQuota {
  day: string;
  count: number;
}

/** 会话诊断（GET /api/tools/sessions?bot=…）。 */
export interface ToolSession {
  peer: string;
  sessionId: string;
  /** 本轮点亮的能力组 */
  groups: string[];
  /** 本轮点名点亮的工具 */
  tools: string[];
  /** 本次 assembly 真正声明的工具 */
  declared: string[];
  /** 其中属于「按需」档、因激活而出现的工具 */
  passiveDeclared: string[];
  /** 系统提示词字符数 */
  promptChars: number;
  sections?: number;
  error?: string;
}

export interface ToolSessionsPayload {
  items: ToolSession[];
  count: number;
  note?: string;
}

export interface AuditEntry {
  id: number;
  at: number;
  botId?: string | null;
  kind: string;
  detail?: string | null;
}

/** SSE /api/events 的一条事件。 */
export interface SseEvent {
  seq: number;
  event: string;
  at: number;
  data: unknown;
}

export type SseStatus = 'connecting' | 'live' | 'down';

/** 提示词拼合预览的单个 prompt 段（GET /api/preview/prompt）。 */
export interface PromptSection {
  name: string;
  label: string;
  text: string;
  chars: number;
  /** 后端标记的空段（例如 query 为空时的 memory/knowledge）。 */
  empty?: boolean;
  /** live 预览：ours=本插件段，host=宿主段（空文本即被遮蔽）。 */
  kind?: 'ours' | 'host';
  /** live 预览：段在 assembly 里的实际顺序。 */
  order?: number;
}

export interface PromptTool {
  name: string;
  tier?: ToolTier | '';
}

export interface PromptActivation {
  groups: string[];
  tools: string[];
}

/**
 * GET /api/preview/prompt 响应。
 * source=live 时是真实 assembly（含宿主段/遮蔽结果/本次声明的工具）；
 * source=composed 时只包含本插件注册的段（模拟拼合）。
 */
export interface PromptPreview {
  ok: boolean;
  source: string;
  sections: PromptSection[];
  text: string;
  notes: string[];
  toolNames: string[];
  skillNames: string[];
  /** 渲染后字符数（live 预览）。 */
  chars?: number;
  /** live 预览：本次真正声明的工具（被动未激活的不在内）。 */
  tools?: PromptTool[];
  /** 运行时上下文快照（user 角色）：记忆/知识/群友/时间，不进系统提示词前缀。 */
  contextSections?: PromptSection[];
  /** 运行时上下文拼合全文（供复制）。 */
  contextText?: string;
  contexts?: string[];
  variables?: string[];
  activation?: PromptActivation;
  /** 该 live 会话绑定的 agent preset（装配期决定的工具集）。 */
  presetId?: string;
  /** 按当前配置档应该使用的 preset；与 presetId 不同说明配置改了但会话没重建。 */
  expectedPresetId?: string;
  /** presetId ≠ expectedPresetId：新配置要在新会话（/new 或重建）才生效。 */
  presetStale?: boolean;
  /** 有会话但实时预览不可用时的原因（no-session / no-service / assemble-failed…）。 */
  liveUnavailable?: string | null;
}

export interface PromptPreviewInput {
  botId: string;
  profileId?: string;
  peer?: string;
  query?: string;
  scope?: 'group' | 'c2c';
}


// ── 模型中心（docs/MODELS-CENTER.md §7）────────────────────────

/** 模型类型插槽：status=ready 渲染成可编辑 tab，planned 归入「更多类型」。 */
export interface ModelSlot {
  id: string;
  label: string;
  status: 'ready' | 'planned';
  /** ready 插槽对应的 settings schema 分节 id（llm→model / vision→vision / voice→voice）。 */
  settingsSection?: string;
  desc?: string;
  /** planned 插槽的扩展点说明。 */
  extend?: string;
  icon?: string;
}

/** GET /api/models/slots：控制台 tab 的单一真相。 */
export interface ModelSlotsPayload {
  slots: ModelSlot[];
  ready: string[];
  planned: string[];
}

/** 宿主 LLM provider（GET /api/models/llm 的候选来源）。 */
export interface LlmProvider {
  id: string;
  name: string;
}

/** 宿主 LLM 模型目录项。 */
export interface LlmModel {
  provider: string;
  id: string;
  name: string;
  description?: string;
  inputModalities?: string[];
}

/** GET /api/models/llm：宿主 llm 服务不可用时返回空目录 + warning，不报错。 */
export interface LlmCatalog {
  providers: LlmProvider[];
  models: LlmModel[];
  warning?: string;
}

/** TTS 字段下拉候选。 */
export interface TtsOptionItem {
  value: string;
  label: string;
}

export type TtsFieldType = 'text' | 'textarea' | 'select' | 'number' | 'json' | 'audio';

/** TTS kind 的表单字段元数据（控制台抽屉按 type 通用渲染）。 */
export interface TtsField {
  key: string;
  label: string;
  type: TtsFieldType;
  /** 静态候选（select 用）。 */
  options?: TtsOptionItem[];
  /** 候选引用 kind 的 models / voices 列表（select 用）。 */
  optionsFrom?: 'models' | 'voices';
  required?: boolean;
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  /** audio 字段允许的扩展名（文件选择器过滤用）。 */
  accept?: string[];
}

/** TTS 供应商种类元数据（GET /api/models/tts/kinds）。 */
export interface TtsKind {
  id: string;
  label: string;
  short: string;
  /** 分组：default（默认音色）/ clone（克隆）/ design（文字设计）。 */
  group: string;
  groupLabel: string;
  /** 供应商能力：tts（合成）/ asr（语音识别，复用同一供应商表）。 */
  capability?: 'tts' | 'asr';
  desc: string;
  /** 需要「生成音色」动作的类型（MiniMax 克隆/设计）的按钮文案。 */
  prepareLabel?: string;
  prepareHint?: string;
  needsSecret: boolean;
  secretLabel: string;
  secretPlaceholder: string;
  secretHelp: string;
  defaultConfig: Record<string, unknown>;
  models: TtsOptionItem[];
  voices: TtsOptionItem[];
  fields: TtsField[];
  outputFormat: 'mp3' | 'wav';
  maxCharsPerRequest: number;
  timeoutMs: number;
}

/** 已配置的 TTS 供应商（脱敏视图：只有 hasSecret，不含 secret）。 */
export interface TtsProvider {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  kindShort: string;
  /** 分组：default / clone / design（由后端按 kind 推导）。 */
  group: string;
  groupLabel: string;
  /** 供应商能力：tts（合成）/ asr（语音识别）。 */
  capability?: 'tts' | 'asr';
  enabled: boolean;
  config: Record<string, unknown>;
  hasSecret: boolean;
  /** 模型 · 音色等一行摘要（后端拼好）。 */
  summary: string;
  outputFormat: string;
  createdAt: number;
  updatedAt: number;
}

/** 新增/编辑 TTS 供应商入参；编辑时 secret 缺省或空串 = 保留原值。 */
export interface TtsProviderInput {
  name?: string;
  kind?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secret?: string;
}

/** TTS 供应商分组元数据（控制台按组拆成三个区块）。 */
export interface TtsGroup {
  id: string;
  label: string;
  order: number;
  desc: string;
}

/** GET /api/models/tts/kinds。 */
export interface TtsKindsPayload {
  kinds: TtsKind[];
  groups: TtsGroup[];
}

/** 克隆样本文件选择器根目录。 */
export interface TtsAudioRoot {
  id: string;
  label: string;
  path: string;
}

/** 克隆样本文件选择器条目（目录或音频文件）。 */
export interface TtsAudioEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  ext?: string;
  size?: number;
}

/** GET /api/models/tts/audio/list。 */
export interface TtsAudioList {
  path: string;
  parent: string | null;
  roots: TtsAudioRoot[];
  entries: TtsAudioEntry[];
  truncated: boolean;
}

/** GET /api/models/tts/providers。 */
export interface TtsProviderList {
  providers: TtsProvider[];
  defaultProvider: string;
}

/** POST /api/models/tts/providers/:id/prepare 的生成音色结果（MiniMax 克隆/设计）。 */
export interface TtsPrepareResult {
  ok: boolean;
  provider: TtsProvider;
  voiceId: string;
  demoAudioBase64?: string;
  demoMimeType?: string;
  demoBytes?: number;
}

/** POST /api/models/tts/providers/:id/test 的试听结果。 */
export interface TtsTestResult {
  ok: boolean;
  providerId: string;
  kind: string;
  model: string;
  voice: string;
  format: string;
  bytes: number;
  ms: number;
  /** 音频 base64（无 data: 前缀）；超过 4MB 时后端省略并置 tooLarge。 */
  audioBase64?: string;
  mimeType?: string;
  tooLarge?: boolean;
}

// ── 群日报卡片模板（ReportsPage；接口契约见 .work/ui-adaptation/contract.md §3）──

/** 模板预览的示例氛围：热闹 / 平静 / 深夜（只影响带插画的模板）。 */
/** 模板声明的氛围 id（由模板 meta.json 的 visuals 决定，后端不写死取值）。 */
export type ReportTemplateMood = string;

/** 模板声明的插画槽（精简视图；素材清单在后端，页面只需要氛围切换）。 */
export interface ReportTemplateVisuals {
  slots: string[];
  moods: Array<{ id: string; label: string }>;
  defaultMood: string;
}

/** 卡片模板（GET /api/reports/templates 的 items 项；内置 + 数据目录自定义）。 */
export interface ReportTemplate {
  name: string;
  label: string;
  description: string;
  builtin: boolean;
  /** 模板 meta.json 里的 visuals 声明；没有插画槽的模板为 null。 */
  visuals?: ReportTemplateVisuals | null;
}

/** GET /api/reports/templates。 */
export interface ReportTemplatesPayload {
  items: ReportTemplate[];
  /** <dataDir>/templates 的父目录（未装配数据目录时为空串）。 */
  dataDir: string;
}

/** GET /api/reports/templates/preview：用示例数据渲染出的自包含 HTML。 */
export interface ReportTemplatePreview {
  name: string;
  label: string;
  description: string;
  builtin: boolean;
  /** iframe 建议逻辑宽度（卡片最宽 1080 + body padding）。 */
  width: number;
  /** 模板声明的插画槽；没有插画槽的模板为 null。 */
  visuals?: ReportTemplateVisuals | null;
  mood: ReportTemplateMood;
  day: string;
  html: string;
}

/** 安装模板的一个文件；content 是 base64。 */
export interface ReportTemplateFile {
  path: string;
  content: string;
}

/** POST /api/reports/templates/install 入参。 */
export interface ReportTemplateInstallInput {
  name: string;
  label?: string;
  description?: string;
  files: ReportTemplateFile[];
  replace?: boolean;
}

/** POST /api/reports/templates/install 返回（label/description 为写完后回读的结果）。 */
export interface ReportTemplateInstallResult {
  ok: boolean;
  name: string;
  label: string;
  description: string;
  builtin: false;
  files: number;
  bytes: number;
}

