/**
 * console/api/stubs —— 尚未实现的资源 REST 占位（DESIGN-v2 §3 后续项）。
 *
 * 群友库/人格卡/表情包已由 members.js / personas.js / stickers.js 实现；
 * 这里只剩 /api/actions/:name 的兜底：宿主未装配 deps.actions.run 时返回 501，
 * 由前端按空态处理。
 */
import { HttpError, notImplemented } from './helpers.js';

export const routes = [
  {
    method: 'POST',
    path: '/api/actions/:name',
    handler: async (ctx) => {
      const actions = ctx.deps?.actions;
      const name = ctx.params.name;
      if (!actions || typeof actions.run !== 'function') {
        throw notImplemented('动作 ' + name + ' 需要 bot 宿主装配（M2）');
      }
      try {
        const result = await actions.run(name, ctx.body || {});
        return result === undefined ? { ok: true } : result;
      } catch (err) {
        // 动作的真实原因（未配置凭据 / TIMEOUT / TOO_LARGE / SSRF_BLOCKED / 未知动作…）
        // 必须透给前端做文案映射；普通 Error 统一映射为 400 + 可读 message。
        if (err instanceof HttpError) throw err;
        const code = typeof err?.code === 'string' && err.code.trim() !== '' ? err.code.trim() : 'action_failed';
        const message = String(err?.message || err || ('动作 ' + name + ' 执行失败'));
        throw new HttpError(400, code, message);
      }
    },
  },
];
