/**
 * sticker-tools 单测：隔离临时目录，不触碰真实工作区/网络。
 * 覆盖：qqbot_sticker_save 注册 schema（含 duplicate）与 DESIGN 一致、
 *       execute 成功/内容去重 duplicate/显式 name 重名、每日收藏配额（source='tool' 受限、
 *       API 上传不受限）、cwd/mediaDir/extraRoots 白名单与 realpath 防符号链接逃逸、
 *       非图片/超限/tags 非法拒绝、tools 服务缺失与 store 缺失降级、store 失败错误透传、
 *       dispose 注销、Cordis ctx 兼容。
 * 只 import 本仓库模块、test/helpers 与 node: 内置模块（不依赖任何 @deepseek-ai 包）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStickerStore } from '../lib/stickers/store.js';
import {
  registerStickerTools,
  STICKER_SAVE_TOOL_NAME,
  STICKER_TOOL_NAMES,
} from '../lib/tools/sticker-tools.js';
import { createFakeCtx, createFakeLogger } from './helpers/fake-ctx.js';

const QUIET_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body', 'latin1')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body', 'latin1')]);

/** 在图片尾部追加标记：magic bytes 不变但内容 hash 不同 */
function variant(buffer, marker) {
  return Buffer.concat([buffer, Buffer.from('#' + marker, 'utf8')]);
}

/** 记录型 ctx：保留完整工具定义（含 output schema/render），便于断言契约。 */
function createRecorder() {
  const defs = [];
  const tools = {
    register(definition) {
      defs.push(definition);
      return () => {
        const index = defs.indexOf(definition);
        if (index >= 0) defs.splice(index, 1);
      };
    },
  };
  const ctx = {
    get(name) {
      return name === 'tools' ? tools : undefined;
    },
  };
  return { ctx, defs };
}

/** 在指定临时根下建 store。 */
function makeStore(base, maxMB = 8) {
  const dir = path.join(base, 'stickers');
  const stickers = { dir, collectEnabled: true, maxMB };
  return createStickerStore({ settings: { get: () => ({ stickers }) }, logger: QUIET_LOGGER });
}

/**
 * 建一套工具测试环境：workspace(cwd) / media / extra 三个允许根 + stickers 目录。
 * @param {object} [options]
 * @param {number} [options.maxMB]
 * @param {number} [options.dailyLimit] 每日收藏上限（不传 = settings 未配置 → store 默认 10）
 * @param {object} [options.configOverrides] 覆盖 runtimeConfig（如 sendFile）
 * @param {'config'|'dep'} [options.mediaDirMode] mediaDir 走 config 还是 registerStickerTools 的依赖参数
 */
function makeRig(t, { maxMB = 8, dailyLimit, configOverrides = {}, mediaDirMode = 'config' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sticker-tool-'));
  t.after(() => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 清理失败忽略 */ }
  });
  const dir = path.join(base, 'stickers');
  const mediaDir = path.join(base, 'media');
  const cwd = path.join(base, 'workspace');
  const extraDir = path.join(base, 'extra');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(extraDir, { recursive: true });

  const stickers = { dir, collectEnabled: true, maxMB };
  if (dailyLimit !== undefined) stickers.dailyLimit = dailyLimit;
  const store = createStickerStore({ settings: { get: () => ({ stickers }) }, logger: QUIET_LOGGER });
  const { ctx, defs } = createRecorder();
  const logger = createFakeLogger();
  const useDep = mediaDirMode === 'dep';
  const runtimeConfig = {
    cwd,
    mediaDir: useDep ? '' : mediaDir,
    sendFile: { restrictPaths: true, extraRoots: [extraDir] },
    ...configOverrides,
  };
  const dispose = registerStickerTools(ctx, {
    stickerStore: store,
    config: runtimeConfig,
    logger,
    mediaDir: useDep ? mediaDir : undefined,
  });
  return {
    base,
    dir,
    mediaDir,
    cwd,
    extraDir,
    stickers,
    store,
    logger,
    ctx,
    defs,
    dispose,
    tool: defs[0],
  };
}

/** 在 mediaDir 写一个图片，返回绝对路径。 */
function writeImage(dir, name, bytes = PNG) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

test('注册 qqbot_sticker_save：参数与输出 schema 符合 DESIGN（含 duplicate）', (t) => {
  const rig = makeRig(t);
  assert.equal(rig.defs.length, 1);
  const tool = rig.tool;

  assert.equal(tool.name, 'qqbot_sticker_save');
  assert.equal(STICKER_SAVE_TOOL_NAME, 'qqbot_sticker_save');
  assert.deepEqual([...STICKER_TOOL_NAMES], ['qqbot_sticker_save']);
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.length > 0);

  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['source_path']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['emotion', 'name', 'note', 'source_path', 'tags']);
  assert.equal(tool.parameters.properties.source_path.type, 'string');
  assert.equal(tool.parameters.properties.name.type, 'string');
  assert.equal(tool.parameters.properties.emotion.type, 'string');
  assert.equal(tool.parameters.properties.note.type, 'string');
  assert.equal(tool.parameters.properties.tags.type, 'array');
  assert.equal(tool.parameters.properties.tags.items.type, 'string');

  assert.deepEqual(tool.output.schema.required, ['ok', 'duplicate', 'name', 'emotion', 'dir', 'count']);
  assert.equal(tool.output.schema.additionalProperties, false);
  assert.equal(tool.output.schema.properties.ok.type, 'boolean');
  assert.equal(tool.output.schema.properties.duplicate.type, 'boolean');
  assert.equal(tool.output.schema.properties.count.type, 'integer');
  assert.equal(typeof tool.output.render, 'function');
});

test('execute：收藏 mediaDir 图片；同图二次收藏 duplicate 不新增', async (t) => {
  const rig = makeRig(t);
  const source = writeImage(rig.mediaDir, 'msg.png');

  const value = await rig.tool.execute({
    source_path: source,
    emotion: '大笑',
    tags: ['开心', ' 开心 ', 'emoji'],
    note: '常用',
  });
  assert.deepEqual(Object.keys(value).sort(), ['count', 'dir', 'duplicate', 'emotion', 'name', 'ok']);
  assert.equal(value.ok, true);
  assert.equal(value.duplicate, false);
  assert.match(value.name, /^大笑-\d+-[0-9a-f]{4}\.png$/);
  assert.equal(value.emotion, '大笑');
  assert.equal(value.dir, path.resolve(rig.dir));
  assert.equal(value.count, 1);
  assert.deepEqual(fs.readFileSync(path.join(rig.dir, value.name)), PNG);

  const item = rig.store.list()[0];
  assert.equal(item.source, 'tool');
  assert.deepEqual(item.tags, ['开心', 'emoji']);
  assert.equal(item.note, '常用');

  const rendered = rig.tool.output.render({}, value);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /已收藏表情/);
  assert.match(rendered[0].text, /共 1 张/);

  // 同一张图再次收藏：duplicate=true，文件名/条数不变，render 显示「已在表情包库」
  const again = await rig.tool.execute({ source_path: source, name: 'renamed.png', emotion: '别的' });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(again.name, value.name);
  assert.equal(again.emotion, '大笑');
  assert.equal(again.count, 1);
  assert.match(rig.tool.output.render({}, again)[0].text, /已在表情包库：.+（未重复收藏）/);
  assert.equal(rig.store.list().length, 1);

  // 不同内容 → 正常新增
  const source2 = writeImage(rig.mediaDir, 'msg2.png', variant(PNG, 'second'));
  const third = await rig.tool.execute({ source_path: source2, name: 'again.png' });
  assert.equal(third.ok, true);
  assert.equal(third.duplicate, false);
  assert.equal(third.name, 'again.png');
  assert.equal(third.count, 2);
  assert.equal(third.emotion, 'again'); // 没给 emotion 时展示文件名去扩展名
});

test('execute：显式 name 重名自动 -2；原文件保留（复制而非移动）', async (t) => {
  const rig = makeRig(t);
  // 三张内容不同、名字相同的图才会走 -2/-3（相同内容会命中去重，不新增文件）
  const src1 = writeImage(rig.mediaDir, 'src1.png', variant(PNG, '1'));
  const src2 = writeImage(rig.mediaDir, 'src2.png', variant(PNG, '2'));
  const src3 = writeImage(rig.mediaDir, 'src3.png', variant(PNG, '3'));
  assert.equal((await rig.tool.execute({ source_path: src1, name: 'cat.png' })).name, 'cat.png');
  assert.equal((await rig.tool.execute({ source_path: src2, name: 'cat.png' })).name, 'cat-2.png');
  assert.equal((await rig.tool.execute({ source_path: src3, name: 'cat.png' })).name, 'cat-3.png');
  assert.equal(fs.existsSync(src1), true);
  assert.equal(fs.existsSync(src2), true);
  assert.equal(fs.existsSync(src3), true);
  assert.equal(rig.store.list().length, 3);
});

test('允许根：cwd 与 sendFile.extraRoots 内的图片也能收藏', async (t) => {
  const rig = makeRig(t);
  const inCwd = writeImage(rig.cwd, 'workspace.png');
  const inExtra = writeImage(rig.extraDir, 'extra.jpg', JPEG);

  assert.equal((await rig.tool.execute({ source_path: inCwd })).ok, true);
  assert.equal((await rig.tool.execute({ source_path: inExtra })).ok, true);
  assert.equal(rig.store.list().length, 2);
});

test('mediaDir 通过 registerStickerTools 依赖参数传入（config.mediaDir 为空）也可用', async (t) => {
  const rig = makeRig(t, { mediaDirMode: 'dep' });
  const source = writeImage(rig.mediaDir, 'dep.png');
  const value = await rig.tool.execute({ source_path: source });
  assert.equal(value.ok, true);
  assert.equal(value.count, 1);
});

test('restrictPaths=false 时放行白名单外的绝对路径（与 qqbot_send_file 语义一致）', async (t) => {
  const rig = makeRig(t, { configOverrides: { sendFile: { restrictPaths: false, extraRoots: [] } } });
  const outside = path.join(rig.base, 'free.png');
  fs.writeFileSync(outside, PNG);
  const value = await rig.tool.execute({ source_path: outside });
  assert.equal(value.ok, true);
  assert.equal(rig.store.list().length, 1);
});

test('拒绝：白名单外/相对路径/空路径/不存在/目录/符号链接逃逸', async (t) => {
  const rig = makeRig(t);
  const outside = path.join(rig.base, 'outside.png');
  fs.writeFileSync(outside, PNG);

  await assert.rejects(() => rig.tool.execute({ source_path: outside }), /不在允许的目录内/);
  await assert.rejects(() => rig.tool.execute({ source_path: 'relative.png' }), /必须是绝对路径/);
  await assert.rejects(() => rig.tool.execute({ source_path: '' }), /不能为空/);
  await assert.rejects(() => rig.tool.execute({}), /不能为空/);
  await assert.rejects(
    () => rig.tool.execute({ source_path: path.join(rig.mediaDir, 'nope.png') }),
    /文件不存在/,
  );

  const sub = path.join(rig.mediaDir, 'sub');
  fs.mkdirSync(sub);
  await assert.rejects(() => rig.tool.execute({ source_path: sub }), /不是普通文件/);

  if (process.platform !== 'win32') {
    // 符号链接在允许根内，realpath 指向根外 → 必须拒绝
    const link = path.join(rig.mediaDir, 'link.png');
    fs.symlinkSync(outside, link);
    await assert.rejects(() => rig.tool.execute({ source_path: link }), /符号链接逃逸/);
  }

  assert.equal(rig.store.list().length, 0);
});

test('拒绝：非图片 / 超过 maxMB / tags 非法 / store 失败错误透传', async (t) => {
  const rig = makeRig(t, { maxMB: 1 });
  const txt = path.join(rig.mediaDir, 'note.txt');
  fs.writeFileSync(txt, 'hello, not an image');
  await assert.rejects(() => rig.tool.execute({ source_path: txt }), /不是支持的图片格式/);

  const big = path.join(rig.mediaDir, 'big.png');
  fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]));
  await assert.rejects(() => rig.tool.execute({ source_path: big }), /大小上限 1MB/);

  const ok = writeImage(rig.mediaDir, 'ok.png');
  await assert.rejects(() => rig.tool.execute({ source_path: ok, tags: 'not-an-array' }), /tags 必须是字符串数组/);

  // store.importFile 返回错误时 execute 抛错（错误文本透传给模型）
  const { ctx, defs } = createRecorder();
  const logger = createFakeLogger();
  const failingStore = {
    dir: () => path.join(rig.base, 'stickers'),
    list: () => [],
    collectQuota: () => ({ todayCount: 0, dailyLimit: 10, allowed: true }),
    importFile: () => ({ ok: false, error: 'saveBuffer: 不是支持的图片格式（png/jpeg/gif/webp）' }),
  };
  registerStickerTools(ctx, {
    stickerStore: failingStore,
    config: { cwd: rig.cwd, mediaDir: rig.mediaDir, sendFile: { restrictPaths: true, extraRoots: [] } },
    logger,
  });
  await assert.rejects(() => defs[0].execute({ source_path: ok }), /不是支持的图片格式/);
});

test('每日配额：dailyLimit=1 时第二次 tool 收藏被拒；API 上传不受限', async (t) => {
  const rig = makeRig(t, { dailyLimit: 1 });
  const first = await rig.tool.execute({ source_path: writeImage(rig.mediaDir, 'one.png', variant(PNG, '1')) });
  assert.equal(first.ok, true);
  assert.equal(first.count, 1);

  const second = writeImage(rig.mediaDir, 'two.png', variant(PNG, '2'));
  await assert.rejects(
    () => rig.tool.execute({ source_path: second }),
    /今日收藏已达上限（1 张），明天再收/,
  );
  assert.equal(rig.store.list().length, 1, '超限时不能落盘');

  // API 上传直接走 store.saveBuffer(source='upload')，不受每日配额限制
  const upload = rig.store.saveBuffer(variant(PNG, '3'), { name: 'upload.png', source: 'upload' });
  assert.equal(upload.ok, true);
  assert.equal(upload.duplicate, false);
  assert.equal(rig.store.list().length, 2);
  // 配额只统计 source='tool'：API 上传不占机器人额度（此时 24h 内 tool 收藏只有 1 条）
  assert.equal(rig.store.collectQuota().todayCount, 1);
  // 但工具层的收藏仍然被拒
  await assert.rejects(
    () => rig.tool.execute({ source_path: writeImage(rig.mediaDir, 'three.png', variant(PNG, '4')) }),
    /今日收藏已达上限/,
  );
});

test('tools 服务缺失或 get 抛错：只 warn 不抛，返回空 dispose', () => {
  const logger = createFakeLogger();
  const store = {
    dir: () => '/tmp/x',
    list: () => [],
    collectQuota: () => ({ todayCount: 0, dailyLimit: 10, allowed: true }),
    importFile: () => ({ ok: true }),
  };

  const missing = { get() { return undefined; } };
  const dispose = registerStickerTools(missing, { stickerStore: store, config: {}, logger });
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
  assert.ok(logger.byLevel('warn').some((args) => String(args[0]).includes('tools 服务不可用')));

  const throwing = { get() { throw new Error('service broken'); } };
  const logger2 = createFakeLogger();
  const dispose2 = registerStickerTools(throwing, { stickerStore: store, config: {}, logger: logger2 });
  assert.equal(typeof dispose2, 'function');
  assert.doesNotThrow(() => dispose2());
  assert.ok(logger2.byLevel('warn').some((args) => String(args[0]).includes('异常')));
});

test('stickerStore 缺失/不完整：warn 并跳过注册', () => {
  const { ctx, defs } = createRecorder();
  const logger = createFakeLogger();
  const dispose = registerStickerTools(ctx, { stickerStore: undefined, config: {}, logger });
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
  assert.equal(defs.length, 0);
  assert.ok(logger.byLevel('warn').some((args) => String(args[0]).includes('stickerStore 不可用')));

  const incomplete = { dir() { return '/tmp/x'; }, list() { return []; } }; // 缺 importFile
  const logger2 = createFakeLogger();
  registerStickerTools(ctx, { stickerStore: incomplete, config: {}, logger: logger2 });
  assert.equal(defs.length, 0);
  assert.ok(logger2.byLevel('warn').some((args) => String(args[0]).includes('stickerStore 不可用')));
});

test('tools.register 抛错时降级为 noop（不打挂启动）', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sticker-tool-'));
  t.after(() => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  const store = makeStore(base);
  const logger = createFakeLogger();
  const badCtx = { get: () => ({ register() { throw new Error('register boom'); } }) };
  const dispose = registerStickerTools(badCtx, {
    stickerStore: store,
    config: { cwd: base, mediaDir: path.join(base, 'media') },
    logger,
  });
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
  assert.ok(logger.byLevel('warn').some((args) => String(args[0]).includes('注册')));
});

test('dispose 注销工具（ctx.effect 卸载语义）', (t) => {
  const rig = makeRig(t);
  assert.equal(rig.defs.length, 1);
  rig.dispose();
  assert.equal(rig.defs.length, 0);
  assert.doesNotThrow(() => rig.dispose()); // 幂等
});

test('与 Cordis ctx 兼容：ctx.get("tools") 注册、执行、释放', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sticker-tool-'));
  t.after(() => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  const cwd = path.join(base, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const store = makeStore(base);
  const ctx = createFakeCtx();
  ctx.set('tools', ctx.tools); // fake-ctx 的服务容器需显式设 tools
  const logger = createFakeLogger();
  const dispose = registerStickerTools(ctx, {
    stickerStore: store,
    config: { cwd, mediaDir: path.join(base, 'media') },
    logger,
  });
  assert.equal(ctx.tools.registered.length, 1);
  const definition = ctx.tools.registered[0];
  assert.equal(definition.name, 'qqbot_sticker_save');

  const source = writeImage(cwd, 'in.png');
  const value = await definition.execute({ source_path: source });
  assert.equal(value.ok, true);
  assert.equal(value.duplicate, false);
  assert.equal(store.list().length, 1);

  dispose();
  assert.equal(ctx.tools.registered.length, 0);
});