/**
 * quote-render —— 引用消息的结构化重排。
 *
 * 现场问题（真实案例，2026-11-11）：
 *   群友「院」引用了机器人自己刚说的话（「院长当然算，而且算这群里最像人的那种。」）
 *   然后回了个 ✌️。旧渲染只有：
 *
 *     [Quoted message begins]
 *     院长当然算，而且算这群里最像人的那种。
 *     [Quoted message ends]
 *     [Current message]
 *     [院 (66C13BA8...)] ✌️ (@you)
 *
 *   两个问题：
 *     1. 没有作者归属——模型不知道这段是「自己刚说的」还是「别人说的」，
 *        于是理解不了「院在回应我，表示认同」这层意思。
 *     2. [Current message] 出现两次（历史块尾部一次 + 引用块一次），
 *        结构上无法区分「哪段是引用、哪段是当前消息」。
 *
 * 处理：给出明确的被引用者，并把引用与当前消息用不同标记分开。
 *
 *   短引用（单行）：
 *     [引用 你(助手) 说的话] 院长当然算，而且算这群里最像人的那种。
 *   长引用 / 多行：
 *     [引用 代理人 的消息]
 *     第一行
 *     第二行
 *     [引用结束]
 *
 * 作者判定优先级：
 *   1. quote.entry.isBot === true            -> 你(助手)
 *   2. quote.entry.senderName                -> 该昵称
 *   3. quote.entry.senderId                  -> 前 8 位 openid
 *   4. sentTracker.hasText(引用正文)          -> 你(助手)（机器人自己发的消息不在 quoteRef store 里）
 *   5. 都判断不出                             -> 某位群友
 */

/** 引用正文为空的占位（SDK 在拿不到内容时给的字面量）。 */
const EMPTY_MARKERS = new Set(['[empty message]', '']);
/** 超过这个长度或含换行时改用块状渲染。 */
const INLINE_MAX_CHARS = 100;

/**
 * 判断一段引用正文是不是机器人自己发的。
 * 机器人发出的消息不会经过入站中间件，所以 quoteRef 的 store 里没有它；
 * 用户引用机器人消息时事件只带 msg_elements（无作者），只能靠 sentTracker 认领。
 * @param {string} text
 * @param {object|null} sentTracker
 * @returns {boolean}
 */
export function isSelfQuoted(text, sentTracker) {
  if (!sentTracker || typeof sentTracker.hasText !== 'function') return false;
  try {
    return sentTracker.hasText(text) === true;
  } catch {
    return false;
  }
}

/**
 * 取引用正文（兼容 text / rawContent / entry.content）。
 * @param {object} quote
 * @returns {string}
 */
export function quoteText(quote) {
  const q = quote && typeof quote === 'object' ? quote : {};
  const candidates = [q.text, q.rawContent, q.entry && q.entry.content];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const text = candidate.trim();
    if (text === '') continue;
    if (EMPTY_MARKERS.has(text)) continue;
    return text;
  }
  return '';
}

/**
 * 解析被引用者标签。
 * @param {object} quote ctx.state.quote
 * @param {{sentTracker?: object|null}} [opts]
 * @returns {{label:string, isSelf:boolean}}
 */
export function resolveQuoteAuthor(quote, { sentTracker = null } = {}) {
  const q = quote && typeof quote === 'object' ? quote : {};
  const entry = q.entry && typeof q.entry === 'object' ? q.entry : null;
  if (entry) {
    if (entry.isBot === true) return { label: '你(助手)', isSelf: true };
    const name = typeof entry.senderName === 'string' ? entry.senderName.trim() : '';
    if (name !== '') return { label: name, isSelf: false };
    const id = typeof entry.senderId === 'string' ? entry.senderId.trim() : '';
    if (id !== '') return { label: id.slice(0, 8), isSelf: false };
  }
  const text = quoteText(q);
  if (text !== '' && isSelfQuoted(text, sentTracker)) return { label: '你(助手)', isSelf: true };
  return { label: '某位群友', isSelf: false };
}

/**
 * 渲染引用块。没有可读内容时返回空串（调用方据此决定不加引用段）。
 * @param {object} quote ctx.state.quote
 * @param {{sentTracker?: object|null}} [opts]
 * @returns {string}
 */
export function renderQuoteBlock(quote, { sentTracker = null } = {}) {
  const text = quoteText(quote);
  if (text === '') return '';
  const author = resolveQuoteAuthor(quote, { sentTracker });
  const label = '[引用 ' + author.label + (author.isSelf ? ' 说的话' : ' 的消息') + ']';
  const multiline = text.includes('\n') || Array.from(text).length > INLINE_MAX_CHARS;
  if (!multiline) return label + ' ' + text;
  return label + '\n' + text + '\n[引用结束]';
}

export default renderQuoteBlock;