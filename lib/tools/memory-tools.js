/**
 * memory-tools —— 注册 memory_save / memory_search / memory_read / memory_list 四个工具。
 *
 * 注册形态参考官方 dist/media/send-file-tool.js：
 *   ctx.get('tools').register({ name, description, parameters, output: { schema, render }, execute })
 * - 工具服务缺失时只告警、不抛错（宿主仍可启动）；
 * - 每个工具单独 try/catch 注册，单个失败不影响其它工具；
 * - execute 返回 output.schema 约定形状的普通对象，render 负责转成模型可见文本。
 * - 返回值是聚合 dispose（便于宿主 ctx.effect 清理）。
 */

/** 工具名（统一 memory_ 前缀，避免与其它通道工具冲突） */
export const MEMORY_TOOL_NAMES = Object.freeze([
  'memory_save',
  'memory_search',
  'memory_read',
  'memory_list',
]);

/** 安全取日志方法 */
function warn(logger, ...args) {
  try {
    (logger ?? console).warn?.(...args);
  } catch { /* logger 失败不能影响注册 */ }
}

/** 输出 schema 通用片段 */
const FILE_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    size: { type: 'integer' },
    mtime: { type: 'number' },
  },
  required: ['name', 'size', 'mtime'],
  additionalProperties: false,
};

/**
 * 构造四个工具定义。
 * @param {object} memoryStore createMemoryStore 的返回值
 * @param {object} logger
 */
function buildDefinitions(memoryStore, logger, storeFor) {
  /** 按本次调用所属机器人取 store（多机器人路由）；旧单机器人模式直接用 memoryStore。 */
  const pick = (exec) => {
    if (typeof storeFor === 'function') {
      const routed = storeFor(exec);
      if (routed) return routed;
    }
    return memoryStore;
  };
  const save = {
    name: 'memory_save',
    description:
      'Save one durable fact to long-term memory (MEMORY.md + daily notes). Use for user identity/preferences, '
      + 'long-term agreements, important events or conclusions worth remembering. Do not save greetings, '
      + 'one-off small talk or tool-call details. Duplicate facts are ignored (duplicate=true).',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact text to remember, one concise sentence or short paragraph.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional short keywords (max 8), e.g. ["偏好","称呼"].',
        },
        importance: {
          type: 'string',
          enum: ['normal', 'high'],
          description: 'Importance level; high marks the entry as important in daily notes.',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          duplicate: { type: 'boolean' },
          file: { type: 'string' },
          entry: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['ok', 'duplicate', 'file', 'entry', 'path'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        return [{
          type: 'text',
          text: v.duplicate ? `该信息已在记忆中，无需重复保存：${v.entry ?? ''}` : `已记住：${v.entry ?? ''}`,
        }];
      },
    },
    async execute(args, exec) {
      const content = args && typeof args.content === 'string' ? args.content.trim() : '';
      if (content === '') throw new Error('memory_save: content 必须是非空字符串');
      const tags = Array.isArray(args.tags) ? args.tags : [];
      const importance = args.importance === 'high' ? 'high' : 'normal';
      return pick(exec).saveFact({ text: content, tags, importance, source: 'tool' });
    },
  };

  const search = {
    name: 'memory_search',
    description:
      'Full-text search over the bot memory directory (MEMORY.md and daily notes). Match is case-insensitive '
      + 'plain substring matching. Use it whenever you need to recall something said before instead of guessing.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive substring).' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum number of matching lines to return (1..20, default 8).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                line: { type: 'integer' },
                text: { type: 'string' },
              },
              required: ['file', 'line', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['count', 'results'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const results = Array.isArray(v.results) ? v.results : [];
        if (results.length === 0) return [{ type: 'text', text: '没有找到相关记忆。' }];
        const lines = results.map((r) => `${r.file}:${r.line} | ${r.text}`);
        return [{ type: 'text', text: `找到 ${results.length} 条匹配：\n${lines.join('\n')}` }];
      },
    },
    async execute(args, exec) {
      const query = args && typeof args.query === 'string' ? args.query : '';
      if (query.trim() === '') throw new Error('memory_search: query 必须是非空字符串');
      const results = pick(exec).search(query, args.limit);
      return { count: results.length, results };
    },
  };

  const read = {
    name: 'memory_read',
    description:
      'Read one markdown file from the bot memory directory. Defaults to MEMORY.md. '
      + 'Use it to inspect the long-term memory file or a daily note (e.g. notes/2026-10-25.md).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the memory root, ending with .md. Defaults to MEMORY.md.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['path', 'text'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        return [{ type: 'text', text: String(v.text ?? '') }];
      },
    },
    async execute(args, exec) {
      const rel = args && typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : 'MEMORY.md';
      return pick(exec).readFile(rel);
    },
  };

  const list = {
    name: 'memory_list',
    description:
      'List the bot memory directory: relative file names, sizes and total character count of markdown files. '
      + 'Use it to see which memory files exist before reading one.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dir: { type: 'string' },
          exists: { type: 'boolean' },
          files: { type: 'array', items: FILE_ENTRY_SCHEMA },
          totalChars: { type: 'integer' },
        },
        required: ['dir', 'exists', 'files', 'totalChars'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const files = Array.isArray(v.files) ? v.files : [];
        if (!v.exists) return [{ type: 'text', text: `记忆目录尚未创建：${v.dir ?? ''}` }];
        if (files.length === 0) return [{ type: 'text', text: `记忆目录为空：${v.dir ?? ''}` }];
        const lines = files.map((f) => `- ${f.name}（${f.size} 字节）`);
        return [{
          type: 'text',
          text: `记忆目录：${v.dir}\n共 ${files.length} 个文件，${v.totalChars ?? 0} 字\n${lines.join('\n')}`,
        }];
      },
    },
    async execute(_args, exec) {
      return pick(exec).layout();
    },
  };

  return [save, search, read, list];
}

/**
 * 注册 memory_* 工具。
 * @returns {() => void} 聚合 dispose；工具服务不可用时返回空函数
 */
export function registerMemoryTools(ctx, memoryStoreOrOptions, loggerArg) {
  // 兼容两种调用：
  //   registerMemoryTools(ctx, memoryStore, logger)                     —— 旧单机器人
  //   registerMemoryTools(ctx, { memoryStore, resolveBot, logger })      —— 多机器人路由
  const isOptions = memoryStoreOrOptions && typeof memoryStoreOrOptions === 'object'
    && (typeof memoryStoreOrOptions.memoryStore === 'object' || typeof memoryStoreOrOptions.resolveBot === 'function');
  const memoryStore = isOptions ? memoryStoreOrOptions.memoryStore : memoryStoreOrOptions;
  const logger = isOptions ? (memoryStoreOrOptions.logger || loggerArg) : loggerArg;
  const resolveBot = isOptions && typeof memoryStoreOrOptions.resolveBot === 'function'
    ? memoryStoreOrOptions.resolveBot
    : null;
  const storeFor = resolveBot
    ? (exec) => {
      const bot = resolveBot(exec);
      return bot && bot.memory ? bot.memory : null;
    }
    : null;
  let tools;
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined;
  } catch (err) {
    warn(logger, 'memory 工具注册：读取 tools 服务异常:', err && err.message);
    tools = undefined;
  }
  if (!tools || typeof tools.register !== 'function') {
    warn(logger, 'memory 工具注册：tools 服务不可用，memory_save/search/read/list 未注册');
    return () => {};
  }
  if (!storeFor && (!memoryStore || typeof memoryStore.saveFact !== 'function')) {
    warn(logger, 'memory 工具注册：memoryStore 不可用，跳过注册');
    return () => {};
  }

  const disposers = [];
  for (const definition of buildDefinitions(memoryStore, logger, storeFor)) {
    try {
      const dispose = tools.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (err) {
      warn(logger, `memory 工具注册失败（${definition.name}）:`, err && err.message);
    }
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (err) {
        warn(logger, 'memory 工具注销失败:', err && err.message);
      }
    }
  };
}
