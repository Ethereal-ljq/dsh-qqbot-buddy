# 控制台前端（web/）

dsh-qqbot-buddy v2 的独立管理控制台，Vite + React + TypeScript，手写 CSS，无 UI 框架、无运行时依赖（React 之外）。

## 开发

```bash
npm --prefix web install
npm --prefix web run dev        # http://127.0.0.1:5173，/api 代理到 127.0.0.1:6198
```

控制台服务需要先启动（插件进程内）。代理目标可用 `QQBOT_CONSOLE_ORIGIN` 覆盖。

## 构建

```bash
npm --prefix web run build      # 先 tsc 类型检查，再产出 web/dist
```

产物由 `lib/console/static.js` 托管；路由使用 hash（`#/overview`），静态服务不需要 SPA fallback。

## 约定

- API 契约见 `docs/DESIGN-v2.md` §3；`src/api/types.ts` 是前端侧的类型落点。
- 所有请求带 cookie，非 GET 自动附加 `X-QQBot-CSRF: 1`；401 统一跳到登录页。
- 404 / 501 视为“后端能力尚未接入”，页面显示空态而不是报错。
