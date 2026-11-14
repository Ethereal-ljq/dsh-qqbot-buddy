/**
 * reports/visuals —— 模板自带「插画插槽」的解析与选图逻辑（数据驱动）。
 *
 * 素材、槽位、氛围、组合都不写死在代码里，模板在自己的 meta.json 里声明：
 *
 *   "visuals": {
 *     "slots": ["hero", "peek", "rhythm"],
 *     "moods": [
 *       { "id": "lively", "label": "热闹", "hours": [12, 13, 14, 15, 16, 17, 18, 19, 20, 21] },
 *       { "id": "calm", "label": "平静", "hours": [5, 6, 7, 8] }
 *     ],
 *     "defaultMood": "lively",
 *     "items": {
 *       "hero-a": { "slot": "hero", "file": "assets/hero-a.svg", "label": "立绘 A" }
 *     },
 *     "presets": { "lively": { "hero": "hero-cheer", "peek": "...", "rhythm": "..." } }
 *   }
 *
 * 模板没有 visuals 时整条链路空转：不选图、不换图、提示词也不带插画清单。
 * 新增/删除素材 = 改 meta.json + 放/删文件，不需要改宿主代码。
 */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const FILE_RE = /^[A-Za-z0-9._\-/]+\.(?:webp|png|jpe?g|svg)$/i;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hoursOf(value) {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 24);
}

/**
 * 归一化 meta.json 里的 visuals 声明；没有任何合法素材时返回 null。
 * @returns {{slots:string[], moods:Array<{id:string,label:string,hours:number[]}>,
 *   defaultMood:string, items:Object<string,{slot:string,file:string,label:string}>,
 *   presets:Object<string,Object<string,string>>, fallback:Object<string,string>} | null}
 */
export function normalizeVisualConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const declared = Array.isArray(raw.slots) ? raw.slots.map(text).filter((slot) => ID_RE.test(slot)) : [];
  const declaredSet = new Set(declared);

  const rawItems = raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items) ? raw.items : {};
  const items = {};
  for (const [id, item] of Object.entries(rawItems)) {
    if (!ID_RE.test(id) || !item || typeof item !== 'object') continue;
    const slot = text(item.slot);
    const file = text(item.file).replace(/^\.?\//, '');
    if (!ID_RE.test(slot) || file === '' || !FILE_RE.test(file) || file.includes('..')) continue;
    // 声明了 slots 时，素材必须落在声明槽位里（防止 meta 写错槽位把 UI 搞乱）。
    if (declaredSet.size > 0 && !declaredSet.has(slot)) continue;
    items[id] = { slot, file, label: text(item.label) || id };
  }
  const usedSlots = [...new Set(Object.values(items).map((item) => item.slot))];
  if (usedSlots.length === 0) return null;

  const slots = declared.length > 0 ? declared.filter((slot) => usedSlots.includes(slot)) : usedSlots;
  if (slots.length === 0) return null;

  const moods = [];
  const seen = new Set();
  for (const mood of Array.isArray(raw.moods) ? raw.moods : []) {
    const id = text(mood && mood.id);
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    moods.push({ id, label: text(mood.label) || id, hours: hoursOf(mood.hours) });
  }
  const askedDefault = text(raw.defaultMood);
  const defaultMood = moods.some((mood) => mood.id === askedDefault)
    ? askedDefault
    : (moods[0] ? moods[0].id : '');

  const presets = {};
  const rawPresets = raw.presets && typeof raw.presets === 'object' && !Array.isArray(raw.presets) ? raw.presets : {};
  for (const mood of moods) {
    const source = rawPresets[mood.id];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const preset = {};
    for (const slot of slots) {
      const id = text(source[slot]);
      if (id && items[id] && items[id].slot === slot) preset[slot] = id;
    }
    if (Object.keys(preset).length > 0) presets[mood.id] = preset;
  }

  // 每个槽位的兜底素材（meta 没写 preset 时也能出图）。
  const fallback = {};
  for (const slot of slots) {
    fallback[slot] = Object.keys(items).find((id) => items[id].slot === slot) || '';
  }

  return { slots, moods, defaultMood, items, presets, fallback };
}

/** 取统计里消息最多的小时；没有数据返回 -1。 */
export function peakHour(stats) {
  const hours = stats && Array.isArray(stats.hours) ? stats.hours : [];
  let peak = -1;
  let best = 0;
  for (let i = 0; i < hours.length && i < 24; i += 1) {
    const n = Number(hours[i]) || 0;
    if (n > best) { best = n; peak = i; }
  }
  return peak;
}

/** 高峰小时 → 氛围：用模板声明的 hours 命中，没命中返回空串。 */
export function moodFromHour(hour, config) {
  const h = Number(hour);
  if (!config || !Number.isFinite(h) || h < 0 || h > 23) return '';
  const hit = config.moods.find((mood) => mood.hours.includes(h));
  return hit ? hit.id : '';
}

function pickId(value, slot, config) {
  const id = text(value);
  const item = config.items[id];
  return item && item.slot === slot ? id : '';
}

/** 归一化模型输出 / 手填值：只留模板声明过的 mood 与槽位素材。 */
export function normalizeVisual(input, config) {
  if (!config || !input || typeof input !== 'object') return null;
  const out = {};
  const mood = text(input.mood);
  if (config.moods.some((item) => item.id === mood)) out.mood = mood;
  for (const slot of config.slots) {
    const id = pickId(input[slot], slot, config);
    if (id) out[slot] = id;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 解析出最终选中的素材。
 * 顺序：模型点名 → mood 预设 → 每个槽位兜底素材；mood 没给时按高峰时段推断。
 * @returns {{[slot:string]:string, mood:string} | null} config 为空时返回 null
 */
export function resolveVisual(input, { stats, config } = {}) {
  if (!config) return null;
  const raw = input && typeof input === 'object' ? input : {};
  const asked = text(raw.mood);
  let mood = config.moods.some((item) => item.id === asked) ? asked : moodFromHour(peakHour(stats), config);
  if (mood === '' && (config.defaultMood !== '' || config.moods.length > 0)) {
    mood = config.defaultMood || (config.moods[0] && config.moods[0].id) || '';
  }
  const preset = (mood !== '' && config.presets[mood]) || {};
  const out = { mood };
  for (const slot of config.slots) {
    const id = pickId(raw[slot], slot, config) || preset[slot] || config.fallback[slot];
    if (id) out[slot] = id;
  }
  return out;
}

/** 从日报 payload 里取选图（payload.visual 或 report.visual）。 */
export function selectionFromPayload(payload, config) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const input = (p.visual && typeof p.visual === 'object' ? p.visual : null)
    || (p.report && typeof p.report === 'object' ? p.report.visual : null);
  return resolveVisual(input, { stats: p.stats, config });
}

/** 给提示词用的素材清单（id + 说明），与 meta 保持同步。 */
export function visualCatalogText(config) {
  if (!config) return '';
  return Object.entries(config.items).map(([id, item]) => id + ' ' + item.label).join(' / ');
}

/** 控制台用的精简视图：槽位 / 氛围 / 默认氛围。 */
export function visualSummary(config) {
  if (!config) return null;
  return {
    slots: config.slots.slice(),
    moods: config.moods.map((mood) => ({ id: mood.id, label: mood.label })),
    defaultMood: config.defaultMood,
  };
}

export default resolveVisual;
