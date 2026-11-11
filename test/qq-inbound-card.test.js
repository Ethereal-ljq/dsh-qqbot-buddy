/**
 * inbound-card —— 入站组装的三项新增：ARK 卡片解析、引用 refIdx、兜底提示走统一 sender。
 *
 * ⚠️ 2026-11-11 卡片渲染规则调整（见 .work/CARD-MESSAGE-ANALYSIS.md §3 / §6），本文件顶部
 * 原有的几条用例断言的是**旧规则**，已随之更新，原因如下（不是为了让测试变绿而放宽断言）：
 *
 *   1) 行前缀由 `[卡片]` 改为带模板标记的 `[卡片:模板名]` / `[卡片:type=37]`。
 *      理由：模型需要知道这是「小程序卡片」还是「图文H5」，否则无从判断能不能给出链接。
 *
 *   2) **删除**了「摘要回落到 fields.preview」这条旧行为。
 *      旧用例 'ARK 卡片：只有 prompt / preview 时也能出内容' 断言
 *      `'[卡片] https://example.com/p.png'` —— 这恰恰是 B站小程序卡片真实表现出 bug 的那一步：
 *      preview 是 qq.ugcimg.cn 上的加密跳转封面图，不是链接，也会把 ark.prompt 里的真摘要挤掉。
 *      现在 preview 永远不进入卡片行，该用例被替换为反断言（preview 不出现 + 摘要取自 prompt）。
 *
 *   3) 摘要改为取 `strip(ark.prompt)`（剥掉 `[QQ小程序]` 前缀）；无 jump_url 时行尾追加
 *      `（小程序卡片，无可点击链接）`。旧用例断言的 `[QQ小程序]哔哩哔哩` 里的方括号模板名
 *      对模型是噪音，且缺少「没有链接」的显式信号会让模型去猜/编造链接。
 *
 *   4) 完全没有内容字段时只输出 `[卡片:小程序]`，不再输出 `[卡片] 小程序`
 *      （旧格式把模板名塞在「标题」位上，容易和真实标题混淆）。
 *
 * 新规则见 lib/qq/card-render.js；真实结构用例见本文件后半部分（B站小程序卡片 / 小黑盒图文H5 /
 * 群历史回填 / 历史无覆盖记录仍跳过）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleAgentBody, createInboundHandler } from '../lib/qq/inbound.js';
import { CARD_CACHE_LIMITS, cardCacheSize, clearCardCache, lookupCard, rememberCard } from '../lib/qq/card-render.js';

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


/** 卡片消息：SDK 把事件体放在 msg.raw 里，ark_data 也在 raw 中。 */
function cardMessage({ fields = {}, ark = {}, extra = {} } = {}) {
  return {
    kind: 'c2c',
    content: '',
    messageId: 'm-card',
    senderId: 'U-CARD-1',
    msgType: 3,
    raw: { ark_data: { ark_type: 37, prompt: '', fields: fields, ...ark } },
    ...extra,
  };
}

const userText = (message) => message && message.content && message.content[0] && message.content[0].text;

/**
 * 入站处理器测试夹具。
 * @param {object} [options]
 * @param {boolean} [options.withSender] 是否注入 getSender（默认不注入，走旧 bot.sendMarkdown）
 * @param {object} [options.manager] 覆盖 manager（触发兜底提示）
 */
function makeRig({ withSender = false, manager, settings } = {}) {
  const created = [];
  const follows = [];
  const botSend = [];
  const senderSend = [];
  const log = createFakeLogger();
  const record = {
    agent: {
      followup: async (message) => { follows.push(message); },
      whenIdle: async () => {},
    },
    turn: { current: null },
  };
  const mgr = manager || {
    getOrCreate: async (scope, peerId, senderId, replyTarget) => {
      created.push({ scope, peerId, senderId, replyTarget });
      return record;
    },
  };
  const bot = {
    sendMarkdown: async (target, text) => {
      botSend.push({ target, text });
      return { id: 'b1' };
    },
  };
  const sender = {
    sendMarkdown: async (target, text, opts) => {
      senderSend.push({ target, text, opts });
      return { ok: true };
    },
    sendProactive: async () => ({ ok: true }),
  };
  const handler = createInboundHandler({
    config: { appId: 'app-1' },
    logger: log,
    manager: mgr,
    settings: settings || { get: () => ({ members: { autoRecord: false } }) },
    stats: {},
    historyStore: { clear() {} },
    botId: 'bot-1',
    getSender: withSender ? () => sender : undefined,
  });
  return {
    handler, bot, sender, created, follows, botSend, senderSend, log, record,
    run: (message, state = {}) => handler({ message, state, bot }),
  };
}

test('ARK 卡片：标题/来源/摘要/链接拼成一行 [卡片]', () => {
  const body = assembleAgentBody({
    message: cardMessage({
      fields: {
        title: '标题',
        source: '哔哩哔哩',
        tag: '小程序',
        desc: '摘要',
        jump_url: 'https://example.com/a',
        preview: 'https://example.com/p.png',
      },
    }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(body, '[卡片:type=37] 标题｜哔哩哔哩｜摘要｜https://example.com/a');
});

test('ARK 卡片：来源可退到 tag，摘要取 prompt 并剥掉 [QQ小程序] 前缀', () => {
  const body = assembleAgentBody({
    message: cardMessage({
      fields: { tag: '小程序' },
      ark: { prompt: '[QQ小程序]哔哩哔哩' },
    }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(body, '[卡片:type=37] 小程序｜哔哩哔哩（小程序卡片，无可点击链接）');
});

test('ARK 卡片：只有 prompt 时用剥离前缀后的 prompt 当摘要', () => {
  const promptOnly = assembleAgentBody({
    message: cardMessage({ fields: {}, ark: { prompt: '[QQ小程序]哔哩哔哩' } }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(promptOnly, '[卡片:type=37] 哔哩哔哩（小程序卡片，无可点击链接）');
});

test('ARK 卡片：preview 是封面图，永远不进卡片行（旧规则会把它当摘要输出）', () => {
  // 这条用例是 §3 那个 bug 的直接回归守卫：preview 曾经被当成摘要，输出里唯一的 URL
  // 是 qq.ugcimg.cn 加密图，模型会当链接去访问。
  const previewOnly = assembleAgentBody({
    message: cardMessage({ fields: { preview: 'https://example.com/p.png' } }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(previewOnly, '[卡片:type=37]', '只有 preview 时不应产生任何摘要/链接内容');

  // preview + prompt 同时存在：摘要必须取 prompt，preview 一个字都不能出现
  const withPrompt = assembleAgentBody({
    message: cardMessage({
      fields: { preview: 'https://example.com/p.png' },
      ark: { prompt: '[QQ小程序]真摘要' },
    }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(withPrompt, '[卡片:type=37] 真摘要（小程序卡片，无可点击链接）');
  assert.ok(!withPrompt.includes('example.com/p.png'), 'preview 封面图不得出现在卡片行里');
});

test('只有卡片、content 为空的消息不会被当成空消息丢弃', () => {
  const body = assembleAgentBody({ message: cardMessage({ fields: { title: '只看我' } }), state: {}, scope: 'c2c' });
  assert.equal(body, '[卡片:type=37] 只看我（小程序卡片，无可点击链接）');
});

test('卡片完全没有内容字段时只留 [卡片:模板名]；连卡片体都没有也给 [卡片] 占位', () => {
  const templateOnly = assembleAgentBody({
    message: cardMessage({ fields: {}, ark: { ark_name: '小程序' } }),
    state: {},
    scope: 'c2c',
  });
  assert.equal(templateOnly, '[卡片:小程序]');

  const bare = { kind: 'c2c', content: '', messageId: 'm2', senderId: 'U2', msgType: 3 };
  assert.equal(assembleAgentBody({ message: bare, state: {}, scope: 'c2c' }), '[卡片]');
});

test('卡片 + 正文同时存在：卡片在前、正文在后', () => {
  const message = cardMessage({ fields: { title: '卡片标题' }, extra: { content: '附带一句' } });
  assert.equal(assembleAgentBody({ message, state: {}, scope: 'c2c' }), '[卡片:type=37] 卡片标题（小程序卡片，无可点击链接）\n附带一句');
});

test('普通文本消息不受卡片解析影响', () => {
  const message = { kind: 'c2c', content: '你好呀', messageId: 'm3', senderId: 'U3' };
  assert.equal(assembleAgentBody({ message, state: {}, scope: 'c2c' }), '你好呀');
});

test('群聊卡片消息带发送者标签，且不会被当成空消息', () => {
  const message = cardMessage({
    fields: { title: '群里的卡片' },
    extra: { kind: 'group', groupOpenid: 'G-1', senderId: 'M-1', senderName: '阿岚' },
  });
  const body = assembleAgentBody({ message, state: {}, scope: 'group' });
  assert.equal(body, '[阿岚 (M-1)] [卡片:type=37] 群里的卡片（小程序卡片，无可点击链接）');
});

test('只有卡片的消息会真的投递给 agent（不被入站处理器丢弃）', async () => {
  const rig = makeRig();
  await rig.run(cardMessage({ fields: { title: '投递给我' } }));
  assert.equal(rig.follows.length, 1);
  assert.equal(userText(rig.follows[0]), '[卡片:type=37] 投递给我（小程序卡片，无可点击链接）');
});

test('replyTarget 附带 msgIdx 作为 refIdx（引用回复用）', async () => {
  const rig = makeRig();
  await rig.run({ kind: 'c2c', content: '引用我', messageId: 'm-ref', msgIdx: '9001', senderId: 'U9' });
  assert.equal(rig.created.length, 1);
  assert.deepEqual(rig.created[0].replyTarget, { scope: 'c2c', targetId: 'U9', msgId: 'm-ref', refIdx: '9001' });
});

test('没有 msgIdx 时 refIdx 为 undefined（不伪造引用）', async () => {
  const rig = makeRig();
  await rig.run({ kind: 'c2c', content: '普通消息', messageId: 'm-plain', senderId: 'U9' });
  assert.equal(rig.created[0].replyTarget.refIdx, undefined);
  assert.equal(rig.created[0].replyTarget.msgId, 'm-plain');
});

test('兜底提示优先走 getSender().sendMarkdown(target, text, {quote:false})', async () => {
  const rig = makeRig({
    withSender: true,
    manager: { getOrCreate: async () => { throw new Error('boom'); } },
  });
  await rig.run({ kind: 'c2c', content: 'hi', messageId: 'm-e', senderId: 'U-ERR' });
  assert.equal(rig.senderSend.length, 1);
  assert.equal(rig.senderSend[0].target.scope, 'c2c');
  assert.equal(rig.senderSend[0].opts.quote, false);
  assert.ok(rig.senderSend[0].text.includes('异常'));
  assert.equal(rig.botSend.length, 0, '有 sender 时不走 bot.sendMarkdown');
});

test('没有 getSender 时兜底提示保持旧行为 bot.sendMarkdown', async () => {
  const rig = makeRig({
    manager: { getOrCreate: async () => { throw new Error('boom'); } },
  });
  await rig.run({ kind: 'c2c', content: 'hi', messageId: 'm-e2', senderId: 'U-ERR' });
  assert.equal(rig.botSend.length, 1);
  assert.ok(rig.botSend[0].text.includes('异常'));
  assert.equal(rig.senderSend.length, 0);
});

test('sender 返回 ok:false 只记日志，不抛错也不重复发', async () => {
  const rig = makeRig({ manager: { getOrCreate: async () => { throw new Error('boom'); } } });
  const handler = createInboundHandler({
    config: {},
    logger: rig.log,
    manager: { getOrCreate: async () => { throw new Error('boom'); } },
    settings: { get: () => ({}) },
    stats: {},
    historyStore: { clear() {} },
    getSender: () => ({ sendMarkdown: async () => ({ ok: false, code: 'PASSIVE_EXHAUSTED' }) }),
  });
  await handler({ message: { kind: 'c2c', content: 'hi', messageId: 'm-f', senderId: 'U-F' }, state: {}, bot: rig.bot });
  assert.equal(rig.botSend.length, 0);
  assert.ok(rig.log.byLevel('warn').some((args) => String(args[0]).includes('PASSIVE_EXHAUSTED')));
});

test('getSender 抛异常时降级 bot.sendMarkdown，不让兜底提示整体失败', async () => {
  const rig = makeRig();
  const handler = createInboundHandler({
    config: {},
    logger: rig.log,
    manager: { getOrCreate: async () => { throw new Error('boom'); } },
    settings: { get: () => ({}) },
    stats: {},
    historyStore: { clear() {} },
    getSender: () => { throw new Error('sender broken'); },
  });
  await handler({ message: { kind: 'c2c', content: 'hi', messageId: 'm-g', senderId: 'U-G' }, state: {}, bot: rig.bot });
  assert.equal(rig.botSend.length, 1);
});
// ---------------------------------------------------------------------------
// 以下用例全部使用 .work/CARD-MESSAGE-ANALYSIS.md §2.1 的**真实**结构（脱敏长串）。
// 每组断言都直接对应一个已经发生过的线上 bug，回归时必挂。
// ---------------------------------------------------------------------------

/**
 * B站「小程序」分享卡片（真实形态）：ark_name=小程序, ark_type=37，
 * fields 只有 title / preview / source / source_logo（**没有 jump_url**），
 * ark.prompt = '[QQ小程序]' + 标题，preview 是 qq.ugcimg.cn 加密跳转图。
 */
const BILI_ARK = Object.freeze({
  ark_name: '小程序',
  ark_type: 37,
  prompt: '[QQ小程序]那个...宝宝...我们就在小...小县城结婚吧！',
  fields: {
    title: '那个...宝宝...我们就在小...小县城结婚吧！',
    preview: 'https://qq.ugcimg.cn/v1/446ta3/e9vf2tsqr6j29hl2kodb3vahlc',
    source: '哔哩哔哩',
    source_logo: 'https://open.gtimg.cn/open/app_icon/00/95/17/76/100951776_100_m.png?t=1793843307',
  },
});

/** 小黑盒「图文H5」分享卡片（真实形态）：有 jump_url 和 desc。 */
const H5_ARK = Object.freeze({
  ark_name: '图文H5',
  ark_type: 37,
  prompt: '[分享]致所有中国玩家的一封信',
  fields: {
    jump_url: 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&link_id=aa6d72cd351e',
    tag: '小黑盒',
    title: '致所有中国玩家的一封信',
    desc: '下载小黑盒查看更多精彩内容',
  },
});

/** 构造一条带指定 ark_data 的卡片消息（SDK 真实形态：ark_data 在 msg.raw 里）。 */
function arkMessage(ark, extra = {}) {
  return { kind: 'c2c', content: '', messageId: 'm-ark', senderId: 'U-ARK', msgType: 3, raw: { ark_data: ark }, ...extra };
}

/** 任何 QQ 图片域名都不应该出现在卡片行里（这些不是可点击的真链接）。 */
const QQ_IMAGE_HOSTS = ['qq.ugcimg.cn', 'open.gtimg.cn', 'miniapp.gtimg.cn', 'qqbot.ugcimg.cn'];

function assertNoQqImage(text) {
  for (const host of QQ_IMAGE_HOSTS) {
    assert.ok(!text.includes(host), '卡片行不应包含图片域名 ' + host + '，实际: ' + text);
  }
}

test('真实 B站小程序卡片：不含 qq.ugcimg.cn，带 [卡片:小程序] 标记和「无可点击链接」', () => {
  const body = assembleAgentBody({ message: arkMessage(BILI_ARK), state: {}, scope: 'c2c' });
  assertNoQqImage(body);
  assert.ok(body.startsWith('[卡片:小程序] '), '应带小程序模板标记，实际: ' + body);
  assert.ok(body.includes('（小程序卡片，无可点击链接）'), '无 jump_url 时必须显式标注不可点击，实际: ' + body);
  // 标题 / 来源 / 摘要来自 title / source / 剥离前缀后的 prompt
  assert.ok(body.includes('那个...宝宝...我们就在小...小县城结婚吧！'), '标题必须保留');
  assert.ok(body.includes('哔哩哔哩'), '来源必须保留');
  // open.gtimg.cn 的 source_logo 也不得出现（assertNoQqImage 已覆盖）
  assert.ok(!body.includes('[QQ小程序]'), 'prompt 的方括号前缀应被剥掉');
});

test('真实 B站小程序卡片：摘要与标题相同时去重，不输出「标题｜来源｜标题」', () => {
  // B站卡片的 ark.prompt 是「[QQ小程序]标题」，剥前缀后与 fields.title 逐字相同
  const body = assembleAgentBody({ message: arkMessage(BILI_ARK), state: {}, scope: 'c2c' });
  const title = BILI_ARK.fields.title;
  const occurrences = body.split(title).length - 1;
  assert.equal(occurrences, 1, '标题只应出现一次（摘要去重），实际: ' + body + '（出现 ' + occurrences + ' 次）');
  assert.equal(body, '[卡片:小程序] ' + title + '｜哔哩哔哩（小程序卡片，无可点击链接）');
});

test('真实 H5 图文卡片：jump_url 必须输出，不误加「无可点击链接」', () => {
  const body = assembleAgentBody({ message: arkMessage(H5_ARK), state: {}, scope: 'c2c' });
  assert.ok(body.includes(H5_ARK.fields.jump_url), 'H5 卡片的 jump_url 必须出现在输出里，实际: ' + body);
  assert.ok(body.includes('[卡片:图文H5]'), '应带 H5 模板标记，实际: ' + body);
  assert.ok(body.includes('下载小黑盒查看更多精彩内容'), 'desc 摘要必须保留');
  assert.ok(!body.includes('无可点击链接'), '有 jump_url 时不应标注「无可点击链接」');
  assertNoQqImage(body);
});

test('jump_url 本身是 QQ 图片域名时也不当作链接输出', () => {
  // 防御性用例：某些模板会把 preview 塞进 jump_url；那不是可点击的真链接。
  const body = assembleAgentBody({
    message: arkMessage({
      ark_name: '小程序',
      ark_type: 37,
      fields: { title: '伪装链接', jump_url: 'https://qq.ugcimg.cn/v1/xxx/abc' },
    }),
    state: {},
    scope: 'c2c',
  });
  assertNoQqImage(body);
  assert.ok(body.includes('（小程序卡片，无可点击链接）'), '图片域名 jump_url 应被丢弃并标注无链接，实际: ' + body);
});

test('群历史回填：卡片先经入站处理，历史里同 messageId 的空 content 条目会被还原成 [卡片] 行', async () => {
  clearCardCache();
  const cardId = 'm-bili-history-' + Date.now();
  const rig = makeRig();
  // 1) 卡片消息真的走一遍入站处理器 → 触发 rememberCard
  await rig.run(arkMessage(BILI_ARK, { messageId: cardId }), {});
  assert.equal(rig.follows.length, 1, '卡片消息应投递给 agent');

  // 2) 历史条目：SDK historyBuffer 只存 content，卡片这里是空串
  const history = [
    { senderId: 'U-H1', senderName: '某群友', content: '前面的闲聊', messageId: 'm-h1', timestamp: 1 },
    { senderId: 'U-H2', senderName: '分享的群友', content: '', messageId: cardId, timestamp: 2 },
  ];
  const body = assembleAgentBody({
    message: { kind: 'group', groupOpenid: 'G-1', content: '这个咋样', messageId: 'm-now', senderId: 'M-1', senderName: '阿岚' },
    state: { history },
    scope: 'group',
  });

  assert.ok(body.includes('[Chat history begins]'), '群聊应带历史块');
  assert.ok(body.includes('[某群友 (U-H1)] 前面的闲聊'), '普通历史条目不受影响');
  const histLine = body.split('\n').find((line) => line.startsWith('[分享的群友 (U-H2)] '));
  assert.ok(histLine, '历史里的卡片条目不应再被丢弃，实际 body:\n' + body);
  assert.ok(histLine.includes('[卡片:小程序]'), '历史回的卡片行应带模板标记，实际: ' + histLine);
  assert.ok(histLine.includes('那个...宝宝...我们就在小...小县城结婚吧！'), '历史卡片行应含真实标题');
  assert.ok(histLine.includes('（小程序卡片，无可点击链接）'), '历史卡片行同样要标注无可点击链接');
  assertNoQqImage(body);
  // 当前消息本身是纯文本，不应凭空多出卡片行
  assert.ok(body.includes('[阿岚 (M-1)] 这个咋样'), '当前纯文本消息保持原样');
});

test('群历史回填：历史卡片行与当前消息里的同一条卡片渲染结果完全一致', async () => {
  clearCardCache();
  const cardId = 'm-same-render-' + Date.now();
  const rig = makeRig();
  await rig.run(arkMessage(H5_ARK, { messageId: cardId }), {});
  const currentText = userText(rig.follows[0]);

  const body = assembleAgentBody({
    message: { kind: 'group', groupOpenid: 'G-1', content: '看看这个', messageId: 'm-now2', senderId: 'M-1', senderName: '阿岚' },
    state: { history: [{ senderId: 'U-H9', senderName: '群友', content: '', messageId: cardId }] },
    scope: 'group',
  });
  const histLine = body.split('\n').find((line) => line.startsWith('[群友 (U-H9)] '));
  assert.ok(histLine, '历史里应出现卡片行');
  assert.equal(histLine, '[群友 (U-H9)] ' + currentText, '历史回填用的必须是同一个渲染函数的结果');
});

test('群历史：既无 content 也无回查记录的空条目仍然被跳过（不产生空行）', () => {
  const body = assembleAgentBody({
    message: { kind: 'group', groupOpenid: 'G-1', content: '在吗', messageId: 'm-now3', senderId: 'M-1', senderName: '阿岚' },
    state: {
      history: [
        { senderId: 'U-X1', senderName: '路人甲', content: '', messageId: 'm-unknown-' + Date.now() },
        { senderId: 'U-X2', senderName: '路人乙', content: '有内容' },
        { senderId: 'U-X3', senderName: '路人丙', content: '', messageId: '' },
      ],
    },
    scope: 'group',
  });
  const histBlock = body.slice(body.indexOf('[Chat history begins]'), body.indexOf('[Chat history ends]'));
  const histLines = histBlock.split('\n').filter((line) => line.startsWith('[') && !line.startsWith('[Chat history'));
  assert.equal(histLines.length, 1, '只有有内容的条目才进历史块，实际: ' + JSON.stringify(histLines));
  assert.ok(histLines[0].includes('有内容'));
  // 不能出现「[昵称 (id)] 」后面什么都没有的半截行
  assert.ok(!/\] $/m.test(histBlock), '不应产生空正文的历史行');
});

test('card-render：rememberCard / lookupCard 的容量上限（LRU 淘汰最旧）', () => {
  clearCardCache();
  const { max } = CARD_CACHE_LIMITS;
  for (let i = 0; i < max + 5; i += 1) rememberCard('m-lru-' + i, '[卡片:小程序] 卡片' + i);
  assert.equal(cardCacheSize(), max, '超出上限后应淘汰旧条目');
  assert.equal(lookupCard('m-lru-0'), '', '最旧的条目应已被淘汰');
  assert.equal(lookupCard('m-lru-' + (max + 4)), '[卡片:小程序] 卡片' + (max + 4), '最新条目必须命中');

  assert.equal(lookupCard(''), '', '空 messageId 不命中');
  assert.equal(lookupCard(undefined), '', 'undefined messageId 不命中');
  clearCardCache();
});

test('card-render：超过 TTL 的回查记录失效并被清掉（用 mock timers 推进时钟）', (t) => {
  clearCardCache();
  const { ttlMs } = CARD_CACHE_LIMITS;
  // 只 mock Date，不打桩任何被测逻辑：lookupCard 内部就是拿 Date.now() 和写入时刻比
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-11T00:00:00Z').getTime() });
  try {
    rememberCard('m-ttl', '[卡片:小程序] 卡片');
    assert.equal(lookupCard('m-ttl'), '[卡片:小程序] 卡片', 'TTL 内必须命中');
    assert.equal(cardCacheSize(), 1);

    // 差一点到期：仍命中
    t.mock.timers.tick(ttlMs - 1000);
    assert.equal(lookupCard('m-ttl'), '[卡片:小程序] 卡片', 'TTL 内（差 1s）仍应命中');

    // 越过 TTL：必须失效
    t.mock.timers.tick(2000);
    assert.equal(lookupCard('m-ttl'), '', '超过 TTL 后不再命中（否则历史里会回填陈年卡片）');
    assert.equal(cardCacheSize(), 0, '过期条目应被顺手清掉，不占 LRU 位置');
  } finally {
    clearCardCache();
  }
});

test('card-render：rememberCard 空文本不写表，避免历史里出现空卡片行', () => {
  clearCardCache();
  rememberCard('m-empty-text', '');
  rememberCard('m-empty-arr', []);
  assert.equal(lookupCard('m-empty-text'), '');
  assert.equal(lookupCard('m-empty-arr'), '');
  assert.equal(cardCacheSize(), 0);
});