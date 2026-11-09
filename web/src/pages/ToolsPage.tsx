/**
 * pages/ToolsPage —— 工具与技能：发现清单 + Profile 级白名单策略。
 *
 * 数据源：GET /api/tools?profile= / GET /api/skills?profile=；
 * 保存：PUT /api/tools/policy、PUT /api/skills/policy（策略落在 Profile）。
 * 未装配时后端返回 501，页面展示“能力待接入”空态而不是报错。
 */
import { useEffect, useMemo, useState } from 'react';

import { api, toApiError } from '../api/client';
import type { SkillPolicy, SkillsPayload, ToolPolicy, ToolsPayload } from '../api/types';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { PageHeader } from '../components/PageHeader';
import { Badge, SourceTag, StatusDot } from '../components/Status';
import { Tabs } from '../components/Tabs';
import { cloneValue } from '../lib/objects';
import { truncate } from '../lib/format';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';
import { useApi } from '../state/useApi';
import type { SkillItem, ToolItem } from '../api/types';

type TabId = 'tools' | 'skills';

export function ToolsPage() {
  const { botId, bots, profiles, activeProfile, reloadState, notify } = useApp();
  const [tab, setTab] = useState<TabId>('tools');
  const [profileId, setProfileId] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (profiles.length === 0) {
      if (profileId !== '') setProfileId('');
      return;
    }
    if (profileId && profiles.some((profile) => profile.id === profileId)) return;
    setProfileId(activeProfile?.id ?? profiles[0].id);
  }, [profiles, profileId, activeProfile]);

  const tools = useApi<ToolsPayload | null>(
    (signal) => (profileId ? api.tools(profileId, signal) : Promise.resolve(null)),
    [profileId],
  );
  const skills = useApi<SkillsPayload | null>(
    (signal) => (profileId ? api.skills(profileId, signal) : Promise.resolve(null)),
    [profileId],
  );

  const [toolsDraft, setToolsDraft] = useState<ToolPolicy | null>(null);
  const [skillsDraft, setSkillsDraft] = useState<SkillPolicy | null>(null);
  const [savingTools, setSavingTools] = useState(false);
  const [savingSkills, setSavingSkills] = useState(false);

  const toolsKey = tools.data ? JSON.stringify(tools.data.policy) : '';
  const skillsKey = skills.data ? JSON.stringify(skills.data.policy) : '';

  useEffect(() => {
    if (tools.data) setToolsDraft(cloneValue(tools.data.policy));
  }, [toolsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (skills.data) setSkillsDraft(cloneValue(skills.data.policy));
  }, [skillsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toolsDirty = Boolean(toolsDraft && tools.data && JSON.stringify(toolsDraft) !== JSON.stringify(tools.data.policy));
  const skillsDirty = Boolean(skillsDraft && skills.data && JSON.stringify(skillsDraft) !== JSON.stringify(skills.data.policy));

  const keyword = filter.trim().toLowerCase();
  const toolRows = useMemo(() => {
    const items = tools.data?.items ?? [];
    if (keyword === '') return items;
    return items.filter((item) =>
      [item.name, item.source || '', item.description || ''].some((field) => field.toLowerCase().includes(keyword)),
    );
  }, [tools.data, keyword]);

  const visibleNames = useMemo(() => {
    if (tools.data?.visible && tools.data.visible.length > 0) return new Set(tools.data.visible);
    return null;
  }, [tools.data]);

  const toggleTool = (name: string, list: 'allow' | 'deny') => {
    setToolsDraft((prev) => {
      if (!prev) return prev;
      const current = new Set(prev[list]);
      if (current.has(name)) current.delete(name);
      else current.add(name);
      return { ...prev, [list]: [...current] };
    });
  };

  const bulkTools = (action: 'allow-all' | 'clear') => {
    setToolsDraft((prev) => {
      if (!prev || !tools.data) return prev;
      if (action === 'clear') return { ...prev, allow: [], deny: [] };
      const names = tools.data.items.filter((item) => item.restrictable !== false).map((item) => item.name);
      return prev.mode === 'allow'
        ? { ...prev, allow: names }
        : { ...prev, deny: [] };
    });
  };

  const saveTools = async () => {
    if (!profileId || !toolsDraft) return;
    setSavingTools(true);
    try {
      await api.saveToolsPolicy(profileId, toolsDraft);
      notify('ok', '工具策略已保存');
      await reloadState();
      tools.reload();
    } catch (err) {
      const error = toApiError(err);
      notify(error.unimplemented ? 'info' : 'error', error.unimplemented ? '工具策略接口尚未装配' : '保存失败：' + error.message, error.code);
    } finally {
      setSavingTools(false);
    }
  };

  const toggleSkill = (name: string) => {
    setSkillsDraft((prev) => {
      if (!prev) return prev;
      const current = new Set(prev.allow);
      if (current.has(name)) current.delete(name);
      else current.add(name);
      return { ...prev, allow: [...current] };
    });
  };

  const saveSkills = async () => {
    if (!profileId || !skillsDraft) return;
    setSavingSkills(true);
    try {
      await api.saveSkillsPolicy(profileId, skillsDraft);
      notify('ok', '技能策略已保存');
      await reloadState();
      skills.reload();
    } catch (err) {
      const error = toApiError(err);
      notify(error.unimplemented ? 'info' : 'error', error.unimplemented ? '技能策略接口尚未装配' : '保存失败：' + error.message, error.code);
    } finally {
      setSavingSkills(false);
    }
  };

  const toolColumns: Array<Column<ToolItem>> = [
    {
      key: 'name',
      title: '工具',
      render: (item) => (
        <div className="cell-stack">
          <span className="mono cell-title">{item.name}</span>
          {item.description ? <span className="cell-sub ellipsis" title={item.description}>{truncate(item.description, 110)}</span> : null}
        </div>
      ),
    },
    {
      key: 'source',
      title: '来源',
      width: '96px',
      render: (item) => <SourceTag source={item.source} />,
    },
    {
      key: 'restrictable',
      title: '可限制',
      width: '88px',
      render: (item) => (item.restrictable === false ? <Badge tone="warn">否</Badge> : <span className="muted">是</span>),
    },
    {
      key: 'visible',
      title: '当前可见',
      width: '104px',
      render: (item) => {
        const visible = visibleNames
          ? visibleNames.has(item.name)
          : item.visible ?? item.enabled ?? null;
        if (visible === null) return <span className="muted">—</span>;
        return (
          <span className="cell-inline">
            <StatusDot tone={visible ? 'ok' : 'idle'} />
            {visible ? '可见' : '不可见'}
          </span>
        );
      },
    },
    {
      key: 'policy',
      title: toolsDraft?.mode === 'deny' ? '屏蔽' : '放行',
      width: '88px',
      align: 'center',
      render: (item) => {
        const list = toolsDraft?.mode === 'deny' ? 'deny' : 'allow';
        const checked = toolsDraft ? toolsDraft[list].includes(item.name) : false;
        const disabled = !toolsDraft || item.restrictable === false;
        return (
          <label className={'check' + (disabled ? ' disabled' : '')} title={disabled ? '该工具不可限制' : undefined}>
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => toggleTool(item.name, list)}
              aria-label={(list === 'deny' ? '屏蔽 ' : '放行 ') + item.name}
            />
            <span className="check-box" aria-hidden="true" />
          </label>
        );
      },
    },
  ];

  const skillColumns: Array<Column<SkillItem>> = [
    {
      key: 'name',
      title: '技能',
      render: (item) => (
        <div className="cell-stack">
          <span className="mono cell-title">{item.name}</span>
          {item.description ? <span className="cell-sub ellipsis" title={item.description}>{truncate(item.description, 120)}</span> : null}
        </div>
      ),
    },
    {
      key: 'source',
      title: '来源',
      width: '96px',
      render: (item) => <SourceTag source={item.source || 'skill'} />,
    },
    {
      key: 'allow',
      title: '允许',
      width: '88px',
      align: 'center',
      render: (item) => {
        if (skillsDraft?.mode !== 'allow') return <span className="muted">全部</span>;
        const checked = skillsDraft?.allow.includes(item.name) ?? false;
        return (
          <label className="check">
            <input
              type="checkbox"
              checked={checked}
              disabled={!skillsDraft}
              onChange={() => toggleSkill(item.name)}
              aria-label={'允许技能 ' + item.name}
            />
            <span className="check-box" aria-hidden="true" />
          </label>
        );
      },
    },
  ];

  const toolsBody = () => {
    if (tools.loading && !tools.data) {
      return <div className="panel-pad"><span className="skeleton skeleton-block" /></div>;
    }
    if (tools.error?.unimplemented) {
      return (
        <div className="panel-pad">
          <EmptyState
            tone="pending"
            title="工具发现尚未装配"
            description="宿主工具发现与控制台装配完成后，这里会列出全部工具、来源与当前可见性。"
            endpoint="GET /api/tools?profile=…"
          />
        </div>
      );
    }
    if (tools.error) {
      return <div className="panel-pad"><ErrorNote error={tools.error} onRetry={tools.reload} /></div>;
    }
    if (!toolsDraft || !tools.data) {
      return <div className="panel-pad"><span className="skeleton skeleton-block" /></div>;
    }
    return (
      <DataTable
        columns={toolColumns}
        rows={toolRows}
        rowKey={(item) => item.name}
        loading={tools.loading}
        empty={(
          <EmptyState
            compact
            tone="pending"
            title={keyword ? '没有匹配的工具' : '宿主尚未装配工具发现服务'}
            description={keyword
              ? '换个关键词试试。'
              : '当前可能是开发模式（deps.toolsDiscover 未装配）或宿主还没注册工具；装配后这里会列出全部工具、来源与可见性。'}
            endpoint="GET /api/tools?profile=…"
          />
        )}
        footer={(
          <div className="table-foot-inner">
            <span className="muted">
              策略：{toolsDraft.mode === 'allow' ? '白名单（只允许列表内）' : '黑名单（只屏蔽列表内）'}
              {' · '}放行 {toolsDraft.allow.length} · 屏蔽 {toolsDraft.deny.length}
              {' · '}额外 {toolsDraft.extra.length}
            </span>
            {tools.data.visible?.length ? (
              <span className="muted">宿主报告可见 {tools.data.visible.length} 项</span>
            ) : null}
          </div>
        )}
      />
    );
  };

  if (bots.length === 0) {
    return (
      <div className="page">
        <PageHeader title="工具与技能" description="工具策略按配置档保存；先创建机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState
            title="还没有机器人"
            description="工具与技能白名单挂在配置档上，配置档属于机器人。"
            action={<button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/bots')}>去创建机器人</button>}
          />
        </div></section>
      </div>
    );
  }

  if (!botId) {
    return (
      <div className="page">
        <PageHeader title="工具与技能" description="先选择作用域机器人。" />
        <section className="panel"><div className="panel-pad">
          <EmptyState title="未选择机器人" description="顶栏选择机器人后即可查看该 bot 配置档的工具策略。" />
        </div></section>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="工具与技能"
        description="从宿主发现全部工具与技能，按配置档控制 QQ 会话里能看到什么。默认拒绝：新装插件不会自动进入会话。"
        actions={(
          <label className="toolbar-field">
            <span className="toolbar-label">策略作用域</span>
            <select className="input select-compact" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}{profile.isDefault ? '（默认）' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      />

      <Tabs
        items={[
          { id: 'tools', label: '工具', count: tools.data?.items.length },
          { id: 'skills', label: '技能', count: skills.data?.items.length },
        ]}
        value={tab}
        onChange={(id) => setTab(id as TabId)}
      />

      {tab === 'tools' ? (
        <section className="panel">
          <header className="panel-head">
            <div>
              <h2 className="panel-title">工具白名单</h2>
              <p className="panel-desc">
                白名单模式下未勾选工具对 QQ 会话不可见；黑名单模式只屏蔽勾选项。工具可见性最终由 agent scope 的
                restrict 执行。
              </p>
            </div>
            <div className="panel-tools">
              <div className="segmented">
                <button
                  type="button"
                  className={'seg-btn' + (toolsDraft?.mode === 'allow' ? ' active' : '')}
                  disabled={!toolsDraft}
                  onClick={() => setToolsDraft((prev) => (prev ? { ...prev, mode: 'allow' } : prev))}
                >
                  白名单
                </button>
                <button
                  type="button"
                  className={'seg-btn' + (toolsDraft?.mode === 'deny' ? ' active' : '')}
                  disabled={!toolsDraft}
                  onClick={() => setToolsDraft((prev) => (prev ? { ...prev, mode: 'deny' } : prev))}
                >
                  黑名单
                </button>
              </div>
              <span className="toolbar-divider" aria-hidden="true" />
              <button type="button" className="btn btn-sm btn-ghost" disabled={!toolsDraft} onClick={() => bulkTools('allow-all')}>
                {toolsDraft?.mode === 'deny' ? '清空屏蔽' : '全部放行'}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={!toolsDraft} onClick={() => bulkTools('clear')}>清空列表</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={!toolsDirty || savingTools} onClick={() => void saveTools()}>
                {savingTools ? '保存中…' : toolsDirty ? '保存策略' : '已保存'}
              </button>
            </div>
          </header>
          <div className="panel-body flush">
            <div className="panel-tools-row">
              <label className="toolbar-search">
                <span className="search-icon" aria-hidden="true">⌕</span>
                <input
                  className="input search-input"
                  data-search-input
                  placeholder="按名称 / 来源 / 说明过滤"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              {toolsDirty ? <span className="dirty-flag">未保存</span> : null}
            </div>
            {toolsBody()}
          </div>
          {tools.data?.note ? <p className="panel-note">{tools.data.note}</p> : null}
        </section>
      ) : (
        <section className="panel">
          <header className="panel-head">
            <div>
              <h2 className="panel-title">技能白名单</h2>
              <p className="panel-desc">技能按 Profile 过滤；全部可见模式下不限制宿主注册的技能。</p>
            </div>
            <div className="panel-tools">
              <div className="segmented">
                <button
                  type="button"
                  className={'seg-btn' + (skillsDraft?.mode === 'all' ? ' active' : '')}
                  disabled={!skillsDraft}
                  onClick={() => setSkillsDraft((prev) => (prev ? { ...prev, mode: 'all' } : prev))}
                >
                  全部可见
                </button>
                <button
                  type="button"
                  className={'seg-btn' + (skillsDraft?.mode === 'allow' ? ' active' : '')}
                  disabled={!skillsDraft}
                  onClick={() => setSkillsDraft((prev) => (prev ? { ...prev, mode: 'allow' } : prev))}
                >
                  仅白名单
                </button>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!skillsDirty || savingSkills}
                onClick={() => void saveSkills()}
              >
                {savingSkills ? '保存中…' : skillsDirty ? '保存策略' : '已保存'}
              </button>
            </div>
          </header>
          <div className="panel-body flush">
            {skills.error?.unimplemented ? (
              <div className="panel-pad">
                <EmptyState
                  tone="pending"
                  title="技能清单尚未装配"
                  description="技能 provider 接入后，这里会列出宿主的技能注册表并支持白名单。"
                  endpoint="GET /api/skills?profile=…"
                />
              </div>
            ) : skills.error ? (
              <div className="panel-pad"><ErrorNote error={skills.error} onRetry={skills.reload} /></div>
            ) : (
              <DataTable
                columns={skillColumns}
                rows={skills.data?.items ?? []}
                rowKey={(item) => item.name}
                loading={skills.loading}
                empty={<EmptyState compact title="没有技能" description="宿主注册技能后会出现。skills.registerProvider 只暴露白名单内技能。" />}
                footer={(
                  <div className="table-foot-inner">
                    <span className="muted">策略：{skillsDraft?.mode === 'all' ? '全部可见' : '仅白名单'} · 允许 {skillsDraft?.allow.length ?? 0} 个</span>
                  </div>
                )}
              />
            )}
          </div>
        </section>
      )}
    </div>
  );
}
