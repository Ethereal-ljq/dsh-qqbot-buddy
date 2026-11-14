/**
 * adapters/mimo-design —— 小米 MiMo 文字设计音色（独立 kind，复用 mimo 共用实现）。
 * 配置：baseUrl / description（自然语言描述想要的声音）
 */
import { synthesizeForKind } from './mimo.js';

export default {
  kind: 'mimo-design',
  synthesize: (args) => synthesizeForKind('mimo-design', args),
};
