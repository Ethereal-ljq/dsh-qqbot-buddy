/**
 * qq-interaction —— INTERACTION_CREATE 分流：按钮 ack+投喂 / 反馈 / 清空会话 / 其余不 ack。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInteractionHandler } from '../lib/qq/interaction.js';

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


/** 互动回调测试夹具：记录 ack / feedAgent / manager.reset。 */
function makeRig({ settings = {}, feedImpl, resetImpl, ackImpl, getBot } = {}) {
  const log = createFakeLogger();
  const stats = {};
  const acks = [];
  const fed = [];
  const resets = [];
  const bot = {
    acknowledgeInteraction: async (id, code) => {
      acks.push({ id, code });
      if (ackImpl) return ackImpl(id, code);
      return { ok: true };
    },
  };
  const manager = {
    reset: async (scope, peerId) => {
      resets.push({ scope, peerId });
      if (resetImpl) return resetImpl(scope, peerId);
    },
  };
  const handler = createInteractionHandler({
    manager: manager,
    getSettings: () => settings,
    logger: log,
    stats: stats,
    getBot: getBot === undefined ? () => bot : getBot,
    feedAgent: async (payload) => {
      fed.push(payload);
      if (feedImpl) return feedImpl(payload);
    },
  });
  return { handler, acks, fed, resets, stats, log, bot };
}

/** 构造一条 INTERACTION_CREATE 事件。 */
function interaction(type, extra = {}) {
  const base = {
    id: 'i-' + type,
    type: type,
    version: 1,
    data: { type: type, resolved: {} },
  };
  return {
    ...base,
    ...extra,
    data: { ...base.data, ...(extra.data || {}) },
  };
}

const buttonClick = (scene, extra = {}) => interaction(11, {
  scene: scene,
  user_openid: 'U-1',
  group_openid: 'G-1',
  group_member_openid: 'M-1',
  data: { resolved: { button_id: 'btn-1', button_data: '/new', message_id: 'msg-1' } },
  ...extra,
});

test('type=11 单聊按钮：先 ack(0)，再把 button_data 投喂 agent', async () => {
  const { handler, acks, fed } = makeRig();
  await handler({ bot: {} }, buttonClick('c2c'));
  assert.deepEqual(acks, [{ id: 'i-11', code: 0 }]);
  assert.deepEqual(fed, [{
    scope: 'c2c',
    peerId: 'U-1',
    text: '/new',
    buttonId: 'btn-1',
    messageId: 'msg-1',
  }]);
});

test('type=12 群聊快捷菜单：scope=group，peerId=group_openid', async () => {
  const { handler, acks, fed } = makeRig();
  await handler({ bot: {} }, interaction(12, {
    scene: 'group',
    group_openid: 'G-9',
    data: { resolved: { button_id: 'btn-2', button_data: '继续', message_id: 'msg-2' } },
  }));
  assert.deepEqual(acks, [{ id: 'i-12', code: 0 }]);
  assert.equal(fed[0].scope, 'group');
  assert.equal(fed[0].peerId, 'G-9');
  assert.equal(fed[0].text, '继续');
});

test('scene 缺失时按 chat_type 推断 scope', async () => {
  const { handler, fed } = makeRig();
  await handler({ bot: {} }, interaction(12, {
    chat_type: 2,
    group_openid: 'G-7',
    data: { resolved: { button_id: 'b', button_data: 'x' } },
  }));
  assert.equal(fed[0].scope, 'group');
  assert.equal(fed[0].peerId, 'G-7');

  const c2c = makeRig();
  await c2c.handler({ bot: {} }, interaction(11, {
    chat_type: 1,
    user_openid: 'U-7',
    data: { resolved: { button_id: 'b' } },
  }));
  assert.equal(c2c.fed[0].scope, 'c2c');
  assert.equal(c2c.fed[0].peerId, 'U-7');
});

test('button_data 为空时退到 button_id 作为投喂文本', async () => {
  const { handler, fed } = makeRig();
  await handler({ bot: {} }, interaction(11, {
    scene: 'c2c',
    user_openid: 'U-2',
    data: { resolved: { button_id: 'btn-only' } },
  }));
  assert.equal(fed[0].text, 'btn-only');
});

test('feedToAgent=false：只 ack，不投喂', async () => {
  const { handler, acks, fed } = makeRig({ settings: { interaction: { feedToAgent: false } } });
  await handler({ bot: {} }, buttonClick('c2c'));
  assert.deepEqual(acks, [{ id: 'i-11', code: 0 }]);
  assert.equal(fed.length, 0);
});

test('feedAgent 抛错：ack 已完成，异常只记日志', async () => {
  const rig = makeRig({ feedImpl: async () => { throw new Error('agent down'); } });
  await rig.handler({ bot: {} }, buttonClick('c2c'));
  assert.deepEqual(rig.acks, [{ id: 'i-11', code: 0 }]);
  assert.ok(rig.log.byLevel('warn').some((args) => String(args[0]).includes('投喂 agent 失败')));
});

test('ack 抛错：不抛出，也不影响后续投喂', async () => {
  const rig = makeRig({ ackImpl: async () => { throw new Error('40034005 expired'); } });
  await rig.handler({ bot: {} }, buttonClick('c2c'));
  assert.equal(rig.fed.length, 1);
  assert.ok(rig.log.byLevel('warn').some((args) => String(args[0]).includes('ack 失败')));
});

test('type=13 消息反馈：记录 feedback_opt，不 ack', async () => {
  const { handler, acks, stats } = makeRig();
  await handler({ bot: {} }, interaction(13, { scene: 'c2c', user_openid: 'U-3', data: { feedback_opt: 'LIKE' } }));
  assert.equal(acks.length, 0, '反馈事件不需要 PUT');
  assert.equal(stats.lastFeedbackOpt, 'LIKE');
  assert.equal(stats.interactionFeedback, 1);
});

test('type=14 清空会话：默认调 manager.reset，不 ack', async () => {
  const { handler, acks, resets } = makeRig();
  await handler({ bot: {} }, interaction(14, { scene: 'group', group_openid: 'G-5', user_openid: 'U-5' }));
  assert.equal(acks.length, 0);
  assert.deepEqual(resets, [{ scope: 'group', peerId: 'G-5' }]);
});

test('type=14：resetOnClearSession=false 时不 reset，不 ack', async () => {
  const { handler, acks, resets } = makeRig({ settings: { interaction: { resetOnClearSession: false } } });
  await handler({ bot: {} }, interaction(14, { scene: 'c2c', user_openid: 'U-6' }));
  assert.equal(acks.length, 0);
  assert.equal(resets.length, 0);
});

test('type=14 manager.reset 抛错：只记日志', async () => {
  const rig = makeRig({ resetImpl: async () => { throw new Error('reset fail'); } });
  await assert.doesNotReject(() => rig.handler({ bot: {} }, interaction(14, { scene: 'c2c', user_openid: 'U-8' })));
  assert.ok(rig.log.byLevel('warn').some((args) => String(args[0]).includes('清空会话失败')));
});

test('type=15/16/18/19/20：只记统计，不 ack / 不投喂 / 不 reset', async () => {
  const { handler, acks, fed, resets, stats } = makeRig();
  for (const type of [15, 16, 18, 19, 20]) {
    await handler({ bot: {} }, interaction(type, { scene: 'c2c', user_openid: 'U-9' }));
  }
  assert.equal(acks.length, 0);
  assert.equal(fed.length, 0);
  assert.equal(resets.length, 0);
  assert.equal(stats.interactionIgnored, 5);
});

test('未知 type：不 ack（旧行为无条件 ack 3 是错的）', async () => {
  const { handler, acks, stats } = makeRig();
  await handler({ bot: {} }, interaction(99, { scene: 'c2c', user_openid: 'U-10' }));
  assert.equal(acks.length, 0);
  assert.equal(stats.interactionUnknown, 1);
});

test('兼容只传 ctx（事件在 ctx.event 里）与字符串 type', async () => {
  const { handler, acks, fed } = makeRig();
  const event = buttonClick('c2c', { type: '11' });
  await handler({ bot: {}, event: event });
  assert.equal(acks.length, 1);
  assert.equal(fed.length, 1);
});

test('没有 bot / getBot 时按钮事件不 ack 也不抛', async () => {
  const { handler, fed } = makeRig({ getBot: () => null });
  await assert.doesNotReject(() => handler({}, buttonClick('c2c')));
  assert.equal(fed.length, 1, 'ack 不可用不影响投喂');
});
