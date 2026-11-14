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
| `#/overview` | 总览 | 全局快照、机器人运行状态、工具档位、SSE 事件横条与最近事件 |
| `#/bots` | 机器人 | 列表 + 详情抽屉：Bot CRUD、启停/重启、**配置档绑定（作用域 → 配置档）**、重置会话、独立工作目录 |
| `#/profiles` | 配置档 | Profile 列表/编辑（15 个分节按 5 个组 tab 合并，含「命令与权限」）、提示词拼合预览 |
| `#/models` | 模型 | LLM / 视觉 / 语音（TTS）/ 语音识别（ASR）/ 更多类型插槽；TTS 供应商按默认 / 克隆 / 文字设计分块 |
| `#/tools` | 工具与技能 | 宿主发现项 + 装配三态 + Profile 级白名单/黑名单、技能白名单 |
| `#/reports` | 群日报 | 卡片模板列表与真实渲染预览、氛围切换、模板安装/删除 |
| `#/knowledge` | 知识库 | 文档列表、文本入库、URL 抓取入库、FTS/LIKE 检索验证 |
| `#/memory` | 记忆 | bot 级长期记忆：列表、录入、检索、删除、立即提炼（/api/actions/extract） |
| `#/members` | 群友库 | openid/昵称/备注/画像 JSON |
| `#/personas` | 人格卡 | 人设卡 CRUD、激活（同步 persona.md） |
| `#/stickers` | 表情包 | 路径登记、emotion 标签、当日发送量 |
| `#/audit` | 审计日志 | 控制台最近写操作 |

## 约定

- API 契约见 `docs/DESIGN-v2.md` §3；`src/api/types.ts` + `src/api/normalize.ts` 是契约落点。
- 所有请求带 cookie，非 GET 自动附加 `X-QQBot-CSRF: 1`；401 统一广播到登录页。
- 404 / 501 视为“后端能力尚未接入”，页面显示空态而不是报错。
- SSE `/api/events` 断线指数退避重连；`bot/status`、`job/progress` 事件会触发快照刷新。
- 运行时动作统一走 `POST /api/actions/:name`：机器人启停/重启/重置会话、URL 入库、记忆提炼、刷新工具发现。
  错误码（TIMEOUT / TOO_LARGE / SSRF_BLOCKED / action_failed…）由 `src/lib/actions.ts` 映射成中文提示。
- 提示词预览走 `GET /api/preview/prompt`（`src/components/PromptPreview.tsx`）：仅展示本插件 `qqbot:*` 段，
  宿主段（身份/工具 schema/技能目录）由 dsh 追加；未上线时（404）显示待接入空态。
- 视觉：石墨绿中性色 + 单一信号色，主题为 **自动 / 浅色 / 深色** 三态（`src/state/theme.ts`，
  `localStorage['qqbot.console.theme']`，首屏由 `index.html`/ `public/theme-init.js` 内联脚本防闪烁），
  等宽字体用于 ID/JSON。
- 版本号、控制台端口等运行期信息来自 `GET /api/state`，不要在页面里写死。
