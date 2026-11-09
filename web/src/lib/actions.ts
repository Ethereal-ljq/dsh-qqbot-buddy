/**
 * lib/actions —— /api/actions/:name 的错误归一与结果摘要。
 *
 * 后端动作有两类失败：
 *  - HttpError（400/501，带 code/message）：如 ingest-url 的 TIMEOUT/TOO_LARGE/SSRF_BLOCKED；
 *  - 「200 + {ok:false}」：如 start-bot 的传输层启动失败（真实原因在 bot/status 事件的 error 里）。
 * 本模块只负责把 HttpError 翻译成中文可读提示；ok:false 的原因由 AppContext 的 botErrors 提供。
 */
import type { ApiError } from '../api/client';

export interface ActionFeedback {
  message: string;
  detail?: string;
}

/** 后端 error.code → 中文提示（code 大小写不敏感）。 */
const CODE_HINTS: Record<string, string> = {
  // ingest-url
  SSRF_BLOCKED: '目标地址被安全策略拒绝：只允许公网 http/https，不能访问本机或内网地址。',
  BLOCKED_URL: '目标地址被安全策略拒绝：只允许公网 http/https，不能访问本机或内网地址。',
  ENOTFOUND: '域名解析失败，请检查地址是否正确。',
  ECONNREFUSED: '连接被拒绝：目标站点未监听该端口。',
  ETIMEDOUT: '连接超时，请检查网络或目标站点。',
  ABORT_ERR: '请求被中止或超时。',
  TIMEOUT: '抓取超时（默认 15 秒），请检查目标站点或改用文本入库。',
  TOO_LARGE: '响应体超过大小上限（默认 2 MiB），请改用文本入库。',
  BAD_URL: 'URL 格式不合法，请填写 http(s):// 开头的完整地址。',
  PROTOCOL: '只支持 http/https 协议。',
  DNS_FAILED: '域名解析失败，请检查地址是否正确。',
  FETCH_FAILED: '抓取失败：目标站点不可达或网络被拒绝。',
  HTTP_STATUS: '目标站点返回了非 2xx 状态，无法入库。',
  CONTENT_TYPE: '不支持的内容类型：目前仅支持 HTML / 纯文本 / JSON。',
  EMPTY_BODY: '目标页面没有正文内容。',
  EMPTY_CONTENT: '抽取后的正文为空，可能是纯脚本页面。',
  TOO_MANY_REDIRECTS: '重定向次数过多（上限 3 次）。',
  REDIRECT: '重定向响应缺少 Location 头。',
  BAD_RESPONSE: '目标站点返回了无法解析的响应。',
  // 动作通用
  ACTION_FAILED: '动作执行失败，后端未返回更多细节。',
  INTERNAL_ERROR: '后端内部错误：常见原因是缺少 QQ 凭据（appId/appSecret）、机器人宿主未启动或旁路 LLM 未配置，请查看插件日志。',
  NOT_IMPLEMENTED: '该动作尚未装配（后端 501）。',
  NOT_READY: '依赖服务尚未就绪（后端 501）。',
  UNAUTHORIZED: '登录会话已失效，请重新登录。',
  FORBIDDEN: '没有权限执行该操作。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。',
  INVALID_PEER: '请填写要重置的会话 peer。',
  BUSY: '同一会话正在执行任务，请稍后再试。',
  EMPTY_TRANSCRIPT: '转录为空：请粘贴一段对话，或等待自动提炼达到轮次阈值。',
};

/** 后端兜底文案：这类 message 没有信息量，用本地中文提示替代。 */
const GENERIC_MESSAGES = new Set(['', '服务器内部错误', 'internal server error', 'internal error', 'action failed']);

/**
 * ApiError → 可读提示 + 原始细节（message/code/requestId 便于排障）。
 *
 * 两类错误分开处理：
 *  - 具体 code（TIMEOUT/TOO_LARGE/SSRF_BLOCKED…）：本地中文提示做主文案，后端原文进 detail；
 *  - action_failed / internal_error：后端 message 通常就是真实原因（如“未配置 QQ 凭据”），
 *    只有在 message 无信息量时才用兜底提示。
 */
export function actionFeedback(error: ApiError): ActionFeedback {
  const rawCode = (error.code || '').trim();
  const upper = rawCode.toUpperCase();
  const hint = CODE_HINTS[upper];
  const backendMessage = (error.message || '').trim();
  const generic = GENERIC_MESSAGES.has(backendMessage.toLowerCase());
  const preferBackend = (upper === 'ACTION_FAILED' || upper === 'INTERNAL_ERROR') && !generic;

  const message = preferBackend ? backendMessage : (hint || backendMessage || '操作失败');
  const detailParts: string[] = [];
  if (backendMessage && backendMessage !== message) detailParts.push(backendMessage);
  if (error.requestId) detailParts.push('requestId ' + error.requestId);
  else if (rawCode) detailParts.push('code ' + rawCode);
  return { message, detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined };
}

/** 把任意动作结果压成一行可读摘要（reset-peer / extract 等形状不固定时使用）。 */
export function summarizeActionResult(result: unknown): string {
  if (result === null || result === undefined) return '完成';
  if (typeof result !== 'object') return String(result);
  const data = result as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['ok', 'epoch', 'facts', 'saved', 'created', 'deduped', 'docId', 'chunks', 'bytes', 'changed', 'reason', 'error']) {
    const value = data[key];
    if (value === undefined || value === null || value === '') continue;
    parts.push(key + '=' + String(value));
  }
  if (parts.length > 0) return parts.join(' · ');
  try { return JSON.stringify(result).slice(0, 300); } catch { return '完成'; }
}
