/**
 * pages/SettingsPage —— 设置：完全由 GET /api/schema 的 UI 元数据渲染。
 *
 * 不手写字段清单：新增设置只改 lib/core/config/schema.js。
 * 保存时只提交被修改的 key，服务端按每项的 scope 自动分流到 global / bot / profile 层。
 */
import { useEffect, useMemo, useState } from 'react';

import { api, toApiError } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { PageHeader } from '../components/PageHeader';
import { SchemaForm } from '../components/SchemaForm';
import { Badge } from '../components/Status';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';
import { useApi } from '../state/useApi';

export function SettingsPage() {
  const { botId, bots, bot, notify, reloadState } = useApp();
  const schema = useApi((signal) => api.schema(signal), []);
  const settings = useApi((signal) => api.settings(botId || undefined, signal), [botId]);
  const [dirty, setDirty] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDirty({});
  }, [botId, settings.data?.botId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirtyCount = Object.keys(dirty).length;
  const schemaReady = (schema.data?.items.length ?? 0) > 0;

  const sectionSummary = useMemo(() => {
    const items = schema.data?.items ?? [];
    const counts: Record<string, number> = { global: 0, bot: 0, profile: 0 };
    for (const item of items) {
      if (item.scope === 'global') counts.global += 1;
      else if (item.scope === 'bot') counts.bot += 1;
      else counts.profile += 1;
    }
    return counts;
  }, [schema.data]);

  const save = async () => {
    if (dirtyCount === 0) return;
    setSaving(true);
    try {
      await api.saveSettings(botId || undefined, dirty);
      notify('ok', '已保存 ' + dirtyCount + ' 项设置');
      setDirty({});
      settings.reload();
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      if (error.unimplemented) notify('info', '设置写入接口尚未装配', error.code);
      else notify('error', '保存失败：' + error.message, error.code);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="设置"
        description="表单由 /api/schema 生成，按层覆盖：默认值 → 全局 → 机器人 → 配置档。保存时每一项写入它所属的层。"
        meta={(
          <span className="cell-inline">
            {botId ? <Badge tone="info">机器人 · {bot?.name || botId}</Badge> : <Badge tone="warn">全局视角</Badge>}
            <span className="muted mono">
              全局 {sectionSummary.global} · 机器人 {sectionSummary.bot} · 配置档 {sectionSummary.profile}
            </span>
          </span>
        )}
        actions={(
          <div className="row-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={dirtyCount === 0 || saving}
              onClick={() => setDirty({})}
            >
              放弃修改
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={dirtyCount === 0 || saving}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : dirtyCount > 0 ? '保存 ' + dirtyCount + ' 项' : '已保存'}
            </button>
          </div>
        )}
      />

      <div className="hierarchy-banner">
        <div className="hierarchy-main">
          <div className="hierarchy-title-row">
            <span className="hierarchy-title">层级优先级</span>
            <div className="hierarchy-levels" aria-label="配置层级从高到低">
              <span className="hierarchy-level profile"><span className="mono">profile</span><span className="hierarchy-level-desc">绑定 / 默认档</span></span>
              <span className="hierarchy-arrow" aria-hidden="true">›</span>
              <span className="hierarchy-level bot"><span className="mono">bot</span><span className="hierarchy-level-desc">机器人</span></span>
              <span className="hierarchy-arrow" aria-hidden="true">›</span>
              <span className="hierarchy-level global"><span className="mono">global</span><span className="hierarchy-level-desc">全局</span></span>
              <span className="hierarchy-priority">从高到低</span>
            </div>
          </div>
          <p className="hierarchy-note">
            profile 级设置建议在「配置档」页统一编辑（与绑定/默认档联动）；本页修改会按每项 scope 自动分流到 global / bot / 默认 profile，功能保留，仅提示层级关系。
          </p>
        </div>
        <div className="hierarchy-actions">
          <button type="button" className="btn btn-sm" onClick={() => navigate('/profiles')}>去配置档页编辑</button>
          {!botId ? <button type="button" className="link-btn" onClick={() => navigate('/bots')}>选择机器人</button> : null}
        </div>
      </div>

      {schema.loading ? (
        <section className="panel"><div className="panel-pad"><span className="skeleton skeleton-block" /></div></section>
      ) : schema.error ? (
        <section className="panel"><div className="panel-pad"><ErrorNote error={schema.error} onRetry={schema.reload} /></div></section>
      ) : !schemaReady ? (
        <section className="panel"><div className="panel-pad">
          <EmptyState
            tone="pending"
            title="设置 schema 尚未装配"
            description="core/config/schema.js 的 schemaPayload() 会提供字段元数据；装配后本页自动出现全部设置项，无需改前端。"
            endpoint="GET /api/schema"
          />
        </div></section>
      ) : (
        <>
          {settings.error && !settings.data ? (
            <section className="panel"><div className="panel-pad"><ErrorNote error={settings.error} onRetry={settings.reload} /></div></section>
          ) : (
            <section className="panel">
              <div className="panel-body">
                <SchemaForm
                  payload={schema.data!}
                  values={settings.data?.values ?? {}}
                  dirty={dirty}
                  scopes={botId ? undefined : ['global']}
                  showScope
                  onChange={(key, value) => setDirty((prev) => ({ ...prev, [key]: value }))}
                />
              </div>
              <footer className="panel-foot save-bar">
                <span className={'save-hint' + (dirtyCount > 0 ? ' dirty' : '')}>
                  {dirtyCount > 0 ? dirtyCount + ' 项未保存' : '所有设置已保存'}
                </span>
                <div className="row-actions">
                  <button type="button" className="btn btn-ghost btn-sm" disabled={dirtyCount === 0 || saving} onClick={() => setDirty({})}>
                    放弃修改
                  </button>
                  <button type="button" className="btn btn-primary btn-sm" disabled={dirtyCount === 0 || saving} onClick={() => void save()}>
                    {saving ? '保存中…' : '保存设置'}
                  </button>
                </div>
              </footer>
            </section>
          )}

          <p className="page-foot mono">
            数据来源 GET /api/schema · {schema.data?.sections.length ?? 0} 个分节 · {schema.data?.items.length ?? 0} 个设置项
            {bots.length === 0 ? ' · 当前没有机器人，只能编辑全局层' : ''}
          </p>
        </>
      )}
    </div>
  );
}
