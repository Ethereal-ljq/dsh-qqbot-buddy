# QQ 机器人 API v2 升级方案（基于 2026-10 官方文档）

> 目标：对照 QQ 开放平台 v2 消息能力，找出 dsh-qqbot-buddy（v0.20.2）可落地的改造点，按 ROI 分阶段给出文件级方案。
> 依据：官方文档 20 个页面（结论与字段引自 `docs/qq-api-v2-capability-notes.md`，每条带来源 URL）；
> 代码现状以当前仓库 `lib/`、`client/` 为准。

## 0. 结论（TL;DR）

- 插件文本发送实质只有**一种方式**：`bot.sendMarkdown(target, chunk)`（msg_type=2），失败去掉 msg_id 主动兜底；
  但直调点有 3 处（outbound / commands / inbound 兜底），被动回复次数、msg_seq、错误码一律没分类。
- 官方 v2 已有、插件**完全没用**的能力：流式单聊、引用回复（发送侧）、图文卡片、内嵌键盘/互动回调、
  `FRIEND_ADD`/`GROUP_ADD_ROBOT` 事件回复、撤回、`is_wakeup` 召回、@全体成员、自定义菜单/指令面板、素材库。
  （**输入中状态已具备**：`middleware.js:296` 已接入 SDK `typingIndicator()`，仅 c2c、60s/50s 保活，见 §3.1。）
- 最值得先做（收益/风险比）：
  1. **P0 被动回复预算 + 错误码分类**：单聊 4 次 / 群聊 5 次额度用满后不再白撞 40034128；主动消息加频控。
  2. **P1 引用回复 + 入群/加好友欢迎 + INTERACTION_CREATE 正确响应 + 卡片入站解析**：改动小、体感强
     （输入中状态已由 SDK 中间件提供，见 §3.1）。
  3. **P2 图文卡片 / 内嵌键盘 / 撤回 / 主动消息治理**：把插件已有命令与知识库能力"露出"。
  4. **P3 C2C 流式回复**：DSH 有 `agent/assistant-stream`，SDK 有 `openStream()`，技术上已通；风险在于拆分/降级，
     建议默认关闭灰度。
- **不建议做**：ARK 消息（平台不开放发送）、群聊流式（官方明确不支持）、把主动消息当推送系统（20 qpm/关系、1000 条/天/关系，
  且用户可关闭）、频道（插件定位不含频道）。

## 1. 官方能力 × 插件现状对照

| 能力 | 单聊 | 群聊 | 插件现状 | 结论 |
|---|---|---|---|---|
| 纯文本 msg_type=0 | ✅ | ✅ | 仅作降级路径（当前无降级） | 需要时补 |
| Markdown msg_type=2 | ✅ 免申请 | ✅ 免申请 | **唯一发送格式** | 已用；需权限/格式降级 |
| 富媒体 msg_type=7 | ✅ | ✅ | `qqbot_send_file` / 表情包已用 | 已用 |
| 图文卡片 msg_type=8（2026-10-28 新增） | ✅ | ✅ | ❌ | 建议 P2 |
| 内嵌键盘 keyboard | ✅ | ✅ | ❌（互动回调只盲 ack） | 建议 P2 |
| 输入中状态 msg_type=6 | ✅ | ❌ | ✅ SDK `typingIndicator()`（middleware.js:296） | 已用，仅需可选配置化 |
| 流式 stream_messages | ✅ | ❌ | ❌ | 建议 P3 |
| 引用回复 message_reference | ✅ | ✅ | 入站能解析引用，**发送不引用** | 建议 P1 |
| 被动回复 msg_id / event_id | 60min·4 次（字段说明写 5min，文档矛盾） | 5min·5 次 | 只传 msg_id，无次数预算；event_id 未用 | P0 修 |
| msg_seq 去重 | ✅ | ✅ | SDK 随机生成，够用；但重试会撞 40054005 | P0 修 |
| 互动召回 is_wakeup | ✅ | ❌ | ❌ | P2/P3 可选 |
| 撤回（2 分钟内） | ✅ | ✅ | ❌（sentTracker 已存 id） | P2 |
| 加好友 / 入群事件（event_id 回复） | FRIEND_ADD | GROUP_ADD_ROBOT | ❌ 无 rawEvent 监听 | P1 |
| 互动事件（按钮/反馈/清空会话/授权） | INTERACTION_CREATE | 同 | 统一 ack code=3（含义是"重复操作"） | P1 修 |
| @全体成员 | ✅ 需管理员 | ✅ 需管理员 | ❌ | 可选 |
| 自定义菜单 / 指令面板 | 2026-08-12 新增 | 同 | ❌（只有 / 命令） | P3 |
| 素材库 qqbot-media:// | ✅ | ✅ | ❌（发图走 msg_type=7） | P3 |

> 代码级落点（文件:行、SDK 现成能力、破坏性变更清单）见 `docs/qq-plugin-change-map.md`（code-auditor 产出）。

## 2. P0：先把"发得出去/发得对"修好（0.5–1 天）

### 2.1 被动回复预算 + msg_seq

官方规则（S1/S2/S4）：
- 单聊：被动回复窗口文档自相矛盾（页首 60 分钟，`msg_id` 字段说明 5 分钟；概述页 60 分钟）。
  保守按 **5 分钟**实现，窗口值做常量可配；真机再校准。
- 群聊：**5 分钟 / 每条消息最多 5 次**。
- 同一 `msg_id + msg_seq` 重复发送必失败（40054005）；`msg_seq` 需递增（SDK 用"时间戳⊕随机数 mod 65536"，基本安全，
  但**重试同一条内容时不要复用同一 seq**）。
- 被动额度用尽 → 40034128；主动失败 → 40034100/40034105/40054013。

现状（`lib/qq/outbound.js` `sendChunk()`）：
- 每个 chunk 都"先被动、失败再主动"，不记录该 msgId 已用次数；
- `splitSegments()` 按 `[[msg]]` 拆条**不设上限**，`chunkMarkdownText()` 还会按 `textChunkLimit`（默认 4500）再拆；
  单聊超过 4 条、群聊超过 5 条时，多出来的每条都要先失败一次 40034128 再降级；
- 降级条件不区分错误码：内容违规(40034006)、被去重(40054005)、机器人被禁言(40054002)、用户拒收(40054013) 也会再发一次主动消息。

改法：
1. **优先复用 SDK 现成的 `ReplyLimiter`**（`node_modules/@tencent-connect/qqbot-nodejs/dist/protocol/utils/reply-limiter.js`，
   自带 `checkLimit/record`、TTL、上限淘汰；注意 SDK **没有**把它接进 `QQBot`，要自己 new 一个按 bot 实例持有）。
   参数：`c2c: { limit: 4, ttlMs: 60*60_000（保守可用 5min）}`、`group: { limit: 5, ttlMs: 5*60_000 }`，可被 settings 覆盖。
2. `outbound.js` 增加 `replyBudget`（每 bot 一个 `ReplyLimiter`）：
   - 被动发送前：窗口过期或 `used >= maxReplies` → 直接走主动，不再白发一次；
   - 成功 +1；同一 turn 内多条共用同一 record。
3. 失败分类 `classifySendError(err)`（SDK `ApiError.bizCode`，别用 message 文案）：
   | 类别 | 错误码 | 处置 |
   |---|---|---|
   | 窗口/次数 | 304103、40034005、40034024、40034128、40034026 | 降级主动（并标记窗口失效） |
   | 格式/权限 | 40034127、304036、40034011、40034124 | 改纯文本 msg_type=0 重发一次 |
   | 去重 | 40054005 | 换 msg_seq 重试一次（不要无限重试） |
   | 频控 | 40034100、50002 | 入主动队列退避 |
   | 永久失败 | 40034006、40034027、40054013、40054002、40054003、40034101 | 记日志 + 统计，放弃 |
4. 主动兜底加**令牌桶/队列**：单关系 20/qpm、Bot 10 qps（未认证 5 qps+30 qpm）、单用户/群 1000 条/天；
   超限排队（上限 N 条，超出丢弃并计数），不要瞬时打满。
5. **统一发送入口**：现在文本发送有 3 处直调 `sendMarkdown`（`outbound.js:295-313`、命令回复 `commands.js:319-329`、
   入站兜底 `inbound.js:26-33`），预算/降级/频控只改 outbound 会漏掉命令与错误提示。建议抽 `lib/qq/sender.js`：
   `sendText/sendMarkdownQq(target, text, {priority})`，三处都改走它（媒体路径 `gateway.js:147-165` 共用同一主动队列）。
6. 注意 **adaptive 攒批用的是"最后一条消息"的 replyTarget**（`adaptive.js:340-380`），预算要按真实触发消息算，
   否则同一 msgId 上会在窗口末尾连发多条。
7. 测试：`test/outbound-final.test.js` 扩展 fake bot，注入 40034128/40034005/40034127/40054005，断言：
   - 第 5 条（单聊）不再发被动；
   - markdown 权限错误会改纯文本；
   - 40034006 不会触发主动重发。

### 2.2 Markdown 降级

背景：官方 2026/04/23 起单聊/群聊**自定义 Markdown 对全部机器人开放**（无需模板）。但存量机器人/平台灰度仍可能报
40034127 / 304036；且 markdown 与 `content`/`ark` 互斥（同时传 22006/40034124）。

改法：
- `sendChunk()` 在 markdown 类错误时用 `bot.sendText(target, plain)`（msg_type=0）重发一次；
- bot 级缓存 `markdownUsable=false`（每 bot 独立，重连不清零或按 1h 过期），后续直接走纯文本，避免每轮都失败一次；
- `botState()`（`lib/qq/gateway.js`）增加 `markdown: 'ok'|'degraded'`，设置页概览显示。

### 2.3 入站去重（扩窗，而非新增）

官方：同一 `msg_id` 可能重复推送（重连补发），需本地去重，否则重复触发 agent 和回复。

现状：SDK `messageFilter()` 已按 `messageId` 去重，但默认窗口只有 **5 秒 / 1000 条**（SDK
`middleware/message-filter.js:19-24`）；插件调用时只传了 `{ skipSelfEcho: false }`（`middleware.js:229`），
重连补发（往往 >5s）仍可能重复触发。

改法：`setupMiddlewares` 里改成 `messageFilter({ skipSelfEcho: false, dedup: { windowMs: 10*60_000, maxSize: 2000 } })`；
配套统计 `stats.dedup`。无需自研新中间件。

### 2.4 发送可观测性

- `stats` 增加 `sentByCode` / `sendFailures`（最近 N 条：时间、scope、code、msgId）；
- 设置页概览"最近发送失败"列表，替代现在只写 warn 日志。

## 3. P1：体感与正确性（1–2 天）

### 3.1 输入中状态（已具备，仅可选配置化）

结论：**不需要新增**。`middleware.js:296` 已经 `bot.use(typingIndicator())`（SDK
`middleware/typing-indicator.js`）：仅 c2c、`durationSec=60`、每 50s 保活、失败只 debug 日志；
且位于频率门控之后，只有真正会回复的消息才触发，语义正确。

可选小改（低优先）：把 `predicate/durationSec/keepAliveIntervalMs` 从 settings 传入，支持"关闭"或"缩短保活"，
例如 `typingIndicator({ predicate: (ctx) => settings.get().reply.typing !== false })`。

### 3.2 引用回复（message_reference）

- 入站已具备：SDK event-dispatcher 解析了 `msg.msgIdx` / `msg.refMsgIdx`（`message_scene.ext` 与 `msg_elements`），
  插件 `quoteRef({ preferMsgElements: true })` 也解析了引用，但**发送侧从未使用**。
- 改法：
  - `inbound.js` 组装 `replyTarget` 时附带 `refIdx`：
    回复"当前消息" → `msg.msgIdx`；回复"被引用的消息" → `msg.refMsgIdx`；
  - `outbound.js` 用 `bot.send({ target, msgType: 2, markdown: { content }, messageReference: { message_id: refIdx } })`
    发首条；无 refIdx 或开关关闭时沿用 `sendMarkdown`；
  - 机器人自己发过的消息的引用要用**响应里的 `ext_info.ref_idx`**：SDK 已暴露 `bot.messageApi.onMessageSent(cb)`，
    在 `createSentTracker` 里同时记录 `refIdx → id/text`，既支持引用回复也提升 `replyProbe` 准确度
    （现在靠文本包含匹配，README 已列为已知限制）。
- 设置：不设全局开关；由模型按需调用 `qqbot_quote_reply` 工具（catalog 能力 `quote`，默认开启）决定是否引用。
- 注意：引用回复与 markdown 可同发（`sendMarkdown` 也支持 opts.keyboard，但 messageReference 建议走 `bot.send`）。

### 3.3 事件回复：加好友 / 入群 / 互动回调

现状：`gateway.js` 只注册了 `message`、`interaction`、`error`、`ready/resumed/disconnected`；
SDK 的 `rawEvent`（`FRIEND_ADD`、`GROUP_ADD_ROBOT`、`C2C_MSG_RECEIVE`、`GROUP_MSG_RECEIVE` 等）**未监听**，
加好友/入群后机器人完全沉默。

改法：
- `instance.on('rawEvent', ...)`：
  - `FRIEND_ADD` / `GROUP_ADD_ROBOT`：发欢迎语。**注意：SDK 1.0.5 的 rawEvent 只透传事件体 `d`，
    不透传 WS 包外层 `id`，而 FRIEND_ADD/GROUP_ADD_ROBOT 的 `d` 里没有 id，因此拿不到 `event_id`，
    只能用 `sendProactive`（受主动消息频控/用户开关限制）**；若未来 SDK 传递外层 id，再切回 event_id 被动回复。
  - `C2C_MSG_RECEIVE` / `GROUP_MSG_RECEIVE`：记录"用户/群已允许主动消息"状态（用于主动兜底决策）。
- 欢迎语复用 persona/prompt 或新增 `welcome` 设置段（每人/每群只发一次：state 文件记录 openid，LRU 落盘）。
- 风险：event_id 只能用于文档列出的 5 类事件（40034027），不要对普通消息事件用 event_id。

### 3.4 INTERACTION_CREATE 正确响应

现状（`gateway.js`）：`instance.on('interaction')` 对所有事件、无条件
`acknowledgeInteraction(event.id, 3)`。code=3 的语义是"重复操作"（USAGE.md §12），
对按钮点击应回 0；对 type 13/14/16/18 等**本不需要 PUT 的事件**发请求是浪费且容易报错。

改法（按 `event.type` 分流）：
- `11`（消息按钮）/ `12`（快捷菜单）：**3 秒内** `ack(0)`，再把 `data.resolved.button_data/button_id`
  作为一条用户消息喂给 agent（来源标记 `[按钮] <data>`），复用命令解析（`lib/qq/commands.js`）优先；
- `13` 消息反馈：记录 `feedback_opt`（LIKE/UNLIKE）到 stats/知识库，无需 PUT；
- `14` 清空会话：调 `manager.reset(scope, peerId)`（对应插件 /new 语义），无需 PUT；
- `16` 切换模型 / `15` 故事集：仅记日志，无需 PUT；
- `18/19/20` 授权：记录 `authorize_data.scope`（`c2c_push`/`group_push`）→ 允许主动消息，无需 PUT。
- 另：`interaction_id` 不要带事件名前缀。

### 3.5 结构化卡片入站解析

官方 `C2C_MESSAGE_CREATE` / 群消息支持 `message_type` = 0/3/101/102/103：
- 3=ARK 卡片（`ark_data`：`ark_type`、`fields.title/desc/jump_url/preview/source`…）
- 103=引用消息（`msg_elements`、`ref_msg_idx`）

现状：`inbound.js` 只用 `msg.content`，分享的小程序/链接/图片卡片会退化成"[卡片消息] 小程序 摘要…"，
URL 丢失，模型无法跟进。

改法：`assembleAgentBody()` 增加 `buildCardLines(msg.ark_data)`：
`title / desc / source / jump_url / preview` 拼成"卡片: 标题｜来源｜链接"，附件同理；
`message_type=103` 优先用 `msg_elements` 文本（SDK quoteRef 已解析，但只用于引用块）。
价值：群聊大量分享卡片，这是"看懂群聊"的关键补全。

## 4. P2：把已有能力"露出"（2–3 天）

### 4.1 图文卡片 msg_type=8（2026-10-28 新增）

- 约束：`type='tuwen'`；`title` 1–50 字、`description` 1–200 字、`url`/`pic_url` 必须 https、≤1024 字符。
- 场景：回复里出现"推荐链接/知识库条目/搜索结果"时，发一张卡片比裸 URL 好得多。
- 实现：新工具 `qqbot_send_card`（`lib/tools/send-card.js` + `lib/tools/catalog.js` 注册 + 工具白名单），
  schema：`{title, description, url, pic_url?}`；URL 校验失败回退普通文本。
- 不建议在 outbound 里自动判定 URL 转卡片（误伤/审核风险），让模型显式调用。

### 4.2 内嵌键盘 / 消息按钮

- 约束：≤5 行 × 5 按钮；`label` ≤10 字；`action.type=2`（指令按钮）最稳，`enter/reply/anchor` 仅单聊、客户端 ≥8983；
  `type=1`（回调）必须 3 秒内 PUT，否则客户端一直 loading。
- 场景：把 `/new /reset /help /status`、"继续/换个话题/更多细节"做成按钮；配合 3.4 的 interaction 分流。
- 实现：`outbound.js` 增加 `keyboardFor(record, text)`（按 settings 配置固定 1 行常用按钮）；命令回复（`commands.js`）也带键盘；
  报 304037/305007/40034029 时去掉 keyboard 重发。
- 风险：按钮权限口径新旧文档不一（旧文档说内邀，FAQ 2026 说已全量开放）；feature flag 默认关，探测失败自动关。

### 4.3 撤回

- 约束：机器人只能撤回自己发的、发送 2 分钟内；SDK `bot.recallMessage(target, id)`。
- `createSentTracker` 已记录消息 id，补 `{id, at, text}`；用途：
  - 管理员命令 `/recall`：撤回机器人最近 N 条（默认 1，上限 5）；
  - 出站失败/中断场景：先发提示再撤回半成品（可选）。
- 设置：`reply.recall`（默认关）。

### 4.4 主动消息治理 + is_wakeup 召回

- 主动兜底必须遵守：单聊 20 qpm/关系、1000 条/天/关系、Bot 维度 10 qps；群聊 20 qpm/群；
  用户可在客户端关闭"允许主动发送"（40054013 / 40034105）。
- 改法：2.1 的主动队列 + 3.3 的 C2C_MSG_RECEIVE/授权状态；40054013 后标记该 peer "拒收"，本次进程内不再主动；
- 可选"沉默召回"：用户 1–30 天未互动时按 4 个周期（当天/1–3 天/3–7 天/7–30 天）各发 1 条 `is_wakeup`，
  需要持久化每用户周期状态；**默认关闭**，属运营行为，先别默认开。

## 5. P3：大功能（2–3 天，需真机验证）

### 5.1 C2C 流式回复（stream_messages）

可行性已确认：
- DSH 有 `agent/assistant-stream`（start/chunk/end 帧，chunk 带 `StreamChunk`），以及 `llm/stream` waterfall；
- 入站 `replyTarget.msgId` 即被动凭证；SDK 有 `bot.openStream({ target, throttleMs })`，
  `update(fullText)` 传全文（replace 语义）、`complete()` 发 DONE；
- 限制：仅单聊、节流 ≥300ms（SDK 默认 500ms）、msg_id 5 分钟内、前缀不可改（40007）、50 QPS、`remain_msg_len` 控长。

设计（新 `lib/qq/streaming.js`）：
1. `gateway.js` 根 `ctx.on('agent/assistant-stream')`：`payload.agent.session.header.id` → `manager.findBySessionId()` → record；
2. 仅当：`scope==='c2c'`、`settings.reply.streaming` 开、record 有 `replyTarget.msgId`、窗口未过期；
3. `start` 帧：无需再发 typing（已有中间件负责）；`chunk` 帧累积文本，按 throttle `update(accumulated)`（转换 emoji 后再送）；
4. `end`（committed）：`complete()`，把最终文本记到 `record.streamed = { text, at }`；
5. `outbound.turn/end`：若 `record.streamed.text` 与待发文本一致，**跳过普通发送**（避免重复）；
6. 降级：任何流式错误 → `cancel()` + 清除 streamed → 走普通 outbound（保证最终内容必达）；
7. 冲突：`[[msg]]` 或空行拆分命中时禁用流式（多气泡无法"原地改写"）；长度超 `remain_msg_len` 时截断，
   最终若被截断再补一条普通消息（或只用流式展示前 N 字）。
- 设置：`reply.streaming`（c2c，默认 false，灰度）；
- 测试：fake stream 断言节流、DONE、去重；真机验证"取消后客户端是否残留半截内容"。

### 5.2 自定义菜单 / 指令面板

- 2026-08-12 新增 `/v2/menu` 与指令面板 API；插件已有 `/help /new /reset /clear /status /stop /id`。
- 价值：用户不用记命令，单聊快捷菜单/群指令面板直接露出；与 3.4 的 type=12 回调联动。
- 实现：启动后（有凭据时）调 `bot.api.post` 注册；设置页加"发布到 QQ 菜单"按钮；失败仅日志。
- 注意：本次未抓取该接口字段，落地前需补文档（`docs/qq-api-v2-capability-notes.md` §14 已列为待确认）。

### 5.3 素材库 + Markdown 内嵌图片

- 能力：图片上传平台得 `qqbot-media://` 引用，可直接插进 markdown；90 天滑动过期、100 张上限、不可跨 bot。
- 场景：把表情包/配图内嵌进正文（而不是单独一条 `msg_type=7`），回复更像"一条完整消息"。
- 实现：素材缓存模块（file hash → media ref + 过期时间）+ `lib/tools/send-file.js` 走素材路径 + 清理任务；
  优先级低于流式。

### 5.4 群管理/审核（可选，超出当前定位）

- 2026-09 新增群成员列表/黑名单/禁言/入群审批 API；可做管理员命令（/mute /kick /approve），
  但涉及权限与误伤风险，建议单独立项，不进本次升级。

## 6. 设置与 UI 改动清单

新增设置（`lib/settings-store.js` `resolveDefaults()` + `normalizeSettings()`，并在 `lib/settings-schema.js` 增条目）：
```js
reply: {
  typing: true,               // 单聊输入中状态（已具备，开关可选）
  streaming: false,           // C2C 流式
  recallEnabled: false,       // /recall 命令
},
features: {
  card: true,                 // qqbot_send_card 工具
  keyboard: false,            // 内嵌键盘
},
welcome: {
  friendEnabled: false,       // FRIEND_ADD 欢迎语
  groupEnabled: false,        // GROUP_ADD_ROBOT 欢迎语
  friendText: '',
  groupText: '',
},
```
- `lib/web/routes.js`：仅新增"菜单发布/素材清理"动作时加 POST（复用 `/action` 也可）；设置仍走 `POST /settings`。
- `client/client.js`：按现有 section 结构加开关/下拉（对话页加"引用/流式/撤回"，能力页加"卡片/键盘"）。
- `test/settings-schema.test.js` 同步默认值与归一化测试。

## 7. 兼容性与回滚

- 所有新能力都可**按开关关闭**；除 `typing`（已具备，默认开）外建议默认关（尤其 streaming/keyboard/welcome）。
- 运行时热生效：`settings.get()` 每轮读取，改设置无需重启。
- 多机器人：能力/配额/openid 按 bot 隔离；`markdownUsable`、主动队列、素材缓存都必须挂在 bot 级，不能做成全局。
- 数据：除 is_wakeup 周期状态（新文件，可缺省）外无 schema 迁移；settings 未知字段会被丢弃，旧版本回滚安全。
- 依赖：现有 `@tencent-connect/qqbot-nodejs@1.0.5` 已包含 streaming / interaction / rawEvent / sendTyping / recall / sendWakeup，
  **无需升级 SDK**；`qqbot-connector@1.2.0` 与本方案无关（可后续评估移除）。

## 8. 建议落地顺序

| 阶段 | 内容 | 预估 | 风险 |
|---|---|---|---|
| P0 | 2.1 被动预算+错误码、2.2 markdown 降级、2.3 入站去重、2.4 观测 | 0.5–1 天 | 低 |
| P1 | 3.2 引用回复、3.3 事件回复、3.4 interaction 分流、3.5 卡片解析（3.1 输入中已具备） | 1–2 天 | 低–中 |
| P2 | 4.1 图文卡片、4.2 键盘、4.3 撤回、4.4 主动治理 | 2–3 天 | 中 |
| P3 | 5.1 流式（灰度）、5.2 自定义菜单、5.3 素材库 | 2–3 天 + 真机 | 中–高 |

每个阶段独立可发布；P0/P1 建议先做，能直接减少线上发送失败与"机器人沉默"类投诉。

## 9. 实施状态（v0.21.0，2026-10-31）

已落地（`npm test` 566 pass / 0 fail；仅新增 docs 与 lib/qq 相关实现，未动 DSH 宿主）：

| 计划项 | 状态 | 落点 |
|---|---|---|
| P0 被动回复预算 | ✅ | `lib/qq/sender.js`（SDK `ReplyLimiter`，单聊 4 次/群聊 5 次，跨重连保留） |
| P0 错误码分类 | ✅ | `lib/qq/error-codes.js` + sender（窗口/格式/去重/频控/瞬时/永久） |
| P0 markdown 降级 | ✅ | sender（权限类标记 bot 降级；引用被拒也会去引用重试） |
| P0 入站去重扩窗 | ✅ | `middleware.js` messageFilter 5s → 10min |
| P0 统一发送入口 | ✅ | outbound / commands / inbound 兜底均走 sender；主动消息 20/min + 1000/天 + Bot 10/s |
| P1 引用回复 | ✅（模型自选） | `qqbot_quote_reply` 工具设置 `record.quoteNext`；outbound 首条带 `message_reference`；入站 refIdx + sentTracker 记 `ext_info.ref_idx` |
| P1 rawEvent 欢迎语 | ✅（主动消息版） | `lib/qq/events.js`；受 SDK 不透传事件外层 id 限制，见 §3.3 |
| P1 INTERACTION 分流 | ✅ | `lib/qq/interaction.js`（11/12 ack 0 + 投喂、13 统计、14 重置、其余不 ack） |
| P1 卡片入站解析 | ✅ | `inbound.js` `[卡片] 标题｜来源｜摘要｜链接` |
| P1 输入中状态 | ✅（原已具备） | SDK `typingIndicator()`（`middleware.js`） |
| P2 图文卡片 | ✅（v0.21.0） | `lib/tools/send-card.js` + `qqbot_send_card`；catalog 新增 `card` 能力（默认开），卡片失败自动降级纯文本 |
| P2 键盘 / 撤回 | ⏳ 待做 | 建议下一轮；需要按钮回调联动与 `/recall` 命令 |
| P3 流式 / 自定义菜单 / 素材库 | ⏳ 待做 | 流式需真机灰度（仅单聊） |

新增设置项（已进 `settings-store.js` + 设置页「回复策略」）：
`reply.proactiveFallback`（默认 true）、
`welcome.{friendEnabled,groupEnabled,friendText,groupText}`（默认关闭、文案空=内置），
`interaction.{feedToAgent,resetOnClearSession}`（默认 true，暂未做 UI 开关）。

## 10. 待确认

1. 单聊被动窗口到底 60 分钟还是 5 分钟（官方文档自相矛盾）→ 真机抓 40034005 时间点确认。
2. 消息按钮权限现状（旧文档"内邀" vs FAQ 2026"全量开放"）→ 发一条探测消息看 304037/40034029。
3. 流式消息被 `cancel`/超时后客户端是否残留半截内容 → 真机验证后再灰度。
4. 群聊是否需要在开放平台勾选"Markdown 消息"权限（文档说免申请，但平台侧可能有开关）。
5. 自定义菜单 `/v2/menu` 与指令面板接口字段 → 需补抓文档。
6. SDK `ReplyLimiter` 默认 4 次/1h，与群聊"5 次/5min"口径不一致；实际 TTL 以真机为准（先按 scope 分别配置）。
7. `markdownSupport: true` 是否要传给 `new QQBot()`：插件没传，但走的是显式 `sendMarkdown`/`sendRaw`，不依赖该开关；
   若未来改用 `sendText`（自动选 msg_type）则必须传，否则会退回纯文本。
