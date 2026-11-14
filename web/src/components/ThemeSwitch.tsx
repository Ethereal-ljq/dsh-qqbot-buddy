/**
 * components/ThemeSwitch —— 顶栏主题开关：自动 / 浅色 / 深色 三态。
 *
 * 只放图标（标题与 aria-label 提供文案），桌面与窄屏都不挤占顶栏；
 * 状态持久化在 localStorage（见 state/theme.ts），首屏由 index.html 内联脚本应用。
 */
import type { ReactNode } from 'react';

import { setThemeMode, useThemeMode, type ThemeMode } from '../state/theme';

function AutoIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 1.2v1.7M8 13.1v1.7M1.2 8h1.7M13.1 8h1.7M3.2 3.2l1.2 1.2M11.6 11.6l1.2 1.2M12.8 3.2l-1.2 1.2M4.4 11.6l-1.2 1.2"
        stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M13.4 9.6A6.1 6.1 0 0 1 6.4 2.6a6.1 6.1 0 1 0 7 7z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

const OPTIONS: Array<{ mode: ThemeMode; label: string; icon: ReactNode }> = [
  { mode: 'auto', label: '跟随系统', icon: <AutoIcon /> },
  { mode: 'light', label: '浅色模式', icon: <SunIcon /> },
  { mode: 'dark', label: '深色模式', icon: <MoonIcon /> },
];

export function ThemeSwitch() {
  const mode = useThemeMode();
  return (
    <div className="theme-switch" role="group" aria-label="界面主题">
      {OPTIONS.map((option) => (
        <button
          key={option.mode}
          type="button"
          aria-label={option.label}
          aria-pressed={mode === option.mode}
          title={option.label}
          onClick={() => setThemeMode(option.mode)}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
