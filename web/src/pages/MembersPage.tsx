/**
 * pages/MembersPage —— 群友库：openid、昵称、人工备注与画像 JSON（按 bot 共享）。
 *
 * 数据源：GET /api/members?bot=、POST /api/members、PATCH/DELETE /api/members/:id?bot=。
 * 服务端按 (botId, openid) upsert，空值不会冲掉已有昵称/备注；profileJson 是对象浅合并，null 清空。
 */
import { useMemo, useState } from 'react';

import { api, toApiError } from '../api/client';
import type { Member } from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CopyButton } from '../components/CopyButton';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { Field } from '../components/Field';
import { PageHeader } from '../components/PageHeader';
import { fmtTimeSmart, prettyJson } from '../lib/format';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';
import { useApi } from '../state/useApi';

interface MemberForm {
  openid: string;
  nickname: string;
  note: string;
  profileText: string;
}

const EMPTY_FORM: MemberForm = { openid: '', nickname: '', note: '', profileText: '' };

export function MembersPage() {
  const { botId, bots, bot, notify } = useApp();
  const members = useApi((signal) => (botId ? api.listMembers(botId, {}, signal) : Promise.resolve([])), [botId]);
  const [filter, setFilter] = useState('');
  const [drawer, setDrawer] = useState<{ mode: 'create' | 'edit'; member: Member | null } | null>(null);
  const [form, setForm] = useState<MemberForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Member | null>(null);
  const [deleting, setDeleting] = useState(false);

  const rows = useMemo(() => {
    const items = members.data ?? [];
    const keyword = filter.trim().toLowerCase();
    if (keyword === '') return items;
    return items.filter((member) =>
      [member.nickname || '', member.openid, member.note || '', prettyJson(member.profileJson ?? {})]
        .some((field) => field.toLowerCase().includes(keyword)),
    );
  }, [members.data, filter]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDrawer({ mode: 'create', member: null });
  };

  const openEdit = (member: Member) => {
    setForm({
      openid: member.openid,
      nickname: member.nickname || '',
      note: member.note || '',
      profileText: member.profileJson ? prettyJson(member.profileJson) : '',
    });
    setFormError(null);
    setDrawer({ mode: 'edit', member });
  };

  const parseProfile = (): { ok: true; value: unknown } | { ok: false; error: string } => {
    const text = form.profileText.trim();
    if (text === '') return { ok: true, value: undefined };
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null) return { ok: true, value: null };
      if (typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: '画像必须是 JSON 对象（或留空）。' };
      return { ok: true, value: parsed };
    } catch (err) {
      return { ok: false, error: '画像 JSON 不合法：' + (err instanceof Error ? err.message : String(err)) };
    }
  };

  const save = async () => {
    if (drawer?.mode === 'create' && form.openid.trim() === '') {
      setFormError('openid 不能为空。');
      return;
    }
    const profile = parseProfile();
    if (profile.ok === false) {
      setFormError(profile.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (drawer?.mode === 'edit' && drawer.member) {
        await api.updateMember(drawer.member.id, botId, {
          nickname: form.nickname.trim(),
          note: form.note.trim(),
          ...(profile.value === undefined ? {} : { profileJson: profile.value }),
        });
        notify('ok', '已保存群友：' + (form.nickname.trim() || form.openid.trim()));
      } else {
        await api.saveMember({
          botId,
          openid: form.openid.trim(),
          nickname: form.nickname.trim(),
          note: form.note.trim(),
          ...(profile.value === undefined ? {} : { profileJson: profile.value }),
        });
        notify('ok', '已登记群友：' + (form.nickname.trim() || form.openid.trim()));
      }
      setDrawer(null);
      members.reload();
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
      await api.deleteMember(deleteTarget.id, botId);
      notify('ok', '已删除群友：' + (deleteTarget.nickname || deleteTarget.openid));
      setDeleteTarget(null);
      members.reload();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '删除失败：' + error.message, error.code);
    } finally {
      setDeleting(false);
    }
  };

  const columns: Array<Column<Member>> = [
    {
      key: 'member',
      title: '群友',
      render: (member) => (
        <div className="cell-stack">
          <span className="cell-title">{member.nickname || '（未命名）'}</span>
          <CopyButton text={member.openid} label="复制 openid" />
        </div>
      ),
    },
    {
      key: 'note',
      title: '人工备注',
      render: (member) => (
        <span className="memory-text" title={member.note || ''}>{member.note || '—'}</span>
      ),
    },
    {
      key: 'profile',
      title: '画像',
      width: '240px',
      render: (member) => {
        const profile = member.profileJson;
        if (!profile || (typeof profile === 'object' && Object.keys(profile as Record<string, unknown>).length === 0)) {
          return <span className="muted">—</span>;
        }
        const keys = typeof profile === 'object' ? Object.keys(profile as Record<string, unknown>) : [];
        return (
          <span className="mono cell-sub ellipsis" title={prettyJson(profile)}>
            {'{ ' + keys.join(', ') + ' }'}
          </span>
        );
      },
    },
    {
      key: 'updatedAt',
      title: '更新时间',
      width: '136px',
      render: (member) => <span className="mono cell-sub">{fmtTimeSmart(member.updatedAt)}</span>,
    },
    {
      key: 'actions',
      title: '',
      width: '132px',
      align: 'right',
      render: (member) => (
        <div className="row-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => openEdit(member)}>编辑</button>
          <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setDeleteTarget(member)}>删除</button>
        </div>
      ),
    },
  ];

  if (bots.length === 0) {
    return (
      <div className="page">
        <PageHeader title="群友库" description="群友库按机器人共享；先创建机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState
            title="还没有机器人"
            description="群友档案挂在 bot 下，与配置档无关。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去创建机器人</button>}
          />
        </div></section>
      </div>
    );
  }

  if (!botId) {
    return (
      <div className="page">
        <PageHeader title="群友库" description="先选择作用域机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState title="未选择机器人" description="顶栏选择机器人后即可管理该 bot 的群友库。" />
        </div></section>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="群友库"
        description={'当前机器人：' + (bot?.name || botId) + '。按 openid 去重；昵称/备注/画像由对话提炼或人工维护。'}
        actions={<button type="button" className="btn btn-primary" onClick={openCreate}>登记群友</button>}
      />

      <div className="hint-strip">
        <span className="hint-label">隐私</span>
        <span className="hint-text">群友库按 bot 隔离，仅用于注入 prompt 变量；删除会从库中移除，不影响 QQ 侧数据。</span>
      </div>

      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">全部群友</h2>
            <p className="panel-desc">共 {members.data?.length ?? 0} 人；服务端按 (botId, openid) upsert，空值不覆盖已有资料。</p>
          </div>
          <div className="panel-tools">
            <label className="toolbar-search">
              <span className="search-icon" aria-hidden="true">⌕</span>
              <input
                className="input search-input"
                data-search-input
                placeholder="按昵称 / openid / 备注过滤"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <button type="button" className="btn btn-sm btn-ghost" onClick={members.reload}>刷新</button>
          </div>
        </header>
        <div className="panel-body flush">
          {members.error && !members.error.unimplemented && !members.data ? (
            <div className="panel-pad"><ErrorNote error={members.error} onRetry={members.reload} /></div>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(member) => member.id}
              loading={members.loading}
              skeletonRows={5}
              empty={(
                <EmptyState
                  title={filter ? '没有匹配的群友' : '群友库还是空的'}
                  description={filter ? '换个关键词试试。' : '群友的 openid 会在收消息时自动入库；也可以手动登记。'}
                  action={filter
                    ? <button type="button" className="btn btn-sm" onClick={() => setFilter('')}>清空过滤</button>
                    : <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>登记群友</button>}
                />
              )}
            />
          )}
        </div>
      </section>

      <Drawer
        open={drawer !== null}
        title={drawer?.mode === 'edit' ? '编辑群友' : '登记群友'}
        subtitle={drawer?.mode === 'edit' ? drawer.member?.openid : 'openid 是唯一键；再次登记相同 openid 会合并资料'}
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
          <Field label="openid" htmlFor="member-openid" required help="QQ 机器人的用户 openid，形如 ABCD…；不可修改。">
            <input
              id="member-openid"
              className="input mono"
              value={form.openid}
              disabled={drawer?.mode === 'edit'}
              placeholder="用户 openid"
              onChange={(event) => setForm({ ...form, openid: event.target.value })}
            />
          </Field>
          <div className="form-row">
            <Field label="昵称" htmlFor="member-nickname">
              <input
                id="member-nickname"
                className="input"
                value={form.nickname}
                onChange={(event) => setForm({ ...form, nickname: event.target.value })}
              />
            </Field>
            <Field label="人工备注" htmlFor="member-note">
              <input
                id="member-note"
                className="input"
                value={form.note}
                placeholder="例如：群主 / 常客 / 请勿打扰"
                onChange={(event) => setForm({ ...form, note: event.target.value })}
              />
            </Field>
          </div>
          <Field
            label="画像 JSON"
            htmlFor="member-profile"
            wide
            help='对象浅合并，例如 {"tags":["admin"],"style":"简短"}；留空表示不修改，填 null 清空。'
          >
            <textarea
              id="member-profile"
              className="input textarea mono json-area"
              rows={6}
              value={form.profileText}
              spellCheck={false}
              placeholder='{"tags": ["admin"], "style": "简短"}'
              onChange={(event) => setForm({ ...form, profileText: event.target.value })}
            />
          </Field>
          {formError ? <p className="field-error" role="alert">{formError}</p> : null}
        </div>
      </Drawer>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除群友"
        message={<span>从群友库删除 <strong>{deleteTarget?.nickname || deleteTarget?.openid}</strong>？该操作不可撤销。</span>}
        confirmLabel="删除"
        busy={deleting}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
