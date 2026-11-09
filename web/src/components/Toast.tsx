/**
 * components/Toast —— 全局通知（保存成功/失败、接口未接入提示）。
 * 渲染在 body portal，保证不受页面滚动容器影响。
 */
import { createPortal } from 'react-dom';

import { useApp } from '../state/AppContext';

export function ToastHost() {
  const { toasts, dismissToast } = useApp();
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={'toast toast-' + toast.kind} role={toast.kind === 'error' ? 'alert' : 'status'}>
          <span className="toast-bar" aria-hidden="true" />
          <div className="toast-body">
            <p className="toast-message">{toast.message}</p>
            {toast.detail ? <p className="toast-detail mono">{toast.detail}</p> : null}
          </div>
          <button type="button" className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="关闭通知">×</button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
