import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPromptComposer, PROMPT_SECTIONS, PROMPT_VARIABLES, toolsGuideFor } from '../lib/host/prompt.js';
import { createBotHost, sessionIdFor, botCwdOf } from '../lib/host/agent.js';
import { apply } from '../lib/index.js';

/** 假的 systemPrompt 服务：记录注册内容，模拟 dsh 的渲染规则。 */
function fakeAgentScope() {
  const sections = [];
  const variables = new Map();
  let suppressCount = 0;
  let onCalls = 0;
  const service = {
    getSectionOrder: () => 0,
    section(section) { sections.push(section); return () => {}; },
    variable(name, provider) { variables.set(name, provider); return () => {}; },
    suppressRuntimeContext() { suppressCount += 1; return () => {}; },
  };
  const agentCtx = {
    systemPrompt: service,
    tools: {
      view: () => ({
        visible: new Map([['read', { name: 'read', description: '读文件' }], ['qqbot_send_file', { name: 'qqbot_send_file', description: '发文件' }]]),
        knownNames: new Set(['read']),
        restrictableNames: new Set(['read']),
      }),
      restrict() { return () => {}; },
    },
    get(name) { return name === 'systemPrompt' ? service : undefined; },
    on() { onCalls += 1; },
  };
  return {
    agentCtx, sections, variables, get suppressCount() { return suppressCount; }, get onCalls() { return onCalls; },
  };
}

/** 模拟 dsh renderPrompt：替换变量、丢掉空段、空行连接。 */
function render(fake, settings = {}) {
  return fake.sections
    .map((section) => section.text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, name) => {
      const provider = fake.variables.get(name);
      const value = provider ? provider({ scope: {} }) : '';
      return typeof value === 'string' ? value : '';
    }))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

test('prompt 契约：只注册 qqbot:* 段 + 变量占位，不挂 assemble 事件', () => {
  const fake = fakeAgentScope();
  const composer = createPromptComposer({ logger: { warn() {} } });
  const state = {
    personaText: () => '你是小助手', memoryText: () => '', knowledgeText: () => '',
    settings: () => ({}), toolsGuide: (agent) => toolsGuideFor(fake.agentCtx, agent),
  };
  const ok = composer.mount(fake.agentCtx, { id: 'agent-1' }, state);
  assert.equal(ok, true);
  assert.equal(fake.sections.length, 4);
  for (const section of fake.sections) {
    assert.match(section.name, /^qqbot:/, '段名必须以 qqbot: 开头，避免 shadow 宿主段');
    assert.match(section.text, /^\{\{qqbot_[a-z]+\}\}$/, '段文本必须是变量占位，不能写死');
  }
  assert.deepEqual(fake.sections.map((s) => s.name), [
    PROMPT_SECTIONS.persona, PROMPT_SECTIONS.guide, PROMPT_SECTIONS.memory, PROMPT_SECTIONS.knowledge,
  ]);
  assert.equal(fake.variables.size, 4);
  assert.equal(fake.onCalls, 0, '禁止注册 system-prompt/assemble 监听');
  // 渲染：人设出现、空段被丢弃
  const text = render(fake);
  assert.match(text, /你是小助手/);
  assert.ok(!text.includes('{{'), '不能有未替换变量');
  assert.equal(text.split('\n\n').length, 2, '人设 + 工具指引两段（记忆/知识为空被丢弃）');
});

test('prompt 状态热更新：变量每次 assembly 重新求值', () => {
  const fake = fakeAgentScope();
  const composer = createPromptComposer({ logger: { warn() {} } });
  let persona = 'v1 人设';
  const state = { personaText: () => persona, memoryText: () => '', knowledgeText: () => '', settings: () => ({}) };
  composer.mount(fake.agentCtx, { id: 'a' }, state);
  assert.match(render(fake), /v1 人设/);
  persona = 'v2 人设';
  assert.match(render(fake), /v2 人设/, '冷会话/热会话看到同一套注册，改设置立即生效');
});

test('suppressRuntimeContext 由设置控制', () => {
  const fake = fakeAgentScope();
  const composer = createPromptComposer({ logger: { warn() {} } });
  composer.mount(fake.agentCtx, { id: 'a' }, { personaText: () => 'x', settings: () => ({ persona: { suppressRuntimeContext: true } }) });
  assert.equal(fake.suppressCount, 1);
  const fake2 = fakeAgentScope();
  composer.mount(fake2.agentCtx, { id: 'a' }, { personaText: () => 'x', settings: () => ({ persona: { suppressRuntimeContext: false } }) });
  assert.equal(fake2.suppressCount, 0);
});

test('工具指引来自实时可见工具', () => {
  const fake = fakeAgentScope();
  const guide = toolsGuideFor(fake.agentCtx, { id: 'a' });
  assert.match(guide, /qqbot_send_file/);
  assert.match(guide, /read/);
});

test('bot host：registerTransport/startAll 无传输层时降级', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-host-'));
  const db = (await import('../lib/core/db.js')).openDb(path.join(tmp, 'buddy.db'));
  const { createConfigStore } = await import('../lib/core/config/store.js');
  const config = createConfigStore({ db, workspaceRoot: tmp });
  const bot = config.createBot({ name: '机器人A' });
  const runtime = {
    config, db, paths: { workspaceRoot: tmp },
    events: { emit() {} },
  };
  const host = await createBotHost({ ctx: {}, runtime, config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const results = await host.startAll();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false, '没有传输层时应返回 false 而不是抛错');
  assert.equal(host.runtimeOf(bot.id).cwd, botCwdOf(tmp, bot.id));
  assert.equal(sessionIdFor(bot.id, 'group:1').toString(), sessionIdFor(bot.id, 'group:1').toString());
  await host.disposeAll();
});

test('插件 apply 冒烟：建库/配置/宿主（控制台关闭）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-apply-'));
  const disposers = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  };
  const applied = await apply(ctx, {
    dataDir: tmp, workspaceRoot: tmp, autoStart: false, console: { enabled: false }, debug: false,
  });
  assert.equal(applied, undefined, 'apply 不能返回值（cordis effect 契约）');
  const runtime = (await import('../lib/index.js')).getRuntime();
  assert.ok(fs.existsSync(path.join(tmp, 'buddy.db')));
  const bot = runtime.config.createBot({ name: '测试号' });
  assert.equal(runtime.config.getSettings(bot.id).reply.mode, 'adaptive');
  assert.ok(fs.existsSync(path.join(tmp, 'bots', bot.id)));
  runtime.db.close();
});