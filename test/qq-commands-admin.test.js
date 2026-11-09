/**
 * commands-admin 单测：COMMAND_CATALOG / adminStatus / /id / /help / 管理员门控 /
 * 未知命令放行 / 设置读取失败降级 / adaptive 清理只对真正执行的命令。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMAND_CATALOG,
  adminStatus,
  createCommandMiddleware,
  handleCommand,
} from '../lib/qq/commands.js';

const ADMIN_ONLY = ['new', 'reset', 'clear', 'resume', 'stop'];
const DEFAULT_STATS = { received: 0, triggered: 0, skipped: 0, replies: 0, lastReplyAt: 0, lastTriggerReason: '' };

function makeSettings(values) {
  return { get() { return JSON.parse(JSON.stringify(values || {})); } };
}
function throwingSettings() {
  return { get() { throw new Error('settings boom'); } };
}
function makeLogger() {
  const entries = [];
  const push = (level) => (...args) => entries.push([level, args]);
  return { entries, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}
function makeBot() {
  const sent = [];
  return {
    sent,
    async sendMarkdown(target, text) {
      sent.push({ target, text });
      return { id: 'sent-' + sent.length };
    },
  };
}
function makeManager() {
  const calls = { reset: 0, resume: 0, record: 0 };
  return {
    calls,
    async reset() { calls.reset += 1; return { ok: true, resumable: 0 }; },
    async resumePrevious() { calls.resume += 1; return { ok: false }; },
    getSessionRecord() { calls.record += 1; return undefined; },
  };
}
function makeContext(text, messageOverrides = {}) {
  const message = Object.assign({
    kind: 'group',
    groupOpenid: 'g1',
    senderId: 'u1',
    senderName: '小明',
    content: text,
    attachments: [],
    messageId: 'm1',
  }, messageOverrides);
  return {
    message,
    replyTarget: { scope: 'group', targetId: 'g1', msgId: 'm1' },
    state: {},
    receivedAt: Date.now(),
    stopped: '',
    stop(reason) { this.stopped = reason; },
  };
}

async function runCommand({ settings, text, manager, bot, logger, adaptive, messageOverrides } = {}) {
  const usedBot = bot || makeBot();
  const usedManager = manager || makeManager();
  const usedLogger = logger || makeLogger();
  const mw = createCommandMiddleware({
    settings: settings || makeSettings({}),
    manager: usedManager,
    logger: usedLogger,
    stats: DEFAULT_STATS,
    getBot: () => usedBot,
    adaptive,
  });
  const ctx = makeContext(text, messageOverrides);
  let nexted = false;
  await mw(ctx, async () => { nexted = true; });
  return { ctx, nexted, bot: usedBot, manager: usedManager, logger: usedLogger };
}

// ── 命令目录 ─────────────────────────────────────────────
test('COMMAND_CATALOG：包含 9 条命令，字段完整，adminOnly 与 DESIGN 一致', () => {
  assert.ok(Array.isArray(COMMAND_CATALOG));
  assert.deepEqual(COMMAND_CATALOG.map((item) => item.name),
    ['help', 'ping', 'status', 'id', 'new', 'reset', 'clear', 'resume', 'stop']);
  for (const item of COMMAND_CATALOG) {
    assert.equal(typeof item.name, 'string');
    assert.equal(item.usage, '/' + item.name);
    assert.equal(typeof item.description, 'string');
    assert.ok(item.description.length > 0);
    assert.equal(typeof item.adminOnly, 'boolean');
    assert.ok(Object.isFrozen(item), 'catalog 条目应冻结');
  }
  assert.deepEqual(
    COMMAND_CATALOG.filter((item) => item.adminOnly).map((item) => item.name),
    ADMIN_ONLY,
  );
  assert.ok(Object.isFrozen(COMMAND_CATALOG));
});

// ── adminStatus 矩阵 ─────────────────────────────────────
test('adminStatus：enabled/configured/enforced/isAdmin/allowed 矩阵', () => {
  const enforcedCfg = { admin: { enabled: true, openids: ['u-admin'], names: ['管理员'] } };

  let s = adminStatus(enforcedCfg, 'u-admin', '路人');
  assert.equal(s.enabled, true);
  assert.equal(s.configured, true);
  assert.equal(s.enforced, true);
  assert.equal(s.isAdmin, true);
  assert.equal(s.matchedBy, 'openid');
  assert.equal(s.allowed, true);

  s = adminStatus(enforcedCfg, 'u-x', '管理员');
  // v0.11：昵称不再参与判定（任何人改群昵称即可冒充管理员，且跨群昵称不同）
  assert.equal(s.isAdmin, false);
  assert.equal(s.matchedBy, '');
  assert.equal(s.allowed, false);

  s = adminStatus(enforcedCfg, 'u-x', '路人');
  assert.equal(s.isAdmin, false);
  assert.equal(s.matchedBy, '');
  assert.equal(s.allowed, false);

  // enabled=true 但名单为空 -> 不强制
  s = adminStatus({ admin: { enabled: true, openids: [], names: [] } }, 'u1', '小明');
  assert.equal(s.enforced, false);
  assert.equal(s.allowed, true);

  // enabled=false 但命中名单 -> 不强制，且 isAdmin 仍为 true（/id 展示）
  s = adminStatus({ admin: { enabled: false, openids: ['u1'], names: [] } }, 'u1', '小明');
  assert.equal(s.enabled, false);
  assert.equal(s.enforced, false);
  assert.equal(s.isAdmin, true);
  assert.equal(s.allowed, true);

  // 缺省 / 空
  s = adminStatus(undefined, 'u1', '小明');
  assert.equal(s.enabled, false);
  assert.equal(s.enforced, false);
  assert.equal(s.allowed, true);

  // 也接受直接传 settings.admin 对象
  s = adminStatus({ enabled: true, openids: ['u1'], names: [] }, 'u1', '');
  assert.equal(s.enforced, true);
  assert.equal(s.isAdmin, true);

  // 首尾空白 trim 后匹配
  s = adminStatus(enforcedCfg, '  u-admin  ', '  管理员  ');
  assert.equal(s.isAdmin, true);
});

// ── /id 公开展示 ────────────────────────────────────────
test('/id：展示昵称/openid，并按门控状态显示管理员身份', async () => {
  // 门控未启用
  let result = await runCommand({ settings: makeSettings({}), text: '/id' });
  assert.equal(result.ctx.stopped, 'command:id');
  let text = result.bot.sent[0].text;
  assert.ok(text.includes('小明'), '应展示昵称: ' + text);
  assert.ok(text.includes('u1'), '应展示 openid');
  assert.ok(text.includes('门控未启用'), '未启用时应说明');

  // 门控启用 + 管理员
  const adminSettings = makeSettings({ admin: { enabled: true, openids: ['u1'], names: [] } });
  result = await runCommand({ settings: adminSettings, text: '/id' });
  text = result.bot.sent[0].text;
  assert.ok(text.includes('管理员：是'), '管理员应显示是: ' + text);
  assert.ok(text.includes('可执行管理员命令'), '应列出管理员命令');

  // 门控启用 + 非管理员
  result = await runCommand({ settings: adminSettings, text: '/id', messageOverrides: { senderId: 'u2', senderName: '路人' } });
  text = result.bot.sent[0].text;
  assert.ok(text.includes('管理员：否'));
  assert.ok(text.includes('u2'));
  assert.ok(text.includes('请让管理员'), '应含配置指引');

  // 门控开启但名单为空
  result = await runCommand({ settings: makeSettings({ admin: { enabled: true, openids: [], names: [] } }), text: '/id' });
  assert.ok(result.bot.sent[0].text.includes('名单为空'));
});

// ── /help 由目录生成并标注管理员命令 ────────────────────
test('/help：逐条来自 COMMAND_CATALOG，管理员命令带（管理员）标注与门控说明', async () => {
  const enforced = makeSettings({ admin: { enabled: true, openids: ['u-admin'], names: [] } });
  let result = await runCommand({ settings: enforced, text: '/help' });
  let text = result.bot.sent[0].text;
  for (const item of COMMAND_CATALOG) {
    const line = item.usage + '：' + item.description + (item.adminOnly ? '（管理员）' : '');
    assert.ok(text.includes(line), 'help 应包含目录行: ' + line + '\n实际: ' + text);
  }
  assert.ok(text.includes('管理员门控已启用'), '启用时应说明门控状态');

  // 未启用门控
  result = await runCommand({ settings: makeSettings({}), text: '/help' });
  text = result.bot.sent[0].text;
  assert.ok(text.includes('管理员门控未启用'));
  assert.ok(text.includes('/id：'), '/help 应包含 /id');
});

// ── 管理员门控：拒绝时清晰提示、命令不执行 ─────────────
test('管理员门控：enabled+名单非空时非管理员被拒，且不执行状态变更命令', async () => {
  const settings = makeSettings({ admin: { enabled: true, openids: ['u-admin'], names: [] } });
  const manager = makeManager();
  const bot = makeBot();
  const result = await runCommand({
    settings,
    text: '/new',
    manager,
    bot,
    messageOverrides: { senderId: 'u2', senderName: '路人' },
  });
  assert.equal(result.nexted, false, '命令应短路');
  assert.equal(result.ctx.stopped, 'command:new');
  assert.equal(manager.calls.reset, 0, '非管理员不应真正执行 /new');
  const text = bot.sent[0].text;
  assert.ok(text.includes('仅管理员'), '应明确提示仅管理员: ' + text);
  assert.ok(text.includes('u2'), '应给出自己的 openid');
  // 第四批 UI 后 tab 改名为「命令与权限 → 管理员」；同时兼容旧路径文案
  assert.ok(
    text.includes('命令与权限 → 管理员') || text.includes('设置 → QQ 机器人 → 管理员'),
    '应给出配置路径（命令与权限 → 管理员）: ' + text,
  );
  assert.ok(text.includes('/id'), '应引导用 /id 查看 openid');
});

test('管理员门控：管理员可执行；公开命令非管理员可用', async () => {
  const settings = makeSettings({ admin: { enabled: true, openids: ['u-admin'], names: [] } });
  let manager = makeManager();
  let result = await runCommand({
    settings,
    text: '/new',
    manager,
    messageOverrides: { senderId: 'u-admin', senderName: '管理员' },
  });
  assert.equal(manager.calls.reset, 1, '管理员执行 /new 应成功');
  assert.ok(result.bot.sent[0].text.includes('新会话'));

  // 公开命令非管理员可用
  manager = makeManager();
  result = await runCommand({
    settings,
    text: '/status',
    manager,
    messageOverrides: { senderId: 'u2', senderName: '路人' },
  });
  assert.ok(result.bot.sent[0].text.includes('QQ 机器人状态'));
  assert.equal(manager.calls.reset, 0);

  // 昵称匹配也可
  manager = makeManager();
  result = await runCommand({
    settings: makeSettings({ admin: { enabled: true, openids: [], names: ['管理员甲'] } }),
    text: '/stop',
    manager,
    messageOverrides: { senderId: 'u9', senderName: '管理员甲' },
  });
  assert.equal(manager.calls.record, 1, '昵称命中应允许执行 /stop');
});

test('管理员门控：未启用 / 名单为空 / 设置读取失败时保持旧行为（所有人可用）', async () => {
  const cases = [
    { name: 'enabled=false 且有名单', settings: makeSettings({ admin: { enabled: false, openids: ['u-admin'], names: [] } }) },
    { name: 'enabled=true 但名单为空', settings: makeSettings({ admin: { enabled: true, openids: [], names: [] } }) },
    { name: '缺少 admin 配置', settings: makeSettings({}) },
    { name: 'settings.get 抛错', settings: throwingSettings() },
  ];
  for (const item of cases) {
    const manager = makeManager();
    const result = await runCommand({
      settings: item.settings,
      text: '/new',
      manager,
      messageOverrides: { senderId: 'u2', senderName: '路人' },
    });
    assert.equal(manager.calls.reset, 1, item.name + '：应保持旧行为直接执行 /new');
    assert.ok(result.bot.sent[0].text.includes('新会话'), item.name + '：应回复成功');
  }
});

test('canonical：/reset /clear /resume 同为管理员命令，非管理员全部被拒', async () => {
  const settings = makeSettings({ admin: { enabled: true, openids: ['u-admin'], names: [] } });
  for (const cmd of ['/reset', '/clear', '/resume']) {
    const manager = makeManager();
    const result = await runCommand({
      settings,
      text: cmd,
      manager,
      messageOverrides: { senderId: 'u2', senderName: '路人' },
    });
    assert.equal(manager.calls.reset, 0, cmd + ' 不应执行');
    assert.equal(manager.calls.resume, 0, cmd + ' 不应执行 resume');
    assert.ok(result.bot.sent[0].text.includes('仅管理员'), cmd + ' 应被拒绝');
    assert.equal(result.ctx.stopped, 'command:' + cmd.slice(1));
  }
});

// ── 未知命令放行 / adaptive 清理 ────────────────────────
test('未知 /xxx 不拦截（按普通消息继续走频率策略）', async () => {
  const settings = makeSettings({ admin: { enabled: true, openids: ['u-admin'], names: [] } });
  const result = await runCommand({
    settings,
    text: '/not-a-command',
    messageOverrides: { senderId: 'u2', senderName: '路人' },
  });
  assert.equal(result.nexted, true, '未知命令应放行');
  assert.equal(result.ctx.stopped, '', '未知命令不应 stop');
  assert.equal(result.bot.sent.length, 0);
});

test('adaptive 清理：只有真正执行的命令才清缓冲，被拒的管理员命令不清', async () => {
  const settings = makeSettings({ admin: { enabled: true, openids: ['u-admin'], names: [] } });
  const calls = [];
  const adaptive = { noteForcedTrigger(peerKey) { calls.push(peerKey); } };

  // 被拒绝：不清缓冲
  await runCommand({
    settings,
    text: '/new',
    adaptive,
    messageOverrides: { senderId: 'u2', senderName: '路人' },
  });
  assert.equal(calls.length, 0, '被拒命令不应清 adaptive 缓冲');

  // 执行成功：清缓冲
  await runCommand({
    settings,
    text: '/status',
    adaptive,
    messageOverrides: { senderId: 'u2', senderName: '路人' },
  });
  assert.deepEqual(calls, ['group:g1'], '执行的命令应清该群缓冲');
});

// ── handleCommand 直接调用（settings.get 抛错也不崩） ──
test('handleCommand：/help 与 /id 在设置读取失败时降级为未启用', async () => {
  const ctx = makeContext('/help');
  const manager = makeManager();
  const helpText = await handleCommand({
    name: 'help',
    ctx,
    scope: 'group',
    peerId: 'g1',
    settings: throwingSettings(),
    manager,
    stats: DEFAULT_STATS,
  });
  assert.ok(helpText.includes('管理员门控未启用'));
  const idText = await handleCommand({
    name: 'id',
    ctx,
    scope: 'group',
    peerId: 'g1',
    settings: throwingSettings(),
    manager,
    stats: DEFAULT_STATS,
  });
  assert.ok(idText.includes('门控未启用'));
  assert.ok(idText.includes('u1'));
});

test('stripLeadingMentions：剥离 openid 形态的 @ 提及（SDK 只认纯数字）', async () => {
  const { stripLeadingMentions } = await import('../lib/qq/commands.js');
  // 新版 QQ 群：mention 用 openid（字母数字混合），SDK 的 <@!?\d+> 正则剥不掉
  assert.equal(stripLeadingMentions('<@!5F23DAE1EBC75E95C88C160AC350A6A0> /new'), '/new');
  assert.equal(stripLeadingMentions('<@123456789> /help'), '/help');
  assert.equal(stripLeadingMentions('<@!a> <@!b> /status'), '/status');
  assert.equal(stripLeadingMentions('/ping'), '/ping');
  assert.equal(stripLeadingMentions('   /id   '), '/id');
  assert.equal(stripLeadingMentions('普通消息'), '普通消息');
  assert.equal(stripLeadingMentions(''), '');
  assert.equal(stripLeadingMentions(undefined), '');
});

test('adminStatus：只按 openid 判定，昵称不再生效（防冒充）', async () => {
  const { adminStatus } = await import('../lib/qq/commands.js');
  const cfg = { admin: { enabled: true, openids: ['OPENID_A'], names: ['小明'] } };
  assert.equal(adminStatus(cfg, 'OPENID_A', '路人').isAdmin, true);
  assert.equal(adminStatus(cfg, 'OPENID_A', '路人').matchedBy, 'openid');
  // 昵称冒充应失败
  assert.equal(adminStatus(cfg, 'OTHER', '小明').isAdmin, false, '昵称不应再命中');
  assert.equal(adminStatus(cfg, 'OTHER', '小明').allowed, false);
  // 只配 names 视为未配置 -> 不强制门控（保持旧行为）
  const namesOnly = { admin: { enabled: true, openids: [], names: ['小明'] } };
  assert.equal(adminStatus(namesOnly, 'OTHER', '小明').enforced, false);
});
