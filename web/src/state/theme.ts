/**
 * state/theme —— 界面主题：自动 / 浅色 / 深色。
 *
 * 首屏防闪烁：index.html 的内联脚本在 JS 包加载前就按 localStorage + 系统偏好
 * 写入 <html data-theme="light|dark">；这里只负责后续切换、持久化与系统偏好跟随。
 * 颜色本身仍由 styles.css 的两套 CSS 变量驱动（:root / :root[data-theme="dark"]），
 * 组件不感知具体色值。
 */
import { useSyncExternalStore } from 'react';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** 与 index.html 内联脚本共用的 localStorage 键。 */
const STORAGE_KEY = 'qqbot.console.theme';
const MODES: ThemeMode[] = ['auto', 'light', 'dark'];

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

function readMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY) || '';
    if ((MODES as string[]).includes(value)) return value as ThemeMode;
  } catch { /* 隐私模式下 localStorage 不可用：回退自动 */ }
  return 'auto';
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemPrefersDark() ? 'dark' : 'light';
}

function applyTheme(next: ResolvedTheme, mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', next);
  root.setAttribute('data-theme-mode', mode);
  root.style.colorScheme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'dark' ? '#101618' : '#eceee9');
}

let mode: ThemeMode = readMode();
let resolved: ResolvedTheme = resolveTheme(mode);
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 初始化（main.tsx 在 render 前调用）：应用当前模式，auto 时跟随系统变化。幂等。 */
export function initTheme(): void {
  applyTheme(resolved, mode);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  let media: MediaQueryList;
  try { media = window.matchMedia('(prefers-color-scheme: dark)'); } catch { return; }
  const onChange = () => {
    if (mode !== 'auto') return;
    const next = resolveTheme(mode);
    if (next === resolved) return;
    resolved = next;
    applyTheme(resolved, mode);
    emit();
  };
  if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
  else if (typeof media.addListener === 'function') media.addListener(onChange);
}

export function getThemeMode(): ThemeMode {
  return mode;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

/** 切换并持久化；'auto' 跟随系统 prefers-color-scheme。 */
export function setThemeMode(next: ThemeMode): void {
  if (!(MODES as string[]).includes(next)) return;
  mode = next;
  try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  resolved = resolveTheme(next);
  applyTheme(resolved, mode);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 组件订阅：只暴露模式（颜色由 CSS 变量负责，无需订阅系统深色值）。 */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode, (): ThemeMode => 'auto');
}
