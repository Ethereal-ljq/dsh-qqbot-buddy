/**
 * console/api/stubs —— 尚未实现的资源 REST 占位（DESIGN-v2 §3 后续项）。
 *
 * 群友库 / 人格卡 / 表情包依赖 M1 后续 store；动作接口依赖 M2 bot 宿主。
 * 统一 501 {error:{code:'not_implemented',message}}，前端按空态处理而不是崩。
 * 若宿主装配了 deps.actions.run，POST /api/actions/:name 直接转发。
 */
import { notImplemented } from './helpers.js';

function stub(label) {
  return () => {
    throw notImplemented(label + ' 接口将在后续里程碑实现');
  };
}

export const routes = [
  { method: 'GET', path: '/api/members', handler: stub('群友库') },
  { method: 'POST', path: '/api/members', handler: stub('群友库') },
  { method: 'PATCH', path: '/api/members/:id', handler: stub('群友库') },
  { method: 'DELETE', path: '/api/members/:id', handler: stub('群友库') },

  { method: 'GET', path: '/api/personas', handler: stub('人格卡') },
  { method: 'POST', path: '/api/personas', handler: stub('人格卡') },
  { method: 'GET', path: '/api/personas/:id', handler: stub('人格卡') },
  { method: 'PATCH', path: '/api/personas/:id', handler: stub('人格卡') },
  { method: 'DELETE', path: '/api/personas/:id', handler: stub('人格卡') },

  { method: 'GET', path: '/api/stickers', handler: stub('表情包') },
  { method: 'POST', path: '/api/stickers', handler: stub('表情包') },
  { method: 'DELETE', path: '/api/stickers/:id', handler: stub('表情包') },

  {
    method: 'POST',
    path: '/api/actions/:name',
    handler: async (ctx) => {
      const actions = ctx.deps?.actions;
      const name = ctx.params.name;
      if (!actions || typeof actions.run !== 'function') {
        throw notImplemented('动作 ' + name + ' 需要 bot 宿主装配（M2）');
      }
      const result = await actions.run(name, ctx.body || {});
      return result === undefined ? { ok: true } : result;
    },
  },
];
