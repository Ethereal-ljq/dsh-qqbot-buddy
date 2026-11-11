/**
 * console/api/schema —— GET /api/schema：设置项 UI 元数据（单一真相来自 core/config/schema）。
 *
 * 返回 {items,sections}；items 同时给出前端常用别名：
 * enum/description/group 与 values/help/section 并存，避免前端再转换。
 * 配置服务未装配时返回空 items（页面显示空态）。
 */
import { requireConfig, safeCall } from './helpers.js';

function mapItem(item) {
  const values = item.values ?? null;
  return {
    key: item.key,
    label: item.label,
    type: item.type,
    enum: values,
    values,
    default: item.default,
    description: item.help || '',
    help: item.help || '',
    group: item.section || '',
    section: item.section || '',
    scope: item.scope || 'profile',
    widget: item.widget || 'text',
    // 动态下拉候选来源（ttsProviders / llmProviders / llmModels）；见 core/config/schema.js
    optionsFrom: item.optionsFrom || null,
    min: item.min ?? null,
    max: item.max ?? null,
    step: item.step ?? null,
  };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/schema',
    handler: (ctx) => {
      const config = requireConfig(ctx.deps);
      const payload = safeCall(() => config.schema(), {}) || {};
      const items = Array.isArray(payload.items) ? payload.items.map(mapItem) : [];
      const sections = Array.isArray(payload.sections) ? payload.sections : [];
      return { items, sections };
    },
  },
];
