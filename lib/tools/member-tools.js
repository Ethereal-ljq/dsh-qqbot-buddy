/**
 * member-tools —— 注册 member_lookup / member_note 两个工具（群友库）。
 *
 * 注册形态与 knowledge-tools / memory-tools 一致：
 *   ctx.get('tools').register({ name, description, parameters, output: { schema, render }, execute })
 * - execute(args, exec)：第二个参数交给 resolveBot 路由到当前机器人，拿不到时回退传入的 members store；
 * - 工具服务缺失 / store 不可用时只告警、不抛错；返回聚合 dispose。
 *
 * 注册签名（兼容两种写法）：
 *   registerMemberTools(ctx, { resolveBot, members, logger })
 *   registerMemberTools(ctx, memberStore, logger)
 */
import { memberId } from '../members/store.js';

/** 工具名（统一 member_ 前缀） */
export const MEMBER_TOOL_NAMES = Object.freeze(['member_lookup', 'member_note']);

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

function isMemberStore(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.save === 'function'
    && typeof value.list === 'function'
    && typeof value.get === 'function';
}

function normalizeOptions(options, logger) {
  if (options && typeof options === 'object' && !Array.isArray(options)
    && ('resolveBot' in options || 'members' in options || 'knowledge' in options || 'store' in options || 'logger' in options)) {
    return {
      resolveBot: options.resolveBot,
      store: options.members ?? options.store,
      logger: options.logger ?? logger,
    };
  }
  if (isMemberStore(options)) return { store: options, logger };
  return { logger };
}

function makeResolver({ resolveBot, fallback, logger }) {
  return async function resolveStore(exec) {
    if (typeof resolveBot === 'function') {
      let bot;
      try {
        bot = await resolveBot(exec);
      } catch (err) {
        warn(logger, 'member 工具：resolveBot 失败，回退默认群友库:', err && err.message);
      }
      if (bot && typeof bot === 'object') {
        const candidate = isMemberStore(bot.members) ? bot.members
          : (isMemberStore(bot.memberStore) ? bot.memberStore
            : (isMemberStore(bot) ? bot : null));
        if (candidate) return candidate;
      }
    }
    return isMemberStore(fallback) ? fallback : null;
  };
}

/** 工具输出里的成员形状（与 member store 的 list item 对齐，裁掉多余字段） */
const GROUP_SCHEMA = {
  type: 'object',
  properties: {
    groupId: { type: 'string' },
    name: { type: 'string' },
    messageCount: { type: 'integer' },
    lastSeenAt: { type: 'string' },
  },
  required: ['groupId', 'name', 'messageCount', 'lastSeenAt'],
  additionalProperties: false,
};

const MEMBER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    openid: { type: 'string' },
    name: { type: 'string' },
    aliases: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
    groups: { type: 'array', items: GROUP_SCHEMA },
    lastSeenAt: { type: 'string' },
    messageCount: { type: 'integer' },
  },
  required: ['id', 'openid', 'name', 'aliases', 'tags', 'note', 'groups', 'lastSeenAt', 'messageCount'],
  additionalProperties: false,
};

/** 条目/列表项 → 输出 schema 形状 */
function toMemberPayload(item) {
  const source = item && typeof item === 'object' ? item : {};
  return {
    id: asString(source.id),
    openid: asString(source.openid),
    name: asString(source.name),
    aliases: Array.isArray(source.aliases) ? source.aliases.filter((value) => typeof value === 'string') : [],
    tags: Array.isArray(source.tags) ? source.tags.filter((value) => typeof value === 'string') : [],
    note: asString(source.note),
    groups: Array.isArray(source.groups)
      ? source.groups.map((group) => ({
        groupId: asString(group?.groupId),
        name: asString(group?.name),
        messageCount: clampInt(group?.messageCount, 0, Number.MAX_SAFE_INTEGER, 0),
        lastSeenAt: asString(group?.lastSeenAt),
      }))
      : [],
    lastSeenAt: asString(source.lastSeenAt),
    messageCount: clampInt(source.messageCount, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

/** 单条成员条目 → 输出形状（openid 查找用） */
function itemFromEntry(entry) {
  const meta = entry?.meta && typeof entry.meta === 'object' ? entry.meta : {};
  const groups = meta.groups && typeof meta.groups === 'object' && !Array.isArray(meta.groups) ? meta.groups : {};
  const groupItems = Object.entries(groups).map(([groupId, value]) => {
    const group = value && typeof value === 'object' ? value : {};
    return {
      groupId,
      name: asString(group.name),
      messageCount: clampInt(group.messageCount, 0, Number.MAX_SAFE_INTEGER, 0),
      lastSeenAt: asString(group.lastSeenAt),
    };
  }).sort((a, b) => (Date.parse(b.lastSeenAt) || 0) - (Date.parse(a.lastSeenAt) || 0));
  let lastSeenAt = '';
  let messageCount = 0;
  for (const group of groupItems) {
    messageCount += group.messageCount;
    if (group.lastSeenAt > lastSeenAt) lastSeenAt = group.lastSeenAt;
  }
  return {
    id: asString(entry?.id),
    openid: asString(meta.openid),
    name: asString(entry?.title) || asString(meta.name),
    aliases: Array.isArray(meta.aliases) ? meta.aliases.filter((value) => typeof value === 'string') : [],
    tags: Array.isArray(entry?.tags) ? entry.tags.filter((value) => typeof value === 'string') : [],
    note: asString(entry?.body),
    groups: groupItems,
    lastSeenAt,
    messageCount,
  };
}

/**
 * 构造工具定义。
 * @param {{resolveBot?:Function, fallback?:object, logger?:object}} deps
 */
function buildDefinitions({ resolveBot, fallback, logger }) {
  const log = logger ?? console;
  const resolveStore = makeResolver({ resolveBot, fallback, logger: log });

  const lookup = {
    name: 'member_lookup',
    description:
      'Look up group members (the bot keeps a profile per QQ openid: nickname, aliases, tags, notes, '
      + 'per-group message counts and last-seen time). Pass openid for one exact person, or groupId/query '
      + 'to list matching regulars of the current group. Use it to address people correctly or check what '
      + 'the bot already knows about someone.',
    parameters: {
      type: 'object',
      properties: {
        openid: { type: 'string', description: 'Exact member openid (returns one member).' },
        query: { type: 'string', description: 'Optional name / alias / note keyword.' },
        groupId: { type: 'string', description: 'Optional current group id; only members seen in it are listed.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max members (1..20, default 8).' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          members: { type: 'array', items: MEMBER_SCHEMA },
        },
        required: ['count', 'members'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const members = Array.isArray(v.members) ? v.members : [];
        if (members.length === 0) return [{ type: 'text', text: '没有找到符合条件的群友。' }];
        const lines = members.map((item) => {
          const tags = item.tags.length > 0 ? `（${item.tags.join(', ')}）` : '';
          const group = item.groups.length > 0 ? ` · ${item.groups.length} 个群` : '';
          const note = item.note ? `\n  ${item.note.slice(0, 100)}` : '';
          return `- ${item.name || '未命名'}#${item.id}（发言 ${item.messageCount} 次${group}）${tags}${note}`;
        });
        return [{ type: 'text', text: `共 ${members.length} 位相关群友：\n${lines.join('\n')}` }];
      },
    },
    async execute(args, exec) {
      const store = await resolveStore(exec);
      if (!store) throw new Error('member_lookup: 群友库不可用（未配置或已关闭）');
      const openid = asString(args?.openid).trim();
      if (openid !== '') {
        const id = typeof store.idFor === 'function' ? store.idFor(openid) : memberId(openid);
        let item = null;
        if (typeof store.get === 'function') {
          const entry = store.get(id);
          if (entry) item = itemFromEntry(entry);
        }
        return { count: item ? 1 : 0, members: item ? [toMemberPayload(item)] : [] };
      }
      const query = asString(args?.query).trim();
      const groupId = asString(args?.groupId).trim();
      const limit = clampInt(args?.limit, 1, 20, 8);
      const listed = store.list({ q: query, groupId, limit });
      const members = (Array.isArray(listed?.items) ? listed.items : []).map(toMemberPayload);
      return { count: members.length, members };
    },
  };

  const note = {
    name: 'member_note',
    description:
      'Create or update the bot\'s note for one group member (profile tags, free-form notes, importance). '
      + 'Use it after learning something durable about a person (role, preferences, how to address them). '
      + 'Pass id from member_lookup, or openid when the member is new. Do not record sensitive guesses.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Member id from member_lookup (m_xxx).' },
        openid: { type: 'string', description: 'Member openid; creates the member when it does not exist.' },
        name: { type: 'string', description: 'Display name / nickname to store.' },
        aliases: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional aliases or nicknames (max 8).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags (max 12), e.g. ["老群友", "程序员"].',
        },
        note: { type: 'string', description: 'Free-form note (markdown), keep it factual and short.' },
        importance: { type: 'integer', minimum: 0, maximum: 3, description: 'Importance 0..3.' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          name: { type: 'string' },
          created: { type: 'boolean' },
          updatedAt: { type: 'string' },
        },
        required: ['ok', 'id', 'name', 'created', 'updatedAt'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        return [{
          type: 'text',
          text: v.created === true
            ? `已记录群友 #${v.id}：${v.name}`
            : `已更新群友 #${v.id}：${v.name}`,
        }];
      },
    },
    async execute(args, exec) {
      const store = await resolveStore(exec);
      if (!store) throw new Error('member_note: 群友库不可用（未配置或已关闭）');
      const id = asString(args?.id).trim();
      const openid = asString(args?.openid).trim();
      if (id === '' && openid === '') throw new Error('member_note: id 或 openid 至少提供一个');
      const existing = id !== '' ? store.get(id) : store.getByOpenid?.(openid) ?? null;
      const entry = store.save({
        ...(id === '' ? {} : { id }),
        ...(openid === '' ? {} : { openid }),
        ...(asString(args?.name).trim() === '' ? {} : { name: asString(args.name).trim() }),
        ...(args?.aliases === undefined ? {} : { aliases: args.aliases }),
        ...(args?.tags === undefined ? {} : { tags: args.tags }),
        ...(args?.note === undefined ? {} : { notes: asString(args.note) }),
        importance: clampInt(args?.importance, 0, 3, existing?.importance ?? 0),
      });
      return {
        ok: true,
        id: entry.id,
        name: entry.title,
        created: !existing,
        updatedAt: entry.updatedAt,
      };
    },
  };

  return [lookup, note];
}

/**
 * 注册 member_* 工具。
 * @param {object} ctx 插件上下文
 * @param {{resolveBot?:Function, members?:object, logger?:object}|object} [options]
 * @param {object} [logger]
 * @returns {() => void} 聚合 dispose；工具服务不可用时返回空函数
 */
export function registerMemberTools(ctx, options, logger) {
  const opts = normalizeOptions(options, logger);
  const log = opts.logger ?? console;

  let tools;
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined;
  } catch (err) {
    warn(log, 'member 工具注册：读取 tools 服务异常:', err && err.message);
    tools = undefined;
  }
  if (!tools || typeof tools.register !== 'function') {
    warn(log, `member 工具注册：tools 服务不可用，${MEMBER_TOOL_NAMES.join('/')} 未注册`);
    return () => {};
  }
  if (typeof opts.resolveBot !== 'function' && !isMemberStore(opts.store)) {
    warn(log, 'member 工具注册：既没有 resolveBot 也没有 members store，跳过注册');
    return () => {};
  }

  let definitions;
  try {
    definitions = buildDefinitions({ resolveBot: opts.resolveBot, fallback: opts.store, logger: log });
  } catch (err) {
    warn(log, 'member 工具定义构造失败:', err && err.message);
    return () => {};
  }

  const disposers = [];
  for (const definition of definitions) {
    try {
      const dispose = tools.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (err) {
      warn(log, `member 工具注册失败（${definition.name}）:`, err && err.message);
    }
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (err) {
        warn(log, 'member 工具注销失败:', err && err.message);
      }
    }
  };
}

export default registerMemberTools;
