/**
 * adapters/minimax-clone —— MiniMax 音色克隆（独立 kind，复用 minimax 共用实现）。
 * 配置：baseUrl / model / samplePath（必填） / promptSamplePath+promptText（可选） / voiceId
 * prepare：上传样本 → voice_clone → 回填 voiceId；synthesize：T2A v2。
 */
import { prepareForKind, synthesizeForKind } from './minimax.js';

export default {
  kind: 'minimax-clone',
  synthesize: (args) => synthesizeForKind('minimax-clone', args),
  prepare: (args) => prepareForKind('minimax-clone', args),
};
