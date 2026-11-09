/**
 * qq-events —— rawEvent 处理：欢迎语开关 / 主动消息许可状态 / 重复推送幂等 / 失败不抛。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRawEventHandler } from '../lib/qq/events.js';

/** 自包含的假 logger（v1 test/helpers/fake-ctx.js 的 createFakeLogger 移植）。 */
function createFakeLogger(entries = []) {
  const make = (level) => (...args) => { entries.push({ level, args, at: Date.now() }); };
  const logger = {
    entries,
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
    child: () => createFakeLogger(entries),
    byLevel(level) { return entries.filter((entry) => entry.level === level).map((entry) => entry.args); },
  };
  return logger;
}


/** rawEvent 处理器测试夹具；sender 传 null 表示「统一 sender 不可用」。 */
function makeRig({ settings = {}, sender, getSender } = {}) {
  const log = createFakeLogger();
  const stats = {};
  const sent = [];
  const senderObj = sender !== undefined ? sender : {
    sendProactive: async (target, text) => {
      sent.push({ target, text });
      return { ok: true };
    },
  };
  const handler = createRawEventHandler({
    getSender: getSender !== undefined ? getSender : () => senderObj,
    getSettings: () => settings,
    logger: log,
    stats,
  });
  return { handler, sent, stats, log, sender: senderObj };
}

const ctxOf = (eventType, data, extra = {}) => ({ bot: {}, eventType, data, state: {}, receivedAt: 1, ...extra });

test('处理器上挂 .state：两个主动消息许可 Map', () => {
  const { handler } = makeRig();
  assert.ok(handler.state, '.state 应存在');
  assert.ok(handler.state.activeAllowed instanceof Map);
  assert.ok(handler.state.groupActiveAllowed instanceof Map);
});

test('FRIEND_ADD：开关打开且填写了文案时按文案发欢迎（主动消息）', async () => {
  const { handler, sent, stats } = makeRig({
    settings: { welcome: { friendEnabled: true, friendText: '欢迎新朋友～' } },
  });
  await handler(ctxOf('FRIEND_ADD', { openid: 'U-1', timestamp: '100' }));
  assert.deepEqual(sent, [{ target: { scope: 'c2c', targetId: 'U-1' }, text: '欢迎新朋友～' }]);
  assert.equal(stats.welcomeSent, 1);
});

test('FRIEND_ADD：开关关闭时不发；默认关闭', async () => {
  const disabled = makeRig({ settings: { welcome: { friendEnabled: false } } });
  await disabled.handler(ctxOf('FRIEND_ADD', { openid: 'U-1', timestamp: '1' }));
  assert.equal(disabled.sent.length, 0);
  assert.equal(disabled.stats.welcomeDisabled, 1);

  // 完全没有 welcome 设置（旧 settings.json）也按关闭处理，不炸
  const missing = makeRig();
  await missing.handler(ctxOf('FRIEND_ADD', { openid: 'U-2', timestamp: '2' }));
  assert.equal(missing.sent.length, 0);
});

test('FRIEND_ADD：文案留空时用内置欢迎语（温和、不自称真人）', async () => {
  const { handler, sent } = makeRig({ settings: { welcome: { friendEnabled: true, friendText: '   ' } } });
  await handler(ctxOf('FRIEND_ADD', { openid: 'U-3', timestamp: '3' }));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes('AI 助手'));
  assert.ok(sent[0].text.length > 0);
});

test('GROUP_ADD_ROBOT：群欢迎发到 group_openid', async () => {
  const { handler, sent } = makeRig({
    settings: { welcome: { groupEnabled: true, groupText: '谢谢拉我进群～' } },
  });
  await handler(ctxOf('GROUP_ADD_ROBOT', { group_openid: 'G-1', op_member_openid: 'M-1', timestamp: '10' }));
  assert.deepEqual(sent, [{ target: { scope: 'group', targetId: 'G-1' }, text: '谢谢拉我进群～' }]);
});

test('GROUP_ADD_ROBOT：开关关闭时用内置群欢迎语以外的路径不发', async () => {
  const { handler, sent } = makeRig({ settings: { welcome: { groupEnabled: false } } });
  await handler(ctxOf('GROUP_ADD_ROBOT', { group_openid: 'G-2', timestamp: '11' }));
  assert.equal(sent.length, 0);
});

test('同一事件重复推送：按 eventType+openid+timestamp 幂等，只发一次欢迎', async () => {
  const { handler, sent, stats } = makeRig({
    settings: { welcome: { friendEnabled: true, friendText: 'hi' } },
  });
  const event = ctxOf('FRIEND_ADD', { openid: 'U-DUP', timestamp: '999' });
  await handler(event);
  await handler(event);
  await handler(ctxOf('FRIEND_ADD', { openid: 'U-DUP', timestamp: '1000' }));
  assert.equal(sent.length, 2, '重复推送被丢弃，新 timestamp 视为新事件');
  assert.equal(stats.rawEventDuplicates, 1);
});

test('欢迎语发送失败只记日志，不抛错', async () => {
  const { handler, log } = makeRig({
    settings: { welcome: { friendEnabled: true, friendText: 'hi' } },
    sender: { sendProactive: async () => { throw new Error('40034027 not allowed'); } },
  });
  await handler(ctxOf('FRIEND_ADD', { openid: 'U-FAIL', timestamp: '5' }));
  assert.ok(log.byLevel('warn').some((args) => String(args[0]).includes('欢迎语发送失败')));
});

test('没有统一 sender 时跳过欢迎语，不抛错', async () => {
  const { handler, sent, stats } = makeRig({
    settings: { welcome: { friendEnabled: true } },
    sender: null,
  });
  await handler(ctxOf('FRIEND_ADD', { openid: 'U-NOSENDER', timestamp: '6' }));
  assert.equal(sent.length, 0);
  assert.equal(stats.welcomeSkipped, 1);
});

test('getSender 抛异常时同样只降级不抛', async () => {
  const { handler } = makeRig({
    settings: { welcome: { friendEnabled: true } },
    getSender: () => { throw new Error('sender broken'); },
  });
  await assert.doesNotReject(() => handler(ctxOf('FRIEND_ADD', { openid: 'U-X', timestamp: '7' })));
});

test('C2C_MSG_RECEIVE / C2C_MSG_REJECT：记录用户是否允许主动消息', async () => {
  const { handler } = makeRig();
  await handler(ctxOf('C2C_MSG_RECEIVE', { openid: 'U-A', timestamp: '20' }));
  assert.equal(handler.state.activeAllowed.get('U-A'), true);
  await handler(ctxOf('C2C_MSG_REJECT', { openid: 'U-A', timestamp: '21' }));
  assert.equal(handler.state.activeAllowed.get('U-A'), false);
});

test('GROUP_MSG_RECEIVE / GROUP_MSG_REJECT：记录群是否允许主动消息', async () => {
  const { handler } = makeRig();
  await handler(ctxOf('GROUP_MSG_RECEIVE', { group_openid: 'G-A', timestamp: '30' }));
  assert.equal(handler.state.groupActiveAllowed.get('G-A'), true);
  await handler(ctxOf('GROUP_MSG_REJECT', { group_openid: 'G-A', timestamp: '31' }));
  assert.equal(handler.state.groupActiveAllowed.get('G-A'), false);
});

test('未知 rawEvent / 缺字段的 data 都被安全忽略', async () => {
  const { handler, sent, stats } = makeRig({ settings: { welcome: { friendEnabled: true } } });
  await handler(ctxOf('MESSAGE_REACTION_ADD', { some: 'x' }));
  await handler(ctxOf('FRIEND_ADD', {}));
  await handler({ eventType: '', data: {} });
  await handler(undefined);
  assert.equal(sent.length, 0);
  assert.ok(stats.rawEvents >= 2);
});
