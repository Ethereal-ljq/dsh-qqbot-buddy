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
  AuditEntry, Binding, Bot, BotInput, Health, IngestResult, KbDoc, KbHit, Member, MemberInput,
  Memory, MemoryHit, MemorySaveResult, Persona, PersonaInput, Profile, PromptPreview, PromptPreviewInput,
  SchemaPayload, SessionInfo, SettingsPayload, SkillPolicy, SkillsPayload, StateSnapshot, Sticker,
  StickerInput, StickerQuota, ToolPolicy, ToolsPayload,
} from './types';
import {
  normAudit, normBinding, normBot, normHealth, normIngest, normKbDoc, normKbHit, normMember,
  normMemory, normMemoryHit, normPersona, normProfile, normPromptPreview, normSchema, normSettings,
  normSkills, normState, normSticker, normStickerQuota, normTools,
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

  // tools / skills（按 profile）
  async tools(profileId: string, signal?: AbortSignal): Promise<ToolsPayload> {
    return normTools(await request('/tools', { query: { profile: profileId }, signal }));
  },
  async saveToolsPolicy(profileId: string, policy: ToolPolicy): Promise<{ profileId: string; policy: ToolPolicy }> {
    const raw = await request<{ profileId?: string; policy?: unknown }>('/tools/policy', { method: 'PUT', body: { profileId, policy } });
    return { profileId: raw?.profileId ?? profileId, policy: normTools({ policy: raw?.policy }).policy };
  },
  async skills(profileId: string, signal?: AbortSignal): Promise<SkillsPayload> {
    return normSkills(await request('/skills', { query: { profile: profileId }, signal }));
  },
  async saveSkillsPolicy(profileId: string, policy: SkillPolicy): Promise<{ profileId: string; policy: SkillPolicy }> {
    return request('/skills/policy', { method: 'PUT', body: { profileId, policy } });
  },

  // 知识库
  async listKbDocs(botId: string, signal?: AbortSignal): Promise<KbDoc[]> {
    const raw = await request<unknown>('/kb/docs', { query: { bot: botId }, signal });
    return (Array.isArray(raw) ? raw : []).map(normKbDoc);
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
