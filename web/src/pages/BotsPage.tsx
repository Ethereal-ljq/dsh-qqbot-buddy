/**
 * pages/BotsPage —— 机器人管理：列表、新建/编辑抽屉、启停/重启、详情与会话重置。
 *
 * 动作接口（M1b，deps.actions.run）：
 *  - POST /api/actions/start-bot | stop-bot | restart-bot  body {botId}
 *  - POST /api/actions/reset-peer  body {botId, peer}（轮换会话 epoch，下次消息建新会话）
 * start 失败时宿主只返回 {ok:false}，真实原因在 bot/status 事件的 error 里（AppContext.botErrors）。
 * 注意 appSecret 只写不读：列表只返回 hasSecret，编辑时留空表示不修改。
 */
import { useMemo, useState } from 'react';

import { ApiError, api, toApiError } from '../api/client';
import type { Bot } from '../api/types';
import { ActionError } from '../components/ActionError';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyButton } from '../components/CopyButton';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { Field } from '../components/Field';
import { PageHeader } from '../components/PageHeader';
import { Badge, StatusDot, runtimeTone } from '../components/Status';
import { actionFeedback, summarizeActionResult } from '../lib/actions';
import { fmtTimeSmart, truncate } from '../lib/format';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';

type BotAction = 'start' | 'stop' | 'restart';

const ACTION_NAME: Record<BotAction, string> = { start: 'start-bot', stop: 'stop-bot', restart: 'restart-bot' };
const ACTION_VERB: Record<BotAction, string> = { start: '启动', stop: '停止', restart: '重启' };
const RUNNING_STATUS = new Set(['online', 'running', 'ready', 'connected', 'starting']);

interface BotForm {
  name: string;
  appId: string;
  appSecret: string;
  cwd: string;
  enabled: boolean;
}

const EMPTY_FORM: BotForm = { name: '', appId: '', appSecret: '', cwd: '', enabled: true };

function isRunning(status?: string): boolean {
  return RUNNING_STATUS.has((status || '').toLowerCase());
}

export function BotsPage() {
  const {
    state, stateError, loadingState, reloadState, botId, setBotId, notify, botErrors, getBotError,
  } = useApp();
  const [filter, setFilter] = useState('');
  const [drawer, setDrawer] = useState<{ mode: 'create' | 'edit'; bot: Bot | null } | null>(null);
  const [form, setForm] = useState<BotForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  // 详情 / 会话操作
  const [detailBot, setDetailBot] = useState<Bot | null>(null);
  const [peer, setPeer] = useState('');
  const [detailBusy, setDetailBusy] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<ApiError | null>(null);
  const [detailNotice, setDetailNotice] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<string | null>(null);

  const bots = state?.bots ?? [];
  const runtime = state?.runtime;

  const rows = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (keyword === '') return bots;
    return bots.filter((bot) =>
      [bot.name, bot.id, bot.appId, bot.cwd || ''].some((field) => field.toLowerCase().includes(keyword)),
    );
  }, [bots, filter]);

  const detail = detailBot ? bots.find((bot) => bot.id === detailBot.id) ?? detailBot : null;
  const detailRunning = isRunning(detail ? runtime?.bots[detail.id]?.status : undefined);

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

  const openDetail = (bot: Bot) => {
    setDetailBot(bot);
    setPeer('');
    setDetailError(null);
    setDetailNotice(null);
    setResetResult(null);
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
      if (detailBot?.id === deleteTarget.id) setDetailBot(null);
      setDeleteTarget(null);
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '删除失败：' + error.message, error.code);
    } finally {
      setDeleting(false);
    }
  };

  /** 执行启停/重启；ok:false 时从 SSE bot/status 的 error 取真实原因。 */
  const runBotAction = async (bot: Bot, action: BotAction, options: { detail?: boolean } = {}) => {
    const inDetail = options.detail === true;
    if (inDetail) setDetailBusy(action);
    else setRowBusy(bot.id + ':' + action);
    if (inDetail) {
      setDetailError(null);
      setDetailNotice(null);
    }
    try {
      const result = await api.action(ACTION_NAME[action], { botId: bot.id });
      const ok = result?.ok !== false;
      await reloadState();
      if (ok) {
        const summary = summarizeActionResult(result);
        if (inDetail) setDetailNotice(ACTION_VERB[action] + '已提交' + (summary && summary !== 'ok=true' ? ' · ' + summary : ''));
        notify('ok', ACTION_VERB[action] + '已提交：' + bot.name, summary !== 'ok=true' ? summary : undefined);
      } else {
        // 宿主启动失败会先返回 {ok:false}，可读原因随 bot/status 事件到达
        await new Promise((resolve) => { window.setTimeout(resolve, 400); });
        const sseError = getBotError(bot.id);
        const hint = sseError
          || '机器人状态置为 error，常见原因：未配置 QQ 凭据（appId/appSecret）、网络不可达；详见事件流或插件日志。';
        if (inDetail) setDetailNotice(ACTION_VERB[action] + '未成功：' + hint);
        notify('error', ACTION_VERB[action] + '未成功：' + bot.name, hint);
      }
    } catch (err) {
      const error = toApiError(err);
      const feedback = actionFeedback(error);
      if (inDetail) setDetailError(error);
      if (error.unimplemented) {
        notify('info', '动作接口尚未装配（deps.actions 未注入）', 'POST /api/actions/' + ACTION_NAME[action]);
      } else {
        notify('error', ACTION_VERB[action] + '失败：' + feedback.message, feedback.detail);
      }
    } finally {
      if (inDetail) setDetailBusy(null);
      else setRowBusy(null);
    }
  };

  const resetPeer = async () => {
    if (!detail) return;
    const value = peer.trim();
    if (value === '') {
      setDetailError(new ApiError('请先填写要重置的会话 peer', { status: 0, code: 'invalid_peer', url: '' }));
      return;
    }
    setDetailBusy('reset-peer');
    setDetailError(null);
    setDetailNotice(null);
    setResetResult(null);
    try {
      const result = await api.action('reset-peer', { botId: detail.id, peer: value });
      setResetResult(summarizeActionResult(result));
      notify('ok', '会话已重置：' + value, summarizeActionResult(result));
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      setDetailError(error);
      const feedback = actionFeedback(error);
      notify(error.unimplemented ? 'info' : 'error', '重置会话失败：' + feedback.message, feedback.detail);
    } finally {
      setDetailBusy(null);
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
      width: '190px',
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
      width: '190px',
      render: (bot) => {
        const info = runtimeTone(runtime?.bots[bot.id]?.status);
        const lastError = botErrors[bot.id];
        return (
          <div className="cell-stack">
            <span className="cell-inline"><StatusDot tone={info.tone} pulse={info.tone === 'ok'} />{info.label}</span>
            {lastError ? (
              <span className="cell-error" title={lastError}>{truncate(lastError, 42)}</span>
            ) : (
              <span className="cell-sub">{bot.enabled ? '允许启动' : '已停用'}</span>
            )}
          </div>
        );
      },
    },
    {
      key: 'updatedAt',
      title: '更新时间',
      width: '130px',
      render: (bot) => <span className="mono cell-sub">{fmtTimeSmart(bot.updatedAt)}</span>,
    },
    {
      key: 'actions',
      title: '',
      width: '300px',
      align: 'right',
      render: (bot) => {
        const running = isRunning(runtime?.bots[bot.id]?.status);
        const busy = rowBusy?.startsWith(bot.id + ':') ?? false;
        return (
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => void runBotAction(bot, running ? 'stop' : 'start')}
            >
              {busy ? '处理中…' : running ? '停止' : '启动'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void runBotAction(bot, 'restart')}>
              重启
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => openDetail(bot)}>详情</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => openEdit(bot)}>编辑</button>
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
        description="每个机器人是一个 QQ 应用 + 独立工作目录 + 独立数据。启停/重启与重置会话走 /api/actions，状态由 SSE 实时刷新。"
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

      {/* 新建 / 编辑 */}
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

      {/* 详情 / 会话操作 */}
      <Drawer
        open={detail !== null}
        title={'机器人 · ' + (detail?.name || '')}
        subtitle={detail?.id}
        width={520}
        onClose={() => setDetailBot(null)}
        footer={<button type="button" className="btn btn-ghost" onClick={() => setDetailBot(null)}>关闭</button>}
      >
        {detail ? (
          <div className="form-stack">
            <section className="detail-section">
              <h3 className="subsection-title">运行控制</h3>
              <p className="field-help">
                动作走 /api/actions；启动失败时真实原因来自 SSE 的 bot/status 事件（例如未配置 QQ 凭据）。
              </p>
              <div className="cell-inline">
                <StatusDot tone={runtimeTone(runtime?.bots[detail.id]?.status).tone} pulse={detailRunning} />
                <span>{runtimeTone(runtime?.bots[detail.id]?.status).label}</span>
                {detail.enabled ? <Badge tone="ok">允许启动</Badge> : <Badge tone="idle">已停用</Badge>}
              </div>
              <div className="row-actions detail-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={detailBusy !== null || detailRunning}
                  onClick={() => void runBotAction(detail, 'start', { detail: true })}
                >
                  {detailBusy === 'start' ? '启动中…' : '启动'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={detailBusy !== null || !detailRunning}
                  onClick={() => void runBotAction(detail, 'stop', { detail: true })}
                >
                  {detailBusy === 'stop' ? '停止中…' : '停止'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={detailBusy !== null}
                  onClick={() => void runBotAction(detail, 'restart', { detail: true })}
                >
                  {detailBusy === 'restart' ? '重启中…' : '重启'}
                </button>
              </div>
              {botErrors[detail.id] ? (
                <div className="note note-error">
                  <span className="note-title">最近启动错误</span>
                  <span className="note-text mono">{botErrors[detail.id]}</span>
                </div>
              ) : null}
              {detailNotice ? <div className="note note-pending"><span className="note-text">{detailNotice}</span></div> : null}
              {detailError ? <ActionError error={detailError} /> : null}
            </section>

            <section className="detail-section">
              <h3 className="subsection-title">重置会话</h3>
              <p className="field-help">
                轮换该 peer 的会话 epoch：下一次消息会创建全新会话，旧会话的持久化记录仍可恢复。peer 形如
                <code className="inline-code mono"> qq:group:123456</code> 或 <code className="inline-code mono">qq:c2c:OPENID</code>。
              </p>
              <Field label="会话 peer" htmlFor="reset-peer" required>
                <input
                  id="reset-peer"
                  className="input mono"
                  value={peer}
                  placeholder="qq:group:123456"
                  onChange={(event) => setPeer(event.target.value)}
                />
              </Field>
              <div className="row-actions detail-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={detailBusy !== null || peer.trim() === ''}
                  onClick={() => void resetPeer()}
                >
                  {detailBusy === 'reset-peer' ? '重置中…' : '重置会话'}
                </button>
              </div>
              {resetResult ? <div className="result-box mono">{resetResult}</div> : null}
            </section>

            <section className="detail-section">
              <h3 className="subsection-title">基础信息</h3>
              <dl className="kv">
                <div className="kv-row"><dt>QQ AppID</dt><dd className="mono">{detail.appId || '—'}</dd></div>
                <div className="kv-row"><dt>AppSecret</dt><dd>{detail.hasSecret ? '已配置（不回显）' : '未配置'}</dd></div>
                <div className="kv-row"><dt>工作目录</dt><dd className="mono ellipsis" title={detail.cwd || ''}>{detail.cwd || '—'}</dd></div>
                <div className="kv-row"><dt>更新时间</dt><dd className="mono">{fmtTimeSmart(detail.updatedAt)}</dd></div>
              </dl>
              <div className="row-actions detail-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setDetailBot(null);
                    setBotId(detail.id);
                    navigate('/profiles');
                  }}
                >
                  配置档与绑定
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => { const target = detail; setDetailBot(null); openEdit(target); }}
                >
                  编辑机器人
                </button>
              </div>
            </section>
          </div>
        ) : null}
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
