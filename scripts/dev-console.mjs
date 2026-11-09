#!/usr/bin/env node
/**
 * 本地开发：只起控制台 + 演示数据（不连 QQ、不需要 dsh）。
 *
 * 用法：node scripts/dev-console.mjs [dataDir] [port]
 * 输出：控制台 URL 与 token（同时也写 <dataDir>/console-token.txt）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply } from '../lib/index.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.resolve(process.argv[2] || path.join(repoRoot, '.work', 'console-dev'));
const port = Number(process.argv[3] || 6199);
const workspaceRoot = path.join(dataDir, 'workspace');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(workspaceRoot, { recursive: true });

const ctx = { get: () => undefined, effect: () => () => {} };
const runtime = await apply(ctx, {
  dataDir,
  workspaceRoot,
  autoStart: false,
  debug: false,
  console: { enabled: true, host: '127.0.0.1', port, token: '' },
});

// ── 演示数据（幂等：已有 bot 就跳过）──
const store = runtime.config;
if (store.listBots().length === 0) {
  const bot = store.createBot({ name: '演示机器人', appId: '100000001' });
  const small = store.createProfile(bot.id, { name: '私聊·安静', data: { reply: { mode: 'mention' } } });
  const group = store.createProfile(bot.id, { name: '大群·活泼', data: { reply: { mode: 'adaptive' }, model: { preset: 'qqbot-buddy' } } });
  store.upsertBinding(bot.id, 'qq:group:123456', group.id, 10);
  store.upsertBinding(bot.id, 'qq:c2c:*', small.id, 5);
  store.patchSettings(bot.id, { reply: { keywords: ['在吗', '救命'], splitBubbles: true }, persona: { activeCardId: '' } });
  if (runtime.kb) {
    runtime.kb.ingest({ botId: bot.id, source: 'kb/team.md', title: '团建安排', text: '# 团建安排\n\n本周六下午三点在滨江公园集合，带好外套。\n\n费用由部门承担，报名截止周五中午。' });
    runtime.kb.ingest({ botId: bot.id, source: 'kb/faq.md', title: '常见问题', text: '# 常见问题\n\n问：怎么请假？ 答：在 OA 提交，直属主管审批。' });
  }
  if (runtime.memory) {
    runtime.memory.save({ botId: bot.id, peer: 'group:123456', text: '群友小k 喜欢猫，周末常去露营', kind: 'fact' });
    runtime.memory.save({ botId: bot.id, peer: 'c2c:alice', text: 'alice 在杭州做前端，偏好简洁回答', kind: 'fact' });
  }
  runtime.db.prepare("INSERT INTO members(bot_id, openid, nickname, note, updated_at) VALUES(?,?,?,?,?)")
    .run(bot.id, 'u_alice', 'Alice', '前端工程师，杭州', Date.now());
  runtime.db.prepare("INSERT INTO members(bot_id, openid, nickname, note, updated_at) VALUES(?,?,?,?,?)")
    .run(bot.id, 'u_bob', '小K', '喜欢猫，露营爱好者', Date.now());
  const pid = 'prs_demo';
  runtime.db.prepare("INSERT OR REPLACE INTO personas(id, bot_id, name, content, active, created_at, updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(pid, bot.id, '默认助手', '你是一个耐心、简洁的 QQ 群助手，回答不超过三句。', 1, Date.now(), Date.now());
  store.audit({ botId: bot.id, kind: 'demo.seed', detail: '演示数据已就绪' });
}
await runtime.discovery?.refresh?.();

const address = runtime.console && runtime.console.address();
const tokenFile = path.join(dataDir, 'console-token.txt');
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '(未生成)';
console.log('控制台: ' + (address && address.url ? address.url : '(启动失败)'));
console.log('token : ' + token);
console.log('data  : ' + dataDir);
setInterval(() => {}, 1 << 30);
