# 模型中心（LLM / 视觉 / 语音 TTS / 插槽）设计与实现契约

> 状态：已实现并通过独立验收（2026-11；本文件同时是多人协作的接口契约，实现完成后作为功能设计文档保留）。
> 关联设置：`lib/core/config/schema.js` 的 model / vision / voice 分节；数据表 `tts_providers`（migration v6）。

## 1. 目标

1. 控制台新增「模型」页（路由 `/models`），用 **tab** 组织同一类配置：
   - `LLM`：对话模型路由（provider / model / 推理强度 / preset）
   - `视觉`：视觉模型来源（跟随 LLM 自带视觉 = 当前内联图片；或独立更精细视觉模型）
   - `语音（TTS）`：TTS 供应商配置面板（全局）+ 当前配置档的供应商/音色/风格选择
   - `更多类型`：模型类型插槽（图像生成 / ASR / 向量检索…，预留扩展点）
2. TTS 支持多种供应商：
   - `edge` 微软 Edge 语音（免 Key，内置 WebSocket 实现）
   - `mimo` 小米 MiMo-V2.5-TTS（内置音色 / voicedesign / voiceclone）
   - `bailian` 阿里云百炼 Qwen-TTS（qwen3-tts-flash / qwen-tts）
   - `openai` OpenAI 兼容 `/audio/speech`
   - `custom` 自定义 HTTP 接口（URL/Header/Body 模板 + 三种响应类型）
   - `command` 本地命令行模型（piper / sherpa-onnx / edge-tts CLI 等）
3. 模型可通过工具 `qqbot_speak` 把文字合成语音并发到当前 QQ 会话；能力开关 `tools.capabilities.voice` 默认关。
4. 后续新增模型类型只改 `lib/core/model-slots.js` + settings schema，控制台自动多出 tab（前端不写死类型清单）。

## 2. 配置层级

- **全局**：TTS 供应商列表（表 `tts_providers`）+ `voice.defaultProvider`（global scope 设置项）。
- **配置档**：`voice.*`（是否启用、选哪个供应商、音色/风格/语速/字数上限）与 `vision.*`、`model.*`。
- 生效顺序沿用既有层级：defaults → global → bot → profile（binding 匹配后的配置档）。

新增设置项（`core/config/schema.js`）：

| key | scope | type | default |
| --- | --- | --- | --- |
| `vision.mode` | profile | enum `llm`/`dedicated` | `llm` |
| `vision.provider` | profile | string | `''` |
| `vision.model` | profile | string | `''` |
| `vision.maxTokens` | profile | number | 4096 |
| `voice.enabled` | profile | boolean | false |
| `voice.provider` | profile | string | `''` |
| `voice.defaultProvider` | global | string | `''` |
| `voice.voice` | profile | string | `''` |
| `voice.style` | profile | string | `''` |
| `voice.speed` | profile | number | 1 |
| `voice.maxChars` | profile | number | 300 |

schema item 新增可选元数据 `optionsFrom`：`llmProviders` | `llmModels` | `ttsProviders`，
`schemaPayload()` 会原样透出，控制台 `SchemaForm` 据此动态拉取下拉候选。

> 实现补充（独立验收时注明）：除上表外，视觉分节还落地了 `vision.inlineImages` / `vision.inlineMaxImages` /
> `vision.inlineMaxBytes` 三个内联图片裁剪设置项（`lib/core/config/schema.js`），用于「跟随 LLM」模式；
> `voice.*`、`model.*` 与上表一致。

## 3. 数据表

migration v6（已写入 `lib/core/migrations.js`）：

```sql
CREATE TABLE tts_providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL DEFAULT '{}',
  secret TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

- `config` 是 **非敏感** JSON（字段由 `core/tts/providers.js` 的 kind 元数据约束）。
- `secret` 只写不读：读接口只返回 `hasSecret`；PATCH 时 secret 缺省/空串 = 保留原值。
- id 生成：`tts_` + 12 位 hex。

## 4. 供应商元数据（`lib/core/tts/providers.js`，已完成）

`TTS_KINDS[kind]`：

```js
{
  id, label, short, desc,
  needsSecret, secretLabel, secretPlaceholder, secretHelp,
  defaultConfig,          // 新建预填，同时是配置默认值
  models: [{value,label}],// select 字段 optionsFrom:'models'
  voices: [{value,label}],// select 字段 optionsFrom:'voices'
  fields: [{ key,label,type:'text'|'textarea'|'select'|'number'|'json',
             options?/optionsFrom?:'models'|'voices', required?, placeholder?, help?,
             min?, max?, step?, maxLength? }],
  outputFormat: 'mp3' | 'wav',
  maxCharsPerRequest: number,
  timeoutMs: number,
}
```

已导出：`TTS_KINDS`、`TTS_KIND_LIST`、`kindOf`、`publicKinds()`、`defaultConfigFor`、
`normalizeProviderInput(input,{existing})`、`providerView(row)`、`fieldOptions`。
**供应商实现只允许用这些导出，不要在别处重复声明 kind。**

## 5. Provider store（`lib/core/tts/store.js`，已实现）

```js
createTtsProviderStore({ db, now = Date.now })
  list()                     // → 内部行（含 secret），按 created_at ASC；engine 用
  listPublic()               // → providerView[]
  get(id)                    // → 内部行 | null
  getPublic(id)              // → providerView | null
  save(input)                // 新增（无 id）/更新（有 id）；secret 空串=保留；→ providerView
  remove(id)                 // → boolean
  firstEnabled()             // → 内部行 | null（默认供应商回退用）
```

校验/归一化全部走 `normalizeProviderInput`；错误信息可直接给用户（中文）。

## 6. TTS 引擎（`lib/core/tts/index.js`，已实现）

```js
createTtsEngine({ db, dataDir, logger })
  kinds()                                        // → publicKinds()
  listProviders()                                // → providerView[]
  getProvider(id)                                // → providerView | null
  saveProvider(input)                            // → providerView
  deleteProvider(id)                             // → boolean
  resolveSelection({ settings })                 // 纯查询：profile 设置 → { provider, providerId, voice, style, speed, maxChars } | null
  async synthesize({
    text, providerId?, voice?, style?, speed?, maxChars?,
    settings?, fileNameHint?, signal?, outDir?,
  }) // → { ok:true, providerId, kind, model, voice, format, filePath, bytes, ms, segments, truncated, text }
  async synthesizeForSettings({ text, settings, ... }) // synthesize 的便捷封装（内部调 resolveSelection）
  async test({ providerId, text? })              // → { ok:true, providerId, kind, model, voice, format, bytes, ms, audioBase64, mimeType }
  audioDir()                                     // → <dataDir>/tts-media（保证存在）
```

- 输出文件命名：`<audioDir>/<yyyyMMdd-HHmmss>-<rand>.<format>`；文件落盘后交给工具发送。
- 文本分段：按句号/换行切，每段 ≤ kind.maxCharsPerRequest；多段合成后 **拼接**：
  - `wav`：解析各段 PCM data 块后重写标准 WAV 头；
  - `mp3`：按字节顺序拼接（顺序播放可用）；
  - 如需转码/强一致，可选调用 `ffmpeg`（存在则用，不存在降级为字节拼接，不报错）。
- `text` 按 `maxChars`（默认 300，来自 `voice.maxChars`）截断，返回 `truncated:true`。
- 错误统一 `Error`，消息中文可读，带 `.code`（如 `TTS_PROVIDER_NOT_FOUND`、`TTS_DISABLED`、`TTS_CONFIG`、`TTS_UPSTREAM`、`TTS_TIMEOUT`、`TTS_EMPTY_TEXT`）。
- 网络：全局 `fetch`，超时用 `AbortSignal.timeout`（与调用方 signal 合并）；只允许 http(s)。测试禁止真实联网。

### 适配器目录 `lib/core/tts/adapters/`

每个文件默认导出：

```js
export default {
  kind: 'mimo',
  async synthesize({ provider, text, options, outPath, signal, logger })
    // provider: 内部行 {id,name,kind,config,secret}; options: {voice,style,speed}
    // outPath: 完整输出路径（扩展名已按 outputFormat 决定）
    // → { bytes, format, model, voice, meta? }
}
```

- `edge.js`：Microsoft Edge TTS WebSocket 协议（`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`）。
  **实测（2026-11）**：旧版 `Sec-MS-GEC` v1（sha256(ticks+token)）已被服务端 403 拒绝，必须用 v2 token
  `<CS64>-<SHA256>`（"版权声明 + ticks + token" 的 CS64/SHA256 组合，算法见 `lib/core/tts/edge-token.js`，
  移植自 MIT 许可的 MsEdgeTTS），查询参数需要 `ConnectionId=<32 hex>`、`Sec-MS-GEC-Version=2-143.0.3650.96`；
  握手需要 Origin/UA/Cookie(muid) 等头，因此用 `ws` 包（dependency）而不是 Node 全局 WebSocket。
  允许被环境变量 `QQBOT_EDGE_TTS_URL` 覆盖（测试/自建代理）。协议随微软策略变动时，
  优先改 `edge-token.js`/版本常量；若彻底失效，用户可用 `command` kind 调本机 `edge-tts` CLI 兜底。
- `mimo.js`：`POST {baseUrl}/chat/completions`，头 `api-key: <secret>`、`Content-Type: application/json`；
  body `{model, messages:[{role:'user',content:style}, {role:'assistant',content:text}], audio:{format:'wav', voice}}`
  （voiceclone 时 `audio.voice = data:<mime>;base64,<样本>`）；响应 `choices[0].message.audio.data` base64。
- `bailian.js`：`POST {baseUrl}/services/aigc/multimodal-generation/generation`，`Authorization: Bearer <secret>`；
  body `{model, input:{text, voice, language_type}}`；响应 `output.audio.url`（下载）或 `output.audio.data` base64。
- `openai.js`：`POST {baseUrl}/audio/speech`，Bearer；body `{model, input:text, voice, response_format, speed, instructions?}`；
  响应二进制音频（按 `content-type` 嗅探实际格式，写文件时统一用 outPath 扩展名）。
- `custom.js`：按 provider.config 渲染 URL/Header/Body；`{{text}}/{{voice}}/{{style}}/{{speed}}` 占位
  （URL 中 URL 编码、body 模板中 JSON 字符串转义）；secret 按 secretHeader/secretPrefix 注入；
  responseType：`audio`（读字节）|`json_base64`（按 responsePath 取值 base64）|`json_url`（按 responsePath 取 URL 下载）。
- `command.js`：`node:child_process` 的 `spawn('/bin/sh',['-c',cmd])`，占位符 shell 单引号转义；
  要求命令退出码 0 且 `{{output}}` 文件存在；超时 kill。

## 7. 控制台 API（`lib/console/api/models.js`，已实现）

路由表（auth 默认开启，CSRF 由 server 统一）：

| method | path | 说明 |
| --- | --- | --- |
| GET | `/api/models/slots` | `{ slots, ready, planned }` ← `core/model-slots.js slotsPayload()` |
| GET | `/api/models/llm` | `{ providers:[{id,name}], models:[{provider,id,name,description?,inputModalities?}], warning? }`；从 `deps.rootCtx.get('llm')` 尽力读取，失败返回空 + warning |
| GET | `/api/models/tts/kinds` | `{ kinds: publicKinds() }` |
| GET | `/api/models/tts/providers` | `{ providers: providerView[], defaultProvider }`（defaultProvider 读 global 设置） |
| POST | `/api/models/tts/providers` | body `{name,kind,enabled?,config?,secret?}` → providerView |
| PATCH | `/api/models/tts/providers/:id` | 同上；secret 空串=保留 |
| DELETE | `/api/models/tts/providers/:id` | `{ok:true,id}` |
| POST | `/api/models/tts/providers/:id/test` | body `{text?}`（默认「你好，这是一条语音合成测试。」）→ `{ok, providerId, kind, model, voice, format, bytes, ms, audioBase64, mimeType}`；audioBase64 超 4MB 时省略并返回 `tooLarge:true` |

注册进 `lib/console/api/index.js`。依赖：`deps.tts`（engine，可为 null → 501）、`deps.config`、`deps.rootCtx`。
`lib/index.js` 装配：`runtime.tts = createTtsEngine({ db, dataDir, logger })`，并放入 `consoleDeps.tts`。

## 8. 工具 `qqbot_speak`（`lib/tools/voice.js`，已实现）

```js
export const SPEAK_TOOL_NAME = 'qqbot_speak';
export function createVoiceTools({ tts, manager, mediaSender, getSettings, config, logger })
```

- 入参：`text`（必填）、`style`（可选，覆盖配置档风格）、`voice`（可选，覆盖音色）。
- 流程：`getSettings()` → `tts.synthesizeForSettings({text, settings, voice, style})` →
  `manager.findByAgent(exec.agent).replyTarget` → `mediaSender.sendVoice(target,{localPath})` → 结构化结果
  `{ok:true, provider, voice, format, bytes, filePath, target}`。
- 失败：未启用 → `语音合成未启用（配置档 → 语音（TTS））`；无供应商 → 可读中文；发送失败沿用 send 的 `deliveryUnknown` 语义（原样抛）。
- 能力归属：`PLUGIN_TOOL_CAPABILITIES.qqbot_speak = 'voice'`；`CAPABILITY_TOOLS.voice = []`；
  `DEFAULT_CAPABILITIES.voice = false`；`CAPABILITY_BOUNDARIES.voice` 补一句。
- `lib/tools/index.js` 注册（依赖 `runtime.tts` 缺失时降级不注册并 warn）。
- `lib/host/tools.js buildToolGuide`：可见 `qqbot_speak` 时加一条「需要朗读/发语音时用 qqbot_speak，只适合短句」。

## 9. 视觉接线（已实现）

- `lib/tools/vision.js`：`createVisionTools({ ctx, runtime, config, getSettings, logger })`；
  每次 execute 读 `getSettings()?.vision`，provider/model/maxTokens **无条件**优先于部署 config.vision
  （即：显式调用 `qqbot_describe_image` 时始终用配置档指定的视觉模型；`vision.mode` 只决定「当前消息图片是否内联」，
  `dedicated` 时内联关闭、图片交给该独立模型阅读）。
- `lib/qq/inline-image.js`：`resolveInlinePolicy` 增加 `vision.mode === 'dedicated'` → 不内联
  （图片仍以路径进文本，模型用 `qqbot_describe_image` 走独立视觉模型）。

## 10. 前端（已实现）

新增 `web/src/pages/ModelsPage.tsx`（路由 `/models`，nav group 配置）：

- 顶部：PageHeader + 「配置档」选择器（`useApp().profiles`，默认 activeProfile）；profile 级保存走
  `api.updateProfile(profileId, {data: pathsToPatch(dirty)})`（与 ProfilesPage 同模式）。
- Tabs 数据来自 `GET /api/models/slots`：ready → LLM / 视觉 / 语音 tab；planned → 「更多类型」tab（插槽卡片 + 扩展点说明）。
- LLM tab：`SchemaForm sectionId="model"`（带动态 provider/model 下拉）+ 保存栏 + 说明卡「供应商由宿主管控」。
- 视觉 tab：`SchemaForm sectionId="vision"` + 两种模式的说明卡（跟随 LLM / 独立模型）+ 保存栏。
- 语音 tab：
  - 配置面板（全局）：「TTS 供应商」卡片列表（名称/kind/模型/音色/hasSecret/启用状态）+ 新增/编辑/删除/试听；
    表单由 `GET /api/models/tts/kinds` 的 `fields` 通用渲染（Drawer），secret 字段单独输入且留空=保留；
    试听调 `POST .../test`，用返回 base64 播放 `<audio>` 并显示 bytes/ms。
  - 当前配置档选择：`SchemaForm sectionId="voice"` + 保存栏；空态提示先去全局添加供应商。
- 更多类型 tab：planned slots 卡片（label/desc/extend）。
- `SchemaForm`：支持 `optionsFrom`（ttsProviders / llmProviders / llmModels），动态拉取候选；
  拉取失败时保留当前值为一个选项（不能丢数据）。所有页面共用，改这一处即可。
- `web/src/api/client.ts` + `types.ts` + `normalize.ts`：加 8 个方法/类型（见 §7）。
- `styles.css`：复用 panel/tabs/segmented/field/btn；新增模型页局部类（provider 卡片网格、试听条）。

## 11. 测试与验证

- `npm test`（node --test）；新增测试不得联网（mock 全局 fetch / WebSocket / 子进程）。
- 新增：`test/tts-providers.test.js`（元数据/校验/脱敏）、`test/tts-store.test.js`、`test/tts-engine.test.js`、
  `test/tts-adapters.test.js`（4 个 HTTP kind + custom 三种响应；edge 用本地 WebSocket 替身）、
  `test/models-api.test.js`（console 路由 CRUD/test/slots/llm 容错）、`test/tools-voice.test.js`（qqbot_speak）。
- 既有测试注意：`test/tools-catalog.test.js` 断言 `CAPABILITY_TOOLS` 与 `DEFAULT_CAPABILITIES` key 一致，
  新增 `voice` 需两边都加；`test/tools-factory.test.js` 会断言注册工具集合，需要加 `qqbot_speak`（voice 默认关，默认不注册；
  开启 voice 后注册）。
- 前端：`npm --prefix web run typecheck`、`npm --prefix web run build`（产物提交到 `web/dist`）。

## 12. 兼容 / 安全

- 只新增一个依赖 `ws@^8.21.0`：Edge TTS 握手需要自定义请求头（Origin/UA/Cookie muid），
  Node 24 的全局 WebSocket 无法设置这些头；其余全部零新依赖（本地命令用 node:child_process，
  音频拼接纯 JS，v2 token 只用 node:crypto）。
- ws 在 **Edge 首次合成时才懒加载**：即使某个部署环境没有装到 ws（例如 `--local` 复制安装且
  profile 依赖未 hoist），TTS 引擎照常装配、其余 5 类供应商照常可用，只有 Edge 供应商在调用时
  返回可读的「需要重装插件 / 改用其他供应商」错误；不会出现整个语音能力 501 的情况。
- 不改变既有 LLM 路由/工具策略行为；voice 默认关闭，vision 默认跟随 LLM。
- secret 永不出现在 GET 响应/日志/审计 detail；错误信息截断上游响应体（≤500 字符）。
- 自定义 HTTP / 本地命令属于管理员显式配置的能力，文档标注风险。
