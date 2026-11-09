/**
 * test/stickers-api —— 表情包控制台接口：hash 去重、quota、删除文件、鉴权/404。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createHarness } from './console-helpers.js';

async function setupBot(h, name = '表情 bot') {
  await h.loginOk();
  const res = await h.request('POST', '/api/bots', { body: { name } });
  assert.equal(res.status, 200, res.text);
  return res.data;
}

test('stickers API：未登录 401、缺 CSRF 403、缺 bot 400、bot 不存在 404', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());

  assert.equal((await h.request('GET', '/api/stickers?bot=x', { auth: false })).status, 401);

  const bot = await setupBot(h);
  const noCsrf = await h.request('POST', '/api/stickers', {
    body: { botId: bot.id, name: 'x', file: '/tmp/x.gif' },
    csrf: false,
  });
  assert.equal(noCsrf.status, 403);

  assert.equal((await h.request('GET', '/api/stickers')).status, 400);
  assert.equal((await h.request('GET', '/api/stickers?bot=nope')).status, 404);
  assert.equal((await h.request('GET', '/api/stickers/quota?bot=nope')).status, 404);

  const missingFile = await h.request('POST', '/api/stickers', { body: { botId: bot.id, name: 'x' } });
  assert.equal(missingFile.status, 400);
});

test('stickers API：hash 去重 → 列表 → quota → 删除文件', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const bot = await setupBot(h);

  const file = path.join(h.dir, 'sticker.gif');
  fs.writeFileSync(file, 'GIF89a');

  const first = await h.request('POST', '/api/stickers', {
    body: { botId: bot.id, name: '猫猫', file, emotion: '开心', hash: 'hash-1' },
  });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.created, true);
  assert.equal(first.data.file, file);
  assert.equal(first.data.emotion, '开心');
  assert.equal(first.data.hash, 'hash-1');

  const dup = await h.request('POST', '/api/stickers', {
    body: { botId: bot.id, name: '猫猫别名', file, emotion: '开心', hash: 'hash-1' },
  });
  assert.equal(dup.status, 200, dup.text);
  assert.equal(dup.data.created, false);
  assert.equal(dup.data.id, first.data.id, '同 bot 同 hash 去重');

  const list = await h.request('GET', '/api/stickers?bot=' + bot.id);
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);

  const filtered = await h.request('GET', '/api/stickers?bot=' + bot.id + '&emotion=' + encodeURIComponent('开心'));
  assert.equal(filtered.data.length, 1);

  const quota = await h.request('GET', '/api/stickers/quota?bot=' + bot.id);
  assert.equal(quota.status, 200);
  assert.match(quota.data.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(quota.data.count, 0);

  const removed = await h.request('DELETE', '/api/stickers/' + first.data.id + '?bot=' + bot.id);
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.data.removed, true);
  assert.equal(fs.existsSync(file), false, '删除表情包应同时删文件');
  assert.equal((await h.request('GET', '/api/stickers?bot=' + bot.id)).data.length, 0);
  assert.equal((await h.request('DELETE', '/api/stickers/' + first.data.id + '?bot=' + bot.id)).status, 404);

  const audit = await h.request('GET', '/api/audit?limit=50&bot=' + bot.id);
  const kinds = audit.data.map((row) => row.kind);
  assert.ok(kinds.includes('sticker.add'));
  assert.ok(kinds.includes('sticker.dedupe') || kinds.includes('sticker.add'));
  assert.ok(kinds.includes('sticker.remove'));
});
