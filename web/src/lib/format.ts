/**
 * lib/format —— 展示层格式化（时间、时长、截断、事件摘要）。
 * 统一中文口径，供表格与状态条复用。
 */

const pad = (n: number): string => (n < 10 ? '0' + n : String(n));

/** 时间戳 → YYYY-MM-DD HH:mm:ss（本地时区）。 */
export function fmtDateTime(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/** 时间戳 → 今天内只显示 HH:mm:ss，其余 YYYY-MM-DD HH:mm。 */
export function fmtTimeSmart(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  return fmtDateTime(ts).slice(0, 16);
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 具体日期。 */
export function fmtRelative(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const diff = Date.now() - ts;
  if (diff < 0) return fmtTimeSmart(ts);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前';
  return fmtDateTime(ts).slice(0, 10);
}

/** 毫秒时长 → “3 天 4 时 / 2 小时 13 分 / 45 秒”。 */
export function fmtDuration(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return days + ' 天 ' + hours + ' 时';
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分';
  if (minutes > 0) return minutes + ' 分 ' + seconds + ' 秒';
  return seconds + ' 秒';
}

/** 截断字符串（按码点，避免切断字符）。 */
export function truncate(text: string | null | undefined, max = 80): string {
  if (!text) return '';
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/** 事件摘要：优先取常见字段，没有就给压缩 JSON。 */
export function summarizeEvent(event: unknown): string {
  if (event === null || event === undefined) return '';
  if (typeof event !== 'object') return String(event);
  const data = event as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['botId', 'peer', 'status', 'level', 'kind', 'name', 'message', 'detail']) {
    const value = data[key];
    if (value !== undefined && value !== null && value !== '') parts.push(key + '=' + String(value));
  }
  if (parts.length > 0) return parts.join(' ');
  try {
    return truncate(JSON.stringify(data), 120);
  } catch {
    return String(data);
  }
}

/** JSON 美化（失败回退原文）。 */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/** 字节数 → 可读大小（B / KiB / MiB）。 */
export function fmtBytes(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB';
  return (value / (1024 * 1024)).toFixed(2) + ' MiB';
}

/** 数字千分位。 */
export function fmtNumber(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN');
}

/**
 * 检索模式 → 中文标签。后端 mode 目前是 fts/like，后续可能新增 mixed；
 * 未知值原样展示，避免把新语义误标成 FTS。
 */
export function searchModeLabel(mode?: string | null): string {
  switch (String(mode || '').toLowerCase()) {
    case 'fts': return 'FTS trigram';
    case 'like': return 'LIKE 回退';
    case 'mixed': return 'FTS + LIKE';
    default: return mode || '';
  }
}

/** 检索模式 → 徽标色调：LIKE 回退用 warn，其余正常。 */
export function searchModeTone(mode?: string | null): 'ok' | 'warn' {
  return String(mode || '').toLowerCase() === 'like' ? 'warn' : 'ok';
}

/** 去掉 undefined 的浅对象（用于 PUT body）。 */
export function compact<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
