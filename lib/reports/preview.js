/**
 * reports/preview —— 模板预览 HTML 拼装（控制台 iframe.srcdoc 用）。
 *
 * 与真实出图同源：先 buildHtml（清空字体占位、按 visual 选插画、内联 assets/ 资源），
 * 再注入示例数据与高度上报脚本，得到自包含 HTML —— 不依赖控制台静态资源，
 * iframe 用 sandbox="allow-scripts" 就能渲染，并把内容高度 postMessage 回父页面。
 */
import path from 'node:path';

import { buildHtml } from './cards.js';
import { sampleDailyPayload } from './sample.js';
import { resolveTemplate } from './template-registry.js';
import { moodFromHour, peakHour, selectionFromPayload, visualSummary } from './visuals.js';

/** 预览建议的 iframe 逻辑宽度：模板卡片最宽 1080 + body padding，1200 足够。 */
export const PREVIEW_WIDTH = 1200;

/** 高度上报脚本：逐字固定，前端按 type='qqbot:report-preview' 接收（见 UI 适配契约 §3.3）。 */
export const PREVIEW_HEIGHT_SCRIPT = '<script>(function(){function post(){try{'
  + 'var h=Math.max(document.documentElement.scrollHeight,document.body.scrollHeight);'
  + 'parent.postMessage({type:\'qqbot:report-preview\',height:h},\'*\');'
  + '}catch(e){}}window.addEventListener(\'load\',post);setTimeout(post,80);setTimeout(post,400);})();</script>';

/** JSON 进 <script> 前把 < 转义成 \u003c，避免正文提前闭合标签。 */
function scriptSafeJson(payload) {
  return JSON.stringify(payload === undefined ? null : payload).replace(/</g, '\\u003c');
}

/** 在标记前插入片段；模板没写该标记时数据脚本放最前、高度脚本放最后。 */
function insertBefore(html, marker, snippet) {
  const source = String(html || '');
  const index = source.indexOf(marker);
  if (index >= 0) return source.slice(0, index) + snippet + source.slice(index);
  return marker === '</head>' ? snippet + source : source + snippet;
}

/**
 * 注入示例数据：<script>window.__CARD_DATA__ = payload;</script>（放在 </head> 前，
 * 保证模板自己的脚本执行时数据已就绪）。单独导出便于测试。
 */
export function injectPreviewData(html, payload) {
  return insertBefore(html, '</head>', '<script>window.__CARD_DATA__ = ' + scriptSafeJson(payload) + ';</script>');
}

/** 注入高度上报脚本（放在 </body> 前，模板脚本之后执行）。 */
export function injectPreviewHeightScript(html) {
  return insertBefore(html, '</body>', PREVIEW_HEIGHT_SCRIPT);
}

/** 注入两段脚本：示例数据 + 高度上报。 */
export function injectPreviewScripts(html, payload) {
  return injectPreviewHeightScript(injectPreviewData(html, payload));
}

/**
 * 模板 → 自包含预览 HTML。
 *
 * 插画槽/氛围完全由模板 meta.json 的 visuals 决定：模板没声明就没有氛围切换，
 * 声明了就按声明的 mood 列表校验、选图、注入。
 *
 * @param {object} [options]
 * @param {string} options.name 模板名（内置或自定义）
 * @param {string} [options.mood] 示例氛围：
 *   - 具体 id：必须是模板声明的 mood；
 *   - 'random'：从模板声明的 mood 里随机一个（每次预览重新摇）；
 *   - 缺省/空：按示例数据的高峰时段兜底（再回退默认氛围）
 * @param {string} [options.day] YYYY-MM-DD，缺省/非法用本地今天
 * @param {string} [options.dataDir] 数据目录（自定义模板在 <dataDir>/templates/<name>/）
 * @param {object} [options.env] 环境变量（可用 QQBOT_TEMPLATE_DIRS 追加模板目录）
 * @returns {{ok:true, template:string, label:string, description:string, builtin:boolean,
 *   visuals:object|null, mood:string, day:string, width:number, html:string} | {ok:false, reason:string, error:string}}
 */
export function buildPreviewHtml({ name, mood, day, dataDir = '', env = process.env } = {}) {
  const key = String(name || '').trim();
  const entry = key === '' ? null : resolveTemplate(key, { dataDir, env });
  if (!entry) return { ok: false, reason: 'no-template', error: '模板不存在：' + key };
  const config = entry.visuals || null;
  const moods = config ? config.moods : [];
  const asked = typeof mood === 'string' ? mood.trim() : '';
  const base = sampleDailyPayload({ day });
  let selectedMood = '';
  if (moods.length > 0) {
    if (asked === 'random') {
      selectedMood = moods[Math.floor(Math.random() * moods.length)].id;
    } else if (moods.some((item) => item.id === asked)) {
      selectedMood = asked;
    } else {
      // 没指定/非法：按示例数据的高峰时段兜底，模拟“模型没给 mood”时的效果
      selectedMood = moodFromHour(peakHour(base.stats), config) || config.defaultMood || moods[0].id;
    }
  }
  const payload = selectedMood === ''
    ? base
    : { ...base, report: { ...base.report, visual: { mood: selectedMood } } };
  const selection = selectionFromPayload(payload, config);
  let html;
  try {
    html = injectPreviewScripts(buildHtml(entry.file, {
      renderer: '',
      selection,
      visuals: config,
      templateDir: path.dirname(entry.file),
    }), payload);
  } catch (err) {
    return { ok: false, reason: 'read-failed', error: (err && err.message) || String(err) };
  }
  return {
    ok: true,
    template: entry.file,
    label: entry.label || key,
    description: entry.description || '',
    builtin: Boolean(entry.builtin),
    visuals: visualSummary(config),
    mood: selectedMood,
    day: payload.day,
    width: PREVIEW_WIDTH,
    html,
  };
}

export default buildPreviewHtml;
