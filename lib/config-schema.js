/**
 * Cordis 插件配置 Schema（只放"部署级"配置：凭据、cwd、preset、超时等）。
 * 用户可在设置页调整的运行期配置在 settings-store.js 管理（JSON 落盘，热生效）。
 */
import Schema from '@deepseek-ai/schemastery';

export const ConfigSchema = Schema.object({
  appId: Schema.string().default('').description('QQ 机器人 AppID（也可用 QQBOT_APPID）'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret（也可用 QQBOT_SECRET）'),
  cwd: Schema.string().default('').description('bot 工作目录；空 = process.cwd()'),
  workspaceRoot: Schema.string().default('').description('多机器人工作区根；空 = cwd。新机器人建在 <root>/bots/<id>，bots.json 也在根下'),
  maxBots: Schema.number().default(8).description('最多同时配置的机器人数'),
  registerTools: Schema.boolean().default(true).description('是否注册插件工具（测试/多实例部署时可关）'),
  preset: Schema.string().default('qqbot-buddy').description('Agent preset id（默认由本包 cordis.patch.yml 提供）'),
  provider: Schema.string().default('').description('LLM provider；空 = 宿主默认'),
  model: Schema.string().default('').description('LLM model；空 = 宿主默认'),
  reasoningEffort: Schema.string().default('').description('LLM 推理强度；空 = 跟随模型默认'),
  stateDir: Schema.string().default('').description('插件状态目录；空 = ~/.dsh-qqbot/buddy'),
  mediaDir: Schema.string().default('').description('媒体目录；空 = ~/.dsh-qqbot/media'),
  settingsFile: Schema.string().default('').description('settings.json 路径；空 = <stateDir>/settings.json'),
  profileDir: Schema.string().default('').description('DSH profile 目录覆盖（空 = 自动探测）；测试隔离时指向临时 profile 副本，避免写 live 配置'),
  textChunkLimit: Schema.number().default(4500).description('单条 QQ 消息最大字符数'),
  historyLimit: Schema.number().default(20).description('群聊历史上下文条数'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置回收(ms)'),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('单轮处理超时(ms)'),
  maxQueue: Schema.number().default(20).description('同 peer 排队上限'),
  autoStart: Schema.boolean().default(true).description('自动连接 QQ（false 时只挂设置页，便于调试）'),
  bindOnMissingCredentials: Schema.boolean().default(true).description('缺少凭据时自动启动扫码绑定流程'),
  debug: Schema.boolean().default(false),
  access: Schema.object({
    c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open'),
    c2cAllow: Schema.array(Schema.string()).default([]),
    groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open'),
    groupAllow: Schema.array(Schema.string()).default([]),
  }).default({ c2cMode: 'open', c2cAllow: [], groupMode: 'open', groupAllow: [] }),
  sendFile: Schema.object({
    restrictPaths: Schema.boolean().default(true),
    extraRoots: Schema.array(Schema.string()).default([]),
  }).default({ restrictPaths: true, extraRoots: [] }),
  vision: Schema.object({
    enabled: Schema.boolean().default(true),
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
    defaultPrompt: Schema.string().default('用中文详细描述这张图片的内容。'),
    maxBytes: Schema.number().default(10 * 1024 * 1024),
    maxTokens: Schema.number().default(4096),
    timeoutMs: Schema.number().default(120000),
  }).default({
    enabled: true, provider: '', model: '', defaultPrompt: '用中文详细描述这张图片的内容。',
    maxBytes: 10 * 1024 * 1024, maxTokens: 4096, timeoutMs: 120000,
  }),
});

export default ConfigSchema;