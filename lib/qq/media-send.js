/**
 * media-send —— 媒体消息（图片/视频/语音/文件）的安全发送与失败定性。
 *
 * 从 v1 lib/qq/gateway.js 搬出（协议资产，纯逻辑，不改语义）：
 * 背景：SDK 的 sendMedia = uploadMedia + sendMediaMessage。上传成功、消息也发出后，
 * 如果响应超时/解析失败，调用方只知道「失败」却不知道消息是否已经送达。
 * 无脑去掉 msgId 主动重发会让同一条媒体出现两遍。
 *
 * 处置分流：
 *   - 确定没送达（被动窗口/频控被拒、连接都没建立、上传阶段 4xx）→ 主动重发一次；
 *   - 确定失败（参数/权限/内容/去重、本地文件读取失败）→ 原样抛出，重试无意义；
 *   - 可能已送达（超时、连接中断、5xx、HTML/JSON 异常）→ 不重发，抛 UNKNOWN_DELIVERY。
 *
 * 工具层（qqbot_send_file）据此提示模型「别重试」。
 */
import { SEND_ERROR, classifySendError } from './error-codes.js';

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

/** 媒体发送失败的处置动作。 */
export const MEDIA_SEND_ACTION = {
  RETRY_PROACTIVE: 'retry-proactive',
  FAIL: 'fail',
  UNKNOWN: 'unknown',
};

/** 明确「连接都没建立」的失败：请求一定没发出去，重发不会造成重复。 */
const DEFINITE_CONNECT_PATTERN = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/;

/** 超时/连接中断类：请求可能已到达服务端（尤其 sendMediaMessage 已落地），绝不重发。 */
const AMBIGUOUS_NETWORK_PATTERN = /ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_CONNECT_TIMEOUT|ABORT_ERR|TIMEOUT|timeout|AbortError|aborted|fetch failed/i;

/** 确认是本地前置失败（请求根本没发出去）才算 FAIL。 */
const LOCAL_FAILURE_PATTERN = /\bENOENT\b|\bEACCES\b|\bEPERM\b|\bEISDIR\b|\bENOTDIR\b|\bENAMETOOLONG\b|no such file|not a directory|one of url\/fileData\/buffer\/localPath is required|mutually exclusive|fileData too large|无法解析文件|文件不存在/;

/** 失败发生在「上传」还是「发消息」阶段（SDK ApiError.path 可区分）。 */
export function mediaSendStage(err) {
  const apiPath = err && typeof err.path === 'string' ? err.path : '';
  if (/\/messages(?:\/|$)/.test(apiPath)) return 'message';
  if (/\/files(?:\/|$)|\/upload/.test(apiPath)) return 'upload';
  return 'unknown';
}

/**
 * 给一次媒体发送失败定性（纯函数，便于单测）。
 * @param {unknown} err
 * @returns {{action:string, deliveryUnknown:boolean, reason:string, category:string,
 *   code?:number, networkCode?:string, httpStatus?:number, stage:string, message:string}}
 */
export function classifyMediaSendFailure(err) {
  const cls = classifySendError(err);
  const stage = mediaSendStage(err);
  const httpStatus = Number.isFinite(cls.httpStatus) ? cls.httpStatus : undefined;
  const base = {
    category: cls.category,
    code: cls.code,
    networkCode: cls.networkCode,
    httpStatus,
    stage,
    message: cls.message,
  };
  const decide = (action, reason, deliveryUnknown = false) => ({
    ...base, action, reason, deliveryUnknown,
  });

  // 上传阶段失败：消息肯定还没发出（上传成功才会调 sendMediaMessage）
  if (stage === 'upload') {
    if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
      return decide(MEDIA_SEND_ACTION.FAIL, 'upload-rejected');
    }
    return decide(MEDIA_SEND_ACTION.RETRY_PROACTIVE, 'upload-not-sent');
  }

  // 被动回复凭证失效/超限、平台频控：请求被明确拒绝，未送达
  if (cls.category === SEND_ERROR.WINDOW || cls.category === SEND_ERROR.RATE_LIMIT) {
    return decide(MEDIA_SEND_ACTION.RETRY_PROACTIVE, 'passive-rejected');
  }
  if (httpStatus === 429) {
    return decide(MEDIA_SEND_ACTION.RETRY_PROACTIVE, 'rate-limited');
  }
  const haystack = [cls.networkCode, cls.message].filter((v) => typeof v === 'string' && v !== '').join(' ');
  const ambiguousNetwork = AMBIGUOUS_NETWORK_PATTERN.test(haystack);
  const definiteConnect = (typeof cls.networkCode === 'string' && cls.networkCode !== ''
    && DEFINITE_CONNECT_PATTERN.test(cls.networkCode))
    || (DEFINITE_CONNECT_PATTERN.test(cls.message) && !ambiguousNetwork);
  if (definiteConnect) {
    return decide(MEDIA_SEND_ACTION.RETRY_PROACTIVE, 'connect-failed');
  }
  // 网络类（超时/连接被重置/UND_ERR_* 等）：请求可能已到达服务端，绝不重发。
  // 必须在 pre-request 判断之前，否则没有 path 的 fetch 超时会掉进「确定失败」。
  if (cls.category === SEND_ERROR.NETWORK) {
    return decide(MEDIA_SEND_ACTION.UNKNOWN, 'ambiguous-network', true);
  }
  // 参数/权限/内容/去重类：再发一次也不会成功（去重说明之前那条可能已送达）
  if (cls.category === SEND_ERROR.PERMANENT
    || cls.category === SEND_ERROR.FORMAT
    || cls.category === SEND_ERROR.DEDUPE) {
    return decide(MEDIA_SEND_ACTION.FAIL, 'permanent');
  }
  // 只有确认是本地前置失败（自己读文件失败/参数校验失败）才判确定失败。
  // 其余「拿不准」的一律当可能已送达，宁可提示别重发。
  if (stage === 'unknown' && httpStatus === undefined
    && !ambiguousNetwork && LOCAL_FAILURE_PATTERN.test(haystack)) {
    return decide(MEDIA_SEND_ACTION.FAIL, 'pre-request');
  }
  // 其余全是「可能已送达」：超时、连接中断、5xx、HTML 响应、JSON 解析失败、未知错误……
  return decide(MEDIA_SEND_ACTION.UNKNOWN, 'ambiguous', true);
}

/** 「可能已送达」错误：带 deliveryUnknown 标记，工具层据此提示模型不要重试。 */
export function createMediaDeliveryUnknownError(cause) {
  const err = new Error('媒体消息可能已经发出（发送响应超时或异常，未拿到确认）：' + errText(cause));
  err.name = 'MediaDeliveryUnknownError';
  err.code = 'UNKNOWN_DELIVERY';
  err.deliveryUnknown = true;
  err.cause = cause;
  return err;
}

/**
 * 媒体发送 + 安全兜底：只有「确定未送达」的错误才去掉 msgId 主动重发一次；
 * 「可能已送达」抛 UNKNOWN_DELIVERY 而不是重发，避免同一媒体出现两遍。
 * @param {object} instance QQBot 实例
 * @param {string} method sendImage / sendVideo / sendVoice / sendFile
 * @param {object} target { scope, targetId, msgId? }
 * @param {object} source { localPath | url | buffer }
 * @param {object} [opts]
 * @param {object} [logger]
 */
export async function sendMediaSafely(instance, method, target, source, opts, logger) {
  const safeTarget = target && typeof target === 'object' ? target : {};
  try {
    return await instance[method](safeTarget, source, opts);
  } catch (err) {
    const plan = classifyMediaSendFailure(err);
    if (plan.action === MEDIA_SEND_ACTION.RETRY_PROACTIVE) {
      logger?.warn?.('媒体发送失败(' + plan.reason + ')，去掉 msgId 主动重试一次: ' + errText(err));
      const proactive = { scope: safeTarget.scope, targetId: safeTarget.targetId };
      try {
        return await instance[method](proactive, source, opts);
      } catch (retryErr) {
        // 兜底重发也可能超时/响应异常：同样不能当成「确定失败」让上层再重试
        const retryPlan = classifyMediaSendFailure(retryErr);
        if (retryPlan.action === MEDIA_SEND_ACTION.UNKNOWN) {
          logger?.warn?.('主动重发结果未知，不再次重发: ' + errText(retryErr));
          throw createMediaDeliveryUnknownError(retryErr);
        }
        throw retryErr;
      }
    }
    if (plan.action === MEDIA_SEND_ACTION.UNKNOWN) {
      logger?.warn?.('媒体发送结果未知(' + plan.reason + ')，不重发以免重复: ' + errText(err));
      throw createMediaDeliveryUnknownError(err);
    }
    throw err;
  }
}

export default sendMediaSafely;
