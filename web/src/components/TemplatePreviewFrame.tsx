/**
 * components/TemplatePreviewFrame —— 群日报卡片模板预览框。
 *
 * 后端把模板渲染成自包含 HTML（资源已内联、示例数据已注入，带窄 CSP）并通过
 * GET /api/reports/templates/preview/html 直接吐出文档；这里用 sandbox iframe 的 src
 * 加载再按容器宽度等比缩放整页 —— 1200px 宽的卡片在小面板里不裁切。
 * 不走 srcdoc 的原因：srcdoc 会继承控制台 script-src 'self' 的 CSP，模板内联脚本会被拦掉。
 *
 * 高度协议（与 lib/reports/preview.js 注入的脚本一致）：
 *   模板页加载后向 parent 发 { type: 'qqbot:report-preview', height }，
 *   这里校验 event.source 后把 iframe 的逻辑高度换成真实内容高度；
 *   首帧先给一个很小的逻辑高度（420），让模板量到的 scrollHeight 就是内容真实高度；
 *   1.5s 内没收到消息再退到 1800 兜底，模板脚本报错也不至于空白。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const DEFAULT_FRAME_WIDTH = 1200;
/**
 * 首帧逻辑高度：刻意远小于卡片实际高度。iframe 视口比内容矮时，
 * 模板注入脚本量到的 scrollHeight 才是真实内容高度；若首帧给 1800，
 * 内容不足 1800 的模板会一直报 1800，底部留一条模板自身的 body 背景。
 */
const INITIAL_FRAME_HEIGHT = 420;
/** 兜底高度：1.5s 内没收到高度消息（模板脚本报错等）时使用。 */
const FALLBACK_FRAME_HEIGHT = 1800;
const MIN_FRAME_HEIGHT = 200;
const MAX_FRAME_HEIGHT = 20_000;

export function TemplatePreviewFrame({ src, width, maxHeight, className }: {
  /** 预览文档地址（同源 /api/reports/templates/preview/html?...，带 cookie 鉴权）。 */
  src: string;
  /** iframe 逻辑宽度（后端返回的 width，缺省 1200）。 */
  width?: number;
  /** 传入时把外层限制到该高度并可纵向滚动（缩略图场景）；页面主预览不传。 */
  maxHeight?: number;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [frameHeight, setFrameHeight] = useState(INITIAL_FRAME_HEIGHT);
  const reportedRef = useRef(false);

  const frameWidth = width !== undefined && Number.isFinite(width) && width > 0 ? width : DEFAULT_FRAME_WIDTH;

  // 容器宽度 → 缩放比。先同步量一次，避免首帧按 1200px 逻辑宽度溢出。
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setHostWidth(host.clientWidth);
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const next = entry ? entry.contentRect.width : host.clientWidth;
      setHostWidth(next);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // 新文档：回到首帧小高度等模板脚本上报；1.5s 没上报就退到兜底高度。
  useEffect(() => {
    reportedRef.current = false;
    setFrameHeight(INITIAL_FRAME_HEIGHT);
    const timer = window.setTimeout(() => {
      if (!reportedRef.current) setFrameHeight(FALLBACK_FRAME_HEIGHT);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [src]);

  // 高度上报：只接受来自本 iframe 的消息，避免同页其它窗口的消息串进来。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object') return;
      const message = data as { type?: unknown; height?: unknown };
      if (message.type !== 'qqbot:report-preview') return;
      const height = Number(message.height);
      if (!Number.isFinite(height)) return;
      reportedRef.current = true;
      setFrameHeight(Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(height))));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const scale = hostWidth > 0 ? hostWidth / frameWidth : 1;

  return (
    <div
      ref={hostRef}
      className={'tpl-frame' + (className ? ' ' + className : '')}
      style={maxHeight !== undefined ? { maxHeight, overflowY: 'auto' } : undefined}
      aria-label="日报模板预览"
    >
      <div
        className="tpl-frame-inner"
        style={{ width: frameWidth * scale, height: frameHeight * scale }}
      >
        <iframe
          ref={frameRef}
          className="tpl-frame-body"
          title="日报模板预览"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={src}
          style={{ width: frameWidth, height: frameHeight, transform: 'scale(' + scale + ')' }}
        />
      </div>
    </div>
  );
}
