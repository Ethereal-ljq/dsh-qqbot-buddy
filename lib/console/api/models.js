/**
 * console/api/models —— 「模型」页后端接口（LLM 目录 / 视觉 / TTS 供应商 / 模型类型插槽）。
 *
 * 契约见 docs/MODELS-CENTER.md §7：
 *   GET    /api/models/slots                      模型类型插槽（控制台 tab 的单一真相）
 *   GET    /api/models/llm                        宿主 LLM provider/model 目录（尽力而为，失败不报错）
 *   GET    /api/models/tts/kinds                  TTS 供应商种类元数据（前端通用表单）
 *   GET    /api/models/tts/providers              已配置的 TTS 供应商（secret 只写不读）
 *   POST   /api/models/tts/providers              新增
 *   PATCH  /api/models/tts/providers/:id          编辑（secret 空串 = 保留）
 *   DELETE /api/models/tts/providers/:id          删除
 *   POST   /api/models/tts/providers/:id/test     合成一段测试语音（返回 base64 供试听）
 *
 * 依赖降级：TTS 引擎未装配（旧装配/模块异常）→ 501 not_ready，页面显示空态；
 * 宿主 llm 服务不可用 → 返回空目录 + warning，不阻断页面。
 */
import { slotsPayload } from '../../core/model-slots.js';
import { publicKinds } from '../../core/tts/providers.js';
import {
  HttpError, requireConfig, badRequest, notFound, notReady, isPlainObject, audit,
} from './helpers.js';

/** 取 TTS 引擎；未装配时 501（页面按「待接入」空态处理）。 */
function requireTts(deps) {
  const tts = deps?.tts;
  if (!tts || typeof tts !== 'object' || typeof tts.listProviders !== 'function') {
    throw notReady('TTS 引擎未装配（core/tts）');
  }
  return tts;
}

/** 服务层抛错 → 400 + 可读 code（供应商校验错误都是用户输入问题，不该变成 500）。 */
function asUserError(err, fallbackCode) {
  if (err instanceof HttpError) return err;
  const message = String((err && err.message) || err || '操作失败');
  const code = typeof (err && err.code) === 'string' && err.code !== '' ? err.code : fallbackCode;
  return new HttpError(400, code, message);
}

// ── 模型类型插槽 ────────────────────────────────────────────
function listSlots() {
  return slotsPayload();
}

// ── 宿主 LLM 目录（provider/model 下拉候选）─────────────────
function readLlmService(deps) {
  const rootCtx = deps?.rootCtx;
  if (!rootCtx) return undefined;
  try {
    if (typeof rootCtx.get === 'function') return rootCtx.get('llm');
    return rootCtx.llm;
  } catch {
    return undefined;
  }
}

function asModelItem(provider, model) {
  const id = model && typeof model.id === 'string' ? model.id : '';
  if (id === '') return null;
  const item = {
    provider,
    id,
    name: model && typeof model.name === 'string' && model.name !== '' ? model.name : id,
  };
  if (model && typeof model.description === 'string' && model.description !== '') item.description = model.description;
  if (model && Array.isArray(model.inputModalities)) {
    item.inputModalities = model.inputModalities.filter((value) => typeof value === 'string');
  }
  return item;
}

async function llmCatalog(ctx) {
  const out = { providers: [], models: [], warning: '' };
  try {
    const llm = readLlmService(ctx.deps);
    if (!llm) {
      out.warning = '宿主 llm 服务不可用，provider/model 只能手填';
      return out;
    }
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : [];
    out.providers = (Array.isArray(providers) ? providers : [])
      .map((item) => {
        const id = item && typeof item.id === 'string' ? item.id : '';
        if (id === '') return null;
        return { id, name: typeof item.name === 'string' && item.name !== '' ? item.name : id };
      })
      .filter(Boolean);
    if (typeof llm.listModels !== 'function') return out;
    const lists = await Promise.all(out.providers.map(async (provider) => {
      try {
        const models = await llm.listModels(provider.id);
        return (Array.isArray(models) ? models : []).map((model) => asModelItem(provider.id, model)).filter(Boolean);
      } catch {
        return [];
      }
    }));
    out.models = lists.flat();
    if (out.models.length === 0 && out.providers.length > 0) {
      out.warning = '宿主未返回模型目录，model 只能手填（provider/model 仍会生效）';
    }
  } catch (err) {
    out.warning = '读取宿主 LLM 目录失败: ' + String((err && err.message) || err).slice(0, 300);
  }
  return out;
}

// ── TTS 供应商 ─────────────────────────────────────────────
function listTtsKinds() {
  return { kinds: publicKinds() };
}

function listTtsProviders(ctx) {
  const tts = requireTts(ctx.deps);
  const config = requireConfig(ctx.deps);
  let defaultProvider = '';
  try {
    const values = config.getSettings('');
    defaultProvider = values && values.voice && typeof values.voice.defaultProvider === 'string'
      ? values.voice.defaultProvider
      : '';
  } catch { /* 全局层读不到不影响列表 */ }
  const providers = typeof tts.listProviders === 'function' ? tts.listProviders() : [];
  return { providers: Array.isArray(providers) ? providers : [], defaultProvider };
}

function createTtsProvider(ctx) {
  const tts = requireTts(ctx.deps);
  const body = ctx.body;
  if (!isPlainObject(body)) throw badRequest('请求体必须是 JSON 对象');
  const provider = (() => {
    try { return tts.saveProvider(body); } catch (err) { throw asUserError(err, 'invalid_tts_provider'); }
  })();
  audit(ctx.deps, { kind: 'tts.provider.create', detail: provider && provider.name ? provider.name : '' });
  return provider;
}

function updateTtsProvider(ctx) {
  const tts = requireTts(ctx.deps);
  const id = ctx.params && ctx.params.id ? String(ctx.params.id) : '';
  if (id === '') throw badRequest('缺少供应商 id');
  const existing = (() => {
    try { return typeof tts.getProvider === 'function' ? tts.getProvider(id) : null; } catch { return null; }
  })();
  if (!existing) throw notFound('TTS 供应商不存在: ' + id);
  const body = ctx.body;
  if (!isPlainObject(body)) throw badRequest('请求体必须是 JSON 对象');
  const provider = (() => {
    try { return tts.saveProvider(Object.assign({}, body, { id })); } catch (err) { throw asUserError(err, 'invalid_tts_provider'); }
  })();
  audit(ctx.deps, { kind: 'tts.provider.update', detail: id });
  return provider;
}

function deleteTtsProvider(ctx) {
  const tts = requireTts(ctx.deps);
  const id = ctx.params && ctx.params.id ? String(ctx.params.id) : '';
  if (id === '') throw badRequest('缺少供应商 id');
  let removed = false;
  try { removed = tts.deleteProvider(id) === true; } catch (err) { throw asUserError(err, 'tts_provider_delete_failed'); }
  if (!removed) throw notFound('TTS 供应商不存在: ' + id);
  audit(ctx.deps, { kind: 'tts.provider.delete', detail: id });
  return { ok: true, id };
}

const DEFAULT_TEST_TEXT = '你好，这是一条语音合成测试。';

async function testTtsProvider(ctx) {
  const tts = requireTts(ctx.deps);
  const id = ctx.params && ctx.params.id ? String(ctx.params.id) : '';
  if (id === '') throw badRequest('缺少供应商 id');
  let existing = null;
  try { existing = typeof tts.getProvider === 'function' ? tts.getProvider(id) : null; } catch { existing = null; }
  if (!existing) throw notFound('TTS 供应商不存在: ' + id);
  const body = isPlainObject(ctx.body) ? ctx.body : {};
  const text = typeof body.text === 'string' && body.text.trim() !== '' ? body.text.trim().slice(0, 500) : DEFAULT_TEST_TEXT;
  let result;
  try {
    result = await tts.test({ providerId: id, text });
  } catch (err) {
    throw asUserError(err, 'tts_test_failed');
  }
  if (!result || result.ok !== true) {
    throw new HttpError(400, (result && result.code) || 'tts_test_failed', String((result && result.error) || '语音合成测试失败'));
  }
  audit(ctx.deps, { kind: 'tts.provider.test', detail: id });
  return result;
}

export const routes = [
  { method: 'GET', path: '/api/models/slots', handler: listSlots },
  { method: 'GET', path: '/api/models/llm', handler: llmCatalog },
  { method: 'GET', path: '/api/models/tts/kinds', handler: listTtsKinds },
  { method: 'GET', path: '/api/models/tts/providers', handler: listTtsProviders },
  { method: 'POST', path: '/api/models/tts/providers', handler: createTtsProvider },
  { method: 'PATCH', path: '/api/models/tts/providers/:id', handler: updateTtsProvider },
  { method: 'DELETE', path: '/api/models/tts/providers/:id', handler: deleteTtsProvider },
  { method: 'POST', path: '/api/models/tts/providers/:id/test', handler: testTtsProvider },
];
