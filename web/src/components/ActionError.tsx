/**
 * components/ActionError —— 动作失败的行内提示（映射中文文案 + 原始 code/requestId）。
 */
import type { ApiError } from '../api/client';
import { actionFeedback } from '../lib/actions';

export function ActionError({ error, onRetry, compact = true }: {
  error: ApiError;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const feedback = actionFeedback(error);
  return (
    <div className={'note note-error' + (compact ? ' compact' : '')} role="alert">
      <span className="note-title">{feedback.message}</span>
      {feedback.detail ? <span className="note-meta mono">{feedback.detail}</span> : null}
      {onRetry ? <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>重试</button> : null}
    </div>
  );
}
