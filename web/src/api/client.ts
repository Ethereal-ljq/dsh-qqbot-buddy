/**
 * api/client —— 控制台 HTTP 客户端。
 *
 * 所有页面只通过这里访问后端：
 *  - 同源 cookie（credentials: 'include'），非 GET 自动加 X-QQBot-CSRF: 1；
 *  - 401 统一广播给应用层（跳到登录页），其它错误收敛为 ApiError；
 *  - 404 / 501 视为“后端能力未装配”，页面据此渲染空态；
 *  - 响应统一交给 api/normalize 收敛字段。
 */
import type {
  KbDocDetail,
  AuditEntry, Binding, Bot, BotInput, Health, IngestResult, KbDoc, KbHit, LlmCatalog, Member, MemberInput,
  Memory, MemoryHit, MemorySaveResult, ModelSlotsPayload, Persona, PersonaInput, Profile, PromptPreview,
  PromptPreviewInput, SchemaPayload, SessionInfo, SettingsPayload, SkillPolicy, SkillsPayload, StateSnapshot,
  Sticker, StickerInput, StickerQuota, ToolPolicy, ToolSessionsPayload, ToolsPayload, TtsAudioList, TtsKindsPayload, TtsProvider,
  TtsProviderInput, TtsProviderList, TtsPrepareResult, TtsTestResult,
  ReportTemplateInstallInput, ReportTemplateInstallResult, ReportTemplateMood, ReportTemplatePreview,
  ReportTemplatesPayload,
} from './types';
import {
  normAudit, normBinding, normBot, normHealth, normIngest, normKbDoc, normKbHit, normLlmCatalog, normMember,
  normMemory, normMemoryHit, normModelSlots, normPersona, normProfile, normPromptPreview, normSchema, normSettings,
  normSkills, normState, normSticker, normStickerQuota, normToolSessions, normTools, normTtsAudioList, normTtsKinds, normTtsProvider,
  normTtsProviderList, normTtsPrepareResult, normTtsTestResult,
  normReportTemplateInstall, normReportTemplatePreview, normReportTemplates,
} from './normalize';

const CSRF_HEADERS: Record<string, string> = { 'X-QQBot-CSRF': '1' };

/** 统一 API 错误。status=0 表示网络层失败（服务未启动）。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly url: string;

  constructor(message: string, init: { status: number; code: string; requestId?: string; url: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.url = init.url;
  }

  /** 404 / 501：后端尚未实现该能力，页面应展示空态。 */
  get unimplemented(): boolean {
    return this.status === 404 || this.status === 501;
  }

  get network(): boolean {
    return this.status === 0;
  }
}

export function toApiError(err: unknown, url = ''): ApiError {
  if (err instanceof ApiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ApiError(message, { status: 0, code: 'unknown_error', url });
}

/** 401 广播：应用层收到后把登录态置为失效。 */
const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => { unauthorizedListeners.delete(listener); };
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  /** 401 时是否触发全局登出（login 请求自己处理失败）。 */
  silent401?: boolean;
}

function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? '?' + text : '';
}

async function parseError(res: Response, url: string): Promise<ApiError> {
  let code = 'http_' + res.status;
  let message = '请求失败（HTTP ' + res.status + '）';
  const requestId = res.headers.get('x-request-id') || undefined;
  try {
    const text = await res.text();
    if (text) {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      if (parsed && parsed.error) {
        if (parsed.error.code) code = String(parsed.error.code);
        if (parsed.error.message) message = String(parsed.error.message);
      }
    }
  } catch {
    /* 错误体不是 JSON：保留 HTTP 状态文案 */
  }
  return new ApiError(message, { status: res.status, code, requestId, url });
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const url = '/api' + path + buildQuery(options.query);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET' && method !== 'HEAD') Object.assign(headers, CSRF_HEADERS);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, credentials: 'include', signal: options.signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError('无法连接控制台服务，请确认插件进程与控制台端口（默认 127.0.0.1:6198）已启动。', {
      status: 0, code: 'network_error', url,
    });
  }

  if (!res.ok) {
    if (res.status === 401 && !options.silent401) {
      for (const listener of unauthorizedListeners) {
        try { listener(); } catch { /* 监听器异常不影响请求错误返回 */ }
      }
    }
    throw await parseError(res, url);
  }

  if (res.status === 204 || res.status === 205) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// ── 具体资源 ────────────────────────────────────────────────

export const api = {
  // 鉴权
  async login(token: string): Promise<{ ok: boolean; expiresAt?: number }> {
    return request('/auth/login', { method: 'POST', body: { token }, silent401: true });
  },
  async logout(): Promise<{ ok: boolean }> {
    return request('/auth/logout', { method: 'POST' });
  },
  async session(signal?: AbortSignal): Promise<SessionInfo> {
    return request('/auth/session', { signal });
  },
  async health(signal?: AbortSignal): Promise<Health> {
    return normHealth(await request('/health', { signal }));
  },

  // 全局快照
  async state(signal?: AbortSignal): Promise<StateSnapshot> {
    return normState(await request('/state', { signal }));
  },

  // bots
  async listBots(signal?: AbortSignal): Promise<Bot[]> {
    const raw = await request<unknown>('/bots', { signal });
    return (Array.isArray(raw) ? raw : []).map(normBot);
  },
  async createBot(input: BotInput): Promise<Bot> {
    return normBot(await request('/bots', { method: 'POST', body: input }));
  },
  async updateBot(id: string, patch: Partial<BotInput>): Promise<Bot> {
    return normBot(await request('/bots/' + encodeURIComponent(id), { method: 'PATCH', body: patch }));
  },
  async deleteBot(id: string): Promise<{ ok: boolean; id: string }> {
    return request('/bots/' + encodeURIComponent(id), { method: 'DELETE' });
  },

  // profiles
  async listProfiles(botId?: string, signal?: AbortSignal): Promise<Profile[]> {
    const raw = await request<unknown>('/profiles', { query: { bot: botId }, signal });
    return (Array.isArray(raw) ? raw : []).map(normProfile);
  },
  async createProfile(input: { botId: string; name: string; data?: Record<string, unknown>; isDefault?: boolean }): Promise<Profile> {
    return normProfile(await request('/profiles', { method: 'POST', body: input }));
  },
  async updateProfile(id: string, patch: { name?: string; data?: Record<string, unknown>; isDefault?: boolean }): Promise<Profile> {
    return normProfile(await request('/profiles/' + encodeURIComponent(id), { method: 'PATCH', body: patch }));
  },
  async deleteProfile(id: string): Promise<{ ok: boolean; id: string }> {
    return request('/profiles/' + encodeURIComponent(id), { method: 'DELETE' });
  },
  async activateProfile(profileId: string, botId?: string): Promise<Profile> {
    return normProfile(await request('/profiles/' + encodeURIComponent(profileId) + '/activate', { method: 'POST', body: { botId } }));
  },

  // bindings
  async listBindings(botId?: string, signal?: AbortSignal): Promise<Binding[]> {
    const raw = await request<unknown>('/bindings', { query: { bot: botId }, signal });
    return (Array.isArray(raw) ? raw : []).map(normBinding);
  },
  async upsertBinding(input: { botId: string; scope: string; profileId: string; priority?: number }): Promise<Binding> {
    return normBinding(await request('/bindings', { method: 'PUT', body: input }));
  },
  async updateBinding(id: number, patch: { scope?: string; profileId?: string; priority?: number }): Promise<Binding> {
    return normBinding(await request('/bindings/' + id, { method: 'PUT', body: patch }));
  },
  async deleteBinding(id: number): Promise<{ ok: boolean; id: number }> {
    return request('/bindings/' + id, { method: 'DELETE' });
  },

  // schema / settings
  async schema(signal?: AbortSignal): Promise<SchemaPayload> {
    return normSchema(await request('/schema', { signal }));
  },
  async settings(botId?: string, signal?: AbortSignal): Promise<SettingsPayload> {
    return normSettings(await request('/settings', { query: { bot: botId }, signal }));
  },
  async saveSettings(botId: string | undefined, values: Record<string, unknown>): Promise<SettingsPayload> {
    return normSettings(await request('/settings', { method: 'PUT', query: { bot: botId }, body: { values } }));
  },

  // 模型中心（LLM / 视觉 / TTS 供应商 / 模型类型插槽；契约见 docs/MODELS-CENTER.md §7）
  async modelSlots(signal?: AbortSignal): Promise<ModelSlotsPayload> {
    return normModelSlots(await request('/models/slots', { signal }));
  },
  async llmCatalog(signal?: AbortSignal): Promise<LlmCatalog> {
    return normLlmCatalog(await request('/models/llm', { signal }));
  },
  async ttsKinds(signal?: AbortSignal): Promise<TtsKindsPayload> {
    return normTtsKinds(await request('/models/tts/kinds', { signal }));
  },
  /** 克隆样本文件选择器：列目录（仅目录 + 音频文件），path 省略 = 第一个根目录。 */
  async ttsAudioList(path?: string, signal?: AbortSignal): Promise<TtsAudioList> {
    return normTtsAudioList(await request('/models/tts/audio/list', { query: { path }, signal }));
  },
  async ttsProviders(signal?: AbortSignal): Promise<TtsProviderList> {
    return normTtsProviderList(await request('/models/tts/providers', { signal }));
  },
  async createTtsProvider(input: TtsProviderInput): Promise<TtsProvider> {
    return normTtsProvider(await request('/models/tts/providers', { method: 'POST', body: input }));
  },
  async updateTtsProvider(id: string, input: TtsProviderInput): Promise<TtsProvider> {
    return normTtsProvider(await request('/models/tts/providers/' + encodeURIComponent(id), { method: 'PATCH', body: input }));
  },
  async deleteTtsProvider(id: string): Promise<{ ok: boolean; id: string }> {
    return request('/models/tts/providers/' + encodeURIComponent(id), { method: 'DELETE' });
  },
  /** 执行生成音色（MiniMax 克隆/设计）：上传样本或调用设计接口，返回 voiceId + 可选试听。 */
  async prepareTtsProvider(id: string): Promise<TtsPrepareResult> {
    return normTtsPrepareResult(await request('/models/tts/providers/' + encodeURIComponent(id) + '/prepare', { method: 'POST', body: {} }));
  },
  /** 合成一段测试语音；返回 base64 供页面 <audio> 试听。 */
  async testTtsProvider(id: string, text?: string): Promise<TtsTestResult> {
    const body = text !== undefined && text !== '' ? { text } : {};
    return normTtsTestResult(await request('/models/tts/providers/' + encodeURIComponent(id) + '/test', { method: 'POST', body }));
  },

  // tools / skills（按 profile）
  async tools(profileId: string, signal?: AbortSignal): Promise<ToolsPayload> {
    return normTools(await request('/tools', { query: { profile: profileId }, signal }));
  },
  async saveToolsPolicy(profileId: string, policy: ToolPolicy): Promise<{ profileId: string; policy: ToolPolicy }> {
    const raw = await request<{ profileId?: string; policy?: unknown }>('/tools/policy', { method: 'PUT', body: { profileId, policy } });
    return { profileId: raw?.profileId ?? profileId, policy: normTools({ policy: raw?.policy }).policy };
  },
  /** 一键清理「当前环境已不存在」的工具条目（失效的 allow/deny/tiers），落库后返回删掉的名字。 */
  async cleanupTools(profileId: string): Promise<{ profileId: string; removed: Array<{ name: string; where: string }>; policy: ToolPolicy }> {
    const raw = await request<{ profileId?: string; removed?: unknown; policy?: unknown }>('/tools/cleanup', { method: 'POST', body: { profileId } });
    const removed = Array.isArray(raw?.removed)
      ? (raw.removed as Array<Record<string, unknown>>).map((item) => ({ name: String(item?.name ?? ''), where: String(item?.where ?? '') })).filter((item) => item.name !== '')
      : [];
    return { profileId: raw?.profileId ?? profileId, removed, policy: normTools({ policy: raw?.policy }).policy };
  },
  /** 会话诊断：每个 live 会话的激活组 / 声明工具 / 提示词字符数。 */
  async toolSessions(botId: string, signal?: AbortSignal): Promise<ToolSessionsPayload> {
    return normToolSessions(await request('/tools/sessions', { query: { bot: botId }, signal }));
  },
  /** 工具清单按 bot 解析默认配置档（概览页用）。 */
  async toolsForBot(botId: string, signal?: AbortSignal): Promise<ToolsPayload> {
    return normTools(await request('/tools', { query: { bot: botId }, signal }));
  },
  async skills(profileId: string, signal?: AbortSignal): Promise<SkillsPayload> {
    return normSkills(await request('/skills', { query: { profile: profileId }, signal }));
  },
  async saveSkillsPolicy(profileId: string, policy: SkillPolicy): Promise<{ profileId: string; policy: SkillPolicy }> {
    return request('/skills/policy', { method: 'PUT', body: { profileId, policy } });
  },

  // 知识库
  async listKbDocs(
    botId: string,
    options: { includeArchived?: boolean; kind?: string } = {},
    signal?: AbortSignal,
  ): Promise<KbDoc[]> {
    const raw = await request<unknown>('/kb/docs', {
      query: { bot: botId, archived: options.includeArchived ? '1' : undefined, kind: options.kind },
      signal,
    });
    return (Array.isArray(raw) ? raw : []).map(normKbDoc);
  },
  /** 只改治理元数据（分类 / 置信度 / 权威 / 保护位 / 归档 / 恢复），不动正文与分块。 */
  async updateKbDocMeta(id: number, input: { botId: string; kind?: string; confidence?: number; authority?: string; pinned?: boolean; stale?: boolean; sourceUrl?: string; fetchedAt?: string }): Promise<KbDoc | null> {
    const raw = await request<{ doc?: unknown }>('/kb/docs/' + id + '/meta', { method: 'POST', body: input });
    return raw && raw.doc ? normKbDoc(raw.doc) : null;
  },
  /** 知识治理：dryRun=true 只预览候选，false 执行软归档 + 清理超 TTL 归档。 */
  async runKbHygiene(input: { botId: string; dryRun: boolean }): Promise<{ archive: Array<{ id: number; title: string; reason: string }>; purge: Array<{ id: number; title: string }>; scanned: number; archived?: number; purged?: number }> {
    return request('/kb/hygiene', { method: 'POST', body: input });
  },
  /** 文档详情 + 分块（编辑回填）。 */
  async getKbDoc(botId: string, id: number, signal?: AbortSignal): Promise<KbDocDetail> {
    const raw = await request<unknown>('/kb/docs/' + id, { query: { bot: botId }, signal });
    const detail = normKbDoc(raw);
    const chunks = Array.isArray((raw as Record<string, unknown>)?.chunks)
      ? ((raw as Record<string, unknown>).chunks as Array<Record<string, unknown>>).map((chunk) => ({
        id: Number(chunk?.id) || 0,
        ord: Number(chunk?.ord) || 0,
        text: String(chunk?.text ?? ''),
      }))
      : [];
    return { ...detail, chunks };
  },
  /** 编辑文档：同 source 原地 re-ingest（docId 不变，重建分块与 FTS）。 */
  async updateKbDoc(input: { botId: string; id: number; title?: string; text: string; kind?: string; confidence?: number; authority?: string; pinned?: boolean; sourceUrl?: string; fetchedAt?: string }): Promise<IngestResult> {
    const raw = await request<unknown>('/kb/docs/' + input.id, {
      method: 'PUT',
      body: { botId: input.botId, title: input.title, text: input.text },
    });
    return normIngest(raw);
  },
  async deleteKbDoc(id: number, botId: string): Promise<{ ok: boolean; id: number }> {
    return request('/kb/docs/' + id, { method: 'DELETE', query: { bot: botId } });
  },
  async ingestKb(input: { botId: string; source?: string; title?: string; text: string; meta?: Record<string, unknown> }): Promise<IngestResult> {
    return normIngest(await request('/kb/ingest', { method: 'POST', body: input }));
  },
  async searchKb(input: { botId: string; query: string; limit?: number }): Promise<KbHit[]> {
    const raw = await request<unknown>('/kb/search', { method: 'POST', body: input });
    return (Array.isArray(raw) ? raw : []).map(normKbHit);
  },

  // 记忆（bot 级共享；写操作走真实内核，近似去重）
  async listMemories(
    botId: string,
    options: { peer?: string; kind?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<Memory[]> {
    const raw = await request<unknown>('/memories', {
      query: { bot: botId, peer: options.peer, kind: options.kind, limit: options.limit, offset: options.offset },
      signal,
    });
    return (Array.isArray(raw) ? raw : []).map(normMemory);
  },
  async createMemory(input: { botId: string; text: string; peer?: string; kind?: string; tags?: string[]; source?: string }): Promise<MemorySaveResult> {
    const raw = await request<Record<string, unknown>>('/memories', { method: 'POST', body: input });
    return {
      ...normMemory(raw),
      created: raw?.created === undefined ? undefined : Boolean(raw.created),
      deduped: raw?.deduped === undefined ? undefined : Boolean(raw.deduped),
    };
  },
  async updateMemory(id: number, patch: { text?: string; kind?: string; tags?: string[] }): Promise<Memory> {
    const raw = await request<unknown>('/memories/' + id, { method: 'PUT', body: patch });
    return normMemory(raw);
  },
  async deleteMemory(id: number): Promise<{ ok: boolean; id: number }> {
    return request('/memories/' + id, { method: 'DELETE' });
  },
  async searchMemories(input: { botId: string; query: string; limit?: number }, signal?: AbortSignal): Promise<MemoryHit[]> {
    const raw = await request<unknown>('/memories/search', { method: 'POST', body: input, signal });
    return (Array.isArray(raw) ? raw : []).map(normMemoryHit);
  },

  // 群友库（按 bot 共享；profileJson 对象浅合并）
  async listMembers(
    botId: string,
    options: { query?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<Member[]> {
    const raw = await request<unknown>('/members', {
      query: { bot: botId, q: options.query, limit: options.limit, offset: options.offset },
      signal,
    });
    return (Array.isArray(raw) ? raw : []).map(normMember);
  },
  async saveMember(input: MemberInput): Promise<Member> {
    return normMember(await request('/members', { method: 'POST', body: input }));
  },
  async updateMember(id: number, botId: string, patch: { nickname?: string | null; note?: string | null; profileJson?: unknown }): Promise<Member> {
    return normMember(await request('/members/' + id, { method: 'PATCH', query: { bot: botId }, body: patch }));
  },
  async deleteMember(id: number, botId: string): Promise<{ ok: boolean; id: number }> {
    return request('/members/' + id, { method: 'DELETE', query: { bot: botId } });
  },

  // 人格卡（同 bot 唯一 active；激活会同步 persona.md）
  async listPersonas(botId: string, signal?: AbortSignal): Promise<Persona[]> {
    const raw = await request<unknown>('/personas', { query: { bot: botId }, signal });
    return (Array.isArray(raw) ? raw : []).map(normPersona);
  },
  async createPersona(input: PersonaInput): Promise<Persona> {
    return normPersona(await request('/personas', { method: 'POST', body: input }));
  },
  async updatePersona(id: string, botId: string, patch: { name?: string; content?: string }): Promise<Persona> {
    return normPersona(await request('/personas/' + encodeURIComponent(id), { method: 'PATCH', query: { bot: botId }, body: patch }));
  },
  async deletePersona(id: string, botId: string): Promise<{ ok: boolean; id: string }> {
    return request('/personas/' + encodeURIComponent(id), { method: 'DELETE', query: { bot: botId } });
  },
  async activatePersona(id: string, botId: string): Promise<Persona> {
    return normPersona(await request('/personas/' + encodeURIComponent(id) + '/activate', { method: 'POST', body: { botId } }));
  },

  // 表情包（JSON 注册已有文件；按 hash 去重）
  async listStickers(
    botId: string,
    options: { emotion?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ): Promise<Sticker[]> {
    const raw = await request<unknown>('/stickers', {
      query: { bot: botId, emotion: options.emotion, limit: options.limit, offset: options.offset },
      signal,
    });
    return (Array.isArray(raw) ? raw : []).map(normSticker);
  },
  async addSticker(input: StickerInput): Promise<Sticker & { created?: boolean }> {
    const raw = await request<Record<string, unknown>>('/stickers', { method: 'POST', body: input });
    return { ...normSticker(raw), created: raw?.created === undefined ? undefined : Boolean(raw.created) };
  },
  async deleteSticker(id: number, botId: string): Promise<{ ok: boolean; id: number }> {
    return request('/stickers/' + id, { method: 'DELETE', query: { bot: botId } });
  },
  /** 表情包原图 URL（同源、走 cookie 鉴权；用于缩略图/大图预览）。 */
  stickerFileUrl(botId: string, id: number): string {
    return '/api/stickers/' + encodeURIComponent(String(id)) + '/file?bot=' + encodeURIComponent(botId);
  },
  async stickerQuota(botId: string, signal?: AbortSignal): Promise<StickerQuota> {
    return normStickerQuota(await request('/stickers/quota', { query: { bot: botId }, signal }));
  },

  // 提示词拼合预览（M1c）：只含本插件 prompt 段，宿主段由 dsh 追加
  async previewPrompt(input: PromptPreviewInput, signal?: AbortSignal): Promise<PromptPreview> {
    const raw = await request<unknown>('/preview/prompt', {
      query: {
        bot: input.botId,
        profile: input.profileId,
        peer: input.peer,
        query: input.query,
        scope: input.scope,
      },
      signal,
    });
    return normPromptPreview(raw);
  },

  // 群日报卡片模板（契约：.work/ui-adaptation/contract.md §3.1）
  /** 可用模板：内置 journal/dark + <dataDir>/templates 下的自定义模板。 */
  async listReportTemplates(signal?: AbortSignal): Promise<ReportTemplatesPayload> {
    return normReportTemplates(await request('/reports/templates', { signal }));
  },
  /** 模板预览元数据（label/宽度/示例日期等）；meta=true 时不带 HTML（页面用 docUrl 进 iframe）。 */
  async previewReportTemplate(
    name: string,
    options: { mood?: ReportTemplateMood; meta?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<ReportTemplatePreview> {
    return normReportTemplatePreview(await request('/reports/templates/preview', {
      query: { name, mood: options.mood, meta: options.meta ? '1' : undefined },
      signal,
    }));
  },
  /**
   * 预览文档 URL（给 iframe src 用，不走 fetch）：
   * 独立响应带自己的窄 CSP，模板内联脚本才能执行；控制台页面 CSP 保持 script-src 'self'。
   */
  reportTemplatePreviewUrl(name: string, options: { mood?: ReportTemplateMood; day?: string } = {}): string {
    const params = new URLSearchParams({ name });
    if (options.mood) params.set('mood', options.mood);
    if (options.day) params.set('day', options.day);
    return '/api/reports/templates/preview/html?' + params.toString();
  },
  /** 安装自定义模板（files[].content 为 base64；同名覆盖用 replace）。 */
  async installReportTemplate(input: ReportTemplateInstallInput): Promise<ReportTemplateInstallResult> {
    return normReportTemplateInstall(await request('/reports/templates/install', { method: 'POST', body: input }));
  },
  /** 删除自定义模板（内置模板后端拒绝）。 */
  async deleteReportTemplate(name: string): Promise<{ ok: boolean; name: string }> {
    return request('/reports/templates/' + encodeURIComponent(name), { method: 'DELETE' });
  },

  // 审计
  async listAudit(limit = 100, signal?: AbortSignal): Promise<AuditEntry[]> {
    const raw = await request<unknown>('/audit', { query: { limit }, signal });
    return (Array.isArray(raw) ? raw : []).map(normAudit);
  },

  // 动作（start/stop/restart/reconnect/ingest-url/extract）
  async action(name: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return request('/actions/' + encodeURIComponent(name), { method: 'POST', body: payload });
  },
};

export type ApiClient = typeof api;
