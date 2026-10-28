/**
 * media-cleaner —— 富媒体下载目录的 TTL 清理。
 *
 * 下载目录（默认 ~/.dsh-qqbot/media）里的文件写入后不再变更，文件 mtime 即下载时间。
 * 启动时清一次，之后每小时清一次；用 ctx.effect 挂定时器，插件卸载时自动停止。
 *
 * 注意：当前 ConfigSchema 没有 media.ttlHours 字段（Lead 的 config-schema.js 未定义），
 * 因此默认 TTL 用常量 168 小时（7 天），可由调用方传入 ttlHours 覆盖。
 */
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 默认保留时长（小时）：7 天。 */
export const DEFAULT_TTL_HOURS = 168;
/** 定期清理间隔（毫秒）：1 小时。 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 清理过期媒体文件（按 mtime 判断）。
 * @param {object} args
 * @param {string} args.mediaDir 媒体目录绝对路径
 * @param {number} [args.ttlHours] 保留小时数；<=0 表示永不过期
 * @param {object} [args.logger] 日志对象
 * @returns {Promise<number>} 删除的文件数
 */
export async function cleanupExpiredMedia({ mediaDir, ttlHours = DEFAULT_TTL_HOURS, logger } = {}) {
  if (!mediaDir || ttlHours <= 0) return 0;
  if (!existsSync(mediaDir)) return 0;
  const now = Date.now();
  const ttlMs = ttlHours * 60 * 60 * 1000;
  let entries;
  try {
    entries = await readdir(mediaDir, { withFileTypes: true });
  } catch (err) {
    logger?.warn?.('读取媒体目录失败: ' + (err && err.message));
    return 0;
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const results = await Promise.all(files.map(async (name) => {
    const filePath = join(mediaDir, name);
    try {
      const info = await stat(filePath);
      if (now - info.mtimeMs <= ttlMs) return false;
      await rm(filePath, { force: true });
      logger?.debug?.('已清理过期媒体: ' + name);
      return true;
    } catch (err) {
      logger?.warn?.('清理媒体文件失败 ' + name + ': ' + (err && err.message));
      return false;
    }
  }));
  return results.filter(Boolean).length;
}

/**
 * 启动媒体清理：启动时清一次 + 每小时清一次。
 * @param {object} ctx cordis 插件上下文（用于 ctx.effect 生命周期）
 * @param {object} args
 * @param {string} args.mediaDir 媒体目录
 * @param {number} [args.ttlHours] 保留小时数
 * @param {object} [args.logger] 日志对象
 */
export function startMediaCleanup(ctx, { mediaDir, ttlHours = DEFAULT_TTL_HOURS, logger } = {}) {
  if (!mediaDir || ttlHours <= 0) return;
  const runOnce = () => {
    cleanupExpiredMedia({ mediaDir, ttlHours, logger })
      .then((cleaned) => {
        if (cleaned > 0) logger?.info?.('已清理 ' + cleaned + ' 个过期媒体文件');
      })
      .catch((err) => logger?.warn?.('媒体清理失败: ' + (err && err.message)));
  };
  runOnce();
  logger?.info?.('媒体清理已启动 (ttl=' + ttlHours + 'h, dir=' + mediaDir + ')');
  if (!ctx || typeof ctx.effect !== 'function') return;
  try {
    ctx.effect(() => {
      const timer = setInterval(runOnce, CLEANUP_INTERVAL_MS);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    }, 'qqbot-buddy.media-cleanup');
  } catch (err) {
    logger?.warn?.('注册媒体清理定时器失败: ' + (err && err.message));
  }
}
