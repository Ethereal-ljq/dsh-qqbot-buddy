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
import { SourceTag, StatusDot } from '../components/Status';
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
    if (!tools.data) return null;
    return new Set(Array.isArray(tools.data.visible) ? tools.data.visible : []);
  }, [tools.data]);

  /** 白名单为空时后端按能力开关放行（不是“全部禁止”）。 */
  const toolAllowFallback = toolsDraft?.mode === 'allow' && toolsDraft.allow.length === 0;
  const skillAllowFallback = skillsDraft?.mode !== 'all' && (skillsDraft?.allow.length ?? 0) === 0;

  const toggleTool = (name: string, list: 'allow' | 'deny') => {
    setToolsDraft((prev) => {
      if (!prev) return prev;
      // 白名单为空 = 按能力开关放行；此时勾选/取消要以“当前可见集合”为基准，
      // 否则随便勾一个就会把其它工具全部挡掉（旧行为）。
      if (list === 'allow' && prev.mode === 'allow' && prev.allow.length === 0) {
        const base = new Set(visibleNames ? [...visibleNames] : (tools.data?.items ?? []).map((item) => item.name));
        if (base.has(name)) base.delete(name);
        else base.add(name);
        return { ...prev, allow: [...base] };
      }
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
      if (prev.mode === 'deny') return { ...prev, deny: [] };
      // 白名单：以「当前生效可见」为基准生成列表，保留能力开关的现实结果；
      // 不再只放 restrictable（否则 QQBot 插件工具会被顺手挡掉）。
      const width = visibleNames ? [...visibleNames] : tools.data.items.map((item) => item.name);
      return { ...prev, allow: [...new Set(width)] };
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
      // 仅白名单 + 列表为空 = 全部技能可用；取消勾选要落成“全部减去它”，不能只留它一个
      if (prev.mode === 'allow' && prev.allow.length === 0) {
        const base = new Set((skills.data?.items ?? []).map((item) => item.name));
        if (base.has(name)) base.delete(name);
        else base.add(name);
        return { ...prev, allow: [...base] };
      }
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
      key: 'visible',
      title: '已保存可见',
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
        const usingDeny = toolsDraft?.mode === 'deny';
        const list = usingDeny ? 'deny' : 'allow';
        const fallback = !usingDeny && (toolsDraft?.allow.length ?? 0) === 0;
        const inList = toolsDraft ? toolsDraft[list].includes(item.name) : false;
        // 白名单为空时后端按能力开关放行：勾选态直接反映“当前是否生效可见”
        const checked = fallback ? Boolean(visibleNames?.has(item.name)) : inList;
        const disabled = !toolsDraft;
        const title = fallback
          ? '白名单为空：当前按能力开关放行；勾选/取消会以当前可见集合为基准生成白名单'
          : (usingDeny ? '屏蔽该工具' : '放行该工具');
        return (
          <label className={'check' + (disabled ? ' disabled' : '')} title={title}>
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => toggleTool(item.name, list)}
              aria-label={(usingDeny ? '屏蔽 ' : '放行 ') + item.name}
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
        const fallback = (skillsDraft?.allow.length ?? 0) === 0;
        const checked = fallback ? true : skillsDraft.allow.includes(item.name);
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
              {toolsDraft.mode === 'allow'
                ? (toolAllowFallback ? ' · 白名单为空 → 按能力开关放行' : ' · 放行 ' + toolsDraft.allow.length)
                : ' · 屏蔽 ' + toolsDraft.deny.length}
              {' · '}已保存策略下可见 {visibleNames ? visibleNames.size : '—'} 项
            </span>
            {toolAllowFallback ? (
              <span className="muted">勾选/取消会以当前可见集合为基准生成白名单</span>
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
                白名单非空时只放行勾选工具（宿主工具与 QQBot 插件工具统一生效）；白名单为空时按能力开关放行；
                黑名单只屏蔽勾选项。策略在创建新会话时应用：改完请发 /new 或重启该 bot。
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
              <p className="panel-desc">
                仅白名单模式下按配置档过滤模型侧技能目录；白名单为空时全部技能可用；改动同样在创建新会话时生效。
              </p>
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
                    <span className="muted">
                      策略：{skillsDraft?.mode === 'all' ? '全部可见' : '仅白名单'}
                      {skillsDraft?.mode === 'all'
                        ? ''
                        : (skillAllowFallback
                          ? ' · 白名单为空 → 全部技能可用'
                          : ' · 允许 ' + (skillsDraft?.allow.length ?? 0) + ' 个'
                            + (() => {
                              const items = new Set((skills.data?.items ?? []).map((item) => item.name));
                              const invalid = (skillsDraft?.allow ?? []).filter((name) => !items.has(name));
                              return invalid.length > 0 ? '（' + invalid.length + ' 个无效条目）' : '';
                            })())}
                      {' · '}清单 {skills.data?.items.length ?? 0} 项
                    </span>
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
