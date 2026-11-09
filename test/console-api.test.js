/**
 * test/console-api —— 资源 API 集成测试：bots/profiles/bindings/settings/schema/tools/kb/memories/audit。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { get } from '../lib/core/db.js';
import { createHarness } from './console-helpers.js';

/** 登录并建一个 bot，返回 bot 实体。 */
async function setupBot(h, name = '测试 bot') {
  await h.loginOk();
  const res = await h.request('POST', '/api/bots', { body: { name, appId: 'app-1', appSecret: 'sec-1' } });
  assert.equal(res.status, 200, res.text);
  return res.data;
}

test('bots CRUD：创建/列表/详情/更新（appSecret 脱敏）/删除', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await h.loginOk();

  const created = await h.request('POST', '/api/bots', {
    body: { name: ' 小助手 ', appId: '10001', appSecret: 'top-secret', cwd: '' },
  });
  assert.equal(created.status, 200);
  const bot = created.data;
  assert.equal(bot.name, '小助手');
  assert.equal(bot.appId, '10001');
  assert.equal(bot.appSecret, '');
  assert.equal(bot.hasAppSecret, true);
  assert.equal(bot.enabled, true);
  assert.equal(typeof bot.id, 'string');
  assert.ok(bot.createdAt > 0);

  const list = await h.request('GET', '/api/bots');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.map((item) => item.id), [bot.id]);
  assert.equal(list.data[0].appSecret, '');

  const got = await h.request('GET', '/api/bots/' + bot.id);
  assert.equal(got.status, 200);
  assert.equal(got.data.id, bot.id);

  const patched = await h.request('PATCH', '/api/bots/' + bot.id, {
    body: { name: '改名 bot', enabled: false, appSecret: '' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.name, '改名 bot');
  assert.equal(patched.data.enabled, false);
  assert.equal(patched.data.hasAppSecret, true, '空串 appSecret 不应清空已保存的 secret');
  const row = get(h.db, 'SELECT app_secret AS secret FROM bots WHERE id = ?', bot.id);
  assert.equal(row.secret, 'top-secret');

  const missing = await h.request('GET', '/api/bots/not-exist');
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'not_found');

  const invalid = await h.request('POST', '/api/bots', { body: { name: '   ' } });
  assert.equal(invalid.status, 400);

  const deleted = await h.request('DELETE', '/api/bots/' + bot.id);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.ok, true);
  assert.equal((await h.request('GET', '/api/bots/' + bot.id)).status, 404);
});

test('profiles：创建/激活/更新/删除与“至少保留一个”约束', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const bot = await setupBot(h);

  const list = await h.request('GET', '/api/profiles?bot=' + bot.id);
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1, '建 bot 时自动创建默认配置档');
  assert.equal(list.data[0].isDefault, true);

  const created = await h.request('POST', '/api/profiles', {
    body: { botId: bot.id, name: '工作档', data: { reply: { enabled: false }, persona: { extraPrompt: '工作模式' } } },
  });
  assert.equal(created.status, 200);
  const profile = created.data;
  assert.equal(profile.name, '工作档');
  assert.equal(profile.isDefault, false);
  assert.equal(profile.data.reply.enabled, false);
  assert.equal(profile.data.persona.extraPrompt, '工作模式');

  const activated = await h.request('POST', '/api/profiles/' + profile.id + '/activate');
  assert.equal(activated.status, 200);
  assert.equal(activated.data.isDefault, true);
  const afterActivate = await h.request('GET', '/api/profiles?bot=' + bot.id);
  assert.equal(afterActivate.data[0].id, profile.id, '激活的配置档应排在最前');

  const patched = await h.request('PATCH', '/api/profiles/' + profile.id, {
    body: { name: '工作档2', data: { reply: { mode: 'mention' } } },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.name, '工作档2');
  assert.equal(patched.data.data.reply.mode, 'mention');
  assert.equal(patched.data.data.reply.enabled, false, 'PATCH data 应为深合并');

  const deleted = await h.request('DELETE', '/api/profiles/' + profile.id);
  assert.equal(deleted.status, 200);
  const lastOne = await h.request('DELETE', '/api/profiles/' + list.data[0].id);
  assert.equal(lastOne.status, 400);
  assert.match(lastOne.data.error.message, /至少保留一个/);
});

test('bindings：PUT upsert、按 id 更新、删除', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const bot = await setupBot(h);
  const defaultProfile = (await h.request('GET', '/api/profiles?bot=' + bot.id)).data[0];
  const second = (await h.request('POST', '/api/profiles', { body: { botId: bot.id, name: '第二档' } })).data;

  const upsert = await h.request('PUT', '/api/bindings', {
    body: { botId: bot.id, scope: 'qq:group:*', profileId: second.id, priority: 5 },
  });
  assert.equal(upsert.status, 200);
  assert.equal(upsert.data.scope, 'qq:group:*');
  assert.equal(upsert.data.profileId, second.id);
  assert.equal(upsert.data.priority, 5);

  const list = await h.request('GET', '/api/bindings?bot=' + bot.id);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].id, upsert.data.id);
  assert.equal(list.data[0].profileName, '第二档');

  const updated = await h.request('PUT', '/api/bindings/' + upsert.data.id, {
    body: { profileId: defaultProfile.id, priority: 9 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.profileId, defaultProfile.id);
  assert.equal(updated.data.priority, 9);

  const invalidScope = await h.request('PUT', '/api/bindings', {
    body: { botId: bot.id, scope: 'bad scope', profileId: second.id },
  });
  assert.equal(invalidScope.status, 400);

  const removed = await h.request('DELETE', '/api/bindings/' + upsert.data.id);
  assert.equal(removed.status, 200);
  assert.equal((await h.request('GET', '/api/bindings?bot=' + bot.id)).data.length, 0);
});

test('settings 读写（扁平点号键/嵌套写法）与 schema', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const bot = await setupBot(h);

  const got = await h.request('GET', '/api/settings?bot=' + bot.id);
  assert.equal(got.status, 200);
  assert.equal(got.data.botId, bot.id);
  assert.equal(got.data.values['reply.enabled'], true);
  assert.equal(got.data.values['reply.mode'], 'adaptive');

  const put = await h.request('PUT', '/api/settings?bot=' + bot.id, {
    body: { 'reply.enabled': false, 'persona.extraPrompt': '测试追加' },
  });
  assert.equal(put.status, 200);
  assert.equal(put.data.values['reply.enabled'], false);
  assert.equal(put.data.values['persona.extraPrompt'], '测试追加');
  assert.ok(Array.isArray(put.data.warnings));

  const nested = await h.request('PUT', '/api/settings?bot=' + bot.id, {
    body: { reply: { mode: 'mention' } },
  });
  assert.equal(nested.status, 200);
  assert.equal(nested.data.values['reply.mode'], 'mention');

  // profile 级设置应落到当前激活配置档
  const profiles = (await h.request('GET', '/api/profiles?bot=' + bot.id)).data;
  assert.equal(profiles[0].data.reply.enabled, false);
  assert.equal(profiles[0].data.reply.mode, 'mention');

  const schema = await h.request('GET', '/api/schema');
  assert.equal(schema.status, 200);
  assert.ok(Array.isArray(schema.data.items));
  assert.ok(schema.data.items.length > 10);
  const modeItem = schema.data.items.find((item) => item.key === 'reply.mode');
  assert.ok(modeItem);
  assert.equal(modeItem.type, 'enum');
  assert.ok(Array.isArray(modeItem.enum));
  assert.ok(Array.isArray(schema.data.sections));
  assert.ok(schema.data.sections.some((section) => section.id === 'reply'));
});

test('tools/skills：未装配发现项为空，策略按 profile 读写', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const bot = await setupBot(h);
  const profile = (await h.request('GET', '/api/profiles?bot=' + bot.id)).data[0];

  const tools = await h.request('GET', '/api/tools?profile=' + profile.id);
  assert.equal(tools.status, 200);
  assert.deepEqual(tools.data.items, []);
  assert.deepEqual(tools.data.policy, { mode: 'allow', allow: [], deny: [], extra: [] });
  assert.deepEqual(tools.data.visible, []);
  assert.equal(tools.data.profileId, profile.id);

  const putTools = await h.request('PUT', '/api/tools/policy', {
    body: { profileId: profile.id, policy: { mode: 'deny', allow: ['bash'], deny: ['write'] } },
  });
  assert.equal(putTools.status, 200);
  assert.equal(putTools.data.policy.mode, 'deny');
  assert.deepEqual(putTools.data.policy.allow, ['bash']);
  assert.deepEqual(putTools.data.policy.deny, ['write']);
  const reload = await h.request('GET', '/api/tools?profile=' + profile.id);
  assert.equal(reload.data.policy.mode, 'deny');

  const badPolicy = await h.request('PUT', '/api/tools/policy', {
    body: { profileId: profile.id, policy: { mode: 'nope' } },
  });
  assert.equal(badPolicy.status, 400);

  const skills = await h.request('GET', '/api/skills?profile=' + profile.id);
  assert.equal(skills.status, 200);
  assert.deepEqual(skills.data.policy, { mode: 'allow', allow: [] });
  const putSkills = await h.request('PUT', '/api/skills/policy', {
    body: { profileId: profile.id, policy: { mode: 'all', allow: ['s1', 's1', ''] } },
  });
  assert.equal(putSkills.status, 200);
  assert.equal(putSkills.data.policy.mode, 'all');
  assert.deepEqual(putSkills.data.policy.allow, ['s1']);
});

test('tools 发现项注入 deps.toolsDiscover 后可见', async (t) => {
  const h = await createHarness({
    deps: {
      toolsDiscover: {
        list: () => [
          { name: 'bash', source: 'host', description: '运行 shell 命令' },
          { name: 'custom', source: 'plugin', description: '插件工具', restrictable: false },
        ],
        visibleNames: () => ['bash'],
      },
    },
  });
  t.after(() => h.close());
  await h.loginOk();

  const tools = await h.request('GET', '/api/tools');
  assert.equal(tools.status, 200);
  assert.equal(tools.data.items.length, 2);
  assert.deepEqual(tools.data.items[0], { name: 'bash', source: 'host', description: '运行 shell 命令', restrictable: true });
  assert.equal(tools.data.items[1].restrictable, false);
  assert.deepEqual(tools.data.visible, ['bash']);
});

test('kb：未装配内核时 docs 空数组、写接口 501；装配后可用', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const bot = await setupBot(h);

  const docs = await h.request('GET', '/api/kb/docs?bot=' + bot.id);
  assert.equal(docs.status, 200);
  assert.deepEqual(docs.data, []);

  const ingest = await h.request('POST', '/api/kb/ingest', { body: { botId: bot.id, text: '一段知识' } });
  assert.equal(ingest.status, 501);
  assert.equal(ingest.data.error.code, 'not_implemented');
  const search = await h.request('POST', '/api/kb/search', { body: { botId: bot.id, query: '知识' } });
  assert.equal(search.status, 501);
  const remove = await h.request('DELETE', '/api/kb/docs/1?bot=' + bot.id);
  assert.equal(remove.status, 501);

  const fakeKb = {
    listDocs: ({ botId: id }) => [{
      id: 7, botId: id, source: 'faq.md', title: '常见问题', hash: 'h', meta: null,
      createdAt: 1, updatedAt: 2, chunkCount: 3,
    }],
    ingest: () => ({ docId: 7, chunks: 2, changed: true, doc: { id: 7, source: 'faq.md' } }),
    search: () => [{ chunkId: 1, docId: 7, text: '原文', title: '常见问题', score: 1.5, mode: 'fts', snippet: '…' }],
    removeDoc: ({ id }) => ({ removed: true, docId: Number(id), chunks: 2 }),
  };
  const h2 = await createHarness({ deps: { kb: fakeKb } });
  t.after(() => h2.close());
  const bot2 = await setupBot(h2, '知识库 bot');

  const docs2 = await h2.request('GET', '/api/kb/docs?bot=' + bot2.id);
  assert.equal(docs2.status, 200);
  assert.equal(docs2.data.length, 1);
  assert.equal(docs2.data[0].chunkCount, 3);

  const ingest2 = await h2.request('POST', '/api/kb/ingest', { body: { botId: bot2.id, text: 'hello', source: 'a.md' } });
  assert.equal(ingest2.status, 200, ingest2.text);
  assert.equal(ingest2.data.docId, 7);
  assert.equal(ingest2.data.chunks, 2);

  const search2 = await h2.request('POST', '/api/kb/search', { body: { botId: bot2.id, query: '原文' } });
  assert.equal(search2.status, 200);
  assert.equal(search2.data[0].mode, 'fts');

  const remove2 = await h2.request('DELETE', '/api/kb/docs/7?bot=' + bot2.id);
  assert.equal(remove2.status, 200);
  assert.equal(remove2.data.ok, true);
  assert.equal(remove2.data.id, 7);
});

test('memories：未装配内核时列表可读、写接口 501；装配后可用', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const bot = await setupBot(h);

  const list = await h.request('GET', '/api/memories?bot=' + bot.id);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data, []);
  const save = await h.request('POST', '/api/memories', { body: { botId: bot.id, text: '用户喜欢猫' } });
  assert.equal(save.status, 501);
  const search = await h.request('POST', '/api/memories/search', { body: { botId: bot.id, query: '猫' } });
  assert.equal(search.status, 501);
  const remove = await h.request('DELETE', '/api/memories/1');
  assert.equal(remove.status, 501);

  const fakeMemory = {
    list: ({ botId: id }) => [{
      id: 1, botId: id, peer: null, kind: 'fact', text: '记忆一', tags: ['a'],
      source: null, createdAt: 1, updatedAt: 2,
    }],
    save: (input) => ({ id: 2, ...input, createdAt: 3, updatedAt: 3, created: true, deduped: false }),
    search: () => [{ id: 1, text: '记忆一', score: 1, mode: 'fts' }],
    remove: ({ id }) => ({ removed: true, id: Number(id) }),
  };
  const h2 = await createHarness({ deps: { memory: fakeMemory } });
  t.after(() => h2.close());
  const bot2 = await setupBot(h2, '记忆 bot');

  const list2 = await h2.request('GET', '/api/memories?bot=' + bot2.id);
  assert.equal(list2.status, 200);
  assert.equal(list2.data[0].text, '记忆一');
  const save2 = await h2.request('POST', '/api/memories', { body: { botId: bot2.id, text: '新记忆', kind: 'fact' } });
  assert.equal(save2.status, 200, save2.text);
  assert.equal(save2.data.id, 2);
  const search2 = await h2.request('POST', '/api/memories/search', { body: { botId: bot2.id, query: '记忆' } });
  assert.equal(search2.status, 200);
  assert.equal(search2.data[0].id, 1);
  const remove2 = await h2.request('DELETE', '/api/memories/1');
  assert.equal(remove2.status, 200);
  assert.equal(remove2.data.ok, true);
});

test('audit 列表、未实现资源 501、actions 转发', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await setupBot(h);

  const audit = await h.request('GET', '/api/audit?limit=20');
  assert.equal(audit.status, 200);
  assert.ok(Array.isArray(audit.data));
  assert.ok(audit.data.some((row) => row.kind === 'auth.login'));
  assert.ok(audit.data.some((row) => row.kind === 'bot.create'));
  assert.equal(typeof audit.data[0].at, 'number');

  const members = await h.request('GET', '/api/members');
  assert.equal(members.status, 501);
  assert.equal(members.data.error.code, 'not_implemented');
  const stickers = await h.request('GET', '/api/stickers');
  assert.equal(stickers.status, 501);
  const actions = await h.request('POST', '/api/actions/start', { body: { botId: 'x' } });
  assert.equal(actions.status, 501);

  const h2 = await createHarness({
    deps: {
      actions: {
        run: async (name, body) => ({ ok: true, action: name, botId: body.botId }),
      },
    },
  });
  t.after(() => h2.close());
  await h2.loginOk();
  const run = await h2.request('POST', '/api/actions/restart', { body: { botId: 'b1' } });
  assert.equal(run.status, 200);
  assert.equal(run.data.action, 'restart');
  assert.equal(run.data.botId, 'b1');
});
