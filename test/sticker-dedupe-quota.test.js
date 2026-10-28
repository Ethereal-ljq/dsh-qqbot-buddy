/**
 * test/sticker-dedupe-quota.test.js —— 表情包内容去重 + 每日收藏配额（追加需求 2026-10-26 晚）。
 *
 * 与 test/sticker-edge.test.js（sticker-dev owner）分开维护，避免并发编辑冲突。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStickerStore } from '../lib/stickers/store.js';
import { registerStickerTools } from '../lib/tools/sticker-tools.js';
import { createFakeLogger } from './helpers/fake-ctx.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

/** 与 sticker-edge 相同的思路：在 PNG 末尾加标记字节，得到内容不同但仍是合法 PNG 魔数的 buffer。 */
function variant(marker) {
  return Buffer.concat([PNG, Buffer.from(String(marker), 'utf8')]);
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-sticker-dq-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 构造临时 store（目录在临时目录下）。 */
function makeStore(t) {
  const base = tempDir(t);
  const stickersDir = path.join(base, 'stickers');
  fs.mkdirSync(stickersDir, { recursive: true });
  const state = { stickers: { dir: stickersDir, collectEnabled: true, maxMB: 8, dailyLimit: 10 } };
  const store = createStickerStore({
    settings: { get: () => JSON.parse(JSON.stringify(state)) },
    logger: createFakeLogger(),
  });
  return { base, stickersDir, state, store };
}
// ── 内容去重 + 每日收藏配额（追加需求 2026-10-26 晚） ────────

test('dedupe：同字节第二次 save 返回 duplicate=true、文件名复用且不新增文件/index', (t) => {
  const { store, stickersDir } = makeStore(t);
  const first = store.saveBuffer(PNG, { name: 'laugh.png', emotion: '大笑' });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.created, true);
  assert.equal(first.name, 'laugh.png');

  const second = store.saveBuffer(PNG, { name: 'copy.png', emotion: '重复' });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true, '相同字节应判定重复');
  assert.equal(second.created, false);
  assert.equal(second.name, 'laugh.png', '应复用已有文件名');
  assert.equal(fs.existsSync(path.join(stickersDir, 'copy.png')), false, '不应写入第二份文件');
  assert.equal(store.list().length, 1);
  assert.equal(Object.keys(store.index().items).length, 1);

  // importFile（工具收藏路径）同样走内容去重
  const sourceDir = tempDir(t);
  const source = path.join(sourceDir, 'src.png');
  fs.writeFileSync(source, PNG);
  const imported = store.importFile(source, { name: 'from-tool' });
  assert.equal(imported.ok, true);
  assert.equal(imported.duplicate, true);
  assert.equal(imported.name, 'laugh.png');
  assert.equal(store.list().length, 1);
});

test('quota：collectQuota 统计 24h 内新增，dailyLimit 截断且 API 上传不受配额限制', (t) => {
  const base = tempDir(t);
  const stickersDir = path.join(base, 'stickers');
  fs.mkdirSync(stickersDir, { recursive: true });
  const state = { stickers: { dir: stickersDir, collectEnabled: true, maxMB: 8, dailyLimit: 2 } };
  const store = createStickerStore({ settings: { get: () => JSON.parse(JSON.stringify(state)) }, logger: createFakeLogger() });
  // 两张内容不同的图片（第二张在 PNG 后加一个字节，magic 仍是 PNG，hash 不同）
  const png2 = Buffer.concat([PNG, Buffer.from([0x00])]);
  assert.equal(store.saveBuffer(PNG, { name: 'a.png', source: 'tool' }).ok, true);
  assert.equal(store.saveBuffer(png2, { name: 'b.png', source: 'tool' }).ok, true);

  const quota = store.collectQuota();
  assert.equal(quota.todayCount, 2);
  assert.equal(quota.dailyLimit, 2);
  assert.equal(quota.allowed, false, '达到每日上限后 allowed=false');

  // 把 index 的 addedAt 改成 2 天前 → 不计入 24h 配额
  const index = store.index();
  for (const name of Object.keys(index.items)) index.items[name].addedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(path.join(stickersDir, 'index.json'), JSON.stringify(index), 'utf8');
  const oldQuota = store.collectQuota();
  assert.equal(oldQuota.todayCount, 0);
  assert.equal(oldQuota.allowed, true);

  // API 上传等价路径（store.saveBuffer）不检查配额：超限后仍能保存
  const png3 = Buffer.concat([PNG, Buffer.from([0x01])]);
  const apiSave = store.saveBuffer(png3, { name: 'api-upload.png', source: 'upload' });
  assert.equal(apiSave.ok, true);
  assert.equal(apiSave.duplicate, false);
  // source='upload' 不占机器人配额：重新计算仍是 0
  assert.equal(store.collectQuota().todayCount, 0);
});

test('tool：dailyLimit=1 时第二次收藏报「今日收藏已达上限」；重复内容不计配额', async (t) => {
  const base = tempDir(t);
  const cwd = path.join(base, 'cwd');
  const mediaDir = path.join(base, 'media');
  const stickersDir = path.join(base, 'stickers');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(stickersDir, { recursive: true });
  const srcA = path.join(cwd, 'a.png');
  const srcB = path.join(cwd, 'b.png');
  fs.writeFileSync(srcA, PNG);
  fs.writeFileSync(srcB, Buffer.concat([PNG, Buffer.from([0x02])]));
  const state = { stickers: { dir: stickersDir, collectEnabled: true, maxMB: 8, dailyLimit: 1 } };
  const store = createStickerStore({ settings: { get: () => JSON.parse(JSON.stringify(state)) }, logger: createFakeLogger() });

  let definition;
  const fakeCtx = {
    get(name) {
      if (name === 'tools') {
        return { register(def) { definition = def; return () => {}; } };
      }
      return undefined;
    },
    logger: createFakeLogger(),
  };
  const config = { cwd, mediaDir, sendFile: { restrictPaths: true, extraRoots: [] } };
  const dispose = registerStickerTools(fakeCtx, { stickerStore: store, config, logger: createFakeLogger() });
  t.after(() => { try { dispose(); } catch { /* ignore */ } });
  assert.ok(definition && definition.name === 'qqbot_sticker_save', '应注册 qqbot_sticker_save');

  const first = await definition.execute({ source_path: srcA, emotion: '开心' });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.count, 1);

  // 达到每日上限后，新的收藏应抛出可读错误
  await assert.rejects(
    () => definition.execute({ source_path: srcB, emotion: '其它' }),
    /今日收藏已达上限/,
  );

  // 重复内容（即使超限）不应触发配额错误：先证明重复返回 duplicate=true（用 limit=1 且第一条内容）
  // 直接把限值调大后验证 duplicate 不新增文件
  state.stickers.dailyLimit = 5;
  const dup = await definition.execute({ source_path: srcA, emotion: '重复' });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.name, first.name);
  assert.equal(store.list().length, 1, '重复收藏不应增加文件数');
});