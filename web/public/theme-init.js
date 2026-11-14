/**
 * 首屏主题初始化（在样式与 JS 包之前执行，避免深色用户看到浅色闪烁）。
 *
 * 与 web/src/state/theme.ts 共用 localStorage 键与解析规则；独立成外置文件是因为
 * 控制台 CSP 为 script-src 'self'（不允许内联脚本），而 srcdoc/内联脚本同样会被拦。
 */
(function () {
  try {
    var mode = localStorage.getItem('qqbot.console.theme') || 'auto';
    var dark = mode === 'dark'
      || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-theme-mode', mode);
    root.style.colorScheme = dark ? 'dark' : 'light';
  } catch (error) { /* 隐私模式/无 matchMedia：保持默认浅色 */ }
})();
