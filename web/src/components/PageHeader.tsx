/**
 * components/PageHeader —— 页面标题区（标题 / 说明 / 右侧操作）。
 */
import type { ReactNode } from 'react';

export function PageHeader({ title, description, actions, meta }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-main">
        <div className="page-title-row">
          <h1 className="page-title">{title}</h1>
          {meta ? <div className="page-meta">{meta}</div> : null}
        </div>
        {description ? <p className="page-desc">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
