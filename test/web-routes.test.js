/**
 * test/web-routes.test.js —— /qqbot-buddy/api/* 管理路由单测。
 *
 * 用 fake webServer / req / res / runtime 覆盖：
 * 注册与释放、state 组装与容错、persona/settings/memory/prompt/action
 * 的成功与错误分支、1MB body 上限、非法 JSON、路径越界拒绝、方法不允许。
 */
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { registerWebRoutes } from '../lib/web/routes.js';

const BASE = '/qqbot-buddy/api';
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// ── fake webServer / ctx ─────────────────────────────────────
function makeServer() {
  const routes = new Map();
  const registered = [];
  return {
    routes,
    registered,
    register(options) {
      assert.equal(options.kind, 'exact');
      assert.equal(typeof options.path, 'string');
      assert.equal(typeof options.handler, 'function');
      routes.set(options.path, options.handler);
      registered.push(options.path);
      return () => {
        if (routes.get(options.path) === options.handler) routes.delete(options.path);
      };
    },
  };
}

function makeCtx(webServer) {
  return {
    get(name) {
      return name === 'webServer' ? webServer : undefined;
    },
  };
}

// ── fake req / res ───────────────────────────────────────────
function splitChunks(text, count) {
  if (text === '') return [];
  const size = Math.ceil(text.length / count);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function makeReq({ method = 'GET', url = '/', body, rawBody } = {}) {
  const listeners = { data: [], end: [], error: [] };
  const req = {
    method,
    url,
    destroyed: false,
    on(event, callback) {
      if (Array.isArray(listeners[event])) listeners[event].push(callback);
      return req;
    },
    destroy() {
      req.destroyed = true;
    },
  };
  const hasBody = rawBody !== undefined || body !== undefined;
  if (hasBody) {
    const text = rawBody !== undefined ? rawBody : JSON.stringify(body);
    process.nextTick(() => {
      for (const part of splitChunks(String(text), 2)) {
        if (req.destroyed) return;
        for (const callback of listeners.data) callback(Buffer.from(part));
      }
      if (req.destroyed) return;
      for (const callback of listeners.end) callback();
    });
  }
  return req;
}

function makeRes() {
  const state = { statusCode: 0, headers: null, body: '' };
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      state.statusCode = status;
      state.headers = headers;
      res.headersSent = true;
      return res;
    },
    end(chunk) {
      if (chunk !== undefined) state.body += String(chunk);
      res.writableEnded = true;
    },
  };
  return { res, state };
}

function makeClient(runtime) {
  const server = makeServer();
  const dispose = registerWebRoutes(makeCtx(server), runtime);
  let lastReq = null;
  async function call(method, path, { body, rawBody, query } = {}) {
    const fullPath = BASE + path;
    const handler = server.routes.get(fullPath);
    assert.equal(typeof handler, 'function', '路由未注册：' + fullPath);
    let url = fullPath;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) params.set(key, value);
      url += '?' + params.toString();
    }
    const req = makeReq({ method, url, body, rawBody });
    lastReq = req;
    const { res, state } = makeRes();
    await handler(req, res);
    let json = null;
    if (state.body !== '') {
      try {
        json = JSON.parse(state.body);
      } catch {
        json = { raw: state.body };
      }
    }
    return { status: state.statusCode, json, headers: state.headers };
  }
  return {
    server,
    dispose,
    call,
    get lastReq() {
      return lastReq;
    },
  };
}

// ── fake runtime ────────────────────────────────────────────
const clone = (value) => JSON.parse(JSON.stringify(value));

function defaultSettings() {
  return {
    version: 1,
    reply: {
      enabled: true,
      groupEnabled: true,
      groupMode: 'count',
      adaptive: { debounceSeconds: 4, cooldownSeconds: 12, maxWaitSeconds: 20, requireRelevance: true },
      countThreshold: 3,
      flushAfterSeconds: 120,
      intervalSeconds: 90,
      probability: 0.25,
      minGapSeconds: 0,
      c2cEnabled: true,
    },
    triggers: { onMention: true, onReplyToBot: true, keywords: [] },
    stickers: { dir: '/tmp/dsh-qqbot-test/project/qqbot/stickers', collectEnabled: true, maxMB: 8, dailyLimit: 10 },
    persona: {
      path: '/tmp/dsh-qqbot-test/project/qqbot/persona.md',
      mode: 'replace',
      suppressRuntimeContext: true,
      groupExtraPrompt: '群聊里要 @ 对方',
      directExtraPrompt: '',
    },
    memory: {
      enabled: true,
      dir: '/tmp/dsh-qqbot-test/project/qqbot/memory',
      injectMaxChars: 4000,
      autoCollect: {
        enabled: true,
        everyRounds: 6,
        maxFacts: 5,
        maxFactChars: 400,
        provider: '',
        model: '',
      },
    },
    behavior: { extraInstructions: '' },
  };
}

const isPlainObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function mergeInto(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObj(value)) {
      target[key] = mergeInto(isPlainObj(target[key]) ? target[key] : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function makeRuntime(overrides = {}) {
  let settings = defaultSettings();
  let personaText = '# 阿漆\n群聊里像朋友一样聊天。';
  const memoryFiles = { 'MEMORY.md': '- [2026-10-25] 喜欢猫' };
  const calls = {
    patch: [],
    replace: [],
    personaWrite: [],
    restore: [],
    readFile: [],
    writeFile: [],
    saveFact: [],
    collect: 0,
    clearPending: 0,
    restart: 0,
    compose: [],
  };
  const now = Date.now();

  const settingsStore = {
    defaults: clone(defaultSettings()),
    get: () => clone(settings),
    async patch(partial) {
      calls.patch.push(clone(partial));
      mergeInto(settings, partial);
      return { settings: clone(settings), changed: Object.keys(partial) };
    },
    async replace(next) {
      calls.replace.push(clone(next));
      settings = mergeInto(defaultSettings(), clone(next));
      return { settings: clone(settings), changed: ['reply', 'triggers'] };
    },
  };

  const persona = {
    read() {
      return {
        text: personaText,
        path: settings.persona.path,
        bytes: Buffer.byteLength(personaText, 'utf8'),
        lines: personaText.split('\n').length,
        exists: true,
        mtime: 1700000000000,
      };
    },
    async write(text) {
      calls.personaWrite.push(text);
      personaText = text;
      return { ok: true, backup: 'persona-20261025-120000-save.md' };
    },
    backups() {
      return [{ name: 'persona-20261025-120000-save.md', size: 24, mtime: 1700000000000 }];
    },
    async restore(name) {
      calls.restore.push(name);
      if (name === 'missing.md') return { ok: false, error: '备份不存在' };
      personaText = '# 恢复后的人设\n';
      return { ok: true };
    },
  };

  const memory = {
    root: () => settings.memory.dir,
    layout: () => ({
      dir: settings.memory.dir,
      exists: true,
      files: [
        { name: 'MEMORY.md', size: 20, mtime: 1700000000000 },
        { name: 'notes/2026-10-25.md', size: 40, mtime: 1700000001000 },
      ],
      totalChars: 60,
    }),
    async readFile(rel) {
      calls.readFile.push(rel);
      if (rel === 'missing.md') throw new Error('文件不存在');
      return { path: settings.memory.dir + '/' + rel, text: memoryFiles[rel] ?? '' };
    },
    async writeFile(rel, text) {
      calls.writeFile.push([rel, text]);
      if (rel === 'bad.txt') return { ok: false, error: '仅支持 .md 文件' };
      memoryFiles[rel] = text;
      return { ok: true, path: settings.memory.dir + '/' + rel };
    },
    async saveFact({ text, tags }) {
      calls.saveFact.push({ text, tags });
      return { ok: true, duplicate: false, entry: { text, tags, at: '2026-10-25' }, file: 'notes/2026-10-25.md' };
    },
  };

  const collector = {
    async collectNow() {
      calls.collect += 1;
      return { ok: true, added: [{ text: '喜欢吃辣', tags: ['偏好'] }], scannedMessages: 12 };
    },
    stats() {
      return { enabled: true, roundsSinceCollect: 2, lastCollectAt: 1700000000000, lastError: '', totalCollected: 3 };
    },
  };

  const runtime = {
    ctx: {},
    config: {},
    logger: { warn() {}, error() {}, info() {}, debug() {} },
    settings: settingsStore,
    persona,
    memory,
    collector,
    promptComposer: {
      compose({ scope }) {
        calls.compose.push(scope);
        return '【人设】\nscope=' + scope;
      },
    },
    gateState: {
      peers: new Map([
        ['group:123456', { pending: [{ text: 'a' }, { text: 'b' }], firstPendingAt: 1700000000000 }],
        ['direct:987654', { pending: [] }],
      ]),
    },
    manager: undefined,
    stats: {
      received: 10,
      triggered: 4,
      skipped: 6,
      replies: 4,
      lastReplyAt: 1700000000000,
      lastTriggerReason: 'mode',
    },
    botState() {
      return {
        appId: '1904123456',
        ready: true,
        startedAt: now - 60000,
        lastError: '',
        sessionCount: 2,
        pending: [{ peerKey: 'group:123456', count: 1 }],
      };
    },
    async clearPending() {
      calls.clearPending += 1;
      return { ok: true };
    },
    async restartBot() {
      calls.restart += 1;
      return { ok: true };
    },
    cwd: '/tmp/dsh-qqbot-test/project/qqbot',
    stateDir: '/tmp/dsh-qqbot-test/.dsh-qqbot/buddy',
    mediaDir: '/tmp/dsh-qqbot-test/.dsh-qqbot/media',
    settingsFile: '/tmp/dsh-qqbot-test/.dsh-qqbot/buddy/settings.json',
    version: PKG_VERSION,
    __calls: calls,
  };
  return Object.assign(runtime, overrides);
}

// ── fake 表情包 store（sticker-dev 的 store 接口契约） ──────
function makeStickerStore() {
  const calls = { saved: [], updated: [], deleted: [], read: [] };
  const buffers = new Map([['laugh.png', Buffer.from('fake-png-bytes')]]);
  const items = [
    {
      name: 'laugh.png',
      path: '/tmp/stickers/laugh.png',
      size: 14,
      mtime: 1700000000000,
      emotion: '大笑',
      tags: ['开心'],
      note: '常用的',
      addedAt: 1699999999000,
      source: 'manual',
    },
  ];
  const store = {
    calls,
    dir: () => '/tmp/stickers',
    async list() {
      return items.slice();
    },
    async read(name) {
      calls.read.push(name);
      if (!buffers.has(name)) throw new Error('表情不存在: ' + name);
      return buffers.get(name);
    },
    async saveBuffer(buffer, options) {
      calls.saved.push({ length: buffer.length, options: options });
      const name = options && options.name ? options.name : 'sticker-new.png';
      buffers.set(name, buffer);
      const item = {
        name,
        path: '/tmp/stickers/' + name,
        size: buffer.length,
        mtime: 1700000001000,
        emotion: options && options.emotion ? options.emotion : '',
        tags: options && Array.isArray(options.tags) ? options.tags : [],
        note: options && options.note ? options.note : '',
        addedAt: 1700000001000,
        source: options && options.source ? options.source : 'upload',
      };
      items.push(item);
      return { ok: true, name, item, created: true };
    },
    async update(name, patch) {
      calls.updated.push({ name, patch });
      const item = items.find((entry) => entry.name === name);
      if (!item) return { ok: false, error: '表情不存在: ' + name };
      if (patch.emotion !== undefined) item.emotion = patch.emotion;
      if (patch.tags !== undefined) item.tags = patch.tags;
      if (patch.note !== undefined) item.note = patch.note;
      if (patch.renameTo !== undefined && patch.renameTo !== name) {
        const previous = item.name;
        item.name = patch.renameTo;
        const buffer = buffers.get(previous);
        if (buffer) {
          buffers.delete(previous);
          buffers.set(item.name, buffer);
        }
      }
      return { ok: true, item };
    },
    async delete(name) {
      calls.deleted.push(name);
      const index = items.findIndex((entry) => entry.name === name);
      if (index < 0) return { ok: false, error: '表情不存在: ' + name };
      items.splice(index, 1);
      buffers.delete(name);
      return { ok: true, removed: true };
    },
  };
  return store;
}

// ── 注册 / 释放 ─────────────────────────────────────────────
test('注册全部 API 路由，dispose 幂等', () => {
  const server = makeServer();
  const dispose = registerWebRoutes(makeCtx(server), makeRuntime());
  const expected = [
    '/state',
    '/persona',
    '/persona/restore',
    '/persona/cards',
    '/persona/cards/content',
    '/persona/cards/update',
    '/persona/cards/activate',
    '/persona/cards/delete',
    '/commands',
    '/settings',
    '/models',
    '/tools',
    '/presets',
    '/memory',
    '/memory/file',
    '/memory/append',
    '/memory/collect',
    '/phrases/suggestions',
    '/prompt',
    '/schema',
    '/action',
    '/stickers',
    '/stickers/file',
    '/stickers/upload',
    '/stickers/update',
    '/stickers/delete',
  ].map((suffix) => BASE + suffix);
  for (const fullPath of expected) assert.ok(server.routes.has(fullPath), '缺少路由 ' + fullPath);
  assert.equal(server.routes.size, expected.length);
  assert.ok(server.routes.has(BASE + '/models'), '新增的模型路由应已注册');

  dispose();
  assert.equal(server.routes.size, 0);
  dispose(); // 幂等
});

test('webServer 未就绪时走 ctx.inject 延迟注册', () => {
  let pending;
  const ctx = {
    get: () => undefined,
    inject(services, callback) {
      assert.deepEqual(services, ['webServer']);
      pending = callback;
      return () => {};
    },
  };
  const dispose = registerWebRoutes(ctx, makeRuntime());
  assert.equal(typeof pending, 'function');
  const server = makeServer();
  pending({ webServer: server });
  assert.ok(server.routes.has(BASE + '/state'));
  dispose();
});

test('ctx.get 抛错时不崩溃，仍返回 dispose', () => {
  const ctx = {
    get() {
      throw new Error('服务未注册');
    },
  };
  const dispose = registerWebRoutes(ctx, {});
  assert.equal(typeof dispose, 'function');
  dispose();
});

// ── GET /state ──────────────────────────────────────────────
test('GET /state 返回脱敏 botId、完整 settings、路径与生效摘要', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const { status, json, headers } = await call('GET', '/state');

  assert.equal(status, 200);
  assert.equal(headers['cache-control'], 'no-store');
  assert.match(headers['content-type'], /application\/json/);
  assert.equal(json.ok, true);
  assert.equal(json.version, PKG_VERSION);
  assert.equal(typeof json.now, 'number');

  assert.equal(json.bot.appId, '1904***456');
  assert.equal(json.bot.ready, true);
  assert.ok(json.bot.uptimeMs >= 59000);
  assert.equal(json.bot.sessionCount, 2);
  assert.equal(json.bot.pending.length, 1);

  assert.equal(json.stats.received, 10);
  assert.equal(json.stats.triggered, 4);
  assert.equal(json.stats.skipped, 6);
  assert.equal(json.stats.replies, 4);
  assert.equal(json.stats.lastTriggerReason, 'mode');

  assert.equal(json.settings.reply.countThreshold, 3);
  assert.equal(json.settings.persona.mode, 'replace');
  assert.equal(json.settings.memory.autoCollect.everyRounds, 6);

  assert.equal(json.paths.cwd, '/tmp/dsh-qqbot-test/project/qqbot');
  assert.equal(json.paths.stateDir, '/tmp/dsh-qqbot-test/.dsh-qqbot/buddy');
  assert.equal(json.paths.mediaDir, '/tmp/dsh-qqbot-test/.dsh-qqbot/media');
  assert.equal(json.paths.persona, '/tmp/dsh-qqbot-test/project/qqbot/persona.md');

  assert.equal(json.persona.exists, true);
  assert.equal(json.persona.bytes > 0, true);
  assert.equal(json.memory.files.length, 2);
  assert.equal(json.memory.totalChars, 60);

  assert.match(json.effective.summary, /每累计 3 条群消息回复一次/);
  assert.match(json.effective.summary, /@\/回复必回/);
  assert.equal(json.effective.pending.length, 1);
  const pendingItem = json.effective.pending[0];
  assert.equal(pendingItem.peerKey, 'group:123456');
  assert.equal(pendingItem.scope, 'group');
  assert.equal(pendingItem.peerId, '123456');
  assert.equal(pendingItem.count, 2);
  assert.equal(pendingItem.oldestAt, 1700000000000);
  assert.equal(typeof pendingItem.waitingMs, 'number');
  assert.ok(pendingItem.waitingMs >= 0);
});

test('GET /state 在 runtime 字段缺失/抛错时可降级返回', async () => {
  const broken = makeRuntime({
    settings: {
      get() {
        throw new Error('坏设置');
      },
    },
    botState() {
      throw new Error('bot 挂了');
    },
    persona: {
      read() {
        throw new Error('人设坏了');
      },
    },
    memory: {
      layout() {
        throw new Error('记忆坏了');
      },
    },
    stats: undefined,
    gateState: undefined,
  });
  const { call } = makeClient(broken);
  const { status, json } = await call('GET', '/state');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.bot.appId, '');
  assert.equal(json.bot.ready, false);
  assert.equal(json.settings.version, undefined);
  assert.equal(json.persona.exists, false);
  assert.equal(json.memory.exists, false);
  assert.deepEqual(json.stats, { received: 0, triggered: 0, skipped: 0, replies: 0, lastReplyAt: 0, lastTriggerReason: '' });
  assert.deepEqual(json.effective.pending, []);
});

test('GET /state 在 runtime 几乎为空时仍返回 ok', async () => {
  const { call } = makeClient({});
  const { status, json } = await call('GET', '/state');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.version, PKG_VERSION);
  assert.equal(json.bot.appId, '');
  assert.deepEqual(json.settings, {});
});

// ── persona ─────────────────────────────────────────────────
test('GET /persona 返回正文、元信息与备份列表', async () => {
  const { call } = makeClient(makeRuntime());
  const { status, json } = await call('GET', '/persona');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.match(json.text, /阿漆/);
  assert.equal(json.path, '/tmp/dsh-qqbot-test/project/qqbot/persona.md');
  assert.equal(json.exists, true);
  assert.ok(json.bytes > 0);
  assert.equal(json.backups.length, 1);
  assert.equal(json.backups[0].name, 'persona-20261025-120000-save.md');
});

test('POST /persona 保存并返回备份名', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const { status, json } = await call('POST', '/persona', { body: { text: '新人设内容' } });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, backup: 'persona-20261025-120000-save.md' });
  assert.deepEqual(runtime.__calls.personaWrite, ['新人设内容']);
});

test('POST /persona 缺少 text / text 非字符串 → 400', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  for (const body of [{}, { text: 123 }]) {
    const { status, json } = await call('POST', '/persona', { body });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.match(json.error, /text/);
  }
  assert.equal(runtime.__calls.personaWrite.length, 0);
});

test('POST /persona 人设存储不可用时 → 503', async () => {
  const { call } = makeClient({});
  const { status, json } = await call('POST', '/persona', { body: { text: 'x' } });
  assert.equal(status, 503);
  assert.equal(json.ok, false);
});

test('POST /persona/restore 成功、非法名、备份不存在', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);

  const ok = await call('POST', '/persona/restore', { body: { name: 'persona-20261025-120000-save.md' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });

  const empty = await call('POST', '/persona/restore', { body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.ok, false);

  const missing = await call('POST', '/persona/restore', { body: { name: 'missing.md' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);
  assert.match(missing.json.error, /不存在/);
});

// ── settings ────────────────────────────────────────────────
test('POST /settings 深合并 patch 并返回完整 settings + changed', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const { status, json } = await call('POST', '/settings', {
    body: { patch: { reply: { countThreshold: 8 }, triggers: { keywords: ['阿漆'] } } },
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.settings.reply.countThreshold, 8);
  assert.deepEqual(json.settings.triggers.keywords, ['阿漆']);
  assert.deepEqual(json.changed, ['reply', 'triggers']);
  assert.equal(runtime.__calls.patch.length, 1);
});

test('POST /settings patch 非法 / 缺失 → 400', async () => {
  const { call } = makeClient(makeRuntime());
  for (const body of [{}, { patch: 'x' }, { patch: [1, 2] }]) {
    const { status, json } = await call('POST', '/settings', { body });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.match(json.error, /patch/);
  }
});

test('POST /settings 设置存储不可用 → 503', async () => {
  const { call } = makeClient({});
  const { status, json } = await call('POST', '/settings', { body: { patch: { reply: { enabled: false } } } });
  assert.equal(status, 503);
  assert.equal(json.ok, false);
});

// ── memory ──────────────────────────────────────────────────
test('GET /memory 返回目录概要与文件列表（只含 name/size/mtime）', async () => {
  const { call } = makeClient(makeRuntime());
  const { status, json } = await call('GET', '/memory');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.dir, '/tmp/dsh-qqbot-test/project/qqbot/memory');
  assert.equal(json.exists, true);
  assert.equal(json.totalChars, 60);
  assert.equal(json.files.length, 2);
  assert.deepEqual(Object.keys(json.files[0]).sort(), ['mtime', 'name', 'size']);
});

test('GET /memory/file 默认读 MEMORY.md，可读取子路径', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const first = await call('GET', '/memory/file');
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.match(first.json.text, /喜欢猫/);
  assert.equal(runtime.__calls.readFile[0], 'MEMORY.md');

  const nested = await call('GET', '/memory/file', { query: { path: 'notes/2026-10-25.md' } });
  assert.equal(nested.status, 200);
  assert.equal(runtime.__calls.readFile[1], 'notes/2026-10-25.md');
});

test('GET /memory/file 拒绝路径越界（.. 与绝对路径）', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const cases = ['../etc/passwd', '../../secret.md', '/etc/passwd', 'notes/../../x.md', 'notes/../a.md', '..\\..\\win.ini'];
  for (const path of cases) {
    const { status, json } = await call('GET', '/memory/file', { query: { path } });
    assert.equal(status, 400, '应拒绝 ' + path);
    assert.equal(json.ok, false);
    assert.match(json.error, /不合法|越界/);
  }
  assert.equal(runtime.__calls.readFile.length, 0);
});

test('GET /memory/file 记忆模块抛错 / 不可用', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const missing = await call('GET', '/memory/file', { query: { path: 'missing.md' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);

  const noMemory = makeClient({ memory: undefined });
  const unavailable = await noMemory.call('GET', '/memory/file');
  assert.equal(unavailable.status, 503);
});

test('POST /memory/file 写入成功 / 缺 text / 越界 / 模块拒绝', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);

  const ok = await call('POST', '/memory/file', { body: { path: 'MEMORY.md', text: '- 新事实' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.path, '/tmp/dsh-qqbot-test/project/qqbot/memory/MEMORY.md');
  assert.deepEqual(runtime.__calls.writeFile[0], ['MEMORY.md', '- 新事实']);

  const noText = await call('POST', '/memory/file', { body: { path: 'MEMORY.md' } });
  assert.equal(noText.status, 400);

  const traversal = await call('POST', '/memory/file', { body: { path: '../outside.md', text: 'x' } });
  assert.equal(traversal.status, 400);
  assert.equal(runtime.__calls.writeFile.length, 1);

  const rejected = await call('POST', '/memory/file', { body: { path: 'bad.txt', text: 'x' } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.error, /仅支持/);
});

test('POST /memory/append 记录手记，tags 过滤非字符串', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const { status, json } = await call('POST', '/memory/append', {
    body: { text: '阿漆喜欢猫', tags: ['偏好', 123, '  ', '猫'] },
  });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.duplicate, false);
  assert.match(json.entry.text, /喜欢猫/);
  assert.deepEqual(runtime.__calls.saveFact[0].tags, ['偏好', '猫']);

  const empty = await call('POST', '/memory/append', { body: { text: '   ' } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /不能为空/);
});

test('POST /memory/append 记忆模块返回失败 → 400', async () => {
  const runtime = makeRuntime({
    memory: {
      layout: () => ({ dir: '/tmp/memory', exists: false, files: [], totalChars: 0 }),
      async saveFact() {
        return { ok: false, error: '仅支持 .md 文件' };
      },
    },
  });
  const { call } = makeClient(runtime);
  const { status, json } = await call('POST', '/memory/append', { body: { text: 'x' } });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
});

test('POST /memory/collect 成功返回 added/scannedMessages/stats，缺模块 503，异常 500', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const ok = await call('POST', '/memory/collect', { body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.added.length, 1);
  assert.equal(ok.json.scannedMessages, 12);
  assert.equal(ok.json.stats.totalCollected, 3);
  assert.equal(runtime.__calls.collect, 1);

  const noCollector = makeClient({ collector: undefined });
  const unavailable = await noCollector.call('POST', '/memory/collect', { body: {} });
  assert.equal(unavailable.status, 503);

  const failing = makeClient({
    collector: {
      async collectNow() {
        throw new Error('模型超时');
      },
      stats: () => ({}),
    },
  });
  const failed = await failing.call('POST', '/memory/collect', { body: {} });
  assert.equal(failed.status, 500);
  assert.equal(failed.json.ok, false);
  assert.match(failed.json.error, /模型超时/);
});

// ── prompt ──────────────────────────────────────────────────
test('GET /prompt 按 scope 组合 prompt（默认 group）', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);

  const group = await call('GET', '/prompt');
  assert.equal(group.status, 200);
  assert.equal(group.json.ok, true);
  assert.match(group.json.text, /scope=group/);

  const direct = await call('GET', '/prompt', { query: { scope: 'direct' } });
  assert.match(direct.json.text, /scope=direct/);

  const bogus = await call('GET', '/prompt', { query: { scope: 'bogus' } });
  assert.match(bogus.json.text, /scope=group/);
  assert.deepEqual(runtime.__calls.compose, ['group', 'direct', 'group']);
});

test('GET /prompt 组合器不可用 / 抛错', async () => {
  const unavailable = makeClient({ promptComposer: undefined });
  const res = await unavailable.call('GET', '/prompt');
  assert.equal(res.status, 503);

  const failing = makeClient({
    promptComposer: {
      compose() {
        throw new Error('组装失败');
      },
    },
  });
  const failed = await failing.call('GET', '/prompt');
  assert.equal(failed.status, 500);
  assert.equal(failed.json.ok, false);
});

// ── action ──────────────────────────────────────────────────
test('POST /action clear-pending', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const { status, json } = await call('POST', '/action', { body: { action: 'clear-pending' } });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.match(json.message, /清空/);
  assert.equal(runtime.__calls.clearPending, 1);

  const unsupported = makeClient({ clearPending: undefined });
  const no = await unsupported.call('POST', '/action', { body: { action: 'clear-pending' } });
  assert.equal(no.status, 501);
  assert.equal(no.json.ok, false);
});

test('POST /action reconnect（支持 / 未实现）', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const ok = await call('POST', '/action', { body: { action: 'reconnect' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(runtime.__calls.restart, 1);

  const unsupported = makeClient({ restartBot: undefined });
  const no = await unsupported.call('POST', '/action', { body: { action: 'reconnect' } });
  assert.equal(no.status, 501);
  assert.match(no.json.error, /不支持/);
});

test('POST /action reset-settings 用默认值 replace，未知 action → 400', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const { status, json } = await call('POST', '/action', { body: { action: 'reset-settings' } });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.match(json.message, /已恢复默认设置/);
  assert.equal(runtime.__calls.replace.length, 1);
  assert.equal(runtime.__calls.replace[0].reply.countThreshold, 3);

  for (const body of [{ action: 'unknown' }, {}]) {
    const res = await call('POST', '/action', { body });
    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
  }
});

// ── 请求体 / 方法 / 错误兜底 ────────────────────────────────
test('请求体超过 1MB → 413 且只返回一次错误 JSON', async () => {
  const client = makeClient(makeRuntime());
  const huge = JSON.stringify({
    patch: { behavior: { extraInstructions: 'a'.repeat(1024 * 1024 + 64) } },
  });
  const { status, json } = await client.call('POST', '/settings', { rawBody: huge });
  assert.equal(status, 413);
  assert.equal(json.ok, false);
  assert.match(json.error, /1MB/);
  // 超限时不能销毁请求连接，否则客户端收不到这条 JSON 错误（只会看到 reset）
  assert.equal(client.lastReq.destroyed, false);
});

test('非法 JSON → 400，空 body → 400（缺 patch）', async () => {
  const { call } = makeClient(makeRuntime());
  const bad = await call('POST', '/settings', { rawBody: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.error, /JSON/);

  const empty = await call('POST', '/settings', { rawBody: '' });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.ok, false);
});

test('方法不允许 → 405', async () => {
  const { call } = makeClient(makeRuntime());
  const getAction = await call('GET', '/action');
  assert.equal(getAction.status, 405);
  assert.equal(getAction.json.ok, false);

  const postState = await call('POST', '/state', { body: {} });
  assert.equal(postState.status, 405);
  assert.equal(postState.json.ok, false);
});

// ── 模型切换（2026-10-25 追加需求） ──────────────────────────
function withServices(services, extra = {}) {
  return makeRuntime(
    Object.assign(
      {
        ctx: {
          get(name) {
            return services ? services[name] : undefined;
          },
        },
      },
      extra,
    ),
  );
}

test('GET /models 归一化 provider/model 形状，单个 provider 失败只跳过它', async () => {
  const llm = {
    async listProviders() {
      return [{ id: 'deepseek', name: 'DeepSeek' }, 'openai', { id: '' }, 42];
    },
    async listModels(provider) {
      if (provider === 'deepseek') {
        return [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }, 'deepseek-reasoner'];
      }
      if (provider === 'openai') throw new Error('网络错误');
      return [];
    },
  };
  const agentDefaultModel = {
    currentSelection: () => ({ provider: 'host-p', model: 'host-m', reasoningEffort: 'medium' }),
  };
  const runtime = withServices({ llm: llm, agentDefaultModel: agentDefaultModel });
  await runtime.settings.patch({ model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } });

  const { call } = makeClient(runtime);
  const { status, json } = await call('GET', '/models');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.providers.length, 2);
  assert.deepEqual(json.providers[0], {
    id: 'deepseek',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'deepseek-reasoner' },
    ],
  });
  assert.deepEqual(json.providers[1], { id: 'openai', models: [] });
  assert.deepEqual(json.default, { provider: 'host-p', model: 'host-m', reasoningEffort: 'medium' });
  assert.deepEqual(json.selected, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' });
  assert.equal(json.source, 'settings');
  assert.equal(json.note, undefined);
});

test('GET /models LLM 不可用 / listProviders 抛错时降级 providers:[] + note', async () => {
  const noLlm = makeClient(makeRuntime());
  const unavailable = await noLlm.call('GET', '/models');
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.json.ok, true);
  assert.deepEqual(unavailable.json.providers, []);
  // DESIGN：default 始终是三元组对象，宿主无默认时为空值（不是 null）
  assert.deepEqual(unavailable.json.default, { provider: '', model: '', reasoningEffort: '' });
  assert.deepEqual(unavailable.json.selected, { provider: '', model: '', reasoningEffort: '' });
  assert.equal(unavailable.json.source, 'host');
  assert.match(unavailable.json.note, /LLM 服务不可用/);

  const brokenLlm = {
    async listProviders() {
      throw new Error('目录损坏');
    },
    async listModels() {
      return [];
    },
  };
  const broken = makeClient(withServices({ llm: brokenLlm }));
  const res = await broken.call('GET', '/models');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.providers, []);
  assert.match(res.json.note, /目录损坏/);
});

test('GET /state model 优先级：settings > config > host', async () => {
  const agentDefaultModel = {
    currentSelection: () => ({ provider: 'host-p', model: 'host-m', reasoningEffort: 'low' }),
  };

  // 只有 host：source=host
  const hostOnly = makeClient(withServices({ agentDefaultModel: agentDefaultModel }));
  const hostState = await hostOnly.call('GET', '/state');
  assert.deepEqual(hostState.json.model.effective, { provider: 'host-p', model: 'host-m', reasoningEffort: 'low' });
  assert.equal(hostState.json.model.source, 'host');
  assert.deepEqual(hostState.json.model.selected, { provider: '', model: '', reasoningEffort: '' });

  // config 覆盖 host
  const withConfig = makeClient(
    withServices({ agentDefaultModel: agentDefaultModel }, { config: { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'high' } }),
  );
  const cfgState = await withConfig.call('GET', '/state');
  assert.deepEqual(cfgState.json.model.effective, { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'high' });
  assert.equal(cfgState.json.model.source, 'config');

  // settings 覆盖 config
  const runtime = withServices(
    { agentDefaultModel: agentDefaultModel },
    { config: { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'high' } },
  );
  await runtime.settings.patch({ model: { provider: 'set-p', model: 'set-m', reasoningEffort: 'max' } });
  const settingsState = await makeClient(runtime).call('GET', '/state');
  assert.deepEqual(settingsState.json.model.selected, { provider: 'set-p', model: 'set-m', reasoningEffort: 'max' });
  assert.deepEqual(settingsState.json.model.effective, { provider: 'set-p', model: 'set-m', reasoningEffort: 'max' });
  assert.equal(settingsState.json.model.source, 'settings');
});

test('POST /action apply-model：成功 / 未实现 501 / 异常 500 / 返回失败 400', async () => {
  let resets = 0;
  const runtime = makeRuntime({
    async resetAllSessions() {
      resets += 1;
      return { ok: true };
    },
  });
  const { call } = makeClient(runtime);
  const ok = await call('POST', '/action', { body: { action: 'apply-model' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.match(ok.json.message, /已重置 bot 会话，下一条消息将使用新模型/);
  assert.equal(resets, 1);

  const missing = makeClient(makeRuntime());
  const unsupported = await missing.call('POST', '/action', { body: { action: 'apply-model' } });
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.json.ok, false);
  assert.match(unsupported.json.error, /不支持/);

  const throwing = makeClient(
    makeRuntime({
      async resetAllSessions() {
        throw new Error('agents 服务不可用');
      },
    }),
  );
  const failed = await throwing.call('POST', '/action', { body: { action: 'apply-model' } });
  assert.equal(failed.status, 500);
  assert.equal(failed.json.ok, false);
  assert.match(failed.json.error, /agents 服务不可用/);

  const refusing = makeClient(
    makeRuntime({
      async resetAllSessions() {
        return { ok: false, error: '没有可重置的会话' };
      },
    }),
  );
  const refused = await refusing.call('POST', '/action', { body: { action: 'apply-model' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.ok, false);
  assert.match(refused.json.error, /没有可重置的会话/);
});

test('GET /state model 优先采用 runtime.getModelInfoSync()，异常时回退本地计算', async () => {
  const runtime = makeRuntime({
    getModelInfoSync: () => ({
      selected: { provider: 'mgr-sel-p', model: 'mgr-sel-m', reasoningEffort: '' },
      effective: { provider: 'mgr-eff-p', model: 'mgr-eff-m', reasoningEffort: 'high' },
      source: 'settings',
      hostDefault: { provider: 'host-p', model: 'host-m' },
    }),
  });
  const state = (await makeClient(runtime).call('GET', '/state')).json;
  assert.deepEqual(state.model, {
    selected: { provider: 'mgr-sel-p', model: 'mgr-sel-m', reasoningEffort: '' },
    effective: { provider: 'mgr-eff-p', model: 'mgr-eff-m', reasoningEffort: 'high' },
    source: 'settings',
  });

  // source='none' / effective=null 归一成 DESIGN 的三值枚举与空三元组
  const noneRuntime = makeRuntime({
    getModelInfoSync: () => ({
      selected: { provider: '', model: '', reasoningEffort: '' },
      effective: null,
      source: 'none',
    }),
  });
  const noneState = (await makeClient(noneRuntime).call('GET', '/state')).json;
  assert.equal(noneState.model.source, 'host');
  assert.deepEqual(noneState.model.effective, { provider: '', model: '', reasoningEffort: '' });

  // getModelInfoSync 抛错时回退到 config 计算，不影响 /state
  const brokenRuntime = makeRuntime({
    config: { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'low' },
    getModelInfoSync() {
      throw new Error('manager 未就绪');
    },
  });
  const brokenState = (await makeClient(brokenRuntime).call('GET', '/state')).json;
  assert.deepEqual(brokenState.model.effective, { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'low' });
  assert.equal(brokenState.model.source, 'config');
});

// ── Agent preset / features（2026-10-25 深夜追加需求） ──────
test('GET /presets 归一化 preset 列表并返回 selected/effective/defaultPreset', async () => {
  const runtime = makeRuntime({
    config: { preset: 'qqbot-buddy' },
    async listPresets() {
      return [
        { id: 'qqbot-buddy', name: 'QQ 机器人内置组合', description: '内置组合', order: 1 },
        { id: 'chatonly', name: 'Chatonly', broken: '激活失败：缺少插件' },
        { id: '  ', name: '空白 id' },
        'oops',
        { id: 'chatonly', name: '重复项' },
        { id: 'plain' },
      ];
    },
  });
  await runtime.settings.patch({ agent: { preset: 'chatonly' } });
  const { status, json } = await makeClient(runtime).call('GET', '/presets');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.presets, [
    { id: 'qqbot-buddy', name: 'QQ 机器人内置组合', description: '内置组合', broken: false },
    { id: 'chatonly', name: 'Chatonly', description: '', broken: true },
    { id: 'plain', name: 'plain', description: '', broken: false },
  ]);
  assert.equal(json.selected, 'chatonly');
  assert.equal(json.effective, 'chatonly');
  assert.equal(json.defaultPreset, 'qqbot-buddy');
  assert.equal(json.note, undefined);
});

test('GET /presets selected 为空时 effective 回退 defaultPreset，服务不可用时降级不报错', async () => {
  const runtime = makeRuntime({ config: { preset: 'cfg-preset' }, async listPresets() { return []; } });
  const configured = await makeClient(runtime).call('GET', '/presets');
  assert.equal(configured.status, 200);
  assert.equal(configured.json.selected, '');
  assert.equal(configured.json.effective, 'cfg-preset');
  assert.equal(configured.json.defaultPreset, 'cfg-preset');
  assert.match(configured.json.note, /未提供可枚举/);

  const bare = makeClient(makeRuntime());
  const unavailable = await bare.call('GET', '/presets');
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.json.ok, true);
  assert.deepEqual(unavailable.json.presets, []);
  assert.equal(unavailable.json.effective, 'qqbot-buddy');
  assert.equal(unavailable.json.defaultPreset, 'qqbot-buddy');
  assert.match(unavailable.json.note, /服务不可用/);
});

test('GET /presets 回退 ctx.get(agentPresets).list()；两类失败均 presets:[] + note', async () => {
  const service = {
    async list() {
      return [{ id: 'host-preset', name: '宿主预设', description: '来自宿主' }];
    },
  };
  const runtime = makeRuntime({
    ctx: { get: (name) => (name === 'agentPresets' ? service : undefined) },
    config: { preset: 'qqbot-buddy' },
  });
  const viaService = await makeClient(runtime).call('GET', '/presets');
  assert.deepEqual(viaService.json.presets, [
    { id: 'host-preset', name: '宿主预设', description: '来自宿主', broken: false },
  ]);
  assert.equal(viaService.json.note, undefined);

  // runtime.listPresets 抛错 → 回退 service，成功时清掉首次失败 note
  const fallbackRuntime = makeRuntime({
    ctx: { get: (name) => (name === 'agentPresets' ? service : undefined) },
    config: { preset: 'qqbot-buddy' },
    async listPresets() {
      throw new Error('registry 未就绪');
    },
  });
  const fallback = await makeClient(fallbackRuntime).call('GET', '/presets');
  assert.equal(fallback.status, 200);
  assert.equal(fallback.json.presets.length, 1);
  assert.equal(fallback.json.note, undefined);

  // service.list 抛错 → 降级 note
  const broken = makeRuntime({
    ctx: {
      get: (name) =>
        name === 'agentPresets'
          ? { async list() { throw new Error('registry 损坏'); } }
          : undefined,
    },
  });
  const brokenRes = await makeClient(broken).call('GET', '/presets');
  assert.equal(brokenRes.status, 200);
  assert.equal(brokenRes.json.ok, true);
  assert.deepEqual(brokenRes.json.presets, []);
  assert.match(brokenRes.json.note, /registry 损坏/);
});

test('GET /state agent 与 features：preset 优先级与开关快照', async () => {
  const runtime = makeRuntime({ config: { preset: 'qqbot-buddy' } });
  await runtime.settings.patch({
    agent: { preset: 'host-preset' },
    features: { workspace: false, web: true, stickers: false, vision: true, memory: false },
  });
  const state = (await makeClient(runtime).call('GET', '/state')).json;
  assert.deepEqual(state.agent, { selectedPreset: 'host-preset', effectivePreset: 'host-preset', builtIn: false });
  assert.deepEqual(state.features, { workspace: false, web: true, stickers: false, vision: true, memory: false });

  // 清空选择 → effective 回退 config.preset（内置组合）
  await runtime.settings.patch({ agent: { preset: '' } });
  const builtInState = (await makeClient(runtime).call('GET', '/state')).json;
  assert.deepEqual(builtInState.agent, { selectedPreset: '', effectivePreset: 'qqbot-buddy', builtIn: true });

  // config.preset 非内置时 builtIn=false
  const hostCfg = makeRuntime({ config: { preset: 'cfg-preset' } });
  const hostState = (await makeClient(hostCfg).call('GET', '/state')).json;
  assert.deepEqual(hostState.agent, { selectedPreset: '', effectivePreset: 'cfg-preset', builtIn: false });

  // runtime 几乎为空时：内置组合 + 功能全开
  const emptyState = (await makeClient({}).call('GET', '/state')).json;
  assert.deepEqual(emptyState.agent, { selectedPreset: '', effectivePreset: 'qqbot-buddy', builtIn: true });
  assert.deepEqual(emptyState.features, { workspace: true, web: true, stickers: true, vision: true, memory: true });
});

test('runtime.presetInfo() 优先用于 state.agent 与 /presets，异常时回退本地计算', async () => {
  const runtime = makeRuntime({
    presetInfo: () => ({ selected: 'p-sel', effective: 'p-eff', builtIn: false, defaultPreset: 'p-default' }),
    async listPresets() {
      return [{ id: 'p-eff', name: '有效预设' }];
    },
  });
  const client = makeClient(runtime);
  const state = (await client.call('GET', '/state')).json;
  assert.deepEqual(state.agent, { selectedPreset: 'p-sel', effectivePreset: 'p-eff', builtIn: false });
  const presets = (await client.call('GET', '/presets')).json;
  assert.equal(presets.selected, 'p-sel');
  assert.equal(presets.effective, 'p-eff');
  assert.equal(presets.defaultPreset, 'p-default');

  // presetInfo 抛错 → 回退 config.preset 计算
  const broken = makeRuntime({
    config: { preset: 'cfg-preset' },
    presetInfo() {
      throw new Error('manager 未就绪');
    },
  });
  const brokenState = (await makeClient(broken).call('GET', '/state')).json;
  assert.deepEqual(brokenState.agent, { selectedPreset: '', effectivePreset: 'cfg-preset', builtIn: false });
});

// ── 表情包管理 API（2026-10-26 追加需求） ───────────────────
function pngDataUrl(text) {
  return 'data:image/png;base64,' + Buffer.from(String(text), 'utf8').toString('base64');
}

test('GET /stickers 返回目录/开关/上限与带 url 的 items', async () => {
  const runtime = makeRuntime({ stickers: makeStickerStore() });
  await runtime.settings.patch({
    features: { stickers: false },
    stickers: { collectEnabled: false, maxMB: 5 },
  });
  const { status, json, headers } = await makeClient(runtime).call('GET', '/stickers');
  assert.equal(status, 200);
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(json.ok, true);
  assert.equal(json.dir, '/tmp/stickers');
  assert.equal(json.collectEnabled, false);
  assert.equal(json.featuresStickers, false);
  assert.equal(json.maxMB, 5);
  assert.equal(json.items.length, 1);
  assert.deepEqual(json.items[0], {
    name: 'laugh.png',
    emotion: '大笑',
    tags: ['开心'],
    note: '常用的',
    size: 14,
    mtime: 1700000000000,
    addedAt: 1699999999000,
    source: 'manual',
    url: '/qqbot-buddy/api/stickers/file?name=laugh.png',
  });

  // store 缺失 → 503（sticker-dev 未装配时降级）
  const unavailable = await makeClient(makeRuntime()).call('GET', '/stickers');
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.json.ok, false);
});

test('GET /stickers/file 返回图片二进制；非法名 400、不存在 404', async () => {
  const store = makeStickerStore();
  const runtime = makeRuntime({ stickers: store });
  const client = makeClient(runtime);

  const ok = await client.call('GET', '/stickers/file', { query: { name: 'laugh.png' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'image/png');
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.json.raw, 'fake-png-bytes');

  for (const name of ['../../etc/passwd', '/etc/passwd', 'notes/laugh.png', 'a.txt', '.hidden.png', '']) {
    const bad = await client.call('GET', '/stickers/file', { query: name === '' ? {} : { name } });
    assert.equal(bad.status, 400, '应拒绝非法文件名：' + name);
    assert.equal(bad.json.ok, false);
  }

  const missing = await client.call('GET', '/stickers/file', { query: { name: 'missing.png' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);
  assert.match(missing.json.error, /不存在/);
});

test('POST /stickers/upload 解析 data URL 保存；非法/超限/缺 store 的错误分支', async () => {
  const store = makeStickerStore();
  const runtime = makeRuntime({ stickers: store });
  const client = makeClient(runtime);

  const ok = await client.call('POST', '/stickers/upload', {
    body: {
      dataUrl: pngDataUrl('uploaded-bytes'),
      name: 'hehe.png',
      emotion: ' 开心 ',
      tags: ['日常', 42, '  ', '开心'],
      note: ' 备注 ',
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.item.name, 'hehe.png');
  assert.equal(ok.json.item.emotion, '开心');
  assert.deepEqual(ok.json.item.tags, ['日常', '开心']);
  assert.equal(ok.json.item.note, '备注');
  assert.equal(ok.json.item.url, '/qqbot-buddy/api/stickers/file?name=hehe.png');
  assert.equal(store.calls.saved.length, 1);
  assert.equal(store.calls.saved[0].options.name, 'hehe.png');
  assert.equal(store.calls.saved[0].options.source, 'upload');
  assert.equal(store.calls.saved[0].options.emotion, '开心');
  assert.equal(store.calls.saved[0].length, Buffer.byteLength('uploaded-bytes'));

  // name 允许不带扩展名（store 自动按 magic bytes 补扩展名）
  const noExt = await client.call('POST', '/stickers/upload', {
    body: { dataUrl: pngDataUrl('no-ext-bytes'), name: 'noext' },
  });
  assert.equal(noExt.status, 200);
  assert.equal(store.calls.saved[1].options.name, 'noext');

  const noData = await client.call('POST', '/stickers/upload', { body: {} });
  assert.equal(noData.status, 400);
  const badData = await client.call('POST', '/stickers/upload', {
    body: { dataUrl: 'data:text/plain;base64,eA==' },
  });
  assert.equal(badData.status, 400);
  const badName = await client.call('POST', '/stickers/upload', {
    body: { dataUrl: pngDataUrl('x'), name: '../evil.png' },
  });
  assert.equal(badName.status, 400);

  // 单张上限：把 maxMB 调成 1，再传 1MB+ 的图片 → 413
  await runtime.settings.patch({ stickers: { maxMB: 1 } });
  const big = Buffer.alloc(1024 * 1024 + 16, 0x61);
  const oversize = await client.call('POST', '/stickers/upload', {
    body: { dataUrl: 'data:image/png;base64,' + big.toString('base64') },
  });
  assert.equal(oversize.status, 413);
  assert.match(oversize.json.error, /上限/);

  const unavailable = await makeClient(makeRuntime()).call('POST', '/stickers/upload', {
    body: { dataUrl: pngDataUrl('x') },
  });
  assert.equal(unavailable.status, 503);
});

test('POST /stickers/update 更新元数据/重命名与错误分支', async () => {
  const store = makeStickerStore();
  const runtime = makeRuntime({ stickers: store });
  const client = makeClient(runtime);

  const ok = await client.call('POST', '/stickers/update', {
    body: { name: 'laugh.png', emotion: '微笑', tags: ['开心', '日常'], note: '改过了' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.item.emotion, '微笑');
  assert.deepEqual(ok.json.item.tags, ['开心', '日常']);
  assert.equal(ok.json.item.note, '改过了');
  assert.deepEqual(store.calls.updated[0], {
    name: 'laugh.png',
    patch: { emotion: '微笑', tags: ['开心', '日常'], note: '改过了' },
  });

  const renamed = await client.call('POST', '/stickers/update', {
    body: { name: 'laugh.png', renameTo: 'laugh2.png' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.item.name, 'laugh2.png');
  assert.equal(renamed.json.item.url, '/qqbot-buddy/api/stickers/file?name=laugh2.png');

  const badName = await client.call('POST', '/stickers/update', { body: { name: '../x.png', emotion: 'x' } });
  assert.equal(badName.status, 400);
  const badRename = await client.call('POST', '/stickers/update', {
    body: { name: 'laugh2.png', renameTo: 'x.txt' },
  });
  assert.equal(badRename.status, 400);
  const noFields = await client.call('POST', '/stickers/update', { body: { name: 'laugh2.png' } });
  assert.equal(noFields.status, 400);

  const missing = await client.call('POST', '/stickers/update', {
    body: { name: 'missing.png', emotion: 'x' },
  });
  assert.equal(missing.status, 404);
});

test('POST /stickers/delete 删除与错误分支', async () => {
  const store = makeStickerStore();
  const runtime = makeRuntime({ stickers: store });
  const client = makeClient(runtime);

  const ok = await client.call('POST', '/stickers/delete', { body: { name: 'laugh.png' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  assert.deepEqual(store.calls.deleted, ['laugh.png']);

  const badName = await client.call('POST', '/stickers/delete', { body: { name: '../laugh.png' } });
  assert.equal(badName.status, 400);
  const missing = await client.call('POST', '/stickers/delete', { body: { name: 'missing.png' } });
  assert.equal(missing.status, 404);
  const unavailable = await makeClient(makeRuntime()).call('POST', '/stickers/delete', {
    body: { name: 'laugh.png' },
  });
  assert.equal(unavailable.status, 503);
});

// ── adaptive 回复模式 + 表情包每日上限（2026-10-26 晚追加需求） ──
test('GET /state effective.summary 支持 adaptive 模式的参数与默认值', async () => {
  const runtime = makeRuntime();
  await runtime.settings.patch({
    reply: {
      groupMode: 'adaptive',
      adaptive: { debounceSeconds: 5, cooldownSeconds: 30, maxWaitSeconds: 60, requireRelevance: false },
    },
  });
  let state = (await makeClient(runtime).call('GET', '/state')).json;
  assert.equal(state.settings.reply.groupMode, 'adaptive');
  assert.deepEqual(state.settings.reply.adaptive, {
    debounceSeconds: 5,
    cooldownSeconds: 30,
    maxWaitSeconds: 60,
    requireRelevance: false,
  });
  assert.match(state.effective.summary, /自适应：静默 5 秒后回一次/);
  assert.match(state.effective.summary, /冷却 30 秒/);
  assert.match(state.effective.summary, /最长等待 60 秒/);
  assert.doesNotMatch(state.effective.summary, /只回问句/);

  // 只开 adaptive、不带参数 → 用默认 4/12/20 且 requireRelevance 默认开启
  const defaultsRuntime = makeRuntime();
  await defaultsRuntime.settings.patch({ reply: { groupMode: 'adaptive' } });
  state = (await makeClient(defaultsRuntime).call('GET', '/state')).json;
  assert.match(state.effective.summary, /自适应：静默 4 秒后回一次/);
  assert.match(state.effective.summary, /冷却 12 秒/);
  assert.match(state.effective.summary, /最长等待 20 秒/);
  assert.match(state.effective.summary, /只回问句/);

  // 保存 adaptive patch 时深合并保留其它 adaptive 值
  const saved = await makeClient(defaultsRuntime).call('POST', '/settings', {
    body: { patch: { reply: { groupMode: 'adaptive', adaptive: { debounceSeconds: 7 } } } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.reply.adaptive.debounceSeconds, 7);
  assert.equal(saved.json.settings.reply.adaptive.cooldownSeconds, 12);
  const after = (await makeClient(defaultsRuntime).call('GET', '/state')).json;
  assert.match(after.effective.summary, /自适应：静默 7 秒后回一次/);
});

test('settings.stickers.dailyLimit 保存/读取可透出到 state', async () => {
  const runtime = makeRuntime();
  const { call } = makeClient(runtime);
  const saved = await call('POST', '/settings', {
    body: { patch: { stickers: { dailyLimit: 25, collectEnabled: false } } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.stickers.dailyLimit, 25);
  assert.equal(saved.json.settings.stickers.collectEnabled, false);
  assert.equal(saved.json.settings.stickers.maxMB, 8, '未改动的字段应保留');

  const state = (await call('GET', '/state')).json;
  assert.equal(state.settings.stickers.dailyLimit, 25);
  assert.equal(state.settings.stickers.collectEnabled, false);
});

test('GET /stickers 的 todayCount：优先 store.countAddedSince，异常/缺省按 addedAt 估算', async () => {
  // countAddedSince 可信（0 <= count <= 库内条目数）
  // collectQuota() 优先
  const quota = makeStickerStore();
  quota.collectQuota = () => ({ todayCount: 1, dailyLimit: 10, allowed: true });
  const quotaRes = (await makeClient(makeRuntime({ stickers: quota })).call('GET', '/stickers')).json;
  assert.equal(quotaRes.todayCount, 1);

  // countAddedSince(sinceMs)：参数是绝对时间戳（now-24h），不是时长
  const counted = makeStickerStore();
  counted.countAddedSince = async (sinceMs) => {
    assert.equal(typeof sinceMs, 'number');
    assert.ok(Math.abs(sinceMs - (Date.now() - 24 * 60 * 60 * 1000)) < 5000, 'sinceMs 应为 now-24h');
    return 0;
  };
  const countedRes = (await makeClient(makeRuntime({ stickers: counted })).call('GET', '/stickers')).json;
  assert.equal(countedRes.todayCount, 0);

  // 不可信（超过库内条目数）→ 忽略，按 addedAt 估算为 0
  const suspicious = makeStickerStore();
  suspicious.countAddedSince = async () => 999;
  const suspiciousRes = (await makeClient(makeRuntime({ stickers: suspicious })).call('GET', '/stickers')).json;
  assert.equal(suspiciousRes.todayCount, 0);

  // 没有 countAddedSince：按近 24h 的 addedAt 估算
  const recent = makeStickerStore();
  recent.list = async () => [
    {
      name: 'recent.png',
      size: 5,
      mtime: Date.now(),
      emotion: '',
      tags: [],
      note: '',
      addedAt: Date.now() - 1000,
      source: 'upload',
    },
  ];
  const recentRes = (await makeClient(makeRuntime({ stickers: recent })).call('GET', '/stickers')).json;
  assert.equal(recentRes.todayCount, 1);
});

test('handler 内部未预期错误被捕获成 500，不会 reject', async () => {
  const runtime = makeRuntime({
    memory: {
      layout() {
        throw new Error('磁盘错误');
      },
    },
    persona: {
      read() {
        throw new Error('权限错误');
      },
    },
  });
  const { call } = makeClient(runtime);
  const memory = await call('GET', '/memory');
  assert.equal(memory.status, 500);
  assert.equal(memory.json.ok, false);

  const persona = await call('GET', '/persona');
  assert.equal(persona.status, 500);
  assert.equal(persona.json.ok, false);
});