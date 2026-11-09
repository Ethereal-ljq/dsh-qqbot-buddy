/**
 * test/personas-api —— 人格卡控制台接口：CRUD、激活互斥、persona.md 落盘、鉴权/404。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './console-helpers.js';

async function setupBot(h, name = '人设 bot') {
  await h.loginOk();
  const res = await h.request('POST', '/api/bots', { body: { name } });
  assert.equal(res.status, 200, res.text);
  return res.data;
}

test('personas API：未登录 401、缺 CSRF 403、缺 bot 400、bot 不存在 404', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  const unauth = await h.request('GET', '/api/personas?bot=x', { auth: false });
  assert.equal(unauth.status, 401);

  const bot = await setupBot(h);
  const noCsrf = await h.request('POST', '/api/personas', { body: { botId: bot.id, name: 'x' }, csrf: false });
  assert.equal(noCsrf.status, 403);

  assert.equal((await h.request('GET', '/api/personas')).status, 400);
  assert.equal((await h.request('GET', '/api/personas?bot=nope')).status, 404);
  assert.equal((await h.request('POST', '/api/personas', { body: { botId: bot.id } })).status, 400);
});

test('personas API：创建 → 激活写 persona.md → 切换互斥 → 编辑同步 → 删除', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const bot = await setupBot(h);

  const created1 = await h.request('POST', '/api/personas', {
    body: { botId: bot.id, name: '温柔助手', content: '# 温柔人设' },
  });
  assert.equal(created1.status, 200, created1.text);
  const p1 = created1.data;
  assert.match(p1.id, /^psn_/);
  assert.equal(p1.active, false);
  assert.equal(p1.name, '温柔助手');
  assert.equal(p1.content, '# 温柔人设');

  const p2 = (await h.request('POST', '/api/personas', {
    body: { botId: bot.id, name: '毒舌助手', content: '# 毒舌人设' },
  })).data;

  const personaFile = path.join(h.dir, 'workspace', 'bots', bot.id, 'persona.md');

  const activated1 = await h.request('POST', '/api/personas/' + p1.id + '/activate', { body: { botId: bot.id } });
  assert.equal(activated1.status, 200, activated1.text);
  assert.equal(activated1.data.active, true);
  assert.equal(fs.readFileSync(personaFile, 'utf8'), '# 温柔人设', '激活应同步写 persona.md');

  const activated2 = await h.request('POST', '/api/personas/' + p2.id + '/activate', { body: { botId: bot.id } });
  assert.equal(activated2.status, 200);
  assert.equal(activated2.data.active, true);
  assert.equal(fs.readFileSync(personaFile, 'utf8'), '# 毒舌人设');
  const list = await h.request('GET', '/api/personas?bot=' + bot.id);
  assert.equal(list.data.length, 2);
  assert.equal(list.data.filter((item) => item.active).length, 1, '同 bot 只能有一张 active');
  assert.equal(list.data[0].id, p2.id, 'active 卡排第一');
  assert.equal(list.data.find((item) => item.id === p1.id).active, false);

  // 编辑 active 卡内容 → 文件同步
  const patched = await h.request('PATCH', '/api/personas/' + p2.id + '?bot=' + bot.id, {
    body: { content: '# 毒舌人设 v2' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.data.content, '# 毒舌人设 v2');
  assert.equal(fs.readFileSync(personaFile, 'utf8'), '# 毒舌人设 v2');

  const detail = await h.request('GET', '/api/personas/' + p1.id + '?bot=' + bot.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.name, '温柔助手');

  // 404
  assert.equal((await h.request('GET', '/api/personas/psn_nope?bot=' + bot.id)).status, 404);
  assert.equal((await h.request('PATCH', '/api/personas/psn_nope?bot=' + bot.id, { body: { name: 'x' } })).status, 404);
  assert.equal((await h.request('POST', '/api/personas/psn_nope/activate', { body: { botId: bot.id } })).status, 404);

  const deleted = await h.request('DELETE', '/api/personas/' + p1.id + '?bot=' + bot.id);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.ok, true);
  assert.equal((await h.request('GET', '/api/personas/' + p1.id + '?bot=' + bot.id)).status, 404);

  const audit = await h.request('GET', '/api/audit?limit=50&bot=' + bot.id);
  const kinds = audit.data.map((row) => row.kind);
  assert.ok(kinds.includes('persona.create'));
  assert.ok(kinds.includes('persona.activate'));
  assert.ok(kinds.includes('persona.update'));
  assert.ok(kinds.includes('persona.remove'));
});
