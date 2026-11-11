/**
 * history-tools —— 消息流水检索工具：chat_history_search / chat_history_recent。
 *
 * 为什么需要：
 *   SDK 的 historyBuffer 只给模型最近 20 条，且重启即丢。模型被问「上次说的那个」
 *   「前天群里谁提过 X」时完全无从下手。消息流水（core/messages/store.js）落库后，
 *   这里给模型显式检索能力——这是「记忆」之外的另一条腿：记忆是提炼后的结论，
 *   消息是原始记录。
 *
 * 依赖缺失时降级不注册（与 data-tools 一致）。
 */

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function clampInt(value, min, max, fallback) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** 时间描述 -> 毫秒时间戳（支持 "2h" / "3d" / ISO 日期）。 */
function parseSince(value) {
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const text = value.trim();
  const rel = text.match(/^(\d+)\s*([hdm])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === 'h' ? 3600000 : (unit === 'd' ? 86400000 : 60000);
    return Date.now() - n * ms;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 时间戳 -> 可读时间（模型看日期比看毫秒有用）。 */
function formatTime(ts) {
  const ms = Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 一条消息渲染成模型可读的一行。 */
function formatRow(row, { withDate = true } = {}) {
  const who = row.role === 'assistant'
    ? '助手'
    : (row.senderName || (row.senderId ? String(row.senderId).slice(0, 8) : '未知'));
  const when = withDate ? formatTime(row.createdAt) + ' ' : '';
  return when + who + '：' + String(row.content || '').replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * 构造消息检索工具定义。
 * @param {object} args
 * @param {object} args.messages createMessagesStore() 返回的 store
 * @param {string} args.botId
 * @param {Function} [args.resolvePeer] (agent) => 当前会话 peer（用于「本群」默认检索）
 * @param {object} [args.logger]
 * @returns {Array<object>} 工具定义数组
 */
export function buildHistoryTools({ messages, botId, resolvePeer, logger } = {}) {
  const log = logger || console;
  const owner = String(botId || '');
  const out = [];

  out.push({
    name: 'chat_history_search',
    description: 'Search past QQ messages (local SQLite, last 14 days by default). '
      + 'Use it when someone refers to something said earlier ("上次说的", "之前谁提过"), '
      + 'or when you need to check what was actually said rather than guess. '
      + 'Searches across all conversations unless peer is given.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to search in message text.' },
        peer: { type: 'string', description: 'Limit to one conversation: "group:<openid>" or "c2c:<openid>". Omit for all.' },
        sender: { type: 'string', description: 'Limit to one speaker: nickname or openid.' },
        since: { type: 'string', description: 'Time window start: "2h", "3d", or an ISO date. Default: all retained.' },
        limit: { type: 'integer', description: 'Max results (1-50, default 10).' },
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
                when: { type: 'string' },
                who: { type: 'string' },
                text: { type: 'string' },
                peer: { type: 'string' },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
          total: { type: 'integer' },
        },
        required: ['results'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const rows = Array.isArray(value.results) ? value.results : [];
        if (rows.length === 0) return [{ type: 'text', text: '没有找到匹配的历史消息。' }];
        return [{ type: 'text', text: rows.map((r) => '- [' + r.when + '] ' + r.who + '：' + r.text).join('\n') }];
      },
    },
    async execute(args) {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      const peerArg = typeof args?.peer === 'string' ? args.peer.trim() : '';
      const senderArg = typeof args?.sender === 'string' ? args.sender.trim() : '';
      const since = parseSince(args?.since);
      const limit = clampInt(args?.limit, 1, 50, 10);

      // sender 既可能是昵称也可能是 openid：昵称情况退化为关键词外的额外过滤不了，
      // 这里只在看起来像 openid（全大写十六进制/长串）时按 senderId 过滤。
      const senderId = /^[A-F0-9]{16,}$/i.test(senderArg) ? senderArg : '';

      const rows = messages.search({
        botId: owner,
        peer: peerArg,
        query,
        senderId,
        since,
        limit,
      }) || [];

      const results = rows
        .filter((row) => (senderArg === '' || senderId !== '' || (row.senderName || '').includes(senderArg)))
        .map((row) => ({
          when: formatTime(row.createdAt),
          who: row.role === 'assistant' ? '助手' : (row.senderName || (row.senderId || '').slice(0, 8)),
          text: String(row.content || '').replace(/\s+/g, ' ').slice(0, 300),
          peer: row.peer,
        }));
      log.debug?.('chat_history_search: query=' + query + ' hits=' + results.length);
      return { results, total: results.length };
    },
  });

  out.push({
    name: 'chat_history_recent',
    description: 'List the most recent messages in the CURRENT conversation (local SQLite). '
      + 'Useful to recover context older than the in-memory window, or after a restart.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many messages (1-50, default 20).' },
        peer: { type: 'string', description: 'Override conversation; omit to use the current one.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          messages: { type: 'array', items: { type: 'string' } },
          peer: { type: 'string' },
        },
        required: ['messages'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const rows = Array.isArray(value.messages) ? value.messages : [];
        if (rows.length === 0) return [{ type: 'text', text: '这个会话还没有历史消息记录。' }];
        return [{ type: 'text', text: rows.join('\n') }];
      },
    },
    async execute(args, exec) {
      let peer = typeof args?.peer === 'string' ? args.peer.trim() : '';
      if (peer === '' && typeof resolvePeer === 'function') {
        // resolvePeer 需要当前 agent 才能定位会话，所以要在 execute 里把 exec.agent 传下去
        try { peer = String(resolvePeer(exec && exec.agent) || ''); } catch { peer = ''; }
      }
      if (peer === '') throw new Error('chat_history_recent: 无法确定当前会话，请显式传 peer');
      const limit = clampInt(args?.limit, 1, 50, 20);
      const rows = messages.list({ botId: owner, peer, limit }) || [];
      // store 返回时间倒序，这里翻正给模型（越往下越新）
      const lines = rows.slice().reverse().map((row) => formatRow(row));
      return { messages: lines, peer };
    },
  });

  return out;
}

export default buildHistoryTools;
