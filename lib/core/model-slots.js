/**
 * core/model-slots —— 「模型类型」插槽注册表（控制台「模型」页的 tab 单一真相）。
 *
 * 控制台「模型」页 = 按本表渲染 top tabs：status=ready 的类型渲染成可编辑 tab，
 * status=planned 的类型归入「更多类型」tab 展示为预留插槽（后续开发从这里扩展）。
 *
 * 新增一类模型时改这里 + 在 core/config/schema.js 加对应 section：
 *   1. settingsSection：该类型在设置 schema 里的分节 id（ready 时必填）；
 *   2. status='ready' 后控制台自动多出一个 tab（前端不写死类型清单）；
 *   3. planned 项只做展示与「扩展点」说明，不参与配置读写。
 *
 * 纯声明模块，不 import 任何东西（console API 与测试共用）。
 */

/** @typedef {{id:string,label:string,status:'ready'|'planned',settingsSection?:string,desc:string,extend?:string,icon?:string}} ModelSlot */

/** 模型类型插槽（顺序即控制台 tab 顺序）。 */
export const MODEL_SLOTS = [
  {
    id: 'llm',
    label: 'LLM',
    status: 'ready',
    settingsSection: 'model',
    desc: '对话模型：provider / model / 推理强度 / agent preset（按配置档生效）',
  },
  {
    id: 'vision',
    label: '视觉',
    status: 'ready',
    settingsSection: 'vision',
    desc: '图片理解：跟随 LLM 自身视觉（内联图片）或使用更精细的独立视觉模型',
  },
  {
    id: 'voice',
    label: '语音（TTS）',
    status: 'ready',
    settingsSection: 'voice',
    desc: '文字转语音：供应商/音色配置（全局）+ 每个配置档的选择',
  },
  {
    id: 'imagegen',
    label: '图像生成',
    status: 'planned',
    desc: '文生图 / 图片编辑模型的供应商与默认模型选择',
    extend: '在 core/model-slots.js 注册 slot，并复用 core/tts 的 provider registry 模式（provider 表 + adapter 目录 + console/models API）',
  },
  {
    id: 'asr',
    label: '语音识别',
    status: 'planned',
    desc: '把收到的 QQ 语音转成文字的模型（当前沿用 QQ 自带 ASR / 宿主转写）',
    extend: '同上；另外 inbound 的语音分支（lib/qq/inbound.js buildVoicePart）需要接新的 ASR provider',
  },
  {
    id: 'embedding',
    label: '向量与重排',
    status: 'planned',
    desc: '记忆/知识库检索用的 embedding / rerank 模型',
    extend: 'core/memory 与 core/kb 的检索层预留了 FTS 通道，接向量模型时在检索实现里做双路融合',
  },
];

/** 取 slot（未知返回 null）。 */
export function slotOf(id) {
  if (typeof id !== 'string' || id === '') return null;
  return MODEL_SLOTS.find((slot) => slot.id === id) || null;
}

/** 控制台 API 返回体（深拷贝，避免调用方改到声明）。 */
export function slotsPayload() {
  return {
    slots: JSON.parse(JSON.stringify(MODEL_SLOTS)),
    ready: MODEL_SLOTS.filter((slot) => slot.status === 'ready').map((slot) => slot.id),
    planned: MODEL_SLOTS.filter((slot) => slot.status === 'planned').map((slot) => slot.id),
  };
}

export default { MODEL_SLOTS, slotOf, slotsPayload };
