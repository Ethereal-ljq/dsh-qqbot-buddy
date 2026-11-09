/**
 * components/PromptPreview —— 提示词拼合预览（配置档页「提示词预览」子 tab）。
 *
 * 契约：GET /api/preview/prompt?bot=&profile=&peer=&query=&scope=group|c2c
 *   → { ok, source, sections:[{name,label,text,chars}], text, notes, toolNames, skillNames }
 *
 * 说明：这里只展示本插件注册的 prompt 段；宿主段（身份/工具 schema 等）由 dsh 运行时追加。
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

  const copy = async (text: string, label: string) => {
    const ok = await copyToClipboard(text);
    notify(ok ? 'ok' : 'error', ok ? label : '复制失败，请手动选择文本后复制');
  };

  const data = preview.data;
  const fullChars = data ? Array.from(data.text).length : 0;
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
          仅展示本插件注册的 prompt 段；宿主段（身份、工具 schema、运行时上下文等）由 dsh 在运行时追加，不在此列表中。
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
            <Badge tone="info" mono>source: {data.source}</Badge>
            <span className="mono">{data.sections.length} 段 · {fullChars} 字符</span>
            <span className="mono">工具 {data.toolNames.length}</span>
            <span className="mono">技能 {data.skillNames.length}</span>
            <span className="muted">配置档：{profileName}</span>
            <span className="muted mono">{scope === 'group' ? '群聊' : '私聊'}{appliedPeer ? ' · ' + appliedPeer : ''}</span>
          </div>

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
                    {section.empty ? <span className="tag prompt-empty-tag">空段</span> : null}
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

          <div className="preview-chips">
            <div className="preview-chip-group">
              <h3 className="preview-subtitle">工具（{data.toolNames.length}）</h3>
              {data.toolNames.length > 0 ? (
                <div className="tag-list">
                  {data.toolNames.map((name) => <span className="tag mono" key={name}>{name}</span>)}
                </div>
              ) : <p className="muted">无</p>}
            </div>
            <div className="preview-chip-group">
              <h3 className="preview-subtitle">技能（{data.skillNames.length}）</h3>
              {data.skillNames.length > 0 ? (
                <div className="tag-list">
                  {data.skillNames.map((name) => <span className="tag mono" key={name}>{name}</span>)}
                </div>
              ) : <p className="muted">无</p>}
            </div>
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
