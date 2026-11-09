/**
 * pages/MemoryPage —— 长期记忆：bot 级共享，检索、录入与清理。
 *
 * 数据源：GET /api/memories?bot=、POST /api/memories/search、POST /api/memories、DELETE /api/memories/:id。
 * 检索语义与知识库一致：< 3 字符回退 LIKE 并标记 mode，否则 FTS5 trigram + bm25。
 * 写入走真实内核：近似的文本会被近似去重（created=false / deduped=true）。
 */
import { useMemo, useState, type FormEvent } from 'react';

import { api, toApiError, type ApiError } from '../api/client';
import type { Memory, MemoryHit } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
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

const KIND_LABEL: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  event: '事件',
  other: '其他',
};

function kindLabel(kind?: string): string {
  return KIND_LABEL[kind || 'fact'] || kind || '事实';
}

function tagsOf(memory: Memory): string[] {
  if (Array.isArray(memory.tags)) return memory.tags.map(String);
  if (typeof memory.tags === 'string' && memory.tags.trim() !== '') return memory.tags.split(',');
  return [];
}

export function MemoryPage() {
  const { botId, bots, bot, notify } = useApp();
  const memories = useApi((signal) => (botId ? api.listMemories(botId, {}, signal) : Promise.resolve([])), [botId]);
  const [filter, setFilter] = useState('');

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [searchError, setSearchError] = useState<ApiError | null>(null);
  const [searching, setSearching] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ text: '', kind: 'fact', peer: '', tags: '', source: '' });
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState(false);

  const rows = useMemo(() => {
    const items = memories.data ?? [];
    const keyword = filter.trim().toLowerCase();
    if (keyword === '') return items;
    return items.filter((memory) =>
      [memory.text, memory.peer || '', memory.kind || '', tagsOf(memory).join(' ')]
        .some((field) => field.toLowerCase().includes(keyword)),
    );
  }, [memories.data, filter]);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (text === '') {
      setHits(null);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      setHits(await api.searchMemories({ botId, query: text, limit: 10 }));
    } catch (err) {
      setHits(null);
      setSearchError(toApiError(err));
    } finally {
      setSearching(false);
    }
  };

  const openCreate = () => {
    setForm({ text: '', kind: 'fact', peer: '', tags: '', source: '' });
    setCreateError(null);
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    const text = form.text.trim();
    if (text === '') {
      setCreateError('记忆内容不能为空。');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const tags = form.tags.split(/[,，\s]+/).map((part) => part.trim()).filter(Boolean);
      const saved = await api.createMemory({
        botId,
        text,
        kind: form.kind,
        peer: form.peer.trim() || undefined,
        source: form.source.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
      });
      notify(saved.deduped ? 'info' : 'ok', saved.deduped ? '已存在近似记忆，已刷新并合并标签' : '已新增记忆');
      setCreateOpen(false);
      memories.reload();
    } catch (err) {
      setCreateError(toApiError(err).message);
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteMemory(deleteTarget.id);
      notify('ok', '已删除记忆 #' + deleteTarget.id);
      setDeleteTarget(null);
      memories.reload();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '删除失败：' + error.message, error.code);
    } finally {
      setDeleting(false);
    }
  };

  const columns: Array<Column<Memory>> = [
    {
      key: 'text',
      title: '记忆内容',
      render: (memory) => (
        <div className="cell-stack">
          <span className="memory-text" title={memory.text}>{memory.text}</span>
          {tagsOf(memory).length > 0 ? (
            <span className="sub-tags">
              {tagsOf(memory).map((tag) => <span key={tag} className="tag mono">{tag}</span>)}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'kind',
      title: '类型',
      width: '78px',
      render: (memory) => <Badge tone="idle">{kindLabel(memory.kind)}</Badge>,
    },
    {
      key: 'peer',
      title: '来源会话',
      width: '176px',
      render: (memory) => <span className="mono cell-sub ellipsis" title={memory.peer || ''}>{memory.peer || '—'}</span>,
    },
    {
      key: 'source',
      title: '来源',
      width: '140px',
      render: (memory) => <span className="cell-sub ellipsis" title={memory.source || ''}>{truncate(memory.source || '—', 22)}</span>,
    },
    {
      key: 'updatedAt',
      title: '更新时间',
      width: '132px',
      render: (memory) => <span className="mono cell-sub">{fmtTimeSmart(memory.updatedAt)}</span>,
    },
    {
      key: 'actions',
      title: '',
      width: '80px',
      align: 'right',
      render: (memory) => (
        <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setDeleteTarget(memory)}>删除</button>
      ),
    },
  ];

  if (bots.length === 0) {
    return (
      <div className="page">
        <PageHeader title="记忆" description="记忆按机器人共享；先创建机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState
            title="还没有机器人"
            description="长期记忆挂在 bot 下，与配置档无关：切换配置档不会丢记忆、不会串记忆。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去创建机器人</button>}
          />
        </div></section>
      </div>
    );
  }

  if (!botId) {
    return (
      <div className="page">
        <PageHeader title="记忆" description="先选择作用域机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState title="未选择机器人" description="顶栏选择机器人后即可查看该 bot 的长期记忆。" />
        </div></section>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="记忆"
        description={'当前机器人：' + (bot?.name || botId) + '。长期记忆按 bot 共享；写入会做近似去重，检索结果标注 fts / like 模式。'}
        actions={<button type="button" className="btn btn-primary" onClick={openCreate}>新增记忆</button>}
      />

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">检索验证</h2>
            <p className="panel-desc">查询不足 3 个字符时 trigram 无法命中，会回退 LIKE 并标记 mode。</p>
          </div>
        </header>
        <div className="panel-body">
          <form className="search-row" onSubmit={(event) => void search(event)}>
            <input
              className="input search-input-lg"
              data-search-input
              value={query}
              placeholder="输入关键词检索记忆，回车执行"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={searching}>{searching ? '检索中…' : '检索'}</button>
            {hits !== null || searchError ? (
              <button type="button" className="btn btn-ghost" onClick={() => { setHits(null); setSearchError(null); setQuery(''); }}>清空</button>
            ) : null}
          </form>

          {searchError ? (
            <ErrorNote error={searchError} />
          ) : hits !== null ? (
            hits.length === 0 ? (
              <EmptyState compact title="没有匹配的记忆" description="换用至少 3 个字的查询，或先新增一条记忆。" />
            ) : (
              <ul className="hit-list">
                {hits.map((hit, index) => (
                  <li className="hit" key={hit.id ?? index}>
                    <div className="hit-head">
                      <span className="hit-title">{kindLabel(hit.kind)}记忆</span>
                      {hit.peer ? <span className="mono cell-sub">{hit.peer}</span> : null}
                      {hit.mode ? (
                        <Badge tone={hit.mode === 'like' ? 'warn' : 'ok'} mono>
                          {hit.mode === 'like' ? 'LIKE 回退' : 'FTS trigram'}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="hit-text">{hit.snippet || hit.text}</p>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      </section>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">记忆库</h2>
            <p className="panel-desc">共 {memories.data?.length ?? 0} 条；按最近更新排序。</p>
          </div>
          <div className="panel-tools">
            <label className="toolbar-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                className="input search-input"
                data-search-input
                placeholder="按内容 / 类型 / 来源过滤"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <button type="button" className="btn btn-sm btn-ghost" onClick={memories.reload}>刷新</button>
          </div>
        </header>
        <div className="panel-body flush">
          {memories.error && !memories.error.unimplemented && !memories.data ? (
            <div className="panel-pad"><ErrorNote error={memories.error} onRetry={memories.reload} /></div>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(memory) => memory.id}
              loading={memories.loading}
              skeletonRows={5}
              empty={(
                <EmptyState
                  title={filter ? '没有匹配的记忆' : '记忆库还是空的'}
                  description={filter ? '换个关键词试试。' : '机器人对话中提炼的记忆会出现在这里，也可以手动新增。'}
                  action={filter
                    ? <button type="button" className="btn btn-sm" onClick={() => setFilter('')}>清空过滤</button>
                    : <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>新增记忆</button>}
                />
              )}
            />
          )}
        </div>
      </section>

      <Drawer
        open={createOpen}
        title="新增记忆"
        subtitle="写入会做近似去重：与已有记忆高度相似时只刷新并合并标签。"
        onClose={() => { if (!creating) setCreateOpen(false); }}
        footer={(
          <>
            <button type="button" className="btn btn-ghost" disabled={creating} onClick={() => setCreateOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={creating} onClick={() => void submitCreate()}>
              {creating ? '保存中…' : '保存'}
            </button>
          </>
        )}
      >
        <div className="form-stack">
          <Field label="记忆内容" htmlFor="memory-text" required wide help="一句话事实/偏好/事件，例如：群主喜欢用表情包回复。">
            <textarea
              id="memory-text"
              className="input textarea"
              rows={4}
              value={form.text}
              onChange={(event) => setForm({ ...form, text: event.target.value })}
            />
          </Field>
          <div className="form-row">
            <Field label="类型" htmlFor="memory-kind">
              <select
                id="memory-kind"
                className="input"
                value={form.kind}
                onChange={(event) => setForm({ ...form, kind: event.target.value })}
              >
                {Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="来源会话 peer" htmlFor="memory-peer" help="可留空；一般形如 qq:group:123456。">
              <input
                id="memory-peer"
                className="input mono"
                value={form.peer}
                placeholder="qq:group:123456"
                onChange={(event) => setForm({ ...form, peer: event.target.value })}
              />
            </Field>
          </div>
          <div className="form-row">
            <Field label="标签 tags" htmlFor="memory-tags" help="逗号分隔，可留空。">
              <input
                id="memory-tags"
                className="input mono"
                value={form.tags}
                placeholder="偏好, 群聊"
                onChange={(event) => setForm({ ...form, tags: event.target.value })}
              />
            </Field>
            <Field label="来源 source" htmlFor="memory-source" help="可留空；例如 auto-extract / manual。">
              <input
                id="memory-source"
                className="input mono"
                value={form.source}
                placeholder="manual"
                onChange={(event) => setForm({ ...form, source: event.target.value })}
              />
            </Field>
          </div>
          {createError ? <p className="field-error" role="alert">{createError}</p> : null}
        </div>
      </Drawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除记忆"
        message={<span>删除记忆 <strong>#{deleteTarget?.id}</strong>？<br />{truncate(deleteTarget?.text, 120)}</span>}
        confirmLabel="删除"
        busy={deleting}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
