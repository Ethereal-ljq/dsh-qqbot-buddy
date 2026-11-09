/**
 * components/EmptyState —— 空态 / 未接入态。
 * 空屏幕是一个行动邀请：说明为什么空、下一步做什么，并给出接口位置。
 */
import type { ReactNode } from 'react';

function InboxIcon() {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" focusable="false">
      <rect x="4.5" y="8.5" width="23" height="16" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 19h7l2.2 3h6.6l2.2-3h7" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function EmptyState({ title, description, action, endpoint, tone = 'neutral', compact = false }: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** 相关接口路径，渲染成等宽小标签，方便对照契约。 */
  endpoint?: string;
  tone?: 'neutral' | 'pending';
  compact?: boolean;
}) {
  return (
    <div className={'empty ' + tone + (compact ? ' compact' : '')}>
      <span className="empty-icon"><InboxIcon /></span>
      <div className="empty-body">
        <p className="empty-title">{title}</p>
        {description ? <p className="empty-desc">{description}</p> : null}
        {endpoint ? <code className="endpoint">{endpoint}</code> : null}
      </div>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
