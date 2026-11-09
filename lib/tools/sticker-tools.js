/**
 * sticker-tools —— 表情包工具（v2 适配 core/stickers/store.js 的契约）。
 *
 * 与 v1 的差异（只改 store 调用，不改产品语义）：
 *   - v1 store 自带 importFile/dir/collectQuota；v2 store 是 DB 行 + {add,list,get,remove,quota,recordSend}，
 *     文件复制/命名/magic 嗅探/去重哈希由本工具层完成（store 按 (bot_id, hash) 去重）；
 *   - 配额语义：v2 stores.quota 是「当日发送量」，所以配额约束在发送工具
 *     qqbot_send_sticker 上（settings.stickers.dailyQuota），保存不受限；
 *   - 文件落在 <bot.cwd>/stickers/（每个 bot 自包含，备份/迁移即拷贝目录）。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';

/** 收藏工具名。 */
export const STICKER_SAVE_TOOL_NAME = 'qqbot_sticker_save';
/** 发送工具名（v2 新增：把表情包库里的一张发到当前会话）。 */
export const STICKER_SEND_TOOL_NAME = 'qqbot_send_sticker';
/** 工具名列表。 */
export const STICKER_TOOL_NAMES = Object.freeze([STICKER_SAVE_TOOL_NAME, STICKER_SEND_TOOL_NAME]);

const SAVE_DESCRIPTION = 'Save an image from the current chat into the bot\'s sticker library so it can be sent later. '
  + 'Pass the local absolute path of the image shown in the message (source_path). '
  + 'Optionally give a short emotion label (emotion), a file name WITHOUT extension (name; the correct extension '
  + 'is appended from the image bytes, so do not guess .jpg/.png) and a note. '
  + 'Only use it for stickers/emotes you actually like and would send; do not save duplicates or spam.';

const SEND_DESCRIPTION = 'Send one sticker from the bot sticker library to the current QQ conversation. '
  + 'Pick a sticker by sticker_id (exact), name (exact or prefix) or emotion. '
  + 'Stickers have a daily sending quota (settings.stickers.dailyQuota); use them sparingly, '
  + 'like a human would, not on every reply.';

/** 图片 magic bytes -> 扩展名（与 inline-image/vision 的嗅探保持一致）。 */
function sniffImageExt(bytes) {
  if (!bytes || bytes.length < 12) return '';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return '.gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return '.webp';
  return '';
}

function errText(err) {
  return err instanceof Error ? err.message : String(err);
}

function warn(logger, ...args) {
  try { (logger ?? console).warn?.(...args); } catch { /* logger 失败不能影响注册 */ }
}

function isWithinRoot(filePath, root) {
  try {
    const rel = path.relative(root, filePath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/** 允许根：bot cwd + mediaDir + config.sendFile.extraRoots（restrictPaths=false 时不限制）。 */
function resolveRoots({ config = {}, cwd, mediaDir }) {
  const sendFile = config.sendFile && typeof config.sendFile === 'object' ? config.sendFile : {};
  const raw = [];
  const base = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd();
  raw.push(base);
  if (typeof mediaDir === 'string' && mediaDir.trim() !== '') raw.push(mediaDir);
  if (Array.isArray(sendFile.extraRoots)) {
    for (const root of sendFile.extraRoots) if (typeof root === 'string' && root.trim() !== '') raw.push(root);
  }
  const roots = [];
  for (const item of raw) {
    const abs = path.resolve(item);
    if (!roots.includes(abs)) roots.push(abs);
    try {
      const real = realpathSync(abs);
      if (!roots.includes(real)) roots.push(real);
    } catch { /* 根目录不存在时保留原始路径 */ }
  }
  return { roots, restrictPaths: sendFile.restrictPaths !== false };
}

/** 校验并解析源图片：返回 {realPath, bytes, ext, hash, size}。 */
function inspectSource(sourceInput, roots, restrictPaths) {
  if (sourceInput === '') throw new Error(STICKER_SAVE_TOOL_NAME + ': source_path 不能为空');
  if (sourceInput.includes('\0')) throw new Error(STICKER_SAVE_TOOL_NAME + ': source_path 包含非法字符');
  if (!path.isAbsolute(sourceInput)) throw new Error(STICKER_SAVE_TOOL_NAME + ': source_path 必须是绝对路径: ' + sourceInput);
  const abs = path.resolve(sourceInput);
  if (restrictPaths && !roots.some((root) => isWithinRoot(abs, root))) {
    throw new Error(STICKER_SAVE_TOOL_NAME + ': source_path 不在允许的目录内: ' + abs);
  }
  if (!existsSync(abs)) throw new Error(STICKER_SAVE_TOOL_NAME + ': 文件不存在: ' + abs);
  let realPath;
  try {
    realPath = realpathSync(abs);
  } catch (err) {
    throw new Error(STICKER_SAVE_TOOL_NAME + ': 无法解析文件真实路径: ' + errText(err));
  }
  if (restrictPaths && !roots.some((root) => isWithinRoot(realPath, root))) {
    throw new Error(STICKER_SAVE_TOOL_NAME + ': 文件真实路径不在允许的目录内（疑似符号链接逃逸）: ' + realPath);
  }
  const info = statSync(realPath);
  if (!info.isFile()) throw new Error(STICKER_SAVE_TOOL_NAME + ': 路径不是普通文件: ' + realPath);
  if (info.size > 10 * 1024 * 1024) throw new Error(STICKER_SAVE_TOOL_NAME + ': 图片超过大小上限（10MB）');
  const bytes = readFileSync(realPath);
  const ext = sniffImageExt(bytes);
  if (ext === '') throw new Error(STICKER_SAVE_TOOL_NAME + ': 无法识别的图片格式（仅支持 png/jpeg/gif/webp）');
  const hash = createHash('sha256').update(bytes).digest('hex');
  return { realPath, bytes, ext, hash, size: info.size };
}

/** 生成不冲突的目标文件路径（name.ext / name-2.ext ...）。 */
function uniqueTarget(dir, baseName, ext) {
  let candidate = path.join(dir, baseName + ext);
  let index = 2;
  while (existsSync(candidate) && index < 1000) {
    candidate = path.join(dir, baseName + '-' + index + ext);
    index += 1;
  }
  return candidate;
}

/** 去掉用户传入文件名的扩展名并清洗非法字符。 */
function cleanBaseName(name, fallback) {
  const raw = typeof name === 'string' ? name.trim() : '';
  const withoutExt = raw.replace(/\.(png|jpe?g|gif|webp)$/i, '').trim();
  const cleaned = withoutExt.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  return cleaned !== '' ? cleaned : fallback;
}

/** 解析当前会话发送目标。 */
function resolveTarget(manager, exec) {
  const runCtx = exec && typeof exec === 'object' ? exec : {};
  if (runCtx.agent === undefined) return undefined;
  const record = manager && typeof manager.findByAgent === 'function' ? manager.findByAgent(runCtx.agent) : undefined;
  return record && record.replyTarget ? record.replyTarget : undefined;
}

/**
 * 创建表情包工具定义。
 * @param {object} deps
 * @param {object} deps.stickers runtime.stickers（createStickersStore 返回值）
 * @param {string} deps.botId 机器人 id
 * @param {string} deps.cwd 机器人工作目录（表情包文件目录 = cwd/stickers）
 * @param {Function} deps.getMediaSender () => {sendImage}
 * @param {object} deps.manager 会话适配器（findByAgent）
 * @param {object} [deps.settings] v2 生效设置（读 stickers.dailyQuota，发送时现读可通过 getSettings）
 * @param {Function} [deps.getSettings] () => settings（优先，支持热更新）
 * @param {object} [deps.config] 部署配置（sendFile 白名单）
 * @param {string} [deps.mediaDir]
 * @param {object} [deps.logger]
 * @returns {object[]}
 */
export function createStickerTools({
  stickers, botId, cwd, getMediaSender, manager, settings, getSettings,
  config = {}, mediaDir, logger,
} = {}) {
  const log = logger || console;
  if (!stickers || typeof stickers.add !== 'function' || typeof stickers.list !== 'function') {
    warn(log, 'sticker store 不可用，表情包工具未注册');
    return [];
  }
  const owner = String(botId || '');
  if (owner === '') {
    warn(log, 'sticker 工具缺少 botId，未注册');
    return [];
  }
  const stickerDir = path.join(typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd(), 'stickers');
  const currentSettings = () => {
    try {
      if (typeof getSettings === 'function') return getSettings() || {};
      return settings && typeof settings === 'object' ? settings : {};
    } catch {
      return {};
    }
  };
  const listStickers = () => {
    try { return stickers.list({ botId: owner, limit: 500 }) || []; } catch (err) {
      warn(log, '读取表情包列表失败:', errText(err));
      return [];
    }
  };

  const save = {
    name: STICKER_SAVE_TOOL_NAME,
    description: SAVE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Absolute local path of the image to collect (the path shown in the message).' },
        name: { type: 'string', description: 'Optional stored base name WITHOUT extension (auto-corrected from image bytes).' },
        emotion: { type: 'string', description: 'Optional short emotion label, e.g. "大笑" / "开心".' },
        note: { type: 'string', description: 'Optional free-form note about when to use this sticker.' },
      },
      required: ['source_path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          duplicate: { type: 'boolean' },
          name: { type: 'string' },
          emotion: { type: 'string' },
          dir: { type: 'string' },
          count: { type: 'integer' },
        },
        required: ['ok', 'duplicate', 'name', 'emotion', 'dir', 'count'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        if (v.duplicate === true) return [{ type: 'text', text: '已在表情包库：' + (v.name || '') + '（未重复收藏）' }];
        return [{
          type: 'text',
          text: '已收藏表情 ' + (v.name || '') + '（' + (v.emotion || '未标注情绪') + '），表情包库共 ' + (v.count ?? 0) + ' 张。',
        }];
      },
    },
    async execute(args) {
      const sourceInput = args && typeof args.source_path === 'string' ? args.source_path.trim() : '';
      const { roots, restrictPaths } = resolveRoots({ config, cwd, mediaDir });
      const source = inspectSource(sourceInput, roots, restrictPaths);

      // 去重：v2 store 按 (bot_id, hash) 唯一；先查再落盘，避免多余文件
      const duplicate = listStickers().find((item) => item && item.hash === source.hash);
      if (duplicate) {
        return {
          ok: true,
          duplicate: true,
          name: duplicate.name,
          emotion: duplicate.emotion || '',
          dir: stickerDir,
          count: listStickers().length,
        };
      }
      const baseName = cleanBaseName(args && args.name, 'sticker-' + source.hash.slice(0, 8));
      try { mkdirSync(stickerDir, { recursive: true, mode: 0o755 }); } catch (err) {
        throw new Error(STICKER_SAVE_TOOL_NAME + ': 创建表情包目录失败: ' + errText(err));
      }
      const target = uniqueTarget(stickerDir, baseName, source.ext);
      try {
        copyFileSync(source.realPath, target);
      } catch (err) {
        throw new Error(STICKER_SAVE_TOOL_NAME + ': 复制图片失败: ' + errText(err));
      }
      let saved;
      try {
        saved = stickers.add({
          botId: owner,
          name: path.basename(target, source.ext),
          file: target,
          emotion: typeof args?.emotion === 'string' ? args.emotion : '',
          hash: source.hash,
        });
      } catch (err) {
        try { rmSync(target, { force: true }); } catch { /* ignore */ }
        throw new Error(STICKER_SAVE_TOOL_NAME + ': 登记表情包失败: ' + errText(err));
      }
      if (!saved || saved.created !== true) {
        try { rmSync(target, { force: true }); } catch { /* ignore */ }
        return {
          ok: true,
          duplicate: true,
          name: (saved && saved.name) || baseName,
          emotion: (saved && saved.emotion) || '',
          dir: stickerDir,
          count: listStickers().length,
        };
      }
      log.info?.('qqbot_sticker_save 收藏表情 ' + saved.name + '（' + source.size + ' bytes）');
      return {
        ok: true,
        duplicate: false,
        name: saved.name,
        emotion: saved.emotion || '',
        dir: stickerDir,
        count: listStickers().length,
      };
    },
  };

  const send = {
    name: STICKER_SEND_TOOL_NAME,
    description: SEND_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        sticker_id: { type: 'integer', description: 'Sticker id from the sticker library (exact match).' },
        name: { type: 'string', description: 'Sticker name (exact match preferred, prefix also accepted).' },
        emotion: { type: 'string', description: 'Pick a random sticker with this emotion label.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          emotion: { type: 'string' },
          target: { type: 'string' },
          remaining: { type: 'integer' },
        },
        required: ['ok', 'name', 'target'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: '已发送表情「' + (value.name || '') + '」 -> ' + (value.target || ''),
      }],
    },
    async execute(args, exec) {
      const settingsNow = currentSettings();
      const stickerSettings = settingsNow.stickers && typeof settingsNow.stickers === 'object' ? settingsNow.stickers : {};
      if (stickerSettings.enabled === false) throw new Error(STICKER_SEND_TOOL_NAME + ': 表情包功能已关闭');
      const target = resolveTarget(manager, exec);
      if (!target) throw new Error(STICKER_SEND_TOOL_NAME + ': 无法确定发送目标，请先让用户发一条消息');
      const all = listStickers();
      if (all.length === 0) throw new Error(STICKER_SEND_TOOL_NAME + ': 表情包库是空的，先用 qqbot_sticker_save 收藏');

      const idArg = Number(args && args.sticker_id);
      const nameArg = typeof args?.name === 'string' ? args.name.trim() : '';
      const emotionArg = typeof args?.emotion === 'string' ? args.emotion.trim() : '';
      let picked = null;
      if (Number.isInteger(idArg) && idArg > 0) picked = all.find((item) => item.id === idArg) || null;
      if (!picked && nameArg !== '') {
        picked = all.find((item) => item.name === nameArg)
          || all.find((item) => typeof item.name === 'string' && item.name.startsWith(nameArg))
          || null;
      }
      if (!picked && emotionArg !== '') {
        const candidates = all.filter((item) => item.emotion === emotionArg);
        if (candidates.length > 0) picked = candidates[Math.floor(Math.random() * candidates.length)];
      }
      if (!picked) throw new Error(STICKER_SEND_TOOL_NAME + ': 没有找到匹配的表情包（可用 sticker_id / name / emotion 指定）');

      // 每日发送配额（v2 stores.quota 记录当日发送量）
      const dailyQuota = Number(stickerSettings.dailyQuota);
      if (Number.isFinite(dailyQuota) && dailyQuota >= 0) {
        const quota = stickers.quota({ botId: owner });
        if (quota && quota.count >= dailyQuota) {
          throw new Error(STICKER_SEND_TOOL_NAME + ': 今日表情包发送已达上限（' + dailyQuota + ' 张），明天再发');
        }
      }
      const mediaSender = typeof getMediaSender === 'function' ? getMediaSender() : null;
      if (!mediaSender || typeof mediaSender.sendImage !== 'function') {
        throw new Error(STICKER_SEND_TOOL_NAME + ': 媒体发送通道不可用');
      }
      await mediaSender.sendImage(target, { localPath: picked.file });
      try { stickers.recordSend({ botId: owner }); } catch (err) {
        warn(log, '记录表情发送失败（忽略）:', errText(err));
      }
      const after = (() => { try { return stickers.quota({ botId: owner }); } catch { return null; } })();
      const remaining = after && Number.isFinite(dailyQuota) ? Math.max(0, dailyQuota - after.count) : undefined;
      log.info?.('qqbot_send_sticker 发送表情 ' + picked.name + ' -> ' + target.scope + ':' + target.targetId);
      return {
        ok: true,
        name: picked.name,
        emotion: picked.emotion || '',
        target: target.scope + ':' + target.targetId,
        ...(remaining === undefined ? {} : { remaining }),
      };
    },
  };

  return [save, send];
}

export default createStickerTools;
