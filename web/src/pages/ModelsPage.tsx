/**
 * pages/ModelsPage —— 模型中心（docs/MODELS-CENTER.md §10）。
 *
 * 页面结构完全由后端元数据驱动：
 *  - tab 来自 GET /api/models/slots（ready → 可编辑 tab，planned → 「更多类型」）；
 *  - 表单来自 GET /api/schema（sectionId = 插槽的 settingsSection），保存只提交
 *    当前 tab 的差异路径（与 ProfilesPage 相同的 api.updateProfile 模式）；
 *  - 语音 tab 多一块全局 TTS 供应商面板：kinds 元数据通用渲染 Drawer 表单，
 *    secret 只写不读（编辑时留空 = 保留），试听用 <audio> 播放返回的 base64。
 *
 * 后端未实现（404/501）时不伪造数据：ErrorNote 的「尚未接入」空态 + 重试。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, toApiError } from '../api/client';
import type {
  ModelSlot, TtsField, TtsKind, TtsProvider, TtsProviderInput, TtsTestResult,
} from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { Field } from '../components/Field';
import { PageHeader } from '../components/PageHeader';
import { invalidateSchemaOptions, SchemaForm } from '../components/SchemaForm';
import { Badge } from '../components/Status';
import { Tabs } from '../components/Tabs';
import { fmtBytes, prettyJson } from '../lib/format';
import { getPath, pathsToPatch } from '../lib/objects';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';
import { useApi } from '../state/useApi';

/** 「更多类型」伪 tab（planned 插槽展示，不对应 schema 分节）。 */
const MORE_TAB = '__more__';

interface ModelTab {
  id: string;
  label: string;
  /** settings schema 分节 id（dirty 归组与保存都按它）。 */
  section: string;
  slot: ModelSlot | null;
}

interface ProviderDraft {
  name: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /** json 字段的编辑文本（保存时统一校验并解析）。 */
  jsonText: Record<string, string>;
  secret: string;
}

interface ProviderTestState {
  busy: boolean;
  error: string | null;
  result: TtsTestResult | null;
}

/** 以 kind 的默认配置（或既有 config）生成供应商表单草稿。 */
function draftOfKind(kind: TtsKind, config?: Record<string, unknown>): ProviderDraft {
  const source = config ?? kind.defaultConfig;
  const jsonText: Record<string, string> = {};
  for (const field of kind.fields) {
    if (field.type === 'json') jsonText[field.key] = prettyJson(source[field.key] ?? {});
  }
  return {
    name: kind.label,
    kind: kind.id,
    enabled: true,
    config: { ...source },
    jsonText,
    secret: '',
  };
}

/** 试听音频的 data URL（后端只给裸 base64 + mimeType）。 */
function audioDataUrl(result: TtsTestResult): string {
  const mime = result.mimeType || (result.format === 'wav' ? 'audio/wav' : 'audio/mpeg');
  return 'data:' + mime + ';base64,' + (result.audioBase64 ?? '');
}

export function ModelsPage() {
  const { botId, bots, profiles, activeProfile, notify, reloadState } = useApp();

  // 元数据：插槽（tab）、schema（表单）、宿主 LLM 目录、TTS kinds / providers。
  const slots = useApi((signal) => api.modelSlots(signal), []);
  const schema = useApi((signal) => api.schema(signal), []);
  const catalog = useApi((signal) => api.llmCatalog(signal), []);
  const kinds = useApi((signal) => api.ttsKinds(signal), []);
  const providers = useApi((signal) => api.ttsProviders(signal), []);

  const [selectedId, setSelectedId] = useState('');
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
  const [tab, setTab] = useState('');
  const [dirty, setDirty] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  /** optionsFrom 候选缓存失效版本：供应商 CRUD 后 +1，驱动 SchemaForm 重新拉取。 */
  const [optionsRevision, setOptionsRevision] = useState(0);

  // TTS 供应商面板 / 抽屉
  const [drawer, setDrawer] = useState<{ mode: 'create' | 'edit'; provider: TtsProvider | null } | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TtsProvider | null>(null);
  const [deletingProvider, setDeletingProvider] = useState(false);
  const [testState, setTestState] = useState<Record<string, ProviderTestState>>({});

  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;

  // 默认选中当前生效配置档；profiles/activeProfile 变化时校正选择。
  useEffect(() => {
    if (profiles.length === 0) {
      if (selectedId !== '') setSelectedId('');
      return;
    }
    if (selectedId !== '' && profiles.some((profile) => profile.id === selectedId)) return;
    setSelectedId(activeProfile?.id ?? profiles[0].id);
  }, [profiles, selectedId, activeProfile]);

  // 切换配置档丢弃未保存修改（切换前已二次确认）。
  useEffect(() => { setDirty({}); }, [selectedId]);

  const slotList = slots.data?.slots ?? [];
  const readySlots = slotList.filter((slot) => slot.status === 'ready');
  const plannedSlots = slotList.filter((slot) => slot.status === 'planned');

  const modelTabs = useMemo<ModelTab[]>(() => {
    const data = slots.data;
    if (!data) return [];
    const list: ModelTab[] = data.slots
      .filter((slot) => slot.status === 'ready')
      .map((slot) => ({ id: slot.id, label: slot.label, section: slot.settingsSection || slot.id, slot }));
    list.push({ id: MORE_TAB, label: '更多类型', section: MORE_TAB, slot: null });
    return list;
  }, [slots.data]);

  useEffect(() => {
    if (modelTabs.length === 0) return;
    if (modelTabs.some((item) => item.id === tab)) return;
    setTab(modelTabs[0].id);
  }, [modelTabs, tab]);

  const currentTab = modelTabs.find((item) => item.id === tab) ?? modelTabs[0] ?? null;

  const sectionByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of schema.data?.items ?? []) map.set(item.key, item.section || 'other');
    return map;
  }, [schema.data]);

  const totalDirtyCount = Object.keys(dirty).length;

  const dirtyKeysFor = (section: string): string[] => {
    if (section === MORE_TAB) return [];
    return Object.keys(dirty).filter((key) => (sectionByKey.get(key) || 'other') === section);
  };

  const dirtyCountFor = (section: string): number => dirtyKeysFor(section).length;

  const saveSection = async (section: string) => {
    if (!selected) return;
    const keys = dirtyKeysFor(section);
    if (keys.length === 0) return;
    const patch: Record<string, unknown> = {};
    for (const key of keys) patch[key] = dirty[key];
    setSaving(true);
    try {
      await api.updateProfile(selected.id, { data: pathsToPatch(patch) });
      setDirty((prev) => {
        const next = { ...prev };
        for (const key of keys) delete next[key];
        return next;
      });
      notify('ok', '已保存 ' + keys.length + ' 项模型设置');
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '保存失败：' + error.message, error.code);
    } finally {
      setSaving(false);
    }
  };

  const discardSection = (section: string) => {
    const keys = dirtyKeysFor(section);
    if (keys.length === 0) return;
    setDirty((prev) => {
      const next = { ...prev };
      for (const key of keys) delete next[key];
      return next;
    });
  };

  const switchProfile = (profileId: string) => {
    if (profileId === selectedId) return;
    if (totalDirtyCount > 0) {
      setPendingSelectId(profileId);
      return;
    }
    setSelectedId(profileId);
  };

  // ── TTS 供应商：抽屉 / CRUD / 试听 ──────────────────────
  const kindById = useMemo(() => new Map((kinds.data ?? []).map((kind) => [kind.id, kind])), [kinds.data]);

  const openCreateProvider = () => {
    const first = kinds.data?.[0];
    if (!first) {
      notify('error', '供应商类型元数据尚未加载');
      return;
    }
    setDrawer({ mode: 'create', provider: null });
    setDraft(draftOfKind(first));
    setDraftError(null);
  };

  const openEditProvider = (provider: TtsProvider) => {
    const kind = kindById.get(provider.kind);
    if (!kind) {
      notify('error', '未知的 TTS 供应商类型：' + provider.kind);
      return;
    }
    setDrawer({ mode: 'edit', provider });
    setDraft({ ...draftOfKind(kind, provider.config), name: provider.name, enabled: provider.enabled });
    setDraftError(null);
  };

  const changeDraftKind = (kindId: string) => {
    const kind = kindById.get(kindId);
    if (!kind) return;
    setDraft((prev) => ({
      ...draftOfKind(kind),
      name: prev && prev.name.trim() !== '' ? prev.name : kind.label,
      enabled: prev ? prev.enabled : true,
    }));
  };

  const setConfigField = (key: string, value: unknown) => {
    setDraft((prev) => (prev ? { ...prev, config: { ...prev.config, [key]: value } } : prev));
  };

  const setJsonText = (key: string, text: string) => {
    setDraft((prev) => (prev ? { ...prev, jsonText: { ...prev.jsonText, [key]: text } } : prev));
  };

  /** 校验并收敛抽屉里的 config；失败返回错误文案。 */
  const parseDraftConfig = (kind: TtsKind): Record<string, unknown> | string => {
    if (!draft) return '表单尚未初始化';
    const config: Record<string, unknown> = {};
    for (const field of kind.fields) {
      if (field.type === 'json') {
        const text = (draft.jsonText[field.key] ?? '').trim();
        if (text === '') continue;
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { return '「' + field.label + '」不是合法 JSON'; }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return '「' + field.label + '」必须是 JSON 对象';
        }
        config[field.key] = parsed;
        continue;
      }
      const value = draft.config[field.key];
      const missing = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
      if (missing) {
        if (field.required) return '请填写「' + field.label + '」';
        continue;
      }
      config[field.key] = value;
    }
    return config;
  };

  const saveProvider = async () => {
    if (!drawer || !draft) return;
    const kind = kindById.get(draft.kind);
    if (!kind) { setDraftError('未知的供应商类型'); return; }
    if (draft.name.trim() === '') { setDraftError('请填写供应商名称'); return; }
    const parsed = parseDraftConfig(kind);
    if (typeof parsed === 'string') { setDraftError(parsed); return; }
    const input: TtsProviderInput = {
      name: draft.name.trim(),
      kind: draft.kind,
      enabled: draft.enabled,
      config: parsed,
    };
    // secret 留空 = 保留原值（新增时后端按空密钥处理）。
    if (draft.secret.trim() !== '') input.secret = draft.secret;
    setSavingProvider(true);
    setDraftError(null);
    try {
      if (drawer.mode === 'edit' && drawer.provider) {
        await api.updateTtsProvider(drawer.provider.id, input);
        notify('ok', '已更新供应商：' + input.name);
      } else {
        await api.createTtsProvider(input);
        notify('ok', '已新增供应商：' + input.name);
      }
      setDrawer(null);
      providers.reload();
      invalidateSchemaOptions('ttsProviders');
      setOptionsRevision((value) => value + 1);
    } catch (err) {
      setDraftError(toApiError(err).message);
    } finally {
      setSavingProvider(false);
    }
  };

  const deleteProvider = async () => {
    if (!deleteTarget) return;
    setDeletingProvider(true);
    try {
      await api.deleteTtsProvider(deleteTarget.id);
      notify('ok', '已删除供应商：' + deleteTarget.name);
      setDeleteTarget(null);
      providers.reload();
      invalidateSchemaOptions('ttsProviders');
      setOptionsRevision((value) => value + 1);
    } catch (err) {
      notify('error', '删除失败：' + toApiError(err).message);
    } finally {
      setDeletingProvider(false);
    }
  };

  const testProvider = async (provider: TtsProvider) => {
    setTestState((prev) => ({ ...prev, [provider.id]: { busy: true, error: null, result: null } }));
    try {
      const result = await api.testTtsProvider(provider.id);
      setTestState((prev) => ({ ...prev, [provider.id]: { busy: false, error: null, result } }));
    } catch (err) {
      setTestState((prev) => ({ ...prev, [provider.id]: { busy: false, error: toApiError(err).message, result: null } }));
    }
  };

  // ── 通用渲染片段 ─────────────────────────────────────────
  /** 渲染某个 schema 分节的配置档表单（含加载/错误/未装配兜底）。 */
  const renderSchemaSection = (section: string): ReactNode => {
    if (schema.loading) return <span className="skeleton skeleton-block" />;
    if (schema.error) return <ErrorNote error={schema.error} onRetry={schema.reload} compact />;
    if (!schema.data || schema.data.items.length === 0) {
      return (
        <EmptyState
          tone="pending"
          compact
          title="设置 schema 尚未装配"
          description="core/config/schema.js 的 schemaPayload() 提供字段元数据；装配后本页自动出现对应设置项。"
          endpoint="GET /api/schema"
        />
      );
    }
    const hasSection = schema.data.items.some((item) => (item.section || 'other') === section);
    if (!hasSection) {
      return (
        <EmptyState
          tone="pending"
          compact
          title="该模型类型暂无设置项"
          description={'settings schema 里还没有「' + section + '」分节；补齐后本页自动出现表单。'}
          endpoint="GET /api/schema"
        />
      );
    }
    return (
      <SchemaForm
        payload={schema.data}
        sectionId={section}
        values={selected?.data ?? {}}
        dirty={dirty}
        scopes={['profile']}
        showScope={false}
        optionsRevision={optionsRevision}
        onChange={(key, value) => setDirty((prev) => ({ ...prev, [key]: value }))}
      />
    );
  };

  /** 单个 tab 的保存栏：只保存/放弃本分节的 dirty。 */
  const saveBarFor = (section: string): ReactNode => {
    const count = dirtyCountFor(section);
    const others = totalDirtyCount - count;
    return (
      <footer className="panel-foot save-bar">
        <span className={'save-hint' + (count > 0 ? ' dirty' : '')}>
          {count > 0 ? '本页 ' + count + ' 项未保存' : '本页修改已保存'}
          {others > 0 ? '；其他 tab 另有 ' + others + ' 项' : ''}
        </span>
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={count === 0 || saving}
            onClick={() => discardSection(section)}
          >
            放弃修改
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={count === 0 || saving}
            onClick={() => void saveSection(section)}
          >
            {saving ? '保存中…' : count > 0 ? '保存 ' + count + ' 项' : '已保存'}
          </button>
        </div>
      </footer>
    );
  };

  /** 按 kinds.fields 元数据通用渲染供应商配置字段。 */
  const renderKindField = (kind: TtsKind, field: TtsField): ReactNode => {
    if (!draft) return null;
    const id = 'tts-field-' + field.key;
    const value = draft.config[field.key];
    if (field.type === 'select') {
      const options = field.options ?? (field.optionsFrom === 'models' ? kind.models : field.optionsFrom === 'voices' ? kind.voices : []);
      return (
        <select id={id} className="input" value={String(value ?? '')} onChange={(event) => setConfigField(field.key, event.target.value)}>
          <option value="">（使用默认）</option>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      );
    }
    if (field.type === 'number') {
      return (
        <input
          id={id}
          type="number"
          className="input mono"
          value={typeof value === 'number' ? value : value === undefined || value === null || value === '' ? '' : String(value)}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(event) => {
            const raw = event.target.value;
            setConfigField(field.key, raw === '' ? undefined : Number(raw));
          }}
        />
      );
    }
    if (field.type === 'textarea') {
      return (
        <textarea
          id={id}
          className="input textarea"
          rows={3}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
          onChange={(event) => setConfigField(field.key, event.target.value)}
        />
      );
    }
    if (field.type === 'json') {
      return (
        <textarea
          id={id}
          className="input mono textarea json-area"
          rows={4}
          spellCheck={false}
          placeholder={field.placeholder}
          value={draft.jsonText[field.key] ?? ''}
          onChange={(event) => setJsonText(field.key, event.target.value)}
        />
      );
    }
    return (
      <input
        id={id}
        type="text"
        className="input"
        maxLength={field.maxLength}
        placeholder={field.placeholder}
        value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
        onChange={(event) => setConfigField(field.key, event.target.value)}
      />
    );
  };

  const providerList = providers.data?.providers ?? [];
  const defaultProvider = providers.data?.defaultProvider ?? '';
  const defaultProviderName = providerList.find((provider) => provider.id === defaultProvider)?.name || defaultProvider;

  const renderProviderCard = (provider: TtsProvider): ReactNode => {
    const kind = kindById.get(provider.kind);
    const test = testState[provider.id];
    return (
      <article
        key={provider.id}
        className={'provider-card' + (provider.enabled ? '' : ' disabled') + (provider.id === defaultProvider ? ' default' : '')}
      >
        <div className="provider-card-head">
          <span className="provider-name">{provider.name}</span>
          {provider.id === defaultProvider ? <Badge tone="info">全局默认</Badge> : null}
          <Badge tone={provider.enabled ? 'ok' : 'idle'}>{provider.enabled ? '启用' : '停用'}</Badge>
        </div>
        <div className="provider-meta">
          <span className="tag">{provider.kindShort || provider.kindLabel || provider.kind}</span>
          <span className="mono">{provider.outputFormat}</span>
          <span>{provider.hasSecret ? '已配置密钥' : kind?.needsSecret ? '缺少密钥' : '免密钥'}</span>
        </div>
        <p className="provider-summary mono">{provider.summary || '（默认配置）'}</p>
        <div className="provider-actions">
          <button type="button" className="btn btn-sm" onClick={() => openEditProvider(provider)}>编辑</button>
          <button type="button" className="btn btn-sm" onClick={() => void testProvider(provider)} disabled={test?.busy}>
            {test?.busy ? '合成中…' : '试听'}
          </button>
          <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setDeleteTarget(provider)}>删除</button>
        </div>
        {test && (test.busy || test.error || test.result) ? (
          <div className="test-bar">
            {test.busy ? <span className="muted">正在调用供应商合成试听…</span> : null}
            {test.error ? <span className="field-error">试听失败：{test.error}</span> : null}
            {test.result ? (
              <>
                {test.result.audioBase64 ? (
                  <audio className="test-audio" controls src={audioDataUrl(test.result)} />
                ) : (
                  <span className="muted">
                    {test.result.tooLarge
                      ? '音频过大（' + fmtBytes(test.result.bytes) + '），已省略播放'
                      : '供应商未返回音频数据'}
                  </span>
                )}
                <span className="test-meta mono">
                  {test.result.kind} · {test.result.format} · {fmtBytes(test.result.bytes)} · {test.result.ms} ms
                  {test.result.voice ? ' · ' + test.result.voice : ''}
                </span>
              </>
            ) : null}
          </div>
        ) : null}
      </article>
    );
  };

  const providerPanel = (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2 className="panel-title">TTS 供应商（全局）</h2>
          <p className="panel-desc">
            所有配置档共用；API Key 只写不读，列表只显示是否已配置。表单字段由供应商种类的 kinds.fields 元数据自动生成。
          </p>
        </div>
        <div className="panel-tools">
          {defaultProvider !== '' ? <Badge tone="info">全局默认：{defaultProviderName}</Badge> : <span className="muted">未设置全局默认</span>}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => providers.reload()} disabled={providers.loading}>刷新</button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={openCreateProvider}
            disabled={!kinds.data || kinds.data.length === 0}
          >
            新增供应商
          </button>
        </div>
      </header>
      <div className="panel-body">
        {providers.loading || kinds.loading ? (
          <span className="skeleton skeleton-block" />
        ) : providers.error ? (
          <ErrorNote error={providers.error} onRetry={providers.reload} />
        ) : kinds.error ? (
          <ErrorNote error={kinds.error} onRetry={kinds.reload} />
        ) : providerList.length === 0 ? (
          <EmptyState
            title="还没有 TTS 供应商"
            description="新增一个语音供应商（Edge 免 Key / MiMo / 百炼 / OpenAI 兼容 / 自定义 HTTP / 本地命令），之后在下方为每个配置档选择。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={openCreateProvider}>新增供应商</button>}
            endpoint="GET /api/models/tts/providers"
          />
        ) : (
          <div className="provider-grid">{providerList.map(renderProviderCard)}</div>
        )}
      </div>
      <p className="panel-note mono">
        数据来源 GET /api/models/tts/providers · 字段元数据 GET /api/models/tts/kinds · 试听 POST /api/models/tts/providers/:id/test
      </p>
    </section>
  );

  // ── 各 tab 内容 ──────────────────────────────────────────
  const llmContent = currentTab ? (
    <>
      <div className="hint-strip">
        <span className="hint-label">说明</span>
        <span className="hint-text">
          供应商由宿主管控：provider / model 候选来自宿主 llm 服务，本页只保存配置档级别的覆盖，留空表示跟随宿主默认。
        </span>
        {catalog.data?.warning ? (
          <span className="hint-warning">{catalog.data.warning}</span>
        ) : catalog.data ? (
          <span className="muted mono">{catalog.data.providers.length} provider · {catalog.data.models.length} model</span>
        ) : null}
      </div>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">对话模型路由</h2>
            <p className="panel-desc">推理强度 / agent preset 由本插件按配置档覆盖；保存后对运行中的机器人下一条消息生效。</p>
          </div>
        </header>
        <div className="panel-body">{renderSchemaSection(currentTab.section)}</div>
        {saveBarFor(currentTab.section)}
      </section>
    </>
  ) : null;

  // 模式卡片可直接点击切换；dirty 优先，保存前也能看到选中态。
  const visionMode = String(dirty['vision.mode'] ?? getPath(selected?.data ?? {}, 'vision.mode', 'llm'));
  const pickVisionMode = (mode: 'llm' | 'dedicated') => {
    setDirty((prev) => ({ ...prev, 'vision.mode': mode }));
  };
  const visionContent = currentTab ? (
    <>
      <div className="mode-grid" role="radiogroup" aria-label="视觉模型来源">
        <button
          type="button"
          role="radio"
          aria-checked={visionMode !== 'dedicated'}
          className={'mode-card' + (visionMode !== 'dedicated' ? ' active' : '')}
          onClick={() => pickVisionMode('llm')}
        >
          <div className="mode-card-head">
            <span className="mode-name">跟随 LLM 自带视觉</span>
            {visionMode !== 'dedicated' ? <Badge tone="ok">当前</Badge> : null}
          </div>
          <p className="mode-desc">
            图片处理走 LLM 自身的多模态能力：图片直接内联进对话上下文，不需要额外模型；同一模型既看文字也看图片。
          </p>
          <p className="mode-desc muted">适合绝大多数场景；内联按「每轮最多图片 / 图片总字节上限」裁剪。</p>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={visionMode === 'dedicated'}
          className={'mode-card' + (visionMode === 'dedicated' ? ' active' : '')}
          onClick={() => pickVisionMode('dedicated')}
        >
          <div className="mode-card-head">
            <span className="mode-name">独立视觉模型</span>
            {visionMode === 'dedicated' ? <Badge tone="ok">当前</Badge> : null}
          </div>
          <p className="mode-desc">
            图片不内联，改由下方指定的视觉模型通过 qqbot_describe_image 阅读：可以用更强的视觉模型配更便宜的对话模型。
          </p>
          <p className="mode-desc muted">需填写 provider / model；读图结果会作为文本回填给对话模型。</p>
        </button>
      </div>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">视觉模型设置</h2>
            <p className="panel-desc">
              按配置档生效：默认跟随 LLM（内联图片）；选「独立视觉模型」后当前消息图片不再内联、改由下方模型阅读。
              无论哪种模式，显式调用 qqbot_describe_image 时都会优先使用这里配置的 provider / model。
            </p>
          </div>
        </header>
        <div className="panel-body">{renderSchemaSection(currentTab.section)}</div>
        {saveBarFor(currentTab.section)}
      </section>
    </>
  ) : null;

  const voiceContent = currentTab ? (
    <>
      {providerPanel}
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">当前配置档：{selected?.name ?? '—'}</h2>
            <p className="panel-desc">
              语音合成按配置档生效；供应商留空跟随全局默认
              {defaultProvider !== ''
                ? '（' + defaultProviderName + '）'
                : '（当前未设置，回退到第一个启用的供应商）'}。
            </p>
          </div>
          <div className="panel-tools">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate('/settings')}>调整全局默认</button>
          </div>
        </header>
        <div className="panel-body">
          <div className="form-stack">
            {providerList.length === 0 && !providers.loading && !providers.error ? (
              <div className="note note-pending compact">
                <span className="note-title">还没有 TTS 供应商</span>
                <span className="note-text">先在上方「TTS 供应商」里新增一个；否则语音合成不可用，供应商选择只能留空。</span>
              </div>
            ) : null}
            {renderSchemaSection('voice')}
          </div>
        </div>
        {saveBarFor('voice')}
      </section>
    </>
  ) : null;

  const genericContent = currentTab ? (
    <>
      <div className="hint-strip">
        <span className="hint-label">扩展</span>
        <span className="hint-text">{currentTab.slot?.desc || '该模型类型由 model-slots 注册，表单来自 settings schema。'}</span>
      </div>
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">{currentTab.label}</h2>
            <p className="panel-desc">
              这是 model-slots 注册的扩展类型，表单来自 settings schema 的「{currentTab.section}」分节；新增类型无需改前端。
            </p>
          </div>
        </header>
        <div className="panel-body">{renderSchemaSection(currentTab.section)}</div>
        {saveBarFor(currentTab.section)}
      </section>
    </>
  ) : null;

  const moreContent = (
    <>
      <div className="hint-strip">
        <span className="hint-label">扩展点</span>
        <span className="hint-text">
          模型类型由 core/model-slots.js 的插槽注册表声明：ready 类型自动出现 tab，planned 类型只展示规划；新增类型不需要改前端页面。
        </span>
        <span className="muted mono">ready {readySlots.length} · planned {plannedSlots.length}</span>
      </div>
      {plannedSlots.length === 0 ? (
        <EmptyState
          title="暂无预留类型"
          description="所有已注册的模型类型都已接入；后续新增类型只要在 core/model-slots.js 注册即可出现在这里。"
          endpoint="GET /api/models/slots"
        />
      ) : (
        <div className="slot-grid">
          {plannedSlots.map((slot) => (
            <article className="slot-card" key={slot.id}>
              <div className="slot-card-head">
                <span className="slot-name">{slot.label}</span>
                <Badge tone="idle">预留</Badge>
              </div>
              <p className="slot-desc">{slot.desc || '尚未提供说明。'}</p>
              {slot.extend ? (
                <div className="slot-extend">
                  <span className="slot-extend-label">扩展点</span>
                  {slot.extend}
                </div>
              ) : null}
              <p className="slot-meta mono">slot id: {slot.id}</p>
            </article>
          ))}
        </div>
      )}
    </>
  );

  // ── 渲染 ────────────────────────────────────────────────
  const tabItems = modelTabs.map((item) => ({
    id: item.id,
    label: item.label,
    count: item.id === MORE_TAB ? plannedSlots.length : dirtyCountFor(item.section) || undefined,
  }));

  const slotsBody = slots.loading ? (
    <section className="panel"><div className="panel-pad"><span className="skeleton skeleton-block" /></div></section>
  ) : slots.error ? (
    <section className="panel"><div className="panel-pad"><ErrorNote error={slots.error} onRetry={slots.reload} /></div></section>
  ) : slotList.length === 0 ? (
    <section className="panel"><div className="panel-pad">
      <EmptyState
        tone="pending"
        title="模型类型插槽尚未装配"
        description="core/model-slots.js 的 slotsPayload() 会声明可用的模型类型；装配后本页自动出现对应 tab。"
        endpoint="GET /api/models/slots"
      />
    </div></section>
  ) : null;

  if (bots.length === 0) {
    return (
      <div className="page">
        <PageHeader title="模型" description="模型配置挂在机器人 → 配置档下；先创建机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState
            title="还没有机器人"
            description="模型配置按配置档生效；创建机器人后会自动生成一个默认配置档。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去创建机器人</button>}
          />
        </div></section>
      </div>
    );
  }

  if (!botId) {
    return (
      <div className="page">
        <PageHeader title="模型" description="先选择作用域机器人，再编辑它的模型配置。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState
            title="未选择机器人"
            description="顶栏的「机器人」选择器决定当前编辑哪个 bot 的配置。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去选择机器人</button>}
          />
        </div></section>
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className="page">
        <PageHeader title="模型" description="模型配置按配置档生效；当前机器人还没有配置档。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState
            title="当前机器人还没有配置档"
            description="配置档承载 model / vision / voice 等可变策略；先到配置档页创建一个。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/profiles')}>去配置档页</button>}
          />
        </div></section>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="模型"
        description="LLM / 视觉 / 语音的统一入口：TTS 供应商为全局配置，其余按配置档生效。"
        meta={(
          <span className="cell-inline">
            <Badge tone="info" mono>{botId}</Badge>
            {selected && activeProfile?.id === selected.id ? <Badge tone="ok">当前生效</Badge> : null}
            {totalDirtyCount > 0 ? <Badge tone="warn">{totalDirtyCount} 项未保存</Badge> : null}
          </span>
        )}
        actions={(
          <div className="models-profile">
            <label className="scope-select">
              <span className="scope-select-label">配置档</span>
              <select
                className="input select-compact"
                value={selectedId}
                disabled={saving}
                onChange={(event) => switchProfile(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}{profile.isDefault ? '（默认）' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      />

      {slotsBody ?? (
        <>
          <Tabs items={tabItems} value={currentTab?.id ?? ''} onChange={setTab} />
          {currentTab?.id === MORE_TAB ? moreContent
            : currentTab?.id === 'llm' ? llmContent
            : currentTab?.id === 'vision' ? visionContent
            : currentTab?.id === 'voice' ? voiceContent
            : genericContent}
          <p className="page-foot mono">
            数据来源 GET /api/models/slots · tab 由插槽注册表驱动（ready {readySlots.length} / planned {plannedSlots.length}）
          </p>
        </>
      )}

      <ConfirmDialog
        open={pendingSelectId !== null}
        title="切换配置档？"
        message={'当前配置档还有 ' + totalDirtyCount + ' 项未保存的修改，切换后将丢弃。'}
        confirmLabel="切换并丢弃"
        onConfirm={() => {
          if (pendingSelectId !== null) setSelectedId(pendingSelectId);
          setPendingSelectId(null);
        }}
        onCancel={() => setPendingSelectId(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除 TTS 供应商"
        message={<>确定删除供应商「<strong>{deleteTarget?.name}</strong>」？引用它的配置档选择会失效，需要重新选择。</>}
        confirmLabel="删除"
        busy={deletingProvider}
        onConfirm={() => void deleteProvider()}
        onCancel={() => { if (!deletingProvider) setDeleteTarget(null); }}
      />

      <Drawer
        open={drawer !== null}
        title={drawer?.mode === 'edit' ? '编辑 TTS 供应商' : '新增 TTS 供应商'}
        subtitle={draft ? draft.kind + ' · ' + (kindById.get(draft.kind)?.label ?? '') : undefined}
        width={560}
        onClose={() => { if (!savingProvider) setDrawer(null); }}
        footer={(
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setDrawer(null)} disabled={savingProvider}>取消</button>
            <button type="button" className="btn btn-primary" onClick={() => void saveProvider()} disabled={savingProvider}>
              {savingProvider ? '保存中…' : '保存供应商'}
            </button>
          </>
        )}
      >
        {draft ? (
          <div className="form-stack">
            {draftError ? (
              <div className="note note-error compact" role="alert">
                <span className="note-title">{draftError}</span>
              </div>
            ) : null}
            <Field label="供应商名称" htmlFor="tts-provider-name" required>
              <input
                id="tts-provider-name"
                className="input"
                maxLength={80}
                value={draft.name}
                onChange={(event) => setDraft((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
              />
            </Field>
            <Field
              label="供应商类型"
              htmlFor="tts-provider-kind"
              help={kindById.get(draft.kind)?.desc}
            >
              <select
                id="tts-provider-kind"
                className="input"
                value={draft.kind}
                disabled={drawer?.mode === 'edit'}
                onChange={(event) => changeDraftKind(event.target.value)}
              >
                {(kinds.data ?? []).map((kind) => (
                  <option key={kind.id} value={kind.id}>{kind.label}</option>
                ))}
              </select>
            </Field>
            <Field label="启用" help="停用后不会参与默认回退，配置档显式选择也会失败。">
              <button
                type="button"
                role="switch"
                aria-checked={draft.enabled}
                className={'switch' + (draft.enabled ? ' on' : '')}
                onClick={() => setDraft((prev) => (prev ? { ...prev, enabled: !prev.enabled } : prev))}
              >
                <span className="switch-thumb" aria-hidden="true" />
                <span className="switch-text">{draft.enabled ? '启用' : '停用'}</span>
              </button>
            </Field>

            {(() => {
              const kind = kindById.get(draft.kind);
              if (!kind) return null;
              return kind.fields.map((field) => (
                <Field
                  key={field.key}
                  label={field.label}
                  htmlFor={'tts-field-' + field.key}
                  required={field.required}
                  help={field.help}
                  wide={field.type === 'textarea' || field.type === 'json'}
                >
                  {renderKindField(kind, field)}
                </Field>
              ));
            })()}

            {(() => {
              const kind = kindById.get(draft.kind);
              if (!kind || (!kind.needsSecret && kind.secretLabel === '')) return null;
              const editing = drawer?.mode === 'edit';
              const hasSecret = drawer?.provider?.hasSecret ?? false;
              const placeholder = editing && hasSecret
                ? '已配置密钥，留空保留原值'
                : kind.secretPlaceholder || '填写 API Key';
              const help = [
                kind.secretHelp || '',
                editing ? '编辑时留空表示保留已保存的密钥。' : '密钥只写不读，保存后不会回显。',
              ].filter(Boolean).join(' ');
              return (
                <Field label={kind.secretLabel || 'API Key'} htmlFor="tts-provider-secret" required={kind.needsSecret && !editing} help={help}>
                  <input
                    id="tts-provider-secret"
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    placeholder={placeholder}
                    value={draft.secret}
                    onChange={(event) => setDraft((prev) => (prev ? { ...prev, secret: event.target.value } : prev))}
                  />
                </Field>
              );
            })()}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
