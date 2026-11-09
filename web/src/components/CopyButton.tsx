/**
 * components/CopyButton —— 复制 ID/token 的小按钮（带瞬时反馈，不打扰主流程）。
 */
import { useEffect, useRef, useState } from 'react';

import { truncate } from '../lib/format';

export function CopyButton({ text, display, label = '复制' }: { text: string; display?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* 非安全上下文下复制失败：静默，用户可手动选中 */
    }
  };

  return (
    <span className="copy-wrap">
      <span className="mono copy-text" title={text}>{display ?? truncate(text, 30)}</span>
      <button type="button" className="copy-btn" onClick={() => void copy()} title={copied ? '已复制' : label}>
        {copied ? '已复制' : label}
      </button>
    </span>
  );
}
