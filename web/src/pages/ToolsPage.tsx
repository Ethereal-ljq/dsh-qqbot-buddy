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
type TierFilter = 'all' | 'active' | 'passive' | 'unclassified';

/**
 * 装配三态格子（2026-11-14）：已装载 / 已声明 / 索引中。
 * 三者互不替代——已装载但未声明 = 只在索引里等 qqbot_enable 点亮。
 */
function AssemblyCell({ on, label, hint }: { on: boolean | null | undefined; label: string; hint: string }) {
  if (on === null || on === undefined) return <span className="muted" title={hint}>—</span>;
  return (
    <span className="cell-inline" title={hint}>
      <StatusDot tone={on ? 'ok' : 'idle'} />
      <span className={on ? '' : 'muted'}>{on ? label : '—'}</span>
    </span>
  );
}

/** 某行的生效档位（覆盖优先，其次后端算好的默认档位）。 */
function effectiveTier(item: ToolItem, draft: ToolPolicy | null): 'active' | 'passive' {
  const override = draft?.tiers?.[item.name];
  if (override === 'active' || override === 'passive') return override;
  return item.tier === 'passive' ? 'passive' : 'active';
}

export function ToolsPage() {
  const { botId, bots, profiles, activeProfile, reloadState, notify } = useApp();
  const [tab, setTab] = useState<TabId>('tools');
  const [profileId, setProfileId] = useState('');
  const [filter, setFilter] = useState('');
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [view, setView] = useState<'list' | 'groups' | 'sessions'>('list');

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
  // 会话诊断：每个 live peer 的激活组 / 声明工具 / 提示词字符数
  const sessions = useApi(
    (signal) => (botId ? api.toolSessions(botId, signal) : Promise.resolve(null)),
    [botId],
  );

  const [toolsDraft, setToolsDraft] = useState<ToolPolicy | null>(null);
  const [skillsDraft, setSkillsDraft] = useState<SkillPolicy | null>(null);
  const [savingTools, setSavingTools] = useState(false);
  const [savingSkills, setSavingSkills] = useState(false);
  // 手动自愈：重启后 resume 的会话可能丢掉插件工具（实测 36 -> 7），
  // 这个按钮给一个立即生效的入口，不用等自动自愈的下一轮。
  const [healingTools, setHealingTools] = useState(false);
  // 刷新发现（2026-11-14）：重新扫描工具/技能清单，报告「新增 / 消失」，并高亮失效工具与失效策略条目。
  const [discovering, setDiscovering] = useState(false);
  const [discoveryNote, setDiscoveryNote] = useState('');
  const [onlyBroken, setOnlyBroken] = useState(false);
  // 清理「当前环境已不存在」的工具条目（服务端直接落库，不需要再点保存）
  const [cleaningTools, setCleaningTools] = useState(false);

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

  const stalePolicy = tools.data?.stale?.policy ?? [];
  const brokenCount = tools.data?.stateSummary?.disabled ?? 0;
  const keyword = filter.trim().toLowerCase();
  const toolRows = useMemo(() => {
    let items = tools.data?.items ?? [];
    if (onlyBroken) items = items.filter((item) => item.state === 'disabled');
    if (keyword !== '') {
      items = items.filter((item) =>
        [item.name, item.source || '', item.description || ''].some((field) => field.toLowerCase().includes(keyword)),
      );
    }
    if (tierFilter !== 'all') {
      items = items.filter((item) => {
        const tier = effectiveTier(item, toolsDraft);
        if (tierFilter === 'unclassified') return item.classified === false;
        return tier === tierFilter;
      });
    }
    return items;
  }, [tools.data, keyword, tierFilter, toolsDraft, onlyBroken]);

  const tierCounts = useMemo(() => {
    const items = tools.data?.items ?? [];
    let active = 0;
    let passive = 0;
    let unclassified = 0;
    for (const item of items) {
      if (item.classified === false) unclassified += 1;
      if (effectiveTier(item, toolsDraft) === 'passive') passive += 1;
      else active += 1;
    }
    return { active, passive, unclassified, total: items.length };
  }, [tools.data, toolsDraft]);

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

  /** 能力组（后端已按 profile 返回 groups/groupState）。 */
  const groupCards = useMemo(() => {
    const groups = tools.data?.groups ?? [];
    const states = new Map((tools.data?.groupState ?? []).map((group) => [group.id, group]));
    const items = new Map((tools.data?.items ?? []).map((item) => [item.name, item]));
    return groups.map((group) => {
      const override = toolsDraft?.tiers?.[group.id] ?? '';
      const tools0 = group.tools.map((name) => items.get(name)).filter((item): item is ToolItem => Boolean(item));
      const passiveCount = tools0.filter((item) => effectiveTier(item, toolsDraft) === 'passive').length;
      const defaultTier = tools0.length === 0
        ? '—'
        : passiveCount === tools0.length
          ? '按需'
          : passiveCount === 0
            ? '常驻'
            : '混合（' + passiveCount + '/' + tools0.length + ' 按需）';
      return {
        ...group,
        override,
        defaultTier,
        available: states.get(group.id)?.capability === null
          ? tools0.length > 0
          : Boolean(states.get(group.id)),
        items: tools0,
        passiveCount,
      };
    });
  }, [tools.data, toolsDraft]);

  const setGroupTier = (groupId: string, tier: '' | 'active' | 'passive') => {
    setToolsDraft((prev) => {
      if (!prev) return prev;
      const tiers = { ...(prev.tiers ?? {}) };
      if (tier === '') delete tiers[groupId];
      else tiers[groupId] = tier;
      return { ...prev, tiers };
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

  /**
   * 刷新发现：重新扫一遍工具/技能清单。
   * 结果里带「新增 / 消失」——消失的就是现在已经失效的工具（插件卸载、改名、能力被删），
   * 配合下方的「失效」过滤和策略失效条目提示一起看。
   */
  const rediscover = async () => {
    setDiscovering(true);
    setDiscoveryNote('');
    try {
      const result = await api.action('refresh-discovery', {});
      const added = Array.isArray(result?.added) ? (result.added as string[]) : [];
      const removed = Array.isArray(result?.removed) ? (result.removed as string[]) : [];
      const toolCount = Number(result?.tools ?? 0);
      const skillCount = Number(result?.skills ?? 0);
      const parts = ['发现 ' + toolCount + ' 个工具 / ' + skillCount + ' 个技能'];
      if (added.length > 0) parts.push('新增 ' + added.length + ' 个：' + added.slice(0, 8).join('、') + (added.length > 8 ? '…' : ''));
      if (removed.length > 0) parts.push('消失 ' + removed.length + ' 个：' + removed.slice(0, 8).join('、') + (removed.length > 8 ? '…' : ''));
      const note = parts.join('；');
      setDiscoveryNote(note);
      notify(removed.length > 0 ? 'info' : 'ok', note);
      tools.reload();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '刷新发现失败：' + error.message);
    } finally {
      setDiscovering(false);
    }
  };

  /**
   * 一键清理策略里「当前环境已不存在」的工具条目（allow/deny/tiers）。
   *
   * 和「刷新发现」的分工：刷新发现是诊断（告诉你谁没了），这里是执行（把它们从配置里删掉并落库）。
   */
  const cleanupStale = async () => {
    if (!profileId) {
      notify('info', '请先选择配置档');
      return;
    }
    setCleaningTools(true);
    try {
      const result = await api.cleanupTools(profileId);
      const names = result.removed.map((item) => item.name);
      if (names.length === 0) {
        notify('info', '没有需要清理的条目：策略里的工具在当前环境都还存在');
      } else {
        notify('ok', '已清理 ' + names.length + ' 个失效条目：' + names.slice(0, 8).join('、') + (names.length > 8 ? '…' : ''));
      }
      tools.reload();
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      notify(error.unimplemented ? 'info' : 'error', '清理失败：' + error.message);
    } finally {
      setCleaningTools(false);
    }
  };

  const healTools = async () => {
    if (!botId) {
      notify('info', '请先在「机器人」页创建并启动一个机器人');
      return;
    }
    setHealingTools(true);
    try {
      const result = await api.action('heal-tools', { botId });
      const visible = Array.isArray(result?.tools) ? (result.tools as string[]) : [];
      const healed = Number(result?.healed ?? 0);
      const total = Number(result?.total ?? 0);
      if (total === 0) {
        notify('info', '当前没有活动会话，无需重挂');
        return;
      }
      const pluginCount = visible.filter((name) => /^(qqbot_|memory_|knowledge_|member_|chat_history_)/.test(name)).length;
      if (pluginCount === 0) {
        notify('error', '已重挂 ' + healed + '/' + total + ' 个会话，但没有检测到插件工具：请检查本页的能力开关与白名单');
      } else {
        notify('ok', '已重挂 ' + healed + '/' + total + ' 个会话，当前会话可见 ' + visible.length + ' 个工具（插件 ' + pluginCount + ' 个）');
      }
      tools.reload();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '重挂失败：' + error.message, error.code);
    } finally {
      setHealingTools(false);
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
          <span className="cell-inline">
            <span className="mono cell-title">{item.name}</span>
            {item.classified === false ? <span className="badge warn" title="catalog 未登记档位，默认按「常驻」处理">未分类</span> : null}
            {item.state === 'disabled' ? (
              <span className="badge warn" title={item.reason || '当前策略下不可用'}>不可用</span>
            ) : null}
          </span>
          {item.description ? <span className="cell-sub ellipsis" title={item.description}>{truncate(item.description, 110)}</span> : null}
        </div>
      ),
    },
    {
      key: 'tier',
      title: '档位',
      width: '132px',
      render: (item) => {
        const override = toolsDraft?.tiers?.[item.name] ?? '';
        const tier = effectiveTier(item, toolsDraft);
        const groupLabel = item.group || item.capability || '';
        const title = override !== ''
          ? '已覆盖为「' + (override === 'active' ? '常驻' : '按需') + '」，保存后生效'
          : '跟随内置分档：' + (tier === 'active' ? '常驻（每次请求都声明）' : '按需（默认不声明，qqbot_enable 或触发词点亮）')
            + (groupLabel ? '；分组：' + groupLabel : '');
        return (
          <select
            className="input select-compact"
            value={override}
            disabled={!toolsDraft}
            title={title}
            aria-label={'档位 ' + item.name}
            onChange={(event) => {
              const next = event.target.value as '' | 'active' | 'passive';
              setToolsDraft((prev) => {
                if (!prev) return prev;
                const tiers = { ...(prev.tiers ?? {}) };
                if (next === '') delete tiers[item.name];
                else tiers[item.name] = next;
                return { ...prev, tiers };
              });
            }}
          >
            <option value="">默认（{tier === 'active' ? '常驻' : '按需'}）</option>
            <option value="active">常驻</option>
            <option value="passive">按需</option>
          </select>
        );
      },
    },
    {
      key: 'loaded',
      title: '已装载',
      width: '86px',
      render: (item) => (
        <AssemblyCell
          on={item.loaded}
          label="已装载"
          hint="已装载：该工具所属插件在本会话启动时注册（可被调用、也可被 qqbot_enable 点亮）。不等于会进请求 schema。"
        />
      ),
    },
    {
      key: 'declared',
      title: '已声明',
      width: '86px',
      render: (item) => (
        <AssemblyCell
          on={item.declared}
          label="已声明"
          hint="已声明：每次请求的 tools schema 里都有它（常驻档）。这些才占提示词 token。"
        />
      ),
    },
    {
      key: 'indexed',
      title: '索引中',
      width: '86px',
      render: (item) => (
        <AssemblyCell
          on={item.indexed}
          label="索引中"
          hint="索引中：只在提示词的【按需能力】索引里出现名字（不带 schema）；模型调用 qqbot_enable 装载后，下一步才进 schema。"
        />
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
              {' · '}档位：常驻 {tierCounts.active} / 按需 {tierCounts.passive}
              {tierCounts.unclassified > 0 ? '（未分类 ' + tierCounts.unclassified + '，按常驻处理）' : ''}
            </span>
            <span className="muted" title="装配期由 agent preset 决定：已声明=每次请求都带 schema；索引中=只在提示词索引里出现，qqbot_enable 装载后下一步进 schema">
              装配：已声明 {tools.data.stateSummary?.declared ?? '—'} · 索引中 {tools.data.stateSummary?.indexed ?? '—'}
              {' · '}不可用 {tools.data.stateSummary?.disabled ?? '—'}
              {tools.data.preset ? ' · preset ' + tools.data.preset.id : ''}
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
                黑名单只屏蔽勾选项。<strong>档位</strong>决定“此刻声明不声明”：常驻工具每次请求都带 schema，
                按需工具默认不声明（不花 token），由用户触发词或模型调用 <span className="mono">qqbot_enable</span> 点亮。
                <br />
                <strong>已装载</strong>=插件已注册到会话；<strong>已声明</strong>=每次请求的 schema 里有它（占 token）；
                <strong>索引中</strong>=只在提示词的【按需能力】索引里出现名字，装载后下一步才进 schema。
                装配（常驻工具集）由 agent preset 在会话创建时决定：改完请发 /new 或重启该 bot。
              </p>
            </div>
            <div className="panel-tools">
              <div className="segmented" role="group" aria-label="视图">
                <button
                  type="button"
                  className={'seg-btn' + (view === 'list' ? ' active' : '')}
                  onClick={() => setView('list')}
                >
                  列表
                </button>
                <button
                  type="button"
                  className={'seg-btn' + (view === 'groups' ? ' active' : '')}
                  onClick={() => setView('groups')}
                >
                  能力组 {groupCards.length}
                </button>
                <button
                  type="button"
                  className={'seg-btn' + (view === 'sessions' ? ' active' : '')}
                  onClick={() => { setView('sessions'); sessions.reload(); }}
                >
                  会话诊断{sessions.data ? ' ' + sessions.data.count : ''}
                </button>
              </div>
              <span className="toolbar-divider" aria-hidden="true" />
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
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={discovering}
                title="重新扫描工具/技能清单，并对比上次发现结果：报告新增、消失（已失效）的工具"
                onClick={() => void rediscover()}
              >
                {discovering ? '发现中…' : '刷新发现'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={cleaningTools || !profileId}
                title="把策略里指向「当前环境已不存在」的工具/分组条目删掉并立即保存（失效工具）"
                onClick={() => void cleanupStale()}
              >
                {cleaningTools ? '清理中…' : '清理工具' + (stalePolicy.length > 0 ? ' ' + stalePolicy.length : '')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={healingTools}
                title="把 qqbot_*/memory_* 等插件工具重新挂到当前会话（修复重启后「这轮没挂工具」）"
                onClick={() => void healTools()}
              >
                {healingTools ? '重挂中…' : '重新挂载工具'}
              </button>
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
              <div className="segmented" role="group" aria-label="按档位筛选">
                {([['all', '全部'], ['active', '常驻'], ['passive', '按需'], ['unclassified', '未分类']] as Array<[TierFilter, string]>).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={'seg-btn' + (tierFilter === id ? ' active' : '')}
                    onClick={() => setTierFilter(id)}
                  >
                    {label}
                    {id === 'all'
                      ? ' ' + tierCounts.total
                      : id === 'active'
                        ? ' ' + tierCounts.active
                        : id === 'passive'
                          ? ' ' + tierCounts.passive
                          : ' ' + tierCounts.unclassified}
                  </button>
                ))}
              </div>
              <div className="segmented" role="group" aria-label="按装配状态筛选">
                <button
                  type="button"
                  className={'seg-btn' + (onlyBroken ? ' active' : '')}
                  disabled={brokenCount === 0}
                  title="只显示当前不可用的工具（能力关闭 / 插件未装载 / 被策略屏蔽）"
                  onClick={() => setOnlyBroken((value) => !value)}
                >
                  失效 {brokenCount}
                </button>
              </div>
              {toolsDirty ? <span className="dirty-flag">未保存</span> : null}
            </div>

            {discoveryNote !== '' ? (
              <div className="panel-pad">
                <div className="note note-pending">
                  <span className="note-title">刷新发现</span>
                  <span className="note-text">{discoveryNote}</span>
                </div>
              </div>
            ) : null}

            {stalePolicy.length > 0 ? (
              <div className="panel-pad">
                <div className="note note-pending">
                  <span className="note-title">策略里有 {stalePolicy.length} 个失效条目</span>
                  <span className="note-text">
                    这些名字在发现清单里已经不存在（插件卸载 / 改名 / 工具被移除）：
                    {stalePolicy.slice(0, 10).map((entry) => entry.name + '（' + entry.where + '）').join('、')}
                    {stalePolicy.length > 10 ? '…' : ''}
                  </span>
                  <button type="button" className="btn btn-sm" disabled={cleaningTools} onClick={() => void cleanupStale()}>
                    {cleaningTools ? '清理中…' : '清理并保存'}
                  </button>
                </div>
              </div>
            ) : null}

            {view === 'sessions' ? (
              <div className="panel-pad">
                <div className="sessions-toolbar">
                  <span className="muted">
                    {sessions.data
                      ? '当前 ' + sessions.data.count + ' 个 live 会话' + (sessions.data.note ? ' · ' + sessions.data.note : '')
                      : '正在读取会话…'}
                  </span>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={sessions.loading} onClick={() => sessions.reload()}>
                    {sessions.loading ? '刷新中…' : '刷新'}
                  </button>
                </div>
                {sessions.error ? (
                  <ErrorNote error={sessions.error} onRetry={sessions.reload} />
                ) : (sessions.data?.items.length ?? 0) === 0 ? (
                  <EmptyState
                    compact
                    title="没有 live 会话"
                    description="机器人启动并收到消息后，这里会显示每个 peer 的被动能力激活状态、本次声明的工具与提示词字符数。"
                  />
                ) : (
                  <DataTable
                    columns={[
                      {
                        key: 'peer',
                        title: '会话 peer',
                        render: (item) => (
                          <div className="cell-stack">
                            <span className="mono cell-title">{item.peer}</span>
                            <span className="mono cell-sub">{item.sessionId ? item.sessionId.slice(0, 24) : '—'}</span>
                          </div>
                        ),
                      },
                      {
                        key: 'groups',
                        title: '本轮激活',
                        width: '220px',
                        render: (item) => (
                          <div className="tag-list">
                            {item.groups.length === 0
                              ? <span className="muted">—</span>
                              : item.groups.map((group) => <span className="tag" key={group}>{group}</span>)}
                            {item.tools.map((tool) => <span className="tag mono" key={tool}>{tool}</span>)}
                          </div>
                        ),
                      },
                      {
                        key: 'declared',
                        title: '本次声明工具',
                        width: '150px',
                        render: (item) => (
                          <span className="cell-inline mono">
                            {item.declared.length}
                            {item.passiveDeclared.length > 0
                              ? <span className="muted">（按需 {item.passiveDeclared.length}）</span>
                              : null}
                          </span>
                        ),
                      },
                      {
                        key: 'prompt',
                        title: '提示词',
                        width: '110px',
                        render: (item) => <span className="mono">{item.promptChars} 字符</span>,
                      },
                      {
                        key: 'error',
                        title: '',
                        render: (item) => (item.error ? <span className="cell-error">{truncate(item.error, 40)}</span> : null),
                      },
                    ]}
                    rows={sessions.data?.items ?? []}
                    rowKey={(item) => item.peer}
                    loading={sessions.loading}
                  />
                )}
              </div>
            ) : view === 'groups' ? (
              <div className="tool-groups">
                {groupCards.length === 0 ? (
                  <EmptyState compact title="没有能力组" description="后端未返回分组信息（旧版本控制台或工具发现未装配）。" />
                ) : groupCards.map((group) => (
                  <div className={'tool-group' + (group.available ? '' : ' is-unavailable')} key={group.id}>
                    <div className="tool-group-head">
                      <span className="tool-group-title">{group.label}</span>
                      <span className="tag mono tool-group-id">{group.id}</span>
                      {group.capability && group.capability !== group.id
                        ? <span className="tag">{group.capability}</span>
                        : null}
                      {group.available ? null : <span className="tag">能力未开</span>}
                    </div>
                    <div className="tool-group-tools">
                      {group.items.length === 0 ? (
                        <span className="muted">组内工具当前不可用</span>
                      ) : group.items.map((item) => (
                        <span
                          key={item.name}
                          className={'tag mono' + (effectiveTier(item, toolsDraft) === 'passive' ? ' tag-passive' : '')}
                          title={effectiveTier(item, toolsDraft) === 'passive' ? '按需（默认不声明）' : '常驻'}
                        >
                          {item.name}
                        </span>
                      ))}
                    </div>
                    <div className="tool-group-desc">
                      默认：{group.defaultTier}；组级覆盖对整组生效（单个工具仍可在列表里单独改）。
                    </div>
                    <div className="tool-group-actions">
                      <select
                        className="input select-compact"
                        value={group.override}
                        disabled={!toolsDraft}
                        aria-label={'组档位 ' + group.id}
                        onChange={(event) => setGroupTier(group.id, event.target.value as '' | 'active' | 'passive')}
                      >
                        <option value="">跟随默认（{group.defaultTier}）</option>
                        <option value="active">整组常驻</option>
                        <option value="passive">整组按需</option>
                      </select>
                      <span className="muted">{group.items.length} 个工具</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : toolsBody()}
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
