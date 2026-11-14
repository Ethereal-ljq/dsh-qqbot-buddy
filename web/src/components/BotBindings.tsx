/**
 * components/BotBindings —— 机器人详情里的「配置档绑定」。
 *
 * 绑定是机器人级数据（bindings 表），不是配置档内容，所以放在机器人页：
 *   scope → profile，匹配精度 精确 > 类型通配 > bot 通配 > 默认配置档。
 * 数据来源：state 快照里的 bindings/profiles（父级已按 bot 过滤），写操作后由父级
 * 调 reloadState() 刷新，避免本组件自己再拉一遍。
 */
import { useMemo, useState } from 'react';

import { api, toApiError } from '../api/client';
import type { Binding, Profile } from '../api/types';
import { ConfirmDialog } from './ConfirmDialog';
import { Field } from './Field';
import { Badge } from './Status';

/** 作用域预设：填进 datalist，允许自由输入。 */
const SCOPE_PRESETS = ['qq:group:123456', 'qq:group:*', 'qq:c2c:*', 'qq:*', '*'];

interface BindingForm {
  mode: 'create' | 'edit';
  id?: number;
  scope: string;
  profileId: string;
  priority: number;
}

export function BotBindings({ botId, profiles, bindings, activeProfileId, onChanged }: {
  botId: string;
  profiles: Profile[];
  bindings: Binding[];
  activeProfileId?: string;
  onChanged: () => Promise<void> | void;
}) {
  const [form, setForm] = useState<BindingForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Binding | null>(null);
  const [deleting, setDeleting] = useState(false);

  const profileName = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.name])),
    [profiles],
  );

  const openCreate = () => {
    setError(null);
    setForm({
      mode: 'create',
      scope: '',
      profileId: activeProfileId || profiles.find((profile) => profile.isDefault)?.id || profiles[0]?.id || '',
      priority: 0,
    });
  };

  const openEdit = (binding: Binding) => {
    setError(null);
    setForm({ mode: 'edit', id: binding.id, scope: binding.scope, profileId: binding.profileId, priority: binding.priority });
  };

  const save = async () => {
    if (!form) return;
    const scope = form.scope.trim();
    if (scope === '') { setError('作用域不能为空，例如 qq:group:* 或 *。'); return; }
    if (form.profileId === '') { setError('请选择要绑定的配置档。'); return; }
    const priority = Number(form.priority) || 0;
    setSaving(true);
    setError(null);
    try {
      if (form.mode === 'edit' && form.id !== undefined) {
        await api.updateBinding(form.id, { scope, profileId: form.profileId, priority });
      } else {
        await api.upsertBinding({ botId, scope, profileId: form.profileId, priority });
      }
      setForm(null);
      await onChanged();
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteBinding(deleteTarget.id);
      setDeleteTarget(null);
      await onChanged();
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="detail-section">
      <div className="section-head-row">
        <h3 className="subsection-title">配置档绑定</h3>
        <button type="button" className="btn btn-sm btn-ghost" onClick={openCreate} disabled={profiles.length === 0}>
          新增绑定
        </button>
      </div>
      <p className="field-help">
        作用域决定哪个群 / 私聊用哪份配置：精确 <code className="inline-code mono">qq:group:123456</code>
        &gt; 类型通配 <code className="inline-code mono">qq:group:*</code>
        &gt; bot 通配 <code className="inline-code mono">*</code> &gt; 默认配置档。
      </p>

      {bindings.length === 0 ? (
        <p className="muted binding-empty">还没有绑定：所有会话都使用默认配置档。</p>
      ) : (
        <ul className="binding-list">
          {bindings.map((binding) => (
            <li className="binding-row" key={binding.id}>
              <div className="binding-main">
                <span className="binding-scope mono">{binding.scope}</span>
                <span className="binding-profile">
                  {binding.profileName || profileName.get(binding.profileId) || binding.profileId}
                  {binding.profileId === activeProfileId ? <Badge tone="info">默认</Badge> : null}
                </span>
              </div>
              <div className="binding-meta">
                <span className="binding-priority mono" title="同精度下 priority 越大越优先">P{binding.priority}</span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => openEdit(binding)}>编辑</button>
                <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setDeleteTarget(binding)}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {form ? (
        <div className="binding-form">
          <div className="form-row">
            <Field label="作用域" htmlFor="binding-scope" required help="支持精确群号、* 通配与 qq:group:* 等写法。">
              <input
                id="binding-scope"
                className="input mono"
                list="binding-scope-presets"
                value={form.scope}
                placeholder="qq:group:123456"
                onChange={(event) => setForm({ ...form, scope: event.target.value })}
              />
              <datalist id="binding-scope-presets">
                {SCOPE_PRESETS.map((preset) => <option key={preset} value={preset} />)}
              </datalist>
            </Field>
            <Field label="配置档" htmlFor="binding-profile" required>
              <select
                id="binding-profile"
                className="input"
                value={form.profileId}
                onChange={(event) => setForm({ ...form, profileId: event.target.value })}
              >
                <option value="">（选择配置档）</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}{profile.isDefault ? ' · 默认' : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="优先级" htmlFor="binding-priority" help="同精度下数字越大越优先；一般保持 0 即可。">
            <input
              id="binding-priority"
              className="input mono"
              type="number"
              value={form.priority}
              onChange={(event) => setForm({ ...form, priority: Number(event.target.value) })}
            />
          </Field>
          {error ? <p className="field-error" role="alert">{error}</p> : null}
          <div className="row-actions">
            <button type="button" className="btn btn-sm" onClick={() => { setForm(null); setError(null); }} disabled={saving}>取消</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : form.mode === 'edit' ? '保存绑定' : '新增绑定'}
            </button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除绑定"
        message={<span>将删除作用域 <strong className="mono">{deleteTarget?.scope}</strong> 的绑定；该作用域会回落到默认配置档。</span>}
        confirmLabel="删除"
        busy={deleting}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
