/**
 * 集成测试：真实 plugin apply → 控制台 HTTP 服务 → 登录 → 资源读写。
 * 覆盖装配契约（deps 注入、token 文件、cookie/CSRF、配置持久化），不依赖宿主 dsh。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../lib/index.js';

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  const first = raw.split(';')[0];
  return first && first.includes('=') ? first : '';
}

test('控制台端到端：登录 → state → 建 bot → 读 schema/settings', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-console-'));
  const ctx = { get: () => undefined, effect: () => () => {} };
  const runtime = await apply(ctx, {
    dataDir: tmp,
    workspaceRoot: tmp,
    autoStart: false,
    console: { enabled: true, host: '127.0.0.1', port: 0, token: 'test-token-v2' },
  });
  // cordis 契约：async apply 的 resolve 值会被当作 effect；必须 undefined
  assert.equal(runtime, undefined, 'apply 不能返回值（否则 cordis 抛 Invalid effect 并卸载插件）');
  const rt = (await import('../lib/index.js')).getRuntime();
  try {
    const address = rt.console && rt.console.address();
    assert.ok(address && address.port > 0, '控制台应监听随机端口');
    const base = 'http://127.0.0.1:' + address.port;

    // health 无需鉴权
    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.ok(healthBody.version);

    // 未登录访问 state → 401
    const unauth = await fetch(base + '/api/state');
    assert.equal(unauth.status, 401);

    // 静态托管：SPA 首页（dist 未构建时返回占位页，同样是 200 HTML）
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') || '', /text\/html/);
    const homeHtml = await home.text();
    assert.ok(homeHtml.length > 100, '首页应有内容（构建产物或占位页）');

    // 登录
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'test-token-v2' }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieFrom(login);
    assert.ok(cookie, '登录应下发会话 cookie');

    // state
    const state = await fetch(base + '/api/state', { headers: { cookie } });
    assert.equal(state.status, 200);
    const stateBody = await state.json();
    assert.deepEqual(stateBody.bots, []);

    // 缺 CSRF 头的写操作 → 403
    const noCsrf = await fetch(base + '/api/bots', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '缺CSRF' }),
    });
    assert.equal(noCsrf.status, 403);

    // 建 bot（带 CSRF）
    const created = await fetch(base + '/api/bots', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'X-QQBot-CSRF': '1' },
      body: JSON.stringify({ name: '控制台建的号', appId: '1024' }),
    });
    assert.equal(created.status, 200, '建 bot 应成功: ' + created.status);
    const bot = await created.json();
    assert.ok(bot.id);
    assert.equal(bot.name, '控制台建的号');

    // state 里能看到，且目录已建
    const state2 = await (await fetch(base + '/api/state', { headers: { cookie } })).json();
    assert.equal(state2.bots.length, 1);
    assert.equal(state2.bots[0].id, bot.id);
    assert.equal(state2.bots[0].appSecret, '', 'state 里的 appSecret 必须脱敏为空串');
    assert.ok(fs.existsSync(path.join(tmp, 'bots', bot.id)));

    // schema 与 settings
    const schema = await (await fetch(base + '/api/schema', { headers: { cookie } })).json();
    assert.ok(Array.isArray(schema.items) && schema.items.length > 10);
    assert.ok(schema.items.some((item) => item.key === 'reply.mode'));

    const settings = await (await fetch(base + '/api/settings?bot=' + bot.id, { headers: { cookie } })).json();
    assert.equal(settings.values['reply.mode'], 'adaptive', 'GET /api/settings 返回扁平点号键');

    // 改设置 → 落库（profile 层）
    const patched = await fetch(base + '/api/settings?bot=' + bot.id, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json', 'X-QQBot-CSRF': '1' },
      body: JSON.stringify({ reply: { mode: 'always' } }),
    });
    assert.equal(patched.status, 200);
    const store = rt.config.getSettings(bot.id);
    assert.equal(store.reply.mode, 'always', '设置必须真正落到 profile 层');

    // actions：无凭据启动机器人 → 400 + 可读原因（错误码透传）
    const startResp = await fetch(base + '/api/actions/start-bot', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'X-QQBot-CSRF': '1' },
      body: JSON.stringify({ botId: bot.id }),
    });
    assert.equal(startResp.status, 400, 'start-bot 无凭据应 400: ' + startResp.status);
    const startBody = await startResp.json();
    assert.equal(startBody.error.code, 'start_failed');
    assert.match(startBody.error.message, /凭据|AppID|AppSecret|传输层/);

    // 知识库（kb 已装配）：ingest + search
    const ingest = await fetch(base + '/api/kb/ingest', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'X-QQBot-CSRF': '1' },
      body: JSON.stringify({ botId: bot.id, source: 'note', title: '团建', text: '本周六下午三点在滨江公园集合。' }),
    });
    assert.equal(ingest.status, 200, 'ingest 应成功: ' + ingest.status);
    const searchResponse = await fetch(base + '/api/kb/search', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'X-QQBot-CSRF': '1' },
      body: JSON.stringify({ botId: bot.id, query: '滨江公园' }),
    });
    assert.equal(searchResponse.status, 200, 'kb search 应成功: ' + searchResponse.status);
    const search = await searchResponse.json();
    assert.ok(Array.isArray(search) && search.length >= 1, '中文检索应命中');
    assert.equal(search[0].mode, 'fts');
  } finally {
    try { await rt.console?.stop?.(); } catch { /* ignore */ }
    try { rt.db.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});