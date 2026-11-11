/**
 * tools-qq-tools —— 作用域工具实现：send_file 目标解析/路径白名单、quote_reply、
 * send_card 校验降级、sticker 收藏/配额、vision 走 oneShot(images)。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSendFileTools, SEND_FILE_TOOL_NAME } from '../lib/tools/send-file.js';
import { createSendCardTools, normalizeCardArgs, SEND_CARD_TOOL_NAME } from '../lib/tools/send-card.js';
import { createQuoteReplyTools, QUOTE_REPLY_TOOL_NAME } from '../lib/tools/quote-reply.js';
import { createStickerTools, STICKER_SAVE_TOOL_NAME, STICKER_SEND_TOOL_NAME } from '../lib/tools/sticker-tools.js';
import { createVisionTools, DESCRIBE_IMAGE_TOOL_NAME } from '../lib/tools/vision.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-tools-'));
  const mediaDir = join(root, 'media');
  mkdirSync(mediaDir, { recursive: true });
  return { root, mediaDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeManager(replyTarget) {
  return { findByAgent: () => ({ replyTarget }) };
}

// ── send_file ────────────────────────────────────────────
test('qqbot_send_file：按扩展名分发 + exec.agent 定位当前会话目标', async () => {
  const ws = makeWorkspace();
  try {
    const imagePath = join(ws.root, 'a.png');
    writeFileSync(imagePath, PNG);
    const calls = [];
    const mediaSender = {
      sendImage: async (target, source) => { calls.push({ kind: 'image', target, source }); return { message: { id: 'm1' }, upload: {} }; },
      sendVideo: async () => ({}),
      sendVoice: async () => ({}),
      sendFile: async () => ({}),
    };
    const [def] = createSendFileTools({
      sender: mediaSender,
      manager: makeManager({ scope: 'group', targetId: 'G1', msgId: 'm-in' }),
      config: { cwd: ws.root },
      logger: silentLogger,
      mediaDir: ws.mediaDir,
    });
    assert.equal(def.name, SEND_FILE_TOOL_NAME);
    const value = await def.execute({ file_path: imagePath }, { agent: {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'image');
    assert.deepEqual(calls[0].target, { scope: 'group', targetId: 'G1', msgId: 'm-in' });
    assert.equal(value.fileName, 'a.png');
    assert.equal(value.target, 'group:G1');
    assert.equal(value.messageId, 'm1');
    assert.deepEqual(value.cached, false);
  } finally {
    ws.cleanup();
  }
});

test('qqbot_send_file：显式 target 覆盖默认；无目标时给出可读错误', async () => {
  const ws = makeWorkspace();
  try {
    const txt = join(ws.root, 'report.bin');
    writeFileSync(txt, 'x');
    const calls = [];
    const mediaSender = {
      sendImage: async () => ({}),
      sendVideo: async () => ({}),
      sendVoice: async () => ({}),
      sendFile: async (target, source, opts) => { calls.push({ target, source, opts }); return { message: { id: 'm2' }, upload: {} }; },
    };
    const [def] = createSendFileTools({ sender: mediaSender, manager: makeManager(undefined), config: { cwd: ws.root }, logger: silentLogger, mediaDir: ws.mediaDir });
    await def.execute({ file_path: txt, target: 'c2c:U9' }, { agent: {} });
    assert.deepEqual(calls[0].target, { scope: 'c2c', targetId: 'U9' });
    assert.equal(calls[0].opts.fileName, 'report.bin');
    await assert.rejects(() => def.execute({ file_path: txt }, { agent: {} }), /无法确定发送目标/);
  } finally {
    ws.cleanup();
  }
});

test('qqbot_send_file：路径白名单与文件校验（越界/不存在/目录）', async () => {
  const ws = makeWorkspace();
  const outside = mkdtempSync(join(tmpdir(), 'qqbot-outside-'));
  try {
    const inside = join(ws.root, 'ok.txt');
    writeFileSync(inside, 'x');
    const outsideFile = join(outside, 'secret.txt');
    writeFileSync(outsideFile, 'x');
    const [def] = createSendFileTools({
      sender: { sendFile: async () => ({ message: { id: 'm' }, upload: {} }) },
      manager: makeManager({ scope: 'c2c', targetId: 'U1' }),
      config: { cwd: ws.root },
      logger: silentLogger,
      mediaDir: ws.mediaDir,
    });
    await assert.rejects(() => def.execute({ file_path: outsideFile }, { agent: {} }), /不在允许的目录/);
    await assert.rejects(() => def.execute({ file_path: join(ws.root, 'nope.txt') }, { agent: {} }), /文件不存在/);
    await assert.rejects(() => def.execute({ file_path: ws.root }, { agent: {} }), /不是普通文件/);
  } finally {
    ws.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('qqbot_send_file：媒体「可能已送达」错误透出 deliveryUnknown，提示模型别重试', async () => {
  const ws = makeWorkspace();
  try {
    const file = join(ws.root, 'a.gif');
    writeFileSync(file, PNG);
    const unknown = Object.assign(new Error('timeout'), { deliveryUnknown: true, code: 'UNKNOWN_DELIVERY' });
    const [def] = createSendFileTools({
      sender: { sendImage: async () => { throw unknown; } },
      manager: makeManager({ scope: 'c2c', targetId: 'U1' }),
      config: { cwd: ws.root },
      logger: silentLogger,
      mediaDir: ws.mediaDir,
    });
    await assert.rejects(() => def.execute({ file_path: file }, { agent: {} }), (err) => {
      assert.equal(err.deliveryUnknown, true);
      assert.match(err.message, /请勿重复发送/);
      return true;
    });
  } finally {
    ws.cleanup();
  }
});

// ── quote_reply / send_card ─────────────────────────────
test('qqbot_quote_reply：在当前会话记录上标记 quoteNext', async () => {
  const record = { replyTarget: { scope: 'c2c', targetId: 'U1', msgId: 'm1' }, quoteNext: false };
  const [def] = createQuoteReplyTools({ manager: { findByAgent: () => record }, logger: silentLogger });
  assert.equal(def.name, QUOTE_REPLY_TOOL_NAME);
  const value = await def.execute({}, { agent: {} });
  assert.equal(value.quoted, true);
  assert.equal(record.quoteNext, true);
  const [missing] = createQuoteReplyTools({ manager: { findByAgent: () => null }, logger: silentLogger });
  await assert.rejects(() => missing.execute({}, { agent: {} }), /找不到当前 QQ 会话/);
});

test('qqbot_send_card：https/长度校验 + 经 sender.sendCard 发送（降级信息透出）', async () => {
  assert.throws(() => normalizeCardArgs({ title: 'ok', description: 'd', url: 'http://x' }), /url 必须是 https/);
  assert.throws(() => normalizeCardArgs({ title: '', description: 'd', url: 'https://x' }), /title/);
  const sent = [];
  const sender = {
    sendCard: async (target, card, opts) => {
      sent.push({ target, card, opts });
      return { ok: true, mode: 'passive', degraded: true, degradedReason: '304061', result: { id: 'mid-1' } };
    },
  };
  const [def] = createSendCardTools({ sender, manager: makeManager({ scope: 'group', targetId: 'G1', msgId: 'm1' }), logger: silentLogger });
  assert.equal(def.name, SEND_CARD_TOOL_NAME);
  const value = await def.execute({ title: '标题', description: '摘要', url: 'https://example.com/a' }, { agent: {} });
  assert.equal(value.degraded, true);
  assert.equal(value.degradedReason, '304061');
  assert.equal(value.messageId, 'mid-1');
  assert.equal(sent[0].target.targetId, 'G1');
  assert.equal(sent[0].opts.fallbackText, '标题\n摘要\nhttps://example.com/a');
});

// ── 表情包 ──────────────────────────────────────────────
function createFakeStickerStore() {
  const items = [];
  return {
    items,
    sent: 0,
    list() { return items.slice(); },
    add(input) {
      const item = { id: items.length + 1, ...input, emotion: input.emotion || '', created: true };
      items.push(item);
      return item;
    },
    quota() { return { day: '2026-11-09', count: this.sent }; },
    recordSend() { this.sent += 1; return { day: '2026-11-09', count: this.sent }; },
  };
}

test('qqbot_sticker_save：复制到 cwd/stickers、按内容去重；qqbot_send_sticker 受每日配额约束', async () => {
  const ws = makeWorkspace();
  try {
    const store = createFakeStickerStore();
    const sendCalls = [];
    const mediaSender = { sendImage: async (target, source) => { sendCalls.push({ target, source }); return { message: { id: 's1' } }; } };
    const defs = createStickerTools({
      stickers: store,
      botId: 'bot-1',
      cwd: ws.root,
      getMediaSender: () => mediaSender,
      manager: makeManager({ scope: 'c2c', targetId: 'U1', msgId: 'm1' }),
      settings: { stickers: { enabled: true, dailyQuota: 1 } },
      config: { cwd: ws.root },
      mediaDir: ws.mediaDir,
      logger: silentLogger,
    });
    const save = defs.find((d) => d.name === STICKER_SAVE_TOOL_NAME);
    const send = defs.find((d) => d.name === STICKER_SEND_TOOL_NAME);
    assert.ok(save && send);

    const src = join(ws.root, 'funny.png');
    writeFileSync(src, PNG);
    const saved = await save.execute({ source_path: src, name: '开心', emotion: '开心' }, {});
    assert.equal(saved.duplicate, false);
    assert.equal(saved.count, 1);
    assert.ok(existsSync(store.items[0].file), '表情图片应复制到 stickers 目录');
    assert.deepEqual(readFileSync(store.items[0].file), Buffer.from(PNG));

    // 同内容再收藏 -> 去重，不重复落库
    const dup = await save.execute({ source_path: src }, {});
    assert.equal(dup.duplicate, true);
    assert.equal(store.items.length, 1);

    const sent = await send.execute({ emotion: '开心' }, { agent: {} });
    assert.equal(sent.ok, true);
    assert.equal(sent.target, 'c2c:U1');
    assert.equal(sendCalls.length, 1);
    assert.equal(store.sent, 1);
    // dailyQuota=1 已用满
    await assert.rejects(() => send.execute({ name: '开心' }, { agent: {} }), /今日表情包发送已达上限/);
  } finally {
    ws.cleanup();
  }
});

// ── 看图（oneShot images） ───────────────────────────────
test('qqbot_describe_image：走 runtime.oneShot.generate({images})，带 attachments.saveImage 引用', async () => {
  const ws = makeWorkspace();
  try {
    const imagePath = join(ws.root, 'pic.png');
    writeFileSync(imagePath, PNG);
    const generateCalls = [];
    const saved = [];
    const runtime = {
      oneShot: {
        async generate(args) {
          generateCalls.push(args);
          return { ok: true, text: '图里是一个蓝色方块' };
        },
      },
    };
    const ctx = {
      get(name) {
        if (name !== 'attachments') return undefined;
        return {
          async saveImage(input) {
            saved.push(input);
            return { attachmentId: 'sha256:ref-1', mediaType: input.mediaType, bytes: input.data.length };
          },
        };
      },
    };
    const [def] = createVisionTools({ ctx, runtime, config: {}, logger: silentLogger });
    assert.equal(def.name, DESCRIBE_IMAGE_TOOL_NAME);
    const value = await def.execute({ image: imagePath, prompt: '图里是什么颜色？' }, {});
    assert.equal(value.text, '图里是一个蓝色方块');
    assert.equal(value.mimeType, 'image/png');
    assert.equal(generateCalls.length, 1);
    assert.equal(generateCalls[0].prompt, '图里是什么颜色？');
    assert.equal(generateCalls[0].images.length, 1);
    assert.equal(generateCalls[0].images[0].attachmentId, 'sha256:ref-1');
    assert.equal(saved[0].mediaType, 'image/png');

    // 缓存命中：同一图 + 同一 prompt 不再调模型
    await def.execute({ image: imagePath, prompt: '图里是什么颜色？' }, {});
    assert.equal(generateCalls.length, 1, '30 分钟内同图同 prompt 应命中缓存');

    // 非图片文件 -> 明确报错
    const bad = join(ws.root, 'not-image.txt');
    writeFileSync(bad, 'hello');
    await assert.rejects(() => def.execute({ image: bad, prompt: 'x' }, {}), /无法识别的图片格式/);
  } finally {
    ws.cleanup();
  }
});

test('qqbot_describe_image：settings.vision 的 provider/model/maxTokens 优先于部署 config（每次 execute 现读）', async () => {
  const ws = makeWorkspace();
  try {
    const imagePath = join(ws.root, 'cfg.png');
    writeFileSync(imagePath, PNG);
    const generateCalls = [];
    const runtime = {
      oneShot: {
        async generate(args) { generateCalls.push(args); return { ok: true, text: 'ok' }; },
      },
    };
    const ctx = {
      get: () => ({
        async saveImage(input) { return { attachmentId: 'sha256:cfg', mediaType: input.mediaType, bytes: input.data.length }; },
      }),
    };
    let settings = { vision: { provider: 'profile-p', model: 'profile-m', maxTokens: 8192 } };
    const [def] = createVisionTools({
      ctx,
      runtime,
      config: { vision: { provider: 'deploy-p', model: 'deploy-m' } },
      getSettings: () => settings,
      logger: silentLogger,
    });
    const value = await def.execute({ image: imagePath, prompt: '描述一下' }, {});
    assert.equal(generateCalls[0].provider, 'profile-p');
    assert.equal(generateCalls[0].model, 'profile-m');
    assert.equal(generateCalls[0].maxTokens, 8192);
    assert.equal(value.model, 'profile-m');

    // 配置档清空 -> 回落到部署 config.vision（热更新：同一工具定义立即生效）
    settings = { vision: {} };
    await def.execute({ image: imagePath, prompt: '换个问法' }, {});
    assert.equal(generateCalls[1].provider, 'deploy-p');
    assert.equal(generateCalls[1].model, 'deploy-m');
    assert.equal(generateCalls[1].maxTokens, 4096, '未配置时默认 4096');
  } finally {
    ws.cleanup();
  }
});

test('qqbot_describe_image：oneShot/attachments 不可用时降级不注册', () => {
  assert.deepEqual(createVisionTools({ ctx: { get: () => undefined }, runtime: { oneShot: null }, config: {}, logger: silentLogger }), []);
  const runtime = { oneShot: { async generate() { return { ok: true, text: 'x' }; } } };
  assert.deepEqual(createVisionTools({ ctx: { get: () => undefined }, runtime, config: {}, logger: silentLogger }), []);
});

test('qqbot_describe_image：只允许 QQ 媒体域名的 https URL（SSRF 防护）', async () => {
  const runtime = { oneShot: { async generate() { return { ok: true, text: 'x' }; } } };
  const ctx = { get: () => ({ async saveImage() { return { attachmentId: 'a' }; } }) };
  const [def] = createVisionTools({ ctx, runtime, config: {}, logger: silentLogger });
  await assert.rejects(() => def.execute({ image: 'https://evil.example.com/a.png' }, {}), /不允许下载该域名/);
  await assert.rejects(() => def.execute({ image: 'http://multimedia.nt.qq.com.cn/a.png' }, {}), /只允许 https/);
});
