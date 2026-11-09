/**
 * core/kb/text-search —— 知识库与记忆共用的检索工具（纯函数，无 IO）。
 *
 * 职责：
 * - 统一封装 FTS5 trigram 的硬限制：索引的最小匹配长度是 3 个字符，
 *   1-2 个字符的查询必须回退 LIKE（本文件提供判定与模式串生成）；
 * - 生成安全的 FTS5 查询串（整串按短语匹配，语义 = 子串匹配）与 LIKE 模糊串；
 * - 生成检索结果片段（snippet）与 LIKE 模式相关度分数；
 * - 所有“字符”长度按 Unicode 码点计算，切片不会切断 UTF-16 代理对（emoji 等）。
 */

/** trigram 索引可命中的最小字符数（硬契约：<3 必须回退 LIKE）。 */
export const FTS_MIN_CHARS = 3;

/** 检索模式标识：FTS5/bm25 排序。 */
export const MODE_FTS = 'fts';

/** 检索模式标识：LIKE 回退（查询 <3 字符或 FTS 无法解析时）。 */
export const MODE_LIKE = 'like';

/** 按 Unicode 码点计算字符长度（emoji 记 1 个字符）。 */
export function charLength(value) {
  const text = String(value ?? '');
  let count = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _ of text) count += 1;
  return count;
}

/** 检索词归一化：去首尾空白。 */
export function normalizeQuery(query) {
  return String(query ?? '').trim();
}

/** 该查询是否必须回退 LIKE（trigram 无法命中 <3 字符）。 */
export function shouldFallbackLike(query) {
  return charLength(normalizeQuery(query)) < FTS_MIN_CHARS;
}

/**
 * 生成 FTS5 短语查询串：整体包成 "..."，内部引号按 FTS5 规则翻倍转义。
 * trigram 分词器下短语匹配等价于“原文包含该子串”，避免用户输入被当成查询语法。
 */
export function ftsPhrase(query) {
  return '"' + String(query ?? '').replace(/"/g, '""') + '"';
}

/** 转义 LIKE 模式里的通配符（配合 SQL 的 ESCAPE '\' 使用）。 */
export function escapeLike(query) {
  return String(query ?? '').replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/** 生成 LIKE 模式串：%query%。 */
export function likePattern(query) {
  return '%' + escapeLike(String(query ?? '')) + '%';
}

/** 不区分大小写地查找第一个匹配位置（UTF-16 下标）；找不到返回 -1。 */
export function findMatchIndex(text, query) {
  const source = String(text ?? '');
  const needle = String(query ?? '');
  if (!needle) return -1;
  return source.toLowerCase().indexOf(needle.toLowerCase());
}

/** 把命中片段从 text 中摘出来：匹配尽量居中，两端省略号；按码点安全截断。 */
export function buildSnippet(text, query, { maxLen = 80 } = {}) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const budget = Math.max(8, Math.floor(Number(maxLen) || 80));
  const needle = normalizeQuery(query);
  const index = needle ? findMatchIndex(raw, needle) : -1;
  if (index < 0) return safeSlice(raw, 0, budget);
  // 让匹配片段大致居中；查询本身很长时优先保证能看见开头
  const context = Math.max(0, Math.floor((budget - Math.min(needle.length, budget)) / 2));
  let start = Math.max(0, index - context);
  let end = Math.min(raw.length, start + budget);
  if (end - start < budget) start = Math.max(0, end - budget);
  start = adjustStart(raw, start);
  end = adjustEnd(raw, start, end);
  const body = raw.slice(start, end);
  return (start > 0 ? '…' : '') + body + (end < raw.length ? '…' : '');
}

/** LIKE 模式的相关度：命中位置越靠前分数越高，取值 (0, 1]。 */
export function likeScore(text, query) {
  const index = findMatchIndex(text, query);
  if (index < 0) return 0;
  return Number((1 / (1 + index / 50)).toFixed(6));
}

/** 按字符预算截断（保留省略号），按码点切分，不切断代理对。 */
export function truncateText(text, maxChars, ellipsis = '…') {
  const chars = [...String(text ?? '')];
  const budget = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (chars.length <= budget) return chars.join('');
  if (budget <= 0) return '';
  const tail = ellipsis.length <= budget ? ellipsis : '';
  return chars.slice(0, budget - [...tail].length).join('') + tail;
}

/* ------------------------------ 内部工具 ------------------------------ */

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 起点落在代理对后半段时后移一位，避免切开 emoji。 */
function adjustStart(text, start) {
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) return start + 1;
  return start;
}

/** 终点落在代理对前半段时前移一位，避免切开 emoji。 */
function adjustEnd(text, start, end) {
  if (end > start && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) return end - 1;
  return end;
}

/** 安全截取 [start, end)，边界不切断注代理对。 */
function safeSlice(text, start, end) {
  const from = adjustStart(text, Math.max(0, start));
  const to = adjustEnd(text, from, Math.min(text.length, end));
  return text.slice(from, to);
}
