/**
 * 图片内联测试：v0.22「图片直接进上下文」。
 *
 * 覆盖：
 *   - 策略解析（settings / 部署配置开关、上限）
 *   - 路由能力门控（文本模型不内联）
 *   - 张数 / 总字节上限、坏文件与非图片跳过、单张失败不影响其它
 *   - inbound 投递时把 image block 拼进同一条 UserMessage
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MAX_IMAGES,
  buildInlineImageBlocks,
  followupWithImageFallback,
  resolveInlinePolicy,
} from '../lib/qq/inline-image.js';
import { createInboundHandler } from '../lib/qq/inbound.js';

// ── 测试素材 ────────────────────────────────────────────────
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38]);

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** 假附件服务：记录 saveImage 调用，支持指定第几次失败。 */
function fakeAttachments({ mediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], failOn = -1, noLimits = false } = {}) {
  const saved = [];
  let calls = 0;
  return {
    imageLimits: noLimits ? undefined : { mediaTypes },
    saved,
    saveImage: async (input) => {
      const index = calls++;
      if (index === failOn) throw new Error('save failed');
      saved.push(input);
      return {
        attachmentId: 'sha256:' + String(index).padStart(4, '0'),
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 1,
        height: 1,
        name: input.name,
      };
    },
  };
}

/** 假 llm：返回固定输入模态。 */
function fakeLlm(inputModalities = ['text', 'image']) {
  return { resolveModelInfo: async () => ({ provider: 'p', id: 'm', name: 'm', inputModalities }) };
}

/** 假 SessionManager：ctx 暴露附件/模型服务，路由可解析。 */
function fakeManager({ attachments, llm, route = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } = {}) {
  return {
    ctx: {
      get: (name) => (name === 'attachments' ? attachments : name === 'llm' ? llm : undefined),
    },
    resolveModelRoute: () => ({ route, source: route ? 'settings' : 'none' }),
  };
}

/** 在临时目录写图片文件，返回 {dir, file()}。 */
async function makeMediaDir() {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-inline-'));
  let seq = 0;
  return {
    dir,
    async file(name, bytes = PNG) {
      const path = join(dir, String(seq++) + '-' + name);
      await writeFile(path, bytes);
      return { filename: name, contentType: 'image', localPath: path, size: bytes.length, url: 'https://example.invalid/' + name };
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const BASE_SETTINGS = {
  features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
  vision: { inlineImages: true, inlineMaxImages: 4, inlineMaxBytes: 20971520 },
};

function fakeSettings(snapshot = BASE_SETTINGS) {
  return { get: () => snapshot };
}

// ── 策略解析 ────────────────────────────────────────────────

test('策略：默认开启，上限来自 settings.vision', () => {
  const policy = resolveInlinePolicy({ settings: fakeSettings(), config: {} });
  assert.equal(policy.enabled, true);
  assert.equal(policy.maxImages, 4);
  assert.equal(policy.maxTotalBytes, 20971520);
});

test('策略：settings.features.vision=false 时不内联', () => {
  const policy = resolveInlinePolicy({
    settings: fakeSettings({ ...BASE_SETTINGS, features: { ...BASE_SETTINGS.features, vision: false } }),
    config: {},
  });
  assert.equal(policy.enabled, false);
});

test('策略：settings.vision.inlineImages=false / 部署配置关闭时不内联', () => {
  const offBySettings = resolveInlinePolicy({
    settings: fakeSettings({ ...BASE_SETTINGS, vision: { ...BASE_SETTINGS.vision, inlineImages: false } }),
    config: {},
  });
  assert.equal(offBySettings.enabled, false);
  const offByConfig = resolveInlinePolicy({ settings: fakeSettings(), config: { vision: { inlineImages: false } } });
  assert.equal(offByConfig.enabled, false);
  const offByDeploy = resolveInlinePolicy({ settings: fakeSettings(), config: { vision: { enabled: false } } });
  assert.equal(offByDeploy.enabled, false);
});

test('策略：部署配置覆盖上限，越界被夹紧', () => {
  const policy = resolveInlinePolicy({
    settings: fakeSettings(),
    config: { vision: { inlineMaxImages: 99, inlineMaxBytes: 1 } },
  });
  assert.equal(policy.maxImages, 10, '张数硬上限 10');
  assert.equal(policy.maxTotalBytes, 1024 * 1024, '字节下限 1MB');
});

// ── 内联构建 ────────────────────────────────────────────────

test('内联：路由支持图片时每张图生成一个 image block', async (t) => {
  const media = await makeMediaDir();
  t.after(() => media.cleanup());
  const attachments = fakeAttachments();
  const a = await media.file('a.png', PNG);
  const b = await media.file('b.jpg', JPEG);
  const blocks = await buildInlineImageBlocks({
    downloaded: [a, b],
    manager: fakeManager({ attachments, llm: fakeLlm() }),
    settings: fakeSettings(),
    config: {},
    logger: silentLogger,
  });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'image');
  assert.ok(blocks[0].attachment && blocks[0].attachment.attachmentId);
  assert.equal(attachments.saved[0].mediaType, 'image/png');
  assert.equal(attachments.saved[1].mediaType, 'image/jpeg');
  assert.equal(attachments.saved[0].name, 'a.png');
});

test('内联：模型不支持图片（text-only）时不内联，也不写附件', async (t) => {
  const media = await makeMediaDir();
  t.after(() => media.cleanup());
  const attachments = fakeAttachments();
  const a = await media.file('a.png');
  const blocks = await buildInlineImageBlocks({
    downloaded: [a],
    manager: fakeManager({ attachments, llm: fakeLlm(['text']) }),
    settings: fakeSettings(),
    config: {},
    logger: silentLogger,
  });
  assert.deepEqual(blocks, []);
  assert.equal(attachments.saved.length, 0);
});

test('内联：看图开关关闭时不内联', async (t) => {
  const media = await makeMediaDir();
  t.after(() => media.cleanup());
  const attachments = fakeAttachments();
  const a = await media.file('a.png');
  const blocks = await buildInlineImageBlocks({
    downloaded: [a],
    manager: fakeManager({ attachments, llm: fakeLlm() }),
    settings: fakeSettings({ ...BASE_SETTINGS, features: { ...BASE_SETTINGS.features, vision: false } }),
    config: {},
    logger: silentLogger,
  });
  assert.deepEqual(blocks, []);
  assert.equal(attachments.saved.length, 0);
});

test('内联：超过张数上限只取前几张', async (t) => {
  const media = await makeMediaDir();
  t.after(() => media.cleanup());
  const attachments = fakeAttachments();
  const files = [];
  for (let i = 0; i < 5; i += 1) files.push(await media.file('p' + i + '.png'));
  const blocks = await buildInlineImageBlocks({
    downloaded: files,
    manager: fakeManager({ attachments, llm: fakeLlm() }),
    settings: fakeSettings(),
    config: { vision: { inlineMaxImages: 2 } },
    logger: silentLogger,
  });
  assert.equal(blocks.length, 2);
  assert.equal(attachments.saved.length, 2);
});

test('内联：单张保存失败不影响其它图', async (t) => {
  const media = await makeMediaDir();
  t.after(() => media.cleanup());
  const attachments = fakeAttachments({ failOn: 0 });
  const a = await media.file('a.png');
  const b = await media.file('b.png');
  const blocks = await buildInlineImageBlocks({
    downloaded: [a, b],
    manager: fakeManager({ attachments, llm: fakeLlm() }),
    settings: fakeSettings(),
    config: {},
    logger: silentLogger,
  });
  assert.equal(blocks.length, 1);
});

test('内联：坏文件 / 非图片 / 文件不存在会被跳过', async (t) => {
  const media = await makeMediaDir();
  t.after(() => media.cleanup());
  const attachments = fakeAttachments();
  const good = await media.file('good.png');
  const bad = await media.file('bad.bin', Uint8Array.from(new Array(16).fill(0x00)));
  const missing = { filename: 'gone.png', contentType: 'image', localPath: join(media.dir, 'nope.png') };
  const notImage = { filename: 'x.mp4', contentType: 'video', localPath: good.localPath };
  const blocks = await buildInlineImageBlocks({
    downloaded: [bad, missing, notImage, good],
    manager: fakeManager({ attachments, llm: fakeLlm() }),
    settings: fakeSettings(),
    config: {},
    logger: silentLogger,
  });
  assert.equal(blocks.length, 1);
});

test('内联：manager 缺 ctx / 附件服务不可用时不抛错', async () => {
  const empty = await buildInlineImageBlocks({
    downloaded: [{ contentType: 'image', localPath: '/tmp/x.png' }],
    manager: {},
    settings: fakeSettings(),
    config: {},
    logger: silentLogger,
  });
  assert.deepEqual(empty, []);
});

test('内联：路由无法解析时不内联（避免对未知模型塞图）', async (t) => {
  const media = await makeMediaDir();
  t.after(() => media.cleanup());
  const attachments = fakeAttachments();
  const a = await media.file('a.png');
  const blocks = await buildInlineImageBlocks({
    downloaded: [a],
    manager: fakeManager({ attachments, llm: fakeLlm(), route: null }),
    settings: fakeSettings(),
    config: {},
    logger: silentLogger,
  });
  assert.deepEqual(blocks, []);
});

test('内联：默认张数 = ' + DEFAULT_MAX_IMAGES, () => {
  assert.equal(DEFAULT_MAX_IMAGES, 4);
});

// ── 带图投递的纯文本兜底 ───────────────────────────────────

/** 记录 followup 调用；第 failFirst 次抛错。 */
function fakeAgent({ failFirst = 0 } = {}) {
  const calls = [];
  return {
    calls,
    followup: async (message) => {
      calls.push(message);
      if (calls.length <= failFirst) throw new Error('followup rejected');
    },
  };
}

test('投递：带图首次成功，不降级', async () => {
  const agent = fakeAgent();
  const result = await followupWithImageFallback({
    agent: agent,
    body: '文字',
    imageBlocks: [{ type: 'image', attachment: { attachmentId: 'sha256:1' } }],
    logger: silentLogger,
  });
  assert.deepEqual(result, { delivered: true, degraded: false });
  assert.equal(agent.calls.length, 1);
  assert.deepEqual(agent.calls[0].content.map((b) => b.type), ['text', 'image']);
});

test('投递：带图被宿主拒绝时，自动用纯文本重投（旧方案兜底）', async () => {
  const agent = fakeAgent({ failFirst: 1 });
  const result = await followupWithImageFallback({
    agent: agent,
    body: '文字\nImage: /tmp/a.png',
    imageBlocks: [{ type: 'image', attachment: { attachmentId: 'sha256:1' } }],
    logger: silentLogger,
  });
  assert.deepEqual(result, { delivered: true, degraded: true });
  assert.equal(agent.calls.length, 2, '第二次是纯文本重投');
  assert.equal(agent.calls[1].content.length, 1);
  assert.equal(agent.calls[1].content[0].type, 'text');
  assert.ok(agent.calls[1].content[0].text.includes('Image: /tmp/a.png'));
});

test('投递：纯文本失败直接抛错（没有图就不重试）', async () => {
  const agent = fakeAgent({ failFirst: 1 });
  await assert.rejects(
    () => followupWithImageFallback({ agent: agent, body: '文字', imageBlocks: [], logger: silentLogger }),
    /followup rejected/,
  );
  assert.equal(agent.calls.length, 1);
});

test('投递：带图 + 纯文本两次都失败时抛错', async () => {
  const agent = fakeAgent({ failFirst: 2 });
  await assert.rejects(
    () => followupWithImageFallback({
      agent: agent,
      body: '文字',
      imageBlocks: [{ type: 'image', attachment: { attachmentId: 'sha256:1' } }],
      logger: silentLogger,
    }),
    /followup rejected/,
  );
  assert.equal(agent.calls.length, 2);
});

// ── inbound 投递装配 ────────────────────────────────────────

test('inbound：图片作为 image block 与文本一起投递', async () => {
  const captured = [];
  const record = {
    agent: {
      followup: (message) => captured.push(message),
      whenIdle: async () => {},
    },
    turn: { current: null },
    quoteNext: false,
    lastActivity: 0,
  };
  const handler = createInboundHandler({
    config: { appId: 'app' },
    logger: silentLogger,
    manager: { getOrCreate: async () => record },
    settings: { get: () => BASE_SETTINGS },
    stats: {},
    buildImageBlocks: async () => [{ type: 'image', attachment: { attachmentId: 'sha256:dead' } }],
  });
  await handler({
    message: { kind: 'c2c', senderId: 'u1', senderName: 'Alice', content: '看看这个', messageId: 'm1' },
    state: {},
    replyTarget: { scope: 'c2c', targetId: 'u1' },
  });
  assert.equal(captured.length, 1);
  const content = captured[0].content;
  assert.equal(content[0].type, 'text');
  assert.ok(content[0].text.includes('看看这个'));
  assert.equal(content[1].type, 'image');
});

test('inbound：内联器抛错时降级为纯文本，不阻断投递', async () => {
  const captured = [];
  const record = {
    agent: { followup: (m) => captured.push(m), whenIdle: async () => {} },
    turn: { current: null },
    quoteNext: false,
    lastActivity: 0,
  };
  const handler = createInboundHandler({
    config: { appId: 'app' },
    logger: silentLogger,
    manager: { getOrCreate: async () => record },
    settings: { get: () => BASE_SETTINGS },
    stats: {},
    buildImageBlocks: async () => { throw new Error('boom'); },
  });
  await handler({
    message: { kind: 'c2c', senderId: 'u1', content: '文字', messageId: 'm1' },
    state: {},
    replyTarget: { scope: 'c2c', targetId: 'u1' },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].content.length, 1);
  assert.equal(captured[0].content[0].type, 'text');
});

test('inbound：带图投递被拒时自动纯文本重投，消息不丢', async () => {
  const calls = [];
  const record = {
    agent: {
      followup: (message) => {
        calls.push(message);
        if (calls.length === 1) throw new Error('reject image');
      },
      whenIdle: async () => {},
    },
    turn: { current: null },
    quoteNext: false,
    lastActivity: 0,
  };
  const handler = createInboundHandler({
    config: { appId: 'app' },
    logger: silentLogger,
    manager: { getOrCreate: async () => record },
    settings: { get: () => BASE_SETTINGS },
    stats: {},
    buildImageBlocks: async () => [{ type: 'image', attachment: { attachmentId: 'sha256:dead' } }],
  });
  await handler({
    message: { kind: 'c2c', senderId: 'u1', content: '看图', messageId: 'm1' },
    state: {},
    replyTarget: { scope: 'c2c', targetId: 'u1' },
  });
  assert.equal(calls.length, 2, '第一次带图被拒，第二次纯文本重投');
  assert.deepEqual(calls[0].content.map((b) => b.type), ['text', 'image']);
  assert.equal(calls[1].content.length, 1);
  assert.equal(calls[1].content[0].type, 'text');
});
