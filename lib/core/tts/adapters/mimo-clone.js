/**
 * adapters/mimo-clone —— 小米 MiMo 音色克隆（独立 kind，复用 mimo 共用实现）。
 * 配置：baseUrl / samplePath（本机音频，文件选择器获取）/ style（可选）
 */
import { synthesizeForKind } from './mimo.js';

export default {
  kind: 'mimo-clone',
  synthesize: (args) => synthesizeForKind('mimo-clone', args),
};
