/**
 * binding/qr —— 绑定 URL → SVG data URL（宿主侧渲染）。
 *
 * 二维码在宿主进程内渲染：客户端 bundle 保持零第三方依赖，且编码内容来自
 * 可信的 connector 回调，页面没有伪造面。
 *
 * 降级语义：qrcode 包不可用、渲染抛错、输入非法时一律返回 undefined（不抛错），
 * 由调用方（binding service）把页面降级为「只显示链接」。
 */

/** 二维码渲染参数：SVG、1 单位留白、240px 宽度（设置页侧栏展示用）。 */
const QR_OPTIONS = { type: 'svg', margin: 1, width: 240 };

function errText(error) {
  return error instanceof Error ? error.message : String(error);
}

function warn(logger, message) {
  try {
    if (logger && typeof logger.warn === 'function') logger.warn(message);
  } catch {
    /* 日志失败不能影响渲染降级 */
  }
}

/**
 * 把绑定 URL 渲染为 `data:image/svg+xml;base64,...`，供设置页 <img src> 直接使用。
 *
 * 使用动态 import 加载 qrcode：包缺失时只让本函数降级，不会连带打挂插件加载。
 *
 * @param {string} url 二维码内容（q.qq.com 的 connect.html 链接）
 * @param {{warn?: Function}} [logger] 可选日志（渲染失败时 warn）
 * @returns {Promise<string|undefined>} data URL；失败/不可用时 undefined
 */
export async function renderQrSvgDataUrl(url, logger) {
  if (typeof url !== 'string' || url.trim() === '') return undefined;
  try {
    const mod = await import('qrcode');
    const QRCode = mod && (mod.default ?? mod);
    if (!QRCode || typeof QRCode.toString !== 'function') {
      throw new Error('qrcode 模块不可用（缺少 toString）');
    }
    const svg = await QRCode.toString(url, QR_OPTIONS);
    if (typeof svg !== 'string' || svg.trim() === '') {
      throw new Error('qrcode 返回空 SVG');
    }
    return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  } catch (error) {
    warn(logger, '[qqbot-buddy] 二维码 SVG 渲染失败（页面降级为链接）: ' + errText(error));
    return undefined;
  }
}

export default { renderQrSvgDataUrl };
