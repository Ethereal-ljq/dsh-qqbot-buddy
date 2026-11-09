/**
 * pages/StickersPage —— 表情包库：路径登记、emotion 标签、hash 去重与当日发送量。
 *
 * 数据源：GET/POST /api/stickers、GET /api/stickers/quota、DELETE /api/stickers/:id?bot=。
 * 当前是 JSON 注册已有文件（非 multipart 上传）：file 是路径字符串，删除时会尝试删除该文件。
 */
import { useMemo, useState } from 'react';

import { api, toApiError } from '../api/client';
import type { Sticker } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { Field } from '../components/Field';
import { PageHeader } from '../components/PageHeader';
import { Badge } from '../components/Status';
import { fmtNumber, fmtTimeSmart, truncate } from '../lib/format';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';
import { useApi } from '../state/useApi';

export function StickersPage() {
  const { botId, bots, bot, notify } = useApp();
  const stickers = useApi((signal) => (botId ? api.listStickers(botId, {}, signal) : Promise.resolve([])), [botId]);
  const quota = useApi((signal) => (botId ? api.stickerQuota(botId, signal) : Promise.resolve(null)), [botId]);
  const [filter, setFilter] = useState('');
  const [emotion, setEmotion] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', file: '', emotion: '', hash: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Sticker | null>(null);
  const [deleting, setDeleting] = useState(false);

  const emotions = useMemo(() => {
    const set = new Set<string>();
    for (const sticker of stickers.data ?? []) if (sticker.emotion) set.add(sticker.emotion);
    return [...set].sort();
  }, [stickers.data]);

  const rows = useMemo(() => {
    const items = stickers.data ?? [];
    const keyword = filter.trim().toLowerCase();
    return items.filter((sticker) => {
      if (emotion && sticker.emotion !== emotion) return false;
      if (keyword === '') return true;
      return [sticker.name, sticker.file, sticker.emotion || '', sticker.hash || '']
        .some((field) => field.toLowerCase().includes(keyword));
    });
  }, [stickers.data, filter, emotion]);

  const openCreate = () => {
    setForm({ name: '', file: '', emotion: '', hash: '' });
    setFormError(null);
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    if (form.name.trim() === '') { setFormError('名称不能为空。'); return; }
    if (form.file.trim() === '') { setFormError('文件路径不能为空。'); return; }
    setSaving(true);
    setFormError(null);
    try {
      const saved = await api.addSticker({
        botId,
        name: form.name.trim(),
        file: form.file.trim(),
        emotion: form.emotion.trim() || undefined,
        hash: form.hash.trim() || undefined,
      });
      notify(saved.created === false ? 'info' : 'ok', saved.created === false ? '相同 hash 已存在，返回已有表情包' : '已登记表情包：' + saved.name);
      setCreateOpen(false);
      stickers.reload();
      quota.reload();
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
      await api.deleteSticker(deleteTarget.id, botId);
      notify('ok', '已删除表情包：' + deleteTarget.name);
      setDeleteTarget(null);
      stickers.reload();
      quota.reload();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '删除失败：' + error.message, error.code);
    } finally {
      setDeleting(false);
    }
  };

  const columns: Array<Column<Sticker>> = [
    {
      key: 'name',
      title: '表情',
      width: '200px',
      render: (sticker) => (
        <div className="cell-stack">
          <span className="cell-title">{sticker.name}</span>
          {sticker.emotion ? <span className="tag">{sticker.emotion}</span> : <span className="muted cell-sub">无 emotion</span>}
        </div>
      ),
    },
    {
      key: 'file',
      title: '文件路径',
      render: (sticker) => (
        <span className="mono cell-sub sticker-file" title={sticker.file}>{truncate(sticker.file, 88)}</span>
      ),
    },
    {
      key: 'hash',
      title: 'hash',
      width: '128px',
      render: (sticker) => <span className="mono cell-sub">{sticker.hash ? sticker.hash.slice(0, 10) : '—'}</span>,
    },
    {
      key: 'createdAt',
      title: '收藏时间',
      width: '140px',
      render: (sticker) => <span className="mono cell-sub">{fmtTimeSmart(sticker.createdAt)}</span>,
    },
    {
      key: 'actions',
      title: '',
      width: '80px',
      align: 'right',
      render: (sticker) => (
        <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setDeleteTarget(sticker)}>删除</button>
      ),
    },
  ];

  if (bots.length === 0) {
    return (
      <div className="page">
        <PageHeader title="表情包" description="表情包按机器人共享；先创建机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState
            title="还没有机器人"
            description="表情包库挂在 bot 下，文件通常位于 bot 的 media/ 目录。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去创建机器人</button>}
          />
        </div></section>
      </div>
    );
  }

  if (!botId) {
    return (
      <div className="page">
        <PageHeader title="表情包" description="先选择作用域机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState title="未选择机器人" description="顶栏选择机器人后即可管理该 bot 的表情包。" />
        </div></section>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="表情包"
        description={'当前机器人：' + (bot?.name || botId) + '。按 (bot, hash) 去重；emotion 标签供模型挑选，发送配额由配置档控制。'}
        actions={<button type="button" className="btn btn-primary" onClick={openCreate}>登记表情包</button>}
      />

      <div className="readouts readouts-3">
        <div className="readout">
          <span className="readout-num mono">{fmtNumber(stickers.data?.length ?? 0)}</span>
          <span className="readout-label">收藏总数</span>
          <span className="readout-sub">{emotions.length} 种 emotion</span>
        </div>
        <div className="readout">
          <span className="readout-num mono">{fmtNumber(quota.data?.count ?? 0)}</span>
          <span className="readout-label">今日已发送</span>
          <span className="readout-sub">{quota.data?.day || '—'}</span>
        </div>
        <div className="readout">
          <span className="readout-num mono">{fmtNumber(rows.length)}</span>
          <span className="readout-label">当前筛选</span>
          <span className="readout-sub">{emotion || '全部 emotion'}</span>
        </div>
      </div>

      <div className="hint-strip">
        <span className="hint-label">路径登记</span>
        <span className="hint-text">当前接口登记已有文件（不是上传）：file 传相对/绝对路径，删除时会尽力删除该文件；上传能力后续里程碑再加。</span>
      </div>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">全部表情包</h2>
            <p className="panel-desc">共 {stickers.data?.length ?? 0} 个；最近收藏优先。</p>
          </div>
          <div className="panel-tools">
            <select className="input select-compact" value={emotion} onChange={(event) => setEmotion(event.target.value)} aria-label="按 emotion 过滤">
              <option value="">全部 emotion</option>
              {emotions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <label className="toolbar-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                className="input search-input"
                data-search-input
                placeholder="按名称 / 路径 / hash 过滤"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => { stickers.reload(); quota.reload(); }}>刷新</button>
          </div>
        </header>
        <div className="panel-body flush">
          {stickers.error && !stickers.error.unimplemented && !stickers.data ? (
            <div className="panel-pad"><ErrorNote error={stickers.error} onRetry={stickers.reload} /></div>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(sticker) => sticker.id}
              loading={stickers.loading}
              empty={(
                <EmptyState
                  title={filter || emotion ? '没有匹配的表情包' : '表情包库还是空的'}
                  description={filter || emotion ? '换个筛选条件试试。' : '入站表情会自动收藏（可配置），也可以手动登记已有文件。'}
                  action={filter || emotion
                    ? <button type="button" className="btn btn-sm" onClick={() => { setFilter(''); setEmotion(''); }}>清空筛选</button>
                    : <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>登记表情包</button>}
                />
              )}
            />
          )}
        </div>
      </section>

      <Drawer
        open={createOpen}
        title="登记表情包"
        subtitle="登记已有文件；hash 相同时返回已有记录，不会重复收藏"
        onClose={() => { if (!saving) setCreateOpen(false); }}
        footer={(
          <>
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => setCreateOpen(false)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void submitCreate()}>
              {saving ? '保存中…' : '登记'}
            </button>
          </>
        )}
      >
        <div className="form-stack">
          <Field label="名称" htmlFor="sticker-name" required>
            <input
              id="sticker-name"
              className="input"
              value={form.name}
              placeholder="例如：点赞 / 猫猫疑问"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="文件路径" htmlFor="sticker-file" required help="相对 bot 工作目录或绝对路径；store 不重定位，删除时会删这个路径。">
            <input
              id="sticker-file"
              className="input mono"
              value={form.file}
              placeholder="media/stickers/thumb-up.png"
              onChange={(event) => setForm({ ...form, file: event.target.value })}
            />
          </Field>
          <div className="form-row">
            <Field label="emotion" htmlFor="sticker-emotion" help="可留空；常用：开心/疑惑/点赞/无语。">
              <input
                id="sticker-emotion"
                className="input"
                value={form.emotion}
                onChange={(event) => setForm({ ...form, emotion: event.target.value })}
              />
            </Field>
            <Field label="hash" htmlFor="sticker-hash" help="可留空；填写可用于去重。">
              <input
                id="sticker-hash"
                className="input mono"
                value={form.hash}
                onChange={(event) => setForm({ ...form, hash: event.target.value })}
              />
            </Field>
          </div>
          {formError ? <p className="field-error" role="alert">{formError}</p> : null}
        </div>
      </Drawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除表情包"
        message={(
          <span>
            删除 <strong>{deleteTarget?.name}</strong> 及其记录？会尝试删除文件{' '}
            <code className="inline-code mono">{truncate(deleteTarget?.file, 60)}</code>，不可撤销。
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
