/**
 * emoji —— QQ 自带表情名的兜底映射。
 *
 * 官方 QQ 群/单聊 Bot API 只有 msg_type=0/2/7（文本/Markdown/富媒体），
 * 不能像频道那样发送 <emoji:id> 原生表情元素；但 Unicode emoji 在 QQ 里
 * 会按系统表情显示。这里把模型可能写出的 [微笑]/【表情: 微笑】 之类的
 * 占位文本转成 Unicode emoji，避免把「表情: 微笑」当成普通文字发出去。
 */

/** 常见 QQ 表情名 -> Unicode emoji（不追求 1:1 的小黄脸画风，先保证表情能显示）。 */
export const QQ_FACE_EMOJI = {
  微笑: '🙂',
  呲牙: '😁',
  憨笑: '😄',
  闭嘴: '🤐',
  笑哭: '😂',
  捂脸: '🤦',
  得意: '😎',
  大哭: '😭',
  发怒: '😡',
  疑问: '❓',
  惊讶: '😲',
  晕: '😵',
  无语: '😑',
  委屈: '🥺',
  害羞: '😊',
  困: '😴',
  吃瓜: '🍉',
  加油: '💪',
  赞: '👍',
  鼓掌: '👏',
  比心: '🫰',
  OK: '👌',
  再见: '👋',
  狗头: '🐶',
  调皮: '😜',
  色: '😍',
  流泪: '😢',
  心碎: '💔',
  玫瑰: '🌹',
  抱抱: '🫂',
};

/** 已知表情名的正则（长的优先，避免「微笑」被「微」之类部分匹配）。 */
const FACE_NAMES = Object.keys(QQ_FACE_EMOJI).sort((a, b) => b.length - a.length).join('|');
const TOKEN_RE = new RegExp('(?:\\[face:\\s*(' + FACE_NAMES + ')\\]|【表情[:：]\\s*(' + FACE_NAMES + ')】|\\[(' + FACE_NAMES + ')\\])', 'g');

/**
 * 把文本里已知的 QQ 表情占位转成 Unicode emoji。
 * @param {string} text 文本
 * @returns {string} 替换后的文本
 */
export function convertEmojiTokens(text) {
  if (typeof text !== 'string' || text === '') return text;
  return text.replace(TOKEN_RE, (_match, a, b, c) => QQ_FACE_EMOJI[a || b || c] || _match);
}
