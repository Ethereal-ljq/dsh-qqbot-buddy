# 控制台前端（web/）

dsh-qqbot-buddy v2 的独立管理控制台，Vite + React + TypeScript，手写 CSS，无 UI 框架、无运行时依赖（React 之外）。

## 开发

```bash
npm --prefix web install
npm --prefix web run dev        # http://127.0.0.1:5173，/api（含 SSE）代理到 127.0.0.1:6198
```

控制台服务需要先启动（插件进程内）。代理目标可用 `QQBOT_CONSOLE_ORIGIN` 覆盖。

## 构建

```bash
npm --prefix web run build      # 先 tsc 类型检查，再产出 web/dist
```

产物由 `lib/console/static.js` 托管；路由使用 hash（`#/overview`），静态服务不需要 SPA fallback。

## 页面

| 路由 | 页面 | 说明 |
|---|---|---|
| `#/overview` | 总览 | 全局快照、机器人运行状态、SSE 事件横条与最近事件 |
| `#/bots` | 机器人 | Bot CRUD、启停、独立工作目录 |
| `#/profiles` | 配置档与绑定 | Profile 列表/编辑、作用域绑定（scope → profile，priority） |
| `#/settings` | 设置 | **完全由 `GET /api/schema` 渲染**，按 scope 自动分流 global/bot/profile 层 |
| `#/tools` | 工具与技能 | 宿主发现项 + Profile 级白名单/黑名单、技能白名单 |
| `#/knowledge` | 知识库 | 文档列表、Markdown 入库、FTS/LIKE 检索验证 |
| `#/memory` | 记忆 | bot 级长期记忆：列表、录入、检索、删除 |
| `#/members` | 群友库 | openid/昵称/备注/画像 JSON |
| `#/personas` | 人格卡 | 人设卡 CRUD、激活（同步 persona.md） |
| `#/stickers` | 表情包 | 路径登记、emotion 标签、当日发送量 |
| `#/audit` | 审计日志 | 控制台最近写操作 |

## 约定

- API 契约见 `docs/DESIGN-v2.md` §3；`src/api/types.ts` + `src/api/normalize.ts` 是契约落点。
- 所有请求带 cookie，非 GET 自动附加 `X-QQBot-CSRF: 1`；401 统一广播到登录页。
- 404 / 501 视为“后端能力尚未接入”，页面显示空态而不是报错。
- SSE `/api/events` 断线指数退避重连；`bot/status`、`job/progress` 事件会触发快照刷新。
- 视觉：石墨绿中性色 + 单一信号色，深色跟随系统（CSS 变量），等宽字体用于 ID/JSON。
