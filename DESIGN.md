# dsh-qqbot-buddy — 设计契约（唯一事实源，改动需 Lead 同意）

QQ 机器人插件（DSH / Cordis），替代官方 `@tencent-connect/dsh-qqbot`，在官方插件与
现有 chatonly 方案基础上补齐四项能力：

1. **回复频率**：群聊不再每条都回；按“累计 N 条”“时间间隔”“概率”三种策略择机回复；
   @机器人、回复机器人消息、命中关键词永远回复（每项可开关）。
2. **Self-improve**：机器人自主把重要信息写进工作区指定文件夹（默认 `<cwd>/memory`），
   下一轮自动读回（注入 system prompt），并可用工具检索/读取/写入。
3. **人设**：设置页可直接编辑人设文件（默认 `<cwd>/persona.md`），支持“替换/追加”模式、备份回滚。
4. **设置入口**：以上全部在 DSH 设置（Settings）里有显式 UI（一个「QQ 机器人」栏目 + 页内分页）。

## 环境事实

- DSH 版本：`@deepseek-ai/dsh 0.2.1-rc.2`（checkout 在 `<dsh-install-dir>/`）
- 运行 profile：`web`（`~/.dsh/profiles/web`），当前 dsh web 进程监听 `127.0.0.1:3080`
- 工作区（bot cwd）：`~/my-bot`（persona.md、stickers/ 已存在）
- 官方插件编译产物（**主要参考源码**，MIT）：
  `~/.dsh/profiles/web/node_modules/@tencent-connect/dsh-qqbot/dist/`
  （阅读入口：`index.js`、`gateway/bootstrap.js`、`session/session-manager.js`、
  `transport/inbound.js`、`transport/outbound.js`、`media/*.js`）
- QQ SDK 源码（含 TS 源码，协议/中间件权威实现）：
  `~/.dsh/profiles/web/node_modules/@tencent-connect/qqbot-nodejs/src/`
- 现有 chatonly 辅助插件参考：`~/.dsh/profiles/web/node_modules/chatonly-*`
- 现有 profile 配置：`~/.dsh/profiles/web/cordis.patch.yml`（im-qqbot 段、chatonly preset）
- 依赖解析：插件若放在 `<profile>/node_modules/dsh-qqbot-buddy`，
  则 `@deepseek-ai/*` 会从 `~/.dsh/profiles/node_modules` 解析，
  `@tencent-connect/*` 从 `profiles/web/node_modules` 解析。**无需打包构建**。
- 源仓库（开发目录）：`<repo>`；部署时用
  `scripts/install-local.sh` 复制到 profile 的 node_modules。
- 默认状态目录：`~/.dsh-qqbot/buddy`（settings.json、persona 备份、sessions.json、日志）；
  媒体目录沿用 `~/.dsh-qqbot/media`（与现有 persona 里的图片路径兼容）。

## 技术约束

- 纯 ESM JavaScript（`"type":"module"`），**不引入构建步骤**（不用 TS/tsdown）。
  client 端手写 `window.__ModuleLoader__.load({id, factory})` 格式的 bundle（参考官方
  `lib/client.js`，只 require `react`，用 `react.createElement`，不用 JSX）。
- 仅使用 Node 内置模块 + 以下已安装依赖：
  `@tencent-connect/qqbot-nodejs`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-session`、
  `@deepseek-ai/schemastery`、`@deepseek-ai/cordis`（type only）。
- 不新增 npm 依赖；不联网拉包。
- 所有磁盘写入用「临时文件 + rename」原子写；文件权限 0o600（settings、备份）。
- HTTP 路由只挂本地 webServer（同源，无额外鉴权，与 chatonly-* 一致）；
  所有 POST body < 1MB；路径参数必须做 root 越界检查。
- 错误必须被捕获并写日志，不允许未处理的 rejection 打挂宿主。
- 中文 UI；代码注释可用中文。

## 目录与归属（写作用域，禁止跨域修改）

```
dsh-qqbot-buddy/
├── DESIGN.md                    # Lead
├── README.md                    # Lead
├── package.json                 # Lead
├── cordis.patch.yml             # Lead（bundle patch 模板）
├── lib/
│   ├── index.js                 # server-dev：插件入口 + 装配
│   ├── config-schema.js         # Lead：schemastery Config
│   ├── logger.js                # Lead：logger 适配
│   ├── settings-store.js        # Lead：settings 读写/校验/订阅
│   ├── persona-store.js         # Lead：人设读写/备份
│   ├── prompt.js                # Lead：system prompt 组合
│   ├── qq/
│   │   ├── gateway.js           # server-dev：QQBot 创建/中间件/生命周期
│   │   ├── middleware.js        # server-dev：管线装配（含 quote/mention/frequency）
│   │   ├── gate.js              # server-dev：纯函数决策（频率策略，可单测）
│   │   ├── session-manager.js   # server-dev：peer→agent 会话管理
│   │   ├── inbound.js           # server-dev：消息组装 + followup
│   │   ├── outbound.js          # server-dev：session/event → QQ 发送
│   │   ├── commands.js          # server-dev：/new /stop /status /help /ping
│   │   ├── attachment.js        # server-dev：媒体下载中间件
│   │   └── media-cleaner.js     # server-dev：媒体 TTL 清理
│   ├── tools/
│   │   ├── send-file.js         # server-dev：qqbot_send_file
│   │   ├── vision.js            # server-dev：qqbot_describe_image
│   │   └── memory-tools.js      # memory-dev：memory_save/search/read/list
│   ├── memory/
│   │   ├── store.js             # memory-dev：记忆文件/索引/检索
│   │   └── collector.js         # memory-dev：自动收集（LLM 提炼）
│   └── web/
│       └── routes.js            # ui-dev：/qqbot-buddy/api/* 管理路由
├── client/
│   └── client.js                # ui-dev：settings.section 手写 bundle
├── preset/
│   └── guard.js                 # Lead：preset 内全局工具白名单（兜底）
├── scripts/
│   ├── install-local.sh         # QA：复制到 profile node_modules
│   ├── deploy-live.sh           # QA：备份 + 改写 profile cordis.patch.yml
│   ├── rollback.sh              # QA：回滚
│   └── test-profile.sh          # QA：隔离 DSH_HOME 启动测试实例
└── test/                        # QA + 各 owner 可加单测（文件名归属见任务）
```

## 模块 API 契约

### settings-store.js（Lead 实现，只读引用）

```js
export function resolveDefaults({ cwd }); // 由插件入口按 cwd 生成默认值（见下）
export function createSettingsStore({ file, defaults, logger }) => {
  get(): Settings,                         // 深拷贝快照（不可变使用）
  patch(partial): Promise<{ settings, changed: string[] }>, // 深合并+逐字段校验+原子落盘+通知订阅
  replace(next): Promise<{ settings, changed: string[] }>,
  subscribe(fn: (settings) => void): () => void,
  readonly file: string,
  readonly defaults: Settings,
}
```

Settings JSON（`version: 1`）：

```jsonc
{
  "version": 1,
  "reply": {
    "enabled": true,                 // 总开关（false = 永不自动回复，命令仍响应）
    "groupEnabled": true,
    "groupMode": "count",            // "all" | "count" | "interval" | "probability"
    "countThreshold": 3,             // count：累计 N 条群消息后回复（1..200）
    "flushAfterSeconds": 120,        // count：pending>0 且最早一条等待超过 N 秒也回复（0=关闭，0..86400）
    "intervalSeconds": 90,           // interval：距离上次回复至少间隔 N 秒（5..86400）
    "probability": 0.25,             // probability：每条消息回复概率（0..1）
    "minGapSeconds": 0,              // 非强制触发之间的全局最小间隔（0..3600）
    "c2cEnabled": true,              // 私聊是否回复
  },
  "triggers": {
    "onMention": true,               // @机器人 必回
    "onReplyToBot": true,            // 引用/回复机器人消息 必回
    "keywords": [],                  // 子串命中必回（最多 50 个，每个 <= 40 字）
  },
  "persona": {
    "path": "<cwd>/persona.md",      // 人设文件绝对路径
    "mode": "replace",               // "replace"：人设完全替代系统提示（chatonly 风格）
                                     // "append"：在宿主系统提示后追加
    "suppressRuntimeContext": true,  // 关闭动态运行上下文快照
    "groupExtraPrompt": "回复群聊中某个人消息时，需要做一次@的操作，好让人知道你在回复她",
    "directExtraPrompt": ""
  },
  "memory": {
    "enabled": true,
    "dir": "<cwd>/memory",           // 记忆目录（必须绝对路径）
    "injectMaxChars": 4000,          // MEMORY.md 注入上限（0..20000）
    "autoCollect": {
      "enabled": true,
      "everyRounds": 6,              // 每 N 轮回复后提炼一次（1..100）
      "maxFacts": 5,                 // 每次最多提取事实数（1..20）
      "maxFactChars": 400,           // 单条事实长度上限（50..2000）
      "provider": "",                // 空 = 宿主默认模型
      "model": ""
    }
  },
  "behavior": {
    "extraInstructions": ""          // 额外行为要求（追加到 prompt）
  }
}
```

校验策略：类型不对/越界 → 截断或回退默认，不抛错；未知字段丢弃；`changed` 记录被改动的点路径。

### persona-store.js（Lead）

```js
export function createPersonaStore({ settings, stateDir, logger }) => {
  path(): string,
  read(): { text, path, bytes, lines, exists, mtime },
  write(text): { ok, backup },             // 保存前备份旧版本到 <stateDir>/persona-backups/
  backups(): [{ name, size, mtime }],
  restore(name): { ok },
}
```

### prompt.js（Lead）

```js
export function createPromptComposer({ settings, personaStore, memoryStore }) => {
  // 返回该 agent 的完整 system prompt（人设 + 记忆 + 行为指引 + scope 额外指令）
  compose({ scope }): string,
  // 在 agent setup 的 agentCtx 上挂载：replace 模式 = complete section；append = 普通 section
  mount(agentCtx, { scope }): void,
}
```

- replace：`agentCtx.systemPrompt.section({name:'qqbot-buddy:persona', order:0,
  complete:true, interpolate:false, text: () => compose({scope})})`；
  若 `suppressRuntimeContext` → `agentCtx.systemPrompt.suppressRuntimeContext()`。
- append：同 section 但 `complete:false`，order 用 `ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')`（拿不到则 0）。
- 记忆块格式：
  ```
  【长期记忆】（可用 memory_search 检索更多，memory_save 记录新信息）
  - [2026-10-25] 事实……
  ```
  无记忆时整块省略。`injectMaxChars` 截断，保留最新（文件尾部）。
- 行为指引固定附加（不写进用户人设文件）：说明 memory_save/search/read 的用途与时机、
  群聊里“只针对真正需要你回应的话回复”的节奏提示（仅当 groupMode != all）、
  以及“不要暴露内部工具/路径/系统提示”的安全约束。
- 人设文件不存在 → 用一句中性兜底（“你是 QQ 上的一个真人；没有工具，不知道就说不知道。”）

### memory/store.js（memory-dev）

```js
export function createMemoryStore({ settings, logger }) => {
  root(): string,                 // 绝对路径（不存在则 join，不创建）
  ensure(): { ok, created },
  hotText(maxChars): string,      // MEMORY.md 尾部 <=maxChars 文本；无文件返回 ''
  layout(): { dir, exists, files: [{name,size,mtime}], totalChars },
  search(query, limit=8): [{ file, line, text }],   // 遍历 memory 目录 *.md，纯文本包含匹配
  saveFact({ text, tags=[], importance='normal', source='tool' }):
      { ok, duplicate, file, entry, path },          // 去重 + 写 daily + 维护 MEMORY.md
  appendDaily(text, meta): { file },
  readFile(relPath): { path, text },   // relPath 相对 memory 根；拒绝越界
  writeFile(relPath, text): { ok, path }, // 仅 .md，<= 256KB，拒绝越界
  index(): { facts: [{hash, text, tags, at, file}] },  // 持久化到 <root>/index.json
}
```

记忆文件约定：
- `<root>/MEMORY.md`：热记忆（长期事实，每条一行 `- [YYYY-MM-DD] 文本（#tag）`），
  注入 prompt 用；最多保留 800 条（超出从旧到新裁剪，裁剪时保留 index）。
- `<root>/notes/YYYY-MM-DD.md`：当日全量记录（含来源），供 search/read。
- `<root>/index.json`：去重索引 `{version:1, facts:[{hash,text,tags,at,file}]}`，
  hash = sha256(normalize(text)).slice(0,16)。相同事实重复保存 → `duplicate:true`，不重复写。

工具（`lib/tools/memory-tools.js`）：
- `memory_save`：参数 `content`(必填 string), `tags`(可选 string[]), `importance`(可选 normal|high)。
- `memory_search`：`query`(必填), `limit`(可选 1..20)。
- `memory_read`：`path`(可选，默认 MEMORY.md)。
- `memory_list`：无参数。
统一用 `ctx.get('tools').register({name, description, parameters, output, execute})` 注册（参考
官方 `dist/media/send-file-tool.js`）；execute 返回普通对象；工具注册失败要告警不崩溃。

### memory/collector.js（memory-dev）

```js
export function createCollector({ ctx, settings, memoryStore, logger, getRoute, onStats }) => {
  noteTurnEnd(record): void,   // 每轮回复后调用；根据 everyRounds 决定是否触发后台提炼
  collectNow(record): Promise<{ ok, added: [{text,tags}], scannedMessages }>, // UI 手动触发
  stats(): { enabled, roundsSinceCollect, lastCollectAt, lastResult, lastError, totalCollected },
}
```

- 取 record.session.events 里最近 `2*everyRounds` 条 user/assistant 消息文本，截断到 12000 字符。
- 用 `ctx.get('llm').stream({provider, model, messages, maxTokens})` + `BlockAssembler`
  （`@deepseek-ai/dsh-llm`）调用；provider/model 为空时用 `ctx.get('agentDefaultModel').currentSelection()`。
- Prompt 要求输出严格 JSON：`{"facts":[{"text":"...","tags":["..."],"importance":"normal|high"}]}`；
  解析失败（含 markdown 代码块包裹）要容错；单条长度限制；最多 maxFacts 条。
- 提炼 prompt 重点：用户偏好/身份信息/长期约定/重要事件/需要记住的结论；忽略寒暄与一次性闲聊。
- 并发锁：同一时刻只跑一个提炼；失败只记日志，不影响回复链路。
- 可用 `ctx.effect` 注册清理定时器（如有）。

### qq/gate.js（server-dev，纯函数，必须可单测）

```js
export function createGateState(); // { peers: Map }
export function decide({ settings, peerKey, scope, wasMentioned, isReplyToBot,
  content, isCommand, now, lastReplyAt, state }) =>
  { trigger: boolean, reason: 'command'|'mention'|'reply'|'keyword'|'c2c'|
    'mode'|'flush'|'cooldown'|'disabled'|'empty', forced: boolean, resetPending: boolean };
export function recordTrigger(state, peerKey, now, reason): void;
export function recordSkip(state, peerKey, now): void;
export function pendingSnapshot(state): [...];
```
规则见上文 settings 说明。`reason==='cooldown'` 表示轮到但被 minGap 拦下（stats 记 skip）。

### qq/gateway.js（server-dev）

- 依据 config 创建 `new QQBot({appId, appSecret, transport:'websocket', baseUrl, tokenBaseUrl, userAgent, logger})`。
- 装配中间件（顺序）：
  1 `errorHandler()`；2 `messageFilter({skipSelfEcho:false})`；3 `accessPolicy`（默认 open）；
  4 `historyBuffer({limit: settings 20, recordOnSkip:true, groupKey})`；
  5 `quoteRef({maxSize:500, preferMsgElements:true})`；
  6 `mentionGate({requireMentionInGroup:false, passthrough:true, isImplicitMention: replyProbe})`；
  7 `contentSanitizer({parseFaceTags:true})`；8 `rateLimiter()`；
  9 `slashCommand({autoHelp:false, commands})`；10 命令处理中间件（见 commands.js）；
  11 **frequencyGate**（自定义）：调 `decide()`；不触发则 `ctx.stop('frequency:<reason>')`
     （消息已被 historyBuffer 记录，无需其它处理）；触发则记 stats 并 `next()`；
  12 `concurrencyGuard({strategy:'merge', maxQueue:20, maxProcessingMs: processingTimeoutMs})`；
  13 `typingIndicator()`；14 `attachmentProcessor`（仅对触发的消息下载媒体）；
  15 自研 envelope 组装标记（可省，inbound 自己组装）。
- `bot.on('message', ...)` → `handleInbound`；`bot.on('interaction')` 只 ack；`bot.on('error')` 记录；
  `bot.on('ready')` / `bot.on('resumed')` 更新状态（op7/op9 重连后 SDK 只发 resumed，不监听会让
  ready 永久停在 false）；`disconnected` 记录：`willReconnect=true` 属协议内的正常重连
  （op7 / code 1000 NORMAL，SDK 自动 RESUME 并补发消息），只记 info 且不写 lastError；
  `willReconnect=false` 才是真断连，记 error + lastError（SDK 旧版不支持这两个事件时忽略）。
- 生命周期用 `ctx.effect`：`bot.start().catch(log)`，dispose 时 `manager.disposeAll(); bot.stop()`。
- 凭据缺失：不启动 bot，只 log warn + 注册 web 路由（UI 可见状态）。
- 统计对象（供 UI）：`{received, triggered, skipped, replies, lastReplyAt, lastTriggerReason}`；
  bot 状态：`{appId, ready, startedAt, lastError, sessionCount, pending}`。

### qq/session-manager.js（server-dev）

- sessionKey = `qqbot-buddy:${appId}:${scope}:${peerId}`；sessionId 先查
  `<stateDir>/sessions.json` 映射，否则 sha256 派生（参考官方 SessionManager.deriveSessionId）。
- `getOrCreate(scope, peerId, senderId, replyTarget)`：内存复用 → `agents.resume` → `agents.create`；
  create/resume 都传 `setup: async (agentCtx) => { await presets.mount(agentCtx, presetId); composer.mount(agentCtx, {scope}); restrictGlobalTools(agentCtx); }`
  meta: `{cwd: config.cwd, agentPreset: presetId}`；agentOptions 可带 config.provider/model。
- 记录 `{sessionKey, sessionId, agent, handle, replyTarget, scope, peerId, senderId, lastActivity}`。
- 闲置回收（默认 30 分钟，`setInterval`）；`disposeAll()`。
- `reset(scope, peerId)`：dispose + 删除记录 + 写入新随机 sessionId 到 sessions.json。
- `findByAgent(agent)`、`findBySessionId(id)`、`latestReplyTargetForAgent(agent)`。
- 若 preset 解析/mount 失败：warn 后继续（仍注册 prompt），不阻断。

### qq/inbound.js（server-dev）

- 输入 `MiddlewareContext`；组装 agentBody（参考官方 inbound.js）：
  1 媒体元数据行（图片：`[图片]\nImage: <本地绝对路径>`；下载失败用 URL；视频/文件同类）；
  2 引用块 `[Quoted message begins]…[Quoted message ends]\n[Current message]`；
  3 群聊发送者标签 `[昵称 (openid)] 内容 (@you)`；私聊不加标签；
  4 群聊历史块（`[Chat history begins]…[Chat history ends]`，来自 `ctx.state.history`，
     limit = settings 20，仅群聊且触发时包含）；
  5 频率触发提示：由 frequencyGate 在 state 标记 `triggerReason`，若 reason 为 mode/flush
     （非强制）则加一行系统提示：`[群聊节奏采样] 这是最近群聊中的一批消息，请挑选真正需要你回应的话题回复；不必逐条回答。`
- `createUserMessage({content:[{type:'text',text}], source:{kind:'user'}})` → `record.agent.followup(message)`。
- 同一 peer 串行：`await record.agent.whenIdle()`（catch 后 warn）。
- 触发的群消息回复后清空该群 history（避免下次重复堆上下文）。

### qq/outbound.js（server-dev）

- `ctx.on('session/event', handler)`：`assistant/message` 取文本块 → `splitSegments`（`[[msg]]`，兼容）→ `splitBlankLineSegments`（空行自动拆条兜底）
  → 每条 `chunkMarkdown`（按 `textChunkLimit` 4500，感知代码块）→ `bot.sendMarkdown(record.replyTarget, chunk)`。
- `turn/end`：若 reason 为失败 → 发一条 `⚠️ 本轮异常结束`（静默码 STREAM_CLOSED 除外）；
  调 `collector.noteTurnEnd(record)`；更新 stats.replies。
- 发送失败记日志；`sendMarkdown` 用 record.replyTarget（带 msgId 被动回复）；
  失败时尝试无 msgId 发送一次（active push），仍失败则放弃。
- 支持 `[[msg]]` 分条与 markdown 长文切分（可参考官方 `transport/chunker.js`、`outbound.js`）。

### qq/commands.js（server-dev）

命令消息（`/` 开头，命中下列之一）在频率门控之前直接处理并 stop：
`/new` `/reset` `/clear`(新会话，旧 id 压入 per-peer 可恢复栈，sessions.json v2 的 previous)、
`/resume`(弹出并恢复上一个会话)、`/stop`、`/status`(含可恢复数量)、`/help`、`/ping`。
恢复栈每个 peer 最多 10 个、持久化在 sessions.json，重启后仍可 /resume。
未知 `/xxx` 当普通消息走频率策略。

### web/routes.js（ui-dev）

```js
export function registerWebRoutes(ctx, runtime): () => void
```
- 用 `ctx.get('webServer').register({kind:'exact', path, handler})`；返回聚合 dispose。
- runtime 提供：`{ ctx, config, logger, settings, persona, memory, collector, manager, gateState,
  botState(), stats, promptComposer, getVersion() }`（Lead 在 index.js 装配后传入）。
- 路由与响应 **必须** 与本文件「HTTP API」一节一致。路由挂在 `/qqbot-buddy` 前缀下；
  所有 JSON 响应 `{ok:true,...}` / `{ok:false,error}`，`cache-control:no-store`。
- 不做鉴权但只接受本机请求（沿用 webServer）；拒绝 path 越界。

## HTTP API（ui-dev 实现，client 使用）

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/qqbot-buddy/api/state` | - | 见下 |
| GET | `/qqbot-buddy/api/persona` | - | `{ok,path,text,bytes,lines,mtime,exists,backups:[{name,size,mtime}]}` |
| POST | `/qqbot-buddy/api/persona` | `{text}` | `{ok,backup}` |
| POST | `/qqbot-buddy/api/persona/restore` | `{name}` | `{ok}` |
| POST | `/qqbot-buddy/api/settings` | `{patch}` | `{ok,settings,changed}` |
| GET | `/qqbot-buddy/api/memory` | - | `{ok,dir,exists,files:[{name,size,mtime}],totalChars}` |
| GET | `/qqbot-buddy/api/memory/file?path=MEMORY.md` | - | `{ok,path,text}` |
| POST | `/qqbot-buddy/api/memory/file` | `{path,text}` | `{ok,path}` |
| POST | `/qqbot-buddy/api/memory/append` | `{text,tags?}` | `{ok,duplicate,entry}` |
| POST | `/qqbot-buddy/api/memory/collect` | `{}` | `{ok,added,scannedMessages,stats}` |
| GET | `/qqbot-buddy/api/prompt?scope=group` | - | `{ok,text}`（当前设置下组合出的 system prompt 预览） |
| POST | `/qqbot-buddy/api/action` | `{action:"clear-pending"\|"reconnect"\|"reset-settings"}` | `{ok,message}` |

`GET /api/state` 响应：
```jsonc
{
  "ok": true, "version": "0.1.0", "now": 1761300000000,
  "bot": {"appId":"1904***298","ready":true,"startedAt":0,"uptimeMs":0,
          "lastError":"","sessionCount":0,"pending":[]},
  "stats": {"received":0,"triggered":0,"skipped":0,"replies":0,
            "lastReplyAt":0,"lastTriggerReason":""},
  "settings": { /* 完整 Settings */ },
  "paths": {"cwd":"...","persona":"...","memory":"...","stickers":"...","stateDir":"...","mediaDir":"..."},
  "persona": {"path":"...","exists":true,"bytes":0,"lines":0,"mtime":0},
  "memory": {"dir":"...","exists":true,"files":[],"totalChars":0},
  "effective": {"summary":"每累计 3 条群消息回复一次；@/回复/关键词必回", "pending": []}
}
```

## 设置 UI（client/client.js，ui-dev）

- 手写 bundle 格式：
  ```js
  window.__ModuleLoader__.load({
    id: "dsh-qqbot-buddy",
    factory: (require) => {
      var module = { exports: {} }; var exports = module.exports;
      const react = require("react");
      // ...组件（react.createElement）...
      const inject = ["slots"];
      function apply(ctx) {
        const slots = ctx.slots;
        ctx.effect(() => slots.inject("settings.section", () =>
          slots.register({ name:"settings.section", id:"qqbot-buddy", order: 40,
                           label: "QQ 机器人" }, Section)), "qqbot-buddy.settings");
      }
      exports.apply = apply; exports.inject = inject;
      return module.exports;
    }
  });
  ```
- Section 组件：顶部标题 + 状态；内部 tab 按钮（自管 state）：`概览 / 回复频率 / 触发规则 / 人设 / 自我改进`。
- 用 `fetch` 调同源 API；加载态/错误/保存中/已保存提示齐全；显式「保存」按钮 + dirty 提示
  （人设、memory 文件编辑同样是显式保存）；频率/触发开关可即时保存（POST /api/settings）。
- 样式：注入一次 `<style>`（id `qqbot-buddy-settings-style`），类名前缀 `qqb-`，
  使用 DSH 主题变量（`var(--dsw-alias-*)`）并给兜底色；响应式；适配深浅色。
- 不引入任何额外依赖，只用 `react.createElement`。
- 文案中文；关键控件带说明（例如“@必回”“回复机器人消息必回”“每 N 条回复一次”）。

## 数据流

```
QQ WS → SDK middleware 管线（history/quote/mention/frequency gate）→ 触发
    → inbound 组装 agentBody → SessionManager.getOrCreate → agent.followup
    → DSH agent loop（system prompt = 人设+记忆+行为指引，工具=fs/web/memory/qqbot）
    → session/event（assistant/message, turn/end）→ outbound 切分发送 QQ
    → turn/end → collector.noteTurnEnd（必要时后台 LLM 提炼 → memory 文件）
    → 下一轮 prompt 的 memory 段自动读回（实时，无需重启）
```

## 质量与验收（QA 必须覆盖）

1. `node --test test/*.test.js` 全绿；gate 决策矩阵覆盖所有 mode × forced × cooldown × flush。
2. settings-store：深合并、越界截断、未知字段丢弃、原子落盘、订阅触发、坏 JSON 回退默认。
3. memory：save 去重、日文件、MEMORY.md 裁剪、search、越界拒绝、注入上限。
4. persona：保存备份/恢复/不存在兜底。
5. prompt：replace/append、记忆块、额外指令、scope 差异。
6. 插件加载：隔离 DSH_HOME 下 `dsh --profile <test> --dump-config` 包含插件与 preset；
   启动 web 服务后 `curl /qqbot-buddy/api/state` 返回 ok；设置页可见且各 tab 可用（浏览器截图）。
7. 不回归：测试实例内不得连接真实 QQ（禁用 im-qqbot / 不配置真实凭据），不写 live profile。

## 团队协作

- 每个 owner 只改自己写作用域内的文件；跨域需要 Lead 协调。
- 共享接口以本文件为准；需要改契约先改 DESIGN.md 并通知 Lead。
- 提交前自测：`node --check` 所有 js；新增模块至少一个单测。
- 禁止重启/杀掉现有 dsh web 进程（端口 3080）；禁止修改 live profile，除非 Lead 明确安排部署任务。

---

# 追加需求（2026-10-25 晚）：模型切换 + 扫码绑定

## settings.model（运行期设置，热生效）

```jsonc
"model": {
  "provider": "",          // 空 = 跟随宿主默认
  "model": "",             // 空 = 跟随宿主默认
  "reasoningEffort": ""    // 空 = 跟随模型/宿主默认；否则 low|medium|high|max 等适配器值
}
```

agent 创建/恢复时的路由优先级（session-manager.agentOptions）：
1. settings.model（provider+model 都非空）
2. 插件 config.provider + config.model
3. 宿主 ctx.get('agentDefaultModel').currentSelection()
4. 都没有 → 日志告警（agent turn 会报 no provider/model）

「应用」语义：改设置只影响**新会话**；POST /api/action {action:'apply-model'} 调
runtime.resetAllSessions() 释放内存中的 bot 会话（保留 sessions.json 映射），下一条消息
以新模型 resume/create。

## 新文件与归属

| 文件 | Owner |
|---|---|
| lib/binding/persist.js、qr.js、service.js | binding-dev |
| lib/web/bind-routes.js | binding-dev |
| lib/web/routes.js 扩展 /api/models、/api/action apply-model | ui-dev |
| lib/qq/session-manager.js、gateway.js、lib/index.js | server-dev |
| client/client.js | ui-dev |
| test/**、scripts/** | qa-dev |

## 绑定服务契约

```js
createBindingService({ logger, profileDir, getCredentials, onBound, onUnbind, source }) => {
  start(): void,                                  // 幂等；无凭据时自动开跑
  refresh(): void,                                // 刷新二维码
  manual(appId, appSecret): Promise<{ok,error?}>, // 手动填写凭据
  unbind(): Promise<{ok,error?}>,                 // 解绑（清 patch 凭据 + onUnbind）
  wireState(): { phase: 'idle'|'bound'|'waiting'|'starting'|'saving'|'failed',
                 appId?, url?, qrSvg?, reason?, issuedAt? },  // idle = 绑定流程未启动
  isBound(): boolean,
  dispose(): void,
}
```

- 用 `@tencent-connect/qqbot-connector` 的 `startQrConnect(callbacks, options)`；`onQrDisplayed(url)`
  后用 `qrcode` 渲染 `data:image/svg+xml;base64,...`（失败降级只返回 url）。
- 扫码成功/手动提交：先更新 profile `cordis.patch.yml` 里 id=qqbot-buddy 的 config
  appId/appSecret（**必须兼容两种形态**：顶层 `- id: qqbot-buddy` 或 `- insert: [{id: qqbot-buddy}]`；
  保留其它 config 键；原子写 + 0600）→ 成功后调用 `onBound({appId,appSecret})`。
- unbind：从 patch 删除 appId/appSecret（保留其它键）→ `onUnbind()`。
- 路由（同源 trusted 校验、JSON、no-store、body < 8KB）：
  - `GET  /qqbot-buddy/api/bind/state`
  - `POST /qqbot-buddy/api/bind/refresh`
  - `POST /qqbot-buddy/api/bind/manual`  `{appId,appSecret}`
  - `POST /qqbot-buddy/api/bind/unbind`
- index.js：缺少凭据（且 config.bindOnMissingCredentials !== false）时自动 `binding.start()`；
  config 增加 `profileDir` 覆盖（空=自动探测；测试隔离时指向临时 profile 副本，避免写 live）。
  runtime 增加 `profileDir`、`binding`、`applyCredentials({appId,appSecret})`、
  `resetAllSessions()`、`getModelInfo()`。

## gateway 凭据热切换

新增 `applyCredentials({appId,appSecret})`：更新运行时凭据 → 停旧 bot → 以新凭据 bootstrap，
不丢内存会话；供扫码/手动绑定与解绑后使用。

## HTTP API 追加

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/qqbot-buddy/api/models` | - | `{ok, providers:[{id,models:[{id,name}]}], default:{provider,model,reasoningEffort}, selected:settings.model, source:'settings'\|'config'\|'host'}` |
| POST | `/qqbot-buddy/api/action` | `{action:"apply-model"}` | `{ok,message}` |
| GET | `/qqbot-buddy/api/bind/state` | - | `{ok, phase, appId?, url?, qrSvg?, reason?, issuedAt?}` |
| POST | `/qqbot-buddy/api/bind/refresh` | - | `{ok}` |
| POST | `/qqbot-buddy/api/bind/manual` | `{appId,appSecret}` | `{ok,message?,error?}` |
| POST | `/qqbot-buddy/api/bind/unbind` | - | `{ok,message?,error?}` |

`GET /api/state` 增加：
`model: {selected:{provider,model,reasoningEffort}, effective:{provider,model,reasoningEffort}, source:'settings'|'config'|'host'}`。

## 设置 UI 追加

- 新增页内 tab「模型」：provider 下拉（首项「跟随宿主默认」）、model 下拉（随 provider）、
  reasoningEffort 下拉（空/low/medium/high/max）、保存、「应用到当前会话」（重置 bot 会话）；
  显示宿主默认模型与当前生效模型/来源；/api/models 不可用时降级为文本输入。
- 「概览」增加连接/绑定卡片：
  - 已绑定：appId + 解绑按钮（解绑后自动显示新二维码）；
  - 未绑定：状态机展示（starting/waiting 显示 qrSvg 二维码 + 刷新；failed 显示原因 + 重试；
    saving 显示保存中）+ 手动填写 appId/appSecret 折叠表单。
  - waiting/starting 期间每 2s 轮询 bind/state，卸载/切 tab 时清理定时器。

---

# 追加需求（2026-10-25 深夜）：独立可安装 + Agent 预设 + 功能开关

目标：本插件作为独立、可安装可维护的自用插件，不依赖官方 `@tencent-connect/dsh-qqbot`；
设置页可选择 agent preset，并按功能开关（工作区/网络/表情包/看图/记忆）动态收窄工具。

## settings.agent / settings.features

```jsonc
"agent": { "preset": "" },     // "" = 内置 qqbot-buddy 组合（推荐）；非空 = 宿主 agent preset id
"features": {
  "workspace": true,           // 工作区读写（fs read/write/edit + glob/grep）
  "web": true,                 // 联网搜索/抓取（web_search/web_fetch）
  "stickers": true,            // 表情包/文件发送（qqbot_send_file）
  "vision": true,              // 图片理解（qqbot_describe_image）
  "memory": true               // 长期记忆工具（memory_save/search/read/list）
}
```

## Agent 装配规则（session-manager.buildSetup）

1. `presetId = settings.agent.preset || config.preset || 'qqbot-buddy'`；
2. `await presets.mount(agentCtx, presetId)`（失败只 warn，继续）；
3. **仅当 presetId === 'qqbot-buddy'（内置组合）** 时，按 features 动态挂载工具插件
   （在 agentCtx 上 `agentCtx.plugin(moduleNamespace, config)`，模块用 dynamic import，
   失败只 warn）：
   - workspace：`@deepseek-ai/dsh-tool-fs`（config: read/readImage:false/write/edit）+ `@deepseek-ai/dsh-tool-fs-search`（sampleOverCapGlobResults:false）
   - web：`@deepseek-ai/dsh-tool-web`
4. 全局工具白名单（agentCtx 的 tools.restrict，替换 preset 里的 guard 插件）：
   - `memory_*`（features.memory && settings.memory.enabled）
   - `qqbot_send_file`（features.stickers）
   - `qqbot_describe_image`（features.vision）
   - 其它全局工具一律不暴露；restrict 对未知名称报错时解析 known global tools 取交集重试，仍失败则 warn 跳过。
   - 宿主 preset 模式（presetId !== 'qqbot-buddy'）下：workspace/web 开关无效（由该 preset 自带工具决定），
     但表情包/看图/记忆开关仍然生效（全局白名单）。
5. `promptComposer.mount(agentCtx, { scope })`；
6. `installToolFilter(agentCtx, presetId)`：在 agent scope 注册
   `system-prompt/assemble` waterfall，对 `assembly.tools` 做二次过滤——
   内置组合用 allowlist（fs/web/memory/qqbot_*，随 features 变化），宿主 preset 用 denylist
   （团队工具、画布/图片生成、working_directory、present 等 QQ 场景不需要的宿主工具）。
   原因：宿主 experimental-agent-team 会往每个 agent scope 注册工具，tools.restrict 只能收窄
   全局层，必须在 assembly 层再过滤一次。

修改 preset 或 features 只影响**新会话**；设置页「应用到当前会话」=
`POST /api/action {action:'apply-model'}` 已有行为（resetAllSessions）。

## preset 精简

`cordis.patch.yml`（bundle patch）与部署 patch 里的 `preset-qqbot-buddy` 只保留
compaction 组（compaction-basic + command-compact）；不再包含 tool-fs / tool-fs-search /
tool-web / qqbot-buddy-guard。preset/guard.js 已删除（v0.2 起白名单在 assembly 层实现）。

## API 追加

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/qqbot-buddy/api/presets` | - | `{ok,presets:[{id,name,description,broken?}],selected:settings.agent.preset,effective, defaultPreset}` |

`GET /api/state` 增加：
`agent: {selectedPreset, effectivePreset, builtIn:boolean}`、`features: settings.features`。

## 设置 UI

- 新增页内 tab「Agent」（7 个 tab：概览/回复频率/触发规则/Agent/模型/人设/自我改进）：
  - preset 下拉：首项「内置组合（推荐）」value=''，其余来自 /api/presets；
  - 5 个功能开关（工作区 / 联网 / 表情包 / 看图 / 记忆）+ 保存 +「应用到当前会话」；
  - 选择宿主 preset 时，工作区/联网开关置灰并提示「由所选预设决定」，表情包/看图/记忆仍生效；
  - /api/presets 不可用时降级为文本输入 preset id。
- 「概览」生效策略摘要增加 preset 与功能开关状态。

## 独立可安装（自用，不发布）

- 插件 `package.json` 显式声明全部运行时依赖：`@tencent-connect/qqbot-nodejs`、
  `@tencent-connect/qqbot-connector`、`js-yaml`、`qrcode`；host 包走 peerDependencies。
- 不再依赖 `@tencent-connect/dsh-qqbot`：profile 的 `package.json` 显式声明上述 4 个依赖，
  从 dependencies 与 `dsh.profile.bundles` 移除官方插件；`cordis.patch.yml` 去掉
  im-qqbot / preset-chatonly / chatonly-* 旧块；`scripts/migrate-v0.2.sh` 负责迁移
  （备份 + 只改声明与 patch，不跑 pnpm、不动 node_modules，避免窗口期风险）。
- 安装/更新：`scripts/install-local.sh` 复制到 profile node_modules；更新后重启 dsh web。

---

# 追加需求（2026-10-26）：表情包管理接口 + 收藏

目标：提供 HTTP 接口与设置页管理「可发送的表情包」；QQ agent 遇到喜欢的表情/贴图时
可以主动收藏进表情包库，下一轮起可在 system prompt 里看到并发送。

## settings.stickers

```jsonc
"stickers": {
  "dir": "<cwd>/stickers",   // 表情包目录（绝对路径；默认沿用工作区 stickers/）
  "collectEnabled": true,    // 允许 bot 用 qqbot_sticker_save 收藏新表情
  "maxMB": 8                 // 单张表情大小上限（1..50）
}
```

`features.stickers` 仍为表情包总开关：关闭时不注入目录提示、不暴露发送/收藏工具
（API 管理不受影响）。

## 存储（lib/stickers/store.js，owner: sticker-dev）

```js
createStickerStore({ settings, logger }) => {
  dir(): string,
  ensure(): { ok, created },
  index(): { version: 1, items: Record<name, { emotion, tags, note, addedAt, source }> },
  list(): Array<{ name, path, size, mtime, emotion, tags, note, addedAt, source }>,
  catalog(maxItems=48): string,     // "laugh=大笑, hehe=开心, ..." 供 prompt 注入
  get(name): item | undefined,
  read(name): Buffer,
  saveBuffer(buffer, { name?, emotion?, tags?, note?, source? }): { ok, name, item, created },
  importFile(absPath, opts): { ok, name, item, created },   // 用于收藏（路径白名单由调用方校验）
  delete(name): { ok, removed },
  update(name, { emotion?, tags?, note?, renameTo? }): { ok, item },
}
```

- 目录里只认 `.png/.jpg/.jpeg/.gif/.webp`；文件名必须是 basename、禁止路径穿越；
- `stickers/index.json` 保存元数据（原子写 0600）；没有元数据的历史文件用
  「文件名去扩展名」作为 emotion（例如 `laugh.png` → `laugh`），list 时合并展示；
- saveBuffer 必须做 magic bytes 嗅探（png/jpeg/gif/webp），大小 <= maxMB；文件写入用
  tmp+rename，重名自动加后缀；收藏默认命名 `<emotion或sticker>-<时间戳>-<随机>.<ext>`；
- update 的 renameTo 同样受 basename/扩展名限制；delete 只删目录内图片并同步 index。

## 工具（lib/tools/sticker-tools.js，owner: sticker-dev）

- `qqbot_sticker_save`：参数 `source_path`(必填 string，消息里的本地图片绝对路径)、
  `name`(可选)、`emotion`(可选)、`tags`(可选 string[])、`note`(可选)。
  路径必须位于允许根（mediaDir / cwd / config.sendFile.extraRoots），校验后用
  `stickerStore.importFile` 复制并登记；返回 `{ok,name,emotion,dir,count}`。
- `registerStickerTools(ctx, { stickerStore, config, logger })` 注册并返回聚合 dispose；
  tools 服务不可用只 warn。
- session-manager 的全局白名单与 assembly allowlist 在 `features.stickers !== false &&
  settings.stickers.collectEnabled !== false` 时加入 `qqbot_sticker_save`。

## prompt（lib/prompt.js）

- 注入【表情包库】：目录 + `catalog()` 输出（最多 48 条）；无表情时提示为空。
- 提示「看到喜欢的表情/贴图可用 qqbot_sticker_save 收藏」仅在 collectEnabled 时出现。
- TOOL_GUIDE 增加 qqbot_sticker_save 的使用说明（不滥用、不重复收藏）。

## HTTP API（owner: ui-dev）

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/qqbot-buddy/api/stickers` | - | `{ok,dir,collectEnabled,featuresStickers,maxMB,items:[{name,emotion,tags,note,size,mtime,addedAt,source,url}]}` |
| GET | `/qqbot-buddy/api/stickers/file?name=xxx.png` | - | 图片二进制（404/400 校验） |
| POST | `/qqbot-buddy/api/stickers/upload` | `{name?,dataUrl,emotion?,tags?,note?}` | `{ok,item}`（data URL，<= maxMB） |
| POST | `/qqbot-buddy/api/stickers/update` | `{name,emotion?,tags?,note?,renameTo?}` | `{ok,item}` |
| POST | `/qqbot-buddy/api/stickers/delete` | `{name}` | `{ok}` |

- 全部 JSON（file 除外），cache-control:no-store；upload body 上限 maxMB*1.4；
- runtime 增加 `stickers`（store 实例）与 `config` 已有；store 缺失时 503；
- 文件名/路径校验在 store 内部兜底，路由层先做 basename 预检。

## 设置 UI（owner: ui-dev）

- 新增页内 tab「表情包」（8 个 tab：概览/回复频率/触发规则/Agent/模型/表情包/人设/自我改进）；
- 内容：目录路径展示、总开关 `features.stickers`、允许收藏 `stickers.collectEnabled`、
  单张上限展示（只读）、刷新；表情网格（缩略图经 file 接口 + 名称 + emotion 标签 +
  收藏来源），单卡可编辑 emotion/tags/note 并保存、删除；上传表单（文件 + emotion + note）；
- 空库显示引导；上传/删除/保存都有 busy/成功/失败提示；图片加载失败显示占位。

---

# 追加需求（2026-10-26 晚）：adaptive 回复模式 + 群聊话术 + 收藏配额 + 看图缓存

## settings.reply.adaptive / groupMode='adaptive'

```jsonc
"reply": {
  "groupMode": "adaptive",        // all|count|interval|probability|adaptive
  "adaptive": {
    "debounceSeconds": 4,         // 0..30：最后一条消息后静默 N 秒触发
    "cooldownSeconds": 12,        // 0..600：回复后冷却，期间只攒不发
    "maxWaitSeconds": 20,         // 2..300：从批次首条起最长等待，到点强制触发
    "requireRelevance": true      // 批次里没有问句/图片/文件时不回（只记）
  }
}
```

### 行为（lib/qq/adaptive.js，owner: server-dev）

- gate.decide：模式 adaptive 且非强制触发时返回 buffer 标记（不触发、不计 pending、不走 minGap），
  由 middleware 交给 AdaptiveScheduler.buffer(ctx) 后 ctx.stop；stats.skipped++。
- 强制触发（@/回复/关键词/命令）仍立即回复，并让 scheduler.noteForcedTrigger 清空该 peer 缓冲 + 进入冷却。
- Scheduler 每 peer 状态：messages[]（上限 30）、firstAt、debounceTimer、maxTimer、cooldownUntil、running。
  - 每来一条消息（重新）启动 debounceTimer；maxTimer 从批次首条时间算 maxWaitSeconds。
  - 触发时若 now < cooldownUntil → 顺延到冷却结束；若另一轮 running → 300ms 后重试。
  - requireRelevance=true 时，批次内没有任何「问句特征」或图片/视频/文件附件 → 丢弃整批（不回复）。
    问句特征正则：/[?？]|吗|呢|么|怎么|为什么|为啥|啥|什么|哪|谁|是不是|能不能|可不可以|有没有|如何|多少|几|该不该|要不要/
  - 满足条件后：下载批次内各消息的附件（downloadMediaAttachments），把「除最后一条外」的消息合成为
    history 块（含 [图片] Image: 本地路径 等媒体行），最后一条用 assembleAgentBody 作为 Current message；
    manager.getOrCreate → agent.followup → whenIdle；之后清该群 history。
  - 触发后 cooldownUntil = now + cooldownSeconds*1000，gateState.lastReplyAt/ stats 更新；
    pendingSnapshot() 供 botState().pending 合并展示（形状与 gate pending 一致）。
  - 模式切走 / 插件卸载 / bot stop 时清空定时器与缓冲；缓冲不持久化（重启丢失，可接受）。
- /status 增加自适应参数与缓冲批次数；UI 侧边栏 pending 显示缓冲条数。

## 群聊话术默认值

- `persona.groupExtraPrompt` 默认改为空字符串（不再默认要求 @；群里人少时纯文本 @ 也不是真 @）。
- prompt 固定 RHYTHM_GUIDE 增加：没被直接问到时 2~3 句、不要每句反问、同话题无新信息不追加、别人聊天别插话。

## 表情包：内容去重 + 每日配额

- index item 增加 `hash`（sha256 前 16）；saveBuffer 先算 hash：
  - 与已有条目相同（历史文件按需读文件补算 hash）→ 返回 `{ok:true, duplicate:true, name:<已有文件名>, item}`，不新写文件；
  - 新保存写入 hash。
- `settings.stickers.dailyLimit`（默认 10，1..100）：`countAddedSince(24h)` >= limit 时，
  **source='tool' 的收藏** 抛可读错误「今日收藏已达上限」；API 上传不受配额限制；
  `collectQuota().todayCount` 也只统计 `source='tool'` 的条目（历史文件/手动上传不占机器人额度）。
- 工具输出增加 `duplicate: boolean`；render 在重复时显示「已在表情包库：<name>（未重复收藏）」。

## 看图：失败重试 + 缓存

- vision.maxTokens 默认 2048；首次调用若返回空文本（reasoning 吃掉预算），自动翻倍重试一次（上限 4096）。
- 同图片 sha256 + 同 prompt 的成功描述缓存 30 分钟（LRU 64），命中直接返回，省 token。
- 首轮 maxTokens 下限 4096；空文本（reasoning 吃满预算）时依次用 8192/16384 重试，错误文本带 finish/maxTokens。
- `/new` 创建的新会话自动 attach 到 config.cwd 对应的 DSH workspace（否则 Web 侧栏 qqbot 工作区看不到）。
- QQ agent 的 team:identity 为 required context，refreshContext 会在 assembly 后重新加入；
  在 assembly waterfall 里把该 provider.text 改成空字符串（仅当前 agent），避免 Team Lead 口吻泄漏。

## 连发多条（2026-10-26 晚补充）

- **一个 turn 只发最终回复**：`assistant/message` 先缓存（同一 turn 可能先讲一句再调工具），
  `turn/end` 且 reason completed 时才发送最后一个文本块；error/aborted 丢弃残留文本（异常提示单独发），
  避免"先说话 + 工具后最终回复"被当成两条回复重复发送。
- 模型常用「空行分段」表达连发，但之前会被合并成一条多行 QQ 消息。现出站：
  - 显式 `[[msg]]` 优先；
  - 无标记时按空行拆 2~4 段（每段 ≤420 字、总长 ≤900 字）→ 多条 QQ 消息；
  - 代码围栏、表格、清单、单换行、超过 4 段或过长文本保持一条。
- prompt 固定追加【发消息】规则；persona 的【连发多条】改成空行分隔、不写标记。
- 版本 0.4.1。

## 人设 vs 自我改进提示词（2026-10-26 上午）

- 目标：`persona.md` 只做人设/语气；学习、记忆、自我改进规则单独成篇，可分别编辑。
- `lib/self-improve.js`：`DEFAULT_SELF_IMPROVE_PROMPT`（聊天内学习规则）、`DEFAULT_COLLECTOR_PROMPT` /
  `buildCollectorPrompt`（自动提炼 prompt，支持 {{maxFacts}}/{{maxFactChars}} 占位）。
- settings.memory 新增 `selfImprovePrompt`（默认内置规则）与 `collectorPrompt`（空=默认）；
  均为可热改文本（<=8000 字符）。
- prompt 组装：persona 段之后追加独立的 `【自我改进】` 段；长记忆数据仍单独一段；工具约定单独一段。
- collector：提取 prompt 用 `buildCollectorPrompt(..., override: cfg.collectorPrompt)`，不再硬编码。
- UI：设置 → 自我改进页新增「自我改进提示词」「记忆提炼提示词（高级）」两个文本域，随记忆设置一起保存。
- 版本 0.4.4。

## 长期记忆可见 + 口头禅（2026-10-26）

- GET /api/memory 增加：facts（解析 MEMORY.md 的 `- [date] 文本（#tag）`）、memoryEnabled、injectMaxChars、
  hotChars、injectedChars、truncated；UI 自我改进页「长期记忆（当前注入）」卡片展示。
- 新增 settings.phrases = {enabled, items:[{text,note,enabled}]}（<=40 条，文本去重）。
- prompt 组装：persona 之后、自我改进之前追加独立【口头禅】段（最多 20 条；一次回复最多用 1 个）。
- 新增 GET /api/phrases/suggestions：扫描 MEMORY.md 中标签含 口头禅/口头语/口癖/说话风格/接梗 的事实，
  提取引号内短语作为候选（过滤已存在条目）。
- 新增 UI tab「口头禅」：条目编辑/开关/删除、手动添加、自动扫描候选并加入；保存走 /api/settings。
- 版本 0.4.5。

## 独立安装（2026-10-26）

- 插件是一个标准 npm 包 + dsh.bundle.patch：`scripts/install-package.sh` 打包 tarball 到
  `<profile>/vendor/`，profile 依赖用 `file:./vendor/<tgz>`，`node_modules/dsh-qqbot-buddy` 为解包真实目录。
- 运行期不再依赖 repo 路径（repo 可移动/删除）；`install-local.sh` 与 `link:` 仅作开发同步，
  link 模式需 `scripts/link-deps.sh` 补 repo 依赖软链。
- 已验证：干净目录 `npm install <tgz>` 后可从包内 import；profile 内直接 import 成功。

## 气泡拆分设置（2026-10-26 下午）

- settings.reply.bubbleSplit：'auto'（默认，空行自动拆）/ 'marker'（只认 [[msg]]）/ 'off'（永不拆）。
- auto 恢复简单行为：2~4 个空行段、总长 <=900、每段 <=420 就拆；不再做"短句并回"的智能合并。
- 回复字数控制交给 prompt/persona：大多数回复只发一条、1~2 句，不要每次补第二段；内容多才分条。
- 版本 0.5.2。
- UI 回复频率 tab 增加「气泡拆分」三选一。

## QQ 表情（2026-10-26）

- 群聊/单聊 Bot API 仅 msg_type 0/2/7，没有原生 face 元素；频道才支持 <emoji:id>。
- 插件用 Unicode emoji；`lib/qq/emoji.js` 把模型可能写的 [捂脸]/【表情: 赞】/[face: 得意] 转 Unicode，
  outbound 发送前统一转换；prompt 也提示直接用 😄 等字符。
- 精确 QQ 小黄脸原画只能走图片/表情包（media/qqbot_send_file）。

## UI

- 回复频率 tab：模式增加「自适应（推荐）」，选中后显示 静默秒数/冷却秒数/最长等待秒数/只回问句与媒体 四个控件；
  生效摘要包含自适应参数。
- 表情包 tab：显示并保存「每日收藏上限」（stickers.dailyLimit），可显示今日已收藏数量。
- 版本 0.4.0。
# 追加需求（2026-10-26 晚）：人格卡 / 设置页重构 / 命令展示 / 管理员权限

## 人格卡
- 新文件 lib/persona-cards-store.js：cardsDir=<cwd>/personas，index.json {version:1,activeId,cards[]}，卡文件 <id>.md。
- list/create/update/activate/delete/importCurrent/detectActive：activate 通过 personaStore.write 写回当前人设（自动备份）；
  delete 不删当前人设；active 由内容实时比对（CRLF/尾部换行归一化）；坏 index 备份 .corrupt-* 后回退。
- 路由：GET/POST /persona/cards；GET /persona/cards/content?id=（读卡正文）；POST /persona/cards/update、/activate、/delete；失败统一 {ok:false,error} 转 400/404。
- UI 支持「手动新建卡（自定义内容）」（POST create 带 content，不依赖当前人设）与「编辑内容」（先 GET content，再 POST update；
  若该卡是使用中的卡，保存后再 activate 一次以同步人设并备份旧人设）。
- index.js 动态装配 runtime.personaCards（失败降级）。

## 设置页 IA（v0.15「工作区 → 页面」重设计）
- 结构声明仍在 lib/settings-schema.js（单一真相，前端只是渲染器）：
  `SETTINGS_GROUPS`（6 个工作区）+ `SETTINGS_SECTIONS`（工作区 → items 页面）。
  每个页面 `{id, label, widget, desc, hotspot}`；`widget` 指向 client/client.js 的 widgets 表。
  `schemaPayload()` 同时下发 `items` 与兼容字段 `children`（旧客户端可读）。
- 6 个工作区：📊概览 / 💬对话 / 🧰能力 / 📝提示词 / 🗂内容 / 🔐权限（共 16 个页面）。
- 交互（client/client.js 的 Section）：
  - 顶部是工作区 tab（带图标与页数徽标），下面是页面切换；
  - **窄容器（宿主设置面板通常 ~700px）用横向胶囊行**，用 container query 在 ≥900px 时升级成左侧 rail；
    不用 media query，因为面板宽度 ≠ 视口宽度；
  - 面包屑（工作区 / 页面）+ 页面一句话说明；
  - 页头 `toast`：页面内小操作（如一键放行工具）完成后回报，不打断当前页；
  - `VIEW_ALIASES`：旧 tab id → (工作区, 页面)，旧书签/旧 `onNavigate("prompts")` 继续可用。
- 分页原则「一个功能只有一个家」：
  - 行为的"发几条"（bubbleSplit）在 对话→语气与分条；提示词里"怎么写"在 提示词→说话方式；两页互链、互不重复；
  - 安全红线从提示词挪到 权限（它是约束，不是人设）；
  - 模型从"Agent 与模型"里独立成 能力→模型与预设，能力开关留在 能力→能力与工具；
  - 口头禅独立成页，不再挤在人设页。
- 新增/复用的前端组件：`MessageStylePage`（气泡拆分 + 两段提示词）、`SpeechPage`（纯提示词两段）、
  `PromptStructurePage`（顺序总览 + 去编辑落点）、`PromptNote`（段位 chips：第几位 / 本次未注入）；
  `PromptSectionPage` 增加 `inline` 模式，可嵌进别的页面而不重复 `.qqb-page` 间距。

## 视觉语言（v0.15.1：对齐 dsh 官方 primitives / 插件市场）
- **不用 emoji**：标题、导航、状态、错误提示全部纯文字；层次只靠字号（16/13/12/11）、字重（400/500/600）、
  灰阶（label-primary / secondary / tertiary）和 1px 细线（border-l2 / l3）表达。
- **颜色只走 --dsw-alias-* 令牌**，浅色/深色主题自动跟随；fallback 只是兜底色。
  深浅两套都实测过：深色下 `brand-primary` 解析为近白色（#f9fafb），所以选中态在深色里是"白字 + 白线"，
  与插件市场的选中 tab 完全一致；浅色下才是蓝色。
- **一级导航** = 官方 tab 形态：13px 文字、2px 底线、选中加粗走 brand；页数写成 `提示词 (6)` 文本，
  不用徽标气泡（市场里 `已安装 (7)` 就是这个写法）。
- **二级导航** = 胶囊 chip（官方 capChip）：12px、999px 圆角、细边；选中态用 `bg-layer-3` 实底、无边框，
  深色下才看得出层次。不再用"常用圆点"这类装饰。
- **卡片**：8px 圆角 + 细边 + 透明底（市场里分区是平的），标题 13/600，hint 12px 灰；
  列表用 1px 下划线分隔，不再用一层层"框套框"。
- **按钮**：默认细边描边；`--primary` = 反色实心（label-primary 填充），深色下就是市场里那颗浅色主按钮。
- **开关**：官方开关观感——关=border-l3 灰轨、开=brand 轨（深色=白轨 + 深色滑块）。
- **分段控件**：胶囊内嵌，选中用浅底 + 细描边，不整块填主色。
- 键盘可达性：tab / chip / 按钮 / 开关 / 分段项统一 `focus-visible` 2px brand 轮廓。
- 覆盖测试：test/settings-schema.test.js 校验每个 `widget` 都能在 client.js 的 widgets 表里找到（防止点开空白）。

### 表情包段的两套键名（2026-10-29 修复）
提示词有两套机制，段 id 与存储键**不一定同名**，踩过一次坑：

| 机制 | 存哪 | 谁读 |
| --- | --- | --- |
| 逐段覆盖 | `settings.prompts.sections.<段id>` | `compose()` 里 `readSectionOverride(cfg, section.id)`，命中就直接用该文本 |
| 功能提示词 | `settings.prompts.<key>`（toolGuide/sendGuide/rhythmGuide/stickerGuide） | 各段 renderer（`resolveGuide`），是"默认文案 + 开关" |

- 表情包段：段 id = `stickers`（prompt-sections.js），默认文案键 = `stickerGuide`（prompt-guides.js / `/api/prompt` 的 `defaults`）。
- 旧设置页用 `sectionId: "stickerGuide"`：`details` 里查不到（那是段 id 不是键名）、`defaults` 恰好能查到 → 页面显示空编辑器；
  保存写进 `prompts.sections.stickerGuide`，而 `compose()` 只读 `prompts.sections.stickers` → **编辑永远不生效**。
- 现在：页面用 `sectionId: "stickers"`，`PromptSectionPage` 通过 `PROMPT_DEFAULT_KEY` 把默认文案键翻成 `stickerGuide`；
  `test/settings-schema.test.js` 会扫描 client.js 里所有 `sectionId:` / `LegacyPromptPage(...)`，断言它们都在 PROMPT_SECTIONS 里；
  `test/prompt.test.js` 锁住"按段 id 覆盖生效 / enabled=false 不注入"。
- 表情包页的阅读顺序：`表情包设置`（能不能发、带不带收藏、发多勤）× `表情包使用规则`（注入的提示段）× `表情库/上传`；
  三段由 `StickersTabPage` 组合，`StickersPage` 增加 `part: "settings" | "library"` 以复用同一份组件。

## 表情包发送频率（v0.15.1）
- 设置项：`settings.stickers.frequency`，四档 `off | rare | normal | often`，默认 `normal`（等价旧行为"每 3~5 轮"）。
- 只做**提示词节奏指引**，不做硬拦截：`lib/prompt.js` 的表情包段在"内置规则文本"后追加一行
  `【发送频率】…`（文案在 `lib/prompt-guides.js` 的 `STICKER_FREQUENCY_LINES`）。发不发仍由模型决定，
  避免出现"工具被拦、表情攒着发不出去"。
- 尊重用户写法：用户若自定义整段 `prompts.stickerGuide.text`，不再追加频率行。
- 归一化：`enumStr(..., STICKER_FREQUENCY_LEVELS, 'normal')`，未知值回退 `normal`，只有变化才落盘并广播。
- 覆盖测试：`test/settings-store.test.js`（默认/四档/未知回退/变更列表）、
  `test/prompt.test.js`（四档注入对应节奏、自定义文本不追加、能力关闭不注入）。

## 命令目录 + 管理员
- commands.js 导出冻结 COMMAND_CATALOG（help/ping/status/id/new/reset/clear/resume/stop）与 adminStatus()；
  /id 公开显示昵称/openid/管理员状态；/help 由目录生成并标注管理员命令。
- settings.admin = {enabled, openids, names}；enabled 且名单非空才启用门控；管理员命令 new/reset/clear/resume/stop，
  被拒命令不执行、不清 adaptive 缓冲；未启用/名单空保持旧行为。
- 门控只覆盖 QQ 命令；Web 设置页仍由本机 dsh Web 访问。

## 功能性提示词与人设分离（2026-10-26 夜）

- 新文件 lib/prompt-guides.js：DEFAULT_TOOL_GUIDE / DEFAULT_SEND_GUIDE / DEFAULT_RHYTHM_GUIDE / DEFAULT_STICKER_GUIDE，
  DEFAULT_FUNCTION_PROMPTS，resolveGuide(entry, fallback)，guideEnabled(entry)。
- settings.prompts = { toolGuide, sendGuide, rhythmGuide, stickerGuide }，每项 {enabled:boolean, text:string(<=8000)}；
  text 为空 = 内置默认；enabled=false = 不注入。默认全部启用、text 为空。
- prompt.js 不再硬编码三份 GUIDE，改为按 settings.prompts 逐段注入；表情包段 = 规则文本 + 动态目录（catalog/dir 仍由插件追加）。
- 2026-10-26 夜：把原 persona.md 里的功能内容全部迁到默认功能提示词 ——
  【能力边界】+【工具使用约定】+【安全】→ toolGuide；【群聊消息格式】+【长短】+【连发多条】+清单/emoji 规则 → sendGuide；
  【群聊节奏】→ rhythmGuide；【表情包】→ stickerGuide。
  persona.md 只保留：身份、说话方式、什么时候认真、底线（语言风格）。
- UI：人设 tab 新增「功能提示词（与人格无关）」卡片，四段各有开关 + 文本域 + 独立保存。
- personaGroup 与功能提示词分离后，persona.md 可只保留语气/性格。

## 扩展能力开关（2026-10-26 深夜）

- settings.tools.extraAllowed（string[]，<=50 项，工具名 ^[A-Za-z0-9_.-]{1,80}$）：
  - 内置组合：加入 tools.restrict 白名单 + assembly allow 名单；
  - 宿主预设（deny 模式）：从屏蔽名单中移除该工具名。
- UI：Agent 与模型 tab 新增「额外放行工具（高级）」卡片（每行一个工具名，独立保存）。
- skill 工具由 dsh-tool-skill 注册；内置组合 preset 只挂 compaction，所以 extraAllowed 含 `skill` 时
  mountFeatureTools 会额外动态挂载 @deepseek-ai/dsh-skill-filesystem + @deepseek-ai/dsh-tool-skill（失败只 warn 降级）。
  验证：隔离实例 assemble 后 tools 含 skill（alt: standard preset 自带同款插件）。
- 技能目录通过 agent/pre-step 注入 user message（<available_skills>），与人设 replace 模式无冲突。

## 测试
- prompt-guides.test.js 6（默认注入/关闭/覆盖/目录保留/群聊节奏条件/resolve 语义）
- persona-cards-store.test.js 17；commands-admin.test.js 11；persona-cards-api.test.js 6；全仓 297+ 绿；
  浏览器 8 tab 截图 + 无 console/page error。

# v0.16（2026-10-29）：多机器人 · 知识库 · 群友库 · 必要时涌现

完整设计契约见 [`docs/MULTIBOT-KNOWLEDGE-DESIGN.md`](docs/MULTIBOT-KNOWLEDGE-DESIGN.md)，实现要点：

## 多机器人

- `lib/bots/registry.js`：`<workspaceRoot>/bots.json`（无密钥）+ 每机器人 `credentials.json`（0600）；
  首次启动迁移 legacy 机器人（沿用旧 cwd/stateDir/settingsFile），旧数据原地可读。
- `lib/bots/paths.js`：工作区目录解析（persona/memory/knowledge/members/stickers/state/media）。
- `lib/bots/runtime.js`：一个机器人 = 一套 settings/persona/memory/knowledge/members/stickers/
  collector/prompt/manager/gateway/binding；agent cwd = 该机器人工作区。
- `lib/bots/host.js`：N 个运行时 + 工具全局注册一次 + facade（字段代理 active 机器人，旧路由兼容）。
- `lib/bots/agent-map.js`：`Agent → BotRuntime`（WeakMap），工具 `execute(args, exec)` 按
  `exec.agent` 路由；SessionManager 建会话时登记。
- HTTP：所有接口支持 `?botId=`；新增 `/bots*`、`/knowledge*`、`/members*`、`/recall/preview`；
  `/state` 的 bot 增加 id/name/legacy/workspaceDir/dirs；绑定接口支持按 botId 选择绑定服务。

## 记忆 v2 与涌现

- `memory/store.js`：index v2（importance/hits/lastHitAt）+ `recall(query, opts)` + `stats()`；
  MEMORY.md 文本格式不变；v1 自动迁移。
- `lib/context/emergence.js`：按当前消息从记忆/知识/群友检索，生成【本轮相关背景】；
  prompt 新增 `recall` 段（priority 58），由 `record.turn.current` 提供本轮上下文；
  无相关内容不注入。
- `prompt.js`：`compose({scope, turn})` / `mount(agentCtx,{scope,turn,getTurn})`。

## 知识库 / 群友库

- `lib/entries/store.js`（通用条目库，frontmatter+markdown+index.json）、`lib/knowledge/store.js`、
  `lib/members/store.js`（成员 id = sha1(openid)，visit 轻量累加，recallAlly 发言人优先）。
- 工具：`knowledge_search/read/save`、`member_lookup/note`；能力目录默认开启（可在设置页关）。
- 设置页：内容 → 知识库/群友库；概览 → 机器人列表/工作区与文件；记忆页新增相关性召回设置与预览。

## 测试

- `node --test test/*.test.js`（含 `bots-registry/bots-host/multibot-integration` 与队友新增用例）；
- 隔离环境：`.dsh-dev`（3098）sync + restart 后 API/UI 验收，见 `.dsh-dev/docs/ui-verify-v016.md`。

# v0.17（2026-10-30）：知识自动提炼 + 工具作用域收口

## 知识自动提炼（阶段一）

- 模块：`lib/knowledge/auto-extract.js`；接口
  `createKnowledgeExtractor({ctx, settings, knowledge, logger, getRoute, callModel})` →
  `{config, extractNow(record, {transcript, scope, groupId, groupHint}), noteTurnEnd(record), stats}`。
- 触发：outbound `turn/end` 时 gateway 把记忆 collector 与知识 extractor 组成 composite 一起驱动；
  每轮计数，达到 `settings.knowledge.autoExtract.everyRounds` 后台跑；也支持 API 手动触发（可传 transcript 试跑）。
- 输出：模型返回 `{"knowledge":[{title,body,tags,importance,confidence,scope}]}`；
  解析后按 `minConfidence` 分流：≥ 阈值 `status='approved'`，否则 `status='pending'`；
  同标题同作用域合并（tags/importance），不重复建条目；单次最多 `maxEntries` 条。
- 条目库新增 `status: approved|pending`（frontmatter + index 都落盘；旧文件/旧索引缺字段按 approved）；
  `search/recall` 跳过 pending，`list` 支持 `status` 过滤，`stats` 暴露 pending 数。
- API：`POST /knowledge/extract`、`GET /knowledge/extract/stats`、`POST /knowledge/approve`；
  `GET /knowledge?status=`。
- 设置：`knowledge.autoExtract = {enabled:false, everyRounds:6, maxEntries:3, minConfidence:0.8, provider:'', model:''}`。

## 工具作用域收口（行为变化）

- 新增 `lib/bots/scoped-tools.js`：`registerScopedTools(agentCtx, bot, logger)` 把插件工具
  （memory_* / knowledge_* / member_* / qqbot_send_file / qqbot_sticker_save / qqbot_describe_image）
  通过 `agentCtx.tools.register()` 注册到当前 agent 的 scope。
- SessionManager `buildSetup` 第 4.6 步调用（仅 QQ 会话创建时），并用 `agentCtx.effect` 绑定清理；
  host 不再在插件 ctx 上全局注册工具（删除 `lib/bots/tools.js`）。
- 效果：只有 qqbot-buddy 创建的 agent（qqbot preset 或为机器人选的 preset）能看到这些工具；
  宿主普通 agent / 其它 preset 的全局工具视图不再出现它们。
- `applyToolWhitelist` 在 `restrict()` 前把 allow 过滤为「全局已注册工具名」，避免 scope 工具名导致白名单失败。
- 兼容：各工具模块的旧注册签名保持可用（单机器人/单测），多机器人仍按 `exec.agent → BotRuntime` 路由。
# v0.18（2026-10-30）：群友备注自动提炼（阶段二）

- `lib/knowledge/auto-extract.js` 扩展：
  - `config()` 同时返回 `knowledge` / `members` 两段配置，`enabled` = 任一开启；
  - prompt 按开关生成 knowledge / members 两类输出，一次模型调用完成；
  - `parseExtractedResult()` 校验两类条目（知识标题/正文/标签/重要度/置信度/作用域；群友 name/openid/aliases/tags/note/confidence）；
  - 群友处理：openid 优先、昵称/别名 + 当前群精确匹配；匹配不到跳过；
    `confidence < minConfidence` 跳过；写入调用 members.applyAutoNote。
- `lib/members/store.js` 新增：
  - `save()` 人工保存非空备注 → `meta.notesSource='manual'`；
  - `applyAutoNote({id,note,tags,confidence,at})`：空正文写正文（auto）/ 自动正文可更新 / 人工正文只追加 `meta.autoNotes`（去重、≤4）；
  - `adoptAutoNote({id,index})`：采纳进正文、移除自动补充、标记 manual；
  - `toItem()` 暴露 `autoNotes` / `notesSource`。
- 设置：`members.autoExtract={enabled:false,maxNotes:2,minConfidence:0.8}`（布尔 true 兼容）。
- API：`POST /members/adopt`；`POST /knowledge/extract` 返回 `membersUpdated/membersSkipped`。
- UI：群友库页新增「自动提炼（群友备注）」卡片；详情页显示「自动补充」列表 + 「采纳到备注」按钮；
  知识库提炼完成提示展示群友备注条数。
# v0.18.1（2026-10-30）：群友库手风琴式编辑（纯前端）

- MembersPage 从「顶部独立详情卡 + 列表」改为「列表项原地展开」：
  - 行头：状态点 + 昵称 + 摘要（openid/群数/发言/最近活跃）+ 可选标签 + 编辑/删除；
  - 展开：昵称、标签、备注、自动补充（含采纳）、重要度、openid/发言数/群列表，底部取消/保存/删除；
  - 同一时间只展开一位（accordion），保存/取消即收起；删除支持从行内直接删。
- 新增样式 `.qqb-accordion*`（沿用现有 qqb 设计变量，无新增依赖）。
- API 与数据结构不变（/members/save、/members/adopt、/members/delete）。
# v0.18.2（2026-10-30）：旧记忆 → 群友备注一次性回填

- 新增 `lib/members/memory-backfill.js`：`backfillMemberNotesFromMemory({memory,members,stateDir,logger})`。
  - 读取 `memory.index().facts`，按成员昵称/别名做纯文本包含匹配（长度 ≥2）；
  - 每位成员取最近最多 5 条事实，拼成一句备注（；分隔，≤480 字）；
  - 写入走 `members.applyAutoNote`：空正文写正文、自动正文可更新、人工备注只进 `meta.autoNotes`；
  - 幂等：marker `<stateDir>/memory-backfill-v1.json`，存在即跳过。
- runtime 在 members 初始化后调用一次（失败只 warn，不影响启动）。
- 背景：旧版本没有群友库，升级后成员条目只有名字没有备注，本次补齐历史信息；新增事实仍由自动提炼/工具维护。
