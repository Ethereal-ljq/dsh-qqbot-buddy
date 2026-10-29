/**
 * knowledge-tools —— 注册 knowledge_search / knowledge_read / knowledge_save 三个工具。
 *
 * 注册形态与 memory-tools / sticker-tools 一致：
 *   ctx.get('tools').register({ name, description, parameters, output: { schema, render }, execute })
 * - 工具服务缺失时只告警、不抛错（宿主仍可启动）；
 * - 每个工具单独 try/catch 注册，单个失败不影响其它工具；
 * - execute(args, exec)：第二个参数交给 resolveBot 路由到当前机器人，拿不到时回退传入的 store；
 * - 返回值是聚合 dispose（便于宿主 ctx.effect 清理）。
 *
 * 注册签名（兼容两种写法）：
 *   registerKnowledgeTools(ctx, { resolveBot, knowledge, logger })
 *   registerKnowledgeTools(ctx, knowledgeStore, logger)
 */
import { ENTRY_SCOPES } from '../entries/store.js';

/** 工具名（统一 knowledge_ 前缀） */
export const KNOWLEDGE_TOOL_NAMES = Object.freeze([
  'knowledge_search',
  'knowledge_read',
  'knowledge_save',
]);

/** 安全取日志方法 */
function warn(logger, ...args) {
  try {
    (logger ?? console).warn?.(...args);
  } catch { /* logger 失败不能影响注册 */ }
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function clampInt(value, min, max, fallback) {
  let num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(num)) return fallback;
  num = Math.trunc(num);
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function isKnowledgeStore(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.save === 'function'
    && typeof value.search === 'function'
    && typeof value.get === 'function';
}

function normalizeOptions(options, logger) {
  if (options && typeof options === 'object' && !Array.isArray(options)
    && ('resolveBot' in options || 'knowledge' in options || 'members' in options || 'logger' in options || 'store' in options)) {
    return {
      resolveBot: options.resolveBot,
      store: options.knowledge ?? options.store,
      logger: options.logger ?? logger,
    };
  }
  if (isKnowledgeStore(options)) return { store: options, logger };
  return { logger };
}

/** 每个工具各自解析 store：resolveBot 优先，失败/为空时回退默认 store */
function makeResolver({ resolveBot, fallback, logger }) {
  return async function resolveStore(exec) {
    if (typeof resolveBot === 'function') {
      let bot;
      try {
        bot = await resolveBot(exec);
      } catch (err) {
        warn(logger, 'knowledge 工具：resolveBot 失败，回退默认知识库:', err && err.message);
      }
      if (bot && typeof bot === 'object') {
        const candidate = isKnowledgeStore(bot.knowledge) ? bot.knowledge
          : (isKnowledgeStore(bot.knowledgeStore) ? bot.knowledgeStore
            : (isKnowledgeStore(bot) ? bot : null));
        if (candidate) return candidate;
      }
    }
    return isKnowledgeStore(fallback) ? fallback : null;
  };
}

/**
 * 构造工具定义。
 * @param {{resolveBot?:Function, fallback?:object, logger?:object}} deps
 */
function buildDefinitions({ resolveBot, fallback, logger }) {
  const log = logger ?? console;
  const resolveStore = makeResolver({ resolveBot, fallback, logger: log });

  const search = {
    name: 'knowledge_search',
    description:
      'Search the bot knowledge base (entries with title, tags, scope and markdown body). '
      + 'Supports Chinese (2-gram) and English word matching. Use it before answering when the user '
      + 'references group rules, past decisions, docs or anything the bot may have saved as knowledge. '
      + 'Pass groupId (current group) to exclude entries scoped to other groups; global entries always match.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for (Chinese or English).' },
        scope: {
          type: 'string',
          enum: [...ENTRY_SCOPES],
          description: 'Optional strict scope filter: global / group / c2c.',
        },
        groupId: {
          type: 'string',
          description: 'Optional current group id. When set, global entries and entries of this group are returned.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (1..20, default 8).' },
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
                id: { type: 'string' },
                title: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                score: { type: 'number' },
                snippet: { type: 'string' },
              },
              required: ['id', 'title', 'tags', 'score', 'snippet'],
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
        if (results.length === 0) return [{ type: 'text', text: '没有找到相关知识。' }];
        const lines = results.map((item) => {
          const tags = Array.isArray(item.tags) && item.tags.length > 0 ? `（${item.tags.join(', ')}）` : '';
          const snippet = item.snippet ? `\n  ${item.snippet}` : '';
          return `- #${item.id} ${item.title}${tags}${snippet}`;
        });
        return [{ type: 'text', text: `找到 ${results.length} 条相关知识：\n${lines.join('\n')}` }];
      },
    },
    async execute(args, exec) {
      const store = await resolveStore(exec);
      if (!store) throw new Error('knowledge_search: 知识库不可用（未配置或已关闭）');
      const query = asString(args?.query);
      if (query.trim() === '') throw new Error('knowledge_search: query 必须是非空字符串');
      const scope = ENTRY_SCOPES.includes(args?.scope) ? args.scope : '';
      const groupId = asString(args?.groupId).trim();
      const limit = clampInt(args?.limit, 1, 20, 8);
      const results = store.search(query, { limit, scope, groupId });
      return { count: results.length, results };
    },
  };

  const read = {
    name: 'knowledge_read',
    description:
      'Read one knowledge entry by id (full markdown body). Use knowledge_search first to get an id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Knowledge entry id, e.g. k_xxx (from knowledge_search).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
          groupId: { type: 'string' },
          importance: { type: 'integer' },
          updatedAt: { type: 'string' },
        },
        required: ['id', 'title', 'body', 'tags', 'scope', 'groupId', 'importance', 'updatedAt'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const head = `【知识 #${v.id}】${v.title}`;
        const meta = [v.scope, v.groupId ? `群 ${v.groupId}` : '', v.tags?.length ? `标签：${v.tags.join(', ')}` : '']
          .filter(Boolean)
          .join(' · ');
        return [{ type: 'text', text: `${head}\n${meta}\n\n${v.body ?? ''}` }];
      },
    },
    async execute(args, exec) {
      const store = await resolveStore(exec);
      if (!store) throw new Error('knowledge_read: 知识库不可用（未配置或已关闭）');
      const id = asString(args?.id).trim();
      if (id === '') throw new Error('knowledge_read: id 必须是非空字符串');
      const entry = store.get(id);
      if (!entry) throw new Error(`knowledge_read: 未找到条目 ${id}`);
      return {
        id: entry.id,
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        scope: entry.scope,
        groupId: entry.groupId,
        importance: entry.importance,
        updatedAt: entry.updatedAt,
      };
    },
  };

  const save = {
    name: 'knowledge_save',
    description:
      'Save one durable knowledge entry (rules, docs, decisions, group facts) so it can be recalled later. '
      + 'Use scope=global for knowledge valid everywhere, scope=group with groupId for the current group only. '
      + 'Prefer one short, self-contained topic per entry. Duplicates are not merged automatically.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short entry title (max 200 chars).' },
        body: { type: 'string', description: 'Markdown body; keep it concise and self-contained.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags (max 12), e.g. ["群规", "活动"].',
        },
        scope: {
          type: 'string',
          enum: [...ENTRY_SCOPES],
          description: 'global (default when no groupId), group (requires groupId) or c2c.',
        },
        groupId: { type: 'string', description: 'Group id when scope=group.' },
        groupName: { type: 'string', description: 'Optional human-readable group name.' },
        importance: { type: 'integer', minimum: 0, maximum: 3, description: 'Importance 0..3 (default 0).' },
        id: { type: 'string', description: 'Optional existing entry id to update in place.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          title: { type: 'string' },
          created: { type: 'boolean' },
          updatedAt: { type: 'string' },
        },
        required: ['ok', 'id', 'title', 'created', 'updatedAt'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        return [{
          type: 'text',
          text: v.created === false
            ? `已更新知识 #${v.id}：${v.title}`
            : `已保存知识 #${v.id}：${v.title}`,
        }];
      },
    },
    async execute(args, exec) {
      const store = await resolveStore(exec);
      if (!store) throw new Error('knowledge_save: 知识库不可用（未配置或已关闭）');
      const title = asString(args?.title).trim();
      if (title === '') throw new Error('knowledge_save: title 必须是非空字符串');
      const scope = ENTRY_SCOPES.includes(args?.scope) ? args.scope : '';
      const groupId = asString(args?.groupId).trim();
      if (scope === 'group' && groupId === '') {
        throw new Error('knowledge_save: scope=group 时 groupId 不能为空');
      }
      const id = asString(args?.id).trim();
      const existing = id === '' ? null : store.get(id);
      const entry = store.save({
        ...(id === '' ? {} : { id }),
        title,
        body: asString(args?.body),
        tags: Array.isArray(args?.tags) ? args.tags.filter((tag) => typeof tag === 'string') : undefined,
        ...(scope === '' ? {} : { scope }),
        ...(groupId === '' ? {} : { groupId }),
        ...(asString(args?.groupName).trim() === '' ? {} : { groupName: asString(args.groupName).trim() }),
        importance: clampInt(args?.importance, 0, 3, 0),
        source: 'tool',
      });
      return {
        ok: true,
        id: entry.id,
        title: entry.title,
        created: !existing,
        updatedAt: entry.updatedAt,
      };
    },
  };

  return [search, read, save];
}

/**
 * 注册 knowledge_* 工具。
 * @param {object} ctx 插件上下文
 * @param {{resolveBot?:Function, knowledge?:object, logger?:object}|object} [options]
 *   resolveBot(exec) 应返回 { knowledge, members } 或 null；knowledge 缺省时回退默认知识库。
 * @param {object} [logger]
 * @returns {() => void} 聚合 dispose；工具服务不可用时返回空函数
 */
export function registerKnowledgeTools(ctx, options, logger) {
  const opts = normalizeOptions(options, logger);
  const log = opts.logger ?? console;

  let tools;
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined;
  } catch (err) {
    warn(log, 'knowledge 工具注册：读取 tools 服务异常:', err && err.message);
    tools = undefined;
  }
  if (!tools || typeof tools.register !== 'function') {
    warn(log, `knowledge 工具注册：tools 服务不可用，${KNOWLEDGE_TOOL_NAMES.join('/')} 未注册`);
    return () => {};
  }
  if (typeof opts.resolveBot !== 'function' && !isKnowledgeStore(opts.store)) {
    warn(log, 'knowledge 工具注册：既没有 resolveBot 也没有 knowledge store，跳过注册');
    return () => {};
  }

  let definitions;
  try {
    definitions = buildDefinitions({ resolveBot: opts.resolveBot, fallback: opts.store, logger: log });
  } catch (err) {
    warn(log, 'knowledge 工具定义构造失败:', err && err.message);
    return () => {};
  }

  const disposers = [];
  for (const definition of definitions) {
    try {
      const dispose = tools.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (err) {
      warn(log, `knowledge 工具注册失败（${definition.name}）:`, err && err.message);
    }
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (err) {
        warn(log, 'knowledge 工具注销失败:', err && err.message);
      }
    }
  };
}

export default registerKnowledgeTools;
