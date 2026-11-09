/**
 * pages/BotsPage —— 机器人管理：列表、新建/编辑抽屉、启停与删除。
 *
 * Bot 是 QQ 应用本体 + 独立工作目录；创建时服务端会同时建默认配置档。
 * 注意 appSecret 只写不读：列表只返回 hasSecret，编辑时留空表示不修改。
 */
import { useMemo, useState } from 'react';

import { api, toApiError } from '../api/client';
import type { Bot } from '../api/types';
import { CopyButton } from '../components/CopyButton';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { Field } from '../components/Field';
import { PageHeader } from '../components/PageHeader';
import { Badge, StatusDot, runtimeTone } from '../components/Status';
import { fmtTimeSmart } from '../lib/format';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';

interface BotForm {
  name: string;
  appId: string;
  appSecret: string;
  cwd: string;
  enabled: boolean;
}

const EMPTY_FORM: BotForm = { name: '', appId: '', appSecret: '', cwd: '', enabled: true };

const RUNNING_STATUS = new Set(['online', 'running', 'ready', 'connected', 'starting']);

export function BotsPage() {
  const { state, stateError, loadingState, reloadState, botId, setBotId, notify } = useApp();
  const [filter, setFilter] = useState('');
  const [drawer, setDrawer] = useState<{ mode: 'create' | 'edit'; bot: Bot | null } | null>(null);
  const [form, setForm] = useState<BotForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const bots = state?.bots ?? [];
  const runtime = state?.runtime;

  const rows = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (keyword === '') return bots;
    return bots.filter((bot) =>
      [bot.name, bot.id, bot.appId, bot.cwd || ''].some((field) => field.toLowerCase().includes(keyword)),
    );
  }, [bots, filter]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDrawer({ mode: 'create', bot: null });
  };

  const openEdit = (bot: Bot) => {
    setForm({
      name: bot.name,
      appId: bot.appId,
      appSecret: '',
      cwd: bot.cwd || '',
      enabled: bot.enabled,
    });
    setFormError(null);
    setDrawer({ mode: 'edit', bot });
  };

  const save = async () => {
    const name = form.name.trim();
    if (name === '') {
      setFormError('机器人名称不能为空。');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (drawer?.mode === 'edit' && drawer.bot) {
        await api.updateBot(drawer.bot.id, {
          name,
          appId: form.appId.trim(),
          cwd: form.cwd.trim(),
          enabled: form.enabled,
          ...(form.appSecret.trim() !== '' ? { appSecret: form.appSecret.trim() } : {}),
        });
        notify('ok', '已保存机器人：' + name);
      } else {
        await api.createBot({
          name,
          appId: form.appId.trim(),
          cwd: form.cwd.trim() || undefined,
          enabled: form.enabled,
          ...(form.appSecret.trim() !== '' ? { appSecret: form.appSecret.trim() } : {}),
        });
        notify('ok', '已创建机器人：' + name);
      }
      setDrawer(null);
      await reloadState();
    } catch (err) {
      setFormError(toApiError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteBot(deleteTarget.id);
      notify('ok', '已删除机器人：' + deleteTarget.name);
      if (botId === deleteTarget.id) {
        const next = bots.find((bot) => bot.id !== deleteTarget.id)?.id ?? '';
        setBotId(next);
      }
      setDeleteTarget(null);
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '删除失败：' + error.message, error.code);
    } finally {
      setDeleting(false);
    }
  };

  const runAction = async (bot: Bot, name: 'start' | 'stop') => {
    const key = bot.id + ':' + name;
    setBusyKey(key);
    try {
      await api.action(name, { botId: bot.id });
      notify('ok', '已请求' + (name === 'start' ? '启动' : '停止') + '：' + bot.name);
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      if (error.unimplemented) {
        notify('info', '机器人启停能力将在宿主适配（M2）后接入', 'POST /api/actions/' + name);
      } else {
        notify('error', '操作失败：' + error.message, error.code);
      }
    } finally {
      setBusyKey(null);
    }
  };

  const columns: Array<Column<Bot>> = [
    {
      key: 'name',
      title: '机器人',
      render: (bot) => (
        <div className="cell-stack">
          <span className="cell-title">{bot.name}</span>
          <CopyButton text={bot.id} label="复制 ID" />
        </div>
      ),
    },
    {
      key: 'appId',
      title: 'QQ 应用',
      width: '196px',
      render: (bot) => (
        <div className="cell-stack">
          <span className="mono">{bot.appId || '未填写'}</span>
          <span className="cell-sub">
            {bot.hasSecret ? <Badge tone="ok">Secret 已配置</Badge> : <Badge tone="warn">缺 Secret</Badge>}
          </span>
        </div>
      ),
    },
    {
      key: 'cwd',
      title: '工作目录',
      render: (bot) => <span className="mono cell-sub ellipsis" title={bot.cwd || ''}>{bot.cwd || '（默认 workspace/bots/…）'}</span>,
    },
    {
      key: 'status',
      title: '状态',
      width: '124px',
      render: (bot) => {
        const info = runtimeTone(runtime?.bots[bot.id]?.status);
        return (
          <div className="cell-stack">
            <span className="cell-inline"><StatusDot tone={info.tone} pulse={info.tone === 'ok'} />{info.label}</span>
            <span className="cell-sub">{bot.enabled ? '允许启动' : '已停用'}</span>
          </div>
        );
      },
    },
    {
      key: 'updatedAt',
      title: '更新时间',
      width: '136px',
      render: (bot) => <span className="mono cell-sub">{fmtTimeSmart(bot.updatedAt)}</span>,
    },
    {
      key: 'actions',
      title: '',
      width: '248px',
      align: 'right',
      render: (bot) => {
        const running = RUNNING_STATUS.has((runtime?.bots[bot.id]?.status || '').toLowerCase());
        const busy = busyKey?.startsWith(bot.id + ':') ?? false;
        return (
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => void runAction(bot, running ? 'stop' : 'start')}
            >
              {busy ? '…' : running ? '停止' : '启动'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => openEdit(bot)}>编辑</button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => { setBotId(bot.id); navigate('/profiles'); }}
            >
              配置档
            </button>
            <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setDeleteTarget(bot)}>删除</button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="机器人"
        description="每个机器人是一个 QQ 应用 + 独立工作目录 + 独立数据（记忆/知识库/群友库/表情包）。"
        actions={<button type="button" className="btn btn-primary" onClick={openCreate}>新建机器人</button>}
      />

      <div className="hint-strip">
        <span className="hint-label">Bot → Profile → Binding</span>
        <span className="hint-text">配置档只切换人设/模型/回复策略；记忆与知识库按 bot 共享，切配置档不会串数据。</span>
        <button type="button" className="link-btn" onClick={() => navigate('/profiles')}>查看配置档与绑定</button>
      </div>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">全部机器人</h2>
            <p className="panel-desc">共 {bots.length} 个；启停优先走 PATCH enabled，运行时动作走 /api/actions。</p>
          </div>
          <div className="panel-tools">
            <label className="toolbar-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                className="input search-input"
                data-search-input
                placeholder="按名称 / ID / AppID / 目录过滤"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
          </div>
        </header>
        <div className="panel-body flush">
          {stateError && !state ? (
            <div className="panel-pad"><ErrorNote error={stateError} onRetry={() => void reloadState()} /></div>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(bot) => bot.id}
              loading={!state && loadingState}
              empty={(
                <EmptyState
                  title={filter ? '没有匹配的机器人' : '还没有机器人'}
                  description={filter ? '换个关键词，或清空过滤条件。' : '创建后会自动生成默认配置档，并分配 workspace/bots/<id> 工作目录。'}
                  action={filter
                    ? <button type="button" className="btn btn-sm" onClick={() => setFilter('')}>清空过滤</button>
                    : <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>新建机器人</button>}
                />
              )}
            />
          )}
        </div>
      </section>

      <Drawer
        open={drawer !== null}
        title={drawer?.mode === 'edit' ? '编辑机器人' : '新建机器人'}
        subtitle={drawer?.mode === 'edit' ? drawer.bot?.id : '创建后自动生成默认配置档与工作目录'}
        onClose={() => { if (!saving) setDrawer(null); }}
        footer={(
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setDrawer(null)} disabled={saving}>取消</button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        )}
      >
        <div className="form-stack">
          <Field label="机器人名称" htmlFor="bot-name" required>
            <input
              id="bot-name"
              className="input"
              value={form.name}
              placeholder="例如：主号 / 测试群机器人"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>

          <div className="form-row">
            <Field label="QQ AppID" htmlFor="bot-appid" help="QQ 开放平台的 AppID，可在机器人设置中修改。">
              <input
                id="bot-appid"
                className="input mono"
                value={form.appId}
                placeholder="102xxxxxx"
                onChange={(event) => setForm({ ...form, appId: event.target.value })}
              />
            </Field>
            <Field
              label="AppSecret"
              htmlFor="bot-secret"
              help={drawer?.mode === 'edit' ? '留空表示不修改已保存的 secret。' : '仅写入，不会回显。'}
            >
              <input
                id="bot-secret"
                className="input mono"
                type="password"
                value={form.appSecret}
                placeholder={drawer?.mode === 'edit' ? '••••••••（留空不改）' : '粘贴 AppSecret'}
                onChange={(event) => setForm({ ...form, appSecret: event.target.value })}
              />
            </Field>
          </div>

          <Field
            label="工作目录"
            htmlFor="bot-cwd"
            help="留空使用 <DSH workspace>/bots/<botId>。workspace 外路径需要 danger-full-access，普通模式会被沙箱拒绝。"
          >
            <input
              id="bot-cwd"
              className="input mono"
              value={form.cwd}
              placeholder="（留空自动分配）"
              onChange={(event) => setForm({ ...form, cwd: event.target.value })}
            />
          </Field>

          <Field label="启用" help="停用的机器人不会被启动，但配置与数据保留。">
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              className={'switch' + (form.enabled ? ' on' : '')}
              onClick={() => setForm({ ...form, enabled: !form.enabled })}
            >
              <span className="switch-thumb" aria-hidden="true" />
              <span className="switch-text">{form.enabled ? '已启用' : '已停用'}</span>
            </button>
          </Field>

          {formError ? <p className="field-error" role="alert">{formError}</p> : null}
        </div>
      </Drawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除机器人"
        message={(
          <span>
            将删除 <strong>{deleteTarget?.name}</strong> 及其配置档、绑定、记忆、知识库等全部数据。
            工作目录中的文件不会被删除。此操作不可撤销。
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
