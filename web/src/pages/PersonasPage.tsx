/**
 * pages/PersonasPage —— 人格卡：可复用的人设文本，同 bot 任意时刻只有一张生效。
 *
 * 数据源：GET/POST /api/personas、PATCH/DELETE /api/personas/:id?bot=、
 * POST /api/personas/:id/activate。激活事务内互斥并原子写 <bot cwd>/persona.md；
 * Profile 的 persona.activeCardId 决定哪张卡进入提示段，留空回退 persona.md。
 */
import { useMemo, useState } from 'react';

import { api, toApiError } from '../api/client';
import type { Persona } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyButton } from '../components/CopyButton';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { Field } from '../components/Field';
import { PageHeader } from '../components/PageHeader';
import { Badge } from '../components/Status';
import { fmtTimeSmart, truncate } from '../lib/format';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';
import { useApi } from '../state/useApi';

const CONTENT_PLACEHOLDER = '你是群里的「小助手」，语气轻松、回答简短。\n遇到不确定的问题先查知识库，不要编造。';

export function PersonasPage() {
  const { botId, bots, bot, notify } = useApp();
  const personas = useApi((signal) => (botId ? api.listPersonas(botId, signal) : Promise.resolve([])), [botId]);
  const [filter, setFilter] = useState('');
  const [drawer, setDrawer] = useState<{ mode: 'create' | 'edit'; persona: Persona | null } | null>(null);
  const [form, setForm] = useState({ name: '', content: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Persona | null>(null);
  const [deleting, setDeleting] = useState(false);

  const rows = useMemo(() => {
    const items = personas.data ?? [];
    const keyword = filter.trim().toLowerCase();
    if (keyword === '') return items;
    return items.filter((persona) =>
      [persona.name, persona.content].some((field) => field.toLowerCase().includes(keyword)),
    );
  }, [personas.data, filter]);

  const openCreate = () => {
    setForm({ name: '', content: '' });
    setFormError(null);
    setDrawer({ mode: 'create', persona: null });
  };

  const openEdit = (persona: Persona) => {
    setForm({ name: persona.name, content: persona.content });
    setFormError(null);
    setDrawer({ mode: 'edit', persona });
  };

  const save = async () => {
    const name = form.name.trim();
    if (name === '') {
      setFormError('人格卡名称不能为空。');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (drawer?.mode === 'edit' && drawer.persona) {
        await api.updatePersona(drawer.persona.id, botId, { name, content: form.content });
        notify('ok', '已保存人格卡：' + name + (drawer.persona.active ? '（生效卡已同步 persona.md）' : ''));
      } else {
        await api.createPersona({ botId, name, content: form.content });
        notify('ok', '已创建人格卡：' + name);
      }
      setDrawer(null);
      personas.reload();
    } catch (err) {
      setFormError(toApiError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const activate = async (persona: Persona) => {
    setActivatingId(persona.id);
    try {
      await api.activatePersona(persona.id, botId);
      notify('ok', '已设为人格卡生效：' + persona.name);
      personas.reload();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '激活失败：' + error.message, error.code);
    } finally {
      setActivatingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deletePersona(deleteTarget.id, botId);
      notify('ok', '已删除人格卡：' + deleteTarget.name);
      setDeleteTarget(null);
      personas.reload();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '删除失败：' + error.message, error.code);
    } finally {
      setDeleting(false);
    }
  };

  const columns: Array<Column<Persona>> = [
    {
      key: 'name',
      title: '人格卡',
      width: '220px',
      render: (persona) => (
        <div className="cell-stack">
          <span className="cell-title">
            {persona.name}
            {persona.active ? <Badge tone="ok">生效中</Badge> : null}
          </span>
          <CopyButton text={persona.id} label="复制 ID" />
        </div>
      ),
    },
    {
      key: 'content',
      title: '人设内容',
      render: (persona) => (
        <span className={'persona-preview' + (persona.content ? '' : ' muted')} title={persona.content}>
          {persona.content ? truncate(persona.content.replace(/\s+/g, ' '), 140) : '（空白，可稍后编辑）'}
        </span>
      ),
    },
    {
      key: 'updatedAt',
      title: '更新时间',
      width: '136px',
      render: (persona) => <span className="mono cell-sub">{fmtTimeSmart(persona.updatedAt)}</span>,
    },
    {
      key: 'actions',
      title: '',
      width: '200px',
      align: 'right',
      render: (persona) => (
        <div className="row-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={persona.active || activatingId === persona.id}
            onClick={() => void activate(persona)}
          >
            {activatingId === persona.id ? '激活中…' : persona.active ? '已生效' : '设为生效'}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openEdit(persona)}>编辑</button>
          <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setDeleteTarget(persona)}>删除</button>
        </div>
      ),
    },
  ];

  if (bots.length === 0) {
    return (
      <div className="page">
        <PageHeader title="人格卡" description="人格卡按机器人共享；先创建机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState
            title="还没有机器人"
            description="人格卡挂在 bot 下，可被该 bot 的多份配置档引用。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去创建机器人</button>}
          />
        </div></section>
      </div>
    );
  }

  if (!botId) {
    return (
      <div className="page">
        <PageHeader title="人格卡" description="先选择作用域机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState title="未选择机器人" description="顶栏选择机器人后即可管理该 bot 的人格卡。" />
        </div></section>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="人格卡"
        description={'当前机器人：' + (bot?.name || botId) + '。激活一张卡会原子写入 bot 工作目录的 persona.md；同 bot 只有一张生效。'}
        actions={<button type="button" className="btn btn-primary" onClick={openCreate}>新建人格卡</button>}
      />

      <div className="hint-strip">
        <span className="hint-label">生效链路</span>
        <span className="hint-text">
          Profile 设置项 persona.activeCardId → 命中的人格卡内容进入提示段；留空则读取 bot 目录下的 persona.md。
        </span>
        <button type="button" className="link-btn" onClick={() => navigate('/settings')}>去设置</button>
      </div>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">全部人格卡</h2>
            <p className="panel-desc">共 {personas.data?.length ?? 0} 张；生效卡排在首位。</p>
          </div>
          <div className="panel-tools">
            <label className="toolbar-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                className="input search-input"
                data-search-input
                placeholder="按名称 / 内容过滤"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <button type="button" className="btn btn-sm btn-ghost" onClick={personas.reload}>刷新</button>
          </div>
        </header>
        <div className="panel-body flush">
          {personas.error && !personas.error.unimplemented && !personas.data ? (
            <div className="panel-pad"><ErrorNote error={personas.error} onRetry={personas.reload} /></div>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(persona) => persona.id}
              loading={personas.loading}
              empty={(
                <EmptyState
                  title={filter ? '没有匹配的人格卡' : '还没有人格卡'}
                  description={filter ? '换个关键词试试。' : '人格卡只存人设文本；模型、回复策略等放在配置档里。'}
                  action={filter
                    ? <button type="button" className="btn btn-sm" onClick={() => setFilter('')}>清空过滤</button>
                    : <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>新建人格卡</button>}
                />
              )}
            />
          )}
        </div>
      </section>

      <Drawer
        open={drawer !== null}
        title={drawer?.mode === 'edit' ? '编辑人格卡' : '新建人格卡'}
        subtitle={drawer?.mode === 'edit' && drawer.persona?.active ? '该卡生效中：保存内容会同步 persona.md' : '人设文本只影响提示段，不改数据与工具策略'}
        onClose={() => { if (!saving) setDrawer(null); }}
        footer={(
          <>
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => setDrawer(null)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        )}
      >
        <div className="form-stack">
          <Field label="名称" htmlFor="persona-name" required help="例如：默认人设 / 深夜模式 / 客服口径。">
            <input
              id="persona-name"
              className="input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="人设内容" htmlFor="persona-content" wide help="Markdown 纯文本；会作为 persona 段注入提示词。">
            <textarea
              id="persona-content"
              className="input textarea persona-editor"
              rows={12}
              value={form.content}
              placeholder={CONTENT_PLACEHOLDER}
              onChange={(event) => setForm({ ...form, content: event.target.value })}
            />
          </Field>
          {formError ? <p className="field-error" role="alert">{formError}</p> : null}
        </div>
      </Drawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除人格卡"
        message={(
          <span>
            删除 <strong>{deleteTarget?.name}</strong>？
            {deleteTarget?.active ? '它是当前生效卡：删除后 persona.activeCardId 指向的卡将不存在，需要重新选择。' : '该操作不可撤销。'}
            {' '}persona.md 文件不会被删除。
          </span>
        )}
        confirmLabel="删除"
        busy={deleting}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
