/**
 * core/text/terms —— 检索词拆分（FTS 辅助）。
 *
 * 背景：trigram FTS 是「整串 phrase」匹配，拿一整句话/带空格的多词去查基本零命中。
 * 这里把用户原话拆成可用于检索的词：
 *   1. 按空白/标点切；
 *   2. 去掉句首功能词（对/在/关于/有/是/把/被/让/给/跟/然后）；
 *   3. 长中文串再按连接词（和/与/及/或/跟/同/的）切开——
 *      "对神棍老师和戴佳伟的印象" → ["神棍老师", "戴佳伟", "印象"]。
 *
 * 纯函数、无依赖，供 host/recall 与 tools/data-tools 共用。
 */

const CONNECTOR_SPLIT = /[和与及或跟同的]/u;
const LEADING_STOP = /^(?:对|在|关于|有|是|把|被|让|给|跟|然后|那么|这个|那个|你的|我的|那|这|就|还|也|又|再|请问|问一下|说说|聊聊)+/u;
// 只去语气助词，别动"吃什么/怎么/为了"这类词尾（么/了 是词的一部分）
const TRAILING_STOP = /(?:呢|吗|啊|吧|呀|哦|嘛|来着)+$/u;
const SEPARATORS = /[^\p{L}\p{N}]+/u;
const MAX_TERMS = 12;

/** 去掉首尾功能词（"那神棍老师和戴佳伟呢" → "神棍老师"/"戴佳伟"）。 */
function stripStop(value) {
  let term = String(value || '').trim();
  if (term === '') return '';
  term = term.replace(LEADING_STOP, '').trim();
  term = term.replace(TRAILING_STOP, '').trim();
  return term;
}

function pushTerm(out, seen, value) {
  const term = String(value || '').trim();
  if (term.length < 2) return;
  const key = term.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(term);
}

/**
 * 把一句话拆成检索词。
 * @param {string} text
 * @param {{maxTerms?: number}} [options]
 * @returns {string[]}
 */
export function queryTerms(text, { maxTerms = MAX_TERMS } = {}) {
  const norm = typeof text === 'string' ? text.normalize('NFKC').trim() : '';
  if (norm === '') return [];
  const out = [];
  const seen = new Set();
  for (const raw of norm.split(SEPARATORS)) {
    if (raw === '') continue;
    const stripped = stripStop(raw);
    if (stripped !== '') pushTerm(out, seen, stripped);
    if (stripped.length > 3) {
      for (const part of stripped.split(CONNECTOR_SPLIT)) pushTerm(out, seen, stripStop(part));
    }
    if (out.length >= maxTerms) break;
  }
  return out.slice(0, maxTerms);
}

export default { queryTerms };
