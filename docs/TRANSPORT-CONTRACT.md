# QQ 传输层契约（M3）

> 目标：把 v0.22 的 QQ 协议资产搬进 v2，只改"接线"，不改协议逻辑。
> 唯一入口：`lib/qq/gateway.js` 导出 `createQqTransportFactory({ ctx, runtime, logger })`。

## 1. 生命周期

```js
// factory 返回 (botRuntime) => transport
// host/agent.js 在 index.js 里为每个 bot 调用一次 registerTransport(bot.id, factory)
const transport = {
  async start() {},   // 建立 QQBot 连接、装中间件、订阅出站事件；失败 throw（host 置 status=error）
  async stop() {},    // 断开、清理定时器与监听
};
```

## 2. 入站

- `botRuntime` 提供：
  - `id / bot`（appId/appSecret/cwd）
  - `settingsFor(peer)` → 生效设置（Profile 层，含 reply.*）
  - `followup(peer, { text, imageBlocks })` → 投递 UserMessage（text + 多模态 ImageBlock）
  - `whenIdle(peer)` → 等当前 turn 结束（串行化）
  - `cwd`（媒体目录建议 `<cwd>/media`）
- peer 一律用 `core/peer.js` 的 `formatPeer(type,id)`：`group:<openid>` / `c2c:<openid>`。
- 中间件链（移植自 v0.22 `lib/qq/middleware.js`）：过滤 → 访问控制 → 历史缓冲 → 引用解析 → @识别 →
  清洗 → 限流 → 命令拦截 → 频率门控（`gate.js` 纯函数）→ 并发合并 → 附件下载 → 触发 `followup`。
- 频率参数从 `settingsFor(peer).reply` 取（v1 从 settings 单例取，改一处即可）。

## 3. 出站

- 只订阅一次：`ctx.on('session/event', handler)`（插件 ctx，全局）。
- 用 `host.findSession(sessionId)` 反查 `{ botId, peer, runtime }`（未知 session 直接忽略）。
- `turn/end` → 取本 turn 最后一段 assistant 文本 → `sender.js` 发送；流式中间态不发。
- 发送走 `lib/qq/sender.js`（被动回复预算、错误码分类、Markdown→纯文本回退、主动消息限速、引用回复）。
- 目标地址由 peer 解析（group → group_openid；c2c → user_openid）+ 入站 msg_id（被动回复）。

## 4. 移植清单（v0.22 → v2）

| v1 文件 | v2 处理 |
|---|---|
| `lib/qq/error-codes.js` `gate.js` `adaptive.js` `events.js` `interaction.js` `attachment.js` `inline-image.js` `media-cleaner.js` | 直接搬（纯函数/无 store 依赖） |
| `lib/qq/sender.js` `outbound.js` `middleware.js` `inbound.js` `commands.js` | 搬 + 把 settings 单例换成 `settingsFor(peer)`；store 依赖换成 `runtime.db`/`core/*` |
| `lib/qq/gateway.js` | 重写为 `createQqTransportFactory`（连接/断开/注册中间件） |
| `lib/qq/session-manager.js` | 不搬：v2 已由 `host/agent.js`（BotRuntime）承担 |
| `lib/qq/commands.js` | 搬，命令回复直接用 sender；`/new` 改为 dispose 当前 agent 后重建 |

依赖：`@tencent-connect/qqbot-nodejs`（package.json 已声明）。测试用 `test/helpers` 里的假 SDK。

## 5. 验收

1. `npm test` 全绿（移植的协议测试必须包含：被动预算、错误码分类、去重窗口、分条）。
2. 无凭据时 `start()` 优雅失败（不抛未捕获异常、不影响其他 bot）。
3. `scripts/probe-tools.mjs`（M2 收尾）能验证冷会话工具集合一致。
