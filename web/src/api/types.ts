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

/** 设置项 UI 元数据（GET /api/schema）。 */
export interface SchemaSection {
  id: string;
  label: string;
  order?: number;
  desc?: string;
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
  sections: SchemaSection[];
  items: SchemaItem[];
}

export interface SettingsPayload {
  botId: string;
  values: Record<string, unknown>;
}

export interface ToolItem {
  name: string;
  source?: string;
  description?: string;
  restrictable?: boolean;
  enabled?: boolean;
  visible?: boolean;
}

export interface ToolPolicy {
  mode: 'allow' | 'deny';
  allow: string[];
  deny: string[];
  extra: string[];
}

export interface ToolsPayload {
  items: ToolItem[];
  policy: ToolPolicy;
  visible: string[];
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
}

/**
 * GET /api/preview/prompt 响应。
 * 只包含本插件注册的 prompt 段；宿主段（身份/工具 schema）由 dsh 在运行时追加，不在此处。
 */
export interface PromptPreview {
  ok: boolean;
  source: string;
  sections: PromptSection[];
  text: string;
  notes: string[];
  toolNames: string[];
  skillNames: string[];
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

export type TtsFieldType = 'text' | 'textarea' | 'select' | 'number' | 'json';

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
}

/** TTS 供应商种类元数据（GET /api/models/tts/kinds）。 */
export interface TtsKind {
  id: string;
  label: string;
  short: string;
  desc: string;
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

/** GET /api/models/tts/providers。 */
export interface TtsProviderList {
  providers: TtsProvider[];
  defaultProvider: string;
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

