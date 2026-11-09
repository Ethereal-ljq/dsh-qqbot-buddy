/**
 * pages/AuditPage —— 审计日志：控制台与机器人操作的最近记录（只读）。
 */
import { useMemo, useState } from 'react';

import { api } from '../api/client';
import type { AuditEntry } from '../api/types';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { PageHeader } from '../components/PageHeader';
import { fmtDateTime, truncate } from '../lib/format';
import { useApi } from '../state/useApi';

export function AuditPage() {
  const [limit, setLimit] = useState(100);
  const [filter, setFilter] = useState('');
  const audit = useApi((signal) => api.listAudit(limit, signal), [limit]);

  const rows = useMemo(() => {
    const items = audit.data ?? [];
    const keyword = filter.trim().toLowerCase();
    if (keyword === '') return items;
    return items.filter((entry) =>
      [entry.kind, entry.botId || '', entry.detail || '', String(entry.id)].some((field) => field.toLowerCase().includes(keyword)),
    );
  }, [audit.data, filter]);

  const columns: Array<Column<AuditEntry>> = [
    {
      key: 'at',
      title: '时间',
      width: '176px',
      render: (entry) => <span className="mono cell-sub">{fmtDateTime(entry.at)}</span>,
    },
    {
      key: 'kind',
      title: '类型',
      width: '148px',
      render: (entry) => <span className="tag mono">{entry.kind}</span>,
    },
    {
      key: 'botId',
      title: '机器人',
      width: '200px',
      render: (entry) => <span className="mono cell-sub">{entry.botId || '—'}</span>,
    },
    {
      key: 'detail',
      title: '详情',
      render: (entry) => (
        <span className="mono cell-sub detail-cell" title={entry.detail || ''}>{truncate(entry.detail || '—', 160)}</span>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="审计日志"
        description="登录、增删改、启停等操作写入 audit 表；按时间倒序，最多读 500 条。"
        actions={(
          <div className="row-actions">
            <label className="toolbar-field">
              <span className="toolbar-label">条数</span>
              <select className="input select-compact" value={limit} onChange={(event) => setLimit(Number(event.target.value) || 100)}>
                <option value={100}>最近 100</option>
                <option value={200}>最近 200</option>
                <option value={500}>最近 500</option>
              </select>
            </label>
            <button type="button" className="btn btn-ghost" onClick={audit.reload}>刷新</button>
          </div>
        )}
      />

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">最近记录</h2>
            <p className="panel-desc">共 {audit.data?.length ?? 0} 条；过滤只作用于已加载的条目。</p>
          </div>
          <div className="panel-tools">
            <label className="toolbar-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                className="input search-input"
                data-search-input
                placeholder="按类型 / 机器人 / 详情过滤"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
          </div>
        </header>
        <div className="panel-body flush">
          {audit.error && !audit.error.unimplemented && !audit.data ? (
            <div className="panel-pad"><ErrorNote error={audit.error} onRetry={audit.reload} /></div>
          ) : audit.error?.unimplemented ? (
            <div className="panel-pad">
              <EmptyState tone="pending" title="审计接口尚未装配" description="控制台装配后 /api/audit 返回最近记录。" endpoint="GET /api/audit?limit=…" />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(entry) => entry.id}
              loading={audit.loading}
              skeletonRows={6}
              empty={(
                <EmptyState
                  title={filter ? '没有匹配的记录' : '暂无审计事件'}
                  description={filter ? '换个关键词试试。' : '控制台启动后的登录与写操作会记录在这里。'}
                  action={filter ? <button type="button" className="btn btn-sm" onClick={() => setFilter('')}>清空过滤</button> : undefined}
                />
              )}
            />
          )}
        </div>
      </section>
    </div>
  );
}
