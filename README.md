# dsh-qqbot-buddy v2

把 DeepSeek Harness（dsh）接到 QQ 的机器人插件 **v2**。相对 v0.22 的四条主线：

1. **独立管理控制台**（默认 `127.0.0.1:6198`，自带 token 登录）——不再挤在 DSH 设置页里，也不再受宿主 UI 升级影响。
2. **配置档 + 会话级配置**：`Bot → Profile → Binding` 三层。切换配置档只切策略（人设/模型/回复/工具），
   **记忆、知识库、群友库按 bot 共享**（一个机器人一份记忆，切档不丢不串）。
3. **工具/技能发现与管理**，并修掉「冷会话 prompt 覆盖导致掉工具」：所有 prompt 段在 agent scope 用 `qqbot:*`
   唯一命名注册、动态内容走 `systemPrompt.variable()`，**不监听 `system-prompt/assemble`**；工具可见性只走
   `tools.restrict` + agent scope 注册。
4. **SQLite + FTS5** 持久化记忆与知识库（`node:sqlite`，零原生依赖、零编译），中文用 trigram、<3 字回退 LIKE。
5. **每个 bot 独立工作目录**：`<workspace>/bots/<botId>`，通过 `workingDirectory` 服务切换 session cwd（durable）。

## 自包含设计

- **不要求 Node 之外的工具链**：运行时只用 Node 内置模块 + 宿主提供的 `@deepseek-ai/*` 服务；
  SQLite 用内置 `node:sqlite`（无 better-sqlite3、无编译）；控制台在插件进程内起 HTTP，不额外部署服务。
- **前端产物随包携带**：`web/dist` 已构建并打进 npm 包，安装阶段不需要 `npm install`/`vite`/`网络`。
  只有改前端源码时才需要 `npm run build:web`。
- **数据自包含**：运行数据默认在 `~/.dsh-qqbot/v2/`（`buddy.db`、控制台 token、日志），
  bot 工作区在 `<workspace>/bots/<botId>`，一个目录即可备份/迁移。
- **Node 要求：>= 24**（`node:sqlite` 在该版本免实验 flag；FTS5 + trigram 已随内置 SQLite 提供）。

## 安装

```bash
# 从 GitHub（v2 分支）
npx -y github:Ethereal-ljq/dsh-qqbot-buddy#v2

# 本地仓库开发安装（复制进 profile，不经过 pnpm）
node scripts/install.mjs --local
```

安装后重启 dsh，打开控制台 `http://127.0.0.1:6198`，token 见 `~/.dsh-qqbot/v2/console-token.txt`。

## 开发

```bash
node scripts/setup-dev.mjs   # 把宿主 dsh 的 @deepseek-ai/* 软链到本地 node_modules
npm test                     # 单元/集成测试（node:test）
npm run dev:console          # 只起控制台 + 演示数据（不连 QQ）
npm run build:web            # 改前端后重建 web/dist
```

## 目录

```
lib/
  host/       DSH 适配层（prompt 契约 / 工具策略 / 会话与 cwd / one-shot LLM / 发现）
  core/       平台无关核心（SQLite、配置、知识库、记忆、群友、人格、表情包、任务）
  qq/         协议层（网关/中间件/发送器/出站/门控/命令）
  tools/      插件工具（qqbot_send_file 等，注册到 agent scope）
  console/    独立控制台（HTTP + 鉴权 + SSE + 静态托管）
web/          控制台前端（Vite + React + TS，产物提交到 web/dist）
docs/DESIGN-v2.md       设计契约（唯一事实源）
docs/TRANSPORT-CONTRACT.md  QQ 传输层契约
```

设计细节见 [docs/DESIGN-v2.md](docs/DESIGN-v2.md)。
