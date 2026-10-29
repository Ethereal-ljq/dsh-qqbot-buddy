/**
 * prompt-guides —— 功能性提示词与人设分离：默认值、开关、自定义覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FUNCTION_PROMPTS,
  resolveGuide,
  guideEnabled,
} from '../lib/prompt-guides.js';
import { createPromptComposer } from '../lib/prompt.js';

function makeComposer(overrides = {}) {
  const prompts = {
    toolGuide: { enabled: true, text: '' },
    sendGuide: { enabled: true, text: '' },
    rhythmGuide: { enabled: true, text: '' },
    stickerGuide: { enabled: true, text: '' },
    ...(overrides.prompts || {}),
  };
  const base = {
    persona: { mode: 'replace', groupExtraPrompt: '', directExtraPrompt: '', path: '/x/persona.md' },
    memory: { enabled: false, injectMaxChars: 0, selfImprovePrompt: '' },
    phrases: { enabled: false, items: [] },
    features: { stickers: true },
    stickers: { collectEnabled: true },
    reply: { groupMode: 'adaptive' },
    behavior: { extraInstructions: '' },
    prompts,
  };
  return createPromptComposer({
    settings: { get: () => base },
    personaStore: { read: () => ({ exists: true, text: 'PERSONA_ONLY' }) },
    memoryStore: { hotText: () => '' },
    stickerStore: {
      catalog: () => 'laugh=大笑',
      dir: () => '/stickers',
    },
    logger: { warn() {} },
  });
}

test('默认：四段功能性提示词各自独立注入，persona 在前', () => {
  const text = makeComposer().compose({ scope: 'group' });
  assert.ok(text.startsWith('PERSONA_ONLY'));
  for (const marker of ['【工具使用约定】', '【发消息】', '【表情包】', '【群聊节奏】']) {
    assert.ok(text.includes(marker), '缺少提示词段：' + marker);
  }
  // persona 段本身不含功能性文案
  const personaEnd = text.indexOf('【工具使用约定】');
  assert.ok(personaEnd > 0);
  assert.ok(!text.slice(0, personaEnd).includes('memory_save'));
});

test('关闭某段后不再注入；其它段不受影响', () => {
  const text = makeComposer({ prompts: { stickerGuide: { enabled: false, text: '' } } }).compose({ scope: 'group' });
  assert.ok(!text.includes('【表情包】'));
  assert.ok(text.includes('【工具使用约定】'));
});

test('自定义文本覆盖默认；留空回退默认', () => {
  const custom = makeComposer({ prompts: { sendGuide: { enabled: true, text: '【发消息】CUSTOM_RULE' } } }).compose({ scope: 'group' });
  assert.ok(custom.includes('CUSTOM_RULE'));
  assert.ok(!custom.includes('大多数回复只发一条消息'));
  const fallback = makeComposer({ prompts: { sendGuide: { enabled: true, text: '   ' } } }).compose({ scope: 'group' });
  assert.ok(fallback.includes('大多数回复只发一条消息'));
});

test('表情包：规则段可编辑，目录仍动态追加', () => {
  const text = makeComposer({ prompts: { stickerGuide: { enabled: true, text: '【表情包】只在深夜发' } } }).compose({ scope: 'group' });
  assert.ok(text.includes('【表情包】只在深夜发'));
  assert.ok(text.includes('/stickers'), '动态目录应保留');
  assert.ok(text.includes('laugh=大笑'));
});

test('群聊节奏段只在非 all 模式下注入', () => {
  const adaptive = makeComposer().compose({ scope: 'group' });
  assert.ok(adaptive.includes('【群聊节奏】'));
  const all = createPromptComposer({
    settings: {
      get: () => ({
        persona: { mode: 'replace', groupExtraPrompt: '', directExtraPrompt: '', path: '/x/persona.md' },
        memory: { enabled: false, injectMaxChars: 0, selfImprovePrompt: '' },
        phrases: { enabled: false, items: [] },
        features: { stickers: false },
        stickers: { collectEnabled: true },
        reply: { groupMode: 'all' },
        behavior: { extraInstructions: '' },
        prompts: {
          toolGuide: { enabled: true, text: '' },
          sendGuide: { enabled: true, text: '' },
          rhythmGuide: { enabled: true, text: '' },
          stickerGuide: { enabled: true, text: '' },
        },
      }),
    },
    personaStore: { read: () => ({ exists: true, text: 'PERSONA_ONLY' }) },
    memoryStore: { hotText: () => '' },
    stickerStore: null,
    logger: { warn() {} },
  }).compose({ scope: 'group' });
  assert.ok(!all.includes('【群聊节奏】'));
});

test('resolveGuide / guideEnabled 语义', () => {
  assert.equal(resolveGuide({ text: 'x' }, 'default'), 'x');
  assert.equal(resolveGuide({ text: '  ' }, 'default'), 'default');
  assert.equal(resolveGuide(undefined, 'default'), 'default');
  assert.equal(guideEnabled({ enabled: false }), false);
  assert.equal(guideEnabled({ enabled: true }), true);
  assert.equal(guideEnabled(undefined), true);
  assert.ok(DEFAULT_FUNCTION_PROMPTS.stickerGuide.includes('qqbot_send_file'));
});


test('默认功能提示词已承载原人设里的功能内容（工具约定/格式/清单规则）', () => {
  // 【能力边界】自 v0.8 起由 renderCapabilityGuide 按已启用能力动态生成，
  // 静态默认文本里只保留「工具使用约定 + 安全」。
  assert.ok(!DEFAULT_FUNCTION_PROMPTS.toolGuide.includes('【能力边界】'), '能力边界不应再写死在静态文本里');
  assert.ok(DEFAULT_FUNCTION_PROMPTS.toolGuide.includes('【安全】'));
  assert.ok(DEFAULT_FUNCTION_PROMPTS.toolGuide.includes('qqbot_describe_image'));
  assert.ok(DEFAULT_FUNCTION_PROMPTS.sendGuide.includes('【群聊消息格式】'));
  assert.ok(DEFAULT_FUNCTION_PROMPTS.sendGuide.includes('不主动列 1234 清单'));
  assert.ok(DEFAULT_FUNCTION_PROMPTS.sendGuide.includes('[[msg]]'));
  // 人设层不该再重复这些功能文案（由 persona.md 维护，这里只校验默认不等于功能段）
  assert.notEqual(DEFAULT_FUNCTION_PROMPTS.sendGuide, DEFAULT_FUNCTION_PROMPTS.toolGuide);
});

test('renderCapabilityGuide：只列出已启用能力，空能力有兜底文案', async () => {
  const { renderCapabilityGuide } = await import('../lib/prompt-guides.js');
  assert.match(renderCapabilityGuide([]), /没有可用的工具能力/);

  const text = renderCapabilityGuide([
    { id: 'workspace', label: '工作区读写', boundary: '读写当前工作区里的文件。' },
    { id: 'imagegen', label: '图片生成', boundary: '可以生成或编辑图片，生成后用 qqbot_send_file 发出去。' },
  ]);
  assert.match(text, /【能力边界】/);
  assert.match(text, /1\. 读写当前工作区里的文件。/);
  assert.match(text, /2\. 可以生成或编辑图片/);
  assert.ok(!text.includes('联网'), '未启用的能力不应出现');
});

test('renderCapabilityGuide：忽略缺少 boundary 的条目', async () => {
  const { renderCapabilityGuide } = await import('../lib/prompt-guides.js');
  const text = renderCapabilityGuide([
    { id: 'a', label: 'A', boundary: '能做 A。' },
    { id: 'b', label: 'B', boundary: '' },
  ]);
  assert.match(text, /能做 A/);
  assert.ok(!text.includes('B'), '空边界条目应被过滤');
});
