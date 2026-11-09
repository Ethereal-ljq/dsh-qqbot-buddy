/**
 * transcript —— 会话记录的「最近对话转录」缓冲（记忆提炼用，纯内存、非权威）。
 *
 * 为什么需要：v1 的 memory collector 依赖 record.turn.current.text（只有用户最后一句）
 * 逐轮累积；v2 的 core/memory/collect.js 支持 noteTurnEnd(record, { transcript }) 传完整
 * 转录（优先于它自己的缓冲）。这里在协议层维护 user/assistant 两侧的最近 N 条文本，
 * turn/end 时整段交给提炼器，比只给用户一句更准。
 *
 * 约束：只进内存、随会话释放；单条截断 + 总量截断，避免长消息把内存撑大。
 */

/** 单条记录最多保留的字符数。 */
export const MAX_LINE_CHARS = 2000;
/** 最多保留的转录条数（user/assistant 各算一条）。 */
export const MAX_ENTRIES = 40;

function clip(text, maxChars) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : chars.slice(0, maxChars).join('');
}

/**
 * 追加一条转录（就地修改 record.transcriptLog）。
 * @param {object} record BotRuntime 会话记录
 * @param {string} line 已带「用户:」/「助手:」前缀的行
 * @param {{maxEntries?: number, maxChars?: number}} [options]
 */
export function appendTranscript(record, line, options = {}) {
  if (!record || typeof record !== 'object') return;
  const text = clip(line, Number(options.maxChars) > 0 ? Number(options.maxChars) : MAX_LINE_CHARS).trim();
  if (text === '') return;
  if (!Array.isArray(record.transcriptLog)) record.transcriptLog = [];
  record.transcriptLog.push(text);
  const maxEntries = Number(options.maxEntries) > 0 ? Math.floor(Number(options.maxEntries)) : MAX_ENTRIES;
  if (record.transcriptLog.length > maxEntries) {
    record.transcriptLog.splice(0, record.transcriptLog.length - maxEntries);
  }
}

/** 读取整段转录（没有则返回空串）。 */
export function transcriptOf(record) {
  if (!record || !Array.isArray(record.transcriptLog) || record.transcriptLog.length === 0) return '';
  return record.transcriptLog.filter((line) => typeof line === 'string' && line.trim() !== '').join('\n');
}

/** 清空转录（/new 释放会话时可选调用）。 */
export function clearTranscript(record) {
  if (record && Array.isArray(record.transcriptLog)) record.transcriptLog.length = 0;
}
