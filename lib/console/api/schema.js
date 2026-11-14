/**
 * console/api/schema —— GET /api/schema：设置项 UI 元数据（单一真相来自 core/config/schema）。
 *
 * 返回 {items,sections}；items 同时给出前端常用别名：
 * enum/description/group 与 values/help/section 并存，避免前端再转换。
 * 配置服务未装配时返回空 items（页面显示空态）。
 */
import { listTemplates } from '../../reports/template-registry.js';
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
      const paths = (ctx.deps && ctx.deps.paths) || {};
      const custom = safeCall(() => listTemplates({ dataDir: paths.dataDir || '' }), []) || [];
      const items = Array.isArray(payload.items)
        ? payload.items.map((item) => {
          const mapped = mapItem(item);
          // 模板选择插槽：内置模板写在 schema，自定义模板运行时从数据目录发现后追加。
          if (item.key !== 'daily.template') return mapped;
          const values = Array.isArray(mapped.values) ? mapped.values.slice() : [];
          const seen = new Set(values.map((entry) => (typeof entry === 'string' ? entry : entry.value)));
          const extra = [];
          for (const tpl of custom) {
            if (tpl.builtin || seen.has(tpl.name)) continue;
            seen.add(tpl.name);
            // meta.json 自带 label 就原样用；没有时用目录名并标注「自定义」。
            extra.push({ value: tpl.name, label: tpl.label === tpl.name ? tpl.name + ' · 自定义' : tpl.label });
          }
          // 自定义项排在「只发文本」之前，方便下拉阅读。
          const offIndex = values.findIndex((entry) => (typeof entry === 'string' ? entry : entry.value) === 'off');
          if (offIndex >= 0) values.splice(offIndex, 0, ...extra);
          else values.push(...extra);
          return { ...mapped, values, enum: values };
        })
        : [];
      const sections = Array.isArray(payload.sections) ? payload.sections : [];
      // 一级分组（配置档编辑器顶部的组 tab）；旧 core/config 没给 groups 时前端会回退。
      const groups = Array.isArray(payload.groups) ? payload.groups : [];
      return { items, sections, groups };
    },
  },
];
