/**
 * test/members-api —— 群友库控制台接口：鉴权/CSRF/参数校验/合并语义/审计。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHarness } from './console-helpers.js';

async function setupBot(h, name = '群友 bot') {
  await h.loginOk();
  const res = await h.request('POST', '/api/bots', { body: { name } });
  assert.equal(res.status, 200, res.text);
  return res.data;
}

test('members API：未登录 401、缺 CSRF 403、缺 bot 400、bot 不存在 404', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const unauth = await h.request('GET', '/api/members?bot=x', { auth: false });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.data.error.code, 'unauthorized');

  const bot = await setupBot(h);

  const noCsrf = await h.request('POST', '/api/members', { body: { botId: bot.id, openid: 'u1' }, csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.error.code, 'csrf_required');

  const noBot = await h.request('GET', '/api/members');
  assert.equal(noBot.status, 400);
  assert.equal(noBot.data.error.code, 'invalid_request');

  const badBot = await h.request('GET', '/api/members?bot=not-exist');
  assert.equal(badBot.status, 404);
  assert.equal(badBot.data.error.code, 'not_found');

  const missingOpenid = await h.request('POST', '/api/members', { body: { botId: bot.id } });
  assert.equal(missingOpenid.status, 400);
});

test('members API：upsert 合并备注 → 列表/搜索 → PATCH → 详情 → DELETE', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const bot = await setupBot(h);

  const created = await h.request('POST', '/api/members', {
    body: {
      botId: bot.id,
      openid: 'openid-1',
      nickname: '小明',
      note: '老备注',
      profileJson: { tags: ['老群友'] },
    },
  });
  assert.equal(created.status, 200, created.text);
  const member = created.data;
  assert.equal(member.openid, 'openid-1');
  assert.equal(member.nickname, '小明');
  assert.equal(member.note, '老备注');
  assert.deepEqual(member.profileJson, { tags: ['老群友'] });
  assert.equal(member.created, true);
  assert.ok(member.id > 0);

  // 空 note 不冲掉已有备注；同 openid 合并到同一行
  const merged = await h.request('POST', '/api/members', {
    body: { botId: bot.id, openid: 'openid-1', nickname: '小明2', note: '' },
  });
  assert.equal(merged.status, 200, merged.text);
  assert.equal(merged.data.id, member.id);
  assert.equal(merged.data.note, '老备注');
  assert.equal(merged.data.nickname, '小明2');
  assert.equal(merged.data.created, false);

  const list = await h.request('GET', '/api/members?bot=' + bot.id);
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);

  const searched = await h.request('GET', '/api/members?bot=' + bot.id + '&q=' + encodeURIComponent('老备注'));
  assert.equal(searched.status, 200);
  assert.equal(searched.data.length, 1);

  const patched = await h.request('PATCH', '/api/members/' + member.id + '?bot=' + bot.id, {
    body: { note: '人工备注', profileJson: { vip: true } },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.data.note, '人工备注');
  assert.deepEqual(patched.data.profileJson, { tags: ['老群友'], vip: true }, 'profileJson 浅合并');

  const detail = await h.request('GET', '/api/members/' + member.id + '?bot=' + bot.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.note, '人工备注');

  const missing = await h.request('GET', '/api/members/9999?bot=' + bot.id);
  assert.equal(missing.status, 404);
  const patchMissing = await h.request('PATCH', '/api/members/9999?bot=' + bot.id, { body: { note: 'x' } });
  assert.equal(patchMissing.status, 404);

  const deleted = await h.request('DELETE', '/api/members/' + member.id + '?bot=' + bot.id);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.ok, true);
  assert.equal((await h.request('GET', '/api/members?bot=' + bot.id)).data.length, 0);
  assert.equal((await h.request('DELETE', '/api/members/' + member.id + '?bot=' + bot.id)).status, 404);

  const audit = await h.request('GET', '/api/audit?limit=50&bot=' + bot.id);
  const kinds = audit.data.map((row) => row.kind);
  assert.ok(kinds.includes('member.upsert'), '写操作应记审计');
  assert.ok(kinds.includes('member.update'));
  assert.ok(kinds.includes('member.remove'));
});

test('members：deps.members 注入时优先使用注入实例', async (t) => {
  const injected = {
    list: () => [{ id: 99, botId: 'b1', openid: 'injected', nickname: null, note: null, profileJson: null, updatedAt: 1 }],
  };
  const h = await createHarness({ deps: { members: injected } });
  t.after(() => h.close());
  await h.loginOk();
  const bot = h.config.createBot({ name: '注入 bot' });
  const res = await h.request('GET', '/api/members?bot=' + bot.id);
  assert.equal(res.status, 200);
  assert.equal(res.data[0].id, 99, '应使用注入的 deps.members');
});
