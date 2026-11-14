/**
 * reports-visuals —— 模板自带插画槽（meta.json visuals）的解析与选图。
 *
 * 素材/氛围/组合全部来自配置，不在代码里写死；这里用一份固定 fixture 覆盖边界。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  moodFromHour, normalizeVisual, normalizeVisualConfig, peakHour, resolveVisual,
  selectionFromPayload, visualCatalogText, visualSummary,
} from '../lib/reports/visuals.js';

const RAW = {
  slots: ['hero', 'peek', 'rhythm'],
  moods: [
    { id: 'lively', label: '热闹', hours: [12, 13, 14] },
    { id: 'calm', label: '平静', hours: [8, 9] },
    { id: 'night', label: '深夜', hours: [23, 0, 1, 2, 3, 4] },
  ],
  defaultMood: 'lively',
  items: {
    'hero-cheer': { slot: 'hero', file: 'assets/a/hero-cheer.webp', label: '挥旗' },
    'hero-night': { slot: 'hero', file: 'assets/a/hero-night.webp', label: '犯困' },
    'peek-happy': { slot: 'peek', file: 'assets/a/peek-happy.webp' },
    'rhythm-run': { slot: 'rhythm', file: 'assets/a/rhythm-run.webp' },
  },
  presets: {
    lively: { hero: 'hero-cheer', peek: 'peek-happy', rhythm: 'rhythm-run' },
    night: { hero: 'hero-night', peek: 'peek-happy', rhythm: 'rhythm-run' },
  },
};

const config = () => normalizeVisualConfig(RAW);
const hoursWithPeak = (hour) => {
  const hours = new Array(24).fill(0);
  hours[hour] = 10;
  return hours;
};

test('normalizeVisualConfig：校验素材/槽位/氛围/预设，非法项丢弃', () => {
  const cfg = normalizeVisualConfig({
    slots: ['hero', 'peek', 'nope!'],
    moods: [{ id: 'night', hours: [23, 25, 'x'] }, { id: 'bad id' }],
    defaultMood: 'missing',
    items: {
      'hero-a': { slot: 'hero', file: 'assets/a.webp', label: 'A' },
      'hero-bad-slot': { slot: 'nope', file: 'assets/b.webp' },
      'hero-traversal': { slot: 'hero', file: '../evil.webp' },
      'hero-bad-ext': { slot: 'hero', file: 'assets/a.exe' },
      'peek-a': { slot: 'peek', file: 'assets/p.webp' },
    },
    presets: { night: { hero: 'hero-a', peek: 'hero-a', rhythm: 'missing' } },
  });
  assert.ok(cfg);
  assert.deepEqual(cfg.slots, ['hero', 'peek']);
  assert.deepEqual(Object.keys(cfg.items).sort(), ['hero-a', 'peek-a']);
  assert.deepEqual(cfg.moods.map((m) => m.id), ['night']);
  assert.deepEqual(cfg.moods[0].hours, [23]);
  assert.equal(cfg.defaultMood, 'night', 'defaultMood 非法时回落到第一个氛围');
  assert.deepEqual(cfg.presets.night, { hero: 'hero-a' }, 'points 到别的槽位/不存在的素材要丢掉');
  assert.deepEqual(cfg.fallback, { hero: 'hero-a', peek: 'peek-a' });
  assert.equal(normalizeVisualConfig({ items: {} }), null);
  assert.equal(normalizeVisualConfig({ items: { x: { slot: 'hero', file: '' } } }), null);
  assert.equal(normalizeVisualConfig(null), null);
  // 没声明 slots 时从素材反推槽位
  assert.deepEqual(normalizeVisualConfig({ items: { x: { slot: 'hero', file: 'a.webp' } } }).slots, ['hero']);
});

test('resolveVisual：高点时段兜底 + mood 预设 + 点名覆盖 + 非法回退', () => {
  const cfg = config();
  assert.equal(resolveVisual(null, {}), null, '没有插画槽的配置返回 null');
  assert.equal(resolveVisual(null, { stats: { hours: hoursWithPeak(12) }, config: cfg }).mood, 'lively');
  assert.equal(resolveVisual(null, { stats: { hours: hoursWithPeak(23) }, config: cfg }).mood, 'night');
  assert.equal(resolveVisual(null, { stats: { hours: hoursWithPeak(8) }, config: cfg }).mood, 'calm');
  // 没有命中小时 → 默认氛围（presets 缺失时用逐槽兜底）
  const calm = resolveVisual({ mood: 'calm' }, { config: cfg });
  assert.equal(calm.mood, 'calm');
  assert.equal(calm.hero, 'hero-cheer', 'calm 没有预设，逐槽回落到第一个素材');
  const mixed = resolveVisual({ mood: 'night', hero: 'hero-cheer' }, { config: cfg });
  assert.equal(mixed.mood, 'night');
  assert.equal(mixed.hero, 'hero-cheer', '点名覆盖预设');
  assert.equal(mixed.peek, 'peek-happy', '没点名的槽位用 mood 预设');
  const invalid = resolveVisual({ mood: 'wild', hero: 'missing', peek: 'hero-cheer' }, { stats: { hours: hoursWithPeak(12) }, config: cfg });
  assert.equal(invalid.mood, 'lively');
  assert.equal(invalid.hero, 'hero-cheer', '跨槽位/未知素材回退预设');
  assert.equal(invalid.peek, 'peek-happy');
  assert.equal(moodFromHour(23, cfg), 'night');
  assert.equal(moodFromHour(99, cfg), '');
  assert.equal(peakHour({ hours: hoursWithPeak(19) }), 19);
  assert.equal(peakHour({}), -1);
});

test('normalizeVisual：只保留配置里声明过的 mood / 素材', () => {
  const cfg = config();
  assert.deepEqual(
    normalizeVisual({ mood: 'night', hero: 'hero-night', peek: 'nope', rhythm: 'hero-night' }, cfg),
    { mood: 'night', hero: 'hero-night' },
  );
  assert.equal(normalizeVisual({}, cfg), null);
  assert.equal(normalizeVisual({ mood: 'wild' }, cfg), null);
  assert.equal(normalizeVisual({ mood: 'night' }, null), null);
});

test('selectionFromPayload：payload.visual 优先于 report.visual', () => {
  const cfg = config();
  assert.equal(selectionFromPayload({ report: { visual: { mood: 'night' } } }, cfg).hero, 'hero-night');
  assert.equal(
    selectionFromPayload({ visual: { mood: 'lively' }, report: { visual: { mood: 'night' } } }, cfg).mood,
    'lively',
  );
  assert.equal(selectionFromPayload({ report: { visual: { mood: 'lively' } }, stats: { hours: hoursWithPeak(23) } }, cfg).mood, 'lively');
  assert.equal(selectionFromPayload({ stats: { hours: hoursWithPeak(23) } }, cfg).mood, 'night');
  assert.equal(selectionFromPayload({}, null), null);
});

test('visualSummary / visualCatalogText：控制台与提示词用的视图', () => {
  const cfg = config();
  assert.deepEqual(visualSummary(cfg), {
    slots: ['hero', 'peek', 'rhythm'],
    moods: [{ id: 'lively', label: '热闹' }, { id: 'calm', label: '平静' }, { id: 'night', label: '深夜' }],
    defaultMood: 'lively',
  });
  assert.equal(visualSummary(null), null);
  assert.match(visualCatalogText(cfg), /hero-cheer 挥旗/);
  assert.match(visualCatalogText(cfg), /rhythm-run/);
  assert.equal(visualCatalogText(null), '');
});
