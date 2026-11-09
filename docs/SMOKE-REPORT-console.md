# 控制台发布收尾验收报告（task-13）

> 任务：发布前收尾——新页配图 + 全新安装回归 + v4 迁移后控制台交叉验证。
> 结论先行：**全部通过**。配图 5 张（1440×900，均 <120KB）已内嵌 USER-GUIDE；隔离 DSH_HOME
> 全新安装 + 控制台 E2E 20/20 通过；v4 迁移后控制台交叉验证 8/8 通过；\`npm test\` 411/411 全绿；
> 无本任务遗留进程/端口。
>
> 关联报告：[SMOKE-REPORT.md](SMOKE-REPORT.md)（integration-dev 的真实 dsh 冒烟与冷会话探针）。

## 1. 环境事实

| 项 | 值 |
|---|---|
| 时间 | 2026-11-09 19:49–19:59（Asia/Shanghai） |
| 工作树 | \`d637da9\`（发布收尾提交；本报告与 USER-GUIDE 小补充在其后，未改代码逻辑） |
| Node（安装/回归） | v24.22.2（\`/home/qiqi/.nvm/versions/node/v24.22.2/bin/node\`） |
| Node（\`npm test\`） | v22.23.2（默认 \`node\`；按 DESIGN §8 两个版本都应跑通） |
| dsh | 0.2.2-rc.1 |
| 浏览器 | Playwright 1.65.0 + 已缓存 chromium-1243（通过 \`executablePath\` 复用，未联网下载新浏览器） |
| 演示控制台 | \`node scripts/dev-console.mjs .work/shots-data 6222\`（仅本机） |
| 隔离安装 | \`DSH_HOME=<repo>/.work/release-check/dsh-home\`，控制台 \`127.0.0.1:6223\`，dsh web \`127.0.0.1:33081\` |
| 隔离视图 | live profile（\`~/.dsh\`）全程未触碰 |

## 2. 控制台新页配图

### 2.1 产出

| 文件 | 页面 | 尺寸 | 大小 |
|---|---|---|---|
| \`docs/images/console-overview.png\` | 总览（侧边栏状态已修） | 1440×900 | 116.0 KB |
| \`docs/images/console-memory.png\` | 记忆 | 1440×900 | 97.3 KB |
| \`docs/images/console-members.png\` | 群友库 | 1440×900 | 103.2 KB |
| \`docs/images/console-personas.png\` | 人格卡 | 1440×900 | 114.1 KB |
| \`docs/images/console-stickers.png\` | 表情包 | 1440×900 | 106.4 KB |

合计约 524 KiB；单张均 <200KB（任务上限），PNG 24bit。

### 2.2 已内嵌到 USER-GUIDE

\`docs/USER-GUIDE.md\` 用相对路径 \`![](images/console-*.png)\` 内嵌（发布包 \`files\` 含 \`docs/**\`，
安装后可直接显示）：

- §2.5 控制台页面一览 → 总览
- §6.2 人格卡 → 人格卡页
- §7.1 长期记忆 → 记忆页
- §7.3 群友库 → 群友库页
- §7.4 表情包 → 表情包页

原先引用 \`.work/shots\` 的内部占位已全部替换（\`.work\` 不随包发布）。

### 2.3 截图流程

1. 补 \`scripts/dev-console.mjs\` 演示数据：群友 3 人（含画像/备注）、人格卡 3 张（1 张生效，
   激活走 store 并写 \`persona.md\`）、表情包 3 个（真实 PNG 文件 + emotion + hash，并预置当日发送 2 次）。
2. 修复该脚本在新版插件上的失效：\`lib/index.js\` 的 \`apply()\` 不再返回 runtime（避免 cordis
   \`Invalid effect\`），脚本改用 \`getRuntime()\`，否则会 \`TypeError: Cannot read properties of undefined\`。
3. 起演示控制台：\`node scripts/dev-console.mjs .work/shots-data 6222\`（token 在
   \`.work/shots-data/console-token.txt\`）。
4. Playwright（headless，1440×900，locale zh-CN）通过 \`context.request\` 登录后逐页截图：
   每页等待目标数据文本渲染 + 900ms 稳定，控制台 **无 pageerror / console error**。
5. 校验：5 张均为 1440×900 RGB PNG、单张 <200KB；页面中无绝对路径等异常内容（表情包文件路径已用
   相对路径 seed）。

## 3. 全新安装回归（隔离 DSH_HOME）

### 3.1 步骤

\`\`\`sh
cd /home/qiqi/project/dsh-qqbot-buddy-v2
export PATH=/home/qiqi/.nvm/versions/node/v24.22.2/bin:$PATH
export DSH_HOME=$PWD/.work/release-check/dsh-home
rm -rf .work/release-check

# 0) 初始化随附 web profile（重要：全新 DSH_HOME 先让 dsh 生成 base/web profile）
dsh --profile web --dump-config

# 1) 本地安装（复制仓库 + 登记 bundle + dump-config 自检）
node scripts/install.mjs --local --profile web

# 2) 断言插件进入插件树（输出 5 处 qqbot-buddy 命中）
dsh --profile web --dump-config | grep -c qqbot-buddy

# 3) 隔离 patch：控制台 6223 + 独立 dataDir/workspace（见 .work/release-check/dsh-home/profiles/web/cordis.patch.yml）
# 4) 启动隔离实例
dsh web --port 33081
\`\`\`

实测：安装器退出码 0，日志「已确认 qqbot-buddy 进入插件树」；profile bundles =
\`[@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-qqbot-buddy]\`；
dsh web 正常启动，控制台 \`http://127.0.0.1:6223\`，\`/api/health\` 返回
\`{ok:true, version:"1.0.0-alpha.0"}\`，token 首次生成（\`.work/release-check/data/console-token.txt\`）。

### 3.2 控制台 E2E（20/20 通过）

脚本：\`.work/qa/release-e2e.mjs\`（临时，不提交）；结果 JSON：\`.work/release-check/e2e-results.json\`。

| # | 用例 | 结果 |
|---|---|---|
| 1 | health 无需鉴权（200） | PASS |
| 2 | 未登录 state=401 | PASS |
| 3 | 错误 token 登录=401 | PASS |
| 4 | 正确 token 登录=200 且下发 HttpOnly cookie | PASS |
| 5 | state 可读、初始 bots 为空 | PASS |
| 6 | 写操作缺 CSRF=403 | PASS |
| 7 | 新建 bot=200 | PASS |
| 8 | bot 工作目录已建立（\`<workspace>/bots/<id>\`） | PASS |
| 9 | 无凭据 start-bot → 400 \`start_failed\` + 可读中文（含「缺少 AppSecret」） | PASS |
| 10 | 未知动作 → 400 \`action_failed\` + 「未知动作: not-exist」 | PASS |
| 11 | 群友库 upsert 合并：空值不冲掉已有备注 | PASS |
| 12 | 人格卡激活并原子写 \`persona.md\`（内容逐字一致） | PASS |
| 13 | 表情包 hash 去重 + 配额 + 删除同时删文件 | PASS |
| 14 | 记忆写入/列表/检索（fts） | PASS |
| 15 | 知识库入库 + docs（chunkCount） | PASS |
| 16 | KB 标题词检索（schema v4，\`titleHit=true, score=1\`） | PASS |
| 17 | KB 正文 FTS + 2 字 LIKE 回退 | PASS |
| 18 | 设置读写（扁平点号键，\`reply.mode=adaptive\`） | PASS |
| 19 | 审计记录写操作（bot.create/persona.activate/kb.ingest 等） | PASS |
| 20 | 登出后会话失效（state=401） | PASS |

关键样例（start-bot 无凭据）：

\`\`\`json
{"error":{"code":"start_failed","message":"QQ 机器人 「发布回归机器人」(bot_…)：缺少 AppSecret：请在控制台「机器人」页填写 …"}}
\`\`\`

### 3.3 发现（已写入 USER-GUIDE）

**在全新 DSH_HOME 上直接 \`--local\` 安装会装出一个不完整 profile**：\`scripts/install.mjs\` 在
profile 不存在时会写一个最小 \`package.json\`，只含本插件 bundle，缺少随附的
\`@deepseek-ai/dsh-base\` / \`@deepseek-ai/dsh-web-app\`，导致 dsh 启动时插件 \`pending\`
（waiting for service: agents）并退出。

- 复现：\`DSH_HOME=<空目录>\` → \`node scripts/install.mjs --local --profile web\` → \`dsh web\` →
  日志 \`2 entries did not activate … pending (waiting for service: agents)\`。
- 规避（本次回归采用，已补进 USER-GUIDE §1.2）：安装前先跑一次
  \`dsh --profile web --dump-config\`（或 \`dsh web\`）初始化随附 profile，再 \`--local\` 安装。
- 建议安装器 owner 修复：\`--local\` 前检测 profile 是否缺少 \`dsh.profile.bundles\` 的 shipped 项，
  自动触发一次 profile 初始化（integration-dev 的 \`scripts/smoke-dsh.mjs\` 同样显式做初始化）。

## 4. v4 迁移后控制台交叉验证（8/8 通过）

模拟「已有 v3 存量数据的用户升级到 v4」：手工构造 \`user_version=3\` 的库（\`kb_chunks\` 无
\`title\` 列，含 2 个存量 chunks），用 \`openDb\` 触发 v4 迁移，再起**真实控制台服务**走公开 API。

结果 JSON：\`.work/release-check/v4-migration/v4-check-results.json\`。

| # | 用例 | 结果与关键值 |
|---|---|---|
| 1 | 构造 schema v3 存量库 | PASS，\`user_version=3\` |
| 2 | openDb 自动迁移 v3→v4 并回填 \`kb_chunks.title\` | PASS，2/2 回填为「退款政策说明」 |
| 3 | v4 重建 FTS 后可检索存量标题词 | PASS，\`MATCH "退款政策"\` 命中 2 行 |
| 4 | 控制台登录 | PASS |
| 5 | 控制台 docs 读到迁移前文档（title/chunkCount） | PASS，\`chunkCount=2\` |
| 6 | 控制台标题词检索：titleHit/score/rawRank | PASS，\`{"mode":"fts","score":1,"titleHit":true,"rawRank":1.94e-6}\` |
| 7 | 控制台正文 FTS + 2 字 LIKE 回退 | PASS，\`contentMode=fts, shortMode=like\` |
| 8 | state/settings 在迁移库上正常 | PASS，bots=1、\`reply.mode=adaptive\` |

结论：v4 迁移不丢存量知识库数据，标题检索、score 归一化（0~1 + rawRank）、控制台列表/检索/设置
在迁移库上均正常。

## 5. 清理与残留检查

- 本任务启动的演示控制台（6222）与隔离 dsh web（33081 + 控制台 6223）均已停止；
  \`ss -ltn\` 确认 \`6222/6223/33081\` 无监听。
- \`pgrep\` 未发现本任务的 \`dev-console\` / \`dsh web --port 33081\` / release-check 进程。
- 验证产物全部在 \`.work/\`（gitignore，不随包发布）：\`shots-data/\`、\`qa/\`、\`release-check/\`。

## 6. 测试

最终全量（在本报告与 USER-GUIDE 补充前运行，代码未再变）：

\`\`\`sh
cd /home/qiqi/project/dsh-qqbot-buddy-v2
npm test
# tests 411 / pass 411 / fail 0 / duration_ms ≈ 5517
\`\`\`

注：\`test/*.test.js\` 由全队用例组成（console / kb / memory / qq / host / config / index 等），
数量随队友提交增长；本次运行 Node v22.23.2、0 失败。

## 7. 复跑指引

临时脚本不进仓库；需要复跑时按下面重建（或在当前 \`.work\` 下直接执行）：

1. **配图**：\`rm -rf .work/shots-data && node scripts/dev-console.mjs .work/shots-data 6222\`，
   然后运行 \`.work/qa/shot-console.cjs\`（\`NODE_PATH=$(npm root -g) node ...\`）。
2. **全新安装回归**：按 §3.1；E2E 脚本 \`.work/qa/release-e2e.mjs\`（读取
   \`.work/release-check/data/console-token.txt\`）。
3. **v4 交叉验证**：\`node .work/qa/v4-cross-check.mjs\`（临时目录自建，不依赖外部数据）。
4. 文档预览：\`docs/USER-GUIDE.md\` 中图片使用相对路径 \`images/console-*.png\`。
