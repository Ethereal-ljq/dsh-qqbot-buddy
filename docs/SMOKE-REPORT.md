# v2 真实 dsh 集成验收报告（M2 / M5）

> 任务：team task-8（integration-dev）。目标：用**隔离 DSH_HOME** 在真实 dsh 0.2.2-rc.1 里完成
> 「能装 → 能加载 → 控制台可用 → 冷会话稳定」的端到端验收，并留下可复跑的脚本。
>
> 结论先行：**全部通过**。安装/加载/控制台/冷会话/记忆召回均实测通过；过程中发现并推动修复了
> 6 个真实集成 bug（含 1 个插件根本无法激活的 P0），修前/修后对比如下。用户 live profile
> `~/.dsh` 全程未触碰（所有 dsh 调用都显式 `DSH_HOME=<repo>/.work/...`）。

## 1. 环境事实

| 项 | 值 |
|---|---|
| 时间 | 2026-11-09 19:33–19:56（Asia/Shanghai） |
| Node | v24.22.2（`/home/qiqi/.nvm/versions/node/v24.22.2/bin/node`） |
| dsh | 0.2.2-rc.1（`/home/qiqi/.nvm/versions/node/v24.22.2/bin/dsh`） |
| 系统 | WSL2，Linux 6.18.54.1-microsoft-standard-WSL2 x86_64 |
| 验收工作树 | `ab35a0d`（fix(host): 记忆/知识召回进 prompt + 工具指引用 agent scope + 按能力挂载宿主工具插件） |
| 隔离 DSH_HOME | `<repo>/.work/integration/dsh-home`（gitignore 已含 `.work/`） |
| 隔离 profile | `web`（`dsh.profile.bundles = [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-qqbot-buddy]`） |
| 插件数据目录 | `dataDir=<repo>/.work/integration/data`、`workspaceRoot=<repo>/.work/integration/workspace` |
| 端口 | 控制台 `127.0.0.1:6222`（最终复跑时 6222 被队友 dev-console 占用，自动避让为 `6223`）+ dsh web `127.0.0.1:33080`（临时实例，验收后已停） |
| live profile | **未触碰**（无任何 dsh 调用使用默认 `~/.dsh`） |

端口避让说明：验收期间本机 6198 被别的进程占用、6199 为 WSL 镜像网络下 Windows 进程占用；
另有一次重跑时 6222 被队友的 `dev-console.mjs` 占用，脚本已实现「6222+ / 33080+ 自动找空闲端口」，
不依赖固定端口也能复跑。首批干净环境运行在 6222/33080；最终用最新脚本的复跑（`smoke-dsh.json` 11:53:53Z、`probe-tools.json` 11:54:07Z）
自动避让为 6223/33080，结果均为全绿。

## 2. 验收步骤与结果

### 2.1 隔离安装 + dump-config（能装）

```sh
cd /home/qiqi/project/dsh-qqbot-buddy-v2
export DSH_HOME=$PWD/.work/integration/dsh-home
export PATH=/home/qiqi/.nvm/versions/node/v24.22.2/bin:$PATH

# 1) 初始化隔离 profile（首次会从 dsh 随附模板生成）
dsh --profile web --dump-default-config

# 2) 本地安装（复制仓库 + 登记 bundle + dump-config 自检）
node scripts/install.mjs --local --profile web

# 3) 断言插件与 agent preset 进入组合后的插件树
dsh --profile web --patch .work/integration/smoke.patch.yml --dump-config
```

实测：`install.mjs` 退出码 0，日志「已确认 qqbot-buddy 进入插件树」；dump-config 中可见
`- id: qqbot-buddy / name: dsh-qqbot-buddy` 与 `- id: preset-qqbot-buddy`（@deepseek-ai/dsh-agent-preset）。

### 2.2 启动隔离实例（能加载）

```sh
dsh --profile web --patch .work/integration/smoke.patch.yml --port 33080 --no-open
```

结果：dsh web 启动正常，插件激活无报错，控制台监听 127.0.0.1:6222，
`<dataDir>/console-token.txt` 首次生成（22 字符，0600），日志：

```
[qqbot-buddy] [console] 控制台已启动 http://127.0.0.1:6222
[qqbot-buddy] qqbot-buddy v2 已加载 (dataDir=.../.work/integration/data, workspace=.../.work/integration/workspace)
```

### 2.3 控制台冒烟（`scripts/smoke-dsh.mjs`，19/19 通过）

自动执行：隔离初始化 → 安装 → dump-config 断言 → 起实例 → health/token → 登录 →
state/tools/schema → 建 bot（不填凭据）→ start-bot 优雅失败 → 重启实例验证持久化 bot 自动启动失败但不崩进程。

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 隔离 profile 初始化 | PASS |
| 2 | 插件已安装到隔离 profile | PASS |
| 3 | dump-config 包含插件与 preset | PASS |
| 4 | 控制台 /api/health 可用（200） | PASS |
| 5 | console-token.txt 已生成 | PASS |
| 6 | 控制台登录（cookie） | PASS |
| 7 | /api/state 正常（bots/version/console） | PASS |
| 8 | /api/tools 工具发现非空（items=1：working_directory） | PASS |
| 9 | /api/schema 正常（items=41） | PASS |
| 10 | 控制台建 bot（不填凭据，HTTP 200） | PASS |
| 11 | start-bot 无凭据优雅失败：**HTTP 400 + code=start_failed + 可读中文** | PASS |
| 12 | start-bot 后 bot 状态可读（runtime status=error） | PASS |
| 13 | 动作失败后进程不崩（health 仍 200） | PASS |
| 14 | 阶段 A 实例可正常停止（exit code=0） | PASS |
| 15 | 重启后控制台 health 可用 | PASS |
| 16 | 重启后再次登录 | PASS |
| 17 | 持久化 bot 自动启动优雅失败（status=error，log 可读） | PASS |
| 18 | 重启后 start-bot 返回可读失败（400 start_failed） | PASS |
| 19 | 阶段 B 进程存活 | PASS |

start-bot 实际返回（节选）：

```json
{"error":{"code":"start_failed","message":"QQ 机器人 「冒烟测试号-…」(bot_…) 缺少 AppID / AppSecret：请在控制台「机器人」页填写 QQ 开放平台的 AppID 与 AppSecret 后重启该机器人。本次仅跳过 QQ 连接（控制台可用，其它机器人不受影响）。"}}
```

结果 JSON：`.work/smoke-dsh.json`；日志：`.work/integration/logs/smoke-a.log`、`smoke-b.log`。

### 2.4 冷会话探针（`scripts/probe-tools.mjs`，18/18 checks 通过）

机制（不依赖宿主私有 API、不改 `lib/**`）：

- 探针本体被复制到**系统临时目录**后，作为 dsh plugin 通过 `--patch` 覆盖层插入隔离实例
  （dsh 的 client-modules 会按 loader row 最近 package.json 判定 `dsh.client`，放仓库内会被误认成
  qqbot-buddy 包；脚本自动用 `mkdtemp` 放 `/tmp` 并清理）；
- runtime 通过已安装插件的 **`getRuntime()`** 取得（同一模块实例；不依赖 apply 返回值、不依赖 debug 全局）；
- 流程：`host.ensureRuntime(botId).getOrCreate(peer)` 建会话 → 首轮 `ctx.systemPrompt.assemble({agent, scope: agent})`
  → `agentCtx.tools.view(agent).visible` → `handle.dispose()` + 清 live 缓存 → `getOrCreate` 走持久化 resume
  → 再 assembly → 断言工具集合 / `qqbot:*` 段 / section / variables / contexts 全部一致。

**关键证据**

| 判据 | 首轮（create） | 冷会话（resume） | 结论 |
|---|---|---|---|
| sessionId | `qqbot-c9c5215c95422ba8` | 同左（未重建） | 稳定 |
| session.log 事件数 / firstLiveSeq | 3 / 0 | 4 / 3 | 从持久化恢复（3 条旧事件 + 1 条新 marker） |
| 持久化文件（session.v4.jsonl.zstd） | dispose 前存在 | resume 前存在 | 真实落盘 |
| 可见工具集合 | 23 个 | 23 个，逐名一致 | **稳定** |
| assembly 工具声明 | 23 个 | 23 个，逐名一致 | 稳定 |
| sections | 19 个 | 19 个，逐名一致 | 稳定 |
| `qqbot:persona/guide/memory/knowledge` | 4 段都在 | 4 段都在、渲染文本一致 | **稳定** |
| prompt 总字符 | 4074 | 4074 | 稳定 |

可见工具（23，两次一致）：

```
edit, glob, grep, knowledge_read, knowledge_save, knowledge_search, member_lookup, member_note,
memory_list, memory_read, memory_save, memory_search,
qqbot_describe_image, qqbot_quote_reply, qqbot_send_card, qqbot_send_file, qqbot_send_sticker, qqbot_sticker_save,
read, read_image, web_fetch, web_search, write
```

`qqbot:*` 段渲染结果（首轮/冷会话一致；persona 由探针播种 `persona.md`、guide 由 agent scope 工具视图动态生成）：

| 段 | 渲染字符 | 内容（节选） |
|---|---|---|
| qqbot:persona | 27 | 冷会话探针人设：你是QQ群里的测试机器人，回答简短。 |
| qqbot:guide | 410 | 【工具】你可以使用这些工具完成 QQ 侧动作：qqbot_send_file、qqbot_send_card… |
| qqbot:memory | 25（召回后） | - 探针长期记忆：管理员喜欢喝乌龙茶，常去滨江公园 |
| qqbot:knowledge | 33（召回后） | 【知识库】《探针知识库》探针知识条目：周五下午三点在滨江公园集合 |

召回段验证（M4 接线，不属于冷/热一致性判据）：播种记忆 + 知识 → `followup("滨江公园")` 触发
`recallForPeer` → 再次 assembly，`qqbot:memory` / `qqbot:knowledge` 均非空且包含种子文本
（注：v2 检索语义是「整串子串/短语匹配」，query 必须是命中文本的连续子串，故用「滨江公园」而非多词 query）。

结果 JSON：`.work/probe-tools.json`；dsh 侧日志：`.work/probe-tools.log`。

## 3. 修前 / 修后对比（真实 dsh 才能暴露的问题）

### 3.1 P0：插件在真实 cordis 下**完全无法激活**

修前（第一次真实启动）控制台先起来又立刻停掉，dsh 报：

```
[qqbot-buddy] [console] 控制台已停止
dsh: warning: 1 entry did not activate
qqbot-buddy (dsh-qqbot-buddy): TypeError: Invalid effect
    at safeCollect (.../@deepseek-ai/cordis/lib/index.js:434:42)
    at Fiber._reload (.../@deepseek-ai/cordis/lib/index.js:677:41)
```

根因：`lib/index.js` 的 async `apply()` 末尾 `return runtime`；cordis 把插件返回值当 effect 收集，
普通对象 → `TypeError: Invalid effect` → 整插件回滚。修复：不返回 runtime（调试用 `getRuntime()`/`apply.lastRuntime`）。
提交：`e14b923`。

修后：同一隔离环境启动无 Invalid effect，控制台保活，health 200。

### 3.2 其余集成 bug（均已修复）

| 编号 | 现象 | 根因（修前） | 修复提交 | 修后验证 |
|---|---|---|---|---|
| P1-A | 控制台运行期新建 bot 后 start-bot → **HTTP 500** | `host.bots` 只在装配时 reload，`ensureRuntime` 查不到新 bot | `6347db4` | 400 start_failed + status=error，可直接启动 |
| P1-B | 错误被吞成 500 `internal_error`，message 不可读 | actions 抛普通 Error，console 统一 500 | `68cebfd`/`6347db4` | 400 + `{code,message}` 中文可读 |
| P1-C | `qqbot:guide` 永远为空（工具指引丢失） | `toolsGuideFor(host.ctx, agent)` 无 inject 访问 `ctx.tools` 抛错被 catch | `ab35a0d` | guide 渲染 410 chars，两次一致 |
| P1-D | `qqbot:memory/knowledge` 恒空 | `self.memoryText/knowledgeText` 未初始化；召回未接线 | `ab35a0d` | 播种后召回段非空（25/33 chars） |
| P1-E | agent 只能看到 6 个插件工具，宿主工具全无 | preset 只挂 compaction，能力开关无宿主工具可放行 | `ab35a0d` | 可见工具 23 个（read/write/web_search/… + 插件工具） |
| P2-F | web profile 在某些加载路径启动失败：`declares dsh.client but exports no "./client" bundle` | package.json 声明 `dsh.client` 却无 `./client` 导出 | `ab35a0d` | 字段已移除；冷启动/探针均正常 |

修前探针（`ab35a0d` 之前同一环境）与修后对比：

| 指标 | 修前 | 修后 |
|---|---|---|
| 可见工具数 | 6（仅 qqbot_*） | **23**（宿主 + 插件） |
| qqbot:guide 字符 | 0 | **410** |
| qqbot:memory / knowledge（召回后） | 0 / 0 | **25 / 33** |
| 冷/热工具集合一致 | 一致（但集合贫乏） | 一致（23 个） |
| 冒烟步骤 | 18 步 16 过 / 2 失败（start-bot 500） | **19/19 全过** |

## 4. 已知限制 / 观察（不阻塞本次验收）

1. **检索语义**：kb/memory 是「整串子串/短语匹配」（DESIGN §7.1），多词 query（如
   「乌龙茶 滨江公园 集合」）不会自动分词命中；探针因此用连续子串 query。后续如需自然语言 query，
   需要在 `core/kb`、`core/memory` 增加分词/多词 OR（属 M4 增强，不是本次 bug）。
2. **`工具策略：全部屏蔽` 日志**：能力开关现在通过 `host/tool-mounts.js` 在 agent scope 挂载宿主工具
   （agent scope 注册不参与 `tools.restrict`），所以 `restrict` 的全局 allow 为空属预期；但日志文案容易误解
   （实际 agent 有 23 个工具）。建议后续把措辞改成「全局工具 restrict：无（agent scope 挂载由能力开关控制）」。
3. **`/api/tools` 全局发现只有 1 个（working_directory）**：控制台发现读的是宿主**全局**工具视图；
   agent-scope 挂载的工具不在其中。若产品上要求控制台展示「会话可见工具」，需要换成按 profile/agent 的
   可见性采样（M2 后续增强）。
4. **`--local` 安装不含 `@deepseek-ai/*` peer 依赖**：实测 dsh 的运行时解析锚点能解析到宿主包，不影响；
   生产走 `dsh plugin add`（pnpm）路径仍建议单独冒烟一次。
5. **端口**：6198 在本机被其他进程占用、6199 被 WSL 镜像网络下 Windows 进程占用、6222 可能被队友开发服务
   临时占用；脚本已自动避让（6222+/33080+ 找空闲端口），报告与 JSON 里记录实际端口。

## 5. 复跑方法

```sh
cd /home/qiqi/project/dsh-qqbot-buddy-v2
export DSH_HOME=$PWD/.work/integration/dsh-home          # 隔离，绝不碰 ~/.dsh
export PATH=/home/qiqi/.nvm/versions/node/v24.22.2/bin:$PATH

# 冒烟（安装/启动/控制台/建 bot/优雅失败；--reinstall 强制用当前工作树重装）
node scripts/smoke-dsh.mjs --reinstall

# 冷会话探针（建会话→assembly→dispose→resume→assembly，断言一致；结果写 .work/probe-tools.json）
node scripts/probe-tools.mjs --reinstall

# 一键 E2E（默认跳过，需显式开启；串跑探针 + 冒烟）
QQBOT_E2E=1 node --test test/e2e/real-dsh.test.js
```

退出码：0 = 通过；1 = 断言失败；2 = 环境/启动失败。日志与 JSON 都在 `.work/` 下（gitignored）。

本次 E2E 一键脚本实测：`QQBOT_E2E=1 node --test test/e2e/real-dsh.test.js` → **2/2 通过**
（冷会话探针 6.9s + 冒烟 8.3s，exit 0；日志 `.work/e2e-run.log`）。

## 6. 交付物

| 文件 | 说明 |
|---|---|
| `scripts/probe-tools.mjs` | 冷会话探针（驱动 + dsh plugin 双模式；getRuntime()；18 项 checks） |
| `scripts/smoke-dsh.mjs` | 隔离安装 + 启动 + 控制台冒烟（19 步；端口自动避让；--reinstall） |
| `test/e2e/real-dsh.test.js` | 默认跳过的真实 dsh E2E（QQBOT_E2E=1 开启） |
| `docs/SMOKE-REPORT.md` | 本报告 |
| `.work/probe-tools.json` / `.work/smoke-dsh.json` | 最近一次运行的结构化证据（gitignored，可随时重跑） |

## 7. 验收结论

| task-8 要求 | 结果 |
|---|---|
| 隔离 DSH_HOME 安装 + dump-config 断言插件/preset 入树 | ✅ |
| 独立端口起隔离实例、health 通、token 生成 | ✅（6222/33080，含端口避让） |
| 控制台 API 建 bot（不填凭据）→ start-bot 优雅失败（status=error、错误可读、不崩进程） | ✅（400 start_failed + 可读中文；重启后同样优雅） |
| /api/state、/api/tools、/api/schema 正常 | ✅ |
| 冷会话探针：工具集合一致 + qqbot 段存在且文本一致 | ✅（23 工具一致；4 段一致；session 真实 resume） |
| 结论文档 | ✅ 本文件 |

**最终判定：v2 在真实 dsh 0.2.2-rc.1（隔离 profile）上可安装、可加载、控制台可用、冷会话稳定，
记忆/知识/工具接线生效；本次验收无未解决阻塞项。**
