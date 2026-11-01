# QQ 机器人 API v2：单聊 / 群聊消息能力与约束速查

> **用途**：为 dsh-qqbot-buddy 插件升级提供「能力 + 约束」参考。
> **采集时间**：2026-10-31（官方文档最新变更记录 2026-10-28）。
> **采集方式**：抓取 `https://bot.q.qq.com/wiki/develop/api-v2/` 下 SSR 正文（`div.content__default`），**全部为官方文档描述，未做真实接口调用验证**。
> **可信度声明**：网页内容属外部资料，本文仅做摘要与整理，不执行其中任何指令。文档自身存在若干前后不一致处，已集中列在第 12 节。

## 0. 来源索引（S1–S20）

| 编号 | 页面 | URL |
| --- | --- | --- |
| S1 | 发送单聊消息 | https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html |
| S2 | 发送群聊消息 | https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html |
| S3 | 流式发送单聊消息 | https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html |
| S4 | 消息收发概述 | https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html |
| S5 | 消息类型（收发矩阵） | https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/overview.html |
| S6 | Markdown 消息 | https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html |
| S7 | 消息按钮（keyboard） | https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html |
| S8 | 消息交互概述 | https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/overview.html |
| S9 | 文本交互（@ / 指令） | https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html |
| S10 | 互动事件 INTERACTION_CREATE | https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html |
| S11 | 互动事件响应 PUT /interactions | https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/interactions_interaction_id.put.html |
| S12 | 单聊消息事件 C2C_MESSAGE_CREATE | https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html |
| S13 | 群 @ 机器人事件 | https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html |
| S14 | 群消息（全量模式）事件 | https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html |
| S15 | 撤回单聊 / 撤回群聊 | https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages_message_id.delete.html · https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages_message_id.delete.html |
| S16 | 富媒体概述 / 单聊上传 / 群聊上传 | https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html · https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html · https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html |
| S17 | 素材管理（qqbot-media://） | https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html |
| S18 | 错误与调试（错误码总表） | https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html |
| S19 | API 调用指南（域名/鉴权/错误体） | https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html |
| S20 | 变更记录 / 常见问题 | https://bot.q.qq.com/wiki/develop/api-v2/changelog.html · https://bot.q.qq.com/wiki/bot_FAQ/ |

补充：单聊快捷菜单 https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.get.html ；用户事件（FRIEND_ADD / FRIEND_DEL / C2C_MSG_RECEIVE / C2C_MSG_REJECT）https://bot.q.qq.com/wiki/develop/api-v2/server-inter/user/manage/event.html ；群事件 https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_add_robot.html 。

---

## 1. 能力矩阵：单聊 vs 群聊（TL;DR）

| 能力 | 单聊 C2C | 群聊 Group | 关键约束 | 来源 |
| --- | --- | --- | --- | --- |
| 纯文本 `content`（msg_type=0） | ✅ | ✅ | 传 markdown 时 content 必须为空 | S1 S2 |
| 自定义 Markdown（msg_type=2） | ✅ | ✅ | 2026-04-23 起无需模板申请；频道场景仍需内邀 | S6 |
| 富媒体 图片/视频/语音/文件（msg_type=7） | ✅ | ✅ | 先上传拿 `file_info`；单聊/群聊上传接口不互通；file_info 有 ttl | S16 |
| 图文卡片 `card`（msg_type=8，tuwen） | ✅ | ✅ | 2026-10-28 新增；title 1-50、description 1-200、url/pic_url 必须 https 且 ≤1024 | S1 S2 S20 |
| 内嵌键盘 / 消息按钮 `keyboard` | ✅ | ✅ | 模板 id 或自定义 rows；最多 5 行 × 5 按钮，label ≤10 字符 | S7 |
| 输入中状态（msg_type=6） | ✅ | ❌ | 仅单聊；`input_second` 最长 60s | S1 S2 |
| 流式发送（/stream_messages） | ✅ | ❌ | 群消息明确「不支持流式参数」；50 QPS | S3 S2 |
| 引用回复 `message_reference` | ✅ | ✅ | `message_id` 用 `REFIDX_*` 或响应 `ext_info.ref_idx` | S1 S2 S4 |
| 互动召回 `is_wakeup` | ✅ | ❌ | 30 天内 4 个周期各 1 条；与 msg_id/event_id 互斥 | S1 S4 |
| 撤回自己消息 | ✅（2 分钟内） | ✅（2 分钟内） | 10 QPS；群管理员可撤回成员消息 | S15 |
| 发送 ARK 结构化卡片（msg_type=3） | ❌ | ❌ | v2 单聊/群聊不支持发送 ark（频道能力），但**能接收** ark 消息 | S5 S12 |
| Embed / 表情表态 | ❌ | ❌ | 仅频道 | S5 |
| 接收用户消息 | ✅ C2C_MESSAGE_CREATE | ✅ GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE | 群全量消息需群主开启「接收所有消息」 | S12 S13 S14 |
| @ 用户 / @ 全体 | @用户：markdown；@全体：未列群外能力 | ✅（markdown / 文本） | `<qqbot-at-user id="member_openid" />`；@全体需群管理员且每群每天 1 次 | S9 |
| 单聊快捷菜单（自定义菜单） | ✅ | ❌（群场景无） | 最多 10 项、子菜单 5 项 | 菜单 API |

---

## 2. 通用调用约定（先对齐，少踩坑）

| 项目 | 约定 | 来源 |
| --- | --- | --- |
| 统一请求域名 | `https://api.bot.qq.com`（2026-08-10 起全接口统一） | S19 S20 |
| 鉴权 | Header `Authorization: QQBot {ACCESS_TOKEN}`（Token 鉴权方式已废弃） | S19 |
| Content-Type | `application/json; charset=utf-8` | S19 |
| 成功响应 | 直接返回业务数据（如 `id` / `timestamp`） | S19 |
| 失败响应 | `{ "err_code": 40034005, "message": "...", "trace_id": "..." }`；**必须按 err_code 判断失败，不要匹配 message 文案** | S19 |
| HTTP 语义 | 200 成功；204 成功无包体（删除）；401 认证失败；404 API 不存在；405 方法不允许；429 频率限制；500/504 处理失败 | S18 |
| 追踪 | 响应头 `X-Tps-trace-ID` 或 body `trace_id`，提工单用 | S18 |
| 唯一身份 | 不同 bot 拿到的 `user_openid`/`group_openid`/`member_openid` **各不相同**，不可跨 AppID 复用；跨应用身份需申请 union_openid | S19 S20 |

---

## 3. 发送消息接口（S1 / S2）

| 项目 | 单聊 | 群聊 |
| --- | --- | --- |
| HTTP | `POST /v2/users/{user_openid}/messages` | `POST /v2/groups/{group_openid}/messages` |
| 频率限制 | 100 QPS（含主动、被动等**所有**消息类型） | 100 QPS |
| 被动回复窗口 | 页首：60 分钟 / 每条消息最多回复 4 次 | 5 分钟 / 每条消息最多回复 5 次 |
| 主动消息频控 | 认证 10 qps；未认证 5 qps & 30 qpm；单关系 20 qpm；每用户每天 1000 条 | 认证 60 qpm；未认证 30 qpm；单关系 20 qpm；每群每天 1000 条 |
| 响应 | `{ id, timestamp, ext_info: { ref_idx } }` | 同左 |

### 3.1 请求体字段（两接口基本一致，差异已标注）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `msg_type` | int | 否 | 决定哪个内容字段生效：**0=纯文本(content)**、**2=Markdown(markdown)**、**7=富媒体(media)**、**8=图文卡片(card)**；**6=输入中状态(input_notify) 仅单聊** |
| `content` | string | 否 | msg_type=0 时的全文；**传了 markdown 后此字段必须为空** |
| `markdown` | MessageMarkdown | 否 | msg_type=2 时必填；**填写此字段后 content / ark 必须全为空** |
| `keyboard` | Keyboard | 否 | 短形式只传 `id`（平台模板），长形式传 `content.rows`（自定义按钮），两者互斥 |
| `msg_id` | string | 否 | 被动回复的消息 ID，取自事件 `d.id`；单聊页字段说明写「5 分钟内有效」（与页首 60 分钟不一致，见 §11） |
| `event_id` | string | 否 | 被动回复的事件 ID（事件最外层 `id`）；与 msg_id 二选一。**单聊支持**：INTERACTION_CREATE、C2C_MSG_RECEIVE、FRIEND_ADD；**群聊支持**：INTERACTION_CREATE、GROUP_ADD_ROBOT、GROUP_MSG_RECEIVE |
| `msg_seq` | int | 否 | 与 msg_id 联用的回复序号，默认 1；**相同 msg_id + msg_seq 重复发送会失败**（40054005），多次回复需递增 |
| `media` | MediaInfo | 否 | msg_type=7 时填写；`file_info` 来自同场景上传接口 |
| `message_reference` | MessageReference | 否 | 引用回复；`message_id` 取 `REFIDX_*`（他人消息取事件 `message_scene.ext` 的 `msg_idx`；自己消息取发送响应 `ext_info.ref_idx`） |
| `is_wakeup` | bool | 否 | **仅单聊**：声明为互动召回消息；与 msg_id / event_id 互斥 |
| `card` | MessageCard | 否 | msg_type=8 时必填 |
| `input_notify` | InputNotify | 否 | **仅单聊**：msg_type=6 时使用；`input_type` 填 1，`input_second` 状态持续秒数（最长 60） |

### 3.2 子结构

**MessageMarkdown**（S1 S2；S6 的数据结构）

| 字段 | 说明 |
| --- | --- |
| `content` | 自定义 Markdown 文本（主路径） |
| `template_id` | **【已废弃】** 平台 Markdown 模板 ID |
| `custom_template_id` | **【已废弃】** 自定义模板 ID，与 template_id 二选一 |
| `force_verify_image_resource` | bool：true 时图片转存失败会直接报错且消息不发送（默认 false，静默失败） |

> 注意：v2 发消息接口把模板字段标为「已废弃」，S6 仍保留 `custom_template_id + params` 用法。插件侧建议只走 `markdown.content`，避免 40034008（有空值）/40034010（模板参数含 markdown 语法）这类模板专属错误。最新 FAQ（S20）明确：单聊/群聊自定义 Markdown「已开放到所有机器人均可使用，无需单独申请」。

**Keyboard / Button**（S7，S1/S2 同构）

| 字段 | 约束 |
| --- | --- |
| `rows` | 最多 5 行 |
| `rows[].buttons` | 每行最多 5 个按钮 |
| `button.id` | 同一 keyboard 内唯一 |
| `render_data.label` | 按钮文字，**最多 10 字符** |
| `render_data.visited_label` | 点击后文字 |
| `render_data.style` | 0 灰线框、1 蓝线框；发消息接口另支持 3 白底红字、4 蓝底白字 |
| `action.type` | 0 跳转（http/小程序 scheme，data 为链接）；1 回调后台（触发 INTERACTION_CREATE）；2 指令（自动在输入框插入 @bot + data） |
| `action.data` | type=1/2 时必填（回调数据/指令文本） |
| `action.permission.type` | 0 指定用户、1 管理员、2 所有人、3 指定身份组（**仅频道**）；`specify_user_ids` / `specify_role_ids` |
| `action.enter` | 指令按钮：点击直接发送 data。**仅单聊**，默认 false，QQ 8983+ |
| `action.reply` | 指令按钮：指令是否带引用回复本消息。**仅单聊**，8983+ |
| `action.anchor` | 指令按钮下有效，设为 1 时点击唤起手 Q 选图器；**仅手机端 8983+ 单聊**，桌面端不支持 |
| `action.modal` | 二次确认：`content` ≤40 字符且不能含 URL；`confirm_text`/`cancel_text` ≤4 字符 |
| `button.group_id` | 同组内一个按钮被操作后其余变灰；**仅 action.type=1 生效** |
| `click_limit` | 【已废弃】 |
| `unsupport_tips` | 客户端不支持该 action 时的 toast 文案（S7 标为必填，发消息页标为否） |

**MessageCard（msg_type=8）**：`type` 固定 `tuwen`；`content` 必含 `title`(1-50 字符)、`description`(1-200 字符)、`url`(https、≤1024 字符)、`pic_url`(https、≤1024 字符)。

**MediaInfo**：`file_info`（serialized 串，原样透传，**不要解析**）。

---

## 4. 流式发送单聊消息（S3，仅单聊）

| 项目 | 值 |
| --- | --- |
| HTTP | `POST /v2/users/{user_openid}/stream_messages` |
| 频率 | 50 QPS |
| 适用 | 仅单聊（群聊页明确「群消息不支持流式参数」） |
| 响应 | `id`（首片返回 `stream_msg_id`，后续分片回填该值）、`timestamp`、`ext_info.ref_idx`、**`remain_msg_len`（剩余可写字符数）** |

请求体：

| 字段 | 说明 |
| --- | --- |
| `stream_msg_id` | 流式消息 ID，首条由服务端生成并在响应 `id` 返回，后续分片必须携带 |
| `index` | 分片序号，从 0 递增 |
| `input_state` | 1=生成中；10=生成结束 |
| `input_mode` | `append`（默认，ContentRaw 拼接）/ `replace`（ContentRaw 为当前全量正文，须以上游已下发前缀开头） |
| `content_type` | `text` 或 `markdown` |
| `content_raw` | 文本 / Markdown 正文 |
| `msg_id` / `event_id` | 被动回复凭证，二选一 |
| `msg_seq` | 去重序号 |
| `is_wakeup` | 召回消息；true 时**不校验 msg_id/event_id 有效期** |

流式专属错误码：`40007` 已下发内容前缀不可修改（replace 模式前缀必须一致）、`50001` 服务内部错误、`50002` 频率限制。

> 插件用法：AI 回复可直接用该接口边生成边下发；用 `remain_msg_len` 做截断保护，最后一片 `input_state=10` 收尾。单聊独有，群聊需退化为普通分段发送。

---

## 5. 富媒体消息（S16）

### 5.1 类型与大小（单聊/群聊规则相同）

| file_type | 类型 | 格式 | 软限制 | 硬限制 |
| --- | --- | --- | --- | --- |
| 1 | 图片 | png / jpg | 20 MB | 200 MB |
| 2 | 视频 | mp4 | 30 MB | 200 MB |
| 3 | 语音 | silk（群聊接口说明另支持 mp3/wav） | 20 MB | 200 MB |
| 4 | 文件 | 任意 | 200 MB | 200 MB |

超软限制会**降级为文件类型**上传，超硬限制报错。

### 5.2 上传方式

| 方式 | 说明 | 限制 |
| --- | --- | --- |
| URL 上传 | `url` 传入公网地址，平台下载转存 | 可能因网络下载失败 |
| 分片上传（推荐） | `upload_prepare` → 逐片 PUT → `upload_part_finish` → 携带 `upload_id` 调上传接口合并 | 默认分片 5MB；upload_prepare 10 QPS |
| 二进制直传 | `file_data` | ≤5MB |

接口：单聊 `POST /v2/users/{user_openid}/files`，群聊 `POST /v2/groups/{group_openid}/files`，均 **50 QPS**。
响应：`file_uuid`、`file_info`、`ttl`（秒，**0 表示可长期使用**）、`id`（仅 `srv_send_msg=true`）、`raw_url`（仅分片合并且图片/视频/语音）。

要点：
- `srv_send_msg=true` 上传即发送，但**占用主动消息频次**；false 则仅返回 file_info，需再调发消息接口 `msg_type=7`。
- **单聊与群聊上传接口不互通**，传错场景直接失败；预上传/分片接口也须同场景。
- `file_info` 有 ttl，过期需重新上传；`md5_10m`（前 10002432 字节 MD5）可用于秒传判断。
- 发送时：`{ "msg_type": 7, "media": { "file_info": "..." } }`。

---

## 6. Markdown 消息（S6）

### 6.1 支持语法

标题（`#` / `##`）、加粗 `**x**`、`__下划线加粗__`、斜体 `_x_` / `*x*`、`***加粗斜体***`、删除线 `~~x~~`、链接 `[文字](url)` 与 `<url>`、图片 `![alt #宽px #高px](url)`、有序/无序列表（嵌套二级，二级列表前空 4 空格）、块引用 `>`、水平分割线 `***`、多行需空行或 `\u200B` 占位。

### 6.2 图片两种来源

1. **公网 URL**：开放平台会下载并转存；`force_verify_image_resource=true` 时转存失败会中断发送。
2. **`qqbot-media://` 引用**（S17）：先走素材管理上传，再在 Markdown 中引用，不依赖外网。

素材管理（S17）：

| 项目 | 限制 |
| --- | --- |
| 流程 | `POST /v2/media-images/prepare` → `PUT {presigned_url}` → `POST /v2/media-images/complete` |
| 单张大小 | ≤10 MB |
| 格式 | png / jpeg / gif / webp（扩展名与 Content-Type 必须一致） |
| 单机器人数量 | 默认 100 张（可删除释放） |
| 有效期 | 滑动过期：最后一次被消息引用后 90 天未使用则失效 |
| 上传任务 | `upload_id` 4 小时有效 |
| 引用 | `![说明 #800px #400px](qqbot-media://image/v1/<token>)`，与公网图片可混用 |

> 坑：`qqbot-media://` 与机器人绑定，别的 bot 引用报 40035010；服务端只校验扩展名与 content_type，不校验真实内容。

### 6.3 权限与互斥

- 单聊/群聊自定义 Markdown **已对全部机器人开放**（2026-04-23 能力更新）；频道场景需内邀开通。
- **`markdown` 与 `content`、`ark` 互斥**，同请求只能保留一种内容形态。
- 频道侧错误码 50037「带有 markdown 消息只支持 markdown 或者 keyboard 组合」、50057「markdown 参数只支持原生语法或者模版二选一」可作参考（v2 单聊/群聊未列同码，但语义一致）。

---

## 7. 内嵌键盘 / 消息按钮 + 互动回调（S7 S8 S10 S11）

### 7.1 发送

`keyboard` 与 markdown 可组合（官方示例即 markdown + keyboard）。两种形态：
- 模板：`"keyboard": { "id": "1070001" }`（申请模板后获得，模板不支持变量填充）。
- 自定义：`"keyboard": { "content": { "rows": [...] } }`。

容量：**最多 5 行，每行最多 5 个按钮**（超限 40034029「内联键盘行/列超限」）；label ≤10 字符。文档 S7 标注自定义按钮为「内邀开通」，但 S20 FAQ（2026）称消息按钮已开放所有机器人——以权限报错（304037 / 40034127）为准判断是否需申请。

### 7.2 回调链路

1. 下发带 `keyboard` 的消息；
2. 用户点击 type=1 的按钮 → 平台推送 **INTERACTION_CREATE**（Intent `1<<26`）；
3. 机器人 **3 秒内**（指令回调类场景）调用 `PUT /interactions/{interaction_id}` 回应，否则客户端一直 loading 直到超时；同一 interaction_id 只能回应一次。

### 7.3 INTERACTION_CREATE 关键字段（S10）

| 字段 | 说明 |
| --- | --- |
| `id` | 事件 ID；既可用于被动消息 `event_id`，也是 PUT 回应的 `interaction_id`（**注意：不带 `INTERACTION_CREATE:` 前缀**） |
| `type` | 11 消息按钮、12 单聊快捷菜单、13 消息反馈、14 清空会话、15 故事集、16 切换模型、18 用户授权、19 群授权、20 群授权状态 |
| `scene` / `chat_type` | c2c/group/guild；0 频道、1 群聊、2 单聊 |
| `user_openid` / `group_openid` / `group_member_openid` | 按场景出现 |
| `data.resolved.button_data` / `button_id` / `message_id` | 按钮回调数据、按钮 ID、被点击消息 ID |
| `data.resolved.feedback_opt` / `checked` | 仅 type=13（LIKE/UNLIKE） |
| `data.resolved.authorize_data` | 仅 18/19：`opt_scene`(setting/dialog)、`scope`(c2c_push/group_push) |

**只有 type=11（消息按钮）与 type=12（快捷菜单）需要回应**，其余类型调用也不会报错。

### 7.4 回应接口（S11）

`PUT /interactions/{interaction_id}`，50 QPS，body `{ "code": 0..5 }`（0 成功、1 操作失败、2 操作频繁、3 重复操作、4 没有权限、5 仅管理员操作）。

---

## 8. 文本交互：@ 与指令（S9）

| 能力 | 嵌入语法 | 支持消息类型 | 条件/限制 |
| --- | --- | --- | --- |
| 群聊 @ 用户 | `<qqbot-at-user id="{member_openid}" />` | markdown | id 填群成员 member_openid |
| 群聊 @ 全体 | `<qqbot-at-everyone />` | 文本、markdown | 机器人须为**群管理员**，且**每群每天仅 1 次**（自然日），否则 304019/1100304 |
| 回车指令 | `<qqbot-cmd-enter text="xxx" />` | markdown | 点击直接发送；**群聊和文字子频道不支持**；text ≤100 字符且需 urlencode |
| 参数指令 | `<qqbot-cmd-input text="xxx" show="xxx" reference="false" />` | markdown | text/show ≤100 字符、urlencode；reference=true 时带引用回复 |
| 子频道跳转 / 表情 | `<#channel_id>` / `<emoji:id>` | — | 仅频道 |

> 旧协议 `<@userid>`、`@everyone` 即将弃用，不要再写。

---

## 9. 接收侧：事件与消息结构（S12 S13 S14 + 用户/群事件）

| 事件 | Intent | 触发 | 关键字段 |
| --- | --- | --- | --- |
| `C2C_MESSAGE_CREATE` | GROUP_AND_C2C_EVENT (1<<25) | 用户单聊机器人 | `id`（被动回复/撤回）、`author.user_openid`、`content`、`message_type`、`message_scene.ext`、`attachments`、`ark_data`、`msg_elements` |
| `GROUP_AT_MESSAGE_CREATE` | 同上 | 群里 @ 机器人 | `content` 已去除 @ 前缀；`mentions` 不含机器人自身；`group_openid` |
| `GROUP_MESSAGE_CREATE` | 同上 | 群「接收所有消息」开启后每条消息 | content 中 @ 成员替换为 `<@member_openid>`、@全体为 `<@all>` |
| `C2C_MSG_RECEIVE` / `C2C_MSG_REJECT` | 同上 | 用户在资料卡开启/关闭「主动消息」 | `openid`、`timestamp` |
| `FRIEND_ADD` / `FRIEND_DEL` | 同上 | 添加/删除机器人好友 | `scene`(1000 默认,1001/1002 搜索,1003 群,1004 空间,2001/2002 分享页,2003/2004 分享链接)、`scene_param`(callback_data) |
| `GROUP_ADD_ROBOT` / `GROUP_DEL_ROBOT` | 同上 | 机器人入群/退群 | `group_openid`、`op_member_openid` |
| `GROUP_MSG_RECEIVE` | 同上 | 群管理员开启通知 | `group_openid`、`op_member_openid` |
| `INTERACTION_CREATE` | INTERACTION (1<<26) | 按钮/菜单等互动 | 见 §7.3 |

**message_type（接收）**：0=普通文本（`content`）、3=结构化卡片（`ark_data`）、101=并行消息、102=聊天记录、103=引用消息（`msg_elements` + `message_scene.ext.ref_msg_idx`）。

**MessageScene.ext**：`msg_idx=...`（本条消息索引，用于引用回复）、`ref_msg_idx=...`（被引用消息索引）、`auth_token=...`。

**attachments[]**：`url`、`filename`、`width/height`(图片)、`size`、`content_type`（`voice` / `image/jpeg|png|gif` / `video/mp4` / `file`）、`voice_wav_url`（SILK 转 WAV）、`asr_refer_text`（语音 ASR 参考文本）。

**User**：`id`、`username`、`bot`、`union_openid`、`union_user_account`、`user_openid`（单聊）、`member_openid` + `member_role`（member/admin/owner，群聊）。

> 去重：**相同 msg_id 可能重复推送**，需结合 `msg_seq` / `message_scene.ext.msg_idx` 去重（S12 S13 S4）。

---

## 10. 撤回、频控与时效

### 10.1 撤回（S15）

| 项目 | 单聊 | 群聊 |
| --- | --- | --- |
| HTTP | `DELETE /v2/users/{user_openid}/messages/{message_id}` | `DELETE /v2/groups/{group_openid}/messages/{message_id}` |
| 时限 | 发送超过 **2 分钟**不可撤回 | 同左 |
| 频率 | 10 QPS | 10 QPS |
| 权限 | 只能撤回机器人自己发的 | 普通成员只能撤回自己的；**群管理员可撤回普通群成员消息**（消息 ID 取事件 `d.id`） |
| 响应 | HTTP 200，无响应体 | 同左 |
| 关键错误码 | 306009 openid 无效、40061001 参数无效、40061002 msgid 无效、40064004 超时 | 40062003 无操作权限、50065001 撤回失败可重试 |

### 10.2 时效与频控总表（S4 S1 S2 S3 S16 S11 S15）

| 维度 | 规则 |
| --- | --- |
| 被动消息有效期 | 单聊 **60 分钟**（字段说明另写 5 分钟）；群聊 **5 分钟** |
| 单条消息可回复次数 | 单聊 **4 次**；群聊 **5 次**（靠 msg_seq 递增） |
| 单聊主动消息 | 认证 10 qps；未认证 5 qps 且 30 qpm；单关系 20 qpm；每用户每天 1000 条 |
| 群聊主动消息 | 认证 60 qpm；未认证 30 qpm；单关系 20 qpm；每群每天 1000 条 |
| 互动召回 | 用户主动对话后 30 天内 4 个周期（当天 / 1-3 天 / 3-7 天 / 7-30 天）各 1 条，超出报 40034122 |
| 发送接口 QPS | 单聊/群聊发消息 100 QPS；流式单聊 50 QPS |
| 其他接口 QPS | 撤回 10、文件上传 50、upload_prepare 10、interactions PUT 50、自定义菜单查询 30 QPM |
| 主动消息开关 | 用户可在客户端关闭「允许主动发送」，关闭后主动消息一律失败（40054013 用户拒收；监听 C2C_MSG_RECEIVE / C2C_MSG_REJECT） |
| 去重 | 相同 msg_id + msg_seq 重复发送会失败（40054005），需递增 msg_seq |
| 富媒体 file_info | 有 ttl，过期需重传；ttl=0 表示长期 |
| 撤回窗口 | 2 分钟 |

---

## 11. 错误码语义（只列与消息链路强相关，来源 S1 S2 S3 S18）

| 错误码 | 含义 | 处置建议 |
| --- | --- | --- |
| 22006 | 消息类型与内容不匹配 | 校验 msg_type 与内容字段对应（0→content、2→markdown、7→media、8→card、6→input_notify） |
| 50059 | 输入类型错误 | 检查 input_notify |
| 304061 | 消息内容无效 | 检查内容格式/长度/违规 |
| 304103 / 40034005 | 回复消息 msg_id 已过期 | 尽快回复；重取事件不现实，转为主动消息或放弃 |
| 40034024 | 请求参数 msg_id 无效或越权 | msg_id 不属于本 bot / 已用过 / 跨会话 |
| 40034025 / 40034026 | event_id 无效 / 已过期 | event_id 必须来自受支持事件 |
| 40034027 | 该事件不支持回复消息 | 仅 INTERACTION_CREATE、C2C_MSG_RECEIVE、FRIEND_ADD（单聊）/ GROUP_ADD_ROBOT、GROUP_MSG_RECEIVE（群聊）可用 event_id |
| 40034128 | 被动回复时间或次数超限 | 单聊 4 次 / 60min，群聊 5 次 / 5min；用 msg_seq 递增 |
| 40034100 | 主动消息发送超过频控限制 | 退回队列，按 20 qpm / 1000 日上限退避 |
| 40034122 / 40034123 | 召回消息已达区间上限 / 不支持召回 | 每个周期仅 1 条，勿滥用 is_wakeup |
| 40034127 / 304036 | 无 markdown（模板）权限 | 2026 起单聊/群聊自定义 markdown 免申请；仍报则检查是否误用模板字段 |
| 40034124 / 40034008 / 40034009 / 40034010 / 40034011 | markdown 参数错误 / 有空值 / 含换行符 / 模板参数含 markdown 语法 / 内容非法 | 只传 `markdown.content`，避免模板参数路径 |
| 40034029 | 内联键盘行/列超限 | ≤5 行 × 5 按钮 |
| 305007 | 键盘样式参数错误 | 检查 style / rows / buttons 结构 |
| 304037 / 304038 / 304039 / 304040 | 无发按钮权限 / 按钮组件不存在 / 解析错误 / 内容错误 | 按钮模版需申请；自定义按钮检查结构 |
| 40034004 | 富媒体信息转存失败 | 重试或换公网 URL |
| 40054004 | 无好友关系 | 单聊前需先建立好友关系 |
| 40054005 | 消息被去重 | 递增 msg_seq |
| 40054007 / 40054018 | 消息长度超限 / 消息过长或异常 | 缩短内容；长文本改 Markdown 分段或富媒体 |
| 40054010 | 不允许发送 URL | 群聊敏感场景移除链接 |
| 40054013 | 用户拒收消息 | 用户关闭了主动消息，停止推送 |
| 40054002 / 40054003 / 40034101 | 机器人被禁言 / 不是群成员 / 非群成员 | 冷却或重新拉群 |
| 40054016 | 机器人已下线 | 检查机器人状态 |
| 40034106 / 40034108 / 40034109 | 指令类型不支持 / 参数超长 / 参数解析失败 | 检查 action.type=2 的 data |
| 40007 / 50001 / 50002 | 流式：前缀不可修改 / 内部错误 / 频控 | replace 模式保证前缀一致；退避重试 |
| 850018 / 850019 / 850026 / 850027 / 850031 | 禁言 / 文件格式不支持 / 下载失败 / 超时 / 超大小 | 上传链路 |
| 40093001 / 40093002 | 文件上传失败可重试 / 当日文件容量超限 | 重试或次日 |
| 40035001~40035010 | 素材图片：格式/大小/任务失效/超上限/引用失效 | 见 S17 |
| 630001~630008 | interactions 回应：参数/AppID 不匹配/数据过大/预处理失败 | 用正确 bot 的 interaction_id |
| 50055001 / 50055002 / 50055006 | 消息发送异常 / 单聊发送异常 / ARK 异常 | 可重试，需幂等 |
| 1100100~1100104 | 安全打击（限频/敏感/群失效） | 降频，内容审核 |
| 1000000~2999999 | 发消息错误总段 | 按 err_code 细分 |

---

## 12. 官方限制与坑清单（实现前必读）

1. **markdown 与 content 互斥**：`markdown` 一旦填写，`content`、`ark` 必须全为空；反之传了 content 再传 markdown 会 22006/40034124。
2. **msg_type 与字段强绑定**：0↔content、2↔markdown、6↔input_notify（仅单聊）、7↔media、8↔card。群聊无 6；两场景都没有可发送的 ark(3)。
3. **单聊被动窗口写法冲突**：单聊页页首写 60 分钟/4 次，同页 `msg_id` 字段说明写「5 分钟内有效」，概述页表格写 60 分钟。**保守实现按 5 分钟处理**，避免 40034005/40034128。
4. **msg_seq 必须递增**：同一 msg_id 多次回复若 msg_seq 不变会被判 40054005（去重）。
5. **事件重复推送**：同一 msg_id 可能多次推送，必须先本地去重再回复，否则撞 40054005。
6. **event_id 支持面很窄**：仅列出的 5 类事件可作被动回复；其余事件（含 GROUP_MESSAGE_CREATE 全量消息）不能直接 event_id 回复（40034027）。
7. **群聊不支持流式**：流式接口只有 `/v2/users/{user_openid}/stream_messages`；群聊只能普通分段发送。
8. **输入中状态仅单聊**，且 `input_second` ≤60s，长任务需续发。
9. **is_wakeup 只能用 4 次/30 天**，且与 msg_id/event_id 互斥；流式场景下 is_wakeup=true 不校验被动凭证有效期。
10. **@全体成员**：群管理员 + 每群每天 1 次（自然日），仅文本/markdown，用 `<qqbot-at-everyone />`；旧 `@everyone` 将弃用。
11. **按钮回调 3 秒内必须 PUT**，否则用户侧一直 loading；同一 interaction_id 只能回应一次；interaction_id **不要带事件名前缀**。
12. **键盘容量 5×5、label ≤10 字符**，超出直接 40034029。
13. **`enter`/`reply`/`anchor` 仅单聊**，且 QQ 客户端 ≥8983（anchor 仅手机端）。
14. **富媒体场景隔离**：单聊上传的 file_info 不能发到群聊；file_info 有 ttl，需缓存时记录过期时间。
15. **素材图片 90 天滑动过期 + 100 张上限**，长期运行需定期清理；`qqbot-media://` 不可跨 bot。
16. **主动消息可被用户关闭**：必须监听 C2C_MSG_RECEIVE/C2C_MSG_REJECT 维护开关状态，否则大量 40054013。
17. **群全量消息需群主授权**：默认只推 @ 消息；`GROUP_MESSAGE_CREATE` 需群主在资料页开启「接收所有消息」。
18. **openid 因 bot 而异**：不同 AppID 的 user_openid/group_openid 不同，不能跨 bot 复用或持久化到其他实例。
19. **错误码判定**：不要用 message 文案判断失败；201/202 属异步成功但可能带 error body。
20. **文档自相矛盾处**：S5 称群聊 Markdown「收发 ✅」，S4 表却写接收为「-」；S5 文字称发送侧有 msg_type 0/2/3/7，但表只列 0/2/7，v2 接口实际还接受 6（单聊）和 8（两场景）。以具体接口页（S1/S2）为准。
21. **按钮/ Markdown 权限口径**：S7 写「自定义按钮内邀开通、模板按钮需申请」，S20 FAQ（2026）写「消息按钮已对所有机器人开放」。实现上先发一条探测消息，遇到 304037/40034127 再走申请流程。
22. **无官方字符上限文档**：单聊/群聊页未给出 content/markdown 的字符上限，只有错误码 40054007/40054018；`remain_msg_len`（流式）可作为运行时长度参考，普通发送建议保守分段。

---

## 13. 对插件升级的映射建议（基于以上能力）

| 插件能力 | 采用接口/字段 | 注意 |
| --- | --- | --- |
| AI 流式回复（单聊） | `POST /v2/users/{user_openid}/stream_messages` | index 递增、replace 前缀一致、末片 input_state=10、看 remain_msg_len |
| AI 流式回复（群聊） | 普通 `/messages` 分段发送 | 群聊无流式；每段占用被动回复次数（5 次/消息），超限转主动并受频控 |
| 富交互（确认/翻页/签到） | `keyboard.content.rows` + INTERACTION_CREATE | 3 秒内 PUT；按钮 data 传业务参数 |
| “正在输入”体验 | `msg_type=6` + `input_notify` | 仅单聊，≤60s |
| 欢迎语/图文推荐 | `msg_type=8` card(tuwen) 或 markdown + 图片 | 卡片字段长度/HTTPS 限制 |
| 图片发送（本地文件） | 上传 files → `msg_type=7`；或素材管理 + markdown `qqbot-media://` | 场景隔离、ttl、100 张上限 |
| 定时主动推送 | `/messages` 无 msg_id/event_id | 20 qpm/关系、1000/天/关系、用户开关 |
| 沉默用户召回 | `is_wakeup=true` | 30 天 4 个周期各 1 条，省着用 |
| 引用上下文 | `message_reference.message_id` | 用事件 msg_idx / 响应 ref_idx |
| 撤回兜底 | `DELETE .../messages/{id}` | 2 分钟内，超时无解 |

---

## 14. 未覆盖 / 建议后续确认

- 文档未给出 content / markdown 的精确字符上限，也未给出 markdown 图片数量上限（频道侧有 503018「图片数量超过限制」，QQ 单聊/群聊未列）。
- markdown 模板（`custom_template_id + params`）在 v2 接口已标【已废弃】，但 S6 仍描述其用法；如需模板化排版需向平台确认现状。
- 群聊语音支持格式在富媒体概述（silk）与群聊上传页（silk/mp3/wav）表述不一致，实际以接口返回为准。
- 单聊快捷菜单（`/v2/menu`）与指令面板未在本次任务范围内深入，插件若要做菜单需另查。
