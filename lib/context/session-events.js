/**
 * context/session-events —— 从 dsh session record 里取消息事件（提炼器共用）。
 *
 * 兼容性（踩过的坑）：
 * - 不同版本事件形态：{ type, message: {content} } 或 { type, data: { message: {content} } }；
 * - session 可能是 record.session / record.agent.session，events 可能是数组、getter 函数、
 *   snapshotEvents() 或 log 数组；
 * - 只取 user/message、assistant/message 的文本块，其它事件忽略。
 */

function safeGet(target, key) {
  if (!target || typeof target !== 'object') return undefined;
  try {
    return target[key];
  } catch {
    return undefined;
  }
}

function readEventsCandidate(candidate, receiver) {
  if (Array.isArray(candidate)) return candidate;
  if (typeof candidate === 'function') {
    try {
      const value = candidate.call(receiver);
      if (Array.isArray(value)) return value;
    } catch { /* ignore */ }
  }
  return undefined;
}

function readSessionEvents(session) {
  if (!session || typeof session !== 'object') return undefined;
  const direct = Array.isArray(session.events) ? session.events : undefined;
  if (direct) return direct;
  const viaFn = readEventsCandidate(session.events, session);
  if (viaFn) return viaFn;
  if (typeof session.snapshotEvents === 'function') {
    try {
      const value = session.snapshotEvents();
      if (Array.isArray(value)) return value;
    } catch { /* ignore */ }
  }
  if (Array.isArray(session.log)) return session.log;
  return undefined;
}

export function getEvents(record) {
  if (!record || typeof record !== 'object') return [];
  const sessions = [];
  const directSession = safeGet(record, 'session');
  if (directSession && typeof directSession === 'object') sessions.push(directSession);
  const agent = safeGet(record, 'agent');
  const agentSession = safeGet(agent, 'session');
  if (agentSession && typeof agentSession === 'object') sessions.push(agentSession);

  const direct = readEventsCandidate(safeGet(record, 'events'), record);
  if (direct) return direct;
  for (const session of sessions) {
    const events = readEventsCandidate(session.events, session);
    if (events) return events;
  }
  for (const session of sessions) {
    const events = readSessionEvents(session);
    if (events) return events;
  }
  const selfEvents = readSessionEvents(record);
  if (selfEvents) return selfEvents;
  return [];
}

/** 事件 → 文本（content 可能是字符串或 block 数组） */
export function blocksToText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function extractMessages(events) {
  const messages = [];
  if (!Array.isArray(events)) return messages;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    // 形态 1：{ data: { message: { content } } }；形态 2：{ message: { content } }；形态 3：{ data: { content } }
    const data = event.data;
    const message = data && typeof data === 'object'
      ? (data.message && typeof data.message === 'object' ? data.message : data)
      : (event.message && typeof event.message === 'object' ? event.message : null);
    if (!message) continue;
    const text = blocksToText(message.content);
    if (text === '') continue;
    messages.push({ role: type === 'user/message' ? 'user' : 'assistant', text });
  }
  return messages;
}

export default { getEvents, extractMessages, blocksToText };
