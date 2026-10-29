/**
 * test/bots-host.test.js —— 多机器人宿主集成测试。
 *
 * 覆盖：宿主装配（legacy 机器人 + 运行时组件）、机器人 CRUD 与工作区目录、
 * 工具全局注册一次并按 exec.agent 路由到所属机器人、web API botId 作用域。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBotHost } from '../lib/bots/host.js';
import { registerWebRoutes } from '../lib/web/routes.js';

function tempRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-host-' + name + '-'));
}

function quietLogger() {
  const entries = [];
  const make = (level) => (...args) => entries.push({ level, args });
  return {
    entries,
    info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug'),
  };
}

function makeCtx(extra = {}) {
  const routes = new Map();
  const tools = new Map();
  const webServer = {
    register(def) {
      routes.set(def.path, def.handler);
      return () => routes.delete(def.path);
    },
  };
  const toolService = {
    register(definition) {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
  };
  const services = new Map(Object.entries(extra));
  services.set('logger', quietLogger());
  services.set('webServer', webServer);
  services.set('tools', toolService);
  return {
    routes,
    tools,
    get(name) { return services.get(name); },
    set(name, value) { services.set(name, value); },
    on() { return () => {}; },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') this._disposers = (this._disposers || []).concat(dispose);
    },
    _disposers: [],
    async dispose() {
      for (const dispose of (this._disposers || []).reverse()) {
        try { await dispose(); } catch { /* ignore */ }
      }
    },
  };
}

/** 模拟一个 agent 作用域上下文（工具注册应落在它自己的 tools 上）。 */
function makeAgentCtx() {
  const toolMap = new Map();
  const disposers = [];
  const agentCtx = {
    _tools: toolMap,
    _disposers: disposers,
    tools: {
      register(def) {
        toolMap.set(def.name, def);
        return () => toolMap.delete(def.name);
      },
    },
    get(name) {
      // 故意让 get('tools') 拿不到（真实宿主 get 会返回无 scope 的全局实例）
      return name === 'tools' ? undefined : undefined;
    },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
  };
  return agentCtx;
}

/** 直接调用已注册路由（不经过 HTTP）。 */
async function callRoute(ctx, path, { method = 'GET', body = '' } = {}) {
  const routePath = path.split('?')[0];
  const handler = ctx.routes.get(routePath);
  assert.ok(handler, '路由未注册: ' + path);
  const chunks = [];
  const listeners = { data: [], end: [] };
  const req = {
    method,
    url: path,
    headers: { origin: '', host: '127.0.0.1' },
    on(event, callback) { (listeners[event] ||= []).push(callback); return req; },
    resume() {},
  };
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(chunk) { if (chunk !== undefined) chunks.push(String(chunk)); this.writableEnded = true; },
  };
  if (body !== '') {
    process.nextTick(() => {
      for (const callback of listeners.data) callback(Buffer.from(body));
      for (const callback of listeners.end) callback();
    });
  }
  const pending = handler(req, res);
  await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 500))]);
  const text = chunks.join('');
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.statusCode, json, text };
}

test('宿主装配：legacy 机器人有完整运行时与工具注册', async () => {
  const root = tempRoot('boot');
  const ctx = makeCtx();
  const config = {
    cwd: root,
    workspaceRoot: root,
    autoStart: false,
    bindOnMissingCredentials: false,
    registerTools: true,
    sendFile: { restrictPaths: true, extraRoots: [] },
  };
  const host = await createBotHost({ ctx, config, logger: quietLogger(), start: false });
  const snapshots = host.listSnapshots();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].id, 'default');
  assert.equal(snapshots[0].legacy, true);
  assert.equal(snapshots[0].ready, false);

  const runtime = host.activeBot();
  assert.ok(runtime, 'active runtime 应存在');
  assert.equal(typeof runtime.settings.get, 'function');
  assert.equal(typeof runtime.memory.saveFact, 'function');
  assert.ok(runtime.knowledge && typeof runtime.knowledge.list === 'function', '知识库应装配');
  assert.ok(runtime.members && typeof runtime.members.visit === 'function', '群友库应装配');
  assert.ok(runtime.emergence && typeof runtime.emergence.recallForTurn === 'function');
  assert.ok(fs.existsSync(path.join(root, 'memory')));
  assert.ok(fs.existsSync(path.join(root, 'knowledge')));
  assert.ok(fs.existsSync(path.join(root, '.qqbot', 'state', 'settings.json')) || fs.existsSync(path.join(root, '.qqbot', 'state')));

  // 关键约束：插件工具不再全局注册（其它 preset / 普通 Web agent 看不到）
  assert.equal(ctx.tools.size, 0, '插件工具不应出现在全局 tools 注册表');

  // 通过 agent 作用域注册：qqbot 会话才有这些工具
  const agentCtx = makeAgentCtx();
  const disposers = await runtime.registerToolsScoped(agentCtx);
  const names = [...agentCtx._tools.keys()];
  for (const expected of ['memory_save', 'memory_search', 'qqbot_send_file', 'qqbot_sticker_save']) {
    assert.ok(names.includes(expected), 'agent scope 缺少工具 ' + expected);
  }
  assert.ok(Array.isArray(disposers) && disposers.length > 0, '应返回作用域工具 disposer');
  for (const dispose of disposers) dispose();
  assert.equal(agentCtx._tools.size, 0, 'disposer 应注销作用域工具');
  assert.equal(ctx.tools.size, 0, '注销后全局仍为空');
  await host.disposeAll();
});

test('新增机器人：独立工作区与设置，工具按 exec.agent 路由', async () => {
  const root = tempRoot('route');
  const ctx = makeCtx();
  const host = await createBotHost({
    ctx,
    config: { cwd: root, workspaceRoot: root, autoStart: false, bindOnMissingCredentials: false, registerTools: true },
    logger: quietLogger(),
    start: false,
  });
  const created = await host.createBot({ name: '客服机器人' });
  assert.equal(created.ok, true);
  const botB = host.getBot(created.bot.id);
  assert.ok(botB);
  assert.notEqual(botB.workspaceDir, host.activeBot().workspaceDir);
  assert.ok(fs.existsSync(path.join(botB.workspaceDir, '.qqbot', 'state')));

  // 两个 agent 分别属于两个机器人
  const agentA = { id: 'agent-a' };
  const agentB = { id: 'agent-b' };
  host.agentMap.bind(agentA, host.activeBot());
  host.agentMap.bind(agentB, botB);
  assert.equal(host.resolveBot({ agent: agentA }).id, 'default');
  assert.equal(host.resolveBot({ agent: agentB }).id, created.bot.id);
  assert.equal(host.resolveBot({}).id, 'default', '未登记 agent 回退 active');

  // 每个 agent 的插件工具只注册进自己的 scope，且绑定到所属机器人
  const agentCtxA = makeAgentCtx();
  const agentCtxB = makeAgentCtx();
  assert.ok((await host.activeBot().registerToolsScoped(agentCtxA)).length > 0);
  assert.ok((await botB.registerToolsScoped(agentCtxB)).length > 0);
  assert.equal(ctx.tools.size, 0, '全局注册表应保持为空');
  assert.ok(agentCtxB._tools.has('memory_save'));

  // memory_save 写入各自工作区
  await agentCtxB._tools.get('memory_save').execute(
    { content: 'B 机器人记住：群主喜欢猫', tags: ['偏好'] }, { agent: agentB },
  );
  await agentCtxA._tools.get('memory_save').execute(
    { content: 'A 机器人记住：周报在周五', tags: ['工作'] }, { agent: agentA },
  );
  assert.ok(fs.existsSync(path.join(botB.workspaceDir, 'memory', 'MEMORY.md')));
  assert.ok(fs.existsSync(path.join(host.activeBot().workspaceDir, 'memory', 'MEMORY.md')));
  const bMemory = fs.readFileSync(path.join(botB.workspaceDir, 'memory', 'MEMORY.md'), 'utf8');
  assert.match(bMemory, /群主喜欢猫/);
  assert.ok(!bMemory.includes('周报在周五'), 'B 机器人的记忆不应包含 A 的内容');

  // 删除机器人
  const deleted = await host.deleteBot(created.bot.id);
  assert.equal(deleted.ok, true);
  assert.equal(host.getBot(created.bot.id), null);
  await host.disposeAll();
});

test('web API：/bots 列表与 botId 作用域', async () => {
  const root = tempRoot('api');
  const ctx = makeCtx();
  const host = await createBotHost({
    ctx,
    config: { cwd: root, workspaceRoot: root, autoStart: false, bindOnMissingCredentials: false, registerTools: false },
    logger: quietLogger(),
    start: false,
  });
  registerWebRoutes(ctx, host.runtime);
  const bots = await callRoute(ctx, '/qqbot-buddy/api/bots');
  assert.equal(bots.status, 200);
  assert.equal(bots.json.ok, true);
  assert.equal(bots.json.supported, true);
  assert.equal(bots.json.bots.length, 1);
  assert.equal(bots.json.activeBotId, 'default');

  const created = await callRoute(ctx, '/qqbot-buddy/api/bots/create', {
    method: 'POST',
    body: JSON.stringify({ name: '二号机' }),
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.bot.name, '二号机');
  const newId = created.json.bot.id;

  // 带 botId 的 knowledge 接口路由到新机器人（空库）
  const knowledge = await callRoute(ctx, '/qqbot-buddy/api/knowledge?botId=' + encodeURIComponent(newId));
  assert.equal(knowledge.status, 200);
  assert.equal(knowledge.json.ok, true);
  assert.equal(knowledge.json.total, 0);

  // 写入一条知识，再按 botId 读取
  const saved = await callRoute(ctx, '/qqbot-buddy/api/knowledge/save?botId=' + encodeURIComponent(newId), {
    method: 'POST',
    body: JSON.stringify({ title: '群规', body: '禁止发广告', tags: ['群规'], scope: 'global', importance: 2 }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  const list = await callRoute(ctx, '/qqbot-buddy/api/knowledge?botId=' + encodeURIComponent(newId));
  assert.equal(list.json.total, 1);
  assert.equal(list.json.items[0].title, '群规');

  // legacy 机器人（default）看不到新机器人的知识
  const otherList = await callRoute(ctx, '/qqbot-buddy/api/knowledge?botId=default');
  assert.equal(otherList.status, 200);
  assert.equal(otherList.json.total, 0);

  // 删除
  const removed = await callRoute(ctx, '/qqbot-buddy/api/bots/delete', {
    method: 'POST',
    body: JSON.stringify({ botId: newId }),
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.ok, true);
  await host.disposeAll();
});

test('涌现预览：知识条目按关键词命中', async () => {
  const root = tempRoot('recall');
  const ctx = makeCtx();
  const host = await createBotHost({
    ctx,
    config: { cwd: root, workspaceRoot: root, autoStart: false, bindOnMissingCredentials: false, registerTools: false },
    logger: quietLogger(),
    start: false,
  });
  const bot = host.activeBot();
  bot.knowledge.save({ title: '活动安排', body: '周六晚八点开黑打排位', tags: ['活动'], scope: 'global', importance: 2 });
  const result = bot.emergence.recallForTurn({ text: '今晚要不要开黑？', scope: 'group', groupId: 'g1' });
  assert.ok(result && typeof result.text === 'string');
  assert.ok(result.text.includes('活动安排') || result.counts.knowledge > 0, '相关条目应被召回：' + JSON.stringify(result.counts));
  const irrelevant = bot.emergence.recallForTurn({ text: '今天天气怎么样', scope: 'group', groupId: 'g1' });
  assert.equal(irrelevant.counts.knowledge, 0);
  await host.disposeAll();
});
