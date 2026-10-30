# dsh-qqbot-buddy

把 DeepSeek Harness（dsh）接到 QQ 的机器人插件。与官方 `@tencent-connect/dsh-qqbot` 相比，重点补了四件事：

1. **回复频率可控** —— 群聊不再“每条都回”。支持“累计 N 条”“时间间隔”“概率”，以及推荐的 **自适应模式**
   （静默 debounce + 冷却 + 最长等待 + 只回问句/图片）；`@机器人`、引用/回复机器人、命中关键词永远回复（各自可开关）。
2. **Self-improve 长期记忆** —— 机器人会把重要信息记到工作区指定目录（默认 `<cwd>/memory`），
   自动注入后续对话，也能主动用工具检索/写入；支持每 N 轮自动提炼一次。
3. **人设可编辑** —— 设置页直接编辑 `persona.md`（默认 `<cwd>/persona.md`），支持“替换/追加”两种模式、自动备份与回滚。
4. **设置菜单显式入口** —— dsh Web 的「设置 → QQ 机器人」内有八个分页：概览 / 回复与触发 / Agent 与模型 / 人设 / 口头禅 / 表情包 / 记忆与自我改进 / 命令与权限。
5. **模型切换** —— 设置页可切 provider / model / reasoningEffort（或跟随宿主默认），新会话生效；支持「应用到当前会话」重置 bot 会话。
6. **扫码绑定** —— 移植官方流程：设置页显示 q.qq.com 二维码，手机 QQ 扫码后自动写入 profile 凭据并热切换 bot；也支持手动填写 appId/appSecret 与解绑。
7. **Agent 预设 + 功能开关** —— 可选择宿主 agent preset，或使用内置组合；按开关动态启用/禁用 工作区读写、联网搜索、表情包、看图、长期记忆。
8. **独立可安装维护** —— 不依赖官方 `@tencent-connect/dsh-qqbot`；4 个运行时依赖在包 `package.json` 中显式声明，profile 侧显式声明后即可单独安装/更新。
9. **表情包库** —— 设置页可直接管理可发送表情（上传/删除/改情绪标签），bot 遇到喜欢的表情可用 `qqbot_sticker_save` 收藏进来，下一轮就能发。

## 架构

```
QQ WebSocket
   │  @tencent-connect/qqbot-nodejs（协议 + 中间件）
   ▼
中间件链：过滤 → 访问控制 → 历史缓冲 → 引用解析 → @识别 → 清洗 → 限流
        → 命令拦截 → 【频率门控】 → 并发合并 → 附件下载
   ▼  触发
入站组装（发送者/引用/媒体/历史/节奏提示）→ agent.followup
   ▼
DSH agent（system prompt = 人设 + 长期记忆 + 行为指引；工具 = fs/web/memory/qqbot）
   ▼  session/event
出站：[[msg]] 分条 / 空行自动分条 + Markdown 长文切分 → QQ 被动回复
   ▼  turn/end
自动记忆提炼（每 N 轮，可选）→ memory 文件 → 下一轮自动读回
```

## 目录

```
lib/
├── index.js            插件入口与装配（runtime、web 路由、bot 生命周期）
├── config-schema.js    插件配置（appId/appSecret/cwd/preset...）
├── settings-store.js   运行期设置（JSON 落盘、热生效、校验）
├── persona-store.js    人设读写/备份/恢复
├── prompt.js           system prompt 组合（人设+记忆+行为指引）
├── qq/                 gateway、中间件、频率门控、会话、入站、出站、命令、媒体
├── memory/             长期记忆存储 + 自动提炼
├── tools/              qqbot_send_file / qqbot_describe_image / memory_*
└── web/routes.js       /qqbot-buddy/api/* 管理路由
client/client.js        dsh 设置页「QQ 机器人」手写 bundle（无需构建）
cordis.patch.yml        bundle patch（插入插件 + qqbot-buddy preset，停用 im-qqbot）
scripts/                install-local / test-profile / deploy-live / rollback
test/                   node:test 单测与隔离验收
```

## v0.16：多机器人 · 知识库 · 群友库 · 必要时涌现

v0.16 把单机器人插件升级成**多机器人宿主**，并补齐长期记忆、知识库、群友库与按需注入：

| 能力 | 说明 |
|---|---|
| 多机器人 | 同一插件实例可同时配置/连接多个 QQ 机器人；每个机器人有独立凭据、设置、会话、人设、记忆、知识、群友、表情包与工作区。设置页顶部有机器人选择器，概览 → 机器人列表/工作区与文件 可新建、启用、扫码绑定、删除与改路径。 |
| 每个机器人独立配置 | 所有运行期设置按机器人落盘；切换机器人后对话/能力/提示词/内容/权限页都读写该机器人的配置。 |
| 文件位置可指定 | 每个机器人有工作区根（默认 `<workspaceRoot>/bots/<id>`，legacy 机器人沿用旧 `cwd`），人设/memory/knowledge/members/stickers 五个资源路径可在「工作区与文件」里覆盖，并提示“不在工作区内”。 |
| 长期记忆 v2 | `index.json` v2（重要度、命中次数），新增按消息相关性召回 `memory.recall`；旧 v1 索引自动迁移，旧 workspace 无需搬文件。 |
| 知识库 | 条目 = 标题 + 正文 + 标签 + 作用域（全局/群/私聊）+ 重要度；markdown 落盘 + 索引；工具 `knowledge_search/knowledge_read/knowledge_save`；设置页「内容 → 知识库」可增删改查。 |
| 群友库 | 复用条目库，按 openid 稳定建档：昵称、别名、标签、备注、所在群、发言数、最近活跃；群消息自动收录活跃度；工具 `member_lookup/member_note`；设置页「内容 → 群友库」。 |
| 必要时涌现 | 每轮按当前消息/群/发言人检索 记忆 + 知识 + 群友，只把相关内容拼成【本轮相关背景】注入 prompt 的 `recall` 段；无关则完全不注入。设置页记忆页可调参数并用「立即预览」验证。 |

### v0.17：知识自动提炼 + 插件工具作用域收口

**知识自动提炼（阶段一：只提炼知识，不改群友备注）**

- 默认关闭，在「内容 → 知识库 → 自动提炼」里开启；每 N 轮（默认 6）从当前会话最近消息里提炼长期群知识
  （群规/固定活动/FAQ/重要结论/群梗），单次最多 3 条，60s 超时、后台跑、失败静默只记日志。
- 入库策略：**置信度 ≥ 阈值（默认 0.8）直接入库；低于阈值写「待确认」**。待确认条目**不参与检索/涌现注入**，
  在知识库里可「采纳 / 丢弃」；同标题同作用域自动合并，不重复建条目。
- 设置：`knowledge.autoExtract = { enabled, everyRounds, maxEntries, minConfidence, provider, model }`；
  provider/model 留空用当前机器人模型。支持手动「立即提炼」（可粘贴一段群聊文本试跑）。
- API：`POST /knowledge/extract`、`GET /knowledge/extract/stats`、`POST /knowledge/approve`；
  `GET /knowledge?status=pending|approved` 过滤；列表项带 `status` 字段。

**插件工具作用域收口（重要行为变化）**

- `memory_* / knowledge_* / member_* / qqbot_send_file / qqbot_sticker_save / qqbot_describe_image`
  不再注册到全局 tools 注册表，而是**只注册进 QQ 会话 agent 的 scope**：
  只有走 qqbot-buddy 会话（qqbot preset / 你为机器人选的 preset）的 agent 能看到/调用这些工具；
  宿主里的普通 Web agent、其它 preset 不会看到，也不会调用到。
- 工具解析仍然经 `exec.agent → BotRuntime`，多机器人互不串；agent 释放时作用域工具随 scope 自动清理。
- 兼容：单元测试与旧单机器人模式不变（旧的 `registerSendFileTool` 等签名保持可用，用于独立单测）。

### v0.18：群友备注自动提炼（阶段二）

- 与知识自动提炼**共用一次模型调用**：同一段群聊里可以同时产出知识条目和群友备注。
- 开关：`members.autoExtract = { enabled(默认 false), maxNotes(默认 2), minConfidence(默认 0.8) }`，
  在「内容 → 群友库」页配置；知识页的「立即提炼」会同时驱动两者。
- 匹配规则：优先按消息里的 `openid` 精确匹配成员；没有 openid 时按昵称/别名在当前群里精确匹配；
  匹配不到**不会**凭空建成员（避免垃圾条目）。
- 写入规则（重点）：**默认不覆盖人工备注**
  - 成员还没有备注 → 自动备注写进正文，标记 `notesSource=auto`；
  - 正文是之前自动写的 → 允许更新；
  - 正文是人工写的（UI/工具保存过）→ 正文不动，只追加到 `meta.autoNotes`（去重、最多 4 条），
    群友详情里显示「自动补充」，可一键「采纳到备注」（采纳后变人工备注并移除该补充）。
- 标签会自动合并（去重，最多 12 个）；低置信（< 阈值）直接跳过、不写。
- API：`POST /members/adopt {id, index}` 采纳自动补充；`GET /members` 列表项新增 `autoNotes` / `notesSource`；
  `POST /knowledge/extract` 返回值新增 `membersUpdated / membersSkipped`。

### v0.18.1：群友库改为手风琴式编辑

- 群友列表每行即一张折叠卡片：左侧状态点（绿=已有人工备注 / 黄=只有自动补充 / 灰=空），
  右侧「编辑 / 删除」；点「编辑」或行内名字在**原地展开**编辑区（昵称、标签、备注、自动补充、重要度），
  底部「取消 / 保存」，同一时间只展开一位，改完即收起。
- 自动补充仍在编辑区内展示，可一键「采纳到备注」；不会再跳到顶部的独立详情卡。
- 纯前端改动，API/数据格式不变。

### v0.18.2：升级后自动把旧记忆回填成群友备注

- 从旧版本（只有 MEMORY.md）升级后，群友库只有名字、备注为空——本次加了一次性迁移：
  首次启动时按群友昵称/别名匹配长期记忆事实，回填成该群友的备注。
- 规则：空备注直接写正文；已有人工备注不覆盖，只追加到「自动补充」；每位最多 5 条事实；
  marker 文件 `<state>/memory-backfill-v1.json` 保证只跑一次（之后由自动提炼继续补充）。
- 只读记忆、不改记忆；没有匹配到事实的群友保持原样。

### 数据布局（每个机器人一个工作区）

```
<workspaceRoot>/                     # config.workspaceRoot，空 = cwd
├── bots.json                        # 机器人注册表（不含 appSecret）
├── <legacy 机器人的原有文件>          # 从 v0.15 升级时原地保留
└── bots/<botId>/                    # 新建机器人的工作区
    ├── persona.md
    ├── memory/  knowledge/  members/  stickers/
    └── .qqbot/{state,media}/settings.json、credentials.json（0600）、sessions.json
```

- 凭据从 v0.16 起写 `<bot.stateDir>/credentials.json`（0600），不再依赖 profile patch；
  只有首次迁移且凭据文件不存在时，才用旧 `config.appId/appSecret` 播种 legacy 机器人。
- 升级不会移动旧数据：首次启动自动迁移出 `id=default` 的 legacy 机器人，路径与 v0.15 一致。
- 新增部署配置：`workspaceRoot`（工作区根，默认 cwd）、`maxBots`（默认 8）、`registerTools`
  （默认 true；测试/多实例部署可关）。

### 新增 HTTP API（均在 `/qqbot-buddy/api`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/bots` | 机器人列表 + activeBotId + maxBots + workspaceRoot |
| POST | `/bots/create` | `/bots/update` | `/bots/delete` | `/bots/activate` | 新建 / 改名启用改路径改凭据 / 删除 / 设为默认 |
| GET | `/knowledge` | `/knowledge/entry` | 条目列表（q/tag/scope/groupId/分页）与详情 |
| POST | `/knowledge/save` | `/knowledge/delete` | 新建/更新（缺 id 即新建）、删除 |
| GET | `/members` | 群友列表 + 群列表 + 标签 |
| POST | `/members/save` | `/members/delete` | 备注/标签/重要度、删除 |
| GET | `/recall/preview` | 用一段文本预览本轮会注入的【本轮相关背景】 |

其余旧接口都接受 `?botId=<id>`（GET）或 body `botId`（POST），缺省 = 当前 active 机器人。

### 迁移与兼容

- 旧 `settings.json`/`persona.md`/`memory`/`stickers` 路径原样可读；
- 旧 `index.json`（记忆 v1）自动迁移到 v2；旧部署没有 `bots.json` 时自动生成；
- 旧配置项（appId/appSecret/cwd/stateDir/mediaDir/settingsFile）继续有效，仅用于 legacy 机器人；
- 解绑会写空凭据墓碑，不会因为 config 里还留着旧凭据而“复活”。

## 安装

### 前置条件

| 依赖 | 说明 |
|---|---|
| dsh（DeepSeek Harness） | 已安装并能正常启动某个 profile（默认 `web`） |
| Node.js | **>= 20.3**（与 dsh 要求一致） |
| pnpm | `dsh plugin` 会把参数转发给 pnpm，需在 PATH 里 |
| QQ 机器人 | 在 [q.qq.com](https://q.qq.com) 创建，拿到 AppID / AppSecret；也可以装完后用扫码绑定 |

插件不依赖官方 `@tencent-connect/dsh-qqbot`，运行时依赖
`@tencent-connect/qqbot-nodejs`、`@tencent-connect/qqbot-connector`、`js-yaml`、`qrcode`
都已在本包 `package.json` 里显式声明，安装时自动拉取。

### 一条命令安装（推荐）

```bash
npx -y github:Ethereal-ljq/dsh-qqbot-buddy
```

这条命令做三件事，**不需要手动改任何配置文件**：

1. `dsh plugin --profile web add github:Ethereal-ljq/dsh-qqbot-buddy` —— 初始化 profile（若不存在）并用 pnpm 装包；
2. 把 `dsh-qqbot-buddy` 登记进 profile `package.json` 的 `dsh.profile.bundles`；
3. `dsh --profile web --dump-config` 自检，确认插件已进入插件树。

> 为什么要第 2 步：dsh 只会加载列在 `dsh.profile.bundles` 里的 bundle。新版 dsh 在 `dsh plugin add` 时会自动登记新依赖，
> 但如果这个包**之前已经装过**（比如你手动跑过 pnpm），重跑 add 不会补登记 —— 安装器会显式补上，所以两种情况下都能装好。

指定 profile 用 `--profile`（**必须是带 Web 界面的 profile，默认为 `web`**）：

```bash
npx -y github:Ethereal-ljq/dsh-qqbot-buddy --profile web
```

> 不要用 `dsh plugin --profile <自建名>` 初始化出来的 base-only profile：那种 profile 里没有 `agentPresets` 服务，
> 插件的 `preset-qqbot-buddy` 会一直 pending，启动时会看到 “1 entry did not activate”。

### 从源码安装 / 本地开发

```bash
git clone https://github.com/Ethereal-ljq/dsh-qqbot-buddy
cd dsh-qqbot-buddy
node scripts/install.mjs --spec .
```

`--spec .` 表示以本地目录为安装源（改完代码重跑即可更新）。也可以直接用 pnpm 规范：
`--spec /abs/path`、`--spec ./dsh-qqbot-buddy-0.7.2.tgz`、`--spec github:owner/repo`。

其他选项：

```bash
node scripts/install.mjs --dry-run      # 只打印将执行的操作
node scripts/install.mjs --skip-check   # 跳过 dump-config 自检
node scripts/install.mjs --help
```

### 不想用安装器？（等价的两条命令）

```bash
dsh plugin --profile web add github:Ethereal-ljq/dsh-qqbot-buddy
# 新版 dsh 会自动登记 bundle；若你的 dsh 较旧、dump-config 里看不到 qqbot-buddy，
# 手动把 "dsh-qqbot-buddy" 加进 profile package.json 的 dsh.profile.bundles 数组即可。
```

### 首次配置：绑定 QQ 机器人

重启 dsh 后打开 **设置 → QQ 机器人**，有两种方式：

1. **扫码绑定（推荐）**：页面会显示 [q.qq.com](https://q.qq.com) 的二维码，手机 QQ 扫码并在手机上确认后，凭据会自动写入 profile 并热切换 bot。
2. **手动填写**：在设置页填 appId / appSecret，或在 profile 的 `cordis.patch.yml` 里覆盖：

   ```yaml
   - id: qqbot-buddy
     config:
       appId: '你的 AppID'
       appSecret: '你的 AppSecret'
       cwd: /path/to/bot-workspace   # bot 的工作目录（人设/记忆/表情包都在它下面）
   ```

   也支持环境变量 `QQBOT_APPID` / `QQBOT_SECRET`。

> `cwd` 留空时取 dsh 进程的启动目录。建议显式设成一个固定目录，否则换个目录启动 dsh 就会换一套人设/记忆/表情包。

> **同一个 AppID 只能有一条 QQ WebSocket 连接**。如果之前部署过官方 `@tencent-connect/dsh-qqbot`（`im-qqbot`），请先在 profile 里停用它，否则两个插件会互相把对方踢下线。

### 安装后自检

```bash
# 1) 插件树里能看到插件与它带的 preset（exit 0、stderr 为空即通过）
dsh --profile web --dump-config | grep -A1 '^- id: qqbot-buddy'
# 预期输出：
# - id: qqbot-buddy
#   name: dsh-qqbot-buddy

# 2) 重启 dsh 后打开 Web → 设置 → QQ 机器人，状态卡片应显示 appId / ready
# 3) 群里 @ 一下机器人，能回复即成功
```

### 安装常见问题

**装完 `dump-config` 里没有 `qqbot-buddy`。**
多半是这个包装过但没登记进 bundle（`dsh plugin add` 只自动登记**本次新增**的依赖）。装一次再卸一次即可，或重跑安装器：

```bash
dsh plugin --profile web remove dsh-qqbot-buddy
npx -y github:Ethereal-ljq/dsh-qqbot-buddy
```

**安装时出现 `[WARN] Issues with peer dependencies found`。**
正常现象，可以忽略：插件的 6 个 `@deepseek-ai/*` peer 由 dsh 宿主提供，不该被装进 profile。
**不要**把 profile `pnpm-workspace.yaml` 里的 `autoInstallPeers` 改成 `true` —— 那会让 pnpm 去 registry 找
`@deepseek-ai/dsh-type-meta` 之类未发布的包，直接 `ERR_PNPM_FETCH_404` 装失败。已误改的话，改回 `false` 再装即可。

**`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` / 提示需要 allowBuilds。**
本包没有构建脚本，正常不会触发；万一触发（比如你自己加了 prepare 脚本），按报错里 pnpm 打印的键
（形如 `dsh-qqbot-buddy@git+<url>#<sha>: true`）加到
`$DSH_HOME/profiles/web/pnpm-workspace.yaml` 的 `allowBuilds:` 下重试。

**`ERR_PNPM_FETCH_404` / 装到一半失败。** 先确认 `pnpm --version` 可用（`dsh plugin` 会转调 pnpm），
以及能访问 npm registry（`@tencent-connect/*`、`js-yaml`、`qrcode` 需要联网下载）。

### 更新

```bash
# 从 GitHub 更新
npx -y github:Ethereal-ljq/dsh-qqbot-buddy

# 从源码更新
git pull && node scripts/install.mjs --spec .
```

更新后重启 dsh 生效（运行期设置是人设/频率那些，存在 `~/.dsh-qqbot/buddy/settings.json`，升级不会丢）。

### 卸载

```bash
dsh plugin --profile web remove dsh-qqbot-buddy
# 再从 profile package.json 的 dsh.profile.bundles 里删掉 "dsh-qqbot-buddy"
```

运行期数据（settings.json、人设备份、下载的图片）在 `~/.dsh-qqbot/`，需要的话自行删除。

## 插件配置（cordis config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 空 | QQ 机器人凭据；也可用环境变量 `QQBOT_APPID` / `QQBOT_SECRET` |
| `cwd` | `process.cwd()` | bot 工作目录（人设、memory、stickers 的相对基准）；也是默认 `workspaceRoot` |
| `workspaceRoot` | 空 = cwd | 多机器人工作区根：新建机器人在 `<root>/bots/<id>`，`bots.json` 也在根下 |
| `maxBots` | `8` | 最多同时配置的机器人数（含 legacy 机器人） |
| `registerTools` | `true` | 是否注册插件工具；测试/多实例部署可关 |
| `preset` | `qqbot-buddy` | QQ agent 使用的 preset（由本包 patch 提供） |
| `provider` / `model` | 空 | 空 = 宿主默认模型 |
| `stateDir` | `<cwd>/.qqbot/state` | settings.json、凭据、人设备份、会话映射（仅 legacy 机器人沿用） |
| `mediaDir` | `<cwd>/.qqbot/media` | 入站图片/视频/文件下载目录（仅 legacy 机器人沿用） |
| `textChunkLimit` | `4500` | 单条 QQ 消息最大字符数 |
| `historyLimit` | `20` | 群聊历史上下文条数 |
| `sessionIdleTimeout` | 30 分钟 | 闲置会话回收 |
| `processingTimeoutMs` | 30 分钟 | 单轮处理超时 |
| `autoStart` | `true` | 是否自动连 QQ（false 时只挂设置页，便于调试） |
| `bindOnMissingCredentials` | `true` | 缺少 appId/appSecret 时自动启动扫码绑定流程 |
| `access` | open | 私聊/群聊白名单 |
| `sendFile` | 白名单开 | `qqbot_send_file` 发送路径限制（mediaDir + cwd + extraRoots） |
| `vision` | 开 | `qqbot_describe_image` 视觉路由；`provider`/`model` 为空时自动回退宿主默认模型；首轮预算下限 4096，空文本自动升到 8192/16384 重试，同图同 prompt 描述缓存 30 分钟 |

运行期设置（回复频率、触发规则、人设路径/模式、记忆目录与自动提炼）都可在设置页修改，
**即时生效、无需重启**，保存在 `<stateDir>/settings.json`。

## 回复频率语义

| groupMode | 行为 |
|---|---|
| `all` | 每条群消息都回（老行为） |
| `count` | 累计 N 条群消息后回一次；`flushAfterSeconds>0` 时，即使没凑满 N 条，最早一条等待超时也会回（避免冷场） |
| `interval` | 距上次回复至少 `intervalSeconds` 秒才回；期间消息只进历史缓冲 |
| `probability` | 每条消息以 `probability` 概率回复 |
| `adaptive` | **推荐**：最后一条消息后静默 `debounceSeconds`（默认4s）再回一次；回复后冷却 `cooldownSeconds`（默认12s）；从批次首条起最多等 `maxWaitSeconds`（默认20s）就强制回；`requireRelevance=true` 时批次里没有问句/图片/文件就不回（避免抢话） |

- 强制回复：`@机器人`（`triggers.onMention`）、引用/回复机器人消息（`triggers.onReplyToBot`）、
  命中 `triggers.keywords`（子串）、私聊（`reply.c2cEnabled`）。
- `reply.minGapSeconds`：非强制回复之间的全局最小间隔（adaptive 模式下用 cooldownSeconds 控制）。
- adaptive 缓冲最多 30 条/群，超时/触发后清空；模式切走或重启会丢弃缓冲。
- 未触发的群消息仍进入历史缓冲（默认 20 条），触发时模型能看到这一批上下文，
  并收到“挑真正需要回应的话题回复”的节奏提示 —— 这就是“针对性地回”。
- 聊天命令（频率门控之前直接响应，未知 `/xxx` 当普通消息）：
  - `/new` `/reset` `/clear`：开启新会话（旧会话进入可恢复栈）
  - `/resume`：恢复上一个被 `/new` 替换掉的会话（带回之前的上下文，可连续恢复多个）
  - `/stop`：中止当前生成；`/status`：状态/频率/可恢复会话数/统计；`/help`；`/ping`

## 能力边界：显式管理 bot 能用哪些工具

**默认拒绝**：只有被「已启用能力」授权的工具名才会给到模型，其余一律屏蔽——
不再维护"要屏蔽哪些工具"的黑名单（那样新装的插件默认会漏进来）。

能力表是唯一真相（`lib/tools/catalog.js`），挂载、白名单、assembly 过滤、技能提示都从它派生：

| 能力 | 放行的工具 | 备注 |
|---|---|---|
| `workspace` 工作区读写 | read / write / edit / glob / grep | 按需挂 dsh-tool-fs(+search) |
| `web` 联网 | web_search / web_fetch | 按需挂 dsh-tool-web |
| `memory` 长期记忆 | memory_save / memory_search / memory_read / memory_list | 受 `memory.enabled` 二次约束 |
| `stickers` 表情包 | qqbot_send_file / qqbot_sticker_save | 关闭收藏后只剩发送 |
| `vision` 看图片 | qqbot_describe_image | |
| `skills` 技能 | skill | **默认关闭**，见下节 |
| `imagegen` 图片生成 | generate_image / generate_images / edit_image / find_inspiration | **默认关闭**；工具来自宿主插件，打开即用 |

- 开关位置：`settings.tools.capabilities`（`workspace/web/memory/stickers/vision` 沿用 `settings.features`）。
- **宿主 preset 也走同一份白名单**：不再有手写屏蔽名单，预设自带的 bash/团队/画布等工具默认不进 QQ 会话；
  确实需要时用 `settings.tools.extraAllowed` 显式放行（MCP / 第三方插件工具同理：插件只负责"允许出现"，不负责安装）。
- 诊断：`GET /api/tools` 返回每项能力的启用状态、放行的工具、已挂载插件与可见技能，便于排障。

## 技能（skills）的过滤

- 宿主 `dsh-skill-filesystem` **没有"按名过滤"能力**，所以本插件自带一个 provider
  （`lib/skills/provider.js`），按宿主公开的 `ctx.skills.registerProvider()` 契约注册，
  只把白名单里的技能暴露给 agent——**不改宿主、不动 `~/.dsh/skills`**。
- 策略：`settings.tools.skills = { mode: 'all' | 'allow', allowed: ['bili-get'] }`
  - `mode: 'all'`：本机全部技能可见（等价旧版 `extraAllowed: ['skill']`，升级时自动迁移）；
  - `mode: 'allow'`：只暴露 `allowed` 里的技能；
  - 能力开关关闭：连 `skill` 工具都不挂。
- 技能扫描与宿主一致：`~/.dsh/skills`、`~/.agents/skills`、项目 `.dsh/skills` / `.agents/skills`，
  只扫一层（`<name>/SKILL.md` 或 `<name>.md`），frontmatter 规则与宿主相同。
- 提示词里的【技能】段按**当前可见技能**动态生成，装/删技能会自动跟随，不再写死技能名。

## Agent 预设与能力开关的关系

- **内置组合（推荐）**：preset 只负责 compaction；工具由插件在创建 agent 时按能力开关动态挂载。
- **宿主 preset**（standard/ptc 等）：该预设自带的工具**不会自动放行**，仍受上面同一份能力白名单约束。
  想要哪个就在 `tools.extraAllowed` 里显式列出——这样"bot 能用什么"始终由本插件说了算。
- 修改只影响**新会话**；点「应用到当前会话」会重置 bot 会话（清空上下文）。

## 看图（视觉理解）

- 入站图片会先下载到 `~/.dsh-qqbot/media/`，消息里给模型一行 `Image: <本地绝对路径>`；
  模型调用 `qqbot_describe_image` 读图。
- 视觉路由来自插件配置 `config.vision`：`provider` / `model` / `maxTokens` / `timeoutMs`；
  留空时回退宿主默认模型（`agentDefaultModel`）。
- 若看图失效：检查 `cordis.patch.yml` 里 `qqbot-buddy` 条目的 `config.vision` 是否存在，
  改完重启 dsh web（或等 HMR 重载）。当前部署使用 `deepseek-account / deepseek-flash`。

## 连发多条（气泡拆分）

- 设置 → 回复频率 →「气泡拆分」三档：
  - **空行自动拆（默认）**：模型用空行分段时，每段发成一条消息，需要拆的正常拆；
  - **只发一条**：空行只当换行（只有显式 `[[msg]]` 才拆）；
  - **永不拆分**：整段只发一条。
- 字数控制靠 prompt/persona：「大多数回复只发一条、1~2 句；不要每次补第二段；确实内容多才分条」。
- 代码块、表格、清单、较长的正式回答不会被长度切分破坏。
- 一个 turn 只发**最终**回复：先说话再调工具时，中间那句不会发出去（否则会出现"两条很像"的重复气泡）。
- 与 `persona.md` 的【连发多条】段落配合；默认规则已改成「空行分隔、不要写标记」。

## /new 与 Web 工作区

- QQ 会话的 cwd 固定是配置的 `cwd`（如 `~/my-bot`），session 日志存在
  `~/.dsh/sessions/--home-qiqi-project-qqbot--/`。
- Web 侧栏按 `~/.dsh/storages/workspace.json` 的 sessionIds 展示会话；插件创建/恢复会话后会自动
  attach 到 cwd 对应的 workspace，所以 `/new` 之后的新会话也会出现在「qqbot」工作区里。
- QQ agent 会屏蔽宿主 `team:identity` 必填上下文，不会再把 "You are the Team Lead" 注入对话。

## 人设 / 功能提示词 / 自我改进（三段分开）

- **人设**（`persona.md`）：只管“我是谁、什么脾气、怎么说话、什么时候认真、语言底线”；不再包含能力清单、工具用法、消息格式、长度/分条规则、表情包规则。
- **功能提示词**（`settings.prompts`，设置 → 人设 →「功能提示词（与人格无关）」）：四段可分别开关/编辑——
  - 工具与能力边界（能做什么/不能做什么、memory_* / 看图 / 发表情 / 收藏、安全红线：不泄露配置密钥）
  - 消息格式与长短（群聊消息怎么读、一条为主、少补一段、分条上限、清单/emoji 规则、[[msg]] 禁用）
  - 群聊节奏（只在群聊且非「每条都回」时注入）
  - 表情包规则（何时发、一次一张、收藏注意；后面自动追加表情包库目录）
  - 文本框直接显示**当前生效文本**（未自定义时就是内置默认），改完保存即覆盖；每段有「恢复默认」；关掉开关 = 不注入。改完下一条消息生效。
- **自我改进**（`settings.memory.selfImprovePrompt`）：学习/记忆规则。

## 人设与自我改进提示词（分开）

- `persona.md` 只负责人设、语气、口癖；学习/记忆规则不再混在人设里。
- 自我改进规则存在 `settings.memory.selfImprovePrompt`，作为独立的 **【自我改进】** 段注入 system prompt
  （设置 → 自我改进 →「自我改进提示词」，可编辑，留空用内置默认）。
- 自动记忆提炼器的 prompt 也是独立的：`settings.memory.collectorPrompt` 可覆盖，
  支持 `{{maxFacts}}` / `{{maxFactChars}}` 占位（设置 → 自我改进 →「记忆提炼提示词（高级）」）。
- 工具说明（memory_save / memory_search 等）仍在固定的工具约定里，那是能力说明，不属于人设。

## 长期记忆可见 & 口头禅管理

- 设置 → 自我改进新增「长期记忆（当前注入）」卡片：列出 MEMORY.md 里已记住的每条事实（日期/#标签/正文），
  显示条数、注入上限与实际注入字符数、是否截断；原始文件仍可在「记忆文件」里编辑。
- 新增独立「口头禅」tab：启用开关、逐条（口头禅 / 备注 / 是否启用 / 删除）、手动添加；
  打开页面会自动扫描长期记忆里 #口头禅 / #说话风格 / #接梗 等事实中的引号短语作为候选，「加入」后生效。
- 口头禅作为独立的【口头禅】段注入 system prompt（一次回复最多用 1 个），不写进 persona.md；
  `settings.phrases = { enabled, items:[{text,note,enabled}] }`。

## 离线 / 内网安装（tarball）

没有外网、或想锁定版本时用 tarball 安装（仍然推荐走安装器，它会顺手登记 bundle）：

```bash
npm pack                                        # 生成 dsh-qqbot-buddy-<version>.tgz
node scripts/install.mjs --spec ./dsh-qqbot-buddy-<version>.tgz
```

把 tgz 拷到别的机器也能装：`node scripts/install.mjs --spec /path/to/xxx.tgz`。

## 开发

```bash
node --test test/*.test.js          # 309 个单测，不需要网络和 QQ 凭据
node scripts/install.mjs --spec .   # 把当前仓库装进 profile（改完代码重跑）
```

底层脚本（开发用）：

| 脚本 | 用途 |
|---|---|
| `scripts/install-local.sh` | rsync 把仓库同步进 profile 的 node_modules，不动 package.json / patch |
| `scripts/link-deps.sh` | `link:` 模式开发时把依赖软链进仓库 |
| `scripts/install-package.sh` | 打包 tgz 放 profile `vendor/` 并按 file: 依赖安装（作者的部署方式） |
| `scripts/deploy-live.sh` | 一次性把 profile patch 改成 qqbot-buddy 部署（停用官方 im-qqbot） |
| `scripts/migrate-v0.2.sh` | 从旧的官方插件部署迁移到本插件（自带 dump-config 预演与回滚） |

## 故障排查：link 安装找不到依赖

- profile 用 `link:<repo>` 安装时，dsh 会从 repo 加载插件；
  repo 没有 `node_modules` 就会报 `Cannot find package '@tencent-connect/qqbot-nodejs'`。
- 修复：在 repo 跑一次 `bash scripts/link-deps.sh`（把 QQ SDK / js-yaml / qrcode / @deepseek-ai/* 软链到 repo），
  然后重启/重新加载插件。该脚本可重复执行；`install-local.sh` 的复制安装不需要它。

## 发送 QQ 表情

- 官方群聊/单聊 Bot API 只有 `msg_type=0/2/7`（文本/Markdown/富媒体），**不支持**像频道那样的 `<emoji:id>` 原生表情元素。
- 插件发送 Unicode emoji（😄😂🤔😑👍 等），QQ 客户端会按系统表情显示；模型可以直接写，
  出站还会把 `[捂脸]` / `【表情: 赞】` / `[face: 得意]` 之类占位转成对应 Unicode，避免把“表情: 赞”当文字发出去。
- 频道场景才支持 `<emoji:id>`（type=1 系统表情）；本插件当前主要处理群聊/单聊。
- 如果需要 QQ 小黄脸的**原画**，只能作为图片/表情包发送（`qqbot_send_file` 或用户表情包库），不能作为原生 face 元素发送。

## 群聊话术默认

- 默认不再要求“回复某人时必须 @”（`persona.groupExtraPrompt` 默认为空；群里人少时纯文本 @ 也不是真实 @）。
  需要时可在 设置 → 人设 → 群聊额外指令 里自行添加。
- 群聊模式为 count/interval/probability/adaptive 时，prompt 会附加节奏规则：
  没被直接问到最多 2~3 句、不要每句反问续话头、同话题无新信息不追加、别人聊天不插话。

## 表情包库与收藏

- 默认目录 `<cwd>/stickers`，元数据存 `stickers/index.json`（无元数据的历史文件按文件名当情绪，如 `laugh.png` → laugh）。
- 设置 → 表情包：上传（png/jpg/gif/webp，默认上限 8MB）、删除、改 emotion/tags/note；可关闭「启用表情包」或「允许 bot 收藏」。
- bot 工具 `qqbot_sticker_save`：看到喜欢的表情/贴图时把消息里的本地图片收藏进库
  （`source_path` 必须是 mediaDir / cwd / sendFile.extraRoots 内的图片；按内容 sha256 去重，重复收藏会提示“已在库”；
  每日收藏上限 `stickers.dailyLimit` 默认 10 张，API 上传不受此限）。
- 可用表情目录会随每轮 system prompt 注入（最多 48 条），收藏后下一轮即可用
  `qqbot_send_file` 发出。
- HTTP：`GET /api/stickers`、`GET /api/stickers/file?name=`、`POST /api/stickers/{upload,update,delete}`。

## Self-improve 记忆

默认目录 `<cwd>/memory`：

```
memory/
├── MEMORY.md          热记忆（每条一行，注入 system prompt；最多 800 条）
├── notes/YYYY-MM-DD.md 当日全量记录（检索/翻阅）
└── index.json          去重索引（sha256）
```

- 工具：`memory_save`（记录重要信息，自动去重）、`memory_search`（全文检索）、
  `memory_read`（读文件）、`memory_list`（列文件）。
- 自动提炼：每 `everyRounds` 轮回复后，后台用 LLM 从最近对话中提炼
  “值得长期记住的事实/偏好/约定”，写入记忆；可在设置页关闭或手动「立即提炼」。
- 记忆是实时读的：改了记忆文件/人设，下一条消息就生效。

## 设置页

dsh Web → 设置（左下角）→「QQ 机器人」。分区按**「要回答的问题」**组织：
顶部 6 个工作区（官方 tab 形态，页数写在标签里，如 `提示词 (6)`），工作区内再用胶囊 chip 切换具体页面
（窄面板下是横向 chip 行，面板够宽时自动变成左栏）。

界面风格与 dsh 官方 primitives / 插件市场一致：**无 emoji、无彩色装饰**，只用字号/字重/灰阶与 1px 细线分层；
颜色全部走 `--dsw-alias-*` 令牌，浅色与深色主题都自动适配。

| 工作区 | 页面 | 干什么 |
| --- | --- | --- |
| 概览 | 状态总览 | 连接状态、扫码/手动绑定、收发统计、当前生效策略、维护操作、运行路径 |
| 对话 | 回复策略 | 总开关、群聊模式（含「自适应（推荐）」）、阈值/兜底/间隔/概率、adaptive 参数、私聊开关 |
| | 触发规则 | @必回、引用必回、必回关键词 |
| | 语气与分条 | 气泡拆分（行为的"发几条"）+ 消息格式、群聊节奏两段提示词 |
| 能力 | 模型与预设 | provider / model / reasoningEffort、Agent preset、应用到当前会话 |
| | 能力与工具 | 能力开关（默认拒绝）、技能白名单、实际生效工具、未归类工具一键放行、额外放行 |
| 提示词 | 组装顺序 | 12 段各排第几位、本次是否注入，带「去编辑」 |
| | 身份与人格 | 人设正文、人格卡、人设模式、群聊/私聊专属补充 |
| | 说话方式 | 消息格式与长短 + 群聊节奏（纯提示词） |
| | 口头禅 | 从对话/记忆里学到的口癖 |
| | 工具约定 | 每个工具该怎么用 |
| | 最终提示词 | 拼好的完整 prompt（只读，用来校验） |
| 内容 | 表情包 | 开关 / 收藏上限 / **发送频率** → 表情包使用规则（提示段）→ 表情库 → 上传/删除 |
| | 记忆与自我改进 | 记忆开关/目录/注入上限、记忆文件、手记、立即提炼、自动收集参数、prompt 预览 |
| 权限 | 命令与管理员 | 全部 / 命令与用法；谁会改变状态的命令 |
| | 安全红线 | 不泄露密钥配置、不越权（提示段） |

「表情包使用规则」这一页写的是 `settings.prompts.sections.stickers`（注入 system prompt 的【表情包】段），
管"什么时候发、发几张、要不要解释"；它和"能不能发 / 库里有什么"是两回事，所以放在同一页但分开两张卡。

旧链接（`navigate("reply")` / `"tools"` / `"prompts"` 等）由 `VIEW_ALIASES` 自动映射到新位置；
服务端结构升级但页面没刷新时，`itemsOf()` 会退回旧的 `children` 列表，不会白屏。

## 扫码绑定（移植官方流程）

- 安装后首次启动若凭据为空，插件会自动调用 `startQrConnect`，设置页「概览 → 连接与绑定」显示二维码；
  手机 QQ 扫码确认后，`appId/appSecret` 自动写入 profile 的 `cordis.patch.yml`（id=qqbot-buddy，
  保留其它配置键；写前自动备份）并热重启 bot，无需重启 dsh。
- 已绑定后可「解绑」（清除 profile 里的凭据，重新进入扫码流程）或「手动填写」appId/appSecret。
- 二维码在宿主侧用 `qrcode` 渲染成 SVG data URL，secret 永不下发到浏览器。
- 若只想用环境变量/配置文件：设置 `bindOnMissingCredentials: false` 或直接写 config 的 appId/appSecret。

## HTTP API

`/qqbot-buddy/api/{state,settings,models,persona,persona/restore,memory,memory/file,memory/append,memory/collect,prompt,action}`
以及扫码绑定路由 `/qqbot-buddy/api/bind/{state,refresh,manual,unbind}`；仅监听本机 dsh webServer，返回 JSON。详见 `DESIGN.md`。

## 测试与验收

```bash
npm test                                           # 单元/路由测试（= node --test test/*.test.js）
bash scripts/test-profile.sh                       # 隔离 DSH_HOME 启动 + dump-config 验证
bash scripts/test-profile.sh --serve               # 另起 127.0.0.1:3099 测试实例（不连真 QQ）
```

隔离实例的截图在 `test/artifacts/`。

## 回滚

`scripts/deploy-live.sh` 每次改动前把 live `cordis.patch.yml` 备份到
`~/.dsh/backups/qqbot/`，`scripts/rollback.sh` 恢复最新备份；也可手动恢复
`~/my-bot/rollback-web-profile.sh` 指向的 14:24 基线。

## 已知限制

- 只支持 WebSocket 传输（与官方插件一致），不支持 Webhook。
- 流式输出未实现（回复在整段生成后发送）。
- 审批/问答按钮通道未移植（chatonly 场景不需要）；工具调用结果默认不展示。
- `reply-to-bot` 的识别依赖引用消息里的 isBot/发送者/文本匹配启发式，极端情况下可能漏判。
- 记忆检索是朴素全文包含匹配，适合个人使用量级。
## 2026-10-26 新增：人格卡 / 命令与权限 / 8 个设置分页

- 设置页收敛为 8 个分页：概览、回复与触发、Agent 与模型、人设、口头禅、表情包、记忆与自我改进、命令与权限。
- 人设页顶部新增人格卡：
  - **手动新建卡（自定义内容）**：直接写一套新人设保存为卡片，不必先改当前人设；
  - **编辑内容**：读取并修改任意卡片正文（改的是使用中的卡时，保存后自动同步到当前人设并备份）；
  - 另外支持把当前人设存成卡、一键切换、用当前人设覆盖当前卡、改名/描述、删除。
  - 卡片存在工作区 `personas/` 目录；切换/同步都会自动备份旧人设。
- 命令与权限页：显式列出全部 / 命令（usage、说明、是否仅管理员）；管理员门控默认关闭，开启并配置 openid/昵称名单后，只有名单内用户能执行 /new /reset /clear /resume /stop；/help /ping /status /id 所有人可用。在群里发 /id 可查看自己的 openid。
- 新增 API：GET /persona/cards、GET /persona/cards/content?id=、POST /persona/cards、/persona/cards/update、/activate、/delete；GET /commands。