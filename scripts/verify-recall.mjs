#!/usr/bin/env node
/**
 * verify-recall —— 验证「记忆 / 知识库」是否被自动召回并进入模型回复。
 *
 * 做法（黑盒，不改动业务代码）：
 *   1) 通过控制台 API 写入一条记忆 + 一条知识库文档，内容带唯一暗号；
 *   2) 调 GET /api/preview/prompt 看 qqbot:memory / qqbot:knowledge 段是否包含暗号；
 *   3) reset 一个测试 peer → debug-followup 用自然问句提问 → 等待会话文件里的 assistant 回复；
 *   4) 检查回复是否包含两个暗号（证明模型确实拿到了注入内容）；
 *   5) 默认清理写入的测试数据。
 *
 * 用法：
 *   node scripts/verify-recall.mjs                      # 默认 http://127.0.0.1:6198
 *   node scripts/verify-recall.mjs --base http://127.0.0.1:6198 --keep
 *   node scripts/verify-recall.mjs --bot bot_xxx --peer c2c:TEST --query "我的暗号是什么？"
 *
 * 退出码：0 全部通过；2 召回层没命中；3 模型回复没用到暗号；1 环境/接口错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const DEFAULT_BASE = 'http://127.0.0.1:6198';
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.dsh-qqbot', 'v2', 'console-token.txt');

function parseArgs(argv) {
  const out = {
    base: process.env.QQBOT_CONSOLE_BASE || DEFAULT_BASE,
    tokenFile: process.env.QQBOT_CONSOLE_TOKEN_FILE || DEFAULT_TOKEN_FILE,
    token: '',
    bot: '',
    peer: '',
    query: '请回答：记忆暗号是什么？知识库暗号是什么？',
    waitMs: 120000,
    keep: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') out.base = argv[++i];
    else if (arg === '--token') out.token = argv[++i];
    else if (arg === '--token-file') out.tokenFile = argv[++i];
    else if (arg === '--bot') out.bot = argv[++i];
    else if (arg === '--peer') out.peer = argv[++i];
    else if (arg === '--query') out.query = argv[++i];
    else if (arg === '--wait') out.waitMs = Math.max(5000, Number(argv[++i]) || 120000);
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('用法: node scripts/verify-recall.mjs [--base URL] [--token TOKEN|--token-file FILE] [--bot ID] [--peer PEER] [--query TEXT] [--wait MS] [--keep] [--json]\n');
      process.exit(0);
    } else {
      process.stderr.write('未知参数: ' + arg + '（--help 查看用法）\n');
      process.exit(1);
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const log = (...args) => { if (!opts.json) console.log(...args); };
const fail = (code, message) => {
  if (opts.json) console.log(JSON.stringify({ ok: false, code, error: message }));
  else console.error('❌ ' + message);
  process.exit(code);
};

function readToken() {
  if (opts.token !== '') return opts.token;
  try { return fs.readFileSync(opts.tokenFile, 'utf8').trim(); } catch {
    fail(1, '读不到控制台 token：' + opts.tokenFile + '（可用 --token/--token-file 指定）');
  }
}

const token = readToken();
const base = opts.base.replace(/\/$/u, '');
const headersJson = { 'content-type': 'application/json', 'x-qqbot-csrf': '1' };

async function login() {
  let res;
  try {
    res = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    });
  } catch (err) {
    fail(1, '连不上控制台 ' + base + ': ' + (err && err.message || err));
  }
  if (!res.ok) fail(1, '控制台登录失败（HTTP ' + res.status + '）');
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) fail(1, '控制台登录未返回会话 cookie');
  return cookie;
}

function makeClient(cookie) {
  return async function call(method, apiPath, body) {
    const res = await fetch(base + apiPath, {
      method,
      headers: { ...headersJson, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, body: json };
  };
}

function findSessionFile(sessionId) {
  const roots = [
    process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : '',
    path.join(os.homedir(), '.dsh', 'sessions'),
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root)) {
      const file = path.join(root, dir, sessionId, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file)) return file;
    }
  }
  return '';
}

function readAssistantText(file) {
  const events = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
    .split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  const texts = [];
  for (const event of events) {
    const message = event.data && event.data.message;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const text = message.content.filter((item) => item && item.type === 'text').map((item) => item.text).join('');
    if (text.trim() !== '') texts.push(text);
  }
  return texts.join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const cookie = await login();
  const call = makeClient(cookie);
  const state = (await call('GET', '/api/state')).body || {};
  const bots = Array.isArray(state.bots) ? state.bots : [];
  const botId = opts.bot || (bots[0] && bots[0].id);
  if (!botId) fail(1, '控制台里没有机器人（先建一个 bot）');
  const defaultProfile = (Array.isArray(state.profiles) ? state.profiles : []).find((item) => item.isDefault);

  const tag = 'VERIFY' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const memToken = tag + '-MEM';
  const kbToken = tag + '-KB';
  const peer = opts.peer || ('c2c:RECALL-' + tag);
  const report = { ok: false, tag, botId, peer, steps: {} };
  log('机器人: ' + botId);
  log('测试 peer: ' + peer);
  log('测试暗号: ' + memToken + ' / ' + kbToken);

  // 1) 写入测试记忆与知识库文档
  const mem = await call('POST', '/api/memories', {
    botId, text: '记忆暗号是 ' + memToken, kind: 'fact', source: 'verify-recall',
  });
  if (mem.status !== 200) fail(1, '写入记忆失败（HTTP ' + mem.status + '）');
  const kb = await call('POST', '/api/kb/ingest', {
    botId,
    title: '暗号知识库 ' + kbToken,
    text: '本群知识库暗号是 ' + kbToken + '。这是一次自动注入验证的临时文档。',
    source: 'verify-recall',
  });
  const kbId = kb.body && (kb.body.docId || (kb.body.doc && kb.body.doc.id));
  if (kb.status !== 200 || !kbId) fail(1, '写入知识库失败（HTTP ' + kb.status + '）');
  log('已写入：记忆 #' + mem.body.id + '，知识库 #' + kbId);

  try {
    // 2) 预览层：prompt 里是否出现暗号
    const previewPath = '/api/preview/prompt?bot=' + encodeURIComponent(botId)
      + (defaultProfile ? '&profile=' + encodeURIComponent(defaultProfile.id) : '')
      + '&query=' + encodeURIComponent(opts.query);
    const preview = (await call('GET', previewPath)).body || {};
    const sections = Array.isArray(preview.sections) ? preview.sections : [];
    const memSection = sections.find((item) => item.name === 'qqbot:memory');
    const kbSection = sections.find((item) => item.name === 'qqbot:knowledge');
    const recall = {
      memory: String(memSection && memSection.text || '').includes(memToken),
      knowledge: String(kbSection && kbSection.text || '').includes(kbToken),
    };
    report.steps.preview = { memory: recall.memory, knowledge: recall.knowledge, memoryChars: memSection && memSection.chars, knowledgeChars: kbSection && kbSection.chars };
    log('预览召回：记忆 ' + (recall.memory ? '✅' : '❌') + '，知识库 ' + (recall.knowledge ? '✅' : '❌'));

    // 3) 真模型链路：reset -> followup -> 读 assistant 回复
    const reset = await call('POST', '/api/actions/reset-peer', { botId, peer });
    const sessionId = reset.body && reset.body.newSessionId;
    if (!sessionId) fail(1, 'reset-peer 未返回 sessionId');
    await call('POST', '/api/actions/debug-followup', { botId, peer, text: opts.query, senderId: 'VERIFY_RECALL' });
    log('已触发 debug-followup（session ' + sessionId + '），等待模型回复…');

    let reply = '';
    const deadline = Date.now() + opts.waitMs;
    while (Date.now() < deadline) {
      await sleep(2000);
      const file = findSessionFile(sessionId);
      if (!file) continue;
      try {
        const text = readAssistantText(file);
        if (text.trim() !== '') { reply = text; break; }
      } catch { /* 会话文件可能正在写入，继续等 */ }
    }
    const used = {
      memory: reply.includes(memToken),
      knowledge: reply.includes(kbToken),
    };
    report.steps.model = { replied: reply !== '', memory: used.memory, knowledge: used.knowledge, reply: reply.slice(0, 500) };
    log('模型回复：' + (reply === '' ? '（超时未取到）' : JSON.stringify(reply.slice(0, 200))));
    log('回复使用：记忆 ' + (used.memory ? '✅' : '❌') + '，知识库 ' + (used.knowledge ? '✅' : '❌'));

    report.ok = recall.memory && recall.knowledge && used.memory && used.knowledge;
    if (!recall.memory || !recall.knowledge) {
      fail(2, '召回层未命中（检查记忆/知识库开关、query 与入库内容）');
    }
    if (!report.ok) {
      fail(3, '召回层通过，但模型回复没有使用暗号（可能模型/上下文问题）');
    }
    if (opts.json) console.log(JSON.stringify(report));
    else console.log('\n✅ 通过：记忆与知识库都已自动注入，并且模型在回复里用到了暗号。');
  } finally {
    if (!opts.keep) {
      await call('DELETE', '/api/memories/' + mem.body.id);
      if (kbId) await call('DELETE', '/api/kb/docs/' + kbId + '?bot=' + encodeURIComponent(botId));
      await call('POST', '/api/actions/reset-peer', { botId, peer });
      log('已清理测试数据（--keep 可保留）');
    }
  }
}

main().catch((err) => fail(1, '执行失败: ' + (err && err.stack || err)));
