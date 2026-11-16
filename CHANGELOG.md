# 变更记录

本项目遵循语义化版本；当前处于 `1.0.0` 的预发布阶段。发布先落 `next`，验收通过后提升 `latest`。

## 1.0.1-alpha.2（2026-11-16，仅本地 commit，未发布）

### 新增：知识库分类 / 置信度 / 治理（可调阈值）

- 知识分类 `kind`：`meme`（梗/角色/黑话）/ `fact`（定义/事实）/ `lookup`（查证资料）/
  `rule`（真·群规）/ `other`，`knowledge_save` 新增 `kind/confidence/authority/sourceUrl/fetchedAt/pinned` 参数，
  source 自动拼成 `kb:<kind>:<slug>`，同主题原地覆盖。
- 治理元数据落库（migration v12）：`kind/confidence/authority/pinned/recall_count/last_recalled_at/stale_at/stale_reason`。
- **保护位优先**：`pinned` / `kind=rule` / `authority=member|admin` / 历史未分类（v1 迁移）永远不参与自动清理；
  群友写的群规/梗默认 `pinned=1`，并每轮注入（`【常驻知识】`，预算 `kb.pinnedInjectChars`），不依赖召回率。
- 召回统计：`kb.search` 命中时给文档记召回（1 小时节流），供治理判断热度。
- 知识治理 `kb.hygiene`：置信度低 + 召回少的知识软归档（可恢复），归档满 `kb.archiveTtlDays` 再物理删除；
  默认阈值全部调短：置信度阈值 40 / 零召回观察 14 天 / 冷召回观察 45 天 / 归档保留 **7 天**，均可在「配置档 → 知识库」调整。
- 控制台知识库页：分类/置信度/召回/保护位列，分类筛选、显示已归档、「知识体检」（先干跑预览再执行）、恢复归档。

## 1.0.1-alpha.1（2026-11-16，仅本地 commit，未发布）

这一版把 11-14 以来的修复与重构收进一个可回滚的提交（暂不 push、不 npm publish）。

### 新增

- **长期记忆可修改**：新增 `memory_update` 工具（状态变化改旧记忆而不是叠加新状态）；
  自动提炼命中近似去重时用新文本覆盖旧记忆；控制台记忆页支持编辑（`PUT /api/memories/:id`）。
- **知识库文档可编辑**：`GET /api/kb/docs/:id` 返回文档 + 分块，`PUT /api/kb/docs/:id` 按同 source 原地重建
  （docId 不变、FTS 同步）；控制台知识库页新增编辑抽屉。
- **工具页重构**：顶部统计卡（每轮发送 / 待唤醒 / 不可用 / 技能）、会话诊断独立页签、
  单一「装配状态」列替代「已装载/已声明/索引中」三列，去掉「可见/不可见」黑话；
  新增「刷新发现 / 清理失效」。

### 修复

- 生图/改图：被动能力激活后，被 `tools.restrict` 藏起来的全局工具无法重新放回 schema
  （`qqbot_enable` 报成功但下一步 unknown tool）——发现清单改为并入 `knownNames ∩ restrictableNames`。
- 记忆提炼把「生图工具报错」等临时故障写成长期事实：提示词加硬约束 + `isTransientToolNoise` 入库前过滤。
- 语音：`qqbot_enable` 装载校验只查能力开关、忽略白名单显式放行，导致「工具页显示索引中、模型却被拒」；
  统一改用 `groupAllowed`（工具页/激活/索引/装载同一口径）。
- 工具页装配状态误标：`canvas_state`/`view_canvas`（按需档却标每轮发送）、`working_directory`、
  force 注册的 `qqbot_enable`（不在白名单却标不可用）。

## 1.0.0-rc.1（2026-11-15）

与 `1.0.0-alpha.6` 代码一致，改动集中在版本号与发布流程：

- 版本号进入 RC：`npm publish` 先发 `next`，跑完独立安装验收再提升 `latest`
  （当前 `latest` = `next` = `1.0.0-rc.1`，所以带不带 `@next` 装到的都是这一版）。
- 仓库默认分支改为 `v2`；v1 线（`v0.21.0` 及之前）归档为 `v1-legacy` 分支 + `v1-archive` 标签。
- README 改为纯文本（控制台实拍集中在 `docs/SCREENSHOTS.md`），GitHub 安装命令去掉 `#v2`（默认分支即 `v2`）。
- 发布包仍不含 `docs/images/`、`docs/SCREENSHOTS.md` 与本地自定义模板。

## 1.0.0-alpha.6（2026-11-15）

### 新增

- **群日报**：定时（默认 23:30）按群汇总当天群聊并主动发送卡片；内置纸刊 `journal` 与深色 `dark` 两套模板，
  `/daily` 可手动生成。
- **自定义模板插槽**：`<dataDir>/templates/<名字>/index.html`，可选 `meta.json`（标题、描述、visuals 插画槽）与 `assets/`；
  控制台「群日报」页可实时预览、切氛围（模型选择 / 随机 / 指定）、一键应用与安装模板。
  随包自带最简示例模板 `custom/templates/minimal`（只用 HTML/CSS 读 `__CARD_DATA__`，不带任何素材）；
  需要按氛围换插画的模板，在 `meta.json` 里声明 `visuals`（槽位 / 素材 / 氛围 / 预设）即可，宿主动态内联素材。
- **关系增量**：每日按互动调整群友 affinity（-2..2），带证据校验、冷却与周上限，结果写审计。
- **消息流水**：新增 `flow_messages` 全量群消息层（门控前落库，含没 @ 的旁观发言），
  与原有的触发轮次 `messages` 分开配置保留期。
- **语音识别（ASR）**：入站 QQ 语音可走 DeepSeek 官方 / MiMo / OpenAI 兼容 / 本地 faster-whisper 转写，
  失败回退 QQ 自带识别；模型中心新增「语音识别」tab。
- **dsh Web 客户端入口**：通过 `dsh.client` 声明贡献客户端模块，在 dsh Web 会话头部「…」菜单里加「QQBot 大屏」，
  由 Host 半的同源 `/qqbot-dashboard` 302 跳到控制台。
- **深色主题**：自动 / 浅色 / 深色三态，顶栏一键切换，首屏由内联脚本防闪烁，登录页与全部页面同步。
- **审计日志页**：控制台集中查看 bot / 配置档 / 工具策略等写入操作。

### 改进

- 控制台信息架构重组：配置档的 15 个设置分节收敛为 5 个组 tab（对话与人设 / 模型与语音 / 能力与权限 / 记忆与数据 / 群日报），
  新增「模型」「群日报」「审计日志」页，去掉独立的「设置」页。
- 工具与技能页改为**装配三态**（已装载 / 已声明 / 索引中）与常驻 / 按需档位，配合索引指南让模型按需 `qqbot_enable`；
  支持「这里不声明」的轻量档位。
- 提示词拼合预览：有 live 会话时展示模型真正收到的分段与字符数，没有时回退模拟拼合，并提供提示词预算测算。
- TTS 供应商按 **默认音色 / 音色克隆 / 文字设计 / 语音识别** 四块拆分配置，新增 DeepSeek、MiniMax（默认 / 克隆 / 设计）、
  MiMo（克隆 / 设计）适配器，克隆样本可用文件选择器选本机音频。
- 发布包自带 `custom/templates/`，`npm run template:install -- minimal` 在 npm 安装后同样可用。
- 发布包不再携带 `docs/images/` 与 `docs/SCREENSHOTS.md`（截图只服务 GitHub），包体积 5.0 MB → 700 KB 量级。
- README 不再内嵌截图（npm 上的说明保持纯文本），控制台实拍统一放到 `docs/SCREENSHOTS.md`。

### 修复

- 卡片 / 转发 / 引用消息的结构化渲染与 `msgId` 引用补充。
- 工具自愈：会话重启后丢失插件工具时自动补挂，`/heal` 支持无 agent 时自建会话。
- 兼容别名与「不要臆造工具」提示，减少模型调用不存在的工具名。

### 打包与发布

- `package.json` 新增 `engines.dsh`（`>=0.2.2-0 <0.3.0`）与 `publishConfig`（`access: public`、`tag: next`）。
- 新增 `scripts/verify-standalone-install.mjs`（`npm run verify:standalone`）：`npm pack` 产物在全新 `DSH_HOME` 里的安装验收。
- 新增 `test/package-manifest.test.js`：守住发布包清单、导出路径、dist-tags 与 README 链接。

## 1.0.0-alpha.5（2026-11-12）

- fix(tools)：工具兼容别名与反臆造规则；`/heal` 支持无 agent 时自建会话。
- feat：消息流水与记忆闭环、卡片 / 转发 / 引用结构化渲染、工具自愈、模型中心与语音。

## 1.0.0-alpha.0 ~ 1.0.0-alpha.4

早期迭代：独立控制台与 REST API/SSE、配置档与作用域绑定、工具与技能白名单、SQLite + FTS5 记忆与知识库、
群友库 / 人格卡 / 表情包、图片与卡片发送、从 v1 数据迁移。逐次变更为 `git log` 记录。
