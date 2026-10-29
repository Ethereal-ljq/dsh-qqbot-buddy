# dsh-qqbot-buddy v0.16 设计契约：多机器人 · 记忆 · 知识库 · 群友库

> 状态：实现中（Lead 维护）。所有并行任务必须遵守本文件的接口与文件所有权。
> 仓库根：`/home/qiqi/project/dsh-qqbot-buddy`（注意不是 session cwd）。
> 测试环境：`/home/qiqi/project/qqbot/.dsh-dev`（隔离实例 3098，禁止触碰 live 3080 / `~/.dsh`）。

## 0. 目标（用户方案）

0. 多机器人：同时绑定多个机器人，每个机器人独立配置；每个机器人可指定插件产生的文件位置（默认都在一个工作区下）。
1. 长期记忆系统完善（相关性召回、重要度、去重、按机器人隔离）。
2. 知识库系统（条目 + 标签 + 作用域 + 检索）。
3. 群友库系统（复用知识库的条目实现；按群记录成员画像）。
4. 必要时涌现：每轮对话按当前消息/群/发言人做相关性检索，只注入相关条目；同时提供按需检索工具。
5. UI：与现有 `client/client.js` 风格一致（qqb- 类名、Card/Button/Section 组件、schema 驱动），不堆砌。
fin. 全部包含在插件内；用 `.dsh-dev` 隔离环境做侧安装验证。

## 1. 数据布局（每个机器人一个工作区）

```
<plugin cwd>                                  # cfg.cwd，DSH 进程/agent 的 cwd（保持现状）
<workspaceRoot>                               # 新增 config.workspaceRoot，默认 = resolve(cfg.cwd)
├── bots.json                                 # 机器人注册表（无密钥；0600）
├── <legacy bot 的原有文件>                    # 旧版单机器人目录结构，原地保留
├── bots/<botId>/                             # 新建机器人的工作区（可被 bot.workspaceDir 覆盖）
│   ├── persona.md  memory/  stickers/  knowledge/  members/
│   └── .qqbot/{state,media}/
│       ├── settings.json                     # 该机器人的运行期设置
│       └── credentials.json                  # appId/appSecret（0600，不写进 bots.json / 不返回给前端）
└── ...
```

- **bots.json**（`{version:1, activeBotId, bots:[...]}`）：每条
  `{ id, name, appId, enabled, legacy?, workspaceDir, createdAt, updatedAt }`。不含 appSecret。
- **凭据**：`<bot.stateDir>/credentials.json`（0600）；绑定/解绑写这里，不再依赖 profile patch。
  兼容迁移：仅当凭据文件不存在时，才用旧 `config.appId/config.appSecret` 播种 legacy bot。
- **目录解析**（lib/bots/paths.js 单一真相，按 bot 记录 + settings 覆盖计算）：
  `workspaceDir`（bot 记录）→ `stateDir=ws/.qqbot/state`、`mediaDir=ws/.qqbot/media`、
  `settingsFile=state/settings.json`、`persona=ws/persona.md`、`memory=ws/memory`、
  `knowledge=ws/knowledge`、`members=ws/members`、`stickers=ws/stickers`。
- **迁移**：无 bots.json 且（旧 settings/人设/凭据任一存在）→ 建 `id='default'`、`legacy:true`、
  `workspaceDir=cfg.cwd` 的机器人，沿用旧 `stateDir/mediaDir/settingsFile`；其余新建机器人按上面布局。
- 目录覆盖：settings 里可改 `memory.dir / knowledge.dir / members.dir / stickers.dir / persona.path`，
  允许工作区外路径但 UI 必须提示“不在工作区内”。

## 2. 模块契约

### 2.1 记忆（`lib/memory/store.js`，保持现有导出 + 新增）

`createMemoryStore({ settings, logger })` 不变。新增：
- `recall(query, { limit=6, tags=[], minImportance, now })` → `[{text, tags, importance, at, score}]`
  纯同步、只读，按 词面匹配(title/正文) + tag + importance + 时间衰减 打分；无 query 返回最近/高重要度条目。
- `stats()` → `{facts, hotEntries, chars, byImportance:{high,normal}, lastSavedAt}`
- `saveFact` 返回/存储的 entry 增加 `importance`（已有）与命中计数（`hits`、`lastHitAt`），index.json 版本 2，
  读旧 v1 index.json 自动迁移（缺失字段补默认）。MEMORY.md 文本格式保持不变（人可读、prompt 直接用）。
- 设置读取一律容错：`settings.get().memory.recall` 缺省时用内置默认（maxItems 6 / maxChars 1200 /
  recencyHalfLifeDays 30 / importanceWeight 2 / minScore 0.15）。
- collector（`lib/memory/collector.js`）保持 `createCollector({ctx, settings, memoryStore, logger})` 与
  `noteTurnEnd/collectNow/stats` 契约；允许内部改用 recall 去重，但不得破坏现有测试。

### 2.2 通用条目库（新文件 `lib/entries/store.js`）

`createEntryStore({ dir, kind, logger })`，`dir` 可以是字符串或 `() => string`（每次读取，支持设置热改）。
- 磁盘：`<dir>/entries/<id>.md`（YAML-ish frontmatter + markdown 正文），`<dir>/index.json`（搜索索引），
  `<dir>/collections.json`（可选，用于群名/标签聚合缓存，可省）。
- 条目：`{ id, kind, title, body, tags:[], scope:'global'|'group'|'c2c', groupId, importance:0..3,
  source:'manual'|'tool'|'auto'|'web', meta:{}, createdAt, updatedAt, hits, lastHitAt }`
- API（同步、容错、原子写、0600、单文件 256KB / 读取 1MB 上限）：
  `ensure()`, `dir()`, `get(id)`, `save(input)`（无 id=新建；返回完整条目）, `remove(id)`,
  `list({q, tag, scope, groupId, limit, offset})` → `{total, items:[summary]}`,
  `search(q,{limit,scope,groupId})` → `[{id,title,tags,score,snippet}]`,
  `recall({query, scope, groupId, limit})` → 带 score 的条目（排序：scope 命中 > tag/词面 > importance > 新近）,
  `stats()` → `{total, byScope, tags:[{tag,count}], updatedAt}`,
  `groups()` → `[{groupId, count, name}]`（成员库用）。
- 不引入外部依赖（不要用 js-yaml；自己写 frontmatter 解析/序列化，字段值只允许 scalar 与字符串数组）。

### 2.3 知识库（新文件 `lib/knowledge/store.js`）

`createKnowledgeStore({ settings, logger, dir })`：内部 `createEntryStore({dir: dir || (() => settings.get().knowledge.dir), kind:'knowledge'})`，
对外暴露同构 API（ensure/get/save/remove/list/search/recall/stats）+ `config()`（knowledge 设置段）。
设置缺省：`settings.knowledge = { enabled:true, dir, injectMaxChars:2500, maxPerTurn:4, autoExtract:false }`。

### 2.4 群友库（新文件 `lib/members/store.js`）

复用 entries：`createMemberStore({ settings, logger, dir })`，一个成员 = 一条 kind='member' 条目，
`id` 由 openid 稳定派生（如 `m_<sha1(openid).slice(0,16)}>`），`meta` 存
`{ openid, name, aliases:[], groups:{ [groupId]: { name?, firstSeenAt, lastSeenAt, messageCount } } }`。
- `visit({ groupId, groupName, openid, name, at })` → upsert，累加 messageCount、更新 lastSeenAt（同步、轻量，每条群消息调用）。
- `recallAlly({ query, groupId, senderId, limit })` → 当前群/发言人相关成员（发言人本人最高权重）。
- `list({ groupId, q, limit })`、`save({id, name, tags, notes, importance})`、`remove(id)`、`groups()`、`stats()`。
设置缺省：`settings.members = { enabled:true, dir, autoRecord:true, injectSender:true, maxPerTurn:3, maxChars:800 }`。

### 2.5 涌现（`lib/context/emergence.js`，Lead 实现）

`createEmergence({ memory, knowledge, members, settings, logger })`：
`recallForTurn({ text, scope, groupId, senderId, senderName, budget? })` →
`{ text, counts:{memory,knowledge,members}, items:[{kind,id,title,score}] }`。
文本格式示例（空则不注入）：
`【本次相关的背景】` + `- 群友：...` / `- 知识：...` / `- 记忆：...`，受 settings 的字数/条数上限约束。

## 3. 运行时与工具路由（Lead 实现）

- `lib/bots/registry.js`：bots.json 读写/迁移/CRUD（原子写、损坏备份、id 分配）。
- `lib/bots/paths.js`：目录解析 + 越界提示。
- `lib/bots/runtime.js`：`createBotRuntime({ctx, record, config, registry, logger})` 组装一个机器人的
  settings/persona/memory/knowledge/members/stickers/collector/promptComposer/gateState/stats/catalog/
  manager/gateway/binding；暴露与现有 `runtime` 同形的字段 + `snapshot()`。
- `lib/bots/host.js`：`createBotHost(...)` 管理 N 个 runtime、工具只注册一次、legacy runtime 视图。
- `lib/bots/agent-map.js`：`Map<Agent, botRuntime>`（WeakMap 语义），SessionManager 建 agent 时登记；
  工具用 `resolveBot(exec)` 取当前机器人，拿不到时退回默认机器人（保持旧测试可用）。
- 工具改造保持**旧签名可用**（测试兼容）：
  `registerMemoryTools(ctx, memoryStoreOrOptions, logger?)`、`registerSendFileTool({...})`、
  `registerVisionTool(...)`、`registerStickerTools(...)` 允许额外传 `resolveBot`；
  工具名不变，不按机器人加前缀。

## 4. HTTP API（均在 `/qqbot-buddy/api` 下，JSON，`{ok,...}` / `{ok:false,error}`）

所有旧接口都接受 `?botId=<id>`（GET）或 body 里的 `botId`（POST），缺省 = activeBotId。
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/bots` | `{ok,bots:[{id,name,appId,ready,enabled,legacy,workspaceDir,dirs:{...},stats}],activeBotId}` |
| POST | `/bots/create` | `{name,appId?,appSecret?,workspaceDir?}` → 建机器人（随后绑定/启动） |
| POST | `/bots/update` | `{botId,name?,enabled?,workspaceDir?,appId?,appSecret?}` |
| POST | `/bots/delete` | `{botId}`（至少保留一个；停网关、释放会话；不删文件） |
| POST | `/bots/activate` | `{botId}` → `{activeBotId}` |
| GET | `/knowledge` | `?q=&scope=&groupId=&tag=&limit=&offset=` → `{ok,total,items,tags}` |
| GET | `/knowledge/entry` | `?id=` → `{ok,entry}` |
| POST | `/knowledge/save` | `{botId,id?,title,body,tags,scope,groupId,importance}` |
| POST | `/knowledge/delete` | `{botId,id}` |
| GET | `/members` | `?q=&groupId=` → `{ok,total,items,groups:[{id,count}]}` |
| POST | `/members/save` | `{botId,id,name,tags,notes,importance}` |
| POST | `/members/delete` | `{botId,id}` |
| GET | `/recall/preview` | `?text=&scope=&groupId=&senderId=` → `{ok,block,counts,items}` |
| GET | `/state` | 现有结构 + `bot:{id,name,workspaceDir,dirs}`（当前机器人） |
| GET/POST | `/bind/state|refresh|manual|unbind` | 增加 `botId`；绑定结果写该机器人凭据文件 |

## 5. UI（client/client.js 唯一写者）

- 顶部：机器人在线状态徽标右侧加**机器人选择器**（下拉：名称 + 连接状态点；“管理机器人…”跳转）；
  所有 API 请求统一带当前 botId；切换后重载 snapshot/schema。
- 新增工作区 **机器人**（group 位置：概览之后、对话之前）：
  - 页 `bots`（widget: bots）——机器人列表卡片（名称/AppID/连接状态/工作区路径/启用开关/绑定与解绑/删除），
    新建表单（名称、AppID、Secret、工作区路径），扫码绑定复用现有 ConnectCard 逻辑（带 botId）。
  - 页 `workspace`（widget: botWorkspace）——当前机器人的工作区根与 7 个子路径（persona/memory/knowledge/members/stickers/state/media），
    可编辑；“恢复默认”；非工作区内路径显示黄色提示条；显示“插件会在这里产生哪些文件”。
- **内容** 工作区新增两页：`knowledge`（知识库：搜索/标签/作用域筛选、条目列表、编辑抽屉或内联编辑、新建/删除、
  显示重要度与更新时间）、`members`（群友库：群筛选、搜索、成员列表（昵称/openid 短码/标签/最近活跃/发言数）、
  成员详情编辑（备注、标签、重要度）、删除）。
- **长期记忆** 页追加“相关性召回”区块：开关、每轮条数、字数上限、时间衰减半衰期、重要度权重、立即预览 `/recall/preview`。
- 风格：沿用 `qqb-` 类名、Card/Field/Button/Badge/EmptyBlock 等现有组件，不引入新依赖、不改现有页面布局；
  页面数量克制，已有 tab id 全部保持兼容。

## 6. 文件所有权（并行写作用域）

| 任务 | 写作用域 | 不碰 |
|---|---|---|
| Lead | `lib/index.js` `lib/bots/**` `lib/config-schema.js` `lib/settings-store.js` `lib/settings-schema.js` `lib/prompt.js` `lib/prompt-sections.js` `lib/context/**` `lib/qq/session-manager.js` `lib/qq/gateway.js` `lib/qq/inbound.js` `lib/tools/catalog.js` `lib/tools/send-file.js` `lib/tools/vision.js` `lib/tools/sticker-tools.js` `lib/web/**` `lib/binding/**` `docs/**` | memory/entries/knowledge/members 内部、client.js |
| memory | `lib/memory/**` `test/memory-*.test.js` `test/collector.test.js` | 其他 |
| knowledge | `lib/entries/**` `lib/knowledge/**` `lib/members/**` `lib/tools/knowledge-tools.js` `lib/tools/member-tools.js` 对应新测试 | 其他 |
| ui | `client/client.js` | 其他 |
| verify | 只读 + `.dsh-dev/` 与 `test/e2e/` 脚本产物 | 插件源码（发现问题报告 Lead） |

## 7. 验收

1. `node --test test/*.test.js` 全绿（现有 371 条 + 新增）。
2. 新模块单测覆盖：条目库 CRUD/检索/损坏恢复、记忆 recall、成员 visit/recall、工具路由。
3. dsh-dev：`bin/dsh-dev sync && bin/dsh-dev restart && bin/dsh-dev smoke` 通过；
   浏览器打开 `bin/dsh-dev url`，截图验证：机器人列表/工作区/知识库/群友库/记忆召回 5 个页面渲染正常、
   无 console error、旧页面（概览/对话/模型/人设/表情/命令）不回归。
4. 单机器人 legacy 迁移：把旧 workspace 复制到临时目录启动，数据（memory/persona/stickers/settings）路径不变、内容可读。
5. 不触碰 live：`/home/qiqi/.dsh` 与 3080 实例哈希不变（`bin/verify-isolation`）。

## 9. v0.17 追加契约（实现后回填）

- 条目新增 `status: approved|pending`；pending 不参与 `search/recall`，`list({status})` 可筛；旧数据缺字段按 approved。
- `knowledge.autoExtract` 由 boolean 升级为对象 `{enabled, everyRounds, maxEntries, minConfidence, provider, model}`（boolean true 兼容为 enabled）。
- 自动提炼写入 `source='auto'`，高置信 approved、低置信 pending；同标题同作用域合并。
- 插件工具改为 agent-scope 注册（`lib/bots/scoped-tools.js`），全局 tools 注册表不再出现插件工具；只有 QQ 会话 agent 可见。
- API：`POST /knowledge/extract`、`GET /knowledge/extract/stats`、`POST /knowledge/approve`。
