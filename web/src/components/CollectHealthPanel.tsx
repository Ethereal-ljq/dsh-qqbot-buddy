/**
 * components/CollectHealthPanel —— 记忆「提炼健康度」面板。
 *
 * 数据源：GET /api/memories/health（后端直读 job_state 里 job='memory-collect' 的行）。
 * 自动提炼以前是「跑了但 0 入库」的黑盒，这里把最近结局 / 连续失败 / 轮次计数摆出来：
 * - saved            已入库（绿）
 * - all-deduped      抽出的内容全部命中已有记忆（蓝）
 * - parse-empty      模型没产出可用事实（黄）
 * - llm-error        模型调用失败或超时（红）
 * - empty-transcript 转录为空（灰）
 * - no-route         没有可用模型路由（红）——去「模型」页设置 provider/model
 * 说明：这里直接用 api/client 的 request()，不往 client.ts 的 api 对象加方法，保持改动面最小。
 */
import { useMemo } from 'react';

import { request } from '../api/client';
import { Badge, type Tone } from './Status';
import { DataTable, type Column } from './DataTable';
import { EmptyState } from './EmptyState';
import { ErrorNote } from './ErrorNote';
import { fmtDateTime, fmtRelative, fmtTimeSmart, truncate } from '../lib/format';
import { useApi } from '../state/useApi';

/** GET /api/memories/health 返回项（camelCase；字段语义见 lib/console/api/memories.js）。 */
export interface MemoryCollectState {
  botId: string;
  peer: string;
  /** 距下次自动触发的轮次计数（触发后清零）。 */
  rounds: number;
  /** 最近一次真正跑完提炼的时间；null = 只累计过轮次、还没跑过。 */
  lastRunAt: number | null;
  /** 最近一次入库条数（新增 + 去重命中）。 */
  lastSaved: number;
  /** saved / all-deduped / parse-empty / llm-error / empty-transcript / busy / ''（旧数据未记录）。 */
  lastOutcome: string;
  lastReason: string;
  /** 最近一次解析出的事实条数。 */
  lastFacts: number;
  /** 连续失败次数；saved / all-deduped 视为成功并清零。 */
  failureCount: number;
  /** job_state 行的 updated_at：轮次计数写入也会刷新它。 */
  updatedAt: number | null;
}

interface OutcomeMeta {
  label: string;
  tone: Tone;
  /** 是否计入 failureCount（与 collector.markOutcome 的判定一致）。 */
  failed: boolean;
}

const OUTCOME_META: Record<string, OutcomeMeta> = {
  saved: { label: '已入库', tone: 'ok', failed: false },
  'all-deduped': { label: '全部去重', tone: 'info', failed: false },
  'parse-empty': { label: '解析为空', tone: 'warn', failed: true },
  'llm-error': { label: '模型错误', tone: 'danger', failed: true },
  'empty-transcript': { label: '转录为空', tone: 'idle', failed: true },
  busy: { label: '并发占用', tone: 'idle', failed: true },
  // 没有可用模型路由：旁路 LLM 不传 provider 会被拒绝（NO_ADAPTER），所以提前拦下
  'no-route': { label: '未配置模型', tone: 'danger', failed: true },
};

function outcomeMeta(outcome: string): OutcomeMeta {
  return OUTCOME_META[outcome] || { label: '未记录', tone: 'idle', failed: false };
}

function toCount(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function toTime(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
}

/** 宽容归一后端数组：坏行丢弃而不是整页报错。 */
function normalizeStates(raw: unknown): MemoryCollectState[] {
  if (!Array.isArray(raw)) return [];
  const states: MemoryCollectState[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    states.push({
      botId: typeof row.botId === 'string' ? row.botId : '',
      peer: typeof row.peer === 'string' ? row.peer : '',
      rounds: toCount(row.rounds),
      lastRunAt: toTime(row.lastRunAt),
      lastSaved: toCount(row.lastSaved),
      lastOutcome: typeof row.lastOutcome === 'string' ? row.lastOutcome : '',
      lastReason: typeof row.lastReason === 'string' ? row.lastReason : '',
      lastFacts: toCount(row.lastFacts),
      failureCount: toCount(row.failureCount),
      updatedAt: toTime(row.updatedAt),
    });
  }
  return states;
}

function fetchCollectHealth(botId: string, signal: AbortSignal): Promise<MemoryCollectState[]> {
  return request<unknown>('/memories/health', { query: { bot: botId, limit: 200 }, signal })
    .then(normalizeStates);
}

/** 结局单元格：中文标签 + 颜色，失败结局把原因作为第二行（省略号 + title 全文）。 */
function OutcomeCell({ state }: { state: MemoryCollectState }) {
  if (state.lastOutcome === '') {
    return (
      <div className="cell-stack">
        <span className="cell-inline"><Badge tone="idle">未记录</Badge></span>
        <span className="cell-sub">{state.lastRunAt ? '修复前的旧记录没有结局字段' : '只累计过轮次，还没触发过提炼'}</span>
      </div>
    );
  }
  const meta = outcomeMeta(state.lastOutcome);
  return (
    <div className="cell-stack">
      <span className="cell-inline"><Badge tone={meta.tone}>{meta.label}</Badge></span>
      {state.lastReason && state.lastReason !== meta.label ? (
        <span className={meta.failed ? 'cell-error' : 'cell-sub'} title={state.lastReason}>
          {truncate(state.lastReason, 42)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 提炼健康度面板。
 * @param props.botId 作用域机器人（面板只展示该 bot 的 job_state 行）
 * @param props.refreshKey 父页面在手动提炼后自增，用于触发重取
 */
export function CollectHealthPanel({ botId, refreshKey = 0 }: { botId: string; refreshKey?: number }) {
  const health = useApi(
    (signal) => (botId ? fetchCollectHealth(botId, signal) : Promise.resolve([])),
    [botId, refreshKey],
  );
  const states = useMemo(() => health.data ?? [], [health.data]);

  // 最近一次真正跑完的提炼（轮次计数更新不算）
  const latest = useMemo(() => {
    let found: MemoryCollectState | null = null;
    for (const row of states) {
      if (row.lastRunAt === null) continue;
      if (!found || row.lastRunAt > (found.lastRunAt ?? 0)) found = row;
    }
    return found;
  }, [states]);

  const failed = useMemo(() => states.filter((row) => row.failureCount > 0), [states]);
  const maxFailure = useMemo(
    () => failed.reduce((max, row) => Math.max(max, row.failureCount), 0),
    [failed],
  );
  // 失败最久/最严重的那个会话：用于告警条里给出最近一次失败原因
  const worst = useMemo(() => {
    let found: MemoryCollectState | null = null;
    for (const row of failed) {
      if (!found
        || row.failureCount > found.failureCount
        || (row.failureCount === found.failureCount && (row.updatedAt ?? 0) > (found.updatedAt ?? 0))) {
        found = row;
      }
    }
    return found;
  }, [failed]);

  const todayCount = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const startAt = start.getTime();
    return states.filter((row) => row.lastRunAt !== null && row.lastRunAt >= startAt).length;
  }, [states]);

  const latestMeta = latest ? outcomeMeta(latest.lastOutcome) : null;

  const columns: Array<Column<MemoryCollectState>> = [
    {
      key: 'peer',
      title: '会话 peer',
      width: '300px',
      render: (row) => (
        <div className="cell-stack">
          <span className="mono cell-sub ellipsis" title={row.peer}>{row.peer || '—'}</span>
          <span className="cell-sub">轮次计数 {row.rounds}</span>
        </div>
      ),
    },
    {
      key: 'outcome',
      title: '最近结局',
      width: '220px',
      render: (row) => <OutcomeCell state={row} />,
    },
    {
      key: 'facts',
      title: '抽取事实',
      width: '88px',
      align: 'right',
      render: (row) => <span className="mono cell-sub">{row.lastFacts}</span>,
    },
    {
      key: 'saved',
      title: '入库',
      width: '76px',
      align: 'right',
      render: (row) => <span className="mono cell-sub">{row.lastSaved}</span>,
    },
    {
      key: 'failure',
      title: '连续失败',
      width: '92px',
      align: 'right',
      render: (row) => (row.failureCount > 0
        ? <Badge tone="danger" mono>{row.failureCount}</Badge>
        : <span className="mono cell-sub">0</span>),
    },
    {
      key: 'lastRunAt',
      title: '最近提炼',
      width: '152px',
      render: (row) => (
        <div className="cell-stack">
          <span className="mono cell-sub">{row.lastRunAt ? fmtTimeSmart(row.lastRunAt) : '—'}</span>
          <span className="cell-sub">{row.lastRunAt ? fmtRelative(row.lastRunAt) : '未跑过'}</span>
        </div>
      ),
    },
  ];

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2 className="panel-title">提炼健康度</h2>
          <p className="panel-desc">
            自动提炼每 N 轮触发一次，最近结局记录在 job_state。「跑过但 0 入库」多半不是没触发，而是下面两种结局：parse-empty = 模型没产出可用事实；all-deduped = 抽出的内容与已有记忆重复。
          </p>
        </div>
        <div className="panel-tools">
          <span className="panel-count">{health.loading ? '读取中…' : states.length + ' 个会话'}</span>
          <button type="button" className="btn btn-sm btn-ghost" disabled={health.loading} onClick={health.reload}>刷新</button>
        </div>
      </header>

      {health.error && !health.data ? (
        <div className="panel-pad"><ErrorNote error={health.error} onRetry={health.reload} /></div>
      ) : (
        <>
          {health.error ? (
            <div className="panel-pad"><ErrorNote error={health.error} compact onRetry={health.reload} /></div>
          ) : null}
          <div className="panel-body">
            <div className="stack">
              <div className="readouts readouts-3">
                <div className="readout">
                  <span className="readout-num mono">{latest?.lastRunAt ? fmtRelative(latest.lastRunAt) : '—'}</span>
                  <span className="readout-label">最近一次提炼</span>
                  <span className="readout-sub">
                    {latest?.lastRunAt ? (
                      <>
                        {fmtDateTime(latest.lastRunAt)} ·{' '}
                        <Badge tone={latestMeta?.tone ?? 'idle'}>{latestMeta?.label ?? '未记录'}</Badge>
                      </>
                    ) : '还没有提炼记录'}
                  </span>
                </div>
                <div className="readout">
                  <span className="readout-num mono">{todayCount}</span>
                  <span className="readout-label">今日提炼过（会话）</span>
                  <span className="readout-sub">共 {states.length} 个会话有记录</span>
                </div>
                <div className="readout">
                  <span className="readout-num mono">{maxFailure}</span>
                  <span className="readout-label">最高连续失败</span>
                  <span className="readout-sub">{failed.length > 0 ? failed.length + ' 个会话待关注' : '成功会自动清零'}</span>
                </div>
              </div>

              {failed.length > 0 && worst ? (
                <div className="note note-error" role="alert">
                  <span className="note-title">连续失败 {maxFailure} 次</span>
                  <span className="note-text">
                    {failed.length} 个会话的提炼在连续失败
                    {worst.lastReason ? '；最近原因：' + worst.lastReason : '（原因未记录）'}。
                  </span>
                  <span className="note-meta mono">{worst.peer}</span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="panel-body flush">
            <DataTable
              columns={columns}
              rows={states}
              rowKey={(row) => row.botId + '\u0000' + row.peer}
              loading={health.loading}
              skeletonRows={3}
              empty={(
                <EmptyState
                  compact
                  title="还没有提炼记录"
                  description="自动提炼触发后会在这里留下每个会话的最近结局；也可以点本页右上角「立即提炼」手动跑一次。"
                  endpoint="GET /api/memories/health"
                />
              )}
            />
          </div>
        </>
      )}
    </section>
  );
}
