/**
 * cordis 部署级配置（只放"启动时才知道"的东西）。
 * 运行期可变配置在 core/config/schema.js（SQLite，控制台可改）。
 */
import Schema from '@deepseek-ai/schemastery';

export const ConfigSchema = Schema.object({
  dataDir: Schema.string().default('').description('运行数据目录（DB/日志/控制台 token）；空 = ~/.dsh-qqbot/v2'),
  workspaceRoot: Schema.string().default('').description('DSH 工作区根；每个 bot 的 agent cwd = <root>/bots/<botId>；空 = process.cwd()'),
  maxBots: Schema.number().default(16).description('最多配置的机器人数'),
  autoStart: Schema.boolean().default(true).description('插件加载后自动启动启用的机器人'),
  debug: Schema.boolean().default(false).description('调试日志；并把 runtime 挂到 globalThis 供探针使用'),
  console: Schema.object({
    enabled: Schema.boolean().default(true),
    host: Schema.string().default('127.0.0.1'),
    port: Schema.number().default(6198),
    token: Schema.string().default('').description('控制台登录 token；空 = 首次启动自动生成并写入 <dataDir>/console-token.txt'),
  }).default({ enabled: true, host: '127.0.0.1', port: 6198, token: '' }),
  textChunkLimit: Schema.number().default(4500).description('单条 QQ 消息最大字符数'),
  historyLimit: Schema.number().default(20).description('群聊历史上下文条数'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置回收(ms)'),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('单轮处理超时(ms)'),
  maxQueue: Schema.number().default(20).description('同 peer 排队上限'),
  // 默认拒绝：没配置就不放行任何人（allowlist + 空名单）。要放开必须显式写 open，
  // 而 open 意味着任何能私聊或在群里 @ 机器人的人都能驱动本机 agent。
  access: Schema.object({
    c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('allowlist')
      .description('私聊访问策略：allowlist（默认，仅 c2cAllow 内的 openid 可用）/ open（任何人都能驱动本机 agent）/ disabled'),
    c2cAllow: Schema.array(Schema.string()).default([])
      .description('私聊白名单 openid；被拦截时日志会打印你的 openid，也可在控制台消息流水里查看'),
    groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('allowlist')
      .description('群聊访问策略：allowlist（默认，仅 groupAllow 内的群 openid 可用）/ open / disabled'),
    groupAllow: Schema.array(Schema.string()).default([])
      .description('群白名单 openid（群 openid，不是群号）；被拦截时日志会打印'),
  }).default({ c2cMode: 'allowlist', c2cAllow: [], groupMode: 'allowlist', groupAllow: [] }),
});

export default ConfigSchema;
