# 提示词预算化改造方案

> 状态：提案（未实施）｜数据截止 2026-11-13｜样本：QQ 机器人 `bot_fb891494bb5d` 最近 12 个会话、550 次请求头、418 次工具调用
> 复现：`node scripts/prompt-budget.mjs --bot bot_fb891494bb5d --sessions 12`

---

## 0. 结论摘要

1. **工具 schema 是固定开销的绝对主体。** 单请求工具负载中位 **31,036 字符**（≈7,759 tokens），均值 29,822；系统提示词平均 7,461 字符。工具占固定开销 **83.1%**。优化工具指引散文（1,267 字符）最多省 3%；优化工具清单能省 60%。
2. **16 个工具在样本期零调用**，合计 **11,616 字符（最坏负载的 31.6%）**：`generate_images`、`find_inspiration`、`apply_patch`、`edit`、`qqbot_send_card`、`job_*`、`canvas_state`、`view_canvas` 等。
3. **兼容别名是负收益。** 4 个别名 schema 共 **3,613 字符（9.8%）**，样本期只救回 5 次误调用，仍有 5 次未覆盖的错名失败（`search_web`、`shell`、`image_generate`、`qqbot_send_text`）。31 次 unknown tool 占全部调用的 **7.4%**。
4. **动态内容写进了 system section，破坏前缀缓存。** 时间/记忆/知识/群友每轮都变，系统提示词随之逐字变化。DSH 为此提供了专门的 `systemPrompt.context()`（cache-safe 的 section 替代品），插件没用。
5. **本机路由没有任何适配器级省流可用。** `dsh-llm-pi-ai` 的 `conversationUpdates()` 对自定义 openai-completions 模型返回空对象（`supportsMidConvoToolAdditions` 等 compat 字段在 `COMPAT_GATES` 里是 `withhold`，不可配置），`deferLoading` 在 pi-ai 侧被**直接过滤掉**（`toolsOf()`）。省流只能靠"声明什么"，不能指望"声明方式"。

---

## 1. 调研方法与数据可信度

| 数据源 | 取到什么 | 为什么可信 |
| --- | --- | --- |
| `session.v4.jsonl.zstd` 的 `request/header` 事件 | 每次请求真正发给模型的 `tools[]` 原文 | DSH 在 agent-loop 里把 canonical header（含 tools）落盘，不是估算 |
| `tool/call` / `tool/result` 事件 | 真实调用名与失败结果 | 同一条日志流 |
| `system/message` 事件 | 渲染后的系统提示词长度 | agent-loop 把 `renderPrompt(assembly)` 提交为 surface node |
| `GET /api/preview/prompt`（控制台 live） | 真实 assembly 的段清单与字符数 | 插件 `buildLivePromptPreview()` 直接调 `systemPrompt.assemble()` |
| 源码 | 机制与约束 | 结论都标了包名与位置 |

**局限（必须一起看）：**

- 样本 12 个会话、单机器人、单模型，不能代表全部部署。
- 字符→token 用 DSH 官方口径 `chars / 4`（`dsh-token-meter/src/estimate.ts`）。本机系统提示词含 2,662 个 CJK 字符，`/4` 会低估约 1.7 倍；工具 JSON 基本是英文，`/4` 可信。**修正值：工具 9,195 tokens 不变，系统提示词约 2,555 tokens（而非 1,446）**，工具占比 78.3%，仍高于四分之三。
- `request/header` 只在**首次 / 声明变化 / 新请求系列**时新写（`agent.ts` 的 `initial|change|series` 三种 reason），同一系列内声明未变则不重复落盘——分布统计的是"请求头事件"，不是"请求次数"。单次请求的负载是准确的，累积成本会被低估。样本里 `series` 占 464 / 550，说明"每轮重新声明"是常态而非异常。

---

## 2. DSH 侧：提示词管理提供了什么

### 2.1 装配模型：一个带作用域的注册表

`@deepseek-ai/dsh-system-prompt` 是唯一装配入口，四类贡献 + 一层作用域：

| 贡献 | API | 作用 | 求值时机 |
| --- | --- | --- | --- |
| section | `section({name, order, text})` | 系统提示词正文；按 order 升序、同序按名字码元排序 | 每次 assembly |
| context | `context({name, order, text, required})` | **动态运行时事实**，渲染成保留历史之后的 user 角色快照 | 每次 assembly + 准入刷新 |
| variable | `variable(name, fn)` | `{{name}}` 插值（严格：未注册/未定义直接抛） | 每次 assembly |
| tools | `tools((ctx) => ({schemas, knownNames}))` | 工具 schema 提供者 | 每次 assembly |

关键语义（都影响本方案）：

1. **同名遮蔽（shadow）只对"不同层"生效。** 全局段可被子作用域同名段替换；**同一层同名注册直接抛错**（`PromptLayer` 的 `NamedEntries`）。这就是插件不能遮蔽 `tool:*` 段的原因（见 3.2）。
2. **`context` 是 section 的 cache-safe 替代品。** 装配时解析、按序合并，agent-loop 只在**内容变化或压缩移除**时才把快照追加到保留历史之后。section 则是每次变化都**原地替换** surface node 0。
3. **`complete: true`** 让某个段独占系统提示词（其余段仍参与协作瀑布，最终只保留它）。
4. **`getSectionOrder(name)`** 是官方分配的序位锚点（`SECTION_ORDERS`，−1000 到 10200），插件应复用而不是自造数字。

### 2.2 请求链路：schema 到底怎么发出去

    工具注册 (ctx.tools.register)
       ↓  assembly.tools（按 toolOrder / 字典序）
    step 准备：renderPrompt(sections) → system/message surface node
                request/header 落盘（含 tools 全文）→ 变化时追加 developer/message(tool-addition|tool-removal)
       ↓  projectToolUpdates(messages, tools, toolUpdate, toolHistory)
    适配器：pi-ai / deepseek / anthropic ……

- **`request/header` 是"每次请求都会重新发送"的证据。** 只要 header 变（工具集变、配置变），就新写一条，并把新增/移除工具写成 developer message。
- **`projectToolUpdates()`（`dsh-llm/src/content.ts:439`）是唯一能在请求层"不发 schema"的机制**：当路由声明 `toolUpdate: 'in-history' | 'addition-only'` 时，它只发**历史基线**的声明，新工具靠历史里的 developer message 激活。
- **但本机路由拿不到这个能力**：`conversationUpdates()`（`dsh-llm-pi-ai/src/models.ts:75`）要求 `compat.supportsMidConvoToolAdditions` 等字段，而 `COMPAT_GATES`（`catalog.ts`）把这些字段标为 `withhold`——配置文件写不进去，出厂 catalog 也没有模型标 true。结论：QQ 机器人每次请求都在重发全部工具 schema。
- **`deferLoading: true` 在 pi-ai 上是"消失"而不是"延迟"**：`context.ts` 的 `toolsOf()` 直接 `.filter(tool => !tool.deferLoading)`。只有 `dsh-llm-deepseek` 会序列化成 `defer_loading: true`。

### 2.3 工具暴露的三道闸门

| 闸门 | 位置 | 效果 | 代价 |
| --- | --- | --- | --- |
| `register(def, {when})` | 工具注册 | 每个 step 求值一次；false 时既不声明也不可调用 | 每次 step 一次同步判断，必须快、不能抛 |
| `tools.restrict({allow/deny})` | agent scope | 收窄**继承来的全局工具**；scoped 注册不受影响 | 集合变化会发 `tools/change`，进而影响 assembly |
| 执行器选择（native / PTC） | preset / agent | PTC 下模型只看到 `run_code`，其余能力变成 SDK 绑定 | 描述从 `tools[]` 搬到系统提示词的 `tools:sdk` 段 |

### 2.4 计量：有总量，没有明细

`token-meter` 把系统提示词与工具 schema 都按 `chars / 4` 计价（`estimateSystemMessage` / `estimateToolsTokens`），但：

- 只用于**上下文压力显示**，不产生 per-tool 明细；
- 没有预算、配额、告警；
- 不区分"工具 schema / 散文 / 召回内容"。

**所以 DSH 提供了全部机制，但没有"预算治理"这一层。**这正是本方案的立足点。

---

## 3. 插件侧：现在的提示词管理

### 3.1 槽位与顺序（`lib/host/prompt.js`）

| 段 | order | 来源 | 性质 |
| --- | --- | --- | --- |
| `deployment:persona-prefix` | 0（官方槽位） | 人格卡 / `persona.md` | 准静态 |
| `qqbot:guide` | 5100 | `buildToolGuide()` | **每轮动态**（随可见工具/能力/激活组变化） |
| `qqbot:memory` | 9400 | 按本轮 query 召回 | **每轮动态** |
| `qqbot:knowledge` | 9500 | 同上 | **每轮动态** |
| `qqbot:members` | 9600 | 发言人 + 被提及者 | **每轮动态** |
| `deployment:persona-suffix` | 10200（官方槽位） | 固定散文 + `{{qqbot_now}}` | **每轮动态**（时间） |

### 3.2 遮蔽：能遮蔽的与不能遮蔽的

`HOST_SECTION_SHADOWS` 遮蔽 4 个全局段（`harness:identity`、`ui:deliverable-file-references`、`harness:source`、`app:web-surface`）——这些是**全局层**注册的，agent scope 同名遮蔽成立。

但 `tool:*`（bash 92、read 160、write 92、edit 83、apply_patch 443、glob 71、grep 129、jobs 382、web_search 215、web_fetch 150，共 **1,817 字符**）由工具插件在 **agent scope** 注册。同层同名 = 抛错，一旦遮蔽会把工具插件一起挂死（代码注释记录了这次真机事故）。

> **`tools.restrict` 能收掉 schema，收不掉散文。**段注册与 schema 可见性是两条独立路径：工具插件把 `tool:*` 段注册在自己的作用域，`restrict` 只过滤 schema，不会 dispose 段。被 hold 的工具仍然在系统提示词里留下它的散文段。

### 3.3 工具策略：能力 → 档位 → 激活组（每轮覆盖）

- **能力开关**（`tools.capabilities`，默认 workspace/web/memory/messages/stickers/vision 开，shell/voice/skills/imagegen 关）：决定"准不准用"。
- **档位**（`TOOL_TIERS`）：`active` 常驻声明；`passive` 默认不声明，注册时挂 `when`。
- **激活组**（`ACTIVATION_GROUPS`）：一组触发词 → 整组点亮。`setActivation()` **每轮覆盖**，`addActivation()` 只在 turn 内追加（`lib/tools/activation.js:74`）。
- **别名**：`expandAliasedDefinitions()` 把 4 个正名展开成 8 个注册项（`lib/tools/aliases.js`）。

三个结论：

1. **激活是"组粒度"**：用户说"画一张"，点亮的不是 `generate_image` 一个，而是 imagegen 组 4 个 + `canvas` 组 2 个（11,694 字符）。
2. **激活是"轮粒度"**：下一轮不触发就全部消失，模型必须重新 `qqbot_enable` 或用户重新点名。
3. **档位可按能力覆盖**（`settings.tools.tiers` 支持工具名/组 id/能力名），为"按场景下发不同档位"留了口子，但控制台没有场景维度。

### 3.4 指引散文与 schema 重复

`buildToolGuide()` 产出的 1,267 字符里，真正没被 schema 描述覆盖的只有：能力边界、被动组清单、反臆造规则、历史检索与记忆的分工。其余（"要发图片用 qqbot_send_file"、"需要最新信息用 web_search"）与工具 description 逐字重复。

### 3.5 观测盲区（最要命的一条）

`buildLivePromptPreview()` 返回 `chars`（只统计 section 拼接后的字符数）和 `tools: [{name, tier}]`。**它把 31,000 字符的工具 schema 显示成"0 字符"**——控制台"提示词预览"页看起来只有 5,800 字符。运营者据此做的所有判断都是错的。

---

## 4. 实测

### 4.1 单请求工具负载分布（n=550 个请求头）

| 分位 | p10 | p50 | mean | p90 | max |
| --- | --- | --- | --- | --- | --- |
| 字符 | 12,062 | **31,036** | 29,822 | 36,807 | 36,824 |
| 工具数 | 7 | 36 | 35 | 43 | 43 |

直方图（按 5K 字符分桶）：10K 13 次、20K 95、25K 145、30K 152、35K 145。**"最坏情况"其实就是常态。**

### 4.2 最坏集的构成（43 工具 / 36,780 字符）

| 组 | 字符 | 占比 | 说明 |
| --- | --- | --- | --- |
| image-gen（`generate_image`、`generate_images`、`edit_image`、`find_inspiration`、`canvas_state`、`view_canvas`） | 11,694 | 31.8% | `edit_image` 单工具 4,679 |
| `qqbot_*` | 9,442 | 25.7% | 含 4 个别名 3,613 |
| 宿主 fs/shell（`bash`、`apply_patch`、`edit`、`write`、`read`、`glob`、`grep`、`read_image`、`working_directory`） | 8,106 | 22.0% | `bash` 单工具 2,280 |
| 记忆/知识/群友/历史（11 个） | 5,488 | 14.9% | 同质 CRUD 各自一套 schema |
| web/skill/jobs | 2,050 | 5.6% | |

### 4.3 逐工具成本与使用（418 次调用）

| 工具 | 字符 | 调用 | 每次调用代价 |
| --- | --- | --- | --- |
| `edit_image` | 4,679 | 11 | 425 |
| `generate_image` | 2,709 | 22 | 123 |
| `bash` | 2,280 | 93 | **25** |
| `generate_images` | 2,158 | 0 | — |
| `find_inspiration` | 1,233 | 0 | — |
| `apply_patch` | 1,182 | 0 | — |
| `edit` | 1,151 | 0 | — |
| `qqbot_send_card` | 1,128 | 0 | — |
| `qqbot_save_emote`（别名） | 1,110 | 1 | 1,110 |
| `qqbot_send_voice`（别名） | 928 | 3 | 309 |
| `qqbot_speak` | 859 | 46 | **19** |
| `web_search` | 323 | 35 | **9** |

**16 个零调用工具合计 11,616 字符**：用三分之一的负载换 0 次能力。

### 4.4 别名与失败率

- 已注册别名：`qqbot_save_emote`、`qqbot_send_voice`、`qqbot_send_image`、`qqbot_send_emote`（3,613 字符 / 9.8%）。
- 样本期别名救回：`qqbot_send_voice` 3 次、`qqbot_send_emote` 1 次、`qqbot_save_emote` 1 次（共 5 次）。
- 未覆盖的错名：`search_web` 2 次、`shell` 1 次、`image_generate` 1 次、`qqbot_send_text` 1 次。
- `tool/result` 里 unknown tool 共 **31 次 / 418 次调用 = 7.4%**。

结论：别名表只覆盖了"可预见的错法"，覆盖率约 50%，却要付 9.8% 的**每次请求**成本。用一次失败换 3,613 字符/请求是划算的。

### 4.5 系统提示词构成（live assembly，各段合计 5,789 字符）

| 段 | 字符 | 性质 |
| --- | --- | --- |
| `deployment:persona-prefix` | 1,482 | 准静态 |
| 宿主 `tool:*` 散文（10 段） | 1,817 | 静态但不可遮蔽 |
| `context:file-reference` | 407 | 静态 |
| `qqbot:guide` | 1,267 | **每轮变** |
| `qqbot:memory` + `knowledge` + `members` | 713 | **每轮变** |
| `deployment:persona-suffix` | 103 | **每轮变**（时间） |

（另有 6 个宿主段被遮蔽为空，不计入。）

---

## 5. 根因诊断

| # | 根因 | 证据 | 影响 |
| --- | --- | --- | --- |
| R1 | 能力清单按"能用就用"设计，不按"用得多才常驻" | 16/43 工具零调用，11,616 字符 | 31.6% 负载 |
| R2 | 激活是组粒度：一个触发点亮一整组 | imagegen 组 4 个 + canvas 组 2 个 = 11,694 | 单轮峰值 36.8K |
| R3 | 别名用 schema 实现 | 3,613 字符，覆盖率约 50% | 9.8% 负载 |
| R4 | 动态内容进了 system section | guide/memory/knowledge/members/suffix 共 2,083 字符每轮变 | 约 37K 字符前缀无法命中缓存 |
| R5 | 散文与 schema 重复 | guide 1,267 中约 700 与 description 重复 | 2% 负载 + 两处措辞不一致 |
| R6 | 没有预算与观测 | 预览只报 section 字符；token-meter 无明细 | 决策无据，回归无感 |
| R7 | 路由级省流不可用 | pi-ai `conversationUpdates()` 返回空；`deferLoading` 被过滤 | 只能"少声明"，不能"晚声明" |

---

## 6. 方案

### 6.0 四条设计原则

1. **预算优先于清单。** 先定"每请求最多多少字符"，再决定声明谁；用确定性打包器保证不超预算。
2. **稳定优先于最小。** 前缀缓存的价值随负载线性增长：37K 字符的稳定前缀 ≈ 9.2K tokens 的缓存命中。宁可多声明 2 个工具，也不要每轮改集合；宁可整租一次租 5 轮，也不要每轮重算。
3. **单一真相。** "什么时候用这个工具"只写在工具 `description`（schema 里）或只写在 guide，不许两处都写。
4. **可观测才能治理。** 任何策略都必须能被 `scripts/prompt-budget.mjs` 和 CI 断言测量到。

### 6.1 P0：观测与预算（先做，1 天量级）

**产出**

1. `scripts/prompt-budget.mjs`（本次已交付）：从 session 日志实测工具负载/构成/使用/失败率，只读、支持 `--json`。
2. 控制台 `GET /api/preview/prompt` 增加 `budget` 字段：

       {
         "toolChars": 31036, "toolTokens": 7759, "systemChars": 5782, "fixedChars": 36818,
         "tools": [{ "name": "bash", "chars": 2280, "tier": "active", "source": "host" }],
         "budget": { "maxChars": 16000, "used": 31036, "over": 15036 },
         "warnings": ["imagegen 组激活使本请求 +11694 字符"]
       }

   实现：`buildLivePromptPreview()` 已经拿到 `assembly.tools`（完整 schema），只需补 `JSON.stringify` 计价；`buildPromptPreview()`（模拟拼合）用 `agentCtx.tools.view` 的 definition 做同样计算。
3. SQLite 表 `tool_usage`（`bot_id, peer, tool, calls, last_used_at, first_seen_at`），由 `ctx.on('tools/result')` 只读累加（该事件是 observe-only，不改结果）。这是 P3"使用驱动档位"的数据基础。
4. CI 门禁：`npm run budget:check` 跑 `prompt-budget.mjs --json`，断言 `toolChars <= maxChars`、`unknownToolRate <= 0.05`。

**验收**：控制台能一眼看到"这次请求 31,036 字符里，imagegen 占 11,694"。

### 6.2 P1：静态化与缓存（半天到 1 天）

把每轮变化的内容从 section 迁到 `systemPrompt.context()`：

| 现在（section） | 改为（context） | 说明 |
| --- | --- | --- |
| `qqbot:memory` / `knowledge` / `members` | `context({name:'qqbot:recall', order:9400, required:true})` | 快照只在变化时追加，系统提示词保持逐字稳定 |
| `deployment:persona-suffix` 里的"现在是 …" | `context({name:'qqbot:clock', ...required:true})` | 时间每轮都变，留在 section 等于每轮弃疗缓存 |
| `qqbot:guide` 中随激活状态变化的部分 | 拆成静态规则段 + `context('qqbot:lease')` | 只把"本轮新点亮的工具"这段放进 context |

**为什么 `required: true`**：插件默认调用 `suppressRuntimeContext()`（chatonly 语义），非 required 的 context 会被一并抑制；required 的会保留（`SystemPrompt.assemble()` 里 `!runtimeContextSuppressed || entry.required === true`）。

**收益**：系统提示词从"每轮变化"变成"每轮相同"，工具 schema 本来就稳定 → 整个约 37K 字符前缀可被 provider 前缀缓存命中（DeepSeek/OpenAI 系命中价通常为 10%）。**这是本方案里 ROI 最高的一条，且不改任何工具。**

**风险与回退**：召回内容从 system 角色变成 user 角色快照。若模型对角色敏感，回退开关 `persona.recallAsContext=false` 即可退回 section。

### 6.3 P2：清单瘦身（主力，2–3 天）

按"每次请求省多少字符"排序，逐条独立可回退（每条一个 setting 开关）。

| 步骤 | 动作 | 省（字符/请求） | 风险 | 缓解 |
| --- | --- | --- | --- | --- |
| P2-a | **别名下线**：不再 `expandAliasedDefinitions` 注册；别名表保留用于 allow/deny/激活归属与失败救援 | 3,613（样本内 4 个别名全部在场） | 错名失败 +5 次/418 调用 | 失败救援（6.4.5）：unknown tool 时回一条"正名是 X"，并**会话内临时注册该别名**；`qqbot_speak` 保留一个别名做对照 |
| P2-b | **QQ 无关工具全部转 cold**：`canvas_state`、`view_canvas`、`find_inspiration`、`generate_images`、`apply_patch`、`working_directory` | 5,848（6 个工具之和） | 需要 canvas 时不可用 | 群聊/单聊场景下 canvas 本就不可达（工作台在 Web 侧）；保留 `qqbot_enable` 点亮通道 |
| P2-c | **imagegen 组拆细**：常驻只剩 `generate_image`；`edit_image` 由"改图/修图/重绘/把这张…"点亮；其余 cold | 4,679（非改图轮不再声明 `edit_image`） | 用户说"改一下"没命中触发词 | 触发词补 `改一下`、`把这张`、`换成`；在 `generate_image` 的 description 里写"要改已有图请先说'改图'" |
| P2-d | **同质 CRUD 合并**（可选，工作量大）：`memory_*` 4→1、`knowledge_*` 3→1、`member_*` 2→1、`chat_history_*` 2→1，用 `action` 分发 | 约 3,400（11→4） | 参数校验/错误定位变弱 | 先做 `memory_*` 一组 A/B，指标是调用成功率与 token |
| P2-e | **散文去重**：guide 从 1,267 → ≤600，只留"能力边界 + 被动组清单 + 反臆造 + 历史/记忆分工" | 约 650 | 跨工具策略丢失 | 逐条对照 schema 文本去重，保留差异项 |

**不能做的一条**：宿主 `tool:*` 散文（1,817 字符）**不能用 shadow 去掉**（同层重复注册会抛错，会把工具插件挂死——`lib/host/prompt.js:73-80` 记录了事故）。正确路径是让这些工具**不被声明**（restrict 掉后散文仍在，这是上游行为），或在 preset 层不挂载对应工具插件——但那会失去 `restrict` 对它们的动态控制权（scoped 注册不受 restrict 影响），与 P3 冲突。**本方案选择"接受这 1,817 字符"，并在预算表里把它列为固定成本。**

### 6.4 P3：暴露策略（结构改造，3–5 天）

#### 6.4.1 三档 + 预算

| 档 | 语义 | 预算 |
| --- | --- | --- |
| `always` | 每轮声明 | 常驻集合 ≤ `budget.maxChars`（默认 12,000，可配） |
| `leased` | 触发/点名后声明，**租约 TTL**（默认 5 轮或会话结束），期间不撤销 | 计入预算；超预算时按优先级裁决 |
| `cold` | 只能 `qqbot_enable` 临时点亮（当前轮） | 不计入常驻预算 |

#### 6.4.2 预算打包器（确定性）

    // lib/host/budget.js —— 纯函数，可单测
    pack({ candidates, budgetChars, activeNow, usageScore }) -> { declared, held, over }

- 候选 = `collectDiscovered(view)` 里的可见工具，字符数用 `JSON.stringify({name, description, parameters}).length`（`view.visible` 有完整 definition，无 IO）。
- 排序键（**固定、无随机**）：`(本轮激活?0:1, 档位 always?0:1, -usageScore, chars, name)`。同样输入必然同样输出 → 不制造无谓的 `tools/change`。
- 截断：超预算的候选降级为 `held`，并在 guide 追加一行"本轮因预算未声明：X、Y（用 qqbot_enable 点亮）"（约 40 字符）。

#### 6.4.3 租约（替代"每轮覆盖"）

`setActivation()` 的覆盖语义改为"合并 + 过期"：

    lease = { groups: Map<id, expiresAtTurn>, tools: Map<name, expiresAtTurn> }
    route(turn): 1) 清理过期 2) 本轮触发词 → 续租 3) 返回 isActive

- 默认 TTL = 5 轮（配置 `tools.leaseTurns`）；`qqbot_enable` 显式点亮 = 会话级。
- 租约只在**轮边界**变化 → 同一次请求内的所有 step 看到同一集合 → 同 turn 内不会抖动。

#### 6.4.4 场景档

`settings.tools.scenes = { group, c2c, owner }`：按 peer 前缀与发送者身份选择档位。典型差异：群里默认不给 `bash`/`write`（2,280+854），单聊或 owner 才给。这把 22% 的宿主 fs/shell 负载按场景切分。

#### 6.4.5 失败救援（替代别名 schema）

在 `tools/post-execute` 里观察 `UNKNOWN_TOOL`：

1. 若无匹配 → 原样返回，但**附加**一条提示（不额外占 schema）："未知工具 X。可用工具：…（如需 Y，先用 qqbot_enable）"；
2. 若命中别名表 → 在**会话内**临时注册该别名（与正名同实现的浅拷贝定义），并返回"已为你切换到 `qqbot_speak`，请重试"；只有真的被猜错过一次，才付这份 schema 钱；
3. 统计命中率进 `tool_usage`：连续 N 次命中同一别名时，控制台提示"建议把 X 设为 always"。

**收益**：基线省 3,613 字符；别名覆盖率从 50%（4 个固定别名）提升到"按需覆盖"（任何被猜错的名字都能救，包括 `search_web`、`shell`、`image_generate`、`qqbot_send_text`）。

### 6.5 P4：结构选项（PTC，评估而非立即采纳）

PTC 执行器只声明 `run_code`，其余工具的 description 变成系统提示词里的 SDK 块。对 QQ 机器人：

| 维度 | native（现状） | PTC |
| --- | --- | --- |
| `tools[]` 负载 | 36,780 字符 | 约 1,600（1 个 schema） |
| 系统提示词 | 约 5,800 | 增加 SDK 块（随工具数线性增长，粗估 0.6–0.8× 原 JSON） |
| 门控能力 | `when`/`restrict` 精确到工具 | SDK 按可见集合生成，`restrict` 仍生效，但集合变化要重写 SDK 文本 → 缓存不友好 |
| 失败面 | 参数校验错误 | 多一类：写错代码（`CODE_RUN_FAILED`） |
| 额外收益 | — | 一次 `run_code` 可并行多个工具调用，减少往返 |

**建议**：先做 P0–P3，把 native 负载压到 15K 以内；届时 PTC 的相对收益缩短，**不做**。若 P0 数据显示"每请求平均工具调用 > 2.5 次"（当前样本 418 调用 / 约 464 次请求 ≈ 0.9，未达到），再评估 PTC。

### 6.6 目标态与预算算术

以最坏集（43 工具 / 36,780 字符）为基准：

| 步骤 | 变化 | 累计最坏负载 | 相对基准 |
| --- | --- | --- | --- |
| 现状 | — | 36,780 | 100% |
| P2-b QQ 无关冷备（6 个工具在基准集里都出现） | −5,848 | 30,932 | 84% |
| P2-a 别名下线 | −3,613 | 27,319 | 74% |
| P2-c imagegen 拆细（`edit_image` 只在改图轮声明） | 最坏（改图）轮不变；非改图轮 −4,679 | 27,319 / 22,640 | 74% / 62% |
| P3 预算封顶（12K 常驻 + 4K 租约） | 硬上限，任何轮都不超 | **约 16,000** | **43%** |
| P1 静态化 | 不改字符，只让前缀可缓存 | 约 16,000 | 有效成本 ≈ 43% × 命中折扣 |

对应 tokens：9,195 → **4,000**（chars/4）；系统提示词 1,866 不变。单请求固定开销从 10,641 降到 5,800 量级。

---

## 7. 实施计划

| 迭代 | 内容 | 关键文件 | 测试 | 验收 | 回退 |
| --- | --- | --- | --- | --- | --- |
| I0（1 天） | prompt-budget 脚本 + 预览 API 加 `budget` + `tool_usage` 表 + CI 门禁 | `scripts/prompt-budget.mjs`、`lib/host/preview.js`、`lib/console/api/preview.js`、`lib/core/db/*` | `test/prompt-budget.test.js`（纯函数 + 真实 header fixture） | 控制台能看到 per-tool 字符与占比 | 只读，无需回退 |
| I1（1 天） | 动态段迁 `context()`；`required` 语义；开关 `persona.recallAsContext` | `lib/host/prompt.js`、`lib/host/preview.js`、`test/host-prompt.test.js` | 段/上下文快照断言；连续两次 `assemble()` 渲染逐字相等 | 连续两轮 `renderPrompt` 相同 | 关开关 → 回 section |
| I2（2 天） | P2-a/b/c + guide 去重 | `lib/tools/index.js`、`lib/tools/catalog.js`、`lib/host/tools.js`、`lib/tools/aliases.js` | `test/tools-catalog.test.js`、`test/host-prompt.test.js`、`test/tools-activation.test.js` | 改图轮 ≤ 27.4K、常规轮 ≤ 22.7K；零调用工具 ≤ 6 个 | 每个动作一个 setting 开关 |
| I3（3 天） | 租约 + 打包器 + 失败救援 + 场景档 | `lib/tools/activation.js`、新 `lib/host/budget.js`、`lib/host/tools.js` | 打包器纯函数（确定性、边界）；救援单测 | 常驻 ≤ 12K；`unknownToolRate` 不升（≤ 7.4%） | `tools.budget.enabled=false` |

**上线顺序**：I0 → I1（无行为变化，纯收益）→ I2（逐条开关）→ I3（观察一个发布周期）。

**观测指标（每个迭代都要看）**

- `toolChars`（p50/p90）、`toolsCount`、每会话工具集变更次数
- `unknownToolRate`、租约命中率（点亮后真的被调用）
- provider 侧缓存命中（若上报，如 DeepSeek `prompt_cache_hit_tokens`）
- 每会话 token 与费用

---

## 8. 风险与权衡

| 决策 | 反对意见 | 缓解 / 判据 |
| --- | --- | --- |
| 别名下线 | "模型猜错名就多一轮失败，用户能看见卡顿" | 失败救援把代价从"一轮"降到"一轮 + 一条纠正"；且现在别名只覆盖一半错法。上线后看 `unknownToolRate`，超过 10% 就回退单个别名 |
| imagegen 拆细 | "用户说'改一下'没触发，能力退化" | 触发词 + description 显式引导；A/B 看 `edit_image` 调用成功率 |
| 动态内容迁 context | "模型把召回当成用户说的话" | 回退开关；先只迁 memory/knowledge/members，时间单独迁 |
| 预算封顶 | "预算裁掉的工具恰好是本轮要用的" | 打包器第一优先级是"本轮激活"，激活永不被裁；被裁的一定是本轮没触发的 |
| 租约 TTL | "工具消失后模型继续调用 → unknown tool" | 租约只在轮边界变化，同一 turn 内不撤销；`qqbot_enable` 无限期 |
| 合并 CRUD 工具 | "schema 清晰度换字符数，得不偿失" | 列为可选（P2-d），先单组 A/B，指标不达标不推广 |

---

## 9. 附录

### A. 逐工具实测表（最坏集 43 工具）

| 工具 | 字符 | 调用 | 建议档位 |
| --- | --- | --- | --- |
| edit_image | 4,679 | 11 | leased |
| generate_image | 2,709 | 22 | leased（或 always） |
| bash | 2,280 | 93 | always（owner）/ leased |
| generate_images | 2,158 | 0 | cold |
| find_inspiration | 1,233 | 0 | cold |
| apply_patch | 1,182 | 0 | cold |
| edit | 1,151 | 0 | leased |
| qqbot_send_card | 1,128 | 0 | leased |
| qqbot_save_emote（别名） | 1,110 | 1 | 删除 |
| qqbot_sticker_save | 1,034 | 4 | always |
| qqbot_send_voice（别名） | 928 | 3 | 删除 |
| qqbot_describe_image | 866 | 3 | leased |
| chat_history_search | 861 | 1 | always |
| qqbot_speak | 859 | 46 | always |
| write | 854 | 1 | leased |
| qqbot_send_image（别名） | 809 | 0 | 删除 |
| qqbot_send_emote（别名） | 766 | 1 | 删除 |
| glob | 750 | 11 | leased |
| qqbot_send_file | 736 | 35 | always |
| grep | 702 | 4 | leased |
| member_lookup | 702 | 7 | always |
| qqbot_send_sticker | 690 | 9 | always |
| knowledge_search | 683 | 7 | always |
| memory_save | 640 | 4 | always |
| job_output | 615 | 0 | leased |
| qqbot_quote_reply | 516 | 0 | always（引用是 QQ 基本交互） |
| view_canvas | 486 | 0 | cold |
| knowledge_save | 477 | 2 | leased |
| chat_history_recent | 448 | 0 | always |
| read | 438 | 9 | leased |
| canvas_state | 429 | 0 | cold |
| member_note | 423 | 0 | leased |
| memory_search | 391 | 11 | always |
| read_image | 389 | 33 | leased |
| job_kill | 370 | 0 | cold |
| memory_list | 363 | 4 | always |
| working_directory | 360 | 1 | cold |
| skill | 332 | 11 | always |
| web_search | 323 | 35 | always |
| memory_read | 252 | 0 | always（与 search 同族） |
| knowledge_read | 248 | 0 | always（与 search 同族） |
| web_fetch | 242 | 36 | always |
| job_list | 168 | 0 | leased |

### B. 复现

    node scripts/prompt-budget.mjs --bot bot_fb891494bb5d --sessions 12
    node scripts/prompt-budget.mjs --bot bot_fb891494bb5d --json > budget.json
    curl -s -b cookie.txt "http://127.0.0.1:6198/api/preview/prompt?bot=<id>&peer=<peer>" | jq '.sections[] | select(.kind=="host") | {name, chars}'

### C. 术语

- **固定开销**：每次请求都要发送、与对话长度无关的部分 = 工具 schema + 系统提示词。
- **前缀缓存**：provider 对请求前缀做 KV 复用；前缀任意位置变化即失效。
- **租约（lease）**：被动工具被点亮后的一段有效期内保持声明，避免逐轮翻转。
- **打包器（packer）**：在预算内选择声明哪些工具的确定性函数。
