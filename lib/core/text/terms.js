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

// 疑问/口语后缀：自然问句（"记忆暗号是什么"）直接整句 phrase 查 FTS 会零命中，
// 需要剥掉疑问词得到核心短语（"记忆暗号"）再查。
const QUESTION_SUFFIX = /(?:是什么|是多少|多少|是谁|谁|是哪个|哪个|哪里|哪儿|怎么样|怎么|为什么|为何|是否|能不能|可不可以|记不记得|还记得|记得|知道|告诉我|说一下|一下|请告诉我|请问|吗|呢|呀|啊|吧|哦|嘛|来着|了)$/u;

/**
 * 生成检索候选短语（由宽到窄），供召回层逐个尝试。
 * 例："记忆暗号是什么？" → ["记忆暗号是什么", "记忆暗号"]
 *     "你还记得我的暗号吗" → [..., "暗号", ...]
 * @param {string} text
 * @param {{max?: number}} [options]
 * @returns {string[]}
 */
export function queryCandidates(text, { max = 12 } = {}) {
  const norm = typeof text === 'string' ? text.normalize('NFKC').trim().replace(/[？?！!。，,、：:；;\s]+$/u, '') : '';
  if (norm === '') return [];
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const term = String(value || '').trim();
    if (term.length < 2) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };
  // 一段文本 + 反复剥疑问/口语后缀（"记忆暗号是什么" → "记忆暗号"）
  const addVariants = (value) => {
    let current = String(value || '').trim();
    if (current === '') return;
    push(current);
    for (let i = 0; i < 5; i += 1) {
      const next = current.replace(QUESTION_SUFFIX, '').trim();
      if (next === current) break;
      push(next);
      current = next;
    }
  };
  addVariants(norm);
  // 多句/多问句：按标点切开，每段各自剥疑问词（一句里问两件事时也能得到两个核心短语）
  for (const segment of norm.split(/[？?！!。，,、：:；;\s]+/u)) addVariants(segment);
  // 拆词（含连接词/的 等）
  for (const term of queryTerms(norm)) addVariants(term);
  return out.slice(0, max);
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

export default { queryTerms, queryCandidates };
