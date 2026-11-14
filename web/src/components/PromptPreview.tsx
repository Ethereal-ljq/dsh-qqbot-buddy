/**
 * components/PromptPreview —— 提示词拼合预览（配置档页「提示词预览」子 tab）。
 *
 * 契约：GET /api/preview/prompt?bot=&profile=&peer=&query=&scope=group|c2c&live=0|1
 *   → { ok, source:'live'|'composed', sections, text, notes, tools?, activation?, liveUnavailable? }
 *
 * 有 live 会话时展示**真实 assembly**（宿主段 + 我们的槽位/遮蔽段 + 本次声明的工具）；
 * 没有会话时回落到本插件的模拟拼合，并说明原因。
 * 接口未上线（404）时展示明确的待接入空态，不阻塞配置档编辑。
 */
import { useState } from 'react';

import { api } from '../api/client';
import type { PromptSection } from '../api/types';
import { copyToClipboard } from '../lib/clipboard';
import { useApp } from '../state/AppContext';
import { useApi } from '../state/useApi';
import { EmptyState } from './EmptyState';
import { ErrorNote } from './ErrorNote';
import { Badge } from './Status';

export function PromptPreview({ botId, profileId, profileName, hasUnsavedChanges, unsavedCount, refreshKey }: {
  botId: string;
  profileId: string;
  profileName: string;
  hasUnsavedChanges: boolean;
  unsavedCount: number;
  /** 配置档 updatedAt：保存后自动刷新预览。 */
  refreshKey?: number;
}) {
  const { notify } = useApp();
  const [scope, setScope] = useState<'group' | 'c2c'>('group');
  const [peerDraft, setPeerDraft] = useState('');
  const [queryDraft, setQueryDraft] = useState('');
  const [appliedPeer, setAppliedPeer] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [tick, setTick] = useState(0);

  const preview = useApi((signal) => api.previewPrompt({
    botId,
    profileId,
    scope,
    peer: appliedPeer || undefined,
    query: appliedQuery || undefined,
  }, signal), [botId, profileId, scope, appliedPeer, appliedQuery, tick, refreshKey]);

  const refresh = () => {
    setAppliedPeer(peerDraft.trim());
    setAppliedQuery(queryDraft.trim());
    setTick((value) => value + 1);
  };

  const [rebuilding, setRebuilding] = useState(false);
  const rebuildSession = async () => {
    if (!appliedPeer) return;
    setRebuilding(true);
    try {
      await api.action('reset-peer', { botId, peer: appliedPeer });
      notify('ok', '已重建该会话：新装配在下一条消息生效');
      preview.reload();
    } catch (err) {
      notify('error', '重建会话失败：' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRebuilding(false);
    }
  };

  const copy = async (text: string, label: string) => {
    const ok = await copyToClipboard(text);
    notify(ok ? 'ok' : 'error', ok ? label : '复制失败，请手动选择文本后复制');
  };

  const data = preview.data;
  const isLive = data?.source === 'live';
  const fullChars = data ? (typeof data.chars === 'number' ? data.chars : Array.from(data.text).length) : 0;
  const shadowCount = data ? data.sections.filter((section) => section.kind === 'host' && section.empty).length : 0;
  const declaredTools = data?.tools ?? [];
  const contextSections = data?.contextSections ?? [];
  const peerPlaceholder = scope === 'group' ? 'qq:group:123456（可选）' : 'qq:c2c:OPENID（可选）';

  return (
    <div className="preview">
      <div className="preview-controls">
        <div className="segmented" role="group" aria-label="会话类型">
          <button
            type="button"
            className={'seg-btn' + (scope === 'group' ? ' active' : '')}
            onClick={() => setScope('group')}
          >
            群聊
          </button>
          <button
            type="button"
            className={'seg-btn' + (scope === 'c2c' ? ' active' : '')}
            onClick={() => setScope('c2c')}
          >
            私聊
          </button>
        </div>
        <input
          className="input mono preview-peer"
          value={peerDraft}
          placeholder={peerPlaceholder}
          aria-label="会话 peer"
          onChange={(event) => setPeerDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') refresh(); }}
        />
        <input
          className="input preview-query"
          value={queryDraft}
          placeholder="用户消息 / query（可选，影响记忆与知识召回）"
          aria-label="预览 query"
          onChange={(event) => setQueryDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') refresh(); }}
        />
        <button type="button" className="btn btn-primary btn-sm" onClick={refresh} disabled={preview.loading}>
          {preview.loading ? '刷新中…' : '刷新预览'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!data || data.text === ''}
          onClick={() => void copy(data?.text ?? '', '已复制拼合全文')}
        >
          复制全文
        </button>
      </div>

      <div className="hint-strip">
        <span className="hint-label">范围</span>
        <span className="hint-text">
          填 peer 且该会话有 live agent 时，展示真实 assembly：宿主段、我们的槽位/遮蔽段、以及本次真正声明的工具都在这儿；
          没有 live 会话时退回模拟拼合（只含本插件负责的段）。
        </span>
      </div>

      {hasUnsavedChanges ? (
        <div className="note note-pending">
          <span className="note-title">预览使用已保存配置</span>
          <span className="note-text">
            当前有 {unsavedCount > 0 ? unsavedCount + ' 项设置' : '名称/默认状态'}未保存；保存后预览会自动刷新。
          </span>
        </div>
      ) : null}

      {preview.loading && !data ? (
        <span className="skeleton skeleton-block" />
      ) : preview.error?.unimplemented ? (
        <EmptyState
          tone="pending"
          title="提示词预览接口尚未上线"
          description="后端 GET /api/preview/prompt 上线后本面板自动可用；接口契约已按 sections/notes/toolNames/skillNames 对接。"
          endpoint="GET /api/preview/prompt?bot=…&profile=…&scope=group"
        />
      ) : preview.error ? (
        <ErrorNote error={preview.error} onRetry={preview.reload} />
      ) : data ? (
        <>
          <div className="preview-meta">
            <Badge tone={isLive ? 'ok' : 'info'} mono>{isLive ? '实时 assembly' : '模拟拼合'}</Badge>
            <span className="mono">{data.sections.length} 段 · {fullChars} 字符</span>
            <span className="mono">
              {isLive ? '声明工具 ' + declaredTools.length : '工具 ' + data.toolNames.length}
            </span>
            {isLive ? (
              <span className="mono">已遮蔽 {shadowCount} 段</span>
            ) : (
              <span className="mono">技能 {data.skillNames.length}</span>
            )}
            <span className="muted">配置档：{profileName}</span>
            <span className="muted mono">{scope === 'group' ? '群聊' : '私聊'}{appliedPeer ? ' · ' + appliedPeer : ''}</span>
          </div>

          {data.liveUnavailable ? (
            <div className="note note-pending">
              <span className="note-title">未能读取实时 assembly</span>
              <span className="note-text">原因：{data.liveUnavailable}。发出任意消息（或 /new）让该 peer 建立 live 会话后再刷新。</span>
            </div>
          ) : null}

          {isLive && data.presetStale ? (
            <div className="note note-pending">
              <span className="note-title">装配档未生效</span>
              <span className="note-text">
                该会话仍绑定 preset <code>{data.presetId}</code>，当前配置应为 <code>{data.expectedPresetId}</code>——
                能力/技能改动要等新会话（/new 或重建）才生效。
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={rebuilding || !appliedPeer}
                onClick={() => void rebuildSession()}
              >
                {rebuilding ? '重建中…' : '立即重建该会话'}
              </button>
            </div>
          ) : null}

          {data.notes.length > 0 ? (
            <div className="note note-pending">
              <span className="note-title">拼合提示</span>
              <span className="note-text">{data.notes.join('；')}</span>
            </div>
          ) : null}

          {data.sections.length === 0 ? (
            <EmptyState compact title="没有可展示的 prompt 段" description="该配置档当前没有命中任何插件 prompt 段（或后端返回空 sections）。" />
          ) : (
            <div className="prompt-sections">
              {data.sections.map((section: PromptSection, index: number) => (
                <details className="prompt-section" key={section.name + '-' + index} open={index === 0}>
                  <summary className={'prompt-section-head' + (section.empty ? ' is-empty' : '')}>
                    <span className="prompt-section-name mono">{section.name}</span>
                    <span className="prompt-section-label">{section.label}</span>
                    {section.kind === 'ours' ? <span className="tag">本插件</span> : null}
                    {section.kind === 'host' && section.empty ? <span className="tag prompt-empty-tag">已遮蔽</span> : null}
                    {section.empty && section.kind !== 'host' ? <span className="tag prompt-empty-tag">空段</span> : null}
                    <span className="prompt-section-chars mono">{section.chars} 字符</span>
                    <button
                      type="button"
                      className="copy-btn prompt-section-copy"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void copy(section.text, '已复制段：' + (section.label || section.name));
                      }}
                    >
                      复制本段
                    </button>
                  </summary>
                  <pre className="prompt-section-text mono">{section.text || '（空段）'}</pre>
                </details>
              ))}
            </div>
          )}

          {contextSections.length > 0 ? (
            <section className="preview-contexts">
              <header className="preview-full-head">
                <h3 className="subsection-title">运行时上下文（user 角色快照 · 不进系统提示词前缀）</h3>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={!data.contextText}
                  onClick={() => void copy(data.contextText || '', '已复制运行时上下文')}
                >
                  复制上下文
                </button>
              </header>
              <div className="prompt-sections">
                {contextSections.map((section: PromptSection, index: number) => (
                  <details className="prompt-section" key={'ctx-' + section.name + '-' + index} open={index === 0}>
                    <summary className={'prompt-section-head' + (section.empty ? ' is-empty' : '')}>
                      <span className="prompt-section-name mono">{section.name}</span>
                      <span className="prompt-section-label">{section.label}</span>
                      {section.kind === 'ours' ? <span className="tag">本插件</span> : null}
                      {section.empty ? <span className="tag prompt-empty-tag">空</span> : null}
                      <span className="prompt-section-chars mono">{section.chars} 字符</span>
                    </summary>
                    <pre className="prompt-section-text mono">{section.text || '（空）'}</pre>
                  </details>
                ))}
              </div>
            </section>
          ) : null}

          <div className="preview-chips">
            {isLive ? (
              <div className="preview-chip-group">
                <h3 className="preview-subtitle">本次声明的工具（{declaredTools.length}）</h3>
                {declaredTools.length > 0 ? (
                  <div className="tag-list">
                    {declaredTools.map((tool) => (
                      <span className={'tag mono' + (tool.tier === 'passive' ? ' tag-passive' : '')} key={tool.name} title={tool.tier === 'passive' ? '被动工具（已激活）' : '常驻工具'}>
                        {tool.name}
                      </span>
                    ))}
                  </div>
                ) : <p className="muted">无（全部工具都被策略隐藏）</p>}
                <p className="muted preview-inline-note">
                  被动工具未激活时不会出现在这里；用户点名或 qqbot_enable 点亮后才会声明。
                </p>
              </div>
            ) : (
              <div className="preview-chip-group">
                <h3 className="preview-subtitle">工具（{data.toolNames.length}）</h3>
                {data.toolNames.length > 0 ? (
                  <div className="tag-list">
                    {data.toolNames.map((name) => <span className="tag mono" key={name}>{name}</span>)}
                  </div>
                ) : <p className="muted">无</p>}
              </div>
            )}
            {!isLive ? (
              <div className="preview-chip-group">
                <h3 className="preview-subtitle">技能（{data.skillNames.length}）</h3>
                {data.skillNames.length > 0 ? (
                  <div className="tag-list">
                    {data.skillNames.map((name) => <span className="tag mono" key={name}>{name}</span>)}
                  </div>
                ) : <p className="muted">无</p>}
              </div>
            ) : (
              <div className="preview-chip-group">
                <h3 className="preview-subtitle">激活状态</h3>
                <p className="muted preview-inline-note">
                  能力组：{data.activation && data.activation.groups.length > 0 ? data.activation.groups.join('、') : '无（本轮没有触发被动能力）'}
                  {data.activation && data.activation.tools.length > 0 ? '；点名工具：' + data.activation.tools.join('、') : ''}
                </p>
                <p className="muted preview-inline-note">
                  运行时上下文：{data.contexts && data.contexts.length > 0 ? data.contexts.join('、') : '无（已抑制）'}
                </p>
              </div>
            )}
          </div>

          <section className="preview-full">
            <header className="preview-full-head">
              <h3 className="subsection-title">拼合全文</h3>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={data.text === ''}
                onClick={() => void copy(data.text, '已复制拼合全文')}
              >
                复制全文
              </button>
            </header>
            <pre className="prompt-full mono">{data.text || '（空）'}</pre>
          </section>
        </>
      ) : null}
    </div>
  );
}
