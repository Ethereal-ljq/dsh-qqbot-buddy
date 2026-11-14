# 复刻方案：fatfish_seememe → 独立 DSH 插件

> 目标形态：一个**独立 npm 包插件**，装在 DSH 的 profile 里，与 dsh-qqbot-buddy **并列挂载**。**不修改 qqbot 仓库任何一行代码。**

---

## 0. 一句话结论

**可以做成完全独立的插件。** 且技术上比"改 qqbot"更干净——DSH 提供了一个 qqbot 没有暴露、但天然适合此场景的钩子：`agent/pre-step`。

---

## 1. 为什么能不改 qqbot 做出来

### 1.1 三个候选挂载点

| 路径 | 可行性 | 结论 |
|---|---|---|
| A. 改 qqbot 源码 | 需要改 9 处 | ❌ 用户明确否决 |
| B. 调 qqbot 的公开接口 | qqbot **不对外暴露任何服务或事件** | ❌ 走不通 |
| C. 挂 DSH 层全局钩子 | `agent/pre-step` waterfall | ✅ **采用** |

**B 走不通的证据**：`qqbot/lib/index.js` 只导出 `name` / `inject = ['agents']` / `apply`，**没有任何 `ctx.set()` 注册服务**；`core/events.js` 是**进程内私有** Map，仅由 qqbot 内部调用，插件外无法订阅。所以想借道 qqbot 的事件总线是不可能的。

### 1.2 `agent/pre-step`：官方预留的注入点

DSH 文档（`dsh-agent/lib/types/runtime-types.d.ts:319-331`）原文：

> ***"Reject a proposed step or replace the messages that enter it. Calling `next()` preserves the current messages."***

签名：

```ts
'agent/pre-step'(payload: {
  agent: Agent; messages: UserMessage[]; turn: number; step: number;
  signal: AbortSignal; modelSelection: Readonly<ModelSelection>;
}, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```

`next()` 返回 `decision`，可以返回 `{ ...decision, messages: [...decision.messages, 新消息] }` **替换进入本步的消息**。

**这不是野路子**——DSH 自带的 `dsh-time-context`（`lib/index.js:249`）就是这么做的：每轮往里塞一条"当前时间"的 `createUserMessage`。

### 1.3 关键优势：天然解决了"持久 vs 临时"

上游 AstrBot 靠 `mark_as_temp()` 区分两类注入。DSH 侧有更清晰的机制——**`source.form`**：

```js
createUserMessage({
  content: [{ type: 'text', text: '这一轮的图：…' }],
  source: { kind: 'qqbot-seememe', form: 'snapshot', sections: [...] },
})
```

- `form: 'snapshot'` 表示"这是系统组装的上下文快照"，UI 会折叠展示，**语义上不是用户说的话**
- qqbot 自己的消息全部是 `source: { kind: 'user' }`（见 `lib/host/agent.js:426`），因此**可以精确区分**，不会误判

对照表：

| 上游 temp | DSH 等价物 | 效果 |
|---|---|---|
| `True`（只给本轮） | `pre-step` 里追加 `form:'snapshot'` 消息 | 只在本步可见，不进转录 |
| `False`（常驻/记进历史） | 需持久化后每轮按需回放 | 见 §4.3 |

---

## 2. 插件骨架

```
dsh-plugin-seememe/            ← 独立 npm 包，与 qqbot 仓库无关
├── package.json               # name: dsh-phatfish-seememe
├── cordis.patch.yml           # dsh.bundle.patch 入口
├── index.js                   # export name / inject / Config / apply
├── src/
│   ├── capturer.js            # 看图：提示词 + oneShot 多模态 + 解析
│   ├── puns.js                # 谐音（移植 puns.py，pinyin-pro）
│   ├── lookup.js              # 查梗 cnmeme.wiki + 缓存 + 防注入
│   ├── store.js               # SQLite（独立 DB 文件，不复用 qqbot 的）
│   ├── quota.js               # 配额 + 时区分天（自写 Asia/Shanghai）
│   ├── session-detect.js      # 判定"这是不是 QQ 会话、这轮要不要看图"
│   └── safety.js              # 防伪造边界
└── test/                      # node --test
```

### package.json 关键字段

```json
{
  "name": "dsh-phatfish-seememe",
  "type": "module",
  "main": "./index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-llm": "*",
    "@deepseek-ai/dsh-agent": "*",
    "@deepseek-ai/dsh-attachment": "*"
  },
  "dependencies": { "pinyin-pro": "^3.29.5" }
}
```

### 安装（不改 qqbot）

```bash
dsh plugin --profile qqbot add dsh-phatfish-seememe
```

装完后 profile 的 `cordis.patch.yml` 里会多一层：

```yaml
- insert:
    - id: qqbot-seememe
      name: dsh-phatfish-seememe
      config:
        enabled: true
        model: ''          # 看图模型；空=跟随对话模型
        maxImages: 3
        ...
```

---

## 3. 核心实现：pre-step 钩子

```js
export const name = 'qqbot-seememe';
export const inject = ['agents'];
export const Config = ConfigSchema;

export async function apply(ctx, config) {
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;

    // 1) 只处理 QQ 会话（按 session 来源判定，见 §4.1）
    const peer = detectPeer(agent.session);
    if (!peer) return decision;

    // 2) 只在本轮第一步做（step === 1），避免多步重复注入
    if (step !== 1) return decision;

    // 3) 找出本轮带的图
    const images = await collectImages(decision.messages, peer, signal);
    if (images.length === 0) return decision;

    // 4) 并行：看图 + 谐音 + 查梗
    const caption = await captionImages(ctx, images, config, signal);
    if (!caption) return decision;          // 失败就静默降级

    // 5) 以 snapshot 形式追加，不改原消息
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: caption }],
        source: {
          kind: 'qqbot-seememe',
          form: 'snapshot',
          sections: [{ name: 'seememe', text: caption }],
        },
      })],
    };
  });
}
```

**要点**：
- 必须先 `await next()` 拿到 `decision`，再在**它的基础上**追加（不能自己造 decision）
- 出错必须 `return decision`（放行原流程），**绝不能阻断聊天**
- 用 `signal` 参与取消

---

## 4. 四个必须自己解决的工程问题

### 4.1 怎么认"这是 QQ 会话" —— 已实测确认

**好消息**：qqbot 的 sessionId 有固定前缀，已实测验证：

```
sessionIdFor('bot1', 'group:abc', 0)  →  'qqbot-4523f747bd4bcbd1'
```

即 `SessionId('qqbot-' + sha1(botId|peer|epoch).slice(0,16))`（`lib/host/agent.js:48-51`）。

所以判定极其简单可靠：

```js
const isQqSession = (agent) => String(agent.session.id).startsWith('qqbot-');
```

**但有个代价**：sessionId 是**哈希值，不可逆**。插件能从它知道"这是 QQ 会话"，却**拿不到 peer（群号/用户）和 botId**——而"按对话分存、跨群不自串"恰恰需要这个身份。

反查入口两条，都不可用：
- `host.findSession(sessionId)` → 返回 `{botId, peer}`，但 `host` 是 qqbot **内部对象**，没有通过 `ctx.set()` 暴露
- `globalThis.__QQBOT_V2_DEBUG__` → 只在 `debug: true` 时存在，是给探针用的非正式接口，**不能作为方案基础**

**结论与对策**：以 **sessionId 本身作为对话身份键**即可——哈希值稳定、跨重启不变、不同群/人天然不碰撞，正合适做分区键。我们不需要知道"这是哪个群"，只需要知道"这几轮是不是同一个对话"。

> ⚠️ 唯一缺失：拿不到"发图人是谁"。上游按"对话 + 发图人"分存，我们退化为**只按对话分存**。影响很小（同一群里不同人发同一张图会共用描述）。
> 若确实需要发图人，可在 P0 探针阶段额外试：解析 qqbot 写在正文里的 `[昵称 (openid)]` 前缀（`inbound.js:250`）。这是**可选增强**，不阻塞主线。

### 4.2 从哪拿到图片

要复用 qqbot 已经下载好的图，不能重复下载。可行做法：
- qqbot 把本地路径写进了消息正文（`Image: /path/to/x.jpg`，见 `inbound.js:97`）
- 解析这段文本拿到路径 → `ctx.get('attachments').saveImage()` → `ImageAttachmentRef`
- 若 qqbot 已内联（`vision.inlineImages`），`decision.messages` 里已有 `{type:'image', attachment}`，**直接复用同一 attachment**，不重复存字节

### 4.3 "常驻段"（记进聊天记录）怎么办

上游"看到了什么"要常驻。在独立插件里有两档做法：

| 做法 | 复杂度 | 建议 |
|---|---|---|
| 写进会话历史 | 需要 `agent.followup()`，但会**触发新一轮对话** | ❌ 危险 |
| 自存 + 每轮按需回放 | 存在自己的 SQLite，下次见到同图时再注入 | ✅ **推荐** |

**推荐后者**：效果等价（下次聊起这张图，插件再注入一次描述），且完全可控。

### 4.4 配额与"今天"

现有 qqbot 的 `stickerDayKey` 用进程本地时区，不满足 Asia/Shanghai 语义。**本插件自己写**：

```js
new Intl.DateTimeFormat('en-CA', { timeZone: config.dayTz || 'Asia/Shanghai' })
  .format(new Date())   // → '2026-11-11'
```

---

## 5. 移植映射表

| 上游 | 本插件 | 工作 |
|---|---|---|
| `seer.build_prompt` | `capturer.js` 常量 | 照抄（约 1.5KB 文本） |
| `seer.parse_deep` / `fields` | 同 | 正则可直译 |
| `seer.caption_block` / `hints_block` | 同 | 直译 |
| `seer.neutral_marks` | `safety.js` | 直译（正则可直译） |
| `puns.find` | `puns.js` | 算法直译，拼音换 `pinyin-pro` |
| `memes.cnmeme_find` | `lookup.js` | 直译（`fetch` 替 `aiohttp`） |
| `memes.clean` / `statement` | `safety.js` | 直译 |
| `main.py` 全部 | 由 pre-step + 本插件替代 | **重写** |
| 转发 / 商城表情 / 历史回捞 | — | **不可实现**（协议限制） |

---

## 6. 分期与验收

| 阶段 | 内容 | 验收标准 | 估时 |
|---|---|---|---|
| P0 | 骨架 + 装进 profile + 探针实测 messages 形状 | 插件能加载、钩子触发、能认出 QQ 会话 | 1 天 |
| P1 | 看图注入最小闭环 | 发图 @ 机器人 → 回复体现出看懂了 | 2 天 |
| P2 | 谐音 | 单测覆盖 117 条词表 + 读音/近音用例 | 1 天 |
| P3 | 查梗 | 命中/缓存/超时/防注入单测 | 2 天 |
| P4 | 配额 + 时区 + 按对话分存 | 跨零点、换群不自串 | 1.5 天 |
| P5 | 表情包词典 | 第 3 次后台深度认 | 2 天 |
| P6 | 配置面板（DSH Web 内） | 可视化开关 | 2 天 |
| **合计** | | | **~11.5 天** |

---

## 7. 风险

1. **会话识别已解决**（`qqbot-` 前缀，实测确认），剩余未知数是**图片路径怎么拿**。建议 P0 用最小探针实测 `decision.messages` 的真实形状，再定后续。
2. **多步 turn 重复注入**：LLM 可能一个 turn 走多步（工具调用），必须只在 `step === 1` 注入，否则同一段会重复。
3. **不要用 `agent.followup()` 注入**：它会开新一轮对话，可能自我循环。一律用 pre-step 返回 decision。
4. **协议级缺失**（合并转发、历史回捞、商城表情）仍然存在，与插件方案无关。
5. **成本**：默认关闭"主模型能看图时也另看一遍"（上游默认开，是最坏 9 次视觉调用的放大器）。

---

## 8. 与"改 qqbot"方案的对比

| | 独立插件 | 改 qqbot |
|---|---|---|
| 是否动 qqbot 源码 | ❌ 不动 | ✅ 改 9 处 |
| 升级 qqbot 时 | 不受影响 | 可能冲突 |
| 对非 QQ 场景 | 可泛化（任何 DSH agent） | 只能 QQ |
| 注入语义 | `form:'snapshot'`，语义正确 | 需自己拼字符串 |
| 污染记忆风险 | 低（snapshot 独立来源） | 高（易混入用户原文） |
| 工期 | ~11.5 天 | ~11 天 |

**结论：独立插件方案在工程上更优**，工期几乎相同，但隔离性、可升级性、语义正确性都更好。
