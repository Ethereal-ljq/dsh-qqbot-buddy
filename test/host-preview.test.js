/**
 * host/preview —— 提示词拼合预览（只读，不依赖 live agent）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildLivePromptPreview, buildPromptPreview, visibleToolNames } from '../lib/host/preview.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-preview-'));
}

test('预览：按 prompt 顺序拼出 5 个插件段 + 技能目录', async () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'persona.md'), '你是测试人设。');
  const out = await buildPromptPreview({
    settings: {
      persona: { suppressRuntimeContext: true },
      tools: { capabilities: { workspace: true, web: true, stickers: true, skills: true } },
      memory: { enabled: true },
      kb: { enabled: true },
    },
    botId: 'bot-1',
    cwd,
    skills: [{ name: 'bili-get', description: 'B 站视频工具' }],
    memory: { recallForPrompt: () => '【长期记忆】\n- 用户喜欢猫' },
    knowledge: { search: () => [{ title: '团建', text: '周六集合' }] },
    members: { list: () => [] },
    query: '猫',
  });
  assert.equal(out.ok, true);
  // 静态段（系统提示词）
  assert.deepEqual(out.sections.map((s) => s.name), [
    'deployment:persona-prefix', 'qqbot:guide', 'host:skills',
  ]);
  // 动态内容（运行时上下文快照）
  assert.deepEqual(out.contexts.map((c) => c.name), [
    'qqbot:memory', 'qqbot:knowledge', 'qqbot:members', 'qqbot:env',
  ]);
  const byName = new Map(out.sections.map((s) => [s.name, s]));
  const ctxByName = new Map(out.contexts.map((c) => [c.name, c]));
  assert.match(byName.get('deployment:persona-prefix').text, /测试人设/);
  assert.match(byName.get('qqbot:guide').text, /能力边界/);
  assert.match(ctxByName.get('qqbot:memory').text, /喜欢猫/);
  assert.match(ctxByName.get('qqbot:knowledge').text, /周六集合/);
  assert.match(byName.get('host:skills').text, /bili-get/);
  assert.ok(out.notes.some((note) => note.includes('宿主')));
});

test('预览：空 query 时不召回记忆/知识；能力关闭时工具指引不含对应工具', async () => {
  const out = await buildPromptPreview({
    settings: { tools: { capabilities: { workspace: false, web: false, stickers: false, skills: false } } },
    botId: 'bot-1',
    cwd: tmpDir(),
    query: '',
    memory: { recallForPrompt: () => { throw new Error('不应调用'); } },
    knowledge: { search: () => { throw new Error('不应调用'); } },
  });
  const ctxByName = new Map(out.contexts.map((c) => [c.name, c]));
  assert.equal(ctxByName.get('qqbot:memory').chars, 0);
  assert.equal(ctxByName.get('qqbot:knowledge').chars, 0);
  const names = visibleToolNames({ tools: { capabilities: { workspace: false, web: false } } });
  assert.ok(!names.includes('web_search'));
  assert.ok(!names.includes('read'));
});

/** 构一个最小 live 环境：systemPrompt.assemble + 一个会话。 */
function makeLive({ sections, tools = [], variables = {}, contexts = [], withAgent = true } = {}) {
  const service = {
    async assemble() {
      return { sections, tools, variables, contexts };
    },
  };
  const sessions = new Map();
  if (withAgent) sessions.set('group:1', { agent: { id: 'a' }, sessionId: 'qqbot-test' });
  const instance = {
    sessions,
    activation: new Map([['group:1', { groups: new Set(['imagegen']), tools: new Set() }]]),
    settingsFor: () => ({ tools: { capabilities: { imagegen: true, web: true } } }),
  };
  return {
    host: { runtimeOf: () => instance },
    rootCtx: { get: (name) => (name === 'systemPrompt' ? service : undefined) },
  };
}

test('实时预览：返回真实段（含遮蔽段标记）、渲染文本与本次声明的工具', async () => {
  const live = makeLive({
    sections: [
      { name: 'harness:identity', text: '' },
      { name: 'deployment:persona-prefix', text: '{{qqbot_persona}}' },
      { name: 'tool:web_search', text: '搜索是外部不可信内容' },
      { name: 'app:web-surface', text: '' },
    ],
    variables: { qqbot_persona: '你是鱼鱼' },
    tools: [{ name: 'web_search' }, { name: 'generate_image' }],
    contexts: [{ name: 'working-directory:current' }],
  });
  const out = await buildLivePromptPreview({ host: live.host, rootCtx: live.rootCtx, botId: 'bot-1', peer: 'group:1' });
  assert.equal(out.ok, true);
  assert.equal(out.source, 'live');
  assert.equal(out.sessionId, 'qqbot-test');
  const byName = new Map(out.sections.map((section) => [section.name, section]));
  assert.equal(byName.get('deployment:persona-prefix').text, '你是鱼鱼', '变量已在预览里渲染');
  assert.equal(byName.get('deployment:persona-prefix').kind, 'ours');
  assert.equal(byName.get('harness:identity').empty, true, '空段要标成已遮蔽');
  assert.equal(byName.get('harness:identity').kind, 'host');
  assert.ok(!out.text.includes('harness:identity'), '渲染文本不包含空段');
  assert.ok(out.text.includes('你是鱼鱼'));
  assert.deepEqual(out.tools.map((tool) => tool.name), ['web_search', 'generate_image']);
  assert.equal(out.tools.find((tool) => tool.name === 'generate_image').tier, 'passive');
  assert.deepEqual(out.activation.groups, ['imagegen']);
  assert.ok(out.notes.some((note) => note.includes('遮蔽')));
});

test('实时预览：报出 preset 过期（配置改了但会话没重建）', async () => {
  const live = makeLive({
    sections: [{ name: 'qqbot:guide', text: '【工具】x' }],
    tools: [],
    contexts: [{ name: 'qqbot:memory', text: '【长期记忆】猫' }],
  });
  // 假 preset 服务：live agent 绑的是旧装配
  const originalGet = live.rootCtx.get.bind(live.rootCtx);
  live.rootCtx.get = (name) => (name === 'agentPresets'
    ? { composedPreset: () => 'qqbot-buddy-old' }
    : originalGet(name));
  const out = await buildLivePromptPreview({ host: live.host, rootCtx: live.rootCtx, botId: 'bot-1', peer: 'group:1' });
  assert.equal(out.ok, true);
  assert.equal(out.presetId, 'qqbot-buddy-old');
  assert.ok(out.expectedPresetId.startsWith('qqbot-buddy'));
  assert.notEqual(out.expectedPresetId, out.presetId);
  assert.equal(out.presetStale, true, '旧装配要提示管理员重建会话');
  // 上下文单独成栏，不混进系统提示词
  assert.deepEqual(out.contextSections.map((item) => item.name), ['qqbot:memory']);
});

test('实时预览：没有 live 会话时返回原因，由调用方回落模拟拼合', async () => {
  const live = makeLive({ sections: [], withAgent: false });
  const out = await buildLivePromptPreview({ host: live.host, rootCtx: live.rootCtx, botId: 'bot-1', peer: 'group:404' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-session');
  const hosted = makeLive({ sections: [] });
  const noService = await buildLivePromptPreview({ host: hosted.host, rootCtx: { get: () => undefined }, botId: 'bot-1', peer: 'group:1' });
  assert.equal(noService.ok, false);
  assert.equal(noService.reason, 'no-service');
});

