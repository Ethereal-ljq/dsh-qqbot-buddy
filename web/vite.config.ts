/**
 * web/vite.config —— 控制台前端构建与开发代理。
 *
 * - dev 时把 /api（含 SSE /api/events）反向代理到控制台服务的默认监听 127.0.0.1:6198，
 *   这样浏览器侧始终同源，cookie 与 X-QQBot-CSRF 头无需任何 CORS 配置；
 * - build 产物输出 web/dist，由 lib/console/static.js 托管。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const CONSOLE_ORIGIN = process.env.QQBOT_CONSOLE_ORIGIN || 'http://127.0.0.1:6198';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: CONSOLE_ORIGIN,
        changeOrigin: true,
        // SSE 是长连接，不能被代理缓冲
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
});
