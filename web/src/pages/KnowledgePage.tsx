/**
 * pages/KnowledgePage —— 知识库：文档列表、Markdown 入库、检索验证。
 *
 * bot 级共享：切换配置档不影响知识库。检索语义由 core/kb/store 决定
 * （query < 3 字符走 LIKE，否则 FTS5 trigram bm25），页面只呈现 mode 与 score。
 */
import { useMemo, useState, type FormEvent } from 'react';

import { api, toApiError } from '../api/client';
import type { ApiError } from '../api/client';
import type { KbDoc, KbHit } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { Field } from '../components/Field';
import { PageHeader } from '../components/PageHeader';
import { Badge } from '../components/Status';
import { actionFeedback } from '../lib/actions';
import { fmtBytes, fmtNumber, fmtTimeSmart, searchModeLabel, searchModeTone, truncate } from '../lib/format';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';
import { useApi } from '../state/useApi';

export function KnowledgePage() {
  const { botId, bots, bot, notify, reloadState } = useApp();
  const docs = useApi((signal) => (botId ? api.listKbDocs(botId, signal) : Promise.resolve([])), [botId]);
  const [filter, setFilter] = useState('');

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KbHit[] | null>(null);
  const [searchError, setSearchError] = useState<ApiError | null>(null);
  const [searching, setSearching] = useState(false);

  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestMode, setIngestMode] = useState<'text' | 'url'>('text');
  const [form, setForm] = useState({ source: '', title: '', text: '', url: '' });
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestErrorDetail, setIngestErrorDetail] = useState<string | null>(null);
  const [ingesting, setIngesting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<KbDoc | null>(null);
  const [deleting, setDeleting] = useState(false);

  const rows = useMemo(() => {
    const items = docs.data ?? [];
    const keyword = filter.trim().toLowerCase();
    if (keyword === '') return items;
    return items.filter((doc) =>
      [doc.title || '', doc.source, String(doc.id)].some((field) => field.toLowerCase().includes(keyword)),
    );
  }, [docs.data, filter]);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (text === '') {
      setSearchError(null);
      setHits(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const result = await api.searchKb({ botId, query: text, limit: 8 });
      setHits(result);
    } catch (err) {
      setHits(null);
      setSearchError(toApiError(err));
    } finally {
      setSearching(false);
    }
  };

  const openIngest = (mode: 'text' | 'url') => {
    setIngestMode(mode);
    setForm({ source: '', title: '', text: '', url: '' });
    setIngestError(null);
    setIngestErrorDetail(null);
    setIngestOpen(true);
  };

  /** URL 入库：走 /api/actions/ingest-url（SSRF/超时/大小限制在 core/kb/ingest-url）。 */
  const submitUrlIngest = async () => {
    const url = form.url.trim();
    if (url === '') {
      setIngestError('请填写目标 URL（http/https 开头）。');
      return;
    }
    setIngesting(true);
    setIngestError(null);
    setIngestErrorDetail(null);
    try {
      const result = await api.action('ingest-url', {
        botId,
        url,
        ...(form.title.trim() !== '' ? { title: form.title.trim() } : {}),
      });
      const data = result as Record<string, unknown>;
      const docId = Number(data.docId);
      const chunks = Number(data.chunks) || 0;
      const bytes = Number(data.bytes);
      const changed = data.changed !== false;
      const detail = 'docId=' + (Number.isFinite(docId) ? docId : '—')
        + ' · ' + chunks + ' 个分块'
        + (Number.isFinite(bytes) && bytes > 0 ? ' · ' + fmtBytes(bytes) : '');
      notify(changed ? 'ok' : 'info', changed ? 'URL 入库完成' : 'URL 内容未变化（hash 相同，已幂等跳过）', detail);
      setIngestOpen(false);
      docs.reload();
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      const feedback = actionFeedback(error);
      setIngestError(error.unimplemented ? 'URL 入库动作尚未装配（deps.actions 未注入）。' : feedback.message);
      setIngestErrorDetail(feedback.detail ?? null);
      notify(error.unimplemented ? 'info' : 'error', 'URL 入库失败：' + feedback.message, feedback.detail);
    } finally {
      setIngesting(false);
    }
  };

  const submitIngest = async () => {
    if (ingestMode === 'url') {
      await submitUrlIngest();
      return;
    }
    if (form.text.trim() === '') {
      setIngestError('文档内容不能为空；粘贴 Markdown 或纯文本。');
      return;
    }
    setIngesting(true);
    setIngestError(null);
    setIngestErrorDetail(null);
    try {
      const result = await api.ingestKb({
        botId,
        source: form.source.trim() || undefined,
        title: form.title.trim() || undefined,
        text: form.text,
      });
      notify('ok', '入库完成：' + (result.doc?.title || form.title || form.source || '未命名文档') + (result.chunks ? ' · ' + result.chunks + ' 个分块' : ''));
      setIngestOpen(false);
      docs.reload();
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      if (error.unimplemented) {
        setIngestError('知识库内核尚未装配（M4），入库接口返回 501。');
      } else {
        setIngestError(error.message);
        setIngestErrorDetail(error.code + (error.requestId ? ' · requestId ' + error.requestId : ''));
      }
    } finally {
      setIngesting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteKbDoc(deleteTarget.id, botId);
      notify('ok', '已删除知识文档：' + (deleteTarget.title || deleteTarget.source));
      setDeleteTarget(null);
      docs.reload();
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '删除失败：' + error.message, error.code);
    } finally {
      setDeleting(false);
    }
  };

  const columns: Array<Column<KbDoc>> = [
    {
      key: 'title',
      title: '文档',
      render: (doc) => (
        <div className="cell-stack">
          <span className="cell-title">{doc.title || doc.source || '（未命名）'}</span>
          <span className="mono cell-sub ellipsis" title={doc.source}>{truncate(doc.source, 90)}</span>
        </div>
      ),
    },
    {
      key: 'chunks',
      title: '分块',
      width: '80px',
      align: 'right',
      render: (doc) => <span className="mono">{fmtNumber(doc.chunkCount)}</span>,
    },
    {
      key: 'hash',
      title: '内容指纹',
      width: '140px',
      render: (doc) => <span className="mono cell-sub">{doc.hash ? doc.hash.slice(0, 12) : '—'}</span>,
    },
    {
      key: 'updatedAt',
      title: '更新时间',
      width: '140px',
      render: (doc) => <span className="mono cell-sub">{fmtTimeSmart(doc.updatedAt || doc.createdAt)}</span>,
    },
    {
      key: 'actions',
      title: '',
      width: '88px',
      align: 'right',
      render: (doc) => (
        <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setDeleteTarget(doc)}>删除</button>
      ),
    },
  ];

  if (bots.length === 0) {
    return (
      <div className="page">
        <PageHeader title="知识库" description="知识库按机器人共享；先创建机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState
            title="还没有机器人"
            description="知识文档挂在 bot 下，与配置档无关。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去创建机器人</button>}
          />
        </div></section>
      </div>
    );
  }

  if (!botId) {
    return (
      <div className="page">
        <PageHeader title="知识库" description="先选择作用域机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState title="未选择机器人" description="顶栏选择机器人后即可管理该 bot 的知识库。" />
        </div></section>
      </div>
    );
  }

  const docsError = docs.error;

  return (
    <div className="page">
      <PageHeader
        title="知识库"
        description={'当前机器人：' + (bot?.name || botId) + '。Markdown 标题优先分块，FTS5 trigram 检索；短查询自动回退 LIKE。'}
        actions={(
          <div className="row-actions">
            <button type="button" className="btn btn-ghost" onClick={() => openIngest('url')}>URL 入库</button>
            <button type="button" className="btn btn-primary" onClick={() => openIngest('text')}>入库文档</button>
          </div>
        )}
      />

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">检索验证</h2>
            <p className="panel-desc">query 少于 3 个字符时 trigram 无法命中，会回退 LIKE 并标记模式。</p>
          </div>
        </header>
        <div className="panel-body">
          <form className="search-row" onSubmit={(event) => void search(event)}>
            <input
              className="input search-input-lg"
              data-search-input
              value={query}
              placeholder="输入问题或关键词，回车检索知识库"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={searching}>{searching ? '检索中…' : '检索'}</button>
            {hits !== null || searchError ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { setHits(null); setSearchError(null); setQuery(''); }}
              >
                清空
              </button>
            ) : null}
          </form>

          {searchError ? (
            searchError.unimplemented
              ? <EmptyState compact tone="pending" title="检索内核尚未装配" description="知识库检索依赖 core/kb/store，M4 交付后可用。" endpoint="POST /api/kb/search" />
              : <ErrorNote error={searchError} />
          ) : hits !== null ? (
            hits.length === 0 ? (
              <EmptyState compact title="没有匹配结果" description="换用至少 3 个字的查询，或确认文档已入库。" />
            ) : (
              <ul className="hit-list">
                {hits.map((hit, index) => (
                  <li className="hit" key={(hit.chunkId ?? index) + '-' + index}>
                    <div className="hit-head">
                      <span className="hit-title">{hit.title || '未命名文档'}</span>
                      {hit.mode ? (
                        <Badge tone={searchModeTone(hit.mode)} mono>{searchModeLabel(hit.mode)}</Badge>
                      ) : null}
                      {hit.score !== undefined ? <span className="mono hit-score">score {hit.score.toFixed(3)}</span> : null}
                      {hit.docId !== undefined ? <span className="mono hit-doc">doc #{hit.docId}</span> : null}
                    </div>
                    <p className="hit-text">{hit.text}</p>
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
            <h2 className="panel-title">文档</h2>
            <p className="panel-desc">共 {docs.data?.length ?? 0} 篇；按 source 幂等重入，hash 去重。</p>
          </div>
          <div className="panel-tools">
            <label className="toolbar-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                className="input search-input"
                data-search-input
                placeholder="按标题 / source 过滤"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <button type="button" className="btn btn-sm btn-ghost" onClick={docs.reload}>刷新</button>
          </div>
        </header>
        <div className="panel-body flush">
          {docsError && !docsError.unimplemented && !docs.data ? (
            <div className="panel-pad"><ErrorNote error={docsError} onRetry={docs.reload} /></div>
          ) : docsError?.unimplemented ? (
            <div className="panel-pad">
              <EmptyState
                tone="pending"
                title="知识库存储尚未装配"
                description="文档列表接口在 core/kb 装配后可用；当前返回 501。"
                endpoint="GET /api/kb/docs?bot=…"
              />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(doc) => doc.id}
              loading={docs.loading}
              skeletonRows={4}
              empty={(
                <EmptyState
                  title={filter ? '没有匹配的文档' : '知识库还是空的'}
                  description={filter ? '换个关键词试试。' : '粘贴 Markdown 入库；标题会优先成为分块边界。'}
                  action={filter
                    ? <button type="button" className="btn btn-sm" onClick={() => setFilter('')}>清空过滤</button>
                    : <button type="button" className="btn btn-primary btn-sm" onClick={() => openIngest('text')}>入库第一篇文档</button>}
                />
              )}
            />
          )}
        </div>
      </section>

      <Drawer
        open={ingestOpen}
        title={ingestMode === 'url' ? '从 URL 入库' : '入库文档'}
        subtitle={ingestMode === 'url'
          ? '抓取网页并抽取正文；同 URL 重复抓取按 hash 幂等'
          : '同一 source 重入会替换旧文档；内容 hash 相同则视为无变化。'}
        onClose={() => { if (!ingesting) setIngestOpen(false); }}
        footer={(
          <>
            <button type="button" className="btn btn-ghost" disabled={ingesting} onClick={() => setIngestOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={ingesting} onClick={() => void submitIngest()}>
              {ingesting ? (ingestMode === 'url' ? '抓取中…' : '入库中…') : (ingestMode === 'url' ? '抓取并入库' : '入库')}
            </button>
          </>
        )}
      >
        <div className="form-stack">
          <div className="segmented" role="group" aria-label="入库方式">
            <button
              type="button"
              className={'seg-btn' + (ingestMode === 'text' ? ' active' : '')}
              disabled={ingesting}
              onClick={() => setIngestMode('text')}
            >
              粘贴文本
            </button>
            <button
              type="button"
              className={'seg-btn' + (ingestMode === 'url' ? ' active' : '')}
              disabled={ingesting}
              onClick={() => setIngestMode('url')}
            >
              从 URL 抓取
            </button>
          </div>

          {ingestMode === 'url' ? (
            <>
              <Field label="目标 URL" htmlFor="kb-url" required help="仅支持公网 http/https；默认 2 MiB 上限、15 秒超时，内网/本机地址会被 SSRF 防护拒绝。">
                <input
                  id="kb-url"
                  className="input mono"
                  value={form.url}
                  placeholder="https://example.com/docs/faq"
                  onChange={(event) => setForm({ ...form, url: event.target.value })}
                />
              </Field>
              <Field label="标题（可选）" htmlFor="kb-title" help="留空时优先取 HTML <title>，其次用 URL 末段。">
                <input
                  id="kb-title"
                  className="input"
                  value={form.title}
                  placeholder="例如：客服 FAQ"
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                />
              </Field>
              <div className="hint-strip">
                <span className="hint-label">限制</span>
                <span className="hint-text">仅 HTML / 纯文本 / JSON；重定向最多 3 次；失败时按后端 error.code 给出可读原因。</span>
              </div>
            </>
          ) : (
            <>
              <Field label="来源标识 source" htmlFor="kb-source" help="唯一标识（文件路径 / URL / 自定义 id），用于幂等重入。留空由服务端生成。">
                <input
                  id="kb-source"
                  className="input mono"
                  value={form.source}
                  placeholder="docs/faq.md 或 https://example.com/doc"
                  onChange={(event) => setForm({ ...form, source: event.target.value })}
                />
              </Field>
              <Field label="标题" htmlFor="kb-title" help="留空时从 Markdown 一级标题或 source 推断。">
                <input
                  id="kb-title"
                  className="input"
                  value={form.title}
                  placeholder="例如：客服 FAQ"
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                />
              </Field>
              <Field label="内容（Markdown / 纯文本）" htmlFor="kb-text" required wide>
                <textarea
                  id="kb-text"
                  className="input textarea mono kb-textarea"
                  rows={12}
                  value={form.text}
                  placeholder={'# 标题\n\n正文…\n\n## 小节\n\n按 Markdown 标题优先切块，超长段落按 800 字符滑窗。'}
                  onChange={(event) => setForm({ ...form, text: event.target.value })}
                />
              </Field>
            </>
          )}

          {ingestError ? (
            <div className="note note-error" role="alert">
              <span className="note-title">{ingestError}</span>
              {ingestErrorDetail ? <span className="note-meta mono">{ingestErrorDetail}</span> : null}
            </div>
          ) : null}
        </div>
      </Drawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除知识文档"
        message={<span>删除 <strong>{deleteTarget?.title || deleteTarget?.source}</strong> 及其全部分块？该操作不可撤销。</span>}
        confirmLabel="删除"
        busy={deleting}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
