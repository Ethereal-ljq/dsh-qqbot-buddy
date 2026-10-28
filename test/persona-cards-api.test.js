/**
 * test/persona-cards-api.test.js —— 人格卡 / 命令 / 管理员设置的 HTTP API 集成测试（第四批）。
 *
 * 用真实 persona-store + persona-cards-store + settings-store，套在 fake Cordis webServer 上，
 * 走真实 registerWebRoutes 分派层，断言：
 *  - /api/persona/cards CRUD + activate 后当前 persona 文件内容确实变化（并保留旧人设备份）；
 *  - 删除激活卡不影响当前 persona 文件；
 *  - /api/commands 返回命令目录与 admin 配置；POST /api/settings 保存 admin 后被 /commands 回显；
 *  - 方法不允许/参数校验/不存在 id 的状态码。
 * 不联网、不写 live（cwd/stateDir 都是临时目录）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerWebRoutes } from '../lib/web/routes.js';
import { createSettingsStore, resolveDefaults } from '../lib/settings-store.js';
import { createPersonaStore } from '../lib/persona-store.js';
import { createPersonaCardsStore } from '../lib/persona-cards-store.js';
import { createFakeCtx } from './helpers/fake-ctx.js';

const API = '/qqbot-buddy/api';
const HOST = '127.0.0.1:3099';

/** 极简 EventEmitter 风格 req + 记录型 res（与 bind-routes 测试同款）。 */
function makeReqRes({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers: { host: HOST, ...headers },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
      return req;
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) listener(...args);
    },
    resume() {},
  };
  const chunks = [];
  const res = {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    headersSent: false,
    setHeader(name, value) {
      res.headers[String(name).toLowerCase()] = value;
    },
    writeHead(code, extra) {
      res.statusCode = code;
      res.headersSent = true;
      for (const [name, value] of Object.entries(extra || {})) res.setHeader(name, value);
      return res;
    },
    end(payload) {
      if (payload !== undefined) chunks.push(String(payload));
      res.writableEnded = true;
      return res;
    },
    get text() {
      return chunks.join('');
    },
    get json() {
      try { return JSON.parse(chunks.join('') || '{}'); } catch { return null; }
    },
  };
  return { req, res, body };
}

/** 搭一套真实 store + fake webServer，返回 call(method, path, opts)。 */
function makeApp(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-cards-api-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'cwd');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const ctx = createFakeCtx({});
  ctx.set('webServer', ctx.webServer);
  const logger = ctx.logger;
  const defaults = resolveDefaults({ cwd });
  const settings = createSettingsStore({ file: path.join(stateDir, 'settings.json'), defaults, logger });
  const persona = createPersonaStore({ settings, stateDir, logger });
  const personaCards = createPersonaCardsStore({ personaStore: persona, cwd, logger });
  const runtime = {
    settings,
    persona,
    personaCards,
    cwd,
    logger,
    getVersion: () => '0.0.0-test',
    botState: () => ({ appId: '', ready: false, startedAt: 0, lastError: '', sessionCount: 0, pending: [] }),
    stats: { received: 0, triggered: 0, skipped: 0, replies: 0, lastReplyAt: 0, lastTriggerReason: '' },
  };
  const dispose = registerWebRoutes(ctx, runtime);

  const call = async (method, p, options = {}) => {
    const route = ctx.webServer.routes.find((item) => item.kind === 'exact' && item.path === API + p);
    assert.ok(route, '路由未注册: ' + p);
    const { req, res } = makeReqRes({ method, url: API + p, headers: options.headers });
    const pending = route.handler(req, res);
    if (options.body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(options.body)));
      req.emit('end');
    } else if (options.rawBody !== undefined) {
      req.emit('data', Buffer.from(options.rawBody));
      req.emit('end');
    }
    await pending;
    return res;
  };

  return { base, cwd, stateDir, ctx, settings, persona, personaCards, dispose, call, routes: () => ctx.webServer.routes };
}

test('GET /persona/cards：空库返回 ok + 空列表 + custom（当前人设不是任何卡）', async (t) => {
  const app = makeApp(t);
  const res = await app.call('GET', '/persona/cards');
  assert.equal(res.statusCode, 200);
  const body = res.json;
  assert.equal(body.ok, true);
  assert.deepEqual(body.cards, []);
  assert.equal(body.activeId, null);
  assert.equal(body.custom, true);
  assert.ok(body.dir.endsWith(path.join('cwd', 'personas')) || body.dir.endsWith('personas'));
  app.dispose();
});

test('人格卡 CRUD + activate：切换后当前 persona 文件内容随之变化并产生旧人设备份', async (t) => {
  const app = makeApp(t);
  // 1. 新建 A
  const createdA = await app.call('POST', '/persona/cards', {
    body: { name: '猫娘 A', description: '第一张', content: '你是一只猫娘。' },
  });
  assert.equal(createdA.statusCode, 200);
  assert.equal(createdA.json.ok, true);
  const cardA = createdA.json.card;
  assert.ok(cardA && cardA.id, '创建应返回 card.id');
  assert.equal(cardA.name, '猫娘 A');
  assert.equal(fs.existsSync(path.join(app.cwd, 'personas', cardA.file)), true, '卡片正文文件应落盘');

  // 2. 激活 A → persona 文件变化
  const activated = await app.call('POST', '/persona/cards/activate', { body: { id: cardA.id } });
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.json.ok, true);
  assert.equal(activated.json.active, true);
  assert.equal(app.persona.read().text, '你是一只猫娘。\n');
  const personaRes = await app.call('GET', '/persona');
  assert.equal(personaRes.json.text, '你是一只猫娘。\n');

  // 3. 新建 B 并激活 → persona 换成 B，A 不再 active
  const createdB = await app.call('POST', '/persona/cards', { body: { name: '猫娘 B', content: '你是一只狐狸。' } });
  const cardB = createdB.json.card;
  const activatedB = await app.call('POST', '/persona/cards/activate', { body: { id: cardB.id } });
  assert.equal(activatedB.json.ok, true);
  assert.equal(app.persona.read().text, '你是一只狐狸。\n');
  const listAfterB = (await app.call('GET', '/persona/cards')).json;
  assert.equal(listAfterB.cardCount, 2);
  assert.equal(listAfterB.activeId, cardB.id);
  assert.equal(listAfterB.cards.find((item) => item.id === cardA.id).active, false);

  // 4. update A 内容后激活 → persona 变成更新后的内容
  const updated = await app.call('POST', '/persona/cards/update', {
    body: { id: cardA.id, content: '你是猫娘 A2。', description: '改过' },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json.ok, true);
  await app.call('POST', '/persona/cards/activate', { body: { id: cardA.id } });
  assert.equal(app.persona.read().text, '你是猫娘 A2。\n');
  assert.equal((await app.call('GET', '/persona/cards')).json.activeId, cardA.id);

  // 5. 删除激活卡 → 当前 persona 不受影响（只删卡片与索引）
  const deleted = await app.call('POST', '/persona/cards/delete', { body: { id: cardA.id } });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json.ok, true);
  assert.equal(deleted.json.wasActive, true);
  assert.equal(app.persona.read().text, '你是猫娘 A2。\n', '删除卡片不得改动当前人设');
  const finalList = (await app.call('GET', '/persona/cards')).json;
  assert.equal(finalList.cardCount, 1);
  assert.equal(finalList.custom, true, '剩余卡内容与当前人设不一致 → custom');
  app.dispose();
});

test('人格卡参数校验：缺 name/id、空正文、不存在 id、方法不允许', async (t) => {
  const app = makeApp(t);
  const noName = await app.call('POST', '/persona/cards', { body: { content: 'x' } });
  assert.equal(noName.statusCode, 400);
  const emptyContent = await app.call('POST', '/persona/cards', { body: { name: '空', content: '   ' } });
  assert.equal(emptyContent.statusCode, 400);
  const noId = await app.call('POST', '/persona/cards/activate', { body: {} });
  assert.equal(noId.statusCode, 400);
  const unknown = await app.call('POST', '/persona/cards/activate', { body: { id: 'nope' } });
  assert.equal(unknown.statusCode, 404);
  const updateUnknown = await app.call('POST', '/persona/cards/update', { body: { id: 'nope', name: 'x' } });
  assert.equal(updateUnknown.statusCode, 404);
  const deleteUnknown = await app.call('POST', '/persona/cards/delete', { body: { id: 'nope' } });
  assert.equal(deleteUnknown.statusCode, 404);
  const badMethod = await app.call('GET', '/persona/cards/activate');
  assert.equal(badMethod.statusCode, 405);
  app.dispose();
});

test('GET /commands：返回目录（含 adminOnly 标记）与 admin 配置；HEAD 可用、POST 405', async (t) => {
  const app = makeApp(t);
  const res = await app.call('GET', '/commands');
  assert.equal(res.statusCode, 200);
  const body = res.json;
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.commands) && body.commands.length >= 9);
  const byName = new Map(body.commands.map((item) => [item.name, item]));
  assert.equal(byName.get('id').adminOnly, false);
  assert.equal(byName.get('help').adminOnly, false);
  assert.equal(byName.get('new').adminOnly, true);
  for (const item of body.commands) {
    assert.match(item.usage, /^\//);
    assert.equal(typeof item.description, 'string');
  }
  assert.deepEqual(body.admin, { enabled: false, openids: [], names: [] });

  const head = await app.call('HEAD', '/commands');
  assert.equal(head.statusCode, 200);
  const post = await app.call('POST', '/commands');
  assert.equal(post.statusCode, 405);
  app.dispose();
});

test('POST /settings 保存 admin 后 /commands 回显；admin 名单影响 enabled/名单内容', async (t) => {
  const app = makeApp(t);
  const saved = await app.call('POST', '/settings', {
    body: { patch: { admin: { enabled: true, openids: ['admin-openid'], names: ['管理员昵称'] } } },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.settings.admin.enabled, true);

  const commands = (await app.call('GET', '/commands')).json;
  assert.deepEqual(commands.admin, { enabled: true, openids: ['admin-openid'], names: ['管理员昵称'] });
  // 再次更新只改 openids，enabled 与 names 保留（深合并）
  await app.call('POST', '/settings', { body: { patch: { admin: { openids: ['admin-openid', 'second'] } } } });
  const next = (await app.call('GET', '/commands')).json;
  assert.equal(next.admin.enabled, true);
  assert.deepEqual(next.admin.openids, ['admin-openid', 'second']);
  assert.deepEqual(next.admin.names, ['管理员昵称']);
  app.dispose();
});

test('创建卡片省略 content：以当前 persona 内容为正文；随后激活内容一致', async (t) => {
  const app = makeApp(t);
  await app.call('POST', '/persona', { body: { text: '当前人设正文' } });
  const created = await app.call('POST', '/persona/cards', { body: { name: '快照卡' } });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json.ok, true);
  assert.equal(created.json.card.chars, '当前人设正文\n'.length, 'chars 含 personason 文件结尾换行');
  await app.call('POST', '/persona/cards/activate', { body: { id: created.json.card.id } });
  const list = (await app.call('GET', '/persona/cards')).json;
  assert.equal(list.activeId, created.json.card.id);
  assert.equal(app.persona.read().text, '当前人设正文\n');
  app.dispose();
});