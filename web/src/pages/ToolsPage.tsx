/**
 * pages/ToolsPage —— 工具与技能（2026-11-16 重构：从"三列状态点"改成"一个说人话的状态列"）。
 *
 * 数据源：GET /api/tools?profile= / GET /api/skills?profile= / GET /api/tools/sessions；
 * 保存：PUT /api/tools/policy、PUT /api/skills/policy（策略落在 Profile）。
 *
 * 读表口径（这一版的重点，避免"可见/不可见"这种黑话）：
 *   - 档位 = 要不要每轮都发。常驻=每轮带完整 schema（占 token）；按需=默认不发，触发词或 qqbot_enable 后本会话可用。
 *   - 放行/屏蔽 = 准不准用。白名单模式勾选=放行；黑名单模式勾选=屏蔽。
 *   - 本会话状态 = 上述两条 + 能力开关 + 本机插件 一起算出来的结果：
 *       每轮发送（declared）/ 待唤醒（indexed）/ 不可用（disabled，行内有原因）。
 */
import { useEffect, useMemo, useState } from 'react';

import { api, toApiError } from '../api/client';
import type { SkillPolicy, SkillsPayload, ToolItem, ToolPolicy, ToolState, ToolsPayload } from '../api/types';
import { DataTable, type Column } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { PageHeader } from '../components/PageHeader';
import { SourceTag } from '../components/Status';
import { Tabs } from '../components/Tabs';
import { cloneValue } from '../lib/objects';
import { truncate } from '../lib/format';
import { navigate } from '../router';
import { useApp } from '../state/AppContext';
import { useApi } from '../state/useApi';
import type { SkillItem } from '../api/types';

type TabId = 'tools' | 'skills' | 'sessions';
type ToolFilter = 'all' | 'declared' | 'indexed' | 'disabled' | 'unclassified';
type ToolView = 'list' | 'groups';

/** 某行的生效档位（覆盖优先，其次后端算好的默认档位）。 */
/** 放宽/屏蔽判定用：别名与正名共享权限，按 related 集合判断。 */
function relatedNamesOf(item: ToolItem): string[] {
  if (Array.isArray(item.related) && item.related.length > 0) return item.related;
  return [item.name];
}

/** 写入策略时只写正名（别名不落库，保持白名单干净）。 */
function policyNameOf(item: ToolItem): string {
  return item.aliasOf || item.name;
}

function effectiveTier(item: ToolItem, draft: ToolPolicy | null): 'active' | 'passive' {
  const override = draft?.tiers?.[item.name];
  if (override === 'active' || override === 'passive') return override;
  return item.tier === 'passive' ? 'passive' : 'active';
}

/** 不可用原因折叠成一句人话（后端 reason 是给排查用的长句）。 */
function shortReason(reason?: string): string {
  const text = String(reason || '');
  if (text === '') return '当前策略下不可用';
  if (/白名单|不在列表|未放行/.test(text)) return '未放行';
  if (/黑名单|被屏蔽/.test(text)) return '被屏蔽';
  if (/能力/.test(text)) return '能力关闭';
  if (/插件|装载|挂载/.test(text)) return '插件未装载';
  return truncate(text, 16);
}

interface StateMeta {
  tone: string;
  label: string;
  hint: string;
  detail?: string;
}

/** 装配状态 → 展示口径。只保留一个状态列，避免「已装载/已声明/索引中」三列并列看不懂。 */
function stateMeta(item: ToolItem): StateMeta {
  const state: ToolState | undefined = item.state;
  if (state === 'declared') {
    return { tone: 'ok', label: '每轮发送', hint: '常驻：每次请求的 tools schema 里都有它，占提示词 token' };
  }
  if (state === 'indexed') {
    return {
      tone: 'warn',
      label: '待唤醒',
      hint: '按需：默认不发 schema；用户触发词命中或模型调用 qqbot_enable 后，本会话后续轮次可用',
    };
  }
  if (state === 'disabled') {
    return { tone: 'danger', label: '不可用', hint: item.reason || '当前策略下不可用', detail: shortReason(item.reason) };
  }
  return { tone: 'idle', label: '—', hint: '没有生效配置档或宿主未装配；无法判断装配状态' };
}

function StateCell({ item }: { item: ToolItem }) {
  const meta = stateMeta(item);
  return (
    <div className="tool-state" title={meta.hint}>
      <span className={'badge ' + meta.tone}>{meta.label}</span>
      {meta.detail ? <span className="tool-state-reason">{meta.detail}</span> : null}
    </div>
  );
}

export function ToolsPage() {
  const { botId, bots, profiles, activeProfile, reloadState, notify } = useApp();
  const [tab, setTab] = useState<TabId>('tools');
  const [profileId, setProfileId] = useState('');
  const [filter, setFilter] = useState('');
  const [toolFilter, setToolFilter] = useState<ToolFilter>('all');
  const [toolView, setToolView] = useState<ToolView>('list');
  const [onlyBroken, setOnlyBroken] = useState(false);

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
  const sessions = useApi(
    (signal) => (botId ? api.toolSessions(botId, signal) : Promise.resolve(null)),
    [botId],
  );

  const [toolsDraft, setToolsDraft] = useState<ToolPolicy | null>(null);
  const [skillsDraft, setSkillsDraft] = useState<SkillPolicy | null>(null);
  const [savingTools, setSavingTools] = useState(false);
  const [savingSkills, setSavingSkills] = useState(false);
  const [healingTools, setHealingTools] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryNote, setDiscoveryNote] = useState('');
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
  const summary = tools.data?.stateSummary;
  const keyword = filter.trim().toLowerCase();

  const toolRows = useMemo(() => {
    let items = tools.data?.items ?? [];
    if (onlyBroken) items = items.filter((item) => item.state === 'disabled');
    if (keyword !== '') {
      items = items.filter((item) =>
        [item.name, item.source || '', item.description || ''].some((field) => field.toLowerCase().includes(keyword)),
      );
    }
    if (toolFilter !== 'all') {
      items = items.filter((item) => {
        if (toolFilter === 'unclassified') return item.classified === false;
        return item.state === toolFilter;
      });
    }
    return items;
  }, [tools.data, keyword, toolFilter, toolsDraft, onlyBroken]);

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

  /** 白名单为空时后端按能力开关放行（不是"全部禁止"）。 */
  const toolAllowFallback = toolsDraft?.mode === 'allow' && toolsDraft.allow.length === 0;
  const skillAllowFallback = skillsDraft?.mode !== 'all' && (skillsDraft?.allow.length ?? 0) === 0;

  const toggleTool = (item: ToolItem, list: 'allow' | 'deny') => {
    const related = relatedNamesOf(item);
    const canonical = policyNameOf(item);
    setToolsDraft((prev) => {
      if (!prev) return prev;
      // 白名单为空 = 按能力开关放行；此时勾选/取消要以"当前可见集合"为基准，
      // 否则随便勾一个就会把其它工具全部挡掉（旧行为）。
      if (list === 'allow' && prev.mode === 'allow' && prev.allow.length === 0) {
        const base = new Set(visibleNames ? [...visibleNames] : (tools.data?.items ?? []).map((entry) => entry.name));
        const present = related.some((name) => base.has(name));
        if (present) related.forEach((name) => base.delete(name));
        else base.add(canonical);
        return { ...prev, allow: [...base] };
      }
      const current = new Set(prev[list]);
      const present = related.some((name) => current.has(name));
      if (present) related.forEach((name) => current.delete(name));
      else current.add(canonical);
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
   * 结果里带「新增 / 消失」——消失的就是现在已经失效的工具（插件卸载、改名、能力被删）。
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

  /** 一键清理策略里「当前环境已不存在」的工具条目（allow/deny/tiers），服务端直接落库。 */
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
      // 仅白名单 + 列表为空 = 全部技能可用；取消勾选要落成"全部减去它"，不能只留它一个
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
            {item.aliasOf ? (
              <span className="badge idle" title={'兼容别名：与 ' + item.aliasOf + ' 共享放行/屏蔽权限'}>别名 → {item.aliasOf}</span>
            ) : null}
            {item.classified === false ? <span className="badge warn" title="catalog 未登记档位，默认按「常驻」处理">未分类</span> : null}
            <SourceTag source={item.source} />
          </span>
          {item.description ? <span className="cell-sub ellipsis" title={item.description}>{truncate(item.description, 120)}</span> : null}
        </div>
      ),
    },
    {
      key: 'tier',
      title: '档位',
      width: '128px',
      render: (item) => {
        const override = toolsDraft?.tiers?.[item.name] ?? '';
        const tier = effectiveTier(item, toolsDraft);
        const title = override !== ''
          ? '已覆盖为「' + (override === 'active' ? '常驻' : '按需') + '」，保存后生效'
          : '跟随内置分档：' + (tier === 'active' ? '常驻（每次请求都发 schema）' : '按需（默认不发，触发词或 qqbot_enable 后可用）');
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
      key: 'state',
      title: '装配状态',
      width: '128px',
      render: (item) => <StateCell item={item} />,
    },
    {
      key: 'policy',
      title: toolsDraft?.mode === 'deny' ? '屏蔽' : '放行',
      width: '74px',
      align: 'center',
      render: (item) => {
        const usingDeny = toolsDraft?.mode === 'deny';
        const list = usingDeny ? 'deny' : 'allow';
        const related = relatedNamesOf(item);
        const fallback = !usingDeny && (toolsDraft?.allow.length ?? 0) === 0;
        // 别名与正名共享权限：只要 related 里任一名字在列表内就算放行，
        // 否则会出现「每轮发送（因为正名放行了）却显示未放行」的假矛盾。
        const inList = toolsDraft ? related.some((name) => toolsDraft[list].includes(name)) : false;
        const visibleNow = related.some((name) => Boolean(visibleNames?.has(name)));
        const checked = fallback ? visibleNow : inList;
        // 元工具 force 注册：白名单拦不住它，只有黑名单能屏蔽 → 显示为「已放行（锁定）」
        const forceLocked = !usingDeny && item.force === true;
        const disabled = !toolsDraft || forceLocked;
        const title = forceLocked
          ? '元工具 qqbot_enable：白名单不拦它（只有黑名单能屏蔽）'
          : fallback
            ? '白名单为空：当前按能力开关放行；勾选/取消会以当前可见集合为基准生成白名单'
            : item.aliasOf
              ? '兼容别名：与 ' + item.aliasOf + ' 共享放行/屏蔽状态（写策略时只记正名）'
              : (usingDeny ? '勾选 = 屏蔽该工具' : '勾选 = 放行该工具');
        return (
          <label className={'check' + (disabled && !forceLocked ? ' disabled' : '')} title={title}>
            <input
              type="checkbox"
              checked={forceLocked ? true : checked}
              disabled={disabled}
              onChange={() => toggleTool(item, list)}
              aria-label={(usingDeny ? '屏蔽 ' : '放行 ') + item.name + (item.aliasOf ? '（别名，跟 ' + item.aliasOf + ' 同步）' : '')}
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
      width: '74px',
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
            title={keyword || toolFilter !== 'all' ? '没有匹配的工具' : '宿主尚未装配工具发现服务'}
            description={keyword || toolFilter !== 'all'
              ? '换个关键词或切回「全部」试试。'
              : '当前可能是开发模式（deps.toolsDiscover 未装配）或宿主还没注册工具；装配后这里会列出全部工具。'}
            endpoint="GET /api/tools?profile=…"
          />
        )}
        footer={(
          <div className="table-foot-inner">
            <span className="muted">
              {toolsDraft.mode === 'allow'
                ? (toolAllowFallback ? '白名单为空 → 按能力开关放行' : '白名单放行 ' + toolsDraft.allow.length + ' 项')
                : '黑名单屏蔽 ' + toolsDraft.deny.length + ' 项'}
              {' · '}常驻 {tierCounts.active} / 按需 {tierCounts.passive}
              {tierCounts.unclassified > 0 ? '（未分类 ' + tierCounts.unclassified + '，按常驻处理）' : ''}
            </span>
            <span className="muted">
              每轮发送 {summary?.declared ?? '—'} · 待唤醒 {summary?.indexed ?? '—'} · 不可用 {summary?.disabled ?? '—'}
            </span>
          </div>
        )}
      />
    );
  };

  const groupsBody = () => {
    if (groupCards.length === 0) {
      return (
        <div className="panel-pad">
          <EmptyState compact title="没有能力组" description="后端未返回分组信息（旧版本控制台或工具发现未装配）。" />
        </div>
      );
    }
    return (
      <div className="tool-groups">
        {groupCards.map((group) => (
          <div className={'tool-group' + (group.available ? '' : ' is-unavailable')} key={group.id}>
            <div className="tool-group-head">
              <span className="tool-group-title">{group.label}</span>
              <span className="tag mono tool-group-id">{group.id}</span>
              {group.available ? null : <span className="badge danger">能力关闭</span>}
            </div>
            <div className="tool-group-tools">
              {group.items.length === 0 ? (
                <span className="muted">组内工具当前不可用</span>
              ) : group.items.map((item) => (
                <span
                  key={item.name}
                  className={'tag mono' + (effectiveTier(item, toolsDraft) === 'passive' ? ' tag-passive' : '')}
                  title={effectiveTier(item, toolsDraft) === 'passive' ? '按需（默认不发 schema）' : '常驻（每轮发送）'}
                >
                  {item.name}
                </span>
              ))}
            </div>
            <div className="tool-group-desc">默认：{group.defaultTier} · 组级覆盖对整组生效（单个工具可在列表里单独改）</div>
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
        description="档位决定要不要每轮发给模型；白名单决定准不准用。默认拒绝：新装插件不会自动进入 QQ 会话。"
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

      <div className="tool-stats">
        <button
          type="button"
          className={'tool-stat' + (tab === 'tools' && toolFilter === 'declared' ? ' active' : '')}
          onClick={() => { setTab('tools'); setToolFilter('declared'); setOnlyBroken(false); }}
        >
          <span className="tool-stat-value">{summary?.declared ?? '—'}</span>
          <span className="tool-stat-label">每轮发送</span>
          <span className="tool-stat-hint">常驻档：每次请求都带 schema，占 token</span>
        </button>
        <button
          type="button"
          className={'tool-stat' + (tab === 'tools' && toolFilter === 'indexed' ? ' active' : '')}
          onClick={() => { setTab('tools'); setToolFilter('indexed'); setOnlyBroken(false); }}
        >
          <span className="tool-stat-value">{summary?.indexed ?? '—'}</span>
          <span className="tool-stat-label">待唤醒</span>
          <span className="tool-stat-hint">不动 schema；触发词 / qqbot_enable 后可用</span>
        </button>
        <button
          type="button"
          className={'tool-stat' + (tab === 'tools' && toolFilter === 'disabled' ? ' active' : '')}
          onClick={() => { setTab('tools'); setToolFilter('disabled'); setOnlyBroken(false); }}
        >
          <span className="tool-stat-value">{summary?.disabled ?? '—'}</span>
          <span className="tool-stat-label">不可用</span>
          <span className="tool-stat-hint">能力关闭 / 未放行 / 插件未装载</span>
        </button>
        <button
          type="button"
          className={'tool-stat' + (tab === 'skills' ? ' active' : '')}
          onClick={() => setTab('skills')}
        >
          <span className="tool-stat-value">{skills.data?.items.length ?? '—'}</span>
          <span className="tool-stat-label">技能</span>
          <span className="tool-stat-hint">模型可按需 skill 加载</span>
        </button>
      </div>

      <Tabs
        items={[
          { id: 'tools', label: '工具', count: tools.data?.items.length },
          { id: 'skills', label: '技能', count: skills.data?.items.length },
          { id: 'sessions', label: '会话诊断', count: sessions.data?.count },
        ]}
        value={tab}
        onChange={(id) => {
          const next = id as TabId;
          setTab(next);
          if (next === 'sessions') sessions.reload();
        }}
      />

      {tab === 'tools' ? (
        <section className="panel">
          <header className="panel-head">
            <div>
              <h2 className="panel-title">
                工具清单
                {tools.data?.preset ? <span className="mono tag tool-preset" title="装配期由 agent preset 决定常驻工具集">{tools.data.preset.id}</span> : null}
              </h2>
              <p className="panel-desc">改动点「保存策略」后生效；装配在会话创建时决定，改完请发 /new 或重启该 bot。</p>
            </div>
            <div className="panel-tools">
              <div className="segmented" role="group" aria-label="策略模式">
                <button
                  type="button"
                  className={'seg-btn' + (toolsDraft?.mode === 'allow' ? ' active' : '')}
                  disabled={!toolsDraft}
                  title="白名单：只放行勾选的工具；列表为空时按能力开关放行"
                  onClick={() => setToolsDraft((prev) => (prev ? { ...prev, mode: 'allow' } : prev))}
                >
                  白名单
                </button>
                <button
                  type="button"
                  className={'seg-btn' + (toolsDraft?.mode === 'deny' ? ' active' : '')}
                  disabled={!toolsDraft}
                  title="黑名单：只屏蔽勾选的工具，其余按能力开关放行"
                  onClick={() => setToolsDraft((prev) => (prev ? { ...prev, mode: 'deny' } : prev))}
                >
                  黑名单
                </button>
              </div>
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
              <div className="segmented" role="group" aria-label="按状态筛选">
                {([['all', '全部', tierCounts.total], ['declared', '每轮发送', summary?.declared ?? 0], ['indexed', '待唤醒', summary?.indexed ?? 0], ['disabled', '不可用', summary?.disabled ?? 0]] as Array<[ToolFilter, string, number]>).map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    className={'seg-btn' + (toolFilter === id ? ' active' : '')}
                    onClick={() => { setToolFilter(id); setOnlyBroken(false); }}
                  >
                    {label} {count}
                  </button>
                ))}
                {tierCounts.unclassified > 0 ? (
                  <button
                    type="button"
                    className={'seg-btn' + (toolFilter === 'unclassified' ? ' active' : '')}
                    onClick={() => { setToolFilter('unclassified'); setOnlyBroken(false); }}
                  >
                    未分类 {tierCounts.unclassified}
                  </button>
                ) : null}
              </div>
              <div className="segmented" role="group" aria-label="视图">
                <button type="button" className={'seg-btn' + (toolView === 'list' ? ' active' : '')} onClick={() => setToolView('list')}>列表</button>
                <button type="button" className={'seg-btn' + (toolView === 'groups' ? ' active' : '')} onClick={() => setToolView('groups')}>按能力组 {groupCards.length}</button>
              </div>
              {toolsDirty ? <span className="dirty-flag">未保存</span> : null}
              <span className="toolbar-divider" aria-hidden="true" />
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
                {cleaningTools ? '清理中…' : '清理失效' + (stalePolicy.length > 0 ? ' ' + stalePolicy.length : '')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={healingTools}
                title="把 qqbot_*/memory_* 等插件工具重新挂到当前会话（修复重启后「这轮没挂工具」）"
                onClick={() => void healTools()}
              >
                {healingTools ? '重挂中…' : '重新挂载'}
              </button>
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

            <div className="tool-legend">
              <span><span className="badge ok">每轮发送</span> 常驻档：每次请求都带完整 schema，占提示词 token</span>
              <span><span className="badge warn">待唤醒</span> 按需档：默认不发；触发词或 qqbot_enable 后本会话可用</span>
              <span><span className="badge danger">不可用</span> 能力关闭 / 未在白名单 / 插件未装载（行内写原因）</span>
              <span className="muted">「档位」决定发不发，「放行」决定准不准用，两者独立；这是按策略推算，会话实际激活看「会话诊断」</span>
            </div>

            {toolView === 'groups' ? groupsBody() : toolsBody()}
          </div>
          {tools.data?.note ? <p className="panel-note">{tools.data.note}</p> : null}
        </section>
      ) : tab === 'skills' ? (
        <section className="panel">
          <header className="panel-head">
            <div>
              <h2 className="panel-title">技能目录</h2>
              <p className="panel-desc">按配置档过滤模型侧技能目录；改动在创建新会话时生效。</p>
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
                empty={<EmptyState compact title="没有技能" description="宿主注册技能后会出现。" />}
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
      ) : (
        <section className="panel">
          <header className="panel-head">
            <div>
              <h2 className="panel-title">会话诊断</h2>
              <p className="panel-desc">每个 live 会话的实际装配：本会话已唤醒的能力组、每轮声明的工具数、提示词字符数。</p>
            </div>
            <div className="panel-tools">
              <button type="button" className="btn btn-sm btn-ghost" disabled={sessions.loading} onClick={() => sessions.reload()}>
                {sessions.loading ? '刷新中…' : '刷新'}
              </button>
            </div>
          </header>
          <div className="panel-body flush">
            <div className="panel-pad">
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
                      width: '240px',
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
                      title: '每轮声明工具',
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
          </div>
        </section>
      )}
    </div>
  );
}
