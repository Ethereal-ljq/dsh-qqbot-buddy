# dsh-qqbot-buddy

把 **DeepSeek Harness（dsh）** 接到 QQ 官方机器人平台的 dsh 插件：自带独立管理控制台，
支持配置档（Profile）/作用域绑定、可管理的工具与技能、SQLite + FTS5 长期记忆与知识库、
群友库、人格卡与表情包，并提供多机器人隔离运行。

- 适用版本：`1.0.0-alpha.2`（v2 分支）
- 运行环境：**Node.js ≥ 24**（使用内置 `node:sqlite`）、dsh 0.2.x
- 依赖：QQ 官方机器人平台的 `appId` / `appSecret`（WebSocket 接入，无需公网回调）
- npm：[dsh-qqbot-buddy](https://www.npmjs.com/package/dsh-qqbot-buddy)（当前 alpha 走 `@next` 标签）
- 许可证：MIT

---

## 功能特性

| 模块 | 说明 |
| --- | --- |
| 独立控制台 | 随插件进程启动的 Web 管理台（默认 `127.0.0.1:6198`），token 登录、SSE 实时事件、开机即用，无需额外部署前端或数据库；与 dsh Web 双向快捷入口（控制台顶栏 → dsh Web；dsh Web 右下角 → QQ 控制台） |
| 多机器人 | 每个 bot 独立工作目录 `<workspace>/bots/<botId>`，凭据、会话、日志互不影响；同一进程可管理多个 bot |
| 配置档与绑定 | 三层策略：`global < bot < profile`；按 `群聊 / 私聊 / 指定 openid` 绑定不同配置档（精确 > 类型通配 > bot 通配 > 默认档），切换配置档不丢记忆 |
| 提示词管理 | 人设卡、人格卡、口头禅、能力边界、工具指引；控制台提供**提示词拼合预览**，按真实顺序查看每段内容与字符数 |
| 工具与技能 | 工具发现、能力开关、按配置档白名单/黑名单（真正生效）；技能白名单按配置档过滤模型侧目录，支持 `/tools`、`/skills` 排查 |
| 长期记忆 | SQLite + FTS5，按用户原话召回（多词自动回退），支持自动提炼（每 N 轮）与手动提炼 |
| 知识库 | 文本/URL 入库、标题/小标题可检索、文档列表查看；FTS5 trigram + LIKE 双通道 |
| 群友库 | 记录 openid/昵称/备注/画像；发言人自动注入、被 @ 的人懒加载，避免整库注入 |
| 表情包 / 人格卡 | 本地图片登记、emotion 标签、每日配额；人格卡可切换与独立编辑 |
| 图片能力 | 视觉理解（贴图描述）、生成/改图结果自动补发到 QQ，不再需要人工提醒 |
| 数据自包含 | 数据目录默认 `~/.dsh-qqbot/v2`，单文件 SQLite；备份 = 拷贝数据目录 + workspace |

## 界面预览

**总览**：机器人运行状态、配置规模、SSE 事件流与最近事件

![控制台总览](docs/images/console-overview.png)

**配置档与绑定**：按分区子 tab 编辑策略，支持提示词拼合预览

![配置档编辑](docs/images/console-profiles.png)

**提示词预览**：按真实顺序拼合人设/工具指引/记忆/知识/群友/技能目录，并标注空段与字符数

![提示词预览](docs/images/console-prompt-preview.png)

**工具与技能**：宿主发现清单、当前可见性、按配置档放行/屏蔽

![工具与技能](docs/images/console-tools.png)

**设置**：schema 驱动，按 global / bot / profile 层级自动分流

![设置](docs/images/console-settings.png)

**记忆与知识库**：检索、录入与提炼

![记忆](docs/images/console-memory.png)

![知识库](docs/images/console-knowledge.png)

## 安装

### 环境要求

- Node.js **24 或更高**（`node --version`）
- 已安装 dsh（`dsh --version` 可用），并初始化过至少一个 profile
- QQ 官方机器人平台的 bot（获取 `appId`、`appSecret`，并在平台开启所需的群/私聊权限）

### 方式一：npm 安装（推荐）

```bash
# 装到默认 web profile（当前是 alpha 版本，使用 @next 标签）
dsh plugin --profile web add dsh-qqbot-buddy@next

# 或装到指定 profile
dsh plugin --profile qqbot add dsh-qqbot-buddy@next

# 或使用安装器（自动校验/初始化 profile、登记 bundle、自检）
npx -y --package=dsh-qqbot-buddy@next dsh-qqbot-buddy-install --profile qqbot --spec dsh-qqbot-buddy@next
```

> 稳定版发布后可直接 `dsh plugin add dsh-qqbot-buddy`（不带 `@next`）。
> 安装完成后**重启 dsh**，控制台随插件一起启动。

### 方式二：从 GitHub 安装（无需 npm 账号）

```bash
# 安装到默认 web profile
npx -y github:Ethereal-ljq/dsh-qqbot-buddy#v2

# 或安装到指定 profile
npx -y github:Ethereal-ljq/dsh-qqbot-buddy#v2 --profile qqbot

# 只看会执行哪些操作
npx -y github:Ethereal-ljq/dsh-qqbot-buddy#v2 --dry-run
```

安装器会完成：初始化/校验 profile → 安装插件与运行期依赖 → 登记进 `dsh.profile.bundles` → 自检。

### 方式三：本地开发安装

```bash
git clone -b v2 https://github.com/Ethereal-ljq/dsh-qqbot-buddy.git
cd dsh-qqbot-buddy

npm --prefix web ci          # 首次构建前端依赖
npm run console:build        # 产物在 web/dist（随包携带，运行期不需要 node_modules）
npm run install:local        # 等价：node scripts/install.mjs --local --spec .

# 安装到指定 profile
node scripts/install.mjs --local --profile qqbot
```

> `--local` 会把仓库作为纯文件副本装进 profile（不依赖仓库的 `node_modules`），
> 与线上安装包行为一致，适合调试插件本体。

### 第一次启动

1. 重启 dsh（例如重新执行 `dsh web`）；
2. 打开控制台 `http://127.0.0.1:6198`，token 在 `<dataDir>/console-token.txt`
   （默认 `~/.dsh-qqbot/v2/console-token.txt`；端口/监听地址可在 profile 的 patch 配置里修改）；
3. 进入「机器人」页新建机器人，填写 QQ 的 `appId` / `appSecret`，保存后启动；
4. 在 QQ 里 @ 机器人或私聊发一条消息，确认链路正常；
5. 按需在「配置档与绑定」里编辑人设、回复策略、工具/技能白名单。

## 目录与数据

```text
<dataDir>/                    默认 ~/.dsh-qqbot/v2
├── buddy.db                  SQLite：配置档/记忆/知识库/群友库/表情包/审计
├── console-token.txt         控制台登录 token
└── logs/                     运行日志（如有）

<workspaceRoot>/              默认 dsh 启动目录
└── bots/<botId>/             每个机器人的独立 agent 工作目录（会话、媒体、生成物）
```

- 记忆、知识库、群友库、表情包、人格卡按 **bot** 共享：切换配置档不会丢数据、也不会串档；
- 备份：停止 bot 后拷贝 `<dataDir>` 与 `<workspaceRoot>/bots` 即可；
- 恢复：原样放回后重启 dsh。

## 配置模型

```text
生效设置 = 默认值 → global 层 → bot 层 → profile 层（后者覆盖前者）
Peer 绑定 = 精确 scope（群 openid / 私聊 openid）> 类型通配（group/c2c）> bot 通配 > 默认配置档
```

- **设置页**：查看/编辑“当前 bot 的生效值”，保存时按每个设置项的 scope 自动分流到对应层级；
- **配置档页**：编辑某个配置档的策略（人设/回复/模型/工具/记忆/知识/群友/看图/表情包），
  并提供提示词预览；作用域绑定决定“哪个群/哪个人用哪个配置档”。

多个 bot 共用同一份进程与数据库结构，但 bot 级配置、数据与会话完全隔离。

## QQ 聊天命令

| 命令 | 说明 | 权限 |
| --- | --- | --- |
| `/help` | 命令列表与管理员门控状态 | 公开 |
| `/ping` | 连通性测试 | 公开 |
| `/status` | 回复频率、人设/会话与统计 | 公开 |
| `/id` | 查看自己的昵称、openid 与管理员身份 | 公开 |
| `/tools` | 工具清单：已开启/未开启分组 + 原因 | 公开 |
| `/skills` | 技能清单：已开启/未开启分组 + 原因 | 公开 |
| `/new` `/reset` `/clear` | 开启新会话（旧会话进入可恢复列表） | 管理员 |
| `/resume` | 恢复上一个被 /new 替换的会话 | 管理员 |
| `/stop` | 停止当前正在生成的回复 | 管理员 |

管理员门控：在「设置 → 命令与权限 → 管理员」启用并配置 openid/昵称名单后生效；
未启用时管理员命令对所有人可用（便于本地调试，公网/多人群建议开启）。

**工具与技能白名单语义**

- `mode=allow` 且列表非空：只放行列表内工具/技能（宿主工具、插件工具、技能目录统一判定）；
- `mode=allow` 且列表为空：回退到能力开关；
- `mode=deny`：除黑名单外放行，但仍受能力开关约束；黑名单优先于白名单；
- 策略在**创建新会话时**应用：修改后请发送 `/new`、重启 bot 或在控制台重置会话。

## 架构

```text
QQ 开放平台 (WebSocket)
        │
        ▼
┌──────────────────────────────────────────────┐
│  dsh 进程                                     │
│                                              │
│  dsh-qqbot-buddy 插件                        │
│  ├── qq/        网关、中间件、出站、门控、命令 │
│  ├── host/      bot 运行时：agent/会话/工具/   │
│  │              技能/召回/提示词拼合           │
│  ├── core/      SQLite、配置档、记忆、知识库、 │
│  │              群友库、人格卡、表情包          │
│  ├── tools/     agent 工具（记忆/知识/群友/文件）│
│  └── console/   独立 HTTP 控制台 + SSE        │
│          │                                    │
│  dsh 宿主服务：agents / sessions / llm / tools │
│                systemPrompt / skills          │
└──────────────────────────────────────────────┘
        │
        ▼
   ~/.dsh-qqbot/v2/buddy.db   +   <workspace>/bots/<botId>/
```

插件只通过 dsh 的官方服务接入（agent、tools、systemPrompt、skills、attachments），
不修改宿主实现；工具按配置档策略在 agent scope 动态挂载，技能由插件自带 provider
按配置档过滤后提供给 `dsh-tool-skill`。

## 开发

```bash
npm test                     # 单元测试（node --test，437 例）
npm run verify:recall        # 真机验证记忆/知识库自动注入（需要控制台在线）
npm run console:build        # tsc 严格检查 + vite 构建控制台
npm run console:dev          # 控制台前端开发模式（代理到 6198）
node scripts/dev-console.mjs # 只启动控制台后端（不连 QQ）

# 真实 dsh 集成测试（隔离 DSH_HOME，不需要 QQ 凭据）
DSH_HOME=$PWD/.work/integration/dsh-home QQBOT_E2E=1 node --test test/e2e/real-dsh.test.js
```

主要目录：

```text
lib/
├── index.js            插件入口：配置、服务装配、控制台/机器人生命周期
├── config-schema.js    dsh 部署级配置（dataDir/workspaceRoot/console…）
├── qq/                 QQ 协议层（网关/中间件/发送/门控/命令）
├── host/               bot 运行时（agent 装配、会话、工具策略、技能 provider、召回）
├── core/               SQLite store、配置档、记忆、知识库、群友库、人格卡、表情包
├── tools/              注册给 agent 的插件工具与能力目录
└── console/            控制台 HTTP 服务与 REST API
web/                    控制台前端（React + TypeScript + Vite，产物 web/dist）
docs/                   用户手册、设计契约、传输层契约、冒烟报告
scripts/                安装器、迁移、探针等工具
```

## 文档

- [用户手册](docs/USER-GUIDE.md)：安装、控制台、配置档、记忆/知识库、备份与迁移
- [设计契约](docs/DESIGN-v2.md)：模块边界、会话映射、记忆召回、工具/技能策略
- [传输层契约](docs/TRANSPORT-CONTRACT.md)：QQ 网关、被动回复、媒体发送、错误码
- [冒烟报告](docs/SMOKE-REPORT.md)：真实环境验证记录与已知限制

## 已知限制

- **被动回复窗口**：QQ 群聊默认只能引用收到消息的 `msgId` 做被动回复；主动消息需要平台权限；
  因此群聊回复会尽量引用触发消息，超时/多轮场景以平台实际能力为准。
- **单连接**：同一 `appId` 只能建立一条 WebSocket 连接，不要与其它框架同时运行同一机器人。
- **技能白名单**：`glob` 与 `grep` 同属宿主 fs-search 插件，不能单独开关（放行任一即两者可见）。
- **前端产物**：控制台前端已随包提供；修改前端源码需要重新 `npm run console:build`。
- **模型/渠道**：模型与图片生成渠道由 dsh 宿主的模型配置决定，本插件不内置模型。

## 许可证

[MIT](LICENSE)