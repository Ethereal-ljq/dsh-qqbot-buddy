/**
 * data-tools —— 数据类工具：memory_* / knowledge_* / member_*（v2 runtime store 适配）。
 *
 * v1 对应 memory-tools.js / knowledge-tools.js / member-tools.js；v2 不搬 v1 文件式 store，
 * 统一走 core/memory、core/kb、core/members 的 SQLite store（runtime.* 由 index 装配）。
 * 依赖缺失时降级不注册（只 warn），不影响其它工具。
 */
function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function warn(logger, ...args) {
  try { (logger ?? console).warn?.(...args); } catch { /* ignore */ }
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

function pickPeer(manager, exec) {
  try {
    const agent = exec && exec.agent;
    const record = agent !== undefined && manager && typeof manager.findByAgent === 'function'
      ? manager.findByAgent(agent)
      : null;
    return record && typeof record.peer === 'string' ? record.peer : '';
  } catch {
    return '';
  }
}

const MEMORY_KINDS = ['fact', 'preference', 'event', 'relation', 'other'];

/** memory_save / memory_search / memory_read / memory_list */
function buildMemoryTools({ memory, botId, manager, logger }) {
  const log = logger || console;
  const owner = String(botId || '');
  return [
    {
      name: 'memory_save',
      description: 'Save one durable fact to long-term memory for this bot. Use for user identity/preferences, '
        + 'long-term agreements, important events or conclusions worth remembering. Duplicate facts are ignored.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact text to remember, one concise sentence.' },
          kind: { type: 'string', enum: MEMORY_KINDS, description: 'Fact category (default fact).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional short keywords.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, created: { type: 'boolean' }, id: { type: 'integer' } },
          required: ['ok', 'created'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.created ? '已记住（id=' + value.id + '）' : '已有相似记忆，未重复保存' }],
      },
      async execute(args, exec) {
        const text = typeof args?.content === 'string' ? args.content.trim() : '';
        if (text === '') throw new Error('memory_save: content 不能为空');
        const kind = MEMORY_KINDS.includes(args?.kind) ? args.kind : 'fact';
        const tags = Array.isArray(args?.tags) ? args.tags.filter((tag) => typeof tag === 'string') : [];
        const saved = memory.save({ botId: owner, peer: pickPeer(manager, exec), kind, text, tags, source: 'tool' });
        log.info?.('memory_save: ' + (saved.created ? 'created' : 'deduped') + ' id=' + saved.id);
        return { ok: true, created: saved.created === true, id: Number(saved.id) || 0 };
      },
    },
    {
      name: 'memory_search',
      description: 'Search long-term memory of this bot. Use before answering questions about past chats or known facts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords (Chinese or English).' },
          limit: { type: 'integer', description: 'Max results (1-20, default 6).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'integer' }, text: { type: 'string' }, kind: { type: 'string' }, score: { type: 'number' } },
                required: ['id', 'text'],
                additionalProperties: false,
              },
            },
          },
          required: ['results'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          const rows = Array.isArray(value.results) ? value.results : [];
          if (rows.length === 0) return [{ type: 'text', text: '没有找到相关记忆。' }];
          return [{ type: 'text', text: rows.map((row) => '- (' + row.id + ') ' + row.text).join('\n') }];
        },
      },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query === '') throw new Error('memory_search: query 不能为空');
        const limit = clampInt(args?.limit, 1, 20, 6);
        const rows = memory.search({ botId: owner, query, limit }) || [];
        return {
          results: rows.map((row) => ({
            id: Number(row.id) || 0,
            text: String(row.text || ''),
            kind: String(row.kind || ''),
            score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
          })),
        };
      },
    },
    {
      name: 'memory_read',
      description: 'Read one long-term memory entry by id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'Memory id from memory_search/memory_list.' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { found: { type: 'boolean' }, text: { type: 'string' }, kind: { type: 'string' } },
          required: ['found'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.found ? String(value.text || '') : '没有找到该记忆。' }],
      },
      async execute(args) {
        const id = clampInt(args?.id, 1, Number.MAX_SAFE_INTEGER, 0);
        if (id === 0) throw new Error('memory_read: id 非法');
        const row = typeof memory.get === 'function' ? memory.get({ botId: owner, id }) : null;
        return row
          ? { found: true, text: String(row.text || ''), kind: String(row.kind || '') }
          : { found: false };
      },
    },
    {
      name: 'memory_list',
      description: 'List recent long-term memories of this bot (newest first).',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: MEMORY_KINDS, description: 'Optional kind filter.' },
          limit: { type: 'integer', description: 'Max rows (1-50, default 20).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: { id: { type: 'integer' }, text: { type: 'string' }, kind: { type: 'string' } },
                required: ['id', 'text'],
                additionalProperties: false,
              },
            },
          },
          required: ['results'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          const rows = Array.isArray(value.results) ? value.results : [];
          return [{ type: 'text', text: rows.length === 0 ? '还没有长期记忆。' : rows.map((row) => '- (' + row.id + ') ' + row.text).join('\n') }];
        },
      },
      async execute(args) {
        const kind = MEMORY_KINDS.includes(args?.kind) ? args.kind : undefined;
        const limit = clampInt(args?.limit, 1, 50, 20);
        const rows = memory.list({ botId: owner, ...(kind ? { kind } : {}), limit }) || [];
        return { results: rows.map((row) => ({ id: Number(row.id) || 0, text: String(row.text || ''), kind: String(row.kind || '') })) };
      },
    },
  ];
}

/** knowledge_search / knowledge_read / knowledge_save */
function buildKnowledgeTools({ kb, botId, logger }) {
  const log = logger || console;
  const owner = String(botId || '');
  return [
    {
      name: 'knowledge_search',
      description: 'Search the bot knowledge base (docs, FAQs, group rules) and cite the matching chunks.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords.' },
          limit: { type: 'integer', description: 'Max chunks (1-10, default 5).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: { title: { type: 'string' }, text: { type: 'string' }, score: { type: 'number' }, mode: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
              },
            },
          },
          required: ['results'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          const rows = Array.isArray(value.results) ? value.results : [];
          if (rows.length === 0) return [{ type: 'text', text: '知识库没有找到相关内容。' }];
          return [{ type: 'text', text: rows.map((row) => '【' + (row.title || '知识') + '】' + row.text).join('\n\n') }];
        },
      },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (query === '') throw new Error('knowledge_search: query 不能为空');
        const rows = kb.search({ botId: owner, query, limit: clampInt(args?.limit, 1, 10, 5) }) || [];
        return {
          results: rows.map((row) => ({
            title: String(row.title || ''),
            text: String(row.text || ''),
            score: Number.isFinite(Number(row.score)) ? Number(row.score) : 0,
            mode: String(row.mode || ''),
          })),
        };
      },
    },
    {
      name: 'knowledge_read',
      description: 'Read one knowledge document by id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'Doc id from knowledge_search/listDocs.' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { found: { type: 'boolean' }, title: { type: 'string' }, chunks: { type: 'integer' } },
          required: ['found'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.found ? '知识文档：' + (value.title || '') + '（' + (value.chunks || 0) + ' 块）' : '没有找到该知识文档。' }],
      },
      async execute(args) {
        const id = clampInt(args?.id, 1, Number.MAX_SAFE_INTEGER, 0);
        if (id === 0) throw new Error('knowledge_read: id 非法');
        const doc = typeof kb.getDoc === 'function' ? kb.getDoc({ botId: owner, docId: id }) : null;
        return doc ? { found: true, title: String(doc.title || doc.source || ''), chunks: Number(doc.chunkCount) || 0 } : { found: false };
      },
    },
    {
      name: 'knowledge_save',
      description: 'Save/update one knowledge document (group rules, FAQs, conventions). Same source is replaced idempotently.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Document title.' },
          content: { type: 'string', description: 'Markdown content to index.' },
          source: { type: 'string', description: 'Optional stable source id (default: tool:<title>).' },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, docId: { type: 'integer' }, chunks: { type: 'integer' }, changed: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.ok ? '已入库知识「' + (value.docId || '') + '」，共 ' + (value.chunks || 0) + ' 块' : '入库失败' }],
      },
      async execute(args) {
        const title = typeof args?.title === 'string' ? args.title.trim() : '';
        const content = typeof args?.content === 'string' ? args.content : '';
        if (title === '' || content.trim() === '') throw new Error('knowledge_save: title/content 不能为空');
        const source = typeof args?.source === 'string' && args.source.trim() !== '' ? args.source.trim() : 'tool:' + title;
        const result = kb.ingest({ botId: owner, source, title, text: content });
        log.info?.('knowledge_save: ' + source + ' -> ' + (result && result.docId));
        return {
          ok: true,
          docId: Number(result && result.docId) || 0,
          chunks: Number(result && result.chunks) || 0,
          changed: !!(result && result.changed),
        };
      },
    },
  ];
}

/** member_lookup / member_note */
function buildMemberTools({ members, botId, logger }) {
  const log = logger || console;
  const owner = String(botId || '');
  return [
    {
      name: 'member_lookup',
      description: 'Look up a group member by openid or nickname: nickname, notes, profile.',
      parameters: {
        type: 'object',
        properties: {
          openid: { type: 'string', description: 'Member openid (exact).' },
          nickname: { type: 'string', description: 'Nickname keyword when openid is unknown.' },
          limit: { type: 'integer', description: 'Max matches (1-20, default 5).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  openid: { type: 'string' },
                  nickname: { type: 'string' },
                  note: { type: 'string' },
                },
                required: ['openid'],
                additionalProperties: false,
              },
            },
          },
          required: ['results'],
          additionalProperties: false,
        },
        render: (_args, value) => {
          const rows = Array.isArray(value.results) ? value.results : [];
          if (rows.length === 0) return [{ type: 'text', text: '没有找到该群友。' }];
          return [{ type: 'text', text: rows.map((row) => '- ' + (row.nickname || '(无昵称)') + ' (' + row.openid + ')' + (row.note ? '：' + row.note : '')).join('\n') }];
        },
      },
      async execute(args) {
        const openid = typeof args?.openid === 'string' ? args.openid.trim() : '';
        if (openid !== '') {
          const one = members.get({ botId: owner, openid });
          return { results: one ? [{ openid: one.openid, nickname: one.nickname || '', note: one.note || '' }] : [] };
        }
        const query = typeof args?.nickname === 'string' ? args.nickname.trim() : '';
        const rows = members.list({ botId: owner, query, limit: clampInt(args?.limit, 1, 20, 5) }) || [];
        return { results: rows.map((row) => ({ openid: row.openid, nickname: row.nickname || '', note: row.note || '' })) };
      },
    },
    {
      name: 'member_note',
      description: 'Add/update a note or nickname for a group member (bot-scoped member profile).',
      parameters: {
        type: 'object',
        properties: {
          openid: { type: 'string', description: 'Member openid (required).' },
          nickname: { type: 'string', description: 'Nickname to remember.' },
          note: { type: 'string', description: 'Free-form note (max 2000 chars).' },
        },
        required: ['openid'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, created: { type: 'boolean' }, openid: { type: 'string' } },
          required: ['ok', 'openid'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.created ? '已加入群友库：' + value.openid : '已更新群友备注：' + value.openid }],
      },
      async execute(args) {
        const openid = typeof args?.openid === 'string' ? args.openid.trim() : '';
        if (openid === '') throw new Error('member_note: openid 不能为空');
        const input = { botId: owner, openid };
        if (typeof args?.nickname === 'string' && args.nickname.trim() !== '') input.nickname = args.nickname.trim();
        if (typeof args?.note === 'string' && args.note.trim() !== '') input.note = args.note.trim();
        const saved = members.upsert(input);
        log.info?.('member_note: ' + openid);
        return { ok: true, created: saved.created === true, openid };
      },
    },
  ];
}

/**
 * 创建数据类工具定义。
 * @param {object} deps
 * @param {object} [deps.memory] runtime.memory
 * @param {object} [deps.kb] runtime.kb
 * @param {object} [deps.members] runtime.members
 * @param {string} deps.botId
 * @param {object} deps.manager 会话适配器（findByAgent -> record.peer）
 * @param {object} [deps.logger]
 * @returns {object[]}
 */
export function createDataTools({ memory, kb, members, botId, manager, logger } = {}) {
  const out = [];
  if (memory && typeof memory.save === 'function' && typeof memory.search === 'function') {
    try { out.push(...buildMemoryTools({ memory, botId, manager, logger })); } catch (err) {
      warn(logger, 'memory 工具定义构造失败: ' + errText(err));
    }
  }
  if (kb && typeof kb.search === 'function' && typeof kb.ingest === 'function') {
    try { out.push(...buildKnowledgeTools({ kb, botId, logger })); } catch (err) {
      warn(logger, 'knowledge 工具定义构造失败: ' + errText(err));
    }
  }
  if (members && typeof members.upsert === 'function' && typeof members.list === 'function') {
    try { out.push(...buildMemberTools({ members, botId, logger })); } catch (err) {
      warn(logger, 'member 工具定义构造失败: ' + errText(err));
    }
  }
  return out;
}

export default createDataTools;
