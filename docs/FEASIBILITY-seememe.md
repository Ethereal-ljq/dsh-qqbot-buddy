# 可行性评估：把 astrbot_plugin_fatfish_seememe 移植到 dsh-qqbot-buddy

- 上游：https://github.com/Vegra85/astrbot_plugin_fatfish_seememe （AstrBot ≥4.29，MIT，v0.4.1）
- 目标：dsh-qqbot-buddy v2（DSH/QQ 官方机器人插件，Node ESM + cordis）
- 结论：**核心可行，但须显式接受 3 项产品降级。** 纯算法层（谐音、查梗、看图提示词、注入格式）可近乎无损迁移；与 QQ 消息结构绑定的部分（取图、转发、历史回捞）受 QQ 官方 Bot API 限制必须重做。
- 工作量估算（**已按复核修正**）：核心可用版本 **8~11 个工作日**；完整对齐原版 **15~22 个工作日**。
- 版本：v2，已根据**三轮独立复核**修正 **14 处勘误**（其中 3 处为致命级：注入落点、投递双路径、注入语义）。逐条见 §8。

---

## 1. 上游插件在做什么

它在"机器人要回话的那一轮"抢在对话模型之前，把图先交给视觉模型看懂，按 **字 / 画面 / 梗 / 跟你 / 坑** 五项写成一段，再注入本轮请求。核心不是图生图，而是一次 **LLM 请求前的上下文注入**。

上游实际注册 **3 个钩子**（不是初版说的 1 个）：

| 钩子 | 位置 | 作用 |
|---|---|---|
| `on_message` | `main.py:657` | 记录群历史、表情包计数 |
| `on_llm_request`(priority=50) | `main.py:948` | **主注入** |
| `on_llm_request`(LATE_PRIORITY) | `main.py:938` | 最后一步做防伪造 |

| 模块 | 文件 | LOC | 可搬性 |
|---|---|---|---|
| 看图提示词 + 结果解析 + 注入文本 | `seer.py` | 972 | ★★★ 纯文本逻辑，几乎照搬 |
| 谐音匹配（字面 + 读音 + 近音） | `puns.py` | 534 | ★★★ 纯算法，需换拼音数据源 |
| 查梗 cnmeme.wiki + 缓存 + 防注入 | `memes.py` | 882 | ★★★ 纯网络/文本逻辑，照搬 |
| 插件主流程、取图、配额、面板 | `main.py` | 2031 | ★ 深度绑定 AstrBot/OneBot |
| 配置项 | `_conf_schema.json` | 37 项 | ★★ 可映射到本仓库 settings |

**关键观察**：三个可搬模块合计 **103,605 字节**源码（seer 42,534 / puns 19,840 / memes 41,231），import 层**零 AstrBot 依赖**（上游 `requirements.txt` 仅一行 `pypinyin`，且 `puns.py:178-200` 有未装时的降级分支）。

其中可迁移的**提示词文本约 4KB**（`build_prompt` ≈1.5KB + `deep_rules` ≈1.3KB + 其余），谐音**词表约 3KB**。

> ⚠️ 两处修正：初版称"约 10KB 提示词"，AST 实测约 **4KB 提示词 + 3KB 词表**（初版高估约 2.5 倍）；但初版又忽略了"约 100KB 源码"这一事实，两个错误方向相反、恰好抵消了对工作量的误导，故工期结论不受此项影响。

> ⚠️ **可搬性要拆开看**：`memes.py` 并非全可搬——`:311-348` 实现了 AstrBot 网页搜索耦合（`WEB_TOOLS` 9 个内置工具名、`WEB_KEYS`、`web_status` 读 `provider_settings`）。应拆为：**cnmeme 路 ★★★ 可搬 / 网页搜索路 ★ 直接砍**（上游 `meme_search` 默认已关）。

---

## 2. 目标侧现有能力（本仓库已具备大半底座）

| 上游需求 | dsh-qqbot-buddy v2 现状 | 位置 |
|---|---|---|
| 多模态旁路调用 | **已有** `createOneShot().generate({prompt, images})` | [lib/host/llm.js](../lib/host/llm.js) |
| 图片 → DSH 附件 | **已有** `saveImage` + `ImageAttachmentRef` | `ctx.get('attachments')` |
| 视觉工具 | **已有** `qqbot_describe_image`（含 SSRF 白名单） | [lib/tools/vision.js](../lib/tools/vision.js) |
| 每轮正文组装（注入落点） | **已有** `assembleAgentBody()` | [lib/qq/inbound.js:222](../lib/qq/inbound.js#L222) |
| 群历史缓冲 | **已有** `historyBuffer` 中间件 | [lib/qq/middleware.js](../lib/qq/middleware.js) |
| 引用消息解析 | **已有** `quoteRef` → `state.quote` | SDK 中间件 |
| 表情包存档 | **已有** `stickers` store + 控制台页 | [lib/core/stickers/store.js](../lib/core/stickers/store.js) |
| 设置项表单 | **已有** schema 驱动（**仅表单**） | [lib/core/config/schema.js](../lib/core/config/schema.js) |
| 控制台面板/统计页 | **需手写**（非 schema 生成） | 参照 `console/api/stickers.js` + `web/src/pages/StickersPage.tsx` |
| 测试基建 | **已有** `node --test`，437 项全绿 | `test/` |

> 🔴 **初版注入点是错的，已修正。** 初版建议在 `inbound.js:311` 与 `:392` 之间插入注入——**这会污染长期记忆**。
>
> 原因：`inbound.js:347` 有 `appendTranscript(record, '用户: ' + body)`，它在 body 组装**之后**执行，把 body **当作"用户原话"**写入转录缓冲，最终交给记忆提炼（`core/memory/collect.js:148`）。若在 311 之后注入，看图结果会被当成用户自己说的话存进长期记忆。
>
> **正确落点**：必须放进 `assembleAgentBody()` **内部**（`inbound.js:222-277`），在返回前拼接。这样注入内容只进本轮 prompt、不进转录。

### 2.0 架构级差异：上游是「结构化分段」，DSH 是「单字符串」

这是移植中**最本质的差异**，初版完全没意识到。

上游注入靠的是 AstrBot 的 **`req.extra_user_content_parts`**——一个 `TextPart` **列表**（`main.py:1159` 追加"看到了什么"、`:1168` 追加"这一轮的图"、`:1467` 追加"查到的梗"）。其中 `_part(text, temp=lambda: TextPart(text).mark_as_temp())`（`main.py:145-149`）用 `mark_as_temp()` 实现**"只给这一轮看、不写进聊天记录"**——这是框架原生语义，插件不用自己管。

DSH 侧 `assembleAgentBody`（`inbound.js:276`）返回的是**一整串纯文本**，没有分段结构，也没有 temp 语义。因此：

- 上游"两段注入、一段常驻一段临时"**必须自行实现**；
- "只给本轮"的保证**从框架语义降级为拼接位置约定**——只要位置放对（在 `appendTranscript` 之前、且不入转录），效果等价，但更脆弱，需测试守护。

**两档语义的具体分工**（这是上游的设计核心，初版完全没建模）：

| 段落 | 上游 | temp | 语义 | DSH 侧需要 |
|---|---|---|---|---|
| 看到了什么 | `main.py:1159` | `False` | **常驻**，记进聊天记录，以后聊起这张图还记得（`seer.py:251` 有意如此） | 需写入会话历史，不能只拼进 body |
| 这一轮的图 | `main.py:1168` | `True` | 只给本轮：梗点、是否在说你、有没有坑 | 只拼 body，不入历史 |
| 查到的梗 | `main.py:1467` | `True` | 只给本轮 | 只拼 body，不入历史 |

**跨轮去重**：上游在 `main.py:1004-1008` 维护"哪些图本轮已处理"，避免同一张图重复注入。DSH 侧没有等价物，需自建。

> 由于 DSH 是单字符串，**"常驻 vs 临时"无法靠拼接实现**——常驻段必须真正写进会话历史（或按对话+发图人分存后每轮按需回放），这是比"拼个字符串"重得多的实现工作。

> ⚠️ 修正：初版说"比 AstrBot 改 `req.prompt` 的写法更干净"是**错的**。上游从没改 `req.prompt`——它用 `extra_user_content_parts` 追加结构化段，只在防伪造时**读取改写** `req.prompt`/`req.system_prompt`（`main.py:916-920`）。准确说法是：**两边都得自己拼，但 DSH 少了 temp 语义这层保护**。

### 2.1 必须同时覆盖两条投递路径

默认配置 `reply.mode = 'adaptive'`（[schema.js:38](../lib/core/config/schema.js#L38)），此时消息**不走** `inbound.js`，而是由 [adaptive.js:362](../lib/qq/adaptive.js#L362) 调用 `assembleBody`（默认值即 `assembleAgentBody`，`adaptive.js:169`）后经 `:390` 的 `deliverInbound` 投递。

**只改 `inbound.js` 会让注入在默认模式下完全失效。** 幸运的是两处共用同一组装函数，只要把逻辑写在 `assembleAgentBody` 内部即可天然覆盖两条路径——但注意 `adaptive` 调用时**未传 `message` 之外的部分上下文**，需确认 `lastState` 里图相关字段可用。

---

## 3. 逐能力判定

| 能力 | 判定 | 说明与改法 |
|---|---|---|
| 看图五要素（字/画面/梗/跟你/坑） | ✅ 直接搬 | 提示词模板原样迁成 JS 常量 |
| 「看到了什么」+「这一轮的图」两段注入 | ✅ 直接搬 | 接到 `assembleAgentBody` 输出前 |
| 防伪造（手打 `[看图看懂]` 标记） | ✅ 直接搬 | 关键在于：本仓库的 body 里用户文本与系统文本混在**同一个字符串**，必须给注入段加不可伪造边界 |
| 按"对话+发图人"分存看图结果 | ✅ 直接搬 | 用 SQLite 表，比上游 JSON 更稳 |
| 谐音梗 | ⚠️ 需换数据源 | 上游依赖 Python `pypinyin`；Node 侧改用 `pinyin-pro`（MIT，950KB，零依赖，支持多音字），117 条词表照搬 |
| 查梗 cnmeme.wiki | ✅ 直接搬 | **已实测接口可用**：`GET https://cnmeme.wiki/api/v1/public/memes?q=<词>&limit=5` 返回 200 与词条 JSON |
| 配额 / 限流 / 退避 / 缓存 TTL | ✅ 直接搬 | 逻辑纯计算 |
| 表情包词典 | ⚠️ 需融合 | 本仓库已有 stickers 表，应**扩列**而非新建，避免两套并行 |
| 一条消息几张图按位置标"第几张" | ✅ 可搬 | QQ 官方 API 单条消息图片顺序稳定 |
| 引用消息里的图 | ✅ 可搬 | `state.quote.attachments` 已含 URL |
| 「上面那张图」回捞群内最近一张 | ⚠️ 退化为缓存近似 | **QQ 官方 Bot API 无拉取群历史消息的接口**（见 3.1）。但 `historyBuffer` 已缓存未 @ 的消息，扩字段后可覆盖"机器人在场的最近窗口"，做不到上游那种任意 10 分钟回捞 |
| 先发图后 @（2 分钟内补看） | ⚠️ 需新建下载链路 | **不是"加个字段"这么简单**：SDK 的 `HistoryEntry` 无 attachments 字段，且 `inbound.js:372` 的图片下载发生在门控**之后**。需在门控前自建旁路存储。见 §3.2 |
| 转发聊天记录里的图 | ❌ 不可搬（协议级） | **不只是缺 API**，官方协议本身无 forward 消息类型（MsgType 仅 0/2/3/7，无转发路由）。上游 `main.py:843-870` 走 OneBot `call_action get_forward_msg`。**不要写成"等官方开接口"** |
| 一条消息几张图"第几张" | ⚠️ 未验证 | SDK 只给 `attachments[]` 数组序，无位置字段。初版称"顺序稳定"**缺乏出处** |
| 消息里的 QQ 商城表情 | ❌ 不可搬 | 官方 Bot 协议无商城表情体系 |
| 群名片/昵称识别 | ⚠️ 变化 | 官方 API 只给 `senderName` |

> 上表 ❌ 的 3 项，正是"OneBot/NapCat 私有协议"与"QQ 官方开放平台 Bot API"的差异所致，不是移植工作量的产物——**任何基于官方 API 的机器人都不可能做到**。

### 3.1 关于"无历史消息接口"的确凿证据

已对 `node_modules/@tencent-connect/qqbot-nodejs/dist` 做穷尽检索：

- 全部 API 路径只有 `/v2/{groups|users}/{id}/messages`、`/v2/users/{openid}/stream_messages`、`/v2/{groups|users}/{id}/files`、`upload_prepare`、`upload_part_finish` —— **全部是"发送/上传"，没有一个"读取"端点**。
- `MessageApi` 的公开方法只有：`sendMessage` / `sendProactiveMessage` / `sendChannelMessage` / `sendDmMessage` / `sendInputNotify` / `acknowledgeInteraction` / `recallMessage` / `getGatewayUrl` / `sendRaw` —— 无任何 list/get history。
- 检索 forward / history 关键字，命中的全部是自建的 `historyBuffer` 中间件（缓存**我们收到的**消息），而非向 QQ 拉取。

**推论**：插件里"看群里 10 分钟内最近一张图"这类能力，在官方 API 下只能退化为**基于我们自己缓存的图片索引**做近似——机器人没在场的时段不可知。这必须在 README 中如实声明。

### 3.2 替代方案（可挽回一半体验）

虽然拉不到历史，但 `historyBuffer` 中间件（[lib/qq/middleware.js](../lib/qq/middleware.js)，`limit` 默认 20，`recordOnSkip: true`）已经在缓存**未 @ 机器人**的群消息。扩展它的 `HistoryEntry`（当前字段：senderId / senderName / content / timestamp / messageId）加一个 `images` 字段，就能支撑：

- **先发图后 @（2 分钟内）**：✅ 可完整实现
- **「上面那张图」**：⚠️ 仅限机器人已缓存的窗口内可近似，不能像上游那样回捞任意 10 分钟历史

> ⚠️ **修正**：初版称"加一个 `images` 字段即可，约 1 天"是**低估**。实际需在频率门控之前新建一条图片下载 + 旁路存储链路（门控会丢弃未 @ 消息，而下载发生在门控之后），独立成项约 **+2~3 天**。

---

## 4. 推荐架构

```
lib/qq/seememe/
  index.js       // 门面：decorate({ scope, peerId, msg, state, record }) → { block, hints }
  caption.js     // 看图提示词与解析（移植 seer.py）
  puns.js        // 谐音（移植 puns.py，pinyin-pro 替代 pypinyin）
  lookup.js      // 查梗 + 缓存 + 防注入（移植 memes.py）
  store.js       // SQLite：看图结果 / 表情包词条 / 查梗缓存
  quota.js       // 每小时/每日配额、时区分天
  safety.js      // 防伪造标记、注入边界
```

接入改动（**初版漏算一半，已补全**）：

| # | 文件 | 改动 |
|---|---|---|
| 1 | `lib/qq/inbound.js:222-277` | **在 `assembleAgentBody` 内部**注入（不可放在其外，见 §2） |
| 2 | `lib/qq/adaptive.js:362` | 确认默认 adaptive 模式走同一组装器；覆盖两处调用 |
| 3 | `lib/core/config/schema.js` | 新增 `seememe` 配置段；**补 `vision` 段缺的"看图用哪个模型"**（现仅 3 项内联配置，无模型选择） |
| 4 | `lib/core/migrations.js` | 新增 **version 5**（现有已到 v4：:13/:203/:218/:225）。查梗缓存**复用 `job_state`**（:206-213），词条扩 `stickers` 列，可少建表 |
| 5 | `lib/core/stickers/store.js` | 扩列；**注意 `stickerDayKey`（:36-37）用进程本地时区，无 Asia/Shanghai 语义，需新写时区分天** |
| 6 | `lib/index.js:204-206/238` | store 装配 |
| 7 | `lib/qq/settings.js:100-107` | 设置映射 |
| 8 | `lib/console/api/` + `web/src/pages/` | 面板需**手写**（非 schema 生成） |
| 9 | `package.json` | 新增 `pinyin-pro` |

---

## 5. 分期计划

| 阶段 | 内容 | 估时 |
|---|---|---|
| P0 | 目录骨架 + 配置项 + 数据表 + `pinyin-pro` 接入 | 1 天 |
| P1 | 看图：提示词移植、`oneShot` 多模态调用、结果解析、body 注入、防伪造 | 2~3 天 |
| P2 | 谐音（词表 + 读音 + 近音） | 1 天 |
| P3 | 查梗（cnmeme.wiki + 缓存 TTL + 限流退避 + 防注入清洗） | 2 天 |
| P4 | 配额/时区分天/按对话分存（**时区需自写**） | 2 天 |
| P4b | 近期图索引（门控前下载 + 旁路存储，**独立立项**） | 2~3 天 |
| P5 | 表情包词典与现有 stickers 融合 | 2~3 天 |
| P6 | 控制台面板（统计 + 试一张图） | 2~3 天 |
| P7 | 测试（单测 + 假模型 e2e） | 2 天 |

---

## 6. 风险清单

1. **QQ 官方 API 天花板**：历史回捞、合并转发、商城表情三项做不了，需在 README 里如实说明，别照抄上游的"能看"承诺。另：上游所谓"商城表情"并非专用 API，而是靠原始消息段透传 `mface`（`main.py:460-474`），官方协议下无此消息段。
2. **成本风险（初版方向错，已修正）**：真正的问题**不是**"单次双调"——图片内联有模态门控（`inline-image.js:213-227`，仅当 `inputModalities` 含 `image` 时才内联），文本模型根本不会内联。真正贵的是 `inline-image.js:15-16` 明写的设计：**图片会留在会话历史里，每轮都随请求发送**——历史图被反复计费。成本开关应针对"历史图片重复发送"，而非"模型看两遍"。
   另：若 seememe 自行 `saveImage`，应与内联**共享同一 attachment**（复用 `imageHostPath`），否则同一张图存两份字节。
3. **注入文本伪造面（比初版认识更严重）**：不只 `[看图看懂]` 标记，现有 body 已有可伪造的固定边界——`wrapWithHistory` 的 `[Chat history begins]`/`[Current message]`（`inbound.js:207-212`）、`[Quoted message begins]`（:165），且 `:250` 的群名片 `senderName` 由用户可控。**这些现有标记本身就没有转义**，seememe 的注入边界必须一并纳入统一转义方案。
4. **隐私**：cnmeme.wiki 会把"像梗的词"发出去，可能是人名。必须保留上游的保守规则（电话/网址/聊天行不查）并默认只在本轮生效。
4b. **查梗是三级链路，不是单接口**：缓存 → cnmeme.wiki → **AstrBot 网页搜索**（`memes.py:311-348` + `main.py:1310`）。第三级强耦合 AstrBot 的 `provider_settings` 与 9 个内置搜索工具，**应直接砍掉**（上游 `meme_search` 默认就是关的）。DSH 已有 `web_fetch`/`web_search`，若要保留需重新适配，不建议放进首版。
4c. **双看默认开启（成本放大器）**：上游 `also_when_main_sees` **默认 True**（`main.py:1027-1035` 默认不跳过），叠加 `max_images=3` 与转发 `forward_max=6`，**最坏一轮 9 次视觉调用**。上游自己都打 warn 提示"看两遍花两份钱"（`main.py:1017-1026`）。DSH 版应**默认关闭**"主模型能看图时也另看一遍"，并单列成本项。
5. **延迟**：回话前等看图（上游默认 30s）会拖慢响应。建议本仓库默认"超时即降级、后台补看下一轮"。

## 7. 结论

**核心可行，但须显式接受 3 项产品降级**（不出在工程量，出在 QQ 官方协议）：

1. 合并转发里的图 —— 协议无此消息类型，**永久不可实现**
2. 群内历史图回捞 —— 无读取接口，只能退化为"机器人在场期间的本地缓存"
3. 商城表情 —— 协议无此体系

上游最有价值的资产是约 **100KB 源码**中与框架无关的纯文本规则（提示词模板、117 条谐音词表、查梗清洗算法），可近乎无损迁移（上游 `requirements.txt` 仅一行 `pypinyin`、且 `puns.py:178-200` 有降级分支，即为佐证）。DSH 侧的多模态、附件、SQLite、控制台基建齐备。

**但初版说成"完全可行、5~8 天"过于乐观**——注入落点、投递双路径、迁移版本、控制台手写、时区语义、附件共享这六处都会真实加时间。修正后：**核心版 8~11 天，完整版 15~22 天**。

---

## 8. 复核勘误记录

本报告经**三轮独立复核**（上游源码 / 目标仓库 / DSH+外部 API），以下错误均已被源码证实并回源核实，不是推测：

| # | 初版说法 | 事实（证据） | 影响 |
|---|---|---|---|
| 1 | 注入点在 `inbound.js:311` 与 `:392` 之间 | `:347` 的 `appendTranscript` 在其后执行，会把注入内容当**用户原话**喂给记忆提炼 | 🔴 致命：污染长期记忆 |
| 2 | 只改 `inbound.js` | 默认 `reply.mode=adaptive` 走 `adaptive.js:362` | 🔴 致命：默认模式下注入失效 |
| 3 | "比 AstrBot 改 `req.prompt` 更干净" | 上游用 `extra_user_content_parts` 结构化分段 + `mark_as_temp()`（`main.py:145-149/1159/1168`），从不写 `req.prompt` | 🔴 架构判断错：DSH 反而**少了 temp 语义** |
| 4 | 新增 v2 迁移 | 现有已到 v4（`migrations.js:13/203/218/225`），应为 **v5** | 迁移冲突 |
| 5 | "改 5 个文件" | 至少 9 处（含 `index.js`、`settings.js`、控制台前后端） | 低估 |
| 6 | 控制台 schema 驱动 | 仅设置表单是；**面板页需手写** | P6 低估 |
| 7 | 约 10KB 提示词 | AST 实测约 **4KB 提示词 + 3KB 词表**；但源码总量约 **100KB** | 两个错误方向相反，净影响小 |
| 8 | 双倍成本 = 模型看两遍 | 实为**历史图片每轮重发**（`inline-image.js:15-16`），且有模态门控（`:213-227`）；真正放大器是 `also_when_main_sees` **默认 True** | 方向错 + 漏了成本放大器 |
| 9 | 配额/时区可直接搬 | `stickerDayKey`（`stickers/store.js:36-37`）用本地时区，无 Asia/Shanghai 语义 | 漏项 |
| 10 | "单条消息图片顺序稳定" | SDK 无位置字段，**未验证** | 不能当事实写 |
| 11 | `memes.py` 全可搬 ★★★ | `:311-348` 耦合 AstrBot 网页搜索，应拆：cnmeme 路 ★★★ / 搜索路 ★ 砍掉 | 工期 |
| 12 | "模块只绑定 main.py" | import 层零依赖成立，但 `memes.py` 有 AstrBot 耦合 | 不精确 |
| 13 | deliver 在 `:392` | 真正的 `deliver(...)` 在 `:393` | off-by-one |
| 14 | 上游只有 1 个钩子 | 实为 3 个（`main.py:657/948/938`） | 不精确 |

### 复核后的判断分歧

三份复核对工期给出的区间：**6~9 天 / 8~11 天**（核心版），本报告取偏保守的 **8~11 天**。对"70% 可 1:1 照搬"的估计，上游复核认为偏乐观，实际约 **50~60%**（因为注入语义、配额、日切、跨轮去重都要重写）。

### 尚存不确定性（不影响可行性结论）

- `mark_as_temp()` 的确切运行时语义：复核机未装 AstrBot，仅依据调用形态推断。**DSH 侧不依赖它**，需自行实现等价行为，故不影响移植。
- 消息内图片顺序：SDK 未暴露位置字段，需在实现时按 `attachments[]` 数组序并实测确认。

