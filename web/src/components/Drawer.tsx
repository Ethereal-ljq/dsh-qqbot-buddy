/**
 * components/Drawer —— 右侧表单抽屉（新建/编辑用）。
 * Esc 关闭、遮罩点击关闭、打开时锁定页面滚动并把焦点放进第一个输入。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Drawer({ open, title, subtitle, onClose, children, footer, width }: {
  open: boolean;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // onClose 通常是父组件的内联箭头函数（每次渲染都是新引用）。若直接放进 effect 依赖，
  // 父组件每敲一个字重渲染就会重跑 effect，40ms 后把焦点抢到抽屉里第一个可聚焦元素
  // （DOM 头部顺序是关闭按钮）——表现就是「输入一个字符，输入框焦点跳出」。这里用 ref
  // 保存最新回调，effect 只跟随 open 变化，保证焦点只在打开时接管一次。
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      // 用户已经聚焦在抽屉内（例如正在输入）时不抢焦点。
      const active = document.activeElement;
      if (active && active instanceof HTMLElement && panel.contains(active)) return;
      // 优先第一个输入控件；没有输入控件才退回按钮（避免把焦点给头部关闭按钮）。
      const target = panel.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select')
        ?? panel.querySelector<HTMLElement>('button');
      target?.focus();
    }, 40);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(timer);
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <aside
        ref={panelRef}
        className="drawer"
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title">{title}</h2>
            {subtitle ? <p className="drawer-subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn drawer-close" onClick={onClose} aria-label="关闭">×</button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <footer className="drawer-foot">{footer}</footer> : null}
      </aside>
    </div>,
    document.body,
  );
}
