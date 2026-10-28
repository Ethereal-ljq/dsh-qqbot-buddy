/**
 * prompt 单测（DESIGN 质量项 5）：
 * replace/append 挂载差异、记忆块注入与截断、行为指引、scope（群聊/私聊）差异、
 * 人设缺失兜底、失败降级不抛错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptComposer } from '../lib/prompt.js';
import { FALLBACK_PERSONA } from '../lib/persona-store.js';
import { resolveDefaults } from '../lib/settings-store.js';
import { createFakeLogger } from './helpers/fake-ctx.js';

const CWD = '/tmp/qqb-prompt-cwd';

/** 测试用深合并（只处理普通对象）。 */
function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(base?.[key], value)
      : value;
  }
  return out;
}

/** 构造最小 settings fake（get 返回深拷贝，便于模拟"设置热更新"）。 */
function makeSettings(overrides = {}) {
  const state = deepMerge(resolveDefaults({ cwd: CWD }), overrides);
  return { state, get: () => JSON.parse(JSON.stringify(state)) };
}

/** 构造最小 personaStore fake。 */
function makePersonaStore({ text = '你是一只猫娘。', exists = true } = {}) {
  const store = {
    value: { text, exists },
    read() {
      const current = this.value;
      return {
        text: current.exists ? current.text : '',
        path: CWD + '/persona.md',
        bytes: Buffer.byteLength(current.exists ? current.text : '', 'utf8'),
        lines: (current.exists ? current.text : '').split('\n').length,
        exists: current.exists,
        mtime: current.exists ? 1 : 0,
      };
    },
  };
  return store;
}

/** 构造最小 memoryStore fake（只有 prompt 用到的 hotText）。 */
function makeMemoryStore(hot = '') {
  const calls = [];
  return {
    calls,
    hotText(maxChars) {
      calls.push(maxChars);
      if (typeof hot === 'function') return hot(maxChars);
      return hot;
    },
  };
}

function makeComposer({ settings, personaStore, memoryStore, logger } = {}) {
  return createPromptComposer({
    settings: settings ?? makeSettings(),
    personaStore: personaStore ?? makePersonaStore(),
    memoryStore: memoryStore ?? makeMemoryStore(''),
    logger: logger ?? createFakeLogger(),
  });
}

/** 构造带 systemPrompt 服务的 agentCtx，记录 section/suppress/effect。 */
function makeAgentCtx({ order = 42, orderThrows = false, sectionThrows = false } = {}) {
  const sections = [];
  const suppressCounter = { count: 0 };
  const effects = [];
  const agentCtx = {
    sections,
    get suppressCount() {
      return suppressCounter.count;
    },
    effects,
    systemPrompt: {
      section(def) {
        if (sectionThrows) throw new Error('section 注册失败');
        sections.push(def);
        return () => { def.disposed = true; };
      },
      suppressRuntimeContext() {
        suppressCounter.count += 1;
        return () => {};
      },
      getSectionOrder(name) {
        if (orderThrows) throw new Error('拿不到 section order');
        assert.equal(name, 'DEPLOYMENT_PERSONA_PREFIX');
        return order;
      },
    },
    effect(callback, label) {
      const dispose = callback();
      effects.push({ label, dispose });
    },
    dispose() {
      for (const effect of effects.reverse()) {
        if (typeof effect.dispose === 'function') effect.dispose();
      }
    },
  };
  return agentCtx;
}

test('compose：包含人设、工具约定与额外行为指令', () => {
  const settings = makeSettings({ behavior: { extraInstructions: '回答尽量简短。' } });
  const composer = makeComposer({ settings });
  const text = composer.compose({ scope: 'direct' });
  assert.ok(text.startsWith('你是一只猫娘。'), '人设应在最前面');
  assert.ok(text.includes('【工具使用约定】'), '应包含固定行为/工具指引');
  assert.ok(text.includes('memory_save'));
  assert.ok(text.includes('回答尽量简短。'), '应追加 behavior.extraInstructions');
});

test('compose：replace 与 append 都输出人设（差异在 mount 的 complete 标记）', () => {
  for (const mode of ['replace', 'append']) {
    const settings = makeSettings({ persona: { mode } });
    const composer = makeComposer({ settings });
    assert.ok(composer.compose({ scope: 'direct' }).includes('你是一只猫娘。'), mode + ' 模式应包含人设');
  }
});

test('人设缺失或纯空白：使用中性兜底文案', () => {
  const missing = makeComposer({ personaStore: makePersonaStore({ exists: false }) });
  assert.ok(missing.compose({ scope: 'direct' }).includes(FALLBACK_PERSONA));

  const blank = makeComposer({ personaStore: makePersonaStore({ text: '   \n\t ' }) });
  assert.ok(blank.compose({ scope: 'direct' }).includes(FALLBACK_PERSONA));
});

test('记忆块：有热记忆时注入固定标题与条目，且按 injectMaxChars 调用 hotText', () => {
  const memoryStore = makeMemoryStore('- [2026-10-25] 用户喜欢猫');
  const settings = makeSettings({ memory: { injectMaxChars: 1234 } });
  const composer = makeComposer({ settings, memoryStore });
  const text = composer.compose({ scope: 'group' });
  assert.ok(text.includes('【长期记忆】'), '应包含记忆块标题');
  assert.ok(text.includes('- [2026-10-25] 用户喜欢猫'));
  assert.deepEqual(memoryStore.calls, [1234], 'hotText 应收到 injectMaxChars');
});

test('记忆块：无记忆/关闭/上限为 0 时整块省略', () => {
  const cases = [
    { name: 'hotText 返回空', settings: makeSettings(), hot: '' },
    { name: 'memory.enabled=false', settings: makeSettings({ memory: { enabled: false } }), hot: '- 记忆' },
    { name: 'injectMaxChars=0', settings: makeSettings({ memory: { injectMaxChars: 0 } }), hot: '- 记忆' },
  ];
  for (const item of cases) {
    const composer = makeComposer({ settings: item.settings, memoryStore: makeMemoryStore(item.hot) });
    const text = composer.compose({ scope: 'group' });
    assert.equal(text.includes('【长期记忆】'), false, item.name + ' 时不应出现记忆块');
  }
});

test('记忆块：超长时保留尾部（最新）内容', () => {
  const hot = 'A'.repeat(80) + '尾部最新记忆';
  const settings = makeSettings({ memory: { injectMaxChars: 10 } });
  const composer = makeComposer({ settings, memoryStore: makeMemoryStore(hot) });
  const text = composer.compose({ scope: 'group' });
  assert.ok(text.includes('尾部最新记忆'), '截断后应保留尾部最新内容');
  assert.equal(text.includes('A'.repeat(10)), false, '不应注入被截掉的前缀');
});

test('记忆读取异常：捕获并降级（不抛错、不打挂 prompt）', () => {
  const logger = createFakeLogger();
  const memoryStore = {
    hotText() {
      throw new Error('磁盘炸了');
    },
  };
  const composer = makeComposer({ memoryStore, logger });
  let text;
  assert.doesNotThrow(() => {
    text = composer.compose({ scope: 'group' });
  });
  assert.ok(text.includes('你是一只猫娘。'));
  assert.equal(text.includes('【长期记忆】'), false);
  assert.ok(logger.byLevel('warn').some((args) => String(args[0]).includes('长期记忆')), '应有 warn 日志');
});

test('scope 差异：群聊/私聊使用不同额外指令，群聊节奏提示只在需要时出现', () => {
  const settings = makeSettings({
    reply: { groupMode: 'count' },
    persona: { groupExtraPrompt: '群聊额外要求', directExtraPrompt: '私聊额外要求' },
  });
  const composer = makeComposer({ settings });
  const group = composer.compose({ scope: 'group' });
  assert.ok(group.includes('群聊额外要求'));
  assert.equal(group.includes('私聊额外要求'), false);
  assert.ok(group.includes('【群聊节奏】'));

  const direct = composer.compose({ scope: 'direct' });
  assert.ok(direct.includes('私聊额外要求'));
  assert.equal(direct.includes('群聊额外要求'), false);
  assert.equal(direct.includes('【群聊节奏】'), false, '私聊不应出现群聊节奏提示');
});

test('scope 差异：groupMode=all 时不出现群聊节奏提示', () => {
  const settings = makeSettings({ reply: { groupMode: 'all' } });
  const composer = makeComposer({ settings });
  assert.equal(composer.compose({ scope: 'group' }).includes('【群聊节奏】'), false);
});

test('mount replace：complete section、order=0、interpolate=false、压制运行上下文', () => {
  const agentCtx = makeAgentCtx();
  const composer = makeComposer();
  composer.mount(agentCtx, { scope: 'group' });
  assert.equal(agentCtx.sections.length, 1);
  const section = agentCtx.sections[0];
  assert.equal(section.name, 'qqbot-buddy:persona');
  assert.equal(section.complete, true, 'replace 模式必须是 complete section');
  assert.equal(section.order, 0);
  assert.equal(section.interpolate, false);
  assert.equal(typeof section.text, 'function');
  assert.ok(section.text().includes('你是一只猫娘。'));
  assert.equal(agentCtx.suppressCount, 1, 'suppressRuntimeContext=true 时应调用');
});

test('mount replace：suppressRuntimeContext=false 时不压制宿主上下文', () => {
  const agentCtx = makeAgentCtx();
  const settings = makeSettings({ persona: { suppressRuntimeContext: false } });
  makeComposer({ settings }).mount(agentCtx, { scope: 'group' });
  assert.equal(agentCtx.suppressCount, 0);
});

test('mount append：普通 section、order 取宿主 DEPLOYMENT_PERSONA_PREFIX', () => {
  const agentCtx = makeAgentCtx({ order: 42 });
  const settings = makeSettings({ persona: { mode: 'append' } });
  makeComposer({ settings }).mount(agentCtx, { scope: 'group' });
  const section = agentCtx.sections[0];
  assert.equal(section.complete, false, 'append 模式不能是 complete section');
  assert.equal(section.order, 42);
  assert.equal(agentCtx.suppressCount, 0, 'append 模式不压制运行时上下文');
});

test('mount append：getSectionOrder 抛错时 order 回退 0', () => {
  const agentCtx = makeAgentCtx({ orderThrows: true });
  const settings = makeSettings({ persona: { mode: 'append' } });
  assert.doesNotThrow(() => makeComposer({ settings }).mount(agentCtx, { scope: 'group' }));
  assert.equal(agentCtx.sections[0].order, 0);
});

test('mount：section.text 惰性求值，改人设/设置后下一轮立即生效', () => {
  const personaStore = makePersonaStore({ text: '旧人设' });
  const settings = makeSettings();
  const agentCtx = makeAgentCtx();
  makeComposer({ settings, personaStore }).mount(agentCtx, { scope: 'direct' });
  const section = agentCtx.sections[0];
  assert.ok(section.text().includes('旧人设'));

  personaStore.value = { text: '新人设', exists: true };
  settings.state.behavior.extraInstructions = '新行为要求';
  const fresh = section.text();
  assert.ok(fresh.includes('新人设'));
  assert.ok(fresh.includes('新行为要求'));
});

test('mount：systemPrompt 服务缺失时只告警不抛错', () => {
  const logger = createFakeLogger();
  const composer = makeComposer({ logger });
  const agentCtx = { effect() { throw new Error('不应注册 effect'); } };
  let dispose;
  assert.doesNotThrow(() => {
    dispose = composer.mount(agentCtx, { scope: 'group' });
  });
  assert.equal(typeof dispose, 'function');
  assert.ok(logger.byLevel('warn').some((args) => String(args[0]).includes('systemPrompt')));
});

test('mount：section 注册失败被捕获，只记 warn', () => {
  const logger = createFakeLogger();
  const agentCtx = makeAgentCtx({ sectionThrows: true });
  assert.doesNotThrow(() => makeComposer({ logger }).mount(agentCtx, { scope: 'group' }));
  assert.ok(logger.byLevel('warn').length >= 1);
});

test('mount：ctx 销毁时释放 section/suppress 注册', () => {
  const agentCtx = makeAgentCtx();
  makeComposer().mount(agentCtx, { scope: 'group' });
  const section = agentCtx.sections[0];
  agentCtx.dispose();
  assert.equal(section.disposed, true, 'dispose 时应调用 section 的 disposer');
});