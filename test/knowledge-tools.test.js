/**
 * knowledge-tools / member-tools 单测：工具定义、输出 schema、execute、resolveBot 路由与兜底。
 * 使用最小的 ctx / tools 服务替身（不引入 cordis 依赖）；store 全部落在临时目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createKnowledgeStore } from '../lib/knowledge/store.js';
import { createMemberStore } from '../lib/members/store.js';
import { registerKnowledgeTools, KNOWLEDGE_TOOL_NAMES } from '../lib/tools/knowledge-tools.js';
import { registerMemberTools, MEMBER_TOOL_NAMES } from '../lib/tools/member-tools.js';
import { createFakeCtx } from './helpers/fake-ctx.js';

const QUIET_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

function makeBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-knowledge-tools-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

/** 一个「机器人」= 一套 knowledge + members store（独立目录） */
function makeBot(t, label = 'bot') {
  const base = makeBase(t);
  const dir = path.join(base, label);
  const settings = {
    get: () => ({
      knowledge: { dir: path.join(dir, 'knowledge') },
      members: { dir: path.join(dir, 'members') },
    }),
  };
  const knowledge = createKnowledgeStore({ settings, logger: QUIET_LOGGER });
  const members = createMemberStore({ settings, logger: QUIET_LOGGER });
  // t.after LIFO：先 flush 清掉延迟写定时器，再让 makeBase 注册的清理删目录
  t.after(() => {
    try { knowledge.flush(); } catch { /* 清理失败忽略 */ }
    try { members.flush(); } catch { /* 清理失败忽略 */ }
  });
  return { dir, knowledge, members };
}

/** 记录 register 的 tools 服务替身；register 对指定工具名抛错（验证单工具失败隔离） */
function captureCtx({ throwOn = '' } = {}) {
  const defs = [];
  const warnings = [];
  const tools = {
    register(definition) {
      if (throwOn !== '' && definition.name === throwOn) throw new Error('模拟注册失败');
      defs.push(definition);
      return () => {
        const index = defs.indexOf(definition);
        if (index >= 0) defs.splice(index, 1);
      };
    },
  };
  const ctx = {
    get: (name) => (name === 'tools' ? tools : undefined),
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  };
  return { ctx, defs, warnings, tools };
}

function findTool(defs, name) {
  const definition = defs.find((item) => item.name === name);
  assert.ok(definition, `未注册工具：${name}`);
  return definition;
}

function render(tool, args, value) {
  const rendered = tool.output.render(args, value);
  assert.ok(Array.isArray(rendered) && rendered.length > 0);
  for (const part of rendered) assert.equal(part.type, 'text');
  return rendered.map((part) => part.text).join('\n');
}

/** 校验返回值字段与 output.schema 完全一致（递归数组项） */
function assertSchemaShape(value, schema, label = 'value') {
  assert.equal(schema.type, 'object', `${label} schema.type`);
  assert.equal(schema.additionalProperties, false, `${label} 必须 additionalProperties:false`);
  assert.ok(Array.isArray(schema.required), `${label} 必须有 required`);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...schema.required].sort(),
    `${label} 返回字段应与 schema.required 完全一致`,
  );
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const item = value[key];
    if (item === undefined) continue;
    switch (prop.type) {
      case 'string':
        assert.equal(typeof item, 'string', `${label}.${key}`);
        break;
      case 'number':
        assert.equal(typeof item, 'number', `${label}.${key}`);
        break;
      case 'integer':
        assert.equal(Number.isInteger(item), true, `${label}.${key} 应为整数`);
        break;
      case 'boolean':
        assert.equal(typeof item, 'boolean', `${label}.${key}`);
        break;
      case 'array':
        assert.ok(Array.isArray(item), `${label}.${key} 应为数组`);
        item.forEach((entry, index) => {
          if (prop.items?.type === 'object') assertSchemaShape(entry, prop.items, `${label}.${key}[${index}]`);
          else if (prop.items?.type === 'string') assert.equal(typeof entry, 'string', `${label}.${key}[${index}]`);
        });
        break;
      case 'object':
        assert.equal(typeof item, 'object', `${label}.${key}`);
        assert.ok(item !== null);
        break;
      default:
        break;
    }
  }
}

test('注册：knowledge_* 三个 + member_* 两个，定义/schema/render 完整，dispose 可注销', (t) => {
  const bot = makeBot(t);
  const { ctx, defs } = captureCtx();
  const disposeKnowledge = registerKnowledgeTools(ctx, { knowledge: bot.knowledge, logger: QUIET_LOGGER });
  const disposeMember = registerMemberTools(ctx, { members: bot.members, logger: QUIET_LOGGER });

  assert.deepEqual(defs.map((item) => item.name).sort(), [...KNOWLEDGE_TOOL_NAMES, ...MEMBER_TOOL_NAMES].sort());
  assert.deepEqual([...KNOWLEDGE_TOOL_NAMES].sort(), ['knowledge_read', 'knowledge_save', 'knowledge_search']);
  assert.deepEqual([...MEMBER_TOOL_NAMES].sort(), ['member_lookup', 'member_note']);

  for (const definition of defs) {
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 20, `${definition.name} 应有可读描述`);
    assert.equal(definition.parameters.type, 'object');
    assert.ok(Array.isArray(definition.parameters.required));
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(definition.output.schema.additionalProperties, false);
    assert.ok(Array.isArray(definition.output.schema.required));
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
  }

  disposeMember();
  disposeKnowledge();
  assert.deepEqual(defs, []);
});

test('knowledge_search：中文检索、输出符合 schema、limit/scope/groupId 生效', async (t) => {
  const bot = makeBot(t);
  const store = bot.knowledge;
  const groupEntry = store.save({
    title: '本群群规',
    body: '禁止广告与刷屏，违规踢出',
    tags: ['群规'],
    scope: 'group',
    groupId: 'g1',
    importance: 2,
  });
  const globalEntry = store.save({ title: '咖啡规则', body: '机器人爱喝美式咖啡', tags: ['偏好'] });
  const { ctx, defs } = captureCtx();
  registerKnowledgeTools(ctx, { knowledge: store, logger: QUIET_LOGGER });
  const tool = findTool(defs, 'knowledge_search');

  const value = await tool.execute({ query: '广告', groupId: 'g1' }, {});
  assertSchemaShape(value, tool.output.schema, 'knowledge_search');
  assert.equal(value.count, 1);
  assert.equal(value.results[0].id, groupEntry.id);
  assert.ok(value.results[0].snippet.includes('广告'));
  const text = render(tool, { query: '广告' }, value);
  assert.match(text, /找到 1 条相关知识/);
  assert.ok(text.includes(groupEntry.id));

  // limit
  const limited = await tool.execute({ query: '咖啡', limit: 1 }, {});
  assert.equal(limited.count, 1);
  assert.equal(limited.results[0].id, globalEntry.id);

  // 不传 groupId = 全局检索（管理 / 无群上下文场景）；传了 groupId 才排除其它群
  const noGroup = await tool.execute({ query: '广告' }, {});
  assert.equal(noGroup.count, 1);
  assert.equal(noGroup.results[0].id, groupEntry.id);
  const globalOnly = await tool.execute({ query: '咖啡' }, {});
  assert.equal(globalOnly.count, 1);

  // 空结果 render
  assert.equal(render(tool, {}, { count: 0, results: [] }), '没有找到相关知识。');

  await assert.rejects(() => tool.execute({ query: '   ' }, {}), /query 必须是非空字符串/);
});

test('knowledge_read：返回完整条目字段且符合 schema；不存在 / 非法 id 抛错', async (t) => {
  const bot = makeBot(t);
  const entry = bot.knowledge.save({ title: '值班表', body: '周一：小明\n周二：小红', tags: ['值班'], scope: 'global' });
  const { ctx, defs } = captureCtx();
  registerKnowledgeTools(ctx, { knowledge: bot.knowledge, logger: QUIET_LOGGER });
  const tool = findTool(defs, 'knowledge_read');

  const value = await tool.execute({ id: entry.id }, {});
  assertSchemaShape(value, tool.output.schema, 'knowledge_read');
  assert.equal(value.id, entry.id);
  assert.equal(value.title, '值班表');
  assert.equal(value.body, '周一：小明\n周二：小红');
  assert.deepEqual(value.tags, ['值班']);
  assert.equal(value.scope, 'global');
  assert.equal(value.importance, 0);
  const text = render(tool, { id: entry.id }, value);
  assert.ok(text.includes('值班表'));
  assert.ok(text.includes('周一：小明'));

  await assert.rejects(() => tool.execute({ id: 'k_missing' }, {}), /未找到条目/);
  await assert.rejects(() => tool.execute({}, {}), /id 必须是非空字符串/);
});

test('knowledge_save：新建 / 按 id 更新 / scope=group 校验 / render', async (t) => {
  const bot = makeBot(t);
  const { ctx, defs } = captureCtx();
  registerKnowledgeTools(ctx, { knowledge: bot.knowledge, logger: QUIET_LOGGER });
  const tool = findTool(defs, 'knowledge_save');

  const created = await tool.execute({
    title: '群活动',
    body: '每周五晚桌游',
    tags: ['活动'],
    scope: 'group',
    groupId: 'g1',
    groupName: '测试群',
    importance: 2,
  }, {});
  assertSchemaShape(created, tool.output.schema, 'knowledge_save');
  assert.equal(created.created, true);
  assert.equal(created.title, '群活动');
  assert.equal(bot.knowledge.get(created.id).importance, 2);
  assert.equal(bot.knowledge.get(created.id).source, 'tool');
  assert.match(render(tool, {}, created), /已保存知识/);

  const updated = await tool.execute({ id: created.id, title: '群活动（新）', body: '改为周六' }, {});
  assert.equal(updated.created, false);
  assert.equal(updated.id, created.id);
  assert.equal(bot.knowledge.get(created.id).title, '群活动（新）');
  assert.equal(bot.knowledge.get(created.id).body, '改为周六');
  assert.match(render(tool, {}, updated), /已更新知识/);

  // 默认 global；scope=group 缺 groupId 拒绝
  const global = await tool.execute({ title: '全局说明' }, {});
  assert.equal(bot.knowledge.get(global.id).scope, 'global');
  await assert.rejects(() => tool.execute({ title: 'x', scope: 'group' }, {}), /groupId 不能为空/);
  await assert.rejects(() => tool.execute({ title: '   ' }, {}), /title 必须是非空字符串/);
});

test('resolveBot 路由：按 exec 选择不同机器人的知识库', async (t) => {
  const botA = makeBot(t, 'a');
  const botB = makeBot(t, 'b');
  botA.knowledge.save({ title: 'A 的知识', body: '这是 A 机器人的知识', tags: ['a'] });
  botB.knowledge.save({ title: 'B 的知识', body: '这是 B 机器人的知识', tags: ['b'] });
  const resolveBot = (exec) => (exec && exec.botId === 'b'
    ? { knowledge: botB.knowledge, members: botB.members }
    : { knowledge: botA.knowledge, members: botA.members });
  const { ctx, defs } = captureCtx();
  registerKnowledgeTools(ctx, { resolveBot, logger: QUIET_LOGGER });
  const search = findTool(defs, 'knowledge_search');
  const save = findTool(defs, 'knowledge_save');

  const fromA = await search.execute({ query: '知识' }, { botId: 'a' });
  const fromB = await search.execute({ query: '知识' }, { botId: 'b' });
  assert.deepEqual(fromA.results.map((item) => item.title), ['A 的知识']);
  assert.deepEqual(fromB.results.map((item) => item.title), ['B 的知识']);

  const saved = await save.execute({ title: 'B 新增', body: '只写 B' }, { botId: 'b' });
  assert.equal(botB.knowledge.get(saved.id).title, 'B 新增');
  assert.equal(botA.knowledge.get(saved.id), null);
});

test('resolveBot 兜底：返回 null / 抛错 / 缺 knowledge 时回退默认 store；仅 resolveBot 也能用', async (t) => {
  const fallbackBot = makeBot(t, 'fallback');
  const routedBot = makeBot(t, 'routed');
  fallbackBot.knowledge.save({ title: '默认知识', body: '来自默认知识库' });
  routedBot.knowledge.save({ title: '路由知识', body: '来自路由知识库' });

  const resolveBot = async (exec) => {
    if (!exec || exec.mode === 'null') return null;
    if (exec.mode === 'throw') throw new Error('router boom');
    if (exec.mode === 'empty') return {};
    if (exec.mode === 'routed') return { knowledge: routedBot.knowledge };
    return { knowledge: fallbackBot.knowledge };
  };
  const { ctx, defs, warnings } = captureCtx();
  registerKnowledgeTools(ctx, { resolveBot, knowledge: fallbackBot.knowledge, logger: { warn: (...args) => warnings.push(args.join(' ')) } });
  const search = findTool(defs, 'knowledge_search');

  for (const exec of [{ mode: 'null' }, { mode: 'throw' }, { mode: 'empty' }, { mode: 'fallback' }]) {
    const value = await search.execute({ query: '知识' }, exec);
    assert.deepEqual(value.results.map((item) => item.title), ['默认知识'], JSON.stringify(exec));
  }
  const routed = await search.execute({ query: '知识' }, { mode: 'routed' });
  assert.deepEqual(routed.results.map((item) => item.title), ['路由知识']);
  assert.ok(warnings.some((line) => line.includes('resolveBot 失败')), 'router 抛错应记 warn');

  // 只有 resolveBot、没有默认 store：同样注册并可执行
  const only = captureCtx();
  registerKnowledgeTools(only.ctx, { resolveBot: () => ({ knowledge: routedBot.knowledge }) });
  const onlySearch = findTool(only.defs, 'knowledge_search');
  const value = await onlySearch.execute({ query: '路由' }, {});
  assert.equal(value.count, 1);
});

test('fallback 兜底：resolveBot 缺失或都不可用时，execute 抛「知识库不可用」', async (t) => {
  const bot = makeBot(t);
  const { ctx, defs } = captureCtx();
  // 只有 resolveBot 且总是返回 null：注册成功，但执行时无 store
  registerKnowledgeTools(ctx, { resolveBot: () => null });
  const search = findTool(defs, 'knowledge_search');
  await assert.rejects(() => search.execute({ query: 'x' }, {}), /知识库不可用/);

  // 传入 store 但 resolveBot 返回别的类型 → 回退
  const fallback = captureCtx();
  registerKnowledgeTools(fallback.ctx, { resolveBot: () => ({ knowledge: { nope: true } }), knowledge: bot.knowledge });
  const fallbackSearch = findTool(fallback.defs, 'knowledge_search');
  const value = await fallbackSearch.execute({ query: '任何' }, {});
  assert.equal(value.count, 0);
});

test('member_lookup：openid 精确查询 / 群列表 / schema 形状 / 空结果', async (t) => {
  const bot = makeBot(t);
  const members = bot.members;
  const ming = members.visit({ groupId: 'g1', groupName: '一群', openid: 'u1', name: '小明' });
  members.visit({ groupId: 'g1', groupName: '一群', openid: 'u2', name: '小红' });
  members.visit({ groupId: 'g2', groupName: '二群', openid: 'u3', name: '小刚' });
  members.save({ id: ming.id, tags: ['程序员'], notes: '喜欢喝美式咖啡', aliases: ['明明'] });
  members.flush();

  const { ctx, defs } = captureCtx();
  registerMemberTools(ctx, { members, logger: QUIET_LOGGER });
  const tool = findTool(defs, 'member_lookup');

  // 1) openid 精确
  const one = await tool.execute({ openid: 'u1' }, {});
  assertSchemaShape(one, tool.output.schema, 'member_lookup');
  assert.equal(one.count, 1);
  assert.equal(one.members[0].id, ming.id);
  assert.equal(one.members[0].name, '小明');
  assert.deepEqual(one.members[0].tags, ['程序员']);
  assert.deepEqual(one.members[0].aliases, ['明明']);
  assert.ok(one.members[0].note.includes('美式咖啡'));
  assert.equal(one.members[0].groups[0].groupId, 'g1');

  // 2) 当前群列表（不含其它群）
  const group = await tool.execute({ groupId: 'g1' }, {});
  assertSchemaShape(group, tool.output.schema, 'member_lookup.group');
  assert.equal(group.count, 2);
  assert.deepEqual(group.members.map((item) => item.name).sort(), ['小明', '小红']);
  assert.equal(group.members.some((item) => item.name === '小刚'), false);

  // 3) query + limit
  const named = await tool.execute({ query: '小红', groupId: 'g1', limit: 1 }, {});
  assert.equal(named.count, 1);
  assert.equal(named.members[0].name, '小红');

  // 4) 未知 openid / 空结果
  const missing = await tool.execute({ openid: 'nobody' }, {});
  assert.equal(missing.count, 0);
  assert.deepEqual(missing.members, []);
  assert.equal(render(tool, {}, missing), '没有找到符合条件的群友。');
  assert.match(render(tool, {}, group), /共 2 位相关群友/);
});

test('member_note：按 openid 新建 / 按 id 更新 / 入参校验 / render', async (t) => {
  const bot = makeBot(t);
  const members = bot.members;
  const visited = members.visit({ groupId: 'g1', openid: 'u1', name: '小明' });
  const { ctx, defs } = captureCtx();
  registerMemberTools(ctx, { members, logger: QUIET_LOGGER });
  const tool = findTool(defs, 'member_note');

  const created = await tool.execute({
    openid: 'u-new',
    name: '新朋友',
    tags: ['新群友'],
    aliases: ['小新'],
    note: '刚入群，喜欢桌游',
    importance: 2,
  }, {});
  assertSchemaShape(created, tool.output.schema, 'member_note.create');
  assert.equal(created.created, true);
  assert.equal(created.name, '新朋友');
  assert.equal(members.getByOpenid('u-new').importance, 2);
  assert.match(render(tool, {}, created), /已记录群友/);

  const updated = await tool.execute({ id: visited.id, note: '负责群活动', name: '小明同学' }, {});
  assert.equal(updated.created, false);
  assert.equal(updated.id, visited.id);
  assert.equal(members.get(visited.id).body, '负责群活动');
  assert.equal(members.get(visited.id).title, '小明同学');
  assert.match(render(tool, {}, updated), /已更新群友/);

  await assert.rejects(() => tool.execute({ name: '无 id' }, {}), /id 或 openid 至少提供一个/);
});

test('member 工具 resolveBot 路由；无 store 时 execute 抛「群友库不可用」', async (t) => {
  const botA = makeBot(t, 'a');
  const botB = makeBot(t, 'b');
  botA.members.visit({ groupId: 'g1', openid: 'ua', name: 'A 群友' });
  botB.members.visit({ groupId: 'g2', openid: 'ub', name: 'B 群友' });
  const resolveBot = (exec) => (exec && exec.botId === 'b' ? { members: botB.members } : { members: botA.members });
  const { ctx, defs } = captureCtx();
  registerMemberTools(ctx, { resolveBot, logger: QUIET_LOGGER });
  const lookup = findTool(defs, 'member_lookup');

  const fromA = await lookup.execute({}, { botId: 'a' });
  const fromB = await lookup.execute({}, { botId: 'b' });
  assert.deepEqual(fromA.members.map((item) => item.name), ['A 群友']);
  assert.deepEqual(fromB.members.map((item) => item.name), ['B 群友']);

  // resolveBot 返回 null 且没有默认 store → execute 抛错
  const broken = captureCtx();
  registerMemberTools(broken.ctx, { resolveBot: () => null });
  const brokenLookup = findTool(broken.defs, 'member_lookup');
  await assert.rejects(() => brokenLookup.execute({}, {}), /群友库不可用/);
});

test('注册降级：tools 服务缺失 / 没有 store 时只 warn 不抛错', (t) => {
  const noTools = { get: () => undefined };
  assert.equal(typeof registerKnowledgeTools(noTools, { knowledge: { save() {}, get() {}, search() {} } }), 'function');
  assert.equal(typeof registerMemberTools(noTools, { members: { save() {}, get() {}, list() {} } }), 'function');
  // 参数为空也不能抛
  assert.equal(typeof registerKnowledgeTools({}, {}), 'function');
  assert.equal(typeof registerMemberTools({}, {}), 'function');
  // 工具服务可用，但没有 store 与 resolveBot
  const { ctx, defs } = captureCtx();
  registerKnowledgeTools(ctx, {});
  registerMemberTools(ctx, {});
  assert.deepEqual(defs, []);
});

test('兼容：第二个参数直接传 store（旧思路位置参数）', async (t) => {
  const bot = makeBot(t);
  const { ctx, defs } = captureCtx();
  registerKnowledgeTools(ctx, bot.knowledge, QUIET_LOGGER);
  registerMemberTools(ctx, bot.members, QUIET_LOGGER);
  assert.equal(defs.length, 5);
  const save = findTool(defs, 'knowledge_save');
  const created = await save.execute({ title: '位置参数', body: 'x' }, {});
  assert.equal(bot.knowledge.get(created.id).title, '位置参数');
  const note = findTool(defs, 'member_note');
  const member = await note.execute({ openid: 'u1', name: '小明' }, {});
  assert.equal(bot.members.get(member.id).title, '小明');
});

test('单工具注册失败不影响其它工具（每个 register 单独 try/catch）', (t) => {
  const bot = makeBot(t);
  const { ctx, defs, warnings } = captureCtx({ throwOn: 'knowledge_read' });
  registerKnowledgeTools(ctx, { knowledge: bot.knowledge, logger: { warn: (...args) => warnings.push(args.join(' ')) } });
  assert.deepEqual(defs.map((item) => item.name).sort(), ['knowledge_save', 'knowledge_search']);
  assert.ok(warnings.some((line) => line.includes('knowledge_read')));
});

test('fake-ctx 集成：注册到真实 ctx.tools 并可 dispose', (t) => {
  const bot = makeBot(t);
  const ctx = createFakeCtx();
  ctx.set('tools', ctx.tools);
  const disposeKnowledge = registerKnowledgeTools(ctx, { knowledge: bot.knowledge, logger: QUIET_LOGGER });
  const disposeMember = registerMemberTools(ctx, { members: bot.members, logger: QUIET_LOGGER });
  assert.equal(ctx.tools.registered.length, 5);
  assert.deepEqual(ctx.tools.registered.map((item) => item.name).sort(), [...KNOWLEDGE_TOOL_NAMES, ...MEMBER_TOOL_NAMES].sort());
  disposeKnowledge();
  assert.equal(ctx.tools.registered.length, 2);
  disposeMember();
  assert.equal(ctx.tools.registered.length, 0);
});
