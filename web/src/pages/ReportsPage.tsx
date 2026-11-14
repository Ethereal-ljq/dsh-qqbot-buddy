/**
 * pages/ReportsPage —— 群日报 · 卡片模板。
 *
 * master-detail：左侧是内置 + 自定义模板清单，右侧把后端渲染的真实模板 HTML 放进
 * sandbox iframe 预览（与投递的 JPEG 卡片同源同数据）。氛围切换只影响带插画的模板；
 * 「设为当前配置档模板」写 profile.data.daily.template。
 *
 * 模板列表 / 预览 / 安装 / 删除接口未装配（404/501）时给出可操作空态，不白屏。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { api, toApiError, type ApiError } from '../api/client';
import type {
  Profile, ReportTemplate, ReportTemplateInstallResult, ReportTemplateMood,
} from '../api/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Drawer } from '../components/Drawer';
import { EmptyState } from '../components/EmptyState';
import { ErrorNote } from '../components/ErrorNote';
import { PageHeader } from '../components/PageHeader';
import { Badge } from '../components/Status';
import { TemplateInstallDrawer } from '../components/TemplateInstallDrawer';
import { TemplatePreviewFrame } from '../components/TemplatePreviewFrame';
import { useApi } from '../state/useApi';
import { useApp } from '../state/AppContext';
import '../reports.css';

/**
 * 示例氛围不再写死：由所选模板的 meta.json visuals.moods 决定（后端 summary）。
 * 没有声明插画槽的模板不显示氛围切换。
 *
 * 氛围有三种模式（对应配置里的 daily.visualMode）：
 *   auto   模型选择 / 按时段：预览不指定 mood，后端按示例数据高峰时段兜底；
 *   random 随机：后端每次从模板氛围里摇一个；
 *   fixed  指定：用户点具体氛围。
 */
export type ReportMoodMode = 'auto' | 'random' | 'fixed';

const MOOD_MODES: ReadonlyArray<{ id: ReportMoodMode; label: string }> = [
  { id: 'auto', label: '模型选择' },
  { id: 'random', label: '随机' },
  { id: 'fixed', label: '指定' },
];

/** 模板列表加载失败的下一步建议（501=后端未装 / dataDir 未配置，0=服务未启动）。 */
function listErrorHint(error: ApiError): string {
  if (error.status === 0) return '无法连接控制台服务：确认插件进程与控制台端口（默认 127.0.0.1:6198）已启动。';
  if (error.status === 501) return '模板列表接口未就绪：确认数据目录（dataDir）已配置，且控制台后端已加载日报模块。';
  return '加载失败可先刷新；仍失败时检查控制台日志与数据目录（dataDir）配置。';
}

/** 预览失败的下一步建议（404=模板缺失 / 501=后端未装 / 0=服务未启动）。 */
function previewErrorHint(error: ApiError): string {
  if (error.status === 0) return '无法连接控制台服务：确认插件进程与控制台端口（默认 127.0.0.1:6198）已启动。';
  if (error.status === 501) return '后端未装配模板预览接口：确认控制台版本已加载 lib/console/api/reports.js 的预览路由。';
  if (error.status === 404) return '模板不存在：可能已被删除，或自定义模板还没装进 <dataDir>/templates/<名字>/index.html；刷新左侧列表后重试。';
  return '模板读取失败：检查模板文件（index.html 与 assets/ 资源）是否完整；也可以先在左侧换一个模板试试。';
}

/** 当前配置档的 daily.template；没有返回空串（页面显示“跟随默认 journal”）。 */
function readDailyTemplate(profile: Profile | null): string {
  const daily = profile?.data?.daily;
  if (!daily || typeof daily !== 'object' || Array.isArray(daily)) return '';
  const template = (daily as Record<string, unknown>).template;
  return typeof template === 'string' ? template : '';
}

/** 当前配置档的插画氛围设置（daily.visualMode / daily.visualMood）。 */
function readDailyVisual(profile: Profile | null): { mode: ReportMoodMode; mood: string } {
  const daily = profile?.data?.daily;
  if (!daily || typeof daily !== 'object' || Array.isArray(daily)) return { mode: 'auto', mood: '' };
  const data = daily as Record<string, unknown>;
  const mode = data.visualMode === 'random' || data.visualMode === 'fixed' ? data.visualMode : 'auto';
  const mood = typeof data.visualMood === 'string' ? data.visualMood : '';
  return { mode, mood };
}

export function ReportsPage() {
  const { activeProfile, reloadState, notify } = useApp();
  const templates = useApi((signal) => api.listReportTemplates(signal), []);
  const items = useMemo(() => templates.data?.items ?? [], [templates.data]);
  const dataDir = templates.data?.dataDir ?? '';
  const dailyTemplate = readDailyTemplate(activeProfile);
  const dailyVisual = readDailyVisual(activeProfile);
  const currentTemplateText = dailyTemplate === ''
    ? '跟随默认 journal'
    : dailyTemplate === 'off' ? 'off（只发文本）' : dailyTemplate;

  const [selectedName, setSelectedName] = useState('');
  /** 安装成功后等列表刷新完再选中新模板（列表里还没有它时先挂起）。 */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const [mood, setMood] = useState<ReportTemplateMood>('');
  const [moodMode, setMoodMode] = useState<ReportMoodMode>('auto');

  // 配置档里的氛围设置回填到预览控件（保存时再写回去）。
  useEffect(() => {
    setMoodMode(dailyVisual.mode);
    if (dailyVisual.mood !== '') setMood(dailyVisual.mood);
  }, [dailyVisual.mode, dailyVisual.mood]);
  const [renderNonce, setRenderNonce] = useState(0);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ReportTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [applying, setApplying] = useState(false);
  /** 用户手动点选过模板后，不再被「当前配置档模板」自动覆盖选中项。 */
  const manualPick = useRef(false);

  const selected = items.find((item) => item.name === selectedName) ?? null;
  const listLoading = templates.loading && items.length === 0;
  const listError = templates.error && items.length === 0;
  /** 所选模板声明的氛围（没有插画槽时为空数组）。 */
  const moodOptions = selected?.visuals?.moods ?? [];
  /** 实际生效的氛围：用户选的仍在声明里就用它，否则回落到模板默认/第一个。 */
  const activeMood = moodOptions.some((item) => item.id === mood)
    ? mood
    : (selected?.visuals?.defaultMood || moodOptions[0]?.id || '');

  // 选中态：优先当前配置档模板，其次第一个；安装成功后选中新模板。
  // 注意：模板列表与 /api/state 是并行加载的，daily.template 可能晚于列表到达，
  // 所以每次都能被「尚未手动选择」的偏好纠正，而不是只在首次初始化时选一次。
  useEffect(() => {
    if (pendingSelect) {
      if (items.some((item) => item.name === pendingSelect)) {
        manualPick.current = true;
        setSelectedName(pendingSelect);
        setPendingSelect(null);
      } else if (templates.error) {
        setPendingSelect(null);
      }
      return;
    }
    if (items.length === 0) {
      if (selectedName !== '') setSelectedName('');
      return;
    }
    const preferred = items.find((item) => item.name === dailyTemplate)?.name ?? '';
    const fallback = preferred !== '' ? preferred : items[0].name;
    if (!manualPick.current) {
      if (selectedName !== fallback) setSelectedName(fallback);
      return;
    }
    if (!items.some((item) => item.name === selectedName)) setSelectedName(fallback);
  }, [items, selectedName, pendingSelect, dailyTemplate, templates.error]);

  /** 手动点选模板（之后不再被配置档偏好改掉）。 */
  const selectTemplate = (name: string) => {
    manualPick.current = true;
    setSelectedName(name);
  };

  /** 预览要传给后端的 mood：auto 不传（后端按时段兜底）、random 传 random、fixed 传具体值。 */
  const moodParam = moodOptions.length === 0
    ? undefined
    : moodMode === 'fixed'
      ? (activeMood || undefined)
      : moodMode === 'random' ? 'random' : undefined;

  const preview = useApi(
    (signal) => (selectedName === ''
      ? Promise.resolve(null)
      : api.previewReportTemplate(
        selectedName,
        { mood: moodParam, meta: true },
        signal,
      )),
    [selectedName, moodParam, renderNonce],
  );
  // 切换模板后旧响应可能短暂留在 state 里：只认与当前选中项同名的数据。
  const previewData = preview.data && preview.data.name === selectedName ? preview.data : null;
  const activePreview = previewData;
  /** 预览文档地址：iframe 直接加载（独立响应，模板内联脚本不受控制台 CSP 限制）。 */
  const previewSrc = selectedName === ''
    ? ''
    : api.reportTemplatePreviewUrl(selectedName, { mood: moodParam });
  const previewLoading = selectedName !== '' && (preview.loading || (!previewData && !preview.error));
  const inUse = selected !== null && dailyTemplate === selected.name;
  /** 预览实际生效的氛围（auto/random 由后端决定，页面展示返回的 id）。 */
  const previewMood = activePreview?.mood || '';
  const moodLabel = moodOptions.find((item) => item.id === previewMood)?.label ?? previewMood;

  const applyToProfile = async () => {
    if (!selected || !activeProfile) return;
    setApplying(true);
    try {
      // 模板 + 氛围选择一起写回配置档；没有插画槽的模板不写氛围字段。
      const daily = moodOptions.length > 0
        ? { template: selected.name, visualMode: moodMode, visualMood: moodMode === 'fixed' ? activeMood : '' }
        : { template: selected.name };
      await api.updateProfile(activeProfile.id, { data: { daily } });
      notify('ok', '已应用模板与氛围：' + selected.label + (moodOptions.length > 0 ? ' · ' + MOOD_MODES.find((m) => m.id === moodMode)?.label : ''));
      await reloadState();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '设置失败：' + error.message, error.code);
    } finally {
      setApplying(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteReportTemplate(deleteTarget.name);
      notify('ok', '已删除模板：' + deleteTarget.label);
      setDeleteTarget(null);
      templates.reload();
    } catch (err) {
      const error = toApiError(err);
      notify('error', '删除失败：' + error.message, error.code);
    } finally {
      setDeleting(false);
    }
  };

  const handleInstalled = (result: ReportTemplateInstallResult) => {
    notify('ok', '已安装模板：' + (result.label || result.name));
    setInstallOpen(false);
    setPendingSelect(result.name);
    templates.reload();
  };

  let detail: ReactNode;
  if (listLoading) {
    detail = (
      <section className="panel">
        <div className="panel-pad"><span className="skeleton skeleton-block" /></div>
      </section>
    );
  } else if (listError && templates.error) {
    detail = (
      <section className="panel">
        <div className="panel-pad">
          <ErrorNote error={templates.error} onRetry={templates.reload} />
          <p className="muted tpl-error-hint">{listErrorHint(templates.error)}</p>
        </div>
      </section>
    );
  } else if (!selected) {
    detail = (
      <section className="panel">
        <div className="panel-pad">
          {items.length === 0 ? (
            <EmptyState
              title="还没有可用模板"
              description="内置模板（journal / dark）随插件发布；自定义模板放在 <dataDir>/templates/<名字>/index.html 后刷新，或用右上角「新增模板」直接安装。"
              endpoint="GET /api/reports/templates"
              action={<button type="button" className="btn btn-primary btn-sm" onClick={() => setInstallOpen(true)}>新增模板</button>}
            />
          ) : (
            <EmptyState
              title="选择左侧模板"
              description="右侧会显示该模板用示例数据渲染的真实卡片；切换氛围可换插画。"
            />
          )}
        </div>
      </section>
    );
  } else {
    detail = (
      <section className="panel">
        <header className="panel-head">
          <div>
            <h2 className="panel-title">
              {selected.label}
              {' '}
              {selected.builtin ? <Badge tone="idle">内置</Badge> : <Badge tone="ok">自定义</Badge>}
            </h2>
            <p className="panel-desc">{selected.description || '（模板未写描述）'}</p>
          </div>
          <div className="panel-tools">
            {inUse ? <Badge tone="ok">当前使用</Badge> : (
              <button
                type="button"
                className="btn btn-sm"
                disabled={!activeProfile || applying}
                title={activeProfile ? '把当前配置档的 daily.template 设为该模板' : '先选择机器人（并创建配置档）后才能设为当前模板'}
                onClick={() => void applyToProfile()}
              >
                {applying ? '设置中…' : '应用模板与氛围'}
              </button>
            )}
            {selected.builtin ? null : (
              <button type="button" className="btn btn-sm btn-danger-text" onClick={() => setDeleteTarget(selected)}>删除</button>
            )}
          </div>
        </header>

        <div className="panel-tools-row tpl-tools">
          {moodOptions.length > 0 ? (
            <>
              <span className="tpl-mood-label">氛围</span>
              <div className="segmented" role="group" aria-label="氛围选择模式">
                {MOOD_MODES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={'seg-btn' + (moodMode === item.id ? ' active' : '')}
                    aria-pressed={moodMode === item.id}
                    onClick={() => setMoodMode(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {moodMode === 'fixed' ? (
                <div className="segmented" role="group" aria-label="指定氛围">
                  {moodOptions.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={'seg-btn' + (activeMood === item.id ? ' active' : '')}
                      aria-pressed={activeMood === item.id}
                      onClick={() => setMood(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <span className="muted tpl-mood-hint">
                {moodMode === 'auto'
                  ? '模型没选时按高峰时段兜底'
                  : moodMode === 'random'
                    ? '每次预览随机一组（点「重新渲染」再摇）'
                    : '固定使用选中的氛围'}
                {'（保存时写入当前配置档）'}
              </span>
            </>
          ) : (
            <span className="muted tpl-mood-hint">该模板没有声明插画槽，无氛围切换</span>
          )}
          <span className="editor-tabs-spacer" />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={!activePreview}
            onClick={() => {
              // 重新拉一次预览（会重读模板文件），再强制 iframe 重挂载。
              preview.reload();
              setRenderNonce((value) => value + 1);
            }}
          >
            重新渲染
          </button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={!activePreview} onClick={() => setZoomOpen(true)}>
            放大预览
          </button>
        </div>

        <div className="tpl-stage">
          {preview.error ? (
            <div className="tpl-stage-error">
              <ErrorNote error={preview.error} onRetry={preview.reload} />
              <p className="muted tpl-error-hint">{previewErrorHint(preview.error)}</p>
            </div>
          ) : null}
          {!preview.error ? (
            <TemplatePreviewFrame
              key={selected.name + ':' + renderNonce + ':' + moodMode + ':' + (moodParam ?? '')}
              src={previewSrc}
              width={activePreview?.width ?? 1200}
            />
          ) : null}
          {previewLoading ? <p className="muted tpl-stage-status">正在加载模板预览…</p> : null}
          {activePreview && preview.loading ? <span className="tpl-stage-busy mono">更新中…</span> : null}
        </div>

        <footer className="panel-foot tpl-foot">
          <span className="muted mono tpl-foot-meta">模板名：{selected.name} · {selected.builtin ? '内置模板' : '自定义模板'}</span>
          <span className="muted mono tpl-foot-meta">数据目录：{dataDir || '—'}</span>
        </footer>
      </section>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="群日报"
        description="群日报卡片模板：左侧选模板，右侧是该模板用示例数据渲染的真实卡片。生成时间、投递方式在「配置档 → 群日报」里设置。"
        meta={(
          <span className="cell-inline">
            <Badge tone="info" mono>{items.length} 套模板</Badge>
            {activeProfile ? (
              <span className="muted">当前配置档：<span className="mono">{currentTemplateText}</span></span>
            ) : (
              <span className="muted">未选择机器人 / 配置档</span>
            )}
          </span>
        )}
        actions={(
          <>
            <button
              type="button"
              className="btn btn-sm"
              disabled={templates.loading}
              onClick={() => {
                templates.reload();
                setRenderNonce((value) => value + 1);
              }}
            >
              {templates.loading ? '刷新中…' : '刷新'}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setInstallOpen(true)}>新增模板</button>
          </>
        )}
      />

      <div className="hint-strip">
        <span className="hint-label">预览</span>
        <span className="hint-text">
          浏览器里直接渲染模板 HTML，与投递的 JPEG 卡片同源同数据；字体回退以本机为准。氛围切换由模板 meta.json 的 visuals 声明，没有插画槽的模板不显示切换。
        </span>
      </div>

      <div className="master-detail tpl-layout">
        <aside className="master">
          <header className="master-head">
            <span className="master-title">卡片模板</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setInstallOpen(true)}>新增</button>
          </header>
          <ul className="master-list">
            {listLoading ? [0, 1, 2].map((index) => (
              <li key={'tpl-skeleton-' + index} className="tpl-master-skeleton">
                <span className="skeleton" />
                <span className="skeleton tpl-master-skeleton-meta" />
              </li>
            )) : null}
            {items.map((item) => (
              <li key={item.name}>
                <button
                  type="button"
                  className={'master-item' + (item.name === selectedName ? ' active' : '')}
                  aria-current={item.name === selectedName ? 'true' : undefined}
                  onClick={() => selectTemplate(item.name)}
                >
                  <span className="master-name tpl-master-name" title={item.label}>{item.label}</span>
                  <span className="master-meta tpl-master-meta">
                    {item.builtin ? <Badge tone="idle">内置</Badge> : <Badge tone="ok">自定义</Badge>}
                    <span className="mono tpl-master-code">{item.name}</span>
                    {item.name === dailyTemplate ? <Badge tone="info">使用中</Badge> : null}
                  </span>
                </button>
              </li>
            ))}
            {!listLoading && listError ? <li className="master-empty">模板清单加载失败，见右侧说明</li> : null}
            {!listLoading && !listError && items.length === 0 ? <li className="master-empty">暂无可用模板</li> : null}
          </ul>
          <p className="master-hint">
            模板目录：&lt;dataDir&gt;/templates/&lt;名字&gt;/index.html；内置模板随插件发布，不可删除。装好自定义模板后刷新即可在这里看到。
          </p>
        </aside>

        {detail}
      </div>

      {/* 放大预览：完整模板、不裁切，抽屉 body 自己滚动 */}
      <Drawer
        open={zoomOpen && selected !== null}
        title="放大预览"
        subtitle={selected ? selected.label + ' · ' + selected.name : undefined}
        width={1000}
        onClose={() => setZoomOpen(false)}
        footer={<button type="button" className="btn btn-ghost" onClick={() => setZoomOpen(false)}>关闭</button>}
      >
        <div className="tpl-zoom">
          <p className="muted mono tpl-zoom-meta">
            逻辑宽度 {activePreview?.width ?? 1200}px · 示例日期 {activePreview?.day || '今天'} · 氛围 {moodLabel}
          </p>
          <TemplatePreviewFrame src={previewSrc} width={activePreview?.width ?? 1200} />
        </div>
      </Drawer>

      <TemplateInstallDrawer
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        onInstalled={handleInstalled}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除自定义模板"
        message={(
          <span>
            删除模板 <strong>{deleteTarget?.label}</strong>
            （<span className="mono">{deleteTarget?.name}</span>）？会移除
            <span className="mono"> &lt;dataDir&gt;/templates/{deleteTarget?.name}</span>
            目录及其资源，无法恢复。已绑定它的配置档需要另选模板。
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
