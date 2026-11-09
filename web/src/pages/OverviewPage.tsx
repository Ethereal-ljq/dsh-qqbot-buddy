/**
 * pages/OverviewPage —— 总览：运行读数、机器人运行状态、控制台信息与实时事件。
 *
 * 数据源：/api/state 快照（context 统一维护）+ /api/events SSE 事件（实时横条与列表）。
 */
import { useState } from 'react';

import { api, toApiError } from '../api/client';
import { Badge, SourceTag, StatusDot, runtimeTone } from '../components/Status';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { PageHeader } from '../components/PageHeader';
import { fmtDuration, fmtNumber, fmtRelative, fmtTimeSmart, summarizeEvent, truncate } from '../lib/format';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';
import type { Bot } from '../api/types';

const RUNNING_STATUS = new Set(['online', 'running', 'ready', 'connected', 'starting']);
const EVENT_LABEL: Record<string, string> = {
  hello: '已连接',
  'bot/status': '机器人状态',
  'job/progress': '任务进度',
  log: '日志',
  message: '事件',
};

function isRunning(status?: string): boolean {
  return RUNNING_STATUS.has((status || '').toLowerCase());
}

export function OverviewPage() {
  const {
    state, stateError, loadingState, reloadState, health, sse, events, setBotId, notify,
  } = useApp();
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const bots = state?.bots ?? [];
  const profiles = state?.profiles ?? [];
  const bindings = state?.bindings ?? [];
  const runtime = state?.runtime;
  const enabledCount = bots.filter((bot) => bot.enabled).length;
  const runningCount = bots.filter((bot) => isRunning(runtime?.bots[bot.id]?.status)).length;
  const uptime = state?.console.uptimeMs ?? health?.uptimeMs;

  const runAction = async (bot: Bot, name: 'start' | 'stop' | 'restart') => {
    const key = bot.id + ':' + name;
    setBusyAction(key);
    try {
      await api.action(name, { botId: bot.id });
      notify('ok', '已请求' + (name === 'start' ? '启动' : name === 'stop' ? '停止' : '重启') + '：' + bot.name);
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      if (error.unimplemented) {
        notify('info', '机器人启停能力将在宿主适配（M2）后接入', 'POST /api/actions/' + name);
      } else {
        notify('error', '操作失败：' + error.message, error.code);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const columns: Array<Column<Bot>> = [
    {
      key: 'name',
      title: '机器人',
      render: (bot) => (
        <div className="cell-stack">
          <span className="cell-title">{bot.name}</span>
          <span className="mono cell-sub">{bot.id}</span>
        </div>
      ),
    },
    {
      key: 'enabled',
      title: '启用',
      width: '72px',
      render: (bot) => (bot.enabled ? <Badge tone="ok">已启用</Badge> : <Badge tone="idle">已停用</Badge>),
    },
    {
      key: 'runtime',
      title: '运行状态',
      width: '120px',
      render: (bot) => {
        const info = runtimeTone(runtime?.bots[bot.id]?.status);
        return (
          <span className="cell-inline">
            <StatusDot tone={info.tone} pulse={info.tone === 'ok'} />
            {info.label}
          </span>
        );
      },
    },
    {
      key: 'appId',
      title: 'QQ AppID',
      width: '160px',
      render: (bot) => <span className="mono cell-sub">{bot.appId || '—'}</span>,
    },
    {
      key: 'actions',
      title: '',
      width: '196px',
      align: 'right',
      render: (bot) => {
        const running = isRunning(runtime?.bots[bot.id]?.status);
        const busy = busyAction?.startsWith(bot.id + ':') ?? false;
        return (
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => void runAction(bot, running ? 'stop' : 'start')}
            >
              {busy ? '处理中…' : running ? '停止' : '启动'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setBotId(bot.id);
                navigate('/profiles');
              }}
            >
              配置
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="总览"
        description="控制台与机器人运行状态、配置规模与最近事件。快照在 SSE 事件到达时自动刷新。"
      />

      <div className="readouts">
        <div className="readout">
          <span className="readout-num mono">{bots.length}</span>
          <span className="readout-label">机器人</span>
          <span className="readout-sub">{enabledCount} 个已启用</span>
        </div>
        <div className="readout">
          <span className="readout-num mono">{runningCount}</span>
          <span className="readout-label">运行中</span>
          <span className="readout-sub">{bots.length - runningCount} 个未运行</span>
        </div>
        <div className="readout">
          <span className="readout-num mono">{fmtNumber(profiles.length)}</span>
          <span className="readout-label">配置档</span>
          <span className="readout-sub">跨 {new Set(profiles.map((profile) => profile.botId)).size} 个机器人</span>
        </div>
        <div className="readout">
          <span className="readout-num mono">{fmtNumber(bindings.length)}</span>
          <span className="readout-label">作用域绑定</span>
          <span className="readout-sub">精确 &gt; 类型通配 &gt; 默认</span>
        </div>
      </div>

      <div className="grid-main">
        <section className="panel">
          <header className="panel-head">
            <div>
              <h2 className="panel-title">机器人与运行状态</h2>
              <p className="panel-desc">启动/停止会写入运行状态并刷新快照；启停接口未接入时会有明确提示。</p>
            </div>
            <div className="panel-tools">
              <button type="button" className="btn btn-sm" onClick={() => navigate('/bots')}>管理机器人</button>
            </div>
          </header>
          <div className="panel-body flush">
            {stateError && !state ? (
              <div className="panel-pad"><ErrorNote error={stateError} onRetry={() => void reloadState()} /></div>
            ) : (
              <DataTable
                columns={columns}
                rows={bots}
                rowKey={(bot) => bot.id}
                loading={!state && loadingState}
                skeletonRows={3}
                empty={(
                  <EmptyState
                    compact
                    title="还没有机器人"
                    description="先创建一个机器人，再配置 QQ 应用、工作目录与配置档。"
                    action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去创建</button>}
                  />
                )}
              />
            )}
          </div>
        </section>

        <div className="stack">
          <section className="panel">
            <header className="panel-head">
              <h2 className="panel-title">控制台信息</h2>
            </header>
            <div className="panel-body">
              <dl className="kv">
                <div className="kv-row"><dt>版本</dt><dd className="mono">v{state?.console.version || health?.version || '—'}</dd></div>
                <div className="kv-row"><dt>运行时长</dt><dd className="mono">{fmtDuration(uptime)}</dd></div>
                <div className="kv-row">
                  <dt>监听地址</dt>
                  <dd className="mono">{state?.console.host || '127.0.0.1'}:{state?.console.port || 6198}</dd>
                </div>
                <div className="kv-row">
                  <dt>事件流</dt>
                  <dd>
                    <span className="cell-inline">
                      <StatusDot tone={sse === 'live' ? 'ok' : sse === 'connecting' ? 'warn' : 'danger'} pulse={sse === 'live'} />
                      {sse === 'live' ? '已连接' : sse === 'connecting' ? '连接中' : '已断开'}
                    </span>
                  </dd>
                </div>
                <div className="kv-row"><dt>数据层</dt><dd>SQLite · WAL · FTS5</dd></div>
              </dl>
            </div>
          </section>

          <section className="panel">
            <header className="panel-head">
              <div>
                <h2 className="panel-title">最近事件</h2>
                <p className="panel-desc">来自 /api/events，最多保留 80 条。</p>
              </div>
              <span className="panel-count mono">{events.length}</span>
            </header>
            <div className="panel-body flush">
              {events.length === 0 ? (
                <div className="panel-pad">
                  <EmptyState compact title="暂无事件" description="机器人状态、日志与任务进度会出现在这里。" endpoint="GET /api/events" />
                </div>
              ) : (
                <ul className="event-list">
                  {events.slice(0, 10).map((event) => (
                    <li className="event-item" key={event.seq}>
                      <span className="event-time mono">{fmtTimeSmart(event.at)}</span>
                      <span className="event-kind">
                        <SourceTag source={event.event.split('/')[0]} />
                        <span className="event-label">{EVENT_LABEL[event.event] || event.event}</span>
                      </span>
                      <span className="event-text" title={summarizeEvent(event.data)}>
                        {truncate(summarizeEvent(event.data) || '（无负载）', 90)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>

      <p className="page-foot mono">快照时间 {state ? fmtRelative(state.console.startedAt) : '—'} 启动 · 刷新以获取最新状态</p>
    </div>
  );
}
