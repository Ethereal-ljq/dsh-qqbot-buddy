# QQ 插件现状与改造点地图（code-auditor / task-2）

> 目标：为「QQ 官方 API v2 升级」提供**代码级**落点。所有行号基于当前仓库 HEAD（v0.20.2，482 个单测全绿）。
> 相关外部资料见 [qq-api-v2-capability-notes.md](./qq-api-v2-capability-notes.md)（doc-scout 产出，本文只引用其结论编号，不重复抄录）。
> **本文档只读代码得出，未修改 lib/ 与 client/。**

---

## 0. 一页结论

| 问题 | 结论 |
| --- | --- |
| 出站是否只有 `bot.sendMarkdown` 一条路径？ | **文本是**：`lib/qq/outbound.js:295-313 sendChunk()` 是唯一文本发送点（命令回复 `lib/qq/commands.js:319-329`、入站兜底 `lib/qq/inbound.js:26-33` 各有一处 `sendMarkdown` 直调）。**媒体是第二条路径**：`lib/qq/gateway.js:147-165 mediaSender` 走 SDK `sendImage/sendVideo/sendVoice/sendFile`。没有任何 `bot.send()` / `sendText` / `keyboard` / `message_reference` 调用。 |
| `msg_seq` 谁管？ | **SDK 自动生成**：`QQBot.sendMarkdown` → `send()` → `messageApi.sendRaw`（SDK `dist/protocol/api/messages.js:119-124`）在缺省时注入 `getNextMsgSeq()`；该函数是 `Date.now()%1e8 ^ random` 取模 65536（`routes.js:45-49`），**不是按 msgId 的递增计数器**，两次发送有概率撞号（平台语义：同 msg_id+msg_seq 重复 → 40054005）。插件侧完全不感知。 |
| 被动回复 4 条上限 / 60 分钟窗口？ | **完全没有显式处理**。没有计数、没有窗口过期预判、没有 `ReplyLimiter`（SDK 已内置，见 §6）。只有「发失败就降级主动」的后验兜底。 |
| 主动兜底有频控/去重吗？ | **没有**。降级主动推送没有队列、没有 20qpm / 1000 条/天 限速、没有幂等去重，失败即放弃（`outbound.js:304-312`、`gateway.js:150-157`）。 |
| 入站支持哪些事件？ | **只有两类**：SDK `message` 事件（C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE，且 guild/dm 被 SDK 丢弃）与 `interaction`（仅 ack）。**`rawEvent` 没监听** → FRIEND_ADD/DEL、C2C_MSG_RECEIVE/REJECT、GROUP_ADD_ROBOT/DEL_ROBOT、GROUP_MSG_RECEIVE/REJECT、reaction 全部静默丢失（`gateway.js:259-274`）。 |
| 设置开关要改哪些文件？ | `lib/settings-store.js`（defaults+归一化，**不写这里字段会被丢弃**）→（可选）`lib/settings-schema.js`（仅新增页面时）→ `client/client.js`（widget + 保存 patch）→ `lib/web/routes.js`（仅新增专用路由/派生字段时）→ 消费方（outbound/middleware/...）→ 测试。见 §4。 |
| 测试怎么跑？ | `npm test`（= `node --test test/*.test.js`，Node ≥20）。当前 482 pass / 0 fail，约 1s。无 lint 脚本；e2e 是手动 Playwright 脚本（`test/e2e/*`）。见 §5。 |

---

## 1. 出站（QQ → 用户）

### 1.1 调用链（当前唯一文本路径）

```
ctx.on('session/event')                       gateway.js:185-219 attachSessionEvents()
  └─ createOutboundHandler(...)               outbound.js:278-429
       ├─ assistant/message → rememberPending outbound.js:361-373（只缓存，不发）
       └─ turn/end → sendText(record, pending) outbound.js:376-407
            ├─ 分条：[[msg]] / 空行 / off     outbound.js:327-344（bubbleSplitMode 读 settings.reply.bubbleSplit）
            ├─ 长度切分 chunkMarkdownText     outbound.js:109-193（limit = config.textChunkLimit，默认 4500，config-schema.js:19）
            └─ sendChunk(bot, record, chunk)  outbound.js:295-313
                 ├─ bot.sendMarkdown(record.replyTarget)        ← 被动（带 msgId）
                 └─ bot.sendMarkdown({scope,targetId})          ← 主动兜底（去 msgId）
```

要点：

- `record.replyTarget` 由入站时 SDK 的 `mCtx.replyTarget` 写入并**每条新消息覆盖**（`inbound.js:212`、`session-manager.js:725-731,834`），字段 `{scope, targetId, msgId}`；`msgId` 存在与否就是「被动 / 主动」的开关（SDK `QQBot.send` 见 `QQBot.js:446-470`：有 msgId 才写 `msg_id`）。
- 一场 turn 可能发出 **N 条**：段数（`splitBlankLineSegments` 上限 4，`outbound.js:65`）× 长文切分条数。**没有对每条 inbound 消息的发送计数**，所以「单聊 4 次 / 群聊 5 次」上限天然可被突破。
- 失败判定只看「抛异常」，**不看 err_code**（outbound.js:301-312）。文档要求按 `err_code` 判定（notes §2）；当前会把 40054005（msg_seq 重复）、内容超限、权限类错误也当成「窗口过期」去重试主动推送 → 容易产生重复消息/二次失败。
- 主动兜底后 `stats.replies` 仍 +1（outbound.js:387-391），但发送失败不计，统计口径与「已回复」语义不完全一致。
- 命令回复 `sendCommandReply`（commands.js:319-329）固定走 `ctx.replyTarget` 被动，**不做主动降级**；入站异常提示 `safeSend`（inbound.js:26-33）同样只有被动一条路。
- 媒体路径：`gateway.js:147-165` `sendMediaWithFallback` —— 被动失败后去掉 msgId 再试主动；由 `qqbot_send_file` 工具调用（`send-file.js:163-177`）。注意：显式传 `target` 时 `parseTarget` 返回的对象**没有 msgId**（send-file.js:41-49,128-139）→ 显式目标永远是主动消息。
- 长回复终态：`turn/end` 异常且非 `STREAM_CLOSED` 时补发 `⚠️ 本轮异常结束`（outbound.js:400-406），也走 `sendText`（同样占用被动次数）。

### 1.2 缺口清单（升级落点）

| 功能点 | 现状（文件:行） | 改动位置（文件/函数） | 风险 / 兼容性 |
| --- | --- | --- | --- |
| 被动回复次数上限（4/5 次）+ 60min/5min 窗口预判 | 无 | 新增 `lib/qq/outbound.js` 内 `createReplyBudget()`（按 msgId 计数，参考 SDK `ReplyLimiter`）；`sendChunk` 前查预算，超限直接走主动 | 需在 `inbound.js:212` 记录触发消息的 msgId + 时间戳；多机器人共用 outbound 时按 appId 隔离。改错了会「该回不回」 |
| `msg_seq` 自管 | SDK 随机生成（messages.js:119-124 / routes.js:45-49） | 改用 `bot.send({target, msgType:2, markdown, extra:{msg_seq}})`（`extra` 透传，QQBot.js:446-470），或在 `sendChunk` 里自增计数 | 需保持同 msgId 内递增、跨回调不重置；主动消息 msg_seq 无意义（固定 1）。属**行为变更**：重复发送的失败模式会变 |
| 主动兜底频控 / 队列 / 去重 | 无（outbound.js:304-312；gateway.js:150-157） | 新增 `lib/qq/proactive.js`（令牌桶 + 按 20qpm/1000 日 限速 + 内容 hash 去重），`sendChunk` 与 `sendMediaWithFallback` 共用 | 需新增设置项（`reply.proactive.*`）与 UI；失败静默丢弃 vs 排队会影响延迟体验 |
| markdown → 纯文本降级 | 无（永远 msg_type=2） | `sendChunk` catch 里按 err_code（304037/40034127/40034124）改 `bot.send({target, msgType:0, content})` | 老行为是直接主动重试；改成降级会让内容格式变化，需设置开关灰度 |
| 流式（仅单聊） | 无 | `outbound.js:361-373 onAssistantMessage` 目前只缓存，可改为 c2c 时 `bot.openStream({target, msgId})`（QQBot.js:652），turn/end `complete()` | 群聊不支持，必须按 scope 分流；STREAM_ERROR 时时序与现有「只发最后一段」策略冲突（需保留非流式回退） |
| 引用回复 `message_reference` | 无（SDK 支持，QQBot.js:446 的 messageReference 字段） | `sendChunk` 增加可选 `message_reference:{message_id: msgIdx}`；msgIdx 来自入站 `msg.msgIdx`（SDK dispatcher 解析 message_scene.ext） | 需把入站 msgIdx 一路带到 record；QQ 客户端版本差异 |
| 按钮 / keyboard | 无 | `sendChunk` 传 `keyboard`；`gateway.js:267-274` 的 interaction 处理改为真实回调分发（现在无条件 ack code=3） | 需要 INTERACTION_CREATE 路由到具体业务；当前 ack code=3 = 「重复操作」，语义错误 |
| 撤回兜底 | 无 | 用 `bot.recallMessage(target, id)`（QQBot.js:525），需 sentTracker 记录入站 msgId 之外的「自己消息 id+时间」 | 2 分钟窗口；群管理员撤回是另一套权限 |
| 输入中状态（单聊） | 无（SDK `sendTyping` QQBot.js:579，中间件 `typingIndicator` 在 middleware.js:296 只是 SDK 侧） | turn 开始时 `sendTyping`，长任务每 ≤60s 续发 | 仅 c2c；群聊调用会报错，需 scope 判定 |

---

## 2. 入站（用户 → QQ）

### 2.1 装配与事件面

- 订阅：`gateway.js:222-324 createBotInstance()` 只 `on('message')`、`on('interaction')`、`on('error')`、`on('ready')`、`on('resumed')`、`on('disconnected')`。**没有 `on('rawEvent')`**。
- SDK 侧：`event-dispatcher.js:55-153` 把 C2C/AT/DIRECT/GROUP_AT/GROUP_MESSAGE 映射为 `action:'message'`，INTERACTION 映射为 `interaction`，其余全部 `action:'raw'` → `QQBot.js:335-338` 发 `rawEvent`。
- `deriveReplyTarget`（SDK QQBot.js:770-781）对 guild/dm 返回 null → **频道/私信消息被 SDK 静默丢弃**，业务层收不到。
- 因此当前实际支持：

| 事件 | 是否处理 | 落点 |
| --- | --- | --- |
| `C2C_MESSAGE_CREATE` | ✅ kind=c2c | middleware 管线 → inbound.js:202-296 |
| `GROUP_AT_MESSAGE_CREATE` | ✅ kind=group | 同上 |
| `GROUP_MESSAGE_CREATE`（群主开「接收所有消息」） | ✅ kind=group（仅当平台推） | 同上 |
| `INTERACTION_CREATE` | ⚠️ 只 ack，不解析 | `gateway.js:267-274`：`acknowledgeInteraction(event.id, 3)`（code 3 = 重复操作，语义不当；未按 `type` 分流 type=11/12 按钮） |
| FRIEND_ADD / FRIEND_DEL | ❌ 丢失 | 需 `on('rawEvent')` |
| C2C_MSG_RECEIVE / C2C_MSG_REJECT | ❌ 丢失（**主动消息开关状态无法维护**） | 同上；notes §12 #16 明确要求监听 |
| GROUP_ADD_ROBOT / GROUP_DEL_ROBOT / GROUP_MSG_RECEIVE / GROUP_MSG_REJECT | ❌ 丢失（无法做入群欢迎/退群清理） | 同上 |
| MESSAGE_REACTION_ADD/REMOVE | ❌ 丢失 | 同上 |
| GUILD_* / CHANNEL_* / AT_MESSAGE_CREATE / DIRECT_MESSAGE_CREATE | ❌ SDK 层就丢弃 | 若要支持频道需改 `deriveReplyTarget` 或走 rawEvent |

### 2.2 中间件管线（顺序即契约）

`middleware.js:195-300 setupMiddlewares()`：
`errorHandler` → 统计 → `messageFilter({skipSelfEcho:false})`（**去重按 messageId，5s 窗口**）→ `accessPolicy` → `historyBuffer`（20 条，按 appId+group 建 key）→ `quoteRef({maxSize:500, preferMsgElements:true})`（:267）→ `mentionGate(passthrough)`（:270）→ `contentSanitizer` → `rateLimiter` → 命令中间件（:283）→ `frequencyGate`（:286）→ `concurrencyGuard(merge)`（:289）→ `typingIndicator`（:296）→ 附件下载（:299）。

- `frequencyGate`（middleware.js:99-177）是**入站**频控，与出站被动/主动限制无关；`gate.decide` 在 `lib/qq/gate.js:104-207`。
- 跳过消息 `ctx.stop('frequency:<reason>')`，不回复但已计入历史。

### 2.3 引用解析（msg_idx / ref_idx）

- `quoteRef`（middleware.js:267，SDK `middleware/quote-ref.js`）用 `msg.msgIdx ?? messageId` 做 key 记录消息摘要，命中 `msg.refMsgIdx` 时写 `ctx.state.quote = {refKey, source:'store'|'msg_elements'|'none', entry, text, attachments, rawContent}`。
- `msgIdx`/`refMsgIdx` 来自 SDK `event-dispatcher.js:8-45 parseRefIndices()`：`message_scene.ext` 的 `msg_idx` / `ref_msg_idx`，以及 `message_type===103` 时 `msg_elements[0].msg_idx`。
- 插件入站使用：`inbound.js:115-120 buildQuotePart()` 输出 `[Quoted message begins]…[Quoted message ends]\n[Current message]`；引用附件单独下载（`attachment.js:274-293`）并在 `buildMediaLines`（inbound.js:63-88）拼 `[引用附件]`。
- 回复机器人判定 `createReplyProbe`（middleware.js:71-92）：`quote.entry.isBot` / `refKey`/`messageId` 命中 `sentTracker` / 文本近似匹配。
  - ⚠️ `sentTracker.record()`（outbound.js:219-233）只记 `result.id`，**没记 `result.ext_info.ref_idx`**；引用「机器人自己消息」时 refKey 往往是 `REFIDX_*`（notes §3.1），只能靠文本兜底 → 判定不稳。
- 出站**不使用** `message_reference`，所以目前不会「引用回复」别人的消息。

### 2.4 媒体入站

`attachment.js`：
- `downloadMediaAttachments`（:215-251）只下 HTTPS、SSRF 白名单、200MB/120s 上限；**语音不下载**。
- `createAttachmentMiddleware`（:261-300）在门控之后执行，写 `ctx.state.downloadedFiles / downloadedQuoteFiles`。
- 语音：优先进程内转写 `state.processedAttachments`，其次 `att.asr_refer_text`，最后 URL（inbound.js:93-112）。`voice_wav_url`、SILK→WAV 未使用（SDK 有 `utils/audio.js`）。
- 图片/视频/文件：`[图片]/Image: <本地路径>`、`[视频]/Video`、`[文件]/File: path (size)`（inbound.js:36-61）。
- **message_type=3（ark 结构化卡片）**：`content` 通常为空、无 attachments → `assembleAgentBody` 返回空串被丢弃（inbound.js:157）。若升级要支持卡片/分享链，需读 `msg.raw.ark_data`。

---

## 3. 会话与状态（升级要复用/改动的地方）

| 组件 | 关键点 | 位置 |
| --- | --- | --- |
| SessionManager | `getOrCreate(scope, peerId, senderId, replyTarget)` 每条消息**覆盖 replyTarget**；`findBySessionId` 供出站反查；`latestReplyTargetForAgent` 供工具 | `session-manager.js:725-745, 836-882` |
| 出站会话反查 | `manager.findBySessionId(sessionId)`（outbound.js:415）→ 多机器人靠各自 handler 隔离 | outbound.js:409-428 |
| adaptive 攒批 | `createAdaptiveScheduler`：批次用**最后一条**消息的 replyTarget 触发（adaptive.js:340-380），批量越大越接近窗口末尾 | `adaptive.js:145+`，交付在 :443-522 |
| pending 快照 | `gateway.botState()` 合并 gate pending + adaptive pending（gateway.js:486-511） | web `/state` |
| 清空待回复 | `gateway.clearPending()` **只清 gateState，不清 adaptive 缓冲**（gateway.js:476-483） | 与 botState 展示不一致，改造时要一并修 |
| 工具发送 | `qqbot_send_file` → `gateway.sender`；多机器人由 `bots/scoped-tools.js:119-131` 注入 | `lib/tools/send-file.js:243+` |
| stats | `{received, triggered, skipped, replies, lastReplyAt, lastTriggerReason}`，出站只 +replies | `runtime.js` 组装，outbound.js:387-391 |

---

## 4. 设置项 / UI 扩展约定（新增一个布尔或枚举要改哪些文件）

**唯一真相链**：`settings-store.js resolveDefaults()` → `normalizeSettings()` → `/settings` patch → `/state.settings` → client 页面。

| # | 文件 | 改什么 | 必改？ |
| --- | --- | --- | --- |
| 1 | `lib/settings-store.js:17-190 resolveDefaults()` | 加默认值（嵌套对象要成组加） | **必须**：`normalizeSettings` 只接受已知字段（文件头注释），未声明字段被丢弃 |
| 2 | `lib/settings-store.js:277-511 normalizeSettings()` | 加分支 + 校验（`bool/int/num/enumStr/text`，越界截断） | **必须**：否则默认值不会回写、类型不受控 |
| 3 | `lib/settings-schema.js:39-122 SETTINGS_SECTIONS` | 仅**新增页面**时加 `{id,label,widget,desc}`（字段级无声明表） | 否（挂到已有页面即可） |
| 4 | `client/client.js` | 页面组件里加 `Switch/ChoiceGroup/NumberField`；`mapped*` 映射 + `patch({...})` 保存 | **必须** |
| 5 | `client/client.js:7697-7730 widgets` | 新页面的 widget id → 组件 | 仅新增页面 |
| 6 | `client/client.js:7533+ VIEW_ALIASES` | 新页面如需旧 id 兼容跳转 | 可选 |
| 7 | `lib/web/routes.js:987-1018 handlePostSettings()` | 无需改（通用 patch）；集合型字段需加入 `DEFAULT_REPLACE_PATHS` | 仅集合型配置 |
| 8 | `lib/web/routes.js:694-770 buildState()` | 想在 `/state` 暴露派生值（如 remaining 被动次数）时加字段 | 可选 |
| 9 | 消费方 | 出站读 `settings.get()`（outbound.js:316-324 现读现用，天然热生效） | **必须接线** |
| 10 | 测试 | `test/settings-store.test.js`（默认值/归一化）、`test/web-routes.test.js`（patch 回读）、`test/settings-schema.test.js:45-70`（**每个 widget 必须在 client.js widgets 表里**，否则测试红） |

**新增 UI 页面的最小改动集（无服务端新路由）**：
`settings-store.js resolveDefaults+normalize` → `settings-schema.js` 加 item → `client.js` 写组件 + 注册 widgets + 保存 patch → 测试。

**UI 组件与写法**（client/client.js，无 JSX，用 `h()`）：
`Card`(:514) / `Switch`(:585) / `ChoiceGroup`(:714) / `NumberField`(:656) / `AreaField`(:636) / `SaveBar`(:564) / `useSaver`(:473) / `useDraft`(:454) / `apiPost`(:208，自动带 botId)。
参考页面：`FrequencyPage`(:1228)、`TriggersPage`(:1453)、`MessageStylePage`(:4955)。
页面获取数据：`props.snapshot.settings`（来自 `GET /state`），`props.reload` 刷新。

---

## 5. 测试约定

- 运行：`npm test`（`node --test test/*.test.js`）；`node` 需在 PATH（本机用 `~/.nvm/versions/node/v22.23.2/bin`）。
- 单测全部用 `node:test` + `node:assert/strict`，`import` 源码（ESM，`package.json type:module`）。
- 共享假件：`test/helpers/fake-ctx.js` —— `createFakeCtx()` 模拟 `ctx.get/set/on/emit/effect/webServer.register/tools.register`（effect 立即执行、dispose 逆序）；`createFakeLogger()` 记录各级日志；`createFakeReqRes()` 造 HTTP。
- 出站测试范式：`test/outbound-final.test.js` 自己搭 rig（假 manager/bot/settings，记录 `sent[]`，`await tick()` 等微任务）。**出站改造一定要在 sendChunk 层加用例**。
- 设置测试：`test/settings-store.test.js`（默认值/越界/坏 JSON/patch 链路）、`test/web-routes.test.js`（handler 成功+错误分支、1MB body、405）、`test/settings-schema.test.js`（schema 完整 + widget 覆盖）。
- 能力/工具：`test/tool-catalog.test.js`、`test/capability-extension.test.js`。
- e2e/探针（手动、不入 npm test）：`test/e2e/settings-screenshots.cjs`、`test/e2e/*-probe.js`，产物落 `test/artifacts/`。
- 当前基线：482 tests / 0 fail（约 0.9s）。

---

## 6. SDK 1.0.5 已具备、但插件未使用的能力（可直接用，避免重造）

| SDK 能力 | 位置 | 对应升级点 |
| --- | --- | --- |
| `ReplyLimiter`（4 次 / 1h，`checkLimit/record`） | `dist/protocol/utils/reply-limiter.js:12-120` | 被动次数上限（§1.2 第一行） |
| `getNextMsgSeq(msgId)` 可自注入 | `dist/protocol/api/messages.js:119-124` | msg_seq 自管 |
| `bot.send({target, msgType, markdown, keyboard, messageReference, extra})` 通用发送 | `dist/QQBot.js:446-470` | 键盘/引用/自定义字段 |
| `openStream` / `StreamSession`（仅 c2c） | `dist/QQBot.js:652`、`dist/streaming.js` | 流式回复 |
| `on('rawEvent')` | `dist/QQBot.js:335-338`；事件枚举 `protocol/gateway/constants.js:57-90` | 好友/主动开关/入退群事件 |
| `acknowledgeInteraction(id, code)`（code 0..5） | `dist/QQBot.js:591` | 互动回调正确回应（现在固定 3） |
| `sendWakeup`（c2c 召回）、`sendTyping`、`recallMessage` | `dist/QQBot.js:540 / 579 / 525` | 召回 / 输入中 / 撤回 |
| `bot.api.get/post`（任意 REST 逃生通道） | `dist/QQBot.js` `get api()` | 素材管理、菜单等未封装接口 |
| `intents` 可配置（默认 FULL_INTENTS） | `protocol/gateway/constants.js:16-21`；插件未传 | 只订阅必要 intent，减事件量 |

---

## 7. 会破坏现有行为 / 高风险的改动点（合并方案时重点标注）

1. **改 `sendChunk` 降级逻辑**（outbound.js:295-313）：现在「任何异常 → 去 msgId 重发」；改成按 err_code 分支后，原先能兜底成功的场景可能变成放弃。必须保留「未知错误仍重试主动」的兜底。
2. **引入被动预算**：超限后转主动会让消息走「主动频控」，且 `stats.replies` 语义、`clearPending` 行为都要同步；另外 **adaptive 批次用的 replyTarget 是最后一条**（adaptive.js:349），预算要按真实触发消息算。
3. **msg_seq 自管**：SDK 现在随机生成（重复概率低但存在）；换成递增后，重连/多 handler 场景必须保证同一 msgId 的计数不串。属协议行为变更。
4. **流式**：会绕过现有「只发 turn 最后一段」策略（outbound.js:281-292、376-392），群聊不支持 → 必须保留非流式分支，否则群回复全挂。
5. **interaction 从 ack code=3 改成 0/真实分发**：若平台/老版本对 code 有校验，可能从「静默成功」变成「报错」；建议先按 `event.type` 分流，未知类型仍回 3。
6. **rawEvent 订阅**：默认 `messageFilter` 的去重只覆盖 message 事件，rawEvent 需自己幂等（同事件可能重复推送）；且不要在 rawEvent 里回消息用 `event_id`（仅 5 类事件支持，notes §12 #6）。
7. **新增设置项**：必须同时进 `resolveDefaults`+`normalizeSettings`，否则被静默丢弃；新增页面必须进 `client.js widgets`，否则 `settings-schema.test.js` 直接红。
8. **multibot**：网关 `registerTools:false`（runtime.js:287-301），工具在 scoped-tools 注册；任何新的全局发送器/队列必须按 bot 实例隔离，不能放模块级单例。
9. **docs**：`DESIGN.md:255-345` 里描述的就是当前实现（出站一节明确写 `sendMarkdown(record.replyTarget)` + 去 msgId 重试），升级后需同步更新 DESIGN 与 README:30。

---

## 8. 待确认（代码无法回答）

- SDK `ReplyLimiter` 的「4 次/1h」是文档口径；群聊实际是「5 次/5min」（notes §10.2、§12 #3 提到文档自相矛盾）——预算参数应可配置。
- `msg_idx`/`ref_msg_idx` 与 `REFIDX_*` 的准确对应关系（notes §3.1 与 SDK quote-ref 实现口径不完全一致），做引用回复前需真实抓包验证。
- `bot.sendMarkdown` 是否需要传 `markdownSupport:true`（插件未传；`sendRaw` 路径其实不依赖该开关，但 `sendText` 会依赖）。
