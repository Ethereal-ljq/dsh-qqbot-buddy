/**
 * api/normalize —— 把控制台返回的 JSON 收敛成前端类型。
 *
 * 后端契约已定稿（camelCase、裸数组），这里保留少量别名兜底：
 *  - bot.hasSecret / hasAppSecret 两种命名；
 *  - schema 可能是裸数组（console 兜底）或 {sections,items} 对象（core/config）；
 *  - 列表可能被包在 {items}/{data} 里（防御性，不影响正常路径）。
 */
import type {
  AuditEntry, Binding, Bot, BotRuntime, ConsoleInfo, Health, IngestResult, KbDoc, KbHit,
  Member, Memory, Persona, Profile, SchemaItem, SchemaPayload, SchemaSection, SettingsPayload,
  SkillItem, SkillPolicy, SkillsPayload, StateSnapshot, Sticker, StickerQuota, ToolItem, ToolPolicy,
  ToolsPayload, MemoryHit, PromptPreview, PromptSection,
  LlmCatalog, LlmModel, ModelSlot, ModelSlotsPayload, TtsField, TtsFieldType, TtsKind, TtsOptionItem,
  TtsProvider, TtsProviderList, TtsTestResult,
} from './types';
import { setPath } from '../lib/objects';

type Raw = Record<string, unknown>;

function rec(value: unknown): Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

function val(src: Raw, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = src[key];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function str(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'string' ? value : String(value);
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = rec(value);
  const inner = obj.items ?? obj.data ?? obj.results ?? obj.list;
  return Array.isArray(inner) ? inner : [];
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [];
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return rec(JSON.parse(value)); } catch { return {}; }
  }
  return rec(value);
}

export function normHealth(raw: unknown): Health {
  const r = rec(raw);
  return {
    ok: bool(val(r, 'ok'), true),
    version: str(val(r, 'version'), 'unknown'),
    startedAt: val(r, 'startedAt') === undefined ? undefined : num(val(r, 'startedAt')),
    uptimeMs: val(r, 'uptimeMs') === undefined ? undefined : num(val(r, 'uptimeMs')),
    online: val(r, 'online') === undefined ? undefined : bool(val(r, 'online')),
  };
}

export function normBot(raw: unknown): Bot {
  const r = rec(raw);
  const id = str(val(r, 'id'));
  const appSecret = str(val(r, 'appSecret', 'app_secret'));
  return {
    id,
    name: str(val(r, 'name'), id),
    appId: str(val(r, 'appId', 'app_id')),
    appSecret,
    hasSecret: bool(val(r, 'hasSecret', 'hasAppSecret'), appSecret !== ''),
    enabled: bool(val(r, 'enabled'), true),
    cwd: val(r, 'cwd') === undefined || val(r, 'cwd') === null ? null : str(val(r, 'cwd')),
    createdAt: num(val(r, 'createdAt', 'created_at')),
    updatedAt: num(val(r, 'updatedAt', 'updated_at')),
  };
}

export function normProfile(raw: unknown): Profile {
  const r = rec(raw);
  return {
    id: str(val(r, 'id')),
    botId: str(val(r, 'botId', 'bot_id')),
    name: str(val(r, 'name')),
    data: parseJson(val(r, 'data')),
    isDefault: bool(val(r, 'isDefault', 'is_default')),
    createdAt: num(val(r, 'createdAt', 'created_at')),
    updatedAt: num(val(r, 'updatedAt', 'updated_at')),
  };
}

export function normBinding(raw: unknown): Binding {
  const r = rec(raw);
  return {
    id: num(val(r, 'id')),
    botId: str(val(r, 'botId', 'bot_id')),
    scope: str(val(r, 'scope')),
    profileId: str(val(r, 'profileId', 'profile_id')),
    profileName: val(r, 'profileName') === undefined ? undefined : str(val(r, 'profileName')),
    priority: num(val(r, 'priority')),
    createdAt: num(val(r, 'createdAt', 'created_at')),
  };
}

export function normState(raw: unknown): StateSnapshot {
  const r = rec(raw);
  const runtime = rec(val(r, 'runtime'));
  const runtimeBots = rec(val(runtime, 'bots'));
  const consoleRaw = rec(val(r, 'console'));
  const activeRaw = rec(val(r, 'activeProfiles', 'active_profiles'));
  const activeProfiles: Record<string, string> = {};
  for (const [key, value] of Object.entries(activeRaw)) activeProfiles[key] = str(value);
  const bots: Record<string, BotRuntime> = {};
  for (const [key, value] of Object.entries(runtimeBots)) {
    const item = rec(value);
    bots[key] = { status: str(val(item, 'status'), 'unknown'), startedAt: val(item, 'startedAt') === undefined ? undefined : num(val(item, 'startedAt')) };
  }
  const consoleInfo: ConsoleInfo = {
    version: str(val(consoleRaw, 'version'), ''),
    startedAt: val(consoleRaw, 'startedAt') === undefined ? undefined : num(val(consoleRaw, 'startedAt')),
    uptimeMs: val(consoleRaw, 'uptimeMs') === undefined ? undefined : num(val(consoleRaw, 'uptimeMs')),
    host: val(consoleRaw, 'host') === undefined ? undefined : str(val(consoleRaw, 'host')),
    port: val(consoleRaw, 'port') === undefined ? undefined : num(val(consoleRaw, 'port')),
  };
  const dshWebRaw = val(r, 'dshWeb', 'dsh_web');
  const dshWeb = dshWebRaw === undefined || dshWebRaw === null ? null : (() => {
    const item = rec(dshWebRaw);
    return {
      url: str(val(item, 'url'), ''),
      ready: bool(val(item, 'ready'), false),
      error: str(val(item, 'error'), ''),
    };
  })();
  return {
    version: str(val(r, 'version'), ''),
    online: bool(val(r, 'online'), true),
    bots: list(val(r, 'bots')).map(normBot),
    profiles: list(val(r, 'profiles')).map(normProfile),
    bindings: list(val(r, 'bindings')).map(normBinding),
    activeProfiles,
    console: consoleInfo,
    runtime: { online: bool(val(runtime, 'online'), false), bots },
    dshWeb,
  };
}

function normSchemaValues(value: unknown): SchemaItem['values'] {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const r = rec(item);
        return { value: str(val(r, 'value')), label: str(val(r, 'label'), str(val(r, 'value'))) };
      }
      return String(item);
    });
  }
  const obj = rec(value);
  return Object.entries(obj).map(([key, label]) => ({ value: key, label: str(label, key) }));
}

function normSchemaItem(raw: unknown): SchemaItem {
  const r = rec(raw);
  const section = val(r, 'section', 'group');
  const scopeRaw = str(val(r, 'scope'));
  const scope = scopeRaw === 'global' || scopeRaw === 'bot' || scopeRaw === 'profile' ? scopeRaw : undefined;
  return {
    key: str(val(r, 'key')),
    section: section === undefined ? undefined : str(section),
    scope,
    type: val(r, 'type') === undefined ? undefined : str(val(r, 'type')),
    label: val(r, 'label') === undefined ? undefined : str(val(r, 'label')),
    help: val(r, 'help', 'description') === undefined ? undefined : str(val(r, 'help', 'description')),
    description: val(r, 'description') === undefined ? undefined : str(val(r, 'description')),
    widget: val(r, 'widget') === undefined ? undefined : str(val(r, 'widget')),
    values: normSchemaValues(val(r, 'values', 'enum')),
    optionsFrom: val(r, 'optionsFrom', 'options_from') === undefined ? undefined : str(val(r, 'optionsFrom', 'options_from')),
    min: val(r, 'min') === undefined ? undefined : num(val(r, 'min')),
    max: val(r, 'max') === undefined ? undefined : num(val(r, 'max')),
    step: val(r, 'step') === undefined ? undefined : num(val(r, 'step')),
    default: val(r, 'default'),
  };
}

export function normSchema(raw: unknown): SchemaPayload {
  if (Array.isArray(raw)) {
    const items = raw.map(normSchemaItem);
    const byId = new Map<string, SchemaSection>();
    for (const item of items) {
      if (!item.section || byId.has(item.section)) continue;
      byId.set(item.section, { id: item.section, label: item.section });
    }
    return { sections: [...byId.values()], items };
  }
  const r = rec(raw);
  const sections = list(val(r, 'sections')).map((item) => {
    const section = rec(item);
    return { id: str(val(section, 'id')), label: str(val(section, 'label'), str(val(section, 'id'))), order: num(val(section, 'order')), desc: val(section, 'desc') === undefined ? undefined : str(val(section, 'desc')) };
  });
  return { sections, items: list(val(r, 'items')).map(normSchemaItem) };
}

/**
 * 设置值在接口层是扁平点号键（{ 'reply.mode': 'adaptive' }），
 * 但 SchemaForm 按点号路径读取嵌套对象，这里统一还原成嵌套。
 */
function nestSettings(flat: Raw): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key.includes('.')) out = setPath(out, key, value);
    else out[key] = value;
  }
  return out;
}

export function normSettings(raw: unknown): SettingsPayload {
  const r = rec(raw);
  const botId = str(val(r, 'botId'), '');
  const values = val(r, 'values');
  if (values !== undefined) return { botId, values: nestSettings(rec(values)) };
  const rest = { ...r };
  delete rest.botId;
  return { botId, values: nestSettings(rest) };
}

export function normToolPolicy(raw: unknown): ToolPolicy {
  const r = rec(raw);
  return {
    mode: str(val(r, 'mode'), 'allow') === 'deny' ? 'deny' : 'allow',
    allow: strings(val(r, 'allow')),
    deny: strings(val(r, 'deny')),
    extra: strings(val(r, 'extra')),
  };
}

function normToolItem(raw: unknown): ToolItem {
  const r = rec(raw);
  return {
    name: str(val(r, 'name')),
    source: val(r, 'source') === undefined ? undefined : str(val(r, 'source')),
    description: val(r, 'description') === undefined ? undefined : str(val(r, 'description')),
    restrictable: bool(val(r, 'restrictable'), true),
    enabled: val(r, 'enabled') === undefined ? undefined : bool(val(r, 'enabled')),
    visible: val(r, 'visible') === undefined ? undefined : bool(val(r, 'visible')),
  };
}

export function normTools(raw: unknown): ToolsPayload {
  const r = rec(raw);
  return {
    items: list(val(r, 'items')).map(normToolItem),
    policy: normToolPolicy(val(r, 'policy')),
    visible: strings(val(r, 'visible')),
    note: val(r, 'note') === undefined ? undefined : str(val(r, 'note')),
  };
}

function normSkillItem(raw: unknown): SkillItem {
  const r = rec(raw);
  return {
    name: str(val(r, 'name')),
    source: val(r, 'source') === undefined ? undefined : str(val(r, 'source')),
    description: val(r, 'description') === undefined ? undefined : str(val(r, 'description')),
  };
}

export function normSkills(raw: unknown): SkillsPayload {
  const r = rec(raw);
  const policy = rec(val(r, 'policy'));
  const policyOut: SkillPolicy = { mode: str(val(policy, 'mode'), 'allow') === 'all' ? 'all' : 'allow', allow: strings(val(policy, 'allow')) };
  return { items: list(val(r, 'items')).map(normSkillItem), policy: policyOut };
}

export function normKbDoc(raw: unknown): KbDoc {
  const r = rec(raw);
  const createdAt = num(val(r, 'createdAt', 'created_at'));
  return {
    id: num(val(r, 'id')),
    botId: str(val(r, 'botId', 'bot_id')),
    source: str(val(r, 'source')),
    title: val(r, 'title') === undefined || val(r, 'title') === null ? null : str(val(r, 'title')),
    hash: val(r, 'hash') === undefined ? undefined : str(val(r, 'hash')),
    meta: val(r, 'meta') === undefined || val(r, 'meta') === null ? null : parseJson(val(r, 'meta')),
    createdAt,
    updatedAt: num(val(r, 'updatedAt', 'updated_at'), createdAt),
    chunkCount: num(val(r, 'chunkCount', 'chunk_count')),
  };
}

export function normKbHit(raw: unknown): KbHit {
  const r = rec(raw);
  return {
    chunkId: val(r, 'chunkId') === undefined ? undefined : num(val(r, 'chunkId')),
    docId: val(r, 'docId') === undefined ? undefined : num(val(r, 'docId')),
    text: str(val(r, 'text')),
    title: val(r, 'title') === undefined || val(r, 'title') === null ? null : str(val(r, 'title')),
    score: val(r, 'score') === undefined ? undefined : num(val(r, 'score')),
    mode: val(r, 'mode') === undefined ? undefined : str(val(r, 'mode')),
  };
}

function normPromptSection(raw: unknown): PromptSection {
  const r = rec(raw);
  const text = str(val(r, 'text'));
  return {
    name: str(val(r, 'name')),
    label: str(val(r, 'label'), str(val(r, 'name'))),
    text,
    chars: num(val(r, 'chars'), Array.from(text).length),
    empty: val(r, 'empty') === undefined ? text.trim() === '' : bool(val(r, 'empty')),
  };
}

/** 提示词拼合预览：缺字段时尽量兜底，不让 UI 崩。 */
export function normPromptPreview(raw: unknown): PromptPreview {
  const r = rec(raw);
  const sections = list(val(r, 'sections')).map(normPromptSection);
  const text = val(r, 'text') === undefined
    ? sections.map((section) => section.text).filter(Boolean).join('\n\n')
    : str(val(r, 'text'));
  return {
    ok: bool(val(r, 'ok'), true),
    source: str(val(r, 'source'), 'composed'),
    sections,
    text,
    notes: strings(val(r, 'notes')),
    toolNames: strings(val(r, 'toolNames', 'tool_names')),
    skillNames: strings(val(r, 'skillNames', 'skill_names')),
  };
}

export function normIngest(raw: unknown): IngestResult {
  const r = rec(raw);
  return {
    doc: val(r, 'doc') === undefined ? undefined : normKbDoc(val(r, 'doc')),
    chunks: num(val(r, 'chunks')),
  };
}

export function normMemoryHit(raw: unknown): MemoryHit {
  const base = normMemory(raw);
  const r = rec(raw);
  return {
    ...base,
    score: val(r, 'score') === undefined ? undefined : num(val(r, 'score')),
    mode: val(r, 'mode') === undefined ? undefined : str(val(r, 'mode')),
    snippet: val(r, 'snippet') === undefined ? undefined : str(val(r, 'snippet')),
  };
}

export function normMemory(raw: unknown): Memory {
  const r = rec(raw);
  return {
    id: num(val(r, 'id')),
    botId: val(r, 'botId') === undefined ? undefined : str(val(r, 'botId')),
    peer: val(r, 'peer') === undefined || val(r, 'peer') === null ? null : str(val(r, 'peer')),
    kind: val(r, 'kind') === undefined ? undefined : str(val(r, 'kind')),
    text: str(val(r, 'text')),
    tags: (val(r, 'tags') as Memory['tags']) ?? null,
    source: val(r, 'source') === undefined || val(r, 'source') === null ? null : str(val(r, 'source')),
    createdAt: val(r, 'createdAt') === undefined ? undefined : num(val(r, 'createdAt')),
    updatedAt: val(r, 'updatedAt') === undefined ? undefined : num(val(r, 'updatedAt')),
  };
}

export function normMember(raw: unknown): Member {
  const r = rec(raw);
  return {
    id: num(val(r, 'id')),
    botId: val(r, 'botId') === undefined ? undefined : str(val(r, 'botId')),
    openid: str(val(r, 'openid')),
    nickname: val(r, 'nickname') === undefined || val(r, 'nickname') === null ? null : str(val(r, 'nickname')),
    note: val(r, 'note') === undefined || val(r, 'note') === null ? null : str(val(r, 'note')),
    profileJson: val(r, 'profileJson', 'profile_json'),
    updatedAt: val(r, 'updatedAt') === undefined ? undefined : num(val(r, 'updatedAt')),
  };
}

export function normPersona(raw: unknown): Persona {
  const r = rec(raw);
  return {
    id: str(val(r, 'id')),
    botId: val(r, 'botId') === undefined ? undefined : str(val(r, 'botId')),
    name: str(val(r, 'name')),
    content: str(val(r, 'content')),
    active: bool(val(r, 'active'), false),
    createdAt: num(val(r, 'createdAt')),
    updatedAt: num(val(r, 'updatedAt')),
  };
}

export function normSticker(raw: unknown): Sticker {
  const r = rec(raw);
  return {
    id: num(val(r, 'id')),
    botId: val(r, 'botId') === undefined ? undefined : str(val(r, 'botId')),
    name: str(val(r, 'name')),
    file: str(val(r, 'file')),
    emotion: val(r, 'emotion') === undefined || val(r, 'emotion') === null ? null : str(val(r, 'emotion')),
    hash: val(r, 'hash') === undefined || val(r, 'hash') === null ? null : str(val(r, 'hash')),
    createdAt: num(val(r, 'createdAt')),
  };
}

export function normStickerQuota(raw: unknown): StickerQuota {
  const r = rec(raw);
  return { day: str(val(r, 'day')), count: num(val(r, 'count')) };
}

export function normAudit(raw: unknown): AuditEntry {
  const r = rec(raw);
  return {
    id: num(val(r, 'id')),
    at: num(val(r, 'at')),
    botId: val(r, 'botId', 'bot_id') === undefined || val(r, 'botId', 'bot_id') === null ? null : str(val(r, 'botId', 'bot_id')),
    kind: str(val(r, 'kind')),
    detail: val(r, 'detail') === undefined || val(r, 'detail') === null ? null : str(val(r, 'detail')),
  };
}

// ── 模型中心 ────────────────────────────────────────────────

function ttsOptions(value: unknown): TtsOptionItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const r = rec(item);
      return { value: str(val(r, 'value')), label: str(val(r, 'label'), str(val(r, 'value'))) };
    }
    return { value: String(item), label: String(item) };
  });
}

const TTS_FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'json'];

function ttsFieldType(value: unknown): TtsFieldType {
  const text = str(value);
  return (TTS_FIELD_TYPES.includes(text) ? text : 'text') as TtsFieldType;
}

export function normModelSlot(raw: unknown): ModelSlot {
  const r = rec(raw);
  const settingsSection = val(r, 'settingsSection', 'settings_section');
  return {
    id: str(val(r, 'id')),
    label: str(val(r, 'label'), str(val(r, 'id'))),
    status: str(val(r, 'status')) === 'ready' ? 'ready' : 'planned',
    settingsSection: settingsSection === undefined || settingsSection === null ? undefined : str(settingsSection),
    desc: val(r, 'desc') === undefined ? undefined : str(val(r, 'desc')),
    extend: val(r, 'extend') === undefined ? undefined : str(val(r, 'extend')),
    icon: val(r, 'icon') === undefined ? undefined : str(val(r, 'icon')),
  };
}

/** GET /api/models/slots：slots 优先；ready/planned 缺失时由 status 推导。 */
export function normModelSlots(raw: unknown): ModelSlotsPayload {
  const r = rec(raw);
  const slots = list(val(r, 'slots')).map(normModelSlot);
  const readyRaw = strings(val(r, 'ready'));
  const plannedRaw = strings(val(r, 'planned'));
  return {
    slots,
    ready: readyRaw.length > 0 ? readyRaw : slots.filter((slot) => slot.status === 'ready').map((slot) => slot.id),
    planned: plannedRaw.length > 0 ? plannedRaw : slots.filter((slot) => slot.status === 'planned').map((slot) => slot.id),
  };
}

/** GET /api/models/llm：宿主目录尽力而为，缺字段按空处理。 */
export function normLlmCatalog(raw: unknown): LlmCatalog {
  const r = rec(raw);
  const catalog: LlmCatalog = {
    providers: list(val(r, 'providers')).map((item) => {
      const provider = rec(item);
      return { id: str(val(provider, 'id')), name: str(val(provider, 'name'), str(val(provider, 'id'))) };
    }),
    models: list(val(r, 'models')).map((item) => {
      const model = rec(item);
      const parsed: LlmModel = {
        provider: str(val(model, 'provider')),
        id: str(val(model, 'id')),
        name: str(val(model, 'name'), str(val(model, 'id'))),
      };
      const description = str(val(model, 'description'));
      if (description !== '') parsed.description = description;
      const modalities = val(model, 'inputModalities', 'input_modalities');
      if (Array.isArray(modalities)) parsed.inputModalities = strings(modalities);
      return parsed;
    }),
  };
  const warning = str(val(r, 'warning'));
  if (warning !== '') catalog.warning = warning;
  return catalog;
}

function normTtsField(raw: unknown): TtsField {
  const r = rec(raw);
  const field: TtsField = {
    key: str(val(r, 'key')),
    label: str(val(r, 'label'), str(val(r, 'key'))),
    type: ttsFieldType(val(r, 'type')),
  };
  const options = ttsOptions(val(r, 'options'));
  if (options.length > 0) field.options = options;
  const from = str(val(r, 'optionsFrom', 'options_from'));
  if (from === 'models' || from === 'voices') field.optionsFrom = from;
  if (val(r, 'required') !== undefined) field.required = bool(val(r, 'required'));
  if (val(r, 'placeholder') !== undefined) field.placeholder = str(val(r, 'placeholder'));
  if (val(r, 'help') !== undefined) field.help = str(val(r, 'help'));
  if (val(r, 'min') !== undefined) field.min = num(val(r, 'min'));
  if (val(r, 'max') !== undefined) field.max = num(val(r, 'max'));
  if (val(r, 'step') !== undefined) field.step = num(val(r, 'step'));
  if (val(r, 'maxLength', 'max_length') !== undefined) field.maxLength = num(val(r, 'maxLength', 'max_length'));
  return field;
}

export function normTtsKind(raw: unknown): TtsKind {
  const r = rec(raw);
  const format = str(val(r, 'outputFormat', 'output_format')) === 'wav' ? 'wav' : 'mp3';
  return {
    id: str(val(r, 'id')),
    label: str(val(r, 'label'), str(val(r, 'id'))),
    short: str(val(r, 'short'), str(val(r, 'label'), str(val(r, 'id')))),
    desc: str(val(r, 'desc')),
    needsSecret: bool(val(r, 'needsSecret', 'needs_secret')),
    secretLabel: str(val(r, 'secretLabel', 'secret_label')),
    secretPlaceholder: str(val(r, 'secretPlaceholder', 'secret_placeholder')),
    secretHelp: str(val(r, 'secretHelp', 'secret_help')),
    defaultConfig: parseJson(val(r, 'defaultConfig', 'default_config')),
    models: ttsOptions(val(r, 'models')),
    voices: ttsOptions(val(r, 'voices')),
    fields: list(val(r, 'fields')).map(normTtsField),
    outputFormat: format,
    maxCharsPerRequest: num(val(r, 'maxCharsPerRequest', 'max_chars_per_request'), 2000),
    timeoutMs: num(val(r, 'timeoutMs', 'timeout_ms'), 120000),
  };
}

/** GET /api/models/tts/kinds：兼容 {kinds:[...]} 与裸数组。 */
export function normTtsKinds(raw: unknown): TtsKind[] {
  if (Array.isArray(raw)) return raw.map(normTtsKind);
  const r = rec(raw);
  return list(val(r, 'kinds')).map(normTtsKind);
}

export function normTtsProvider(raw: unknown): TtsProvider {
  const r = rec(raw);
  const kind = str(val(r, 'kind'));
  return {
    id: str(val(r, 'id')),
    name: str(val(r, 'name')),
    kind,
    kindLabel: str(val(r, 'kindLabel', 'kind_label'), kind),
    kindShort: str(val(r, 'kindShort', 'kind_short'), kind),
    enabled: bool(val(r, 'enabled'), true),
    config: parseJson(val(r, 'config')),
    hasSecret: bool(val(r, 'hasSecret', 'has_secret')),
    summary: str(val(r, 'summary')),
    outputFormat: str(val(r, 'outputFormat', 'output_format'), 'mp3'),
    createdAt: num(val(r, 'createdAt', 'created_at')),
    updatedAt: num(val(r, 'updatedAt', 'updated_at')),
  };
}

/** GET /api/models/tts/providers。 */
export function normTtsProviderList(raw: unknown): TtsProviderList {
  const r = rec(raw);
  return {
    providers: list(val(r, 'providers')).map(normTtsProvider),
    defaultProvider: str(val(r, 'defaultProvider', 'default_provider')),
  };
}

/** POST /api/models/tts/providers/:id/test。 */
export function normTtsTestResult(raw: unknown): TtsTestResult {
  const r = rec(raw);
  return {
    ok: bool(val(r, 'ok'), true),
    providerId: str(val(r, 'providerId', 'provider_id')),
    kind: str(val(r, 'kind')),
    model: str(val(r, 'model')),
    voice: str(val(r, 'voice')),
    format: str(val(r, 'format'), 'mp3'),
    bytes: num(val(r, 'bytes')),
    ms: num(val(r, 'ms')),
    audioBase64: val(r, 'audioBase64', 'audio_base64') === undefined ? undefined : str(val(r, 'audioBase64', 'audio_base64')),
    mimeType: val(r, 'mimeType', 'mime_type') === undefined ? undefined : str(val(r, 'mimeType', 'mime_type')),
    tooLarge: val(r, 'tooLarge', 'too_large') === undefined ? undefined : bool(val(r, 'tooLarge', 'too_large')),
  };
}
