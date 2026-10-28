/**
 * attachment —— QQ 富媒体附件下载（图片 / 视频 / 文件）。
 *
 * 参考官方 dist/transport/attachment.js，但做了两处本地化：
 *   1. 下载根目录由调用方传入 mediaDir（默认 ~/.dsh-qqbot/media），不再硬编码；
 *   2. 下载失败 / 超限只记日志并跳过，绝不阻断消息处理（由入站组装降级为 URL 描述）。
 *
 * 安全底线：只允许 HTTPS、阻断解析到内网/保留地址的主机（SSRF）、限制单文件大小与超时。
 * 语音附件不下载（QQ 会直接给 ASR 文本），由入站组装使用 asr_refer_text。
 */
import { mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as dns from 'node:dns';

/** 单文件默认下载上限（200MB），与官方 dist 一致。 */
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/** 单个附件下载超时（毫秒）。 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 是否图片（兼容裸值 image 与 MIME image/png）。 */
export function isImageContentType(contentType) {
  return contentType === 'image' || (typeof contentType === 'string' && contentType.startsWith('image/'));
}

/** 是否视频（兼容裸值 video 与 MIME video/mp4）。 */
export function isVideoContentType(contentType) {
  return contentType === 'video' || (typeof contentType === 'string' && contentType.startsWith('video/'));
}

/** 是否语音（兼容裸值 voice 与 MIME audio/silk）。 */
export function isVoiceContentType(contentType) {
  return contentType === 'voice' || (typeof contentType === 'string' && contentType.startsWith('audio/'));
}

/** 归类附件类型：image | video | voice | file。 */
export function classifyContentType(contentType) {
  if (isImageContentType(contentType)) return 'image';
  if (isVideoContentType(contentType)) return 'video';
  if (isVoiceContentType(contentType)) return 'voice';
  return 'file';
}

/** 字节数格式化为人类可读文本（入站消息里提示文件大小用）。 */
export function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / (1024 * 1024)).toFixed(1) + 'MB';
}

/** 处理 // 开头的协议相对 URL（补 https:）。 */
function normalizeUrl(url) {
  if (typeof url !== 'string') return '';
  return url.startsWith('//') ? 'https:' + url : url;
}

/** 文件名净化：去路径、替换文件系统非法字符（保留中文等 Unicode）。 */
function sanitizeFilename(name) {
  const raw = typeof name === 'string' && name.trim() !== '' ? name : 'attachment';
  const base = basename(raw.replace(/\\/g, '/'));
  const safe = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim().normalize('NFC');
  return safe || 'attachment';
}

/** 统一为 POSIX 分隔符，注入 prompt 的路径跨平台一致。 */
function toPosixPath(p) {
  return String(p).split(sep).join('/');
}

/** 防重名：原名 + 时间戳 + 随机数。 */
function uniqueFilename(name) {
  const base = sanitizeFilename(name);
  const ext = extname(base);
  const stem = basename(base, ext);
  const rand = randomBytes(4).toString('hex');
  return stem + '_' + Date.now() + '_' + rand + ext;
}

// ── SSRF 防护：阻断解析到私有 / 保留地址的主机 ──────────────
const PRIVATE_RANGES = [
  [0x0a000000n, 8], // 10.0.0.0/8
  [0xac100000n, 12], // 172.16.0.0/12
  [0xc0a80000n, 16], // 192.168.0.0/16
  [0x7f000000n, 8], // 127.0.0.0/8
  [0xa9fe0000n, 16], // 169.254.0.0/16
  [0xe0000000n, 4], // 224.0.0.0/4
];

function ipToBigInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function isPrivateIP(ip) {
  const val = ipToBigInt(ip);
  return PRIVATE_RANGES.some(([mask, prefix]) => (val >> (32n - BigInt(prefix))) === (mask >> (32n - BigInt(prefix))));
}

/**
 * IPv6 私网 / 保留地址判定（按文档前缀，命中即拒绝）：
 *   ::/::1（未指定/回环）、fc00::/7（ULA）、fe80::/10（link-local）、ff00::/8（组播）、
 *   fec0::/10（site-local）、::ffff:a.b.c.d 与 ::a.b.c.d（IPv4 映射/兼容，交由 IPv4 规则判定）、
 *   2002::/16（6to4）、2001:0::/32（Teredo）—— 这两类会把 IPv4 内网地址嵌进 IPv6。
 */
function isPrivateIPv6(ip) {
  const value = String(ip || '').toLowerCase().split('%')[0].trim();
  if (value === '') return true;
  if (value.includes('.')) {
    const tail = value.slice(value.lastIndexOf(':') + 1);
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(tail) ? isPrivateIP(tail) : true;
  }
  if (value.startsWith('::')) return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true;
  if (value.startsWith('ff')) return true;
  if (value.startsWith('fec') || value.startsWith('fed') || value.startsWith('fee') || value.startsWith('fef')) return true;
  if (value.startsWith('2002:')) return true;
  if (value.startsWith('2001:0:') || value.startsWith('2001:0000:')) return true;
  return false;
}

/**
 * DNS 解析并阻断内网地址；A / AAAA 都查，任一命中私网即拒绝，解析失败直接抛错（宁可不下载）。
 * 注意：DNS 校验与实际 fetch 之间仍存在 TOCTOU 窗口（本插件不引入 undici 依赖去固定 IP，
 * 保持「零新依赖」约束）；同时下载使用 redirect:'error'，避免重定向绕过校验。
 */
async function assertSafeHostname(hostname) {
  const [v4, v6] = await Promise.all([
    dns.promises.resolve4(hostname).catch(() => []),
    dns.promises.resolve6(hostname).catch(() => []),
  ]);
  if (v4.length === 0 && v6.length === 0) throw new Error('DNS 解析失败: ' + hostname);
  for (const addr of v4) {
    if (isPrivateIP(addr)) throw new Error('SSRF blocked: ' + hostname + ' -> ' + addr);
  }
  for (const addr of v6) {
    if (isPrivateIPv6(addr)) throw new Error('SSRF blocked: ' + hostname + ' -> ' + addr);
  }
}

/**
 * 安全下载：仅 HTTPS + SSRF 防护 + 流式大小上限 + 超时；返回写入字节数。
 * 先写 .part 临时文件，成功后再 rename 到目标路径（原子落盘，失败清理临时文件）。
 */
async function download(url, destPath, maxBytes) {
  const parsed = new URL(normalizeUrl(url));
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS allowed: ' + parsed.protocol);
  await assertSafeHostname(parsed.hostname);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('download timeout')), DOWNLOAD_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const tmpPath = destPath + '.part-' + process.pid + '-' + Date.now();
  let handle;
  try {
    // redirect:'error' 防止 3xx 跳转到内网绕过 SSRF 校验
    const resp = await fetch(parsed.toString(), { signal: controller.signal, redirect: 'error' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const declared = Number(resp.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error('Download exceeds ' + formatFileSize(maxBytes));
    }
    if (!resp.body) throw new Error('响应没有 body');
    handle = await openFile(tmpPath, 'w', 0o600);
    const reader = resp.body.getReader();
    let total = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      // 边读边判：超过上限立即取消流并抛错，避免把整个大文件读进内存
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* 取消失败也要抛原始超限错误 */
        }
        throw new Error('Download exceeds ' + formatFileSize(maxBytes));
      }
      await handle.write(value);
    }
    await handle.close();
    handle = undefined;
    renameSync(tmpPath, destPath);
    return total;
  } catch (err) {
    try {
      if (handle) await handle.close();
    } catch {
      /* 忽略 */
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      /* 临时文件可能不存在 */
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下载消息里的富媒体附件到本地 mediaDir。
 * @param {object} args
 * @param {Array<object>} args.attachments QQ 附件数组（content_type/filename/url/size）
 * @param {string} args.mediaDir 下载目录（绝对路径）
 * @param {number} [args.maxBytes] 单文件上限
 * @param {object} [args.logger] 日志对象
 * @returns {Promise<Array<{filename:string, contentType:string, localPath:string, size:number, url:string}>>}
 */
export async function downloadMediaAttachments({ attachments, mediaDir, maxBytes = DEFAULT_MAX_BYTES, logger } = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  const targets = list.filter((a) => a && classifyContentType(a.content_type) !== 'voice' && a.url);
  if (targets.length === 0) return [];

  const results = [];
  try {
    mkdirSync(mediaDir, { recursive: true });
  } catch (err) {
    logger?.warn?.('创建媒体目录失败，跳过附件下载: ' + (err && err.message));
    return results;
  }

  for (const att of targets) {
    const contentType = classifyContentType(att.content_type);
    if (Number(att.size) > maxBytes) {
      logger?.debug?.('附件超过大小上限，跳过下载: ' + (att.filename || att.url));
      continue;
    }
    const localPath = toPosixPath(join(mediaDir, uniqueFilename(att.filename)));
    try {
      const bytes = await download(att.url, localPath, maxBytes);
      logger?.debug?.('附件已下载: ' + (att.filename || '') + ' (' + formatFileSize(bytes) + ') -> ' + localPath);
      results.push({
        filename: att.filename || basename(localPath),
        contentType,
        localPath,
        size: bytes,
        url: att.url,
      });
    } catch (err) {
      // 单个附件失败不影响其它附件与整条消息
      logger?.warn?.('附件下载失败: ' + (att.filename || att.url) + ' — ' + (err && err.message));
    }
  }
  return results;
}

/**
 * 附件下载中间件：位于频率门控之后，所以只有「已触发」的消息才会下载媒体。
 * 结果写入 ctx.state.downloadedFiles / ctx.state.downloadedQuoteFiles 供 inbound 组装。
 * @param {object} args
 * @param {object} args.config 部署配置
 * @param {object} args.logger 日志对象
 * @param {string} args.mediaDir 媒体目录绝对路径
 */
export function createAttachmentMiddleware({ logger, mediaDir } = {}) {
  const maxBytes = DEFAULT_MAX_BYTES;
  return async function attachmentProcessor(ctx, next) {
    try {
      const msg = ctx.message || {};
      const downloaded = await downloadMediaAttachments({
        attachments: msg.attachments,
        mediaDir,
        maxBytes,
        logger,
      });
      ctx.state.downloadedFiles = downloaded;

      // 引用消息里的附件单独下载（结构转换成 RawAttachment 复用同一实现）
      const quoteAttachments = ctx.state.quote && Array.isArray(ctx.state.quote.attachments)
        ? ctx.state.quote.attachments
        : [];
      if (quoteAttachments.length > 0) {
        const rawQuote = quoteAttachments
          .filter((a) => a && a.url)
          .map((a) => ({
            content_type: a.contentType || '',
            filename: a.filename || '',
            size: 0,
            url: a.url,
          }));
        ctx.state.downloadedQuoteFiles = await downloadMediaAttachments({
          attachments: rawQuote,
          mediaDir,
          maxBytes,
          logger,
        });
      }
    } catch (err) {
      // 附件下载是增强能力，失败绝不阻断消息
      logger?.warn?.('附件下载中间件异常: ' + (err && err.message));
    }
    await next();
  };
}
