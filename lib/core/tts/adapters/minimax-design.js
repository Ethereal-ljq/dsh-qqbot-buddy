/**
 * adapters/minimax-design —— MiniMax 文字设计音色（独立 kind，复用 minimax 共用实现）。
 * 配置：baseUrl / model / description（必填） / previewText / voiceId
 * prepare：voice_design → 回填 voiceId + 返回试听音频；synthesize：T2A v2。
 */
import { prepareForKind, synthesizeForKind } from './minimax.js';

export default {
  kind: 'minimax-design',
  synthesize: (args) => synthesizeForKind('minimax-design', args),
  prepare: (args) => prepareForKind('minimax-design', args),
};
