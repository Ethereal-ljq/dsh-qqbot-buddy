/**
 * components/ErrorNote —— 行内错误提示：消息 + code/requestId + 重试。
 */
import type { ApiError } from '../api/client';

export function ErrorNote({ error, onRetry, compact = false }: {
  error: ApiError;
  onRetry?: () => void;
  compact?: boolean;
}) {
  if (error.unimplemented) {
    return (
      <div className={'note note-pending' + (compact ? ' compact' : '')}>
        <span className="note-title">后端能力尚未接入（HTTP {error.status}）</span>
        <span className="note-text">{error.message}</span>
        {onRetry ? <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>重试</button> : null}
      </div>
    );
  }
  return (
    <div className={'note note-error' + (compact ? ' compact' : '')} role="alert">
      <span className="note-title">{error.message}</span>
      <span className="note-meta mono">
        {error.code ? error.code : 'error'}
        {error.requestId ? ' · req ' + error.requestId : ''}
      </span>
      {onRetry ? <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>重试</button> : null}
    </div>
  );
}
