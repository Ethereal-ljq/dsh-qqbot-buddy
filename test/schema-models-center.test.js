/**
 * schema-models-center —— 模型中心（model/vision/voice 分节）设置 schema 与模型类型插槽的契约测试。
 *
 * 覆盖：新增设置项的存在性/scope/默认值、optionsFrom 动态候选元数据、
 * normalize 的 enum / 未知键行为、slotsPayload 与 SECTIONS 的一致性。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SECTIONS, SETTINGS, schemaPayload, normalize, defaults } from '../lib/core/config/schema.js';
import { MODEL_SLOTS, slotsPayload } from '../lib/core/model-slots.js';

const byKey = new Map(SETTINGS.map((item) => [item.key, item]));

test('voice 分节存在，且位于视觉之后', () => {
  const voice = SECTIONS.find((section) => section.id === 'voice');
  assert.ok(voice, 'schema 应有 voice 分节');
  assert.match(voice.label, /语音/);
  const vision = SECTIONS.find((section) => section.id === 'vision');
  assert.ok(vision);
  assert.ok(voice.order > vision.order);
});

test('voice.* 设置项：scope/type/default 符合契约', () => {
  const expected = {
    'voice.enabled': { scope: 'profile', type: 'boolean', default: false },
    'voice.provider': { scope: 'profile', type: 'string', default: '' },
    'voice.defaultProvider': { scope: 'global', type: 'string', default: '' },
    'voice.voice': { scope: 'profile', type: 'string', default: '' },
    'voice.style': { scope: 'profile', type: 'string', default: '' },
    'voice.speed': { scope: 'profile', type: 'number', default: 1, min: 0.5, max: 2 },
    'voice.maxChars': { scope: 'profile', type: 'number', default: 300, min: 20, max: 2000 },
  };
  for (const [key, want] of Object.entries(expected)) {
    const item = byKey.get(key);
    assert.ok(item, '缺少设置项: ' + key);
    assert.equal(item.section, 'voice', key);
    assert.equal(item.scope, want.scope, key);
    assert.equal(item.type, want.type, key);
    assert.equal(item.default, want.default, key);
    if (want.min !== undefined) assert.equal(item.min, want.min, key);
    if (want.max !== undefined) assert.equal(item.max, want.max, key);
  }
  // 默认关闭：语音合成默认不产生调用/费用
  assert.equal(defaults(['profile']).voice.enabled, false);
});

test('vision.* 新增项：视觉来源/独立模型/输出上限', () => {
  const mode = byKey.get('vision.mode');
  assert.ok(mode, '缺少 vision.mode');
  assert.equal(mode.type, 'enum');
  assert.equal(mode.default, 'llm');
  assert.deepEqual(mode.values.map((value) => value.value), ['llm', 'dedicated']);
  assert.equal(byKey.get('vision.provider').default, '');
  assert.equal(byKey.get('vision.model').default, '');
  assert.equal(byKey.get('vision.maxTokens').default, 4096);
  assert.equal(byKey.get('vision.maxTokens').min, 256);
  assert.equal(byKey.get('vision.maxTokens').max, 32768);
});

test('optionsFrom 元数据：LLM/视觉/TTS 下拉走动态候选', () => {
  const expected = {
    'model.provider': 'llmProviders',
    'model.model': 'llmModels',
    'vision.provider': 'llmProviders',
    'vision.model': 'llmModels',
    'voice.provider': 'ttsProviders',
    'voice.defaultProvider': 'ttsProviders',
  };
  for (const [key, source] of Object.entries(expected)) {
    assert.equal(byKey.get(key)?.optionsFrom, source, key + ' 的 optionsFrom 应为 ' + source);
  }
  // schemaPayload 必须把 optionsFrom 透出给控制台
  const payload = schemaPayload();
  const item = payload.items.find((entry) => entry.key === 'voice.provider');
  assert.equal(item.optionsFrom, 'ttsProviders');
  const plain = payload.items.find((entry) => entry.key === 'reply.mode');
  assert.equal(plain.optionsFrom, null);
});

test('normalize：voice/vision 新项类型纠正、enum 回落、未知键告警', () => {
  const { value, warnings } = normalize({
    voice: { enabled: 'yes', speed: 99, maxChars: 1, style: '活泼', bogus: 1 },
    vision: { mode: 'nope', maxTokens: 10 },
  }, { scopes: ['profile'] });
  assert.equal(value.voice.enabled, false, '非布尔值回落默认 false');
  assert.equal(value.voice.speed, 2, '速度按 max 截断');
  assert.equal(value.voice.maxChars, 20, 'maxChars 按 min 截断');
  assert.equal(value.voice.style, '活泼');
  assert.equal(value.vision.mode, 'llm', '非法 enum 回落默认');
  assert.equal(value.vision.maxTokens, 256, 'maxTokens 按 min 截断');
  assert.ok(warnings.some((warning) => warning.includes('voice.bogus')));
  assert.ok(warnings.some((warning) => warning.includes('vision.mode')));
});

test('voice.defaultProvider 只属于 global 层', () => {
  const { value } = normalize({ voice: { defaultProvider: 'tts_1' } }, { scopes: ['profile'] });
  assert.equal(value.voice.defaultProvider, undefined, 'profile 层不应出现全局项');
  const global = normalize({ voice: { defaultProvider: 'tts_1' } }, { scopes: ['global'] });
  assert.equal(global.value.voice.defaultProvider, 'tts_1');
  assert.equal(global.value.voice.enabled, undefined, 'global 层不应出现 profile 项');
});

test('模型类型插槽：ready 项有 settingsSection，planned 项有扩展点说明', () => {
  const payload = slotsPayload();
  assert.deepEqual(payload.ready, ['llm', 'vision', 'voice']);
  assert.ok(payload.planned.includes('imagegen'));
  const sectionIds = new Set(SECTIONS.map((section) => section.id));
  for (const slot of MODEL_SLOTS) {
    assert.equal(typeof slot.label, 'string');
    assert.ok(slot.status === 'ready' || slot.status === 'planned');
    if (slot.status === 'ready') {
      assert.ok(sectionIds.has(slot.settingsSection), slot.id + ' 的 settingsSection 必须存在于 SECTIONS');
    } else {
      assert.ok(typeof slot.extend === 'string' && slot.extend !== '', slot.id + ' 预留插槽应说明扩展点');
    }
  }
  // 返回深拷贝：外部改写不能污染声明
  payload.slots[0].label = '被改掉';
  assert.notEqual(MODEL_SLOTS[0].label, '被改掉');
});
