/**
 * card-render —— ARK 卡片（分享卡片 / 小程序卡片）的渲染与进程内回查表。
 *
 * 背景（见 .work/CARD-MESSAGE-ANALYSIS.md）：
 *   1. SDK 的 historyBuffer 只把 message.content 存进群历史，卡片消息的 content 是空串，
 *      所以卡片进了群历史就被 `if (!body) continue;` 整条丢掉。这里用一张进程内 LRU
 *      按 messageId 记住渲染好的卡片行，组装历史时回填。
 *   2. QQ 小程序卡片（ark_name=小程序 / ark_type=37，B站分享）的 fields 里没有 jump_url，
 *      preview 是 qq.ugcimg.cn 的加密跳转图，不是真链接。把 preview 当摘要/当链接输出
 *      会挤掉真摘要（ark.prompt）并误导模型。
 *
 * 输出格式保持一行式（现有测试依赖）：
 *   [卡片] 标题｜来源｜摘要｜链接
 * 附加信息：
 *   - 始终带类型标记：[卡片:小程序]（无 ark_name 时用 ark_type，如 [卡片:type=37]）
 *   - 有 jump_url 才输出链接；没有则行尾追加（小程序卡片，无可点击链接）
 *   - preview / source_logo / 任何 QQ 图片域名的 URL 都不会进入卡片行
 */

/** 没有 jump_url 时追加在行尾的标记：防止模型把封面图当链接，也防止它自己编一个。 */
const NO_LINK_MARK = '（小程序卡片，无可点击链接）';

/** preview / source_logo 这类封面图可能出现的 QQ 图片域名：一律不当作链接输出。 */
const QQ_IMAGE_HOSTS = ['qq.ugcimg.cn', 'open.gtimg.cn', 'miniapp.gtimg.cn', 'qqbot.ugcimg.cn'];

/** 回查表容量上限：历史窗口本来只有 20 条左右，200 条足够覆盖多个群同时刷屏。 */
const CARD_CACHE_LIMIT = 200;

/** 卡片回查表的 TTL：历史窗口本来就是内存里的短窗口，10 分钟足够。 */
const CARD_CACHE_TTL_MS = 10 * 60 * 1000;

/** messageId -> { text, at }，Map 的插入顺序即 LRU 顺序（最旧在前）。 */
const cardCache = new Map();

/** 取字段文本（数字转字符串）；空值返回空串，避免拼出「｜｜」。 */
function cardField(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * 是否是 QQ 图片域名（qq.ugcimg.cn / open.gtimg.cn / miniapp.gtimg.cn / qqbot.ugcimg.cn）。
 * 用 URL 解析拿 hostname，避免「含子串但不是该域名」的误判。
 * @param {string} value
 * @returns {boolean}
 */
export function isQqImageUrl(value) {
  const text = cardField(value);
  if (!text) return false;
  let host = '';
  try {
    host = new URL(text).hostname.toLowerCase();
  } catch {
    // 不是合法 URL（如纯域名文本）：退化为整串匹配
    host = text.toLowerCase();
  }
  return QQ_IMAGE_HOSTS.some((domain) => host === domain || host.endsWith('.' + domain));
}

/**
 * 剥掉 ark.prompt 里的 `[QQ小程序]`、`[分享]` 之类前缀，得到真正的摘要文本。
 * prompt 是 QQ 客户端自动拼的「[模板名]标题」，方括号里的模板名对模型没有信息量。
 * @param {string} value
 * @returns {string}
 */
export function stripCardPromptPrefix(value) {
  const text = cardField(value);
  if (!text) return '';
  return text.replace(/^\s*[[［【][^\]］】]*[\]］】]\s*/, '').trim();
}

/**
 * 从消息里取 ark_data：优先 raw.ark_data（SDK 把整个事件体放在 raw 里），其次 msg.ark_data。
 * @param {object} msg
 * @returns {object|null}
 */
export function pickArkData(msg) {
  const raw = msg && typeof msg.raw === 'object' && msg.raw ? msg.raw : {};
  const fromRaw = raw.ark_data && typeof raw.ark_data === 'object' ? raw.ark_data : null;
  if (fromRaw) return fromRaw;
  return msg && msg.ark_data && typeof msg.ark_data === 'object' ? msg.ark_data : null;
}

/**
 * 卡片类型标记：ark_name > ark_type（数字或字符串）。
 * @param {object} ark
 * @returns {string} 无可用模板名时返回空串
 */
export function cardTemplate(ark) {
  const source = ark && typeof ark === 'object' ? ark : {};
  const name = cardField(source.ark_name);
  if (name) return name;
  const typeText = cardField(source.ark_type);
  return typeText ? 'type=' + typeText : '';
}

/** 从候选里取第一个非空文本。 */
function firstText(...candidates) {
  for (const candidate of candidates) {
    const text = cardField(candidate);
    if (text) return text;
  }
  return '';
}

/**
 * 摘要与标题重复时返回空串。
 * QQ 小程序卡片的 ark.prompt 形如「[QQ小程序]标题」，剥掉方括号前缀就和标题一模一样，
 * 直接拼会得到「标题｜来源｜标题」这种重复行。
 * @param {string} title
 * @param {string} desc
 * @returns {string}
 */
function dedupeDesc(title, desc) {
  if (!desc) return '';
  return desc === title ? '' : desc;
}

/**
 * 把一份 ark_data 渲染成卡片行（只有一行，内容为空时返回 []）。
 *
 * 字段优先级：
 *   标题 fields.title
 *   来源 fields.source > fields.tag
 *   摘要 fields.desc > strip(ark.prompt)   ← 不再回落到 fields.preview（那是封面图）
 *   链接 fields.jump_url                   ← 没有就不输出；QQ 图片域名一律丢弃
 *
 * @param {object} ark ark_data 对象（可从 raw.ark_data 取，见 pickArkData）
 * @param {object} [opts]
 * @param {boolean} [opts.isCard] 消息本体是否被判定为卡片（msgType===3）；此时即使 ark 全空也出 [卡片]
 * @returns {string[]} 0 或 1 行的数组（与 buildCardLines 的历史契约一致）
 */
export function renderCard(ark, opts = {}) {
  const hasArk = ark && typeof ark === 'object';
  if (!hasArk && opts.isCard !== true) return [];
  const source = {
    ark_name: cardField(hasArk ? ark.ark_name : ''),
    ark_type: hasArk ? ark.ark_type : '',
    prompt: cardField(hasArk ? ark.prompt : ''),
    fields: hasArk && ark.fields && typeof ark.fields === 'object' ? ark.fields : {},
  };
  const fields = source.fields;

  const title = cardField(fields.title);
  const from = firstText(fields.source, fields.tag);
  // 摘要与标题相同时直接丢掉：B站小程序的 ark.prompt 就是「[QQ小程序]标题」，
  // 剥掉前缀后与 fields.title 逐字相同，不去重会输出「标题｜哔哩哔哩｜标题」。
  const desc = dedupeDesc(title, firstText(fields.desc, stripCardPromptPrefix(source.prompt)));
  // 只认 jump_url，且必须是真链接（不是 QQ 图片域名）
  const rawLink = cardField(fields.jump_url);
  const link = rawLink && !isQqImageUrl(rawLink) ? rawLink : '';

  // 有类型标记就带在 [卡片:xxx] 里，便于模型判断这是小程序 / H5 / 图文
  const template = cardTemplate(source);
  const head = '[卡片' + (template ? ':' + template : '') + ']';

  // 内容字段全空：只出类型标记兜底，别丢掉「这是张卡片」这个事实
  if (!title && !from && !desc && !link) return [head];

  const parts = [title, from, desc, link].filter((part) => part !== '');
  const line = head + ' ' + parts.join('｜') + (link ? '' : NO_LINK_MARK);
  return [line];
}

/**
 * 记住一条卡片消息的渲染结果，供群历史回查（SDK historyBuffer 不保存 ark_data）。
 * @param {string} messageId 消息 id（空值直接忽略：历史条目没有 id 时也无从匹配）
 * @param {string|string[]} text 卡片行（接受 renderCard 的返回值或单行字符串）
 */
export function rememberCard(messageId, text) {
  const id = cardField(messageId);
  if (!id) return;
  const lines = Array.isArray(text) ? text : [text];
  const body = lines.map((line) => cardField(line)).filter((line) => line !== '').join('\n');
  if (!body) return;
  cardCache.delete(id);
  cardCache.set(id, { text: body, at: Date.now() });
  // LRU 淘汰：超上限时从最旧的一条开始删
  while (cardCache.size > CARD_CACHE_LIMIT) {
    const oldest = cardCache.keys().next();
    if (oldest.done) break;
    cardCache.delete(oldest.value);
  }
}

/**
 * 按 messageId 回查卡片正文；未命中或已过期返回空串。
 * 过期条目顺手删掉，避免 TTL 失效的条目占着 LRU 位置。
 * @param {string} messageId
 * @returns {string}
 */
export function lookupCard(messageId) {
  const id = cardField(messageId);
  if (!id) return '';
  const hit = cardCache.get(id);
  if (!hit) return '';
  if (Date.now() - hit.at > CARD_CACHE_TTL_MS) {
    cardCache.delete(id);
    return '';
  }
  return hit.text;
}

/**
 * 把一条消息渲染成卡片行（入站主流程与历史回填共用同一套规则）。
 * 非卡片消息返回 []。
 * @param {object} msg QQ 入站消息
 * @returns {string[]}
 */
export function renderMessageCard(msg) {
  const ark = pickArkData(msg);
  const isCard = msg && Number(msg.msgType) === 3;
  if (!isCard && !ark) return [];
  return renderCard(ark, { isCard });
}

/** 清空回查表（仅测试/重载用）。 */
export function clearCardCache() {
  cardCache.clear();
}

/** 当前回查表粒度（测试用）。 */
export function cardCacheSize() {
  return cardCache.size;
}

/** 回查表上限与 TTL（测试用，避免魔法数字）。 */
export const CARD_CACHE_LIMITS = Object.freeze({ max: CARD_CACHE_LIMIT, ttlMs: CARD_CACHE_TTL_MS });

/** 无链接标记导出，便于测试断言（避免测试里硬编码中文串）。 */
export const CARD_NO_LINK_MARK = NO_LINK_MARK;
