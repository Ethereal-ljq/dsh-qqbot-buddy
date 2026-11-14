/**
 * web 入口：挂载 React 应用与全局样式。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// 全局样式必须先于页面样式加载（页面组件会 import 自己的 css，如 reports.css），
// 否则全局规则可能排到页面样式之后，被页面样式里的同名选择器反覆盖。
import './styles.css';
import { App } from './App';
import { initTheme } from './state/theme';

// 主题在首屏前已由 index.html 内联脚本写入 data-theme；这里补上系统偏好跟随与 meta 同步。
initTheme();

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
