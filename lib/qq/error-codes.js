/**
 * error-codes —— QQ 开放平台发送错误的语义分类。
 *
 * 背景：QQ 消息接口的错误只能靠 err_code（SDK ApiError.bizCode）区分处置方式：
 *   - 窗口/次数类（msg_id 过期、被动回复超限）→ 降级主动消息；
 *   - markdown 权限/格式类 → 改纯文本重发；
 *   - 去重（40054005）→ 换 msg_seq 重试；
 *   - 频控/瞬时 → 退避重试；
 *   - 永久错误（内容违规/被禁言/用户拒收…）→ 放弃，不要再发一条主动消息。
 *
 * 这里只做纯函数分类，便于单测；发送策略在 sender.js。
 */

/** 发送失败类别。 */
export const SEND_ERROR = {
  WINDOW: 'window',        // 被动回复窗口过期 / 被动次数超限 / msg_id 无效
  LENGTH: 'length',        // 消息长度超限（可拆成多条重发）
  FORMAT: 'format',        // markdown 权限或内容格式错误（可降级纯文本）
  DEDUPE: 'dedupe',        // 同 msg_id + msg_seq 重复发送
  RATE_LIMIT: 'rate_limit',// 主动消息频控 / 平台限频
  TRANSIENT: 'transient',  // 服务端瞬时错误，可重试
  PERMANENT: 'permanent',  // 内容违规 / 无权限 / 用户拒收 / 机器人不可用
  NETWORK: 'network',      // 网络/超时（httpStatus=0），按瞬时处理
  UNKNOWN: 'unknown',      // 未知错误：保留旧的「降级主动再试一次」行为
};

/** 被动回复凭证类错误：窗口过期或次数用尽，应改走主动消息。 */
const WINDOW_CODES = new Set([
  304103,   // 消息ID已过期，不能回复
  40034005, // 回复消息 msg_id 已过期
  40034024, // msg_id 无效或越权
  40034025, // event_id 无效
  40034026, // event_id 已过期
  40034128, // 被动回复时间或次数超限
]);

/** markdown 权限/格式类错误：改纯文本重发（权限类还应标记该 bot 不再用 markdown）。 */
const FORMAT_CODES = new Set([
  22006,    // 消息类型与内容不匹配
  304036,   // 无 Markdown 模板权限
  40034008, // markdown 参数有空值
  40034009, // markdown 参数有换行符
  40034010, // 模板参数不能含 markdown 语法
  40034011, // 无效的 markdown 内容
  40034124, // markdown 消息参数错误
  40034127, // 无 markdown 模板权限
]);

/**
 * 消息长度超限类错误：QQ 官方文档没有给出 content/markdown 的字符上限，
 * 只在群聊页/错误码表里给了 40054007「消息长度超限」与 40054018「消息过长或异常」。
 * 长回复被整条拒绝时，正确做法是「拆成几条重发」，不是放弃这一轮。
 */
const LENGTH_CODES = new Set([
  40054007, // 消息长度超限
  40054018, // 消息过长或异常（长度类，文档未单列但官方 FAQ 与 40054007 并列）
]);

/** markdown 权限类（只有这类才把 bot 标记为「markdown 不可用」）。 */
const MARKDOWN_PERMISSION_CODES = new Set([304036, 40034127]);

/** 主动消息频控类错误。 */
const RATE_LIMIT_CODES = new Set([
  40034100, // 主动消息发送超过频控限制
  50002,    // 流式/接口频率限制
]);

/** 服务端瞬时错误，可短暂退避后重试。 */
const TRANSIENT_CODES = new Set([
  50001,     // 服务内部错误
  50055001,  // 消息发送异常，请稍后重试
  50055002,  // 单聊消息发送异常
  50055006,  // ARK 消息发送异常
]);

/** 永久错误：再重试也不会成功（继续重试只会刷日志/触发风控）。 */
const PERMANENT_CODES = new Set([
  304004,   // 无 ARK 模板权限
  304037,   // 无发按钮权限
  304061,   // 消息内容无效
  304064,   // 订阅消息未授权
  304080,   // 文件信息无效
  305007,   // 键盘样式参数错误
  340069,   // 消息类型无效
  40034006, // 消息内容违规
  40034027, // 该事件不支持回复消息
  40034029, // 内联键盘行/列超限
  40034101, // 机器人非群成员
  40034105, // 主动消息无权限
  40054002, // 机器人被禁言
  40054003, // 机器人不是群成员
  40054004, // 无好友关系
  40054010, // 不允许发送 URL
  40054013, // 用户拒收消息
  40054016, // 机器人已下线
  40034122, // 召回消息已达区间上限
  40034123, // 不支持召回消息
]);

/** 网络类错误（fetch/undici 等）。 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  'ABORT_ERR', 'TIMEOUT',
]);

/**
 * 从 SDK 错误里提取业务错误码（数字）；没有则返回 undefined。
 * 兼容 ApiError（bizCode）、普通 Error（code / err_code / errCode）以及
 * 老版本把 code 拼进 message 的情况。
 * @param {unknown} err
 * @returns {number|undefined}
 */
export function bizCodeOf(err) {
  if (!err || typeof err !== 'object') {
    // 字符串错误：尝试从文案里抠数字码
    if (typeof err === 'string') {
      const m = /\b(\d{5,9})\b/.exec(err);
      return m ? Number(m[1]) : undefined;
    }
    return undefined;
  }
  const candidates = [err.bizCode, err.code, err.err_code, err.errCode, err.resultCode, err.error_code];
  for (const raw of candidates) {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  const message = typeof err.message === 'string' ? err.message : '';
  if (message) {
    const m = /(?:code|err_code|错误码)[=:：\s]+(\d{5,9})/i.exec(message) || /\((\d{5,9})\)/.exec(message);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** 网络类错误码字符串（err.code 是非数字的 E*）。 */
export function networkCodeOf(err) {
  if (!err || typeof err !== 'object') return undefined;
  const raw = err.code ?? err.errno ?? err.cause?.code;
  return typeof raw === 'string' && NETWORK_ERROR_CODES.has(raw) ? raw : undefined;
}

/**
 * 把一次发送异常归类。
 * @param {unknown} err
 * @returns {{category:string, code?:number, networkCode?:string, httpStatus?:number, message:string}}
 */
export function classifySendError(err) {
  const code = bizCodeOf(err);
  const networkCode = networkCodeOf(err);
  const httpStatus = err && typeof err === 'object' && Number.isFinite(err.httpStatus) ? err.httpStatus : undefined;
  const message = err instanceof Error ? err.message : String(err ?? 'unknown error');

  let category = SEND_ERROR.UNKNOWN;
  if (code !== undefined) {
    if (WINDOW_CODES.has(code)) category = SEND_ERROR.WINDOW;
    else if (LENGTH_CODES.has(code)) category = SEND_ERROR.LENGTH;
    else if (MARKDOWN_PERMISSION_CODES.has(code) || FORMAT_CODES.has(code)) category = SEND_ERROR.FORMAT;
    else if (code === 40054005) category = SEND_ERROR.DEDUPE;
    else if (RATE_LIMIT_CODES.has(code)) category = SEND_ERROR.RATE_LIMIT;
    else if (TRANSIENT_CODES.has(code)) category = SEND_ERROR.TRANSIENT;
    else if (PERMANENT_CODES.has(code)) category = SEND_ERROR.PERMANENT;
  } else if (networkCode) {
    category = SEND_ERROR.NETWORK;
  } else if (httpStatus === 0 || httpStatus === undefined) {
    // 没有业务码时：SDK 网络错误 httpStatus=0；未知错误保持旧行为
    category = SEND_ERROR.UNKNOWN;
  }

  return { category, code, networkCode, httpStatus, message };
}

/** 该错误是否属于「被动凭证失效/用完」，需要改走主动消息。 */
export function isPassiveExpired(cls) {
  return cls && (cls.category === SEND_ERROR.WINDOW || cls.category === SEND_ERROR.RATE_LIMIT
    || cls.category === SEND_ERROR.TRANSIENT || cls.category === SEND_ERROR.NETWORK
    || cls.category === SEND_ERROR.UNKNOWN);
}

/** 该错误是否是 markdown 权限问题（标记 bot 不再用 markdown）。 */
export function isMarkdownPermission(cls) {
  return !!(cls && cls.code !== undefined && MARKDOWN_PERMISSION_CODES.has(cls.code));
}

/** 该错误是否是「消息长度超限」（应该拆成多条重发，而不是放弃）。 */
export function isLengthError(cls) {
  return !!(cls && cls.category === SEND_ERROR.LENGTH);
}

/** 该错误是否应该改纯文本重发。 */
export function shouldDegradeToPlain(cls) {
  return !!(cls && cls.category === SEND_ERROR.FORMAT);
}

/** 该错误是否是去重失败（换 msg_seq 可重试）。 */
export function isDedupeError(cls) {
  return !!(cls && cls.category === SEND_ERROR.DEDUPE);
}
