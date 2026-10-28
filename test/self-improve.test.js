/**
 * self-improve —— 自我改进提示词与 persona 分离：独立注入段、独立提炼 prompt。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SELF_IMPROVE_PROMPT,
  DEFAULT_COLLECTOR_PROMPT,
  buildCollectorPrompt,
} from '../lib/self-improve.js';
import { createPromptComposer } from '../lib/prompt.js';

test('默认自我改进提示词：学习规则独立成段，不混入 persona', () => {
  assert.match(DEFAULT_SELF_IMPROVE_PROMPT, /memory_save/);
  assert.match(DEFAULT_SELF_IMPROVE_PROMPT, /长期/);
  assert.doesNotMatch(DEFAULT_SELF_IMPROVE_PROMPT, /语气|口癖|称呼鱼鱼/);
});

test('collector prompt：默认占位替换 + 对话摘录追加', () => {
  const prompt = buildCollectorPrompt({ transcript: '用户: 我喜欢猫\n助手: 好的', maxFacts: 3, maxFactChars: 120 });
  assert.match(prompt, /最多输出 3 条事实，每条不超过 120 个字符/);
  assert.doesNotMatch(prompt, /\{\{maxFacts\}\}|\{\{maxFactChars\}\}/);
  assert.ok(prompt.endsWith('【对话摘录】\n用户: 我喜欢猫\n助手: 好的'));
});

test('collector prompt：自定义覆盖生效，仍支持占位与摘录', () => {
  const prompt = buildCollectorPrompt({
    transcript: '用户: hi',
    maxFacts: 2,
    maxFactChars: 50,
    override: '只提取偏好，最多 {{maxFacts}} 条，每条 {{maxFactChars}} 字。',
  });
  assert.ok(prompt.startsWith('只提取偏好，最多 2 条，每条 50 字。'));
  assert.ok(prompt.endsWith('【对话摘录】\n用户: hi'));
  assert.doesNotMatch(prompt, /\{\{/);
  // 自定义出现时不混入默认提炼指令
  assert.doesNotMatch(prompt, /你是长期记忆提炼器/);
});

function makeComposer(overrides = {}) {
  const settings = {
    get: () => ({
      persona: { mode: 'replace', groupExtraPrompt: '', directExtraPrompt: '', path: '/x/persona.md' },
      memory: { enabled: true, injectMaxChars: 0, selfImprovePrompt: 'CUSTOM_LEARN_RULES', ...(overrides.memory || {}) },
      features: { stickers: false },
      stickers: { collectEnabled: false },
      reply: { groupMode: 'adaptive' },
      behavior: { extraInstructions: '' },
    }),
  };
  return createPromptComposer({
    settings,
    personaStore: { read: () => ({ exists: true, text: 'PERSONA_ONLY_VOICE' }) },
    memoryStore: { hotText: () => '' },
    stickerStore: null,
    logger: { warn() {} },
  });
}

test('prompt 组装：persona 与【自我改进】是独立段落，顺序固定', () => {
  const text = makeComposer().compose({ scope: 'group' });
  assert.ok(text.startsWith('PERSONA_ONLY_VOICE'));
  const selfAt = text.indexOf('【自我改进】\nCUSTOM_LEARN_RULES');
  assert.ok(selfAt > 0, '自我改进段应存在且带标题');
  assert.ok(text.indexOf('PERSONA_ONLY_VOICE') < selfAt, 'persona 在前');
  // persona 段落本身不包含学习规则
  const personaPart = text.slice(0, selfAt);
  assert.doesNotMatch(personaPart, /memory_save|自我改进/);
});

test('prompt 组装：自我改进提示词留空时只有记忆数据、不伪造规则', () => {
  const composer = makeComposer({ memory: { selfImprovePrompt: '', injectMaxChars: 100 } });
  const text = composer.compose({ scope: 'group' });
  assert.doesNotMatch(text, /【自我改进】/);
});


test('prompt 组装：口头禅是独立【口头禅】段，禁用后不注入', () => {
  const base = {
    persona: { mode: 'replace', groupExtraPrompt: '', directExtraPrompt: '', path: '/x/persona.md' },
    memory: { enabled: false, injectMaxChars: 0, selfImprovePrompt: '' },
    features: { stickers: false },
    stickers: { collectEnabled: false },
    reply: { groupMode: 'adaptive' },
    behavior: { extraInstructions: '' },
  };
  const make = (phrases) => createPromptComposer({
    settings: { get: () => ({ ...base, phrases }) },
    personaStore: { read: () => ({ exists: true, text: 'PERSONA_ONLY' }) },
    memoryStore: { hotText: () => '' },
    stickerStore: null,
    logger: { warn() {} },
  });
  const text = make({ enabled: true, items: [{ text: '哦对了', note: '想到一件事', enabled: true }, { text: 'onp', note: '', enabled: true }, { text: '关掉的', note: '', enabled: false }] }).compose({ scope: 'group' });
  assert.ok(text.includes('【口头禅】'));
  assert.match(text, /- 哦对了（想到一件事）/);
  assert.match(text, /- onp/);
  assert.ok(!text.includes('关掉的'), '禁用条目不应注入');
  const disabled = make({ enabled: false, items: [{ text: '哦对了', note: '', enabled: true }] }).compose({ scope: 'group' });
  assert.ok(!disabled.includes('【口头禅】'));
  const empty = make({ enabled: true, items: [] }).compose({ scope: 'group' });
  assert.ok(!empty.includes('【口头禅】'));
});
