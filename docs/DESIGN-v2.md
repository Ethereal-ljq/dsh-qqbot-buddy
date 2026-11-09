# dsh-qqbot-buddy v2 — 设计契约（唯一事实源）

> 目标：在 `/home/qiqi/project/dsh-qqbot-buddy-v2` 从零搭建 v2，吸收 AstrBot 的产品形态，
> 解决 v0.22 的四条结构性诉求。v0.22 仓库保留不动，作为协议层与测试的移植来源。

## 0. 四条诉求的裁决

### 0.1 独立 WebUI（要）——不等同于"再写一个设置页"

v1 的 8 个分页 + 26 个页面组件塞在宿主设置页里，代价是：每次 DSH 升级都要回归宿主 UI 契约；
管理面（配置/知识库/群友库/日志/任务）本来也不是"设置"。v2 拆成**独立控制台**：

- 独立 HTTP 服务，默认 `127.0.0.1:6198`，只在插件进程内启动，随插件 apply/dispose 起停；
- **自带鉴权**：首次启动生成 128bit token（scrypt 存储），登录换 HttpOnly+SameSite=Strict 会话 cookie，
  写操作要求 `X-QQBot-CSRF: 1` 自定义头；登录失败限速（5 次/5 分钟/IP）。这同时把 v1 审计的 P0（48 路由 5 条有校验）从根上解决；
- 前端：`web/`（Vite + React + TS），产物 `web/dist` 由控制台服务托管；后端零依赖（只用 node 内置）；
- DSH 设置页只保留一个 `console` 小段：状态、地址、token 复制/重置、打开按钮。
- 备选被否：继续用宿主 webServer + 同源鉴权（受宿主路由准入语义约束），或 iframe 嵌宿主（体验差且仍受宿主升级影响）。

### 0.2 配置管理：Bot → Profile → Binding 三层

- **Bot**：QQ 应用本体 + 独立工作目录 + 独立数据（记忆/知识库/群友库/表情包/人格卡）。
- **Profile（配置档）**：只装"可变策略"——人设、提示段、模型/provider、回复与触发策略、工具与技能策略。
  一个 bot 有多个 profile，任意时刻一个 `active`，可一键切换（= 快速切换配置）。
- **Binding（作用域绑定）**：`scope` 采用 UMO 风格 `qq:group:123456` / `qq:group:*` / `qq:c2c:*` / `*`，
  数值 priority + 匹配精度排序（精确 > 类型通配 > bot 通配 > 默认）。等价于 AstrBot 的 abconf/UMO 路由。

**关于「不同会话配置之间是否共享记忆」**（用户问题，调研结论）：
AstrBot 的配置档只决定该 UMO 用哪套 provider/prompt；**对话上下文按会话存**，人格/知识库是实例级全局，
长期记忆不在核心里（靠插件）。AstrBot 不存在"跨配置档共享记忆"的显式设计。

我们的裁决（也是用户想要的）：**记忆/知识库/群友库按 bot 共享，会话上下文按 peer 隔离，Profile 只改策略不改数据。**
即"一个机器人一份记忆"，切换配置档不会丢记忆、不会串记忆。

### 0.3 工具发现 + 白名单 v2 + 「冷会话掉工具」根因

**根因（v1 实现层面的问题，已从 dsh 源码确认语义）**

1. `system-prompt` 服务的作用域规则：**agent scope 的同名 section 会 shadow 全局 section**
   （`dsh-system-prompt/lib/index.js` 的 `PERSONA_PREFIX_SECTION` 注释与 `PromptLayer` 实现）。
   v1 在**全局**注册 `deployment:persona-*` 一类内容，而宿主 preset 在 **agent scope** 注册同名内容 →
   冷会话恢复时 preset 挂载生效，把我们的段"盖掉"。
2. v1 的兜底是监听 `system-prompt/assemble` 事件、**改写返回的 assembly 数组**，并用
   `provider.text = () => ''` 这种打补丁方式压 team 上下文。而该服务的契约写明：
   "Sections, tools, and interpolation variables retain the accepted assembly; their providers
   and waterfall do not rerun." —— 一旦 assembly 被接受/缓存，冷路径上我们的改写不保证重跑，
   于是"prompt 被覆盖、工具指引丢失"表现为"掉工具"。
3. `tools.restrict()` 要求调用方必须是 **agent scope**（宿主抛错原文：requires a scoped context），
   v1 用 `agentCtx.tools` 代理 + 报错文本解析重试，脆弱。

**v2 契约（写死，不许绕）**

- 所有 prompt 贡献都在 **agent scope** 用唯一命名注册：`qqbot:persona`、`qqbot:toolguide`、
  `qqbot:memory`……**绝不与宿主段同名**（需要替换宿主语义时显式使用宿主导出的 section 名并写明理由）。
- 动态内容一律走 `systemPrompt.variable(name, provider)`，section 文本写 `{{qqbot_persona}}` 这类占位——
  每次 assembly 重新求值，天然解决"配置改了冷会话不生效"。
- **禁止**监听 `system-prompt/assemble` 改写数组；禁止改 provider 对象。需要隐藏运行时上下文时用官方的
  `suppressRuntimeContext()`（作用于调用方 scope）+ 过滤 `team:*` 由注册而不是删改。
- 工具可见性只走两条官方通道：`agentCtx.tools.restrict({ allow | deny })`（全局工具收窄）+
  agent-scope 注册（插件自带工具）。不做 assembly 后置过滤。
- 回归验收：写一个 dsh 集成探针（`scripts/probe-tools.mjs`），流程 = 建会话 → 首轮 assembly →
  dispose → 从持久化 resume（模拟冷会话）→ 断言工具集合与 prompt 段与首轮一致。

**工具/技能管理接口**

- `core/tools/discover.js`：从宿主收集 `{ name, source: 'host'|'plugin'|'mcp'|'skill'|'qqbot', description, restrictable }`；
  来源 = `ctx.tools.view(scope).knownNames/visible` + 宿主插件清单 + `ctx.skills` 注册表 + 本插件工具。
- 策略存 Profile：`tools: { mode: 'allow'|'deny', allow: [...], deny: [...], extra: [...] }`、
  `skills: { mode: 'all'|'allow', allow: [...] }`。
- 控制台「工具与技能」页：列出全部发现项（含宿主新装插件带来的），一键放行/屏蔽，实时显示"当前会话可见性"。
- 技能仍用 v1 的 `skills.registerProvider()` 方案（按白名单过滤），但白名单来自 Profile。

### 0.4 目录管理：每个 bot 独立 cwd（dsh 原生支持，已确认）

v1 让所有 bot 共用 `cwd`，不是 dsh 限制，而是没用到 `dsh-working-directory`：

- `dsh-working-directory` 服务提供 `ensure(agent, signal)`（读）与 `set(agent, path, signal)`（改）；
  变更通过 `working-directory/change` 事件写进 session，**durable**，重启/resume 后仍是该目录；
- session header 带 `cwd`，宿主 `dsh-tool-fs` / `dsh-tool-bash` / `dsh-tool-present` 等全部通过
  `ctx.workingDirectory.ensure(exec.agent)` 取根目录 —— 所以**换 cwd 就等于给该 bot 换了文件系统根**。

**裁决**

- bot 工作目录 = `<DSH workspace>/bots/<botId>/`（必须在 workspace 内，否则 workspace-write 沙箱拒绝写）；
  建 bot 时 mkdir，并在 agent create 的 `meta.cwd` 播种 + `workingDirectory.set` 兜底；
- 目录结构（每个 bot 自包含，备份/迁移 = 拷贝一个目录）：
  ```
  <workspace>/bots/<botId>/
    persona.md            # 当前生效人设（人设卡另存 DB）
    memory/               # 人文本记忆导出（DB 是权威，这里便于人读/编辑）
    knowledge/            # 知识源文件（ingest 后进 DB）
    media/                # 入站图片/表情/文件缓存
  ```
- 运行数据（`buddy.db`、日志、控制台 token）放 `~/.dsh-qqbot/v2/`，**不在** workspace 内（不污染 agent 视野）；
  可用 config `dataDir` 覆盖。
- workspace 之外的绝对路径：默认禁止（沙箱会拒绝）；config `bots[].cwdOverride` 允许但会标注"需要 danger-full-access"。
- 这同时回答"无法修改"：**能改，改的是 session cwd，不需要动 DSH 配置。**

## 1. 架构与模块边界

```
lib/
  index.js              # cordis 插件入口：装配 core + console + bot host
  host/                 # DSH 适配层（唯一允许 import @deepseek-ai/* 的地方）
    services.js         # getService / requireService 帮助函数
    agent.js            # peer→agent 创建/恢复；cwd 播种；setup 钩子
    prompt.js           # 声明式 prompt 契约（section/variable，见 0.3）
    tools.js            # 工具发现 + restrict + 作用域注册
    skills.js           # 技能 provider（白名单来自 Profile）
  core/                 # 平台无关业务核心（不许 import @deepseek-ai/*）
    db.js  migrations.js
    config/{schema.js,store.js}     # 设置单一真相 + Bot/Profile/Binding
    kb/{store.js,chunk.js,ingest.js}
    memory/{store.js,collect.js}
    members/{store.js,extract.js}
    personas/store.js  stickers/store.js  entries/store.js
    tools/{catalog.js,discover.js,policy.js}
    jobs/rounds.js  llm/one-shot.js
  qq/                   # 协议层（移植 v0.22 资产）
    (gate|sender|outbound|error-codes|adaptive|events|interaction|attachment|inline-image|media-cleaner).js
  console/
    server.js  auth.js  api/*.js  sse.js  static.js
web/                    # 控制台前端（Vite + React + TS）
test/                   # node:test
docs/DESIGN-v2.md       # 本文件
```

依赖方向：`index → host/console/qq → core`；`core` 不依赖 host / qq / console；
`qq` 只依赖 `core` 与 `@tencent-connect/*`。禁止反向 import。

## 2. 数据模型（SQLite，见 lib/core/migrations.js）

| 表 | 说明 |
|---|---|
| meta / settings | 版本与设置（settings 按 `bot_id` 分层，`''`=全局） |
| bots | QQ 应用 + 工作目录 + 启停 |
| profiles | 配置档（JSON：persona/model/tools/reply/prompt 覆盖） |
| bindings | scope → profile，priority |
| sessions | peer → dsh session_id + 会话级 cwd |
| memories + memories_fts | 长期记忆（bot 级共享），FTS5 trigram |
| kb_docs / kb_chunks + kb_chunks_fts | 知识库，FTS5 trigram |
| members / personas / stickers | 群友库 / 人格卡 / 表情包（均 bot 级） |
| audit / console_tokens / console_sessions | 审计与鉴权 |

**检索契约（`core/kb/store.js`）**：`search({botId, query, limit})` 返回 `[{text,title,score,mode}]`；
query 长度 < 3 时 trigram 无法命中 → 回退 `LIKE` 并返回 `mode:'like'`；否则 `bm25()` 排序、`mode:'fts'`。
分块：Markdown 标题优先，其次按 `maxChars=800/overlap=80` 滑窗；hash 去重、按 `source` 幂等重入。

## 3. 控制台 API 契约（`/api`，全部 JSON）

鉴权：除 `POST /api/auth/login`、`GET /api/health` 外都要求会话 cookie；非 GET 要求 `X-QQBot-CSRF: 1`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 版本/在线/无鉴权 |
| POST | /api/auth/login | `{token}` → Set-Cookie；失败限速 |
| POST | /api/auth/logout | 注销 |
| GET | /api/auth/session | 当前登录态 |
| GET | /api/state | 全局快照（bots/profiles/active/console 版本/运行状态） |
| GET/POST/PATCH/DELETE | /api/bots[/:id] | bot 增删改查、启停 |
| GET/POST/PATCH/DELETE | /api/profiles[/:id] | 配置档；`POST /api/profiles/:id/activate` |
| GET/PUT/DELETE | /api/bindings[/:id] | 作用域绑定 |
| GET/PUT | /api/settings | 按 schema 归一化；`?bot=` |
| GET | /api/schema | 设置项的 UI 元数据（label/type/enum/说明） |
| GET | /api/tools | 发现项 + 当前策略 + 可见性 |
| PUT | /api/tools/policy | Profile 级工具策略 |
| GET | /api/skills | 技能清单 + 策略 |
| PUT | /api/skills/policy | Profile 级技能策略 |
| GET/POST/DELETE | /api/kb/docs | 知识库文档；`POST /api/kb/ingest`、`POST /api/kb/search` |
| GET/POST/DELETE | /api/memories | 记忆；`POST /api/memories/search` |
| GET/PATCH/DELETE | /api/members | 群友库 |
| GET/POST/PATCH/DELETE | /api/personas | 人格卡 |
| GET/POST/DELETE | /api/stickers | 表情包 |
| GET | /api/audit | 最近审计 |
| GET | /api/events | SSE：bot/status、log、job/progress |
| POST | /api/actions/:name | start/stop/restart/reconnect/ingest-url/extract |

错误统一 `{error:{code,message}}`，2xx 返回裸数据；`X-Request-Id` 回显。

## 4. 从 v1 移植什么、重写什么

**移植（协议资产，v0.22 已踩坑）**：`lib/qq/error-codes.js`、`gate.js`、`sender.js`、`outbound.js`、
`adaptive.js`、`events.js`、`interaction.js`、`attachment.js`、`inline-image.js`、`media-cleaner.js`
及对应测试。移植时只把依赖从旧 store 换成 `core/*`。

**重写**：设置/配置（→ SQLite + schema registry）、记忆/知识库/群友/表情包 store（→ SQLite）、
prompt 组装（→ 0.3 契约）、工具白名单（→ 0.3）、web 路由（→ console）、client（→ web/）、
多 bot 宿主（→ host/agent + workingDirectory）。

## 5. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 地基 | repo/DB/迁移/配置 schema+store/插件入口/控制台服务骨架 | `npm test` 绿；控制台 `/api/health` 通 |
| M1 控制台 | 鉴权 + 资源 API + 前端壳与 6 个页面 | 浏览器能登录、增删改 bot/profile/binding、看工具与知识库 |
| M2 宿主适配 | prompt 契约、工具策略、每 bot cwd、会话管理 | `scripts/probe-tools.mjs` 冷会话一致性通过 |
| M3 QQ 移植 | 协议层搬入并接新 core | 原协议测试全绿 + 真机冒烟 |
| M4 数据能力 | KB ingest/search、记忆提炼 job | 中文 <3 字/≥3 字检索用例、10k 条性能 <20ms |
| M5 发布 | 安装脚本、v1→v2 数据迁移器、文档 | 隔离 DSH_HOME 安装测试 |

## 6. 写作用域（团队）

| 范围 | owner |
|---|---|
| lib/core/db.js, migrations.js, lib/core/config/**, lib/index.js, docs/** | Lead |
| lib/console/**, lib/core/kb/**, test/kb*.test.js | console-dev / kb-dev |
| web/** | web-dev |
| lib/qq/**, test/qq/ | qq-dev（M3 起） |
| lib/host/**, lib/core/tools/** | Lead（M2） |

## 7. 实现补记（M0–M2 落地后）

### 7.1 知识库/记忆检索（kb-dev, M4）

- FTS5 索引用 `trigram`：**查询短语 < 3 字符时必须回退 LIKE**（trigram 硬限制），返回值带 `mode: 'fts' | 'like'`。
- **性能坑（重要）**：`kb_chunks_fts` JOIN `kb_chunks` 再 `WHERE bot_id=?` 时，SQLite 会用 bot 索引驱动、逐行执行 MATCH
  （10k chunks 下 200ms+，高频词 7.8s）。必须写成 `FROM kb_chunks_fts CROSS JOIN kb_chunks ...` 强制 FTS 先行；
  实测中位 0.33ms（fts）/ 0.92ms（like）。性能用例在 `test/kb-perf.test.js`。
- **FTS 触发器坑**：FK `ON DELETE CASCADE` 不会触发 FTS 删除触发器，会留影子行；removeDoc 必须显式先删 chunks。
- 检索语义是整串子串/短语匹配，不做分词与多词 OR；标题暂不进索引（后续可把 title 拼进 chunk 或加列）。
- 记忆近似去重：归一化精确匹配 + 字符 bigram Dice ≥ 0.85，扫同 bot 最近 300 条（性能取舍）。

### 7.2 控制台（console-dev, M1）

- 路由声明式：`{ method, path(:param), auth?, csrf?, handler }`；中间件顺序 Host 校验 → 匹配 → 会话鉴权 → CSRF → body → handler。
- `GET /api/settings` 返回**扁平点号键** `{botId, values:{'reply.mode':...}}`；PUT 接受扁平/嵌套两种写法。
- 鉴权：token（scrypt）+ HttpOnly/SameSite=Strict cookie（DB 存 sha256(sid)）+ 非 GET 的 `X-QQBot-CSRF: 1` 头 + 登录失败限速。
- 端到端集成用例：`test/integration-console.test.js`（真实 apply → 随机端口 → 登录 → 建 bot → 改设置 → KB 入库/检索）。

### 7.3 宿主适配（Lead, M2）

- prompt 契约与工具策略见 §0.3；`lib/host/prompt.js` / `lib/host/tools.js` 有契约测试（`test/host-prompt.test.js`）。
- 每 bot cwd：`meta.cwd` 播种 + `workingDirectory.set` 兜底（`lib/host/agent.js`）。
- 旁路 LLM 收口：`lib/host/llm.js` `createOneShot().generate()`（记忆提炼/知识抽取共用）。
- 后台任务状态表：`job_state(bot_id, peer, job, value, updated_at)`（迁移 v2），供"每 N 轮提炼"跨重启计数。

### 7.4 待办

- M2 收尾：真实 dsh 冷会话探针 `scripts/probe-tools.mjs`（建会话→首轮 assembly→resume→断言工具/prompt 一致）。
- M4 剩余：`lib/core/memory/collect.js`（提炼 job）、`lib/core/kb/ingest-url.js`（URL 入库，需 SSRF 防护）。
- M3：QQ 传输层（qq-dev 进行中）。
- M5：安装脚本、v1→v2 数据迁移器（v1 settings.json/记忆/知识库 → SQLite）。
