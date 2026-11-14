import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPromptComposer, PROMPT_SECTIONS, PROMPT_VARIABLES, PROMPT_ORDERS,
  PROMPT_CONTEXTS, PROMPT_CONTEXT_ORDERS,
  HOST_SECTION_SHADOWS, toolsGuideFor, formatNow,
} from '../lib/host/prompt.js';
import { createBotHost, sessionIdFor, botCwdOf } from '../lib/host/agent.js';
import { apply } from '../lib/index.js';

/** 假的 systemPrompt 服务：记录注册内容，模拟 dsh 的渲染规则。 */
function fakeAgentScope() {
  const sections = [];
  const contexts = [];
  const variables = new Map();
  let suppressCount = 0;
  let onCalls = 0;
  let disposed = 0;
  const service = {
    getSectionOrder: () => 0,
    section(section) {
      sections.push(section);
      return () => {
        disposed += 1;
        const index = sections.indexOf(section);
        if (index >= 0) sections.splice(index, 1);
      };
    },
    context(entry) {
      contexts.push(entry);
      return () => {
        disposed += 1;
        const index = contexts.indexOf(entry);
        if (index >= 0) contexts.splice(index, 1);
      };
    },
    variable(name, provider) {
      variables.set(name, provider);
      return () => {
        disposed += 1;
        if (variables.get(name) === provider) variables.delete(name);
      };
    },
    suppressRuntimeContext() {
      suppressCount += 1;
      return () => { disposed += 1; suppressCount -= 1; };
    },
  };
  const agentCtx = {
    systemPrompt: service,
    tools: {
      view: () => ({
        visible: new Map([
          ['read', { name: 'read', description: '读文件' }],
          ['qqbot_send_file', { name: 'qqbot_send_file', description: '发文件' }],
          ['generate_image', { name: 'generate_image', description: '生图' }],
        ]),
        knownNames: new Set(['read', 'qqbot_send_file', 'generate_image']),
        restrictableNames: new Set(['read', 'generate_image']),
      }),
      restrict() { return () => {}; },
    },
    get(name) { return name === 'systemPrompt' ? service : undefined; },
    on() { onCalls += 1; },
  };
  return {
    agentCtx, sections, contexts, variables, get suppressCount() { return suppressCount; },
    get onCalls() { return onCalls; }, get disposed() { return disposed; },
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

function stateOf(overrides = {}) {
  return {
    personaText: () => '你是小助手',
    memoryText: () => '',
    knowledgeText: () => '',
    membersText: () => '',
    settings: () => ({}),
    toolsGuide: () => '【工具】发文件用 qqbot_send_file',
    ...overrides,
  };
}

test('prompt 契约：人设占官方槽位 + 遮蔽其它 surface 段 + 变量占位，不挂 assemble 事件', () => {
  const fake = fakeAgentScope();
  const composer = createPromptComposer({ logger: { warn() {} } });
  const agent = { id: 'agent-1' };
  const ok = composer.mount(fake.agentCtx, agent, stateOf());
  assert.equal(ok, true);

  const byName = new Map(fake.sections.map((section) => [section.name, section]));
  // 人设必须占官方槽位（替换宿主默认人设，而不是旁开一路）
  assert.equal(PROMPT_SECTIONS.persona, 'deployment:persona-prefix');
  const persona = byName.get('deployment:persona-prefix');
  assert.ok(persona, '必须注册官方人设槽位');
  assert.equal(persona.order, 0);
  assert.equal(persona.text, '{{' + PROMPT_VARIABLES.persona + '}}');

  // 自有段仍用 qqbot: 前缀（不抢宿主名字），但系统提示词里只留静态段
  for (const name of ['qqbot:guide']) {
    assert.ok(byName.has(name), '缺少段: ' + name);
  }
  for (const name of ['qqbot:memory', 'qqbot:knowledge', 'qqbot:members']) {
    assert.ok(!byName.has(name), name + ' 是动态内容，必须走运行时上下文，不能进系统提示词');
  }
  assert.equal(byName.get('deployment:persona-suffix').order, PROMPT_ORDERS.suffix);

  // 动态内容：user-role 快照，required=true（suppressRuntimeContext 打开时仍要注入）
  const byContext = new Map(fake.contexts.map((entry) => [entry.name, entry]));
  for (const name of ['qqbot:memory', 'qqbot:knowledge', 'qqbot:members', 'qqbot:env']) {
    const entry = byContext.get(name);
    assert.ok(entry, '缺少运行时上下文: ' + name);
    assert.equal(entry.required, true, name + ' 必须 required（否则被 suppress 吞掉）');
    assert.equal(typeof entry.text, 'function', name + ' 文本要每轮求值');
  }
  assert.ok(PROMPT_CONTEXT_ORDERS.memory < PROMPT_CONTEXT_ORDERS.env, '上下文顺序稳定');

  // 遮蔽：官方身份 / Web / 交付段全部空文本
  for (const shadow of HOST_SECTION_SHADOWS) {
    const section = byName.get(shadow.name);
    assert.ok(section, '缺少遮蔽段: ' + shadow.name);
    assert.equal(section.text, '', '遮蔽段必须是空文本: ' + shadow.name);
  }
  // 工具散文段不遮蔽：它们由 agent scope 挂载的插件注册，同名会撞车（真机探针实测）
  assert.ok(!byName.has('tool:read'), 'tool:* 段不能在我们这一层遮蔽');
  assert.ok(!byName.has('tool:bash'));
  assert.ok(!byName.has('context:file-reference'), 'file-reference 由宿主在 agent scope 注册，不能遮蔽');

  assert.equal(fake.onCalls, 0, '禁止注册 system-prompt/assemble 监听');
  assert.equal(fake.suppressCount, 1, '默认隐藏宿主运行时上下文');

  const text = render(fake);
  assert.match(text, /你是小助手/);
  assert.ok(!text.includes('{{'), '不能有未替换变量');
  assert.match(text, /你在 QQ 里和用户对话/, '后缀要声明 QQ 环境');
  assert.doesNotMatch(text, /现在是 \d{4}-\d{2}-\d{2}/, '时间属于动态内容，不能留在系统提示词里（否则每分钟打穿缓存）');

  // 时间进运行时上下文
  const env = fake.contexts.find((entry) => entry.name === 'qqbot:env');
  assert.match(env.text({ scope: {} }), /现在是 \d{4}-\d{2}-\d{2}/);
});

test('prompt 顺序：静态段固定，动态内容走 context（KV cache 友好）', () => {
  const orders = PROMPT_ORDERS;
  assert.ok(orders.persona < orders.guide, '人设 → 工具指引');
  assert.ok(orders.guide < orders.suffix, '工具指引 → 环境后缀（官方 10200）');
  assert.ok(orders.guide > 5000, '工具指引排在 tools:sdk(5000) 之后');
  const ctx = PROMPT_CONTEXT_ORDERS;
  assert.ok(ctx.memory < ctx.knowledge && ctx.knowledge < ctx.members && ctx.members < ctx.env,
    '上下文顺序稳定（记忆 → 知识 → 群友 → 时间）');
  assert.ok(ctx.memory > 210, '排在宿主 context（100~210）之后，避免与宿主抢占');
});

test('prompt 稳定性：同一配置下连续两次渲染逐字节相同（缓存命中的前提）', () => {
  const fake = fakeAgentScope();
  const composer = createPromptComposer({ logger: { warn() {} } });
  const agent = { id: 'a' };
  const snapshot = () => {
    composer.mount(fake.agentCtx, agent, stateOf());
    return {
      text: render(fake),
      contexts: fake.contexts.map((entry) => entry.name + ':' + entry.order).join(','),
    };
  };
  const first = snapshot();
  const second = snapshot();
  assert.equal(first.text, second.text, '系统提示词必须逐字节稳定');
  assert.equal(first.contexts, second.contexts, '上下文注册集合与顺序必须稳定');
});

test('prompt 幂等：同一 agent 重复 mount 会先释放上一次注册', () => {
  const fake = fakeAgentScope();
  const composer = createPromptComposer({ logger: { warn() {} } });
  const agent = { id: 'a' };
  composer.mount(fake.agentCtx, agent, stateOf());
  const first = fake.sections.length;
  assert.ok(first > 0);
  const disposedAfterFirst = fake.disposed;
  composer.mount(fake.agentCtx, agent, stateOf());
  assert.equal(fake.sections.length, first, '重复 mount 不应叠加注册');
  assert.ok(fake.disposed > disposedAfterFirst, '重复 mount 应先释放上一次的注册');
});

test('suppressRuntimeContext 由设置控制', () => {
  const fake = fakeAgentScope();
  const composer = createPromptComposer({ logger: { warn() {} } });
  composer.mount(fake.agentCtx, { id: 'a' }, stateOf({ settings: () => ({ persona: { suppressRuntimeContext: true } }) }));
  assert.equal(fake.suppressCount, 1);
  const fake2 = fakeAgentScope();
  composer.mount(fake2.agentCtx, { id: 'a' }, stateOf({ settings: () => ({ persona: { suppressRuntimeContext: false } }) }));
  assert.equal(fake2.suppressCount, 0);
});

test('工具指引：只列此刻可用的工具，被动能力按组提示 qqbot_enable', () => {
  const fake = fakeAgentScope();
  const guide = toolsGuideFor(fake.agentCtx, { id: 'a' }, {
    settings: { tools: { capabilities: { workspace: true, imagegen: true } } },
    isActive: (name) => name !== 'read' && name !== 'generate_image',
  });
  assert.match(guide, /qqbot_send_file/);
  // 2026-11-14：未装载的工具只出现在索引段（只有名字，不注入 schema），不进可用清单
  const [loadedPart, indexPart = ''] = guide.split('【按需能力】');
  assert.doesNotMatch(loadedPart, /\bread\b/, '被动且未激活的工具不该出现在可用清单');
  assert.match(indexPart, /\bread\b/, '索引段要列出可按需装载的工具名');
  assert.match(guide, /【按需能力】/);
  assert.match(guide, /workspace/);
  assert.match(guide, /imagegen/);
  assert.match(guide, /qqbot_enable/);
});

test('工具指引：能力关闭的被动组不提示', () => {
  const fake = fakeAgentScope();
  const guide = toolsGuideFor(fake.agentCtx, { id: 'a' }, {
    settings: { tools: { capabilities: { imagegen: false } } },
    isActive: () => true,
  });
  assert.doesNotMatch(guide, /imagegen/);
});

test('formatNow 输出 YYYY-MM-DD HH:mm', () => {
  assert.match(formatNow(new Date(2026, 10, 12, 9, 5)), /^2026-11-12 09:05$/);
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
