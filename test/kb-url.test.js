import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, closeDb, run } from '../lib/core/db.js';
import { createKbStore } from '../lib/core/kb/store.js';
import {
  ALLOWED_CONTENT_TYPES,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  IngestUrlError,
  MAX_REDIRECTS,
  decodeHtmlEntities,
  extractHtmlTitle,
  htmlToText,
  ingestUrl,
  isPrivateAddress,
} from '../lib/core/kb/ingest-url.js';

/** 公网 IP 字面量：不触发 DNS，测试不联网。 */
const PUBLIC = 'http://93.184.216.34/article';
const PUBLIC_B = 'https://93.184.216.35/note';

/* ------------------------------ 脚手架 ------------------------------ */

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-kb-url-'));
  const db = openDb(path.join(dir, 'test.db'));
  const now = Date.now();
  for (const id of ['bot-a', 'bot-b']) {
    run(db, 'INSERT INTO bots(id, name, created_at, updated_at) VALUES(?,?,?,?)', id, id, now, now);
  }
  t.after(() => closeDb(db));
  return { db, kb: createKbStore({ db }) };
}

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

function textResponse(text, contentType = 'text/plain; charset=utf-8') {
  return response(text, { headers: { 'content-type': contentType } });
}

function htmlResponse(html) {
  return textResponse(html, 'text/html; charset=utf-8');
}

function queueFetch(responses) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected extra fetch: ' + url);
    return typeof next === 'function' ? next(url, options) : next;
  };
  return { calls, fetchImpl: impl };
}

function fetchingNever() {
  const calls = [];
  const impl = (url) => { calls.push(url); return new Promise(() => { /* 永不返回 */ }); };
  return { calls, fetchImpl: impl };
}

function rejectsWithCode(promise, code) {
  return assert.rejects(promise, (err) => {
    assert.ok(err instanceof IngestUrlError, '应是 IngestUrlError，实际: ' + err);
    assert.equal(err.code, code, '错误码应为 ' + code + '，实际 ' + err.code + '（' + err.message + '）');
    return true;
  });
}

/* ------------------------------ SSRF 防护 ------------------------------ */

test('isPrivateAddress：私网/环回/链路本地/保留段判为危险', () => {
  const dangerous = [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.0.1',
    '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255',
    '255.255.255.255', '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
    '2002:7f00:0001::', 'not-an-ip', '',
  ];
  for (const address of dangerous) {
    assert.equal(isPrivateAddress(address), true, address + ' 应判为危险');
  }
  const safe = ['8.8.8.8', '93.184.216.34', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'];
  for (const address of safe) {
    assert.equal(isPrivateAddress(address), false, address + ' 应判为公网');
  }
});

test('SSRF：私网/环回/链路本地/IPv6 本地地址一律拒绝且不发起 fetch', async (t) => {
  const { kb } = setup(t);
  const blocked = [
    'http://127.0.0.1/x',
    'http://10.9.8.7/x',
    'http://172.16.0.1/x',
    'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/x',
    'http://localhost:8080/x',
    'http://foo.localhost/x',
    'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://[fd00::1]/x',
    'http://[fe80::1]/x',
  ];
  const { fetchImpl, calls } = fetchingNever();
  for (const url of blocked) {
    await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url, fetchImpl }), 'SSRF_BLOCKED');
  }
  assert.equal(calls.length, 0, '被 SSRF 拦截的 URL 不应发起网络请求');
});

test('SSRF：DNS 解析到私网地址同样拒绝；DNS 失败报 DNS_FAILED', async (t) => {
  const { kb } = setup(t);
  let fetched = 0;
  const neverFetch = async () => { fetched += 1; return textResponse('x'); };
  await rejectsWithCode(
    ingestUrl({
      kb, botId: 'bot-a', url: 'http://internal.example/doc', fetchImpl: neverFetch,
      lookupImpl: async () => [{ address: '10.0.0.5', family: 4 }],
    }),
    'SSRF_BLOCKED',
  );
  assert.equal(fetched, 0);

  await rejectsWithCode(
    ingestUrl({
      kb, botId: 'bot-a', url: 'http://nope.example/doc', fetchImpl: neverFetch,
      lookupImpl: async () => { throw new Error('ENOTFOUND'); },
    }),
    'DNS_FAILED',
  );
  assert.equal(fetched, 0);
});

test('公网域名经 DNS 校验通过后可正常抓取（lookup 注入，不联网）', async (t) => {
  const { kb } = setup(t);
  const { calls, fetchImpl } = queueFetch([textResponse('公网域名抓取到的正文内容。')]);
  const result = await ingestUrl({
    kb, botId: 'bot-a', url: 'http://example.org/doc', fetchImpl,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(result.changed, true);
  assert.equal(result.bytes > 0, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /example\.org/);
});

test('协议/URL 校验：只允许 http/https，拒绝账号密码与非法 URL', async (t) => {
  const { kb, db } = setup(t);
  const { fetchImpl } = fetchingNever();
  await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url: 'file:///etc/passwd', fetchImpl }), 'PROTOCOL');
  await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url: 'ftp://93.184.216.34/a', fetchImpl }), 'PROTOCOL');
  await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url: 'not a url', fetchImpl }), 'BAD_URL');
  await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url: 'http://user:pass@93.184.216.34/x', fetchImpl }), 'BAD_URL');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM kb_docs').get().c, 0);
});

/* ------------------------------ content-type / 大小 / 状态 ------------------------------ */

test('content-type 白名单：四种允许，其余拒绝', async (t) => {
  const { kb } = setup(t);
  assert.deepEqual(ALLOWED_CONTENT_TYPES, ['text/plain', 'text/markdown', 'text/html', 'application/json']);

  const allowed = [
    ['text/plain; charset=utf-8', '纯文本的正文内容。'],
    ['text/markdown', '# 标题\nMarkdown 正文内容。'],
    ['text/html', '<html><body><p>HTML 正文内容。</p></body></html>'],
    ['application/json', '{"项目":"凤凰计划","状态":"进行中"}'],
  ];
  for (let i = 0; i < allowed.length; i += 1) {
    const [contentType, body] = allowed[i];
    const { fetchImpl } = queueFetch([textResponse(body, contentType)]);
    const result = await ingestUrl({
      kb, botId: 'bot-a', url: 'http://93.184.216.34/doc' + i, fetchImpl,
    });
    assert.equal(result.changed, true, contentType + ' 应被接受');
    assert.ok(result.chunks >= 1);
  }

  for (const contentType of ['application/octet-stream', 'image/png', 'text/csv']) {
    const { fetchImpl } = queueFetch([response('内容', { headers: { 'content-type': contentType } })]);
    await rejectsWithCode(
      ingestUrl({ kb, botId: 'bot-a', url: 'http://93.184.216.34/ct', fetchImpl }),
      'CONTENT_TYPE',
    );
  }

  // 完全没有 content-type 头（用最小 fake response，避免 Response 自动补 text/plain）
  const noContentType = { status: 200, headers: { get: () => null }, body: null, arrayBuffer: async () => Buffer.from('x') };
  await rejectsWithCode(
    ingestUrl({ kb, botId: 'bot-a', url: 'http://93.184.216.34/ct-none', fetchImpl: async () => noContentType }),
    'CONTENT_TYPE',
  );
});

test('大小超限：流式读取阶段中止；content-length 提前拒绝', async (t) => {
  const { kb } = setup(t);
  assert.equal(DEFAULT_MAX_BYTES, 2 * 1024 * 1024);

  const big = 'x'.repeat(5000);
  const { fetchImpl } = queueFetch([textResponse(big)]);
  await rejectsWithCode(
    ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl, maxBytes: 100 }),
    'TOO_LARGE',
  );

  const declared = new Response('tiny', {
    headers: { 'content-type': 'text/plain', 'content-length': '999999' },
  });
  const second = queueFetch([declared]);
  await rejectsWithCode(
    ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl: second.fetchImpl, maxBytes: 1024 }),
    'TOO_LARGE',
  );

  // 恰好等于上限可以入库
  const exact = 'y'.repeat(64);
  const third = queueFetch([textResponse(exact)]);
  const ok = await ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl: third.fetchImpl, maxBytes: 64 });
  assert.equal(ok.changed, true);
  assert.equal(ok.bytes, 64);
});

test('非 2xx 状态拒绝（HTTP_STATUS）', async (t) => {
  const { kb } = setup(t);
  for (const status of [404, 500, 503]) {
    const { fetchImpl } = queueFetch([response('error page', { status, headers: { 'content-type': 'text/html' } })]);
    await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl }), 'HTTP_STATUS');
  }
});

test('HTML 提取后正文为空时报 EMPTY_CONTENT', async (t) => {
  const { kb } = setup(t);
  const html = '<html><head><style>.a{color:red}</style><script>var a=1;</script></head><body>   </body></html>';
  const { fetchImpl } = queueFetch([htmlResponse(html)]);
  await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl }), 'EMPTY_CONTENT');
});

/* ------------------------------ HTML 提取与入库 ------------------------------ */

test('htmlToText / extractHtmlTitle：去脚本样式、实体解码、压缩空白', () => {
  const html = [
    '<!DOCTYPE html><html><head><title> 页面 &amp; 标题 </title>',
    '<style>.a { color: red; }</style><script>alert("x")</script></head>',
    '<body><!-- 注释 --><h1>Hello</h1><p>中文&nbsp;内容 &amp; 实体&#33;</p>',
    '<ul><li>第一项</li><li>第二项</li></ul></body></html>',
  ].join('');
  const text = htmlToText(html);
  assert.ok(!text.includes('alert'), '应去掉 script 内容');
  assert.ok(!text.includes('color:red'), '应去掉 style 内容');
  assert.ok(!text.includes('<'), '应去掉标签');
  assert.ok(!text.includes('注释'), '应去掉 HTML 注释');
  assert.match(text, /Hello/);
  assert.match(text, /中文 内容 & 实体!/);
  assert.match(text, /第一项\n第二项/);
  assert.equal(extractHtmlTitle(html), '页面 & 标题');
  assert.equal(decodeHtmlEntities('&lt;A&gt; &#65;&#x42;'), '<A> AB');
  assert.equal(extractHtmlTitle('<html><body>无标题</body></html>'), '');
});

test('HTML 抓取入库：标题取 <title>、正文实体解码、按 URL source 落库', async (t) => {
  const { kb } = setup(t);
  const html = '<html><head><title>活动通知</title></head><body>'
    + '<script>track()</script><h1>周末活动</h1>'
    + '<p>本周六在滨江公园集合，价格 &lt; 100 元 &amp; 含税。</p></body></html>';
  const { fetchImpl } = queueFetch([htmlResponse(html)]);
  const result = await ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl });
  assert.equal(result.changed, true);
  assert.ok(result.bytes > 0);
  assert.ok(result.chunks >= 1);

  const doc = kb.getDoc({ botId: 'bot-a', source: PUBLIC });
  assert.equal(doc.title, '活动通知');
  assert.equal(doc.meta.contentType, 'text/html');
  assert.equal(doc.meta.url, PUBLIC);

  const hits = kb.search({ botId: 'bot-a', query: '滨江公园' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /价格 < 100 元 & 含税/);
  assert.ok(!hits[0].text.includes('track()'));
});

test('显式 title 覆盖 HTML <title>；默认标题取 URL 末段', async (t) => {
  const { kb } = setup(t);
  const first = queueFetch([htmlResponse('<html><title>网页标题</title><body>正文一。</body></html>')]);
  await ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, title: '自定义标题', fetchImpl: first.fetchImpl });
  assert.equal(kb.getDoc({ botId: 'bot-a', source: PUBLIC }).title, '自定义标题');

  const second = queueFetch([textResponse('纯文本正文。')]);
  await ingestUrl({ kb, botId: 'bot-a', url: 'http://93.184.216.34/docs/guide.md', fetchImpl: second.fetchImpl });
  assert.equal(kb.getDoc({ botId: 'bot-a', source: 'http://93.184.216.34/docs/guide.md' }).title, 'guide.md');
});

test('同 URL 重复抓取幂等；内容变化后替换 chunks 并同步 FTS', async (t) => {
  const { kb } = setup(t);
  const same = '<html><title>通知</title><body>原定周五下午开会。</body></html>';
  const firstQueue = queueFetch([htmlResponse(same)]);
  const first = await ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl: firstQueue.fetchImpl });
  const secondQueue = queueFetch([htmlResponse(same)]);
  const second = await ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl: secondQueue.fetchImpl });
  assert.equal(second.changed, false, '同 URL 同内容应幂等');
  assert.equal(second.docId, first.docId);
  assert.equal(kb.listDocs({ botId: 'bot-a' }).length, 1);

  const changedHtml = '<html><title>通知</title><body>会议改到周一上午十点。</body></html>';
  const thirdQueue = queueFetch([htmlResponse(changedHtml)]);
  const third = await ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl: thirdQueue.fetchImpl });
  assert.equal(third.changed, true);
  assert.equal(kb.search({ botId: 'bot-a', query: '周五下午' }).length, 0);
  assert.equal(kb.search({ botId: 'bot-a', query: '周一上午' }).length, 1);
});

/* ------------------------------ 重定向 / 超时 ------------------------------ */

test('重定向逐跳校验：公网 -> 公网跟随并记 finalUrl', async (t) => {
  const { kb } = setup(t);
  const redirect = new Response(null, { status: 302, headers: { location: PUBLIC_B } });
  const html = '<html><title>重定向后标题</title><body>重定向后的正文内容。</body></html>';
  const { calls, fetchImpl } = queueFetch([redirect, htmlResponse(html)]);
  const result = await ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(result.changed, true);
  const doc = kb.getDoc({ botId: 'bot-a', source: PUBLIC });
  assert.equal(doc.title, '重定向后标题');
  assert.equal(doc.meta.finalUrl, PUBLIC_B);
});

test('重定向逐跳校验：公网 -> 私网被拦截，不发起第二跳', async (t) => {
  const { kb } = setup(t);
  const redirect = new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
  const { calls, fetchImpl } = queueFetch([redirect]);
  await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl }), 'SSRF_BLOCKED');
  assert.equal(calls.length, 1, '第二跳私网地址应在上一次响应后、发起请求前被拦截');
});

test('重定向次数超过上限报 TOO_MANY_REDIRECTS', async (t) => {
  const { kb } = setup(t);
  const redirect = () => new Response(null, { status: 301, headers: { location: PUBLIC } });
  const { calls, fetchImpl } = queueFetch(Array.from({ length: MAX_REDIRECTS + 5 }, redirect));
  await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl }), 'TOO_MANY_REDIRECTS');
  assert.equal(calls.length, MAX_REDIRECTS + 1);
});

test('抓取超时：模型... 响应永不到达时报 TIMEOUT', async (t) => {
  const { kb } = setup(t);
  assert.equal(DEFAULT_TIMEOUT_MS, 15000);
  const { fetchImpl } = fetchingNever();
  await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl, timeoutMs: 30 }), 'TIMEOUT');
});

test('fetch 抛错时归为 FETCH_FAILED', async (t) => {
  const { kb } = setup(t);
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  await rejectsWithCode(ingestUrl({ kb, botId: 'bot-a', url: PUBLIC, fetchImpl }), 'FETCH_FAILED');
});

/* ------------------------------ 参数校验 ------------------------------ */

test('参数校验：kb/url/botId 必填', async () => {
  const fakeKb = { ingest() {} };
  await assert.rejects(ingestUrl({ url: PUBLIC, botId: 'bot-a' }), TypeError);
  await assert.rejects(ingestUrl({ kb: fakeKb, botId: 'bot-a' }), TypeError);
  await assert.rejects(ingestUrl({ kb: fakeKb, url: PUBLIC }), TypeError);
  await assert.rejects(ingestUrl({ kb: {}, url: PUBLIC, botId: 'bot-a' }), TypeError);
});
