/**
 * pages/ProfilesPage —— 配置档 + 作用域绑定。
 *
 * 配置档编辑器完全由 GET /api/schema 的 profile 级设置项驱动（SchemaForm），
 * 保存时只提交本次修改的差异路径；schema 未装配时退回原始 JSON 编辑。
 * 绑定页维护 scope → profile 的路由（精确 > 类型通配 > bot 通配 > 默认）。
 */
import { useEffect, useMemo, useState } from 'react';

import { api, toApiError } from '../api/client';
import type { Binding, Profile, SchemaSection } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyButton } from '../components/CopyButton';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { Field } from '../components/Field';
import { PageHeader } from '../components/PageHeader';
import { PromptPreview } from '../components/PromptPreview';
import { SchemaForm } from '../components/SchemaForm';
import { Badge } from '../components/Status';
import { Tabs } from '../components/Tabs';
import { fmtTimeSmart, prettyJson } from '../lib/format';
import { pathsToPatch } from '../lib/objects';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';
import { useApi } from '../state/useApi';

type TabId = 'profiles' | 'bindings';

const SCOPE_PRESETS = ['qq:group:123456', 'qq:group:*', 'qq:c2c:*', '*'];

export function ProfilesPage() {
  const {
    botId, bots, profiles, activeProfile, state, reloadState, notify,
  } = useApp();
  const [tab, setTab] = useState<TabId>('profiles');
  const schema = useApi((signal) => api.schema(signal), []);
  const schemaReady = (schema.data?.items.length ?? 0) > 0;

  // ── 配置档 ────────────────────────────────────────────────
  const [selectedId, setSelectedId] = useState('');
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [dirty, setDirty] = useState<Record<string, unknown>>({});
  const [rawText, setRawText] = useState('{}');
  const [rawError, setRawError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 编辑区子 tab：schema section id / '__raw__' / 'preview'。 */
  const [editorTab, setEditorTab] = useState<string>('');

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;
  const dirtyCount = Object.keys(dirty).length;
  const hasChanges = Boolean(selected) && (
    dirtyCount > 0
    || name.trim() !== selected?.name
    || isDefault !== selected?.isDefault
    || (!schemaReady && rawText !== prettyJson(selected?.data ?? {}))
  );

  /** 只保留包含 profile 级设置项的分区（按 schema order 排序）。 */
  const profileSections = useMemo<SchemaSection[]>(() => {
    const payload = schema.data;
    if (!payload) return [];
    const seen = new Set<string>();
    const sections: SchemaSection[] = [];
    for (const item of payload.items) {
      if (item.scope !== 'profile') continue;
      const id = item.section || 'other';
      if (seen.has(id)) continue;
      seen.add(id);
      const definition = payload.sections.find((section) => section.id === id);
      sections.push({
        id,
        label: definition?.label || (id === 'other' ? '其他' : id),
        order: definition?.order ?? (id === 'other' ? 999 : 500),
        desc: definition?.desc,
      });
    }
    return sections.sort((a, b) => (a.order ?? 500) - (b.order ?? 500));
  }, [schema.data]);

  const activeSection = profileSections.find((section) => section.id === editorTab) ?? null;

  const dirtyBySection = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!schema.data) return counts;
    const sectionByKey = new Map(schema.data.items.map((item) => [item.key, item.section || 'other']));
    for (const key of Object.keys(dirty)) {
      const section = sectionByKey.get(key) || 'other';
      counts[section] = (counts[section] || 0) + 1;
    }
    return counts;
  }, [dirty, schema.data]);

  useEffect(() => {
    if (editorTab === 'preview') return;
    if (profileSections.some((section) => section.id === editorTab)) return;
    // schema 未就绪时停在原始 JSON；加载完成后自动切到第一个分区
    if (!schemaReady) {
      if (editorTab !== '__raw__') setEditorTab('__raw__');
      return;
    }
    setEditorTab(profileSections[0]?.id ?? '__raw__');
  }, [profileSections, editorTab, schemaReady]);

  useEffect(() => {
    if (profiles.length === 0) {
      if (selectedId !== '') setSelectedId('');
      return;
    }
    if (selectedId && profiles.some((profile) => profile.id === selectedId)) return;
    setSelectedId(activeProfile?.id ?? profiles[0].id);
  }, [profiles, selectedId, activeProfile]);

  useEffect(() => {
    if (!selected) {
      setDirty({});
      setName('');
      setIsDefault(false);
      setRawText('{}');
      setRawError(null);
      return;
    }
    setDirty({});
    setName(selected.name);
    setIsDefault(selected.isDefault);
    setRawText(prettyJson(selected.data));
    setRawError(null);
  }, [selected?.id, selected?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchProfile = (profileId: string) => {
    if (profileId === selectedId) return;
    if (hasChanges) {
      setPendingSelectId(profileId);
      return;
    }
    setSelectedId(profileId);
  };

  const saveProfile = async () => {
    if (!selected) return;
    const trimmedName = name.trim();
    if (trimmedName === '') {
      notify('error', '配置档名称不能为空');
      return;
    }
    const patch: { name?: string; data?: Record<string, unknown>; isDefault?: boolean } = {};
    if (trimmedName !== selected.name) patch.name = trimmedName;
    if (isDefault !== selected.isDefault) patch.isDefault = isDefault;

    if (schemaReady) {
      if (dirtyCount > 0) patch.data = pathsToPatch(dirty);
    } else {
      try {
        const parsed: unknown = rawText.trim() === '' ? {} : JSON.parse(rawText);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setRawError('配置档 data 必须是 JSON 对象。');
          return;
        }
        const nextData = parsed as Record<string, unknown>;
        if (prettyJson(nextData) !== prettyJson(selected.data)) patch.data = nextData;
        setRawError(null);
      } catch (err) {
        setRawError('JSON 不合法：' + (err instanceof Error ? err.message : String(err)));
        return;
      }
    }

    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    try {
      await api.updateProfile(selected.id, patch);
      setDirty({});
      notify('ok', '已保存配置档：' + trimmedName);
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '保存失败：' + error.message, error.code);
    } finally {
      setSaving(false);
    }
  };

  const confirmDeleteProfile = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteProfile(deleteTarget.id);
      notify('ok', '已删除配置档：' + deleteTarget.name);
      if (selectedId === deleteTarget.id) setSelectedId('');
      setDeleteTarget(null);
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '删除失败：' + error.message, error.code);
    } finally {
      setDeleting(false);
    }
  };

  const createProfile = async () => {
    const trimmed = newName.trim();
    if (trimmed === '') {
      setCreateError('请输入配置档名称。');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createProfile({ botId, name: trimmed });
      notify('ok', '已创建配置档：' + trimmed);
      setCreateOpen(false);
      setNewName('');
      await reloadState();
      setSelectedId(created.id);
    } catch (err) {
      setCreateError(toApiError(err).message);
    } finally {
      setCreating(false);
    }
  };

  // ── 绑定 ─────────────────────────────────────────────────
  const [bindingDrawer, setBindingDrawer] = useState<{ mode: 'create' | 'edit'; binding: Binding | null } | null>(null);
  const [bindingForm, setBindingForm] = useState({ scope: '', profileId: '', priority: 0 });
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [bindingSaving, setBindingSaving] = useState(false);
  const [bindingDelete, setBindingDelete] = useState<Binding | null>(null);
  const [bindingDeleting, setBindingDeleting] = useState(false);

  const bindings = useMemo(
    () => (state?.bindings ?? []).filter((binding) => binding.botId === botId),
    [state, botId],
  );

  const openBindingCreate = () => {
    setBindingForm({ scope: '', profileId: activeProfile?.id ?? profiles[0]?.id ?? '', priority: 0 });
    setBindingError(null);
    setBindingDrawer({ mode: 'create', binding: null });
  };

  const openBindingEdit = (binding: Binding) => {
    setBindingForm({ scope: binding.scope, profileId: binding.profileId, priority: binding.priority });
    setBindingError(null);
    setBindingDrawer({ mode: 'edit', binding });
  };

  const saveBinding = async () => {
    const scope = bindingForm.scope.trim();
    if (scope === '') {
      setBindingError('作用域不能为空，例如 qq:group:* 或 *。');
      return;
    }
    if (bindingForm.profileId === '') {
      setBindingError('请选择要绑定的配置档。');
      return;
    }
    setBindingSaving(true);
    setBindingError(null);
    try {
      if (bindingDrawer?.mode === 'edit' && bindingDrawer.binding) {
        await api.updateBinding(bindingDrawer.binding.id, {
          scope,
          profileId: bindingForm.profileId,
          priority: Number(bindingForm.priority) || 0,
        });
        notify('ok', '已更新绑定：' + scope);
      } else {
        await api.upsertBinding({
          botId,
          scope,
          profileId: bindingForm.profileId,
          priority: Number(bindingForm.priority) || 0,
        });
        notify('ok', '已新增绑定：' + scope);
      }
      setBindingDrawer(null);
      await reloadState();
    } catch (err) {
      setBindingError(toApiError(err).message);
    } finally {
      setBindingSaving(false);
    }
  };

  const confirmDeleteBinding = async () => {
    if (!bindingDelete) return;
    setBindingDeleting(true);
    try {
      await api.deleteBinding(bindingDelete.id);
      notify('ok', '已删除绑定：' + bindingDelete.scope);
      setBindingDelete(null);
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '删除绑定失败：' + error.message, error.code);
    } finally {
      setBindingDeleting(false);
    }
  };

  const bindingColumns: Array<Column<Binding>> = [
    {
      key: 'scope',
      title: '作用域',
      render: (binding) => <span className="mono scope-cell">{binding.scope}</span>,
    },
    {
      key: 'profile',
      title: '配置档',
      render: (binding) => (
        <span className="cell-inline">
          {binding.profileName || profiles.find((profile) => profile.id === binding.profileId)?.name || binding.profileId}
          {binding.profileId === activeProfile?.id ? <Badge tone="info">当前默认</Badge> : null}
        </span>
      ),
    },
    {
      key: 'priority',
      title: '优先级',
      width: '92px',
      align: 'right',
      render: (binding) => <span className="mono">{binding.priority}</span>,
    },
    {
      key: 'createdAt',
      title: '创建时间',
      width: '136px',
      render: (binding) => <span className="mono cell-sub">{fmtTimeSmart(binding.createdAt)}</span>,
    },
    {
      key: 'actions',
      title: '',
      width: '132px',
      align: 'right',
      render: (binding) => (
        <div className="row-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openBindingEdit(binding)}>编辑</button>
          <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setBindingDelete(binding)}>删除</button>
        </div>
      ),
    },
  ];

  if (bots.length === 0) {
    return (
      <div className="page">
        <PageHeader title="配置档与绑定" description="配置档需要挂在机器人下；先创建机器人。" />
        <section className="panel">
          <div className="panel-pad">
            <EmptyState
              title="还没有机器人"
              description="配置档属于某个机器人；创建机器人后会自动生成一个默认配置档。"
              action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去创建机器人</button>}
            />
          </div>
        </section>
      </div>
    );
  }

  if (!botId) {
    return (
      <div className="page">
        <PageHeader title="配置档与绑定" description="先选择作用域机器人，再编辑配置档与绑定。" />
        <section className="panel">
          <div className="panel-pad">
            <EmptyState
              title="未选择机器人"
              description="顶栏的“机器人”选择器决定当前编辑哪个 bot 的配置。"
              action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去选择机器人</button>}
            />
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="配置档与绑定"
        description="配置档只装可变策略（人设、模型、回复、工具）；作用域绑定决定哪个会话用哪份配置。"
        meta={(
          <span className="cell-inline">
            <Badge tone="info" mono>{botId}</Badge>
            <span className="muted">默认：{activeProfile?.name || '—'}</span>
          </span>
        )}
        actions={tab === 'profiles'
          ? <button type="button" className="btn btn-primary" onClick={() => setCreateOpen(true)}>新建配置档</button>
          : <button type="button" className="btn btn-primary" onClick={openBindingCreate}>新增绑定</button>}
      />

      <Tabs
        items={[
          { id: 'profiles', label: '配置档', count: profiles.length },
          { id: 'bindings', label: '作用域绑定', count: bindings.length },
        ]}
        value={tab}
        onChange={(id) => setTab(id as TabId)}
      />

      {tab === 'profiles' ? (
        <div className="master-detail">
          <aside className="master">
            <header className="master-head">
              <span className="master-title">配置档</span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCreateOpen(true)}>新建</button>
            </header>
            <ul className="master-list">
              {profiles.map((profile) => (
                <li key={profile.id}>
                  <button
                    type="button"
                    className={'master-item' + (profile.id === selectedId ? ' active' : '')}
                    onClick={() => switchProfile(profile.id)}
                  >
                    <span className="master-name">{profile.name}</span>
                    <span className="master-meta">
                      {profile.isDefault ? <Badge tone="ok">默认</Badge> : null}
                      <span className="mono">{fmtTimeSmart(profile.updatedAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
              {profiles.length === 0 ? <li className="master-empty">暂无配置档</li> : null}
            </ul>
            <p className="master-hint">
              绑定优先于默认：精确 scope &gt; 类型通配 &gt; bot 通配 &gt; 默认配置档。
            </p>
          </aside>

          {selected ? (
            <section className="panel editor">
              <header className="panel-head">
                <div>
                  <h2 className="panel-title">编辑配置档</h2>
                  <p className="panel-desc">
                    <CopyButton text={selected.id} label="复制 ID" />
                  </p>
                </div>
                <div className="panel-tools">
                  <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setDeleteTarget(selected)}>删除</button>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveProfile()} disabled={saving || !hasChanges}>
                    {saving ? '保存中…' : '保存'}
                  </button>
                </div>
              </header>

              <div className="panel-body">
                <div className="form-grid form-grid-2">
                  <Field label="配置档名称" htmlFor="profile-name" required>
                    <input
                      id="profile-name"
                      className="input"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                  <Field label="默认配置档" help="没有绑定匹配时，会话使用默认配置档；同一 bot 只有一个默认。">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={isDefault}
                      className={'switch' + (isDefault ? ' on' : '')}
                      onClick={() => setIsDefault((value) => !value)}
                    >
                      <span className="switch-thumb" aria-hidden="true" />
                      <span className="switch-text">{isDefault ? '默认' : '非默认'}</span>
                    </button>
                  </Field>
                </div>

                <div className="editor-divider" />

                {/* 分区子 tab（来自 /api/schema sections）+ 提示词预览 */}
                <div className="tabs editor-tabs" role="tablist" aria-label="配置档设置分区">
                  {schemaReady ? profileSections.map((section) => (
                    <button
                      key={section.id}
                      type="button"
                      role="tab"
                      aria-selected={editorTab === section.id}
                      className={'tab' + (editorTab === section.id ? ' active' : '')}
                      onClick={() => setEditorTab(section.id)}
                    >
                      {section.label}
                      {dirtyBySection[section.id] ? (
                        <span className="tab-count" title={dirtyBySection[section.id] + ' 项未保存'}>
                          {dirtyBySection[section.id]}
                        </span>
                      ) : null}
                    </button>
                  )) : (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={editorTab === '__raw__'}
                      className={'tab' + (editorTab === '__raw__' ? ' active' : '')}
                      onClick={() => setEditorTab('__raw__')}
                    >
                      原始 JSON
                    </button>
                  )}
                  <span className="editor-tabs-spacer" />
                  <button
                    type="button"
                    role="tab"
                    aria-selected={editorTab === 'preview'}
                    className={'tab preview-tab' + (editorTab === 'preview' ? ' active' : '')}
                    onClick={() => setEditorTab('preview')}
                  >
                    提示词预览
                  </button>
                </div>

                {editorTab === 'preview' ? (
                  <PromptPreview
                    botId={botId}
                    profileId={selected.id}
                    profileName={selected.name}
                    hasUnsavedChanges={hasChanges}
                    unsavedCount={dirtyCount}
                    refreshKey={selected.updatedAt}
                  />
                ) : (
                  <>
                    {activeSection?.desc ? <p className="editor-section-desc">{activeSection.desc}</p> : null}
                    {schema.loading ? (
                      <p className="muted">正在加载设置 schema…</p>
                    ) : schemaReady && schema.data ? (
                      <SchemaForm
                        payload={schema.data}
                        sectionId={editorTab}
                        values={selected.data}
                        dirty={dirty}
                        scopes={['profile']}
                        showScope={false}
                        onChange={(key, value) => setDirty((prev) => ({ ...prev, [key]: value }))}
                      />
                    ) : (
                      <div className="form-stack">
                        <ErrorNote
                          error={schema.error ?? toApiError(new Error('schema 为空'))}
                          onRetry={schema.reload}
                          compact
                        />
                        <Field
                          label="配置档 data（原始 JSON）"
                          htmlFor="profile-raw"
                          help="设置 schema 未装配时的兜底编辑；保存会整体覆盖 data。"
                          wide
                        >
                          <textarea
                            id="profile-raw"
                            className="input mono textarea json-area"
                            rows={12}
                            value={rawText}
                            spellCheck={false}
                            onChange={(event) => {
                              setRawText(event.target.value);
                              try {
                                JSON.parse(event.target.value || '{}');
                                setRawError(null);
                              } catch (err) {
                                setRawError('JSON 不合法：' + (err instanceof Error ? err.message : String(err)));
                              }
                            }}
                          />
                        </Field>
                        {rawError ? <p className="field-error">{rawError}</p> : null}
                      </div>
                    )}
                  </>
                )}
              </div>

              <footer className="panel-foot save-bar">
                <span className={'save-hint' + (hasChanges ? ' dirty' : '')}>
                  {hasChanges ? '有未保存的修改' : '所有修改已保存'}
                  {dirtyCount > 0 ? '（' + dirtyCount + ' 项设置）' : ''}
                </span>
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!hasChanges || saving}
                    onClick={() => {
                      setDirty({});
                      setName(selected.name);
                      setIsDefault(selected.isDefault);
                      setRawText(prettyJson(selected.data));
                    }}
                  >
                    放弃修改
                  </button>
                  <button type="button" className="btn btn-primary btn-sm" disabled={saving || !hasChanges} onClick={() => void saveProfile()}>
                    {saving ? '保存中…' : '保存修改'}
                  </button>
                </div>
              </footer>
            </section>
          ) : (
            <section className="panel">
              <div className="panel-pad">
                <EmptyState
                  title="还没有配置档"
                  description="创建一份配置档来保存人设、模型、回复与工具策略。"
                  action={<button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>新建配置档</button>}
                />
              </div>
            </section>
          )}
        </div>
      ) : (
        <section className="panel">
          <header className="panel-head">
            <div>
              <h2 className="panel-title">作用域绑定</h2>
              <p className="panel-desc">UMO 风格 scope：qq:group:123456 / qq:group:* / qq:c2c:* / *；数值 priority 大者优先。</p>
            </div>
          </header>
          <div className="panel-body flush">
            <DataTable
              columns={bindingColumns}
              rows={bindings}
              rowKey={(binding) => binding.id}
              empty={(
                <EmptyState
                  title="还没有绑定"
                  description="没有匹配绑定时，所有会话使用默认配置档。绑定可以按群、按会话类型或按 bot 全局覆盖。"
                  action={<button type="button" className="btn btn-primary btn-sm" onClick={openBindingCreate}>新增绑定</button>}
                />
              )}
            />
          </div>
        </section>
      )}

      {/* 新建配置档 */}
      <Drawer
        open={createOpen}
        title="新建配置档"
        subtitle="创建后从空白策略开始；默认配置档不会被自动替换。"
        onClose={() => { if (!creating) setCreateOpen(false); }}
        footer={(
          <>
            <button type="button" className="btn btn-ghost" disabled={creating} onClick={() => setCreateOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={creating} onClick={() => void createProfile()}>
              {creating ? '创建中…' : '创建'}
            </button>
          </>
        )}
      >
        <div className="form-stack">
          <Field label="配置档名称" htmlFor="new-profile-name" required help="例如：深夜模式 / 群聊正式版 / 客服口径。">
            <input
              id="new-profile-name"
              className="input"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </Field>
          {createError ? <p className="field-error" role="alert">{createError}</p> : null}
        </div>
      </Drawer>

      {/* 绑定新增/编辑 */}
      <Drawer
        open={bindingDrawer !== null}
        title={bindingDrawer?.mode === 'edit' ? '编辑绑定' : '新增绑定'}
        subtitle={bindingDrawer?.mode === 'edit' ? bindingDrawer.binding?.scope : '相同 scope 重复保存会覆盖原绑定'}
        onClose={() => { if (!bindingSaving) setBindingDrawer(null); }}
        footer={(
          <>
            <button type="button" className="btn btn-ghost" disabled={bindingSaving} onClick={() => setBindingDrawer(null)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={bindingSaving} onClick={() => void saveBinding()}>
              {bindingSaving ? '保存中…' : '保存绑定'}
            </button>
          </>
        )}
      >
        <div className="form-stack">
          <Field label="作用域 scope" htmlFor="binding-scope" required help="qq:group:群号 精确匹配；qq:group:* 匹配所有群；qq:c2c:* 匹配私聊；* 兜底。">
            <input
              id="binding-scope"
              className="input mono"
              value={bindingForm.scope}
              placeholder="qq:group:*"
              onChange={(event) => setBindingForm({ ...bindingForm, scope: event.target.value })}
            />
          </Field>
          <div className="preset-row">
            {SCOPE_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className="chip chip-button mono"
                onClick={() => setBindingForm({ ...bindingForm, scope: preset })}
              >
                {preset}
              </button>
            ))}
          </div>
          <Field label="绑定到配置档" htmlFor="binding-profile" required>
            <select
              id="binding-profile"
              className="input"
              value={bindingForm.profileId}
              onChange={(event) => setBindingForm({ ...bindingForm, profileId: event.target.value })}
            >
              <option value="">请选择配置档</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}{profile.isDefault ? '（默认）' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="优先级 priority" htmlFor="binding-priority" help="数值越大越优先；同精度 scope 之间用它决胜。">
            <input
              id="binding-priority"
              type="number"
              className="input mono"
              value={bindingForm.priority}
              onChange={(event) => setBindingForm({ ...bindingForm, priority: Number(event.target.value) || 0 })}
            />
          </Field>
          {bindingError ? <p className="field-error" role="alert">{bindingError}</p> : null}
        </div>
      </Drawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除配置档"
        message={<span>删除 <strong>{deleteTarget?.name}</strong>？引用它的绑定会一并删除；若它是当前默认配置档，需要另选默认。</span>}
        confirmLabel="删除"
        busy={deleting}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDeleteProfile()}
      />

      <ConfirmDialog
        open={pendingSelectId !== null}
        title="放弃未保存的修改？"
        message="切换配置档会丢失当前未保存的名称、默认状态或设置项修改。"
        confirmLabel="放弃并切换"
        tone="primary"
        onCancel={() => setPendingSelectId(null)}
        onConfirm={() => {
          if (pendingSelectId) setSelectedId(pendingSelectId);
          setPendingSelectId(null);
        }}
      />

      <ConfirmDialog
        open={bindingDelete !== null}
        title="删除绑定"
        message={<span>删除作用域 <code className="inline-code mono">{bindingDelete?.scope}</code> 的绑定？删除后该会话回落到默认配置档。</span>}
        confirmLabel="删除"
        busy={bindingDeleting}
        onCancel={() => { if (!bindingDeleting) setBindingDelete(null); }}
        onConfirm={() => void confirmDeleteBinding()}
      />
    </div>
  );
}
