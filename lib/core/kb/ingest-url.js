/**
 * core/kb/ingest-url —— 从 URL 抓取文本并写入知识库（lib/core/kb/store.js 的 ingest）。
 *
 * 职责：
 * - 只允许 http/https；抓取前做 SSRF 防护：拒绝环回/私网/链路本地/IPv6 本地地址
 *   （含 localhost、IPv4 映射 IPv6、6to4/NAT64 内嵌私网）；重定向逐跳重新校验；
 * - 资源约束：默认 2MiB 上限（流式读取，超限立即中止）、15s 超时、最多 3 次重定向；
 * - content-type 白名单：text/plain、text/markdown、text/html、application/json；
 * - HTML 用正则转文本（去 script/style/注释/标签、实体解码、压缩空白）。正则实现的局限：
 *   不处理 CDATA、不保证复杂嵌套/畸形 HTML 的语义，只求抽取正文；足够知识库入库用；
 * - 落库走 kb.ingest（source 缺省为 URL，天然幂等：同 URL 重复抓取 hash 不变则 changed:false）。
 *
 * 安全说明（重要局限）：DNS 校验与 fetch 实际连接之间存在 TOCTOU 窗口，理论上可被
 * DNS rebinding 绕过；生产部署应叠加出口网络策略（禁止访问内网），本模块负责应用层第一道闸。
 */
import dns from 'node:dns/promises';
import net from 'node:net';

/** 默认单次抓取正文上限：2 MiB。 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** 默认抓取总超时：15s。 */
export const DEFAULT_TIMEOUT_MS = 15 * 1000;
/** 默认最多跟随重定向次数。 */
export const MAX_REDIRECTS = 3;
/** content-type 白名单（忽略 charset 等参数）。 */
export const ALLOWED_CONTENT_TYPES = ['text/plain', 'text/markdown', 'text/html', 'application/json'];
export const FETCH_USER_AGENT = 'dsh-qqbot-buddy/2 (+kb-ingest)';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 带错误码的抓取/入库错误，便于控制台区分提示。 */
export class IngestUrlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IngestUrlError';
    this.code = code;
  }
}

/**
 * 抓取 URL 并入库。
 * @param {object} args
 * @param {object} args.kb createKbStore() 返回的 store（必须）
 * @param {string} args.url 目标 URL（http/https）
 * @param {string} args.botId 入库的 bot
 * @param {string} [args.title] 文档标题（缺省取 HTML <title> 或 URL 末段）
 * @param {Function} [args.fetchImpl] fetch 实现（默认 globalThis.fetch，测试可注入）
 * @param {Function} [args.lookupImpl] DNS lookup 实现（默认 node:dns，测试可注入）
 * @param {string} [args.source] 幂等键（缺省用去掉 hash 的 URL）
 * @param {number} [args.maxBytes] 正文上限（默认 2MiB）
 * @param {number} [args.timeoutMs] 超时（默认 15s）
 * @param {number} [args.maxRedirects] 最大重定向次数（默认 3）
 * @returns {Promise<{docId: number, chunks: number, changed: boolean, bytes: number}>}
 */
export async function ingestUrl({
  kb,
  url,
  botId,
  title,
  fetchImpl,
  lookupImpl,
  source,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = MAX_REDIRECTS,
} = {}) {
  if (!kb || typeof kb.ingest !== 'function') {
    throw new TypeError('ingestUrl: 需要 createKbStore() 返回的 kb');
  }
  const owner = String(botId ?? '').trim();
  if (owner === '') throw new TypeError('ingestUrl: botId 不能为空');
  const target = String(url ?? '').trim();
  if (target === '') throw new TypeError('ingestUrl: url 不能为空');

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') throw new TypeError('ingestUrl: 当前运行环境没有 fetch，请注入 fetchImpl');
  const doLookup = typeof lookupImpl === 'function' ? lookupImpl : defaultLookup;
  const byteLimit = Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_MAX_BYTES));
  const timeLimit = Math.max(1, Math.floor(Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const redirectLimit = Math.max(0, Math.floor(Number(maxRedirects)) || 0);

  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    // 不能 unref：这是整个抓取过程的兜底计时器，事件循环空闲时也必须能触发；
    // 成功/失败路径都会在 finally 里 clearTimeout。
    timer = setTimeout(() => {
      try { controller.abort(new Error('ingest-url timeout')); } catch { /* ignore */ }
      reject(new IngestUrlError('TIMEOUT', '抓取超时（' + timeLimit + 'ms）: ' + target));
    }, timeLimit);
  });

  try {
    return await Promise.race([
      runIngest({ kb, doFetch, doLookup, target, owner, title, source, byteLimit, redirectLimit, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ 抓取流程 ------------------------------ */

async function runIngest({ kb, doFetch, doLookup, target, owner, title, source, byteLimit, redirectLimit, signal }) {
  const initial = normalizeUrl(target);
  let current = initial.href;
  let response = null;
  let hops = 0;

  for (;;) {
    await assertSafeTarget(current, doLookup);
    response = await callFetch(doFetch, current, signal);
    const status = Number(response && response.status);
    if (REDIRECT_STATUSES.has(status)) {
      if (hops >= redirectLimit) {
        throw new IngestUrlError('TOO_MANY_REDIRECTS', '重定向次数超过上限（' + redirectLimit + '）: ' + target);
      }
      const location = headerOf(response, 'location');
      if (!location) throw new IngestUrlError('REDIRECT', '重定向缺少 location: ' + current);
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new IngestUrlError('REDIRECT', '重定向目标非法: ' + location);
      }
      next.hash = '';
      current = next.href;
      hops += 1;
      continue;
    }
    break;
  }

  const status = Number(response.status);
  if (!(status >= 200 && status < 300)) {
    throw new IngestUrlError('HTTP_STATUS', '目标返回 HTTP ' + status + ': ' + current);
  }
  const rawContentType = headerOf(response, 'content-type');
  const contentType = normalizeContentType(rawContentType);
  if (contentType === '' || !ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw new IngestUrlError('CONTENT_TYPE', '不支持的 content-type: ' + (rawContentType || '(空)'));
  }

  const buffer = await readBodyLimited(response, byteLimit);
  if (buffer.length === 0) throw new IngestUrlError('EMPTY_BODY', '响应正文为空: ' + current);

  const rawText = decodeBuffer(buffer, rawContentType);
  const extracted = extractContent(contentType, rawText);
  const text = extracted.text.trim();
  if (text === '') throw new IngestUrlError('EMPTY_CONTENT', '未能从响应中提取出正文: ' + current);

  const docTitle = firstNonEmpty(
    title,
    extracted.title,
    defaultTitleFromUrl(current),
    current,
  );
  const docSource = firstNonEmpty(source, initial.href);
  const ingestResult = await kb.ingest({
    botId: owner,
    source: docSource,
    title: docTitle,
    text,
    meta: {
      url: initial.href,
      finalUrl: current,
      contentType,
      bytes: buffer.length,
      fetchedAt: Date.now(),
    },
  });
  return {
    docId: Number(ingestResult.docId ?? ingestResult.doc?.id),
    chunks: Number(ingestResult.chunks) || 0,
    changed: ingestResult.changed !== false,
    bytes: buffer.length,
  };
}

/** 校验 URL 并做 SSRF 防护（DNS 解析后逐个地址检查）。 */
async function assertSafeTarget(href, doLookup) {
  const parsed = normalizeUrl(href);
  const host = stripBrackets(parsed.hostname).toLowerCase();
  if (host === '' || host.includes('%')) throw new IngestUrlError('BAD_URL', 'URL 主机名非法: ' + href);
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new IngestUrlError('SSRF_BLOCKED', '禁止访问本机地址: ' + host);
  }

  const literal = net.isIP(host);
  let addresses;
  if (literal !== 0) {
    addresses = [host];
  } else {
    let records;
    try {
      records = await doLookup(host, { all: true, verbatim: true });
    } catch (err) {
      throw new IngestUrlError('DNS_FAILED', 'DNS 解析失败: ' + host + '（' + errorText(err) + '）');
    }
    const list = Array.isArray(records) ? records : [records];
    addresses = list.map((item) => (typeof item === 'string' ? item : item && item.address)).filter(Boolean);
    if (addresses.length === 0) throw new IngestUrlError('DNS_FAILED', 'DNS 未返回地址: ' + host);
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new IngestUrlError('SSRF_BLOCKED', '禁止访问私网/环回/链路本地地址: ' + host + ' -> ' + address);
    }
  }
  return parsed;
}

function normalizeUrl(href) {
  let parsed;
  try {
    parsed = new URL(String(href));
  } catch {
    throw new IngestUrlError('BAD_URL', 'URL 非法: ' + String(href));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new IngestUrlError('PROTOCOL', '只允许 http/https，收到: ' + parsed.protocol);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new IngestUrlError('BAD_URL', 'URL 不允许携带账号密码');
  }
  return parsed;
}

async function callFetch(doFetch, href, signal) {
  try {
    return await doFetch(href, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        accept: 'text/plain, text/markdown, text/html, application/json;q=0.9, */*;q=0.1',
        'user-agent': FETCH_USER_AGENT,
      },
    });
  } catch (err) {
    if (err instanceof IngestUrlError) throw err;
    if (signal && signal.aborted) throw new IngestUrlError('TIMEOUT', '抓取超时或被中止: ' + href);
    throw new IngestUrlError('FETCH_FAILED', '抓取失败: ' + href + '（' + errorText(err) + '）');
  }
}

/** 流式读取响应体，超过 maxBytes 立即中止（不把超大响应读进内存）。 */
async function readBodyLimited(response, maxBytes) {
  const declared = Number(headerOf(response, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new IngestUrlError('TOO_LARGE', '响应超过大小上限 ' + maxBytes + ' 字节（content-length=' + declared + '）');
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new IngestUrlError('TOO_LARGE', '响应超过大小上限 ' + maxBytes + ' 字节');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new IngestUrlError('TOO_LARGE', '响应超过大小上限 ' + maxBytes + ' 字节');
    return buffer;
  }
  throw new IngestUrlError('BAD_RESPONSE', '无法读取响应体（既没有 body 流也没有 arrayBuffer）');
}

function headerOf(response, name) {
  try {
    if (response && response.headers && typeof response.headers.get === 'function') {
      return response.headers.get(name);
    }
  } catch { /* ignore */ }
  return null;
}

function normalizeContentType(header) {
  return String(header ?? '').split(';')[0].trim().toLowerCase();
}

function decodeBuffer(buffer, contentTypeHeader) {
  const matched = /charset\s*=\s*"?([\w-]+)"?/i.exec(String(contentTypeHeader ?? ''));
  const charset = matched ? matched[1].toLowerCase() : 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

/** 按 content-type 抽取正文与标题。 */
function extractContent(contentType, rawText) {
  if (contentType === 'text/html') {
    return { text: htmlToText(rawText), title: extractHtmlTitle(rawText) };
  }
  if (contentType === 'application/json') {
    return { text: prettifyJson(rawText), title: '' };
  }
  return { text: String(rawText ?? ''), title: '' };
}

function prettifyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return String(text ?? ''); }
}

function defaultTitleFromUrl(href) {
  try {
    const parsed = new URL(href);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments.length > 0 ? segments[segments.length - 1] : '';
    const decoded = last ? decodeURIComponent(last) : '';
    return decoded || parsed.hostname;
  } catch {
    return '';
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text !== '') return text;
  }
  return '';
}

/* ------------------------------ HTML 转文本（正则实现） ------------------------------ */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', bull: '•',
  times: '×', divide: '÷', laquo: '«', raquo: '»', ensp: ' ', emsp: ' ', thinsp: ' ',
};

/** HTML 实体解码：命名实体常见子集 + 十进制/十六进制数字实体。 */
export function decodeHtmlEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (whole, entity) => {
    const raw = entity.toLowerCase();
    if (raw.startsWith('#x')) {
      const code = parseInt(raw.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, whole) : whole;
    }
    if (raw.startsWith('#')) {
      const code = parseInt(raw.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, whole) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, raw) ? NAMED_ENTITIES[raw] : whole;
  });
}

function safeFromCodePoint(code, fallback) {
  if (code <= 0 || code > 0x10ffff) return fallback;
  try { return String.fromCodePoint(code); } catch { return fallback; }
}

/**
 * HTML -> 纯文本：去 DOCTYPE/注释/script/style/noscript/template/svg/iframe，
 * 块级标签换行、其余标签替换为空格，实体解码后压缩空白。
 */
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<!DOCTYPE[^>]*>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // 未闭合/自闭合的噪声标签
  text = text.replace(/<(script|style|noscript|template|svg|iframe|object|embed)\b[^>]*\/?>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol|dl|dt|dd|form|figure)\s*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t\f\v\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** 提取 <title> 文本（去标签 + 实体解码 + 压缩空白，截断 200 字符）。 */
export function extractHtmlTitle(html) {
  const matched = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''));
  if (!matched) return '';
  const raw = decodeHtmlEntities(matched[1].replace(/<[^>]*>/g, ' '));
  const text = raw.replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, 200).join('');
}

/* ------------------------------ SSRF：地址分类 ------------------------------ */

/**
 * 判断地址是否属于禁止访问的范围（环回/私网/链路本地/多播/保留段）。
 * IPv4/IPv6 都支持；非法地址按危险处理（返回 true）。
 */
export function isPrivateAddress(address) {
  const value = String(address ?? '').trim().toLowerCase();
  if (value === '') return true;
  const family = net.isIP(value);
  if (family === 4) return isPrivateIPv4(value);
  if (family === 6) return isPrivateIPv6(value);
  return true;
}

function isPrivateIPv4(address) {
  const parts = String(address).split('.').map((part) => Number(part));
  if (parts.length !== 4) return true;
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;              // 0/8、10/8、127/8
  if (a === 169 && b === 254) return true;                          // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true;                // 172.16/12
  if (a === 192 && b === 168) return true;                          // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;                // 100.64/10 CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;    // 192.0.0/24、192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true;             // 198.18/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true;              // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true;               // 203.0.113/24
  if (a >= 224) return true;                                        // 多播 224/4 + 保留 240/4 + 广播
  return false;
}

function isPrivateIPv6(address) {
  const bytes = ipv6ToBytes(address);
  if (!bytes) return true;
  const zeroPrefix = (length) => bytes.slice(0, length).every((byte) => byte === 0);
  if (bytes.every((byte) => byte === 0)) return true;                              // ::
  if (zeroPrefix(15) && bytes[15] === 1) return true;                              // ::1
  if (bytes[0] === 0xfc || bytes[0] === 0xfd) return true;                          // fc00::/7 ULA
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;                // fe80::/10 链路本地
  if (bytes[0] === 0xff) return true;                                               // ff00::/8 多播
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32
  if (zeroPrefix(10) && bytes[10] === 0xff && bytes[11] === 0xff) {                 // ::ffff:0:0/96 IPv4 映射
    return isPrivateIPv4(bytes.slice(12).join('.'));
  }
  if (zeroPrefix(12)) return isPrivateIPv4(bytes.slice(12).join('.'));              // ::/96 IPv4 兼容（已废弃）
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {                                     // 2002::/16 6to4 内嵌 IPv4
    return isPrivateIPv4(bytes.slice(2, 6).join('.'));
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) { // 64:ff9b::/96 NAT64
    return isPrivateIPv4(bytes.slice(12).join('.'));
  }
  return false;
}

/** IPv6 字符串 -> 16 字节数组；非法返回 null。支持 :: 压缩与内嵌点分 IPv4。 */
function ipv6ToBytes(address) {
  let value = String(address).trim().toLowerCase();
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dotted) {
    const ipv4 = parseIPv4Bytes(dotted[2]);
    if (!ipv4) return null;
    const hex = ipv4.map((byte) => byte.toString(16).padStart(2, '0')).join('');
    value = dotted[1] + hex.slice(0, 4) + ':' + hex.slice(4);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const valueOfGroup = parseInt(group, 16);
    bytes.push((valueOfGroup >> 8) & 0xff, valueOfGroup & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

function parseIPv4Bytes(address) {
  const parts = String(address).split('.').map((part) => Number(part));
  if (parts.length !== 4) return null;
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

/* ------------------------------ 内部小工具 ------------------------------ */

function stripBrackets(hostname) {
  const value = String(hostname ?? '');
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

async function defaultLookup(host, options) {
  return dns.lookup(host, options);
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

export default ingestUrl;
