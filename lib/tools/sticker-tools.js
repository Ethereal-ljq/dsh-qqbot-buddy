/**
 * sticker-tools —— 注册 qqbot_sticker_save 工具：把消息里看到的本地图片收藏进表情包库。
 *
 * 注册形态与 memory-tools / send-file 一致：
 *   ctx.get('tools').register({ name, description, parameters, output: { schema, render }, execute })
 * - 工具服务缺失时只告警、不抛错（宿主仍可启动）；
 * - 返回聚合 dispose（便于宿主 ctx.effect 清理）；
 * - execute 失败抛 Error（模型可见错误文本），成功返回 output.schema 约定的
 *   {ok, duplicate, name, emotion, dir, count}；
 * - 每日配额：import 前调 stickerStore.collectQuota()，source='tool' 的收藏在额度用完后
 *   抛「今日收藏已达上限（N 张），明天再收」（API 上传不走本工具，不受配额限制）；
 * - 内容去重：store.importFile 对相同内容返回 {duplicate:true, name:已有名}，本工具原样透出
 *   （不新增文件/条数），render 显示「已在表情包库：<name>（未重复收藏）」。
 *
 * 路径白名单（防越权读文件）：
 * - source_path 必须是绝对路径、已存在、是普通文件；
 * - 真实路径（realpath，防符号链接逃逸）必须落在 config.cwd / config.mediaDir /
 *   config.sendFile.extraRoots 之一；config.sendFile.restrictPaths === false 时放行任意路径
 *   （与 qqbot_send_file 的白名单语义保持一致）；
 * - 图片格式/大小/命名由 stickerStore.importFile 兜底校验（magic bytes + maxMB）。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** 工具名（qqbot 前缀避免与其它通道的同名工具冲突）。 */
export const STICKER_SAVE_TOOL_NAME = 'qqbot_sticker_save';

/** 工具名列表（便于 session-manager 白名单等按数组引入）。 */
export const STICKER_TOOL_NAMES = Object.freeze([STICKER_SAVE_TOOL_NAME]);

const DESCRIPTION = 'Save an image from the current chat into the bot\'s sticker library so it can be sent later. '
  + 'Pass the local absolute path of the image shown in the message (source_path). '
  + 'Optionally give a short emotion label (emotion), a file name WITHOUT extension (name; the correct extension '
  + 'is appended from the image bytes, so do not guess .jpg/.png), tags (string array) and a note. '
  + 'Only use it for stickers/emotes you actually like and would send; do not save duplicates or spam.';

const OUTPUT_SCHEMA = {
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
};

/** 安全取日志方法 */
function warn(logger, ...args) {
  try {
    (logger ?? console).warn?.(...args);
  } catch { /* logger 失败不能影响注册 */ }
}

/** 是否位于 root 内（含 root 本身）。 */
function isWithinRoot(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 默认 mediaDir：与 lib/index.js 的 resolveDir(cfg.mediaDir, <cwd>/.qqbot/media) 保持一致。
 * 「一个工作区」原则：未显式配置时，program 默认把数据放在会话工作区内，不写用户主目录。
 * 只有 config.cwd 也缺失时才回退到 process.cwd()。
 */
function defaultMediaDir(config) {
  try {
    const rawCwd = config && typeof config.cwd === 'string' ? config.cwd.trim() : '';
    const base = rawCwd !== '' ? path.resolve(rawCwd) : process.cwd();
    return path.join(base, '.qqbot', 'media');
  } catch {
    return '';
  }
}

/**
 * 计算允许根目录。
 * config.cwd / config.mediaDir / config.sendFile.extraRoots，额外接受显式 mediaDir 参数；
 * mediaDir 缺失时回退默认 ~/.dsh-qqbot/media（index.js 传的 runtimeConfig 默认不含解析后的 mediaDir）。
 * 每个根同时把 realpath 结果纳入白名单，避免根目录本身是符号链接时误拒。
 */
function resolveRoots(config, mediaDir) {
  const cfg = config && typeof config === 'object' ? config : {};
  const sendFile = cfg.sendFile && typeof cfg.sendFile === 'object' ? cfg.sendFile : {};
  const rawRoots = [];
  const cwd = typeof cfg.cwd === 'string' && cfg.cwd.trim() !== '' ? cfg.cwd.trim() : process.cwd();
  rawRoots.push(cwd);
  const candidates = [];
  if (typeof mediaDir === 'string' && mediaDir.trim() !== '') candidates.push(mediaDir.trim());
  if (typeof cfg.mediaDir === 'string' && cfg.mediaDir.trim() !== '') candidates.push(cfg.mediaDir.trim());
  if (candidates.length === 0) {
    const fallback = defaultMediaDir(cfg);
    if (fallback !== '') candidates.push(fallback);
  }
  rawRoots.push(...candidates);
  if (Array.isArray(sendFile.extraRoots)) {
    for (const root of sendFile.extraRoots) {
      if (typeof root === 'string' && root.trim() !== '') rawRoots.push(root.trim());
    }
  }
  const roots = [];
  for (const raw of rawRoots) {
    const abs = path.resolve(raw);
    if (!roots.includes(abs)) roots.push(abs);
    try {
      const real = realpathSync(abs);
      if (!roots.includes(real)) roots.push(real);
    } catch { /* 根目录不存在时保留原始路径 */ }
  }
  return {
    roots,
    restrictPaths: sendFile.restrictPaths !== false,
  };
}

/** 解析字符串参数（非字符串视为未提供） */
function optionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 构造工具定义。
 * @param {{stickerStore:object, config:object, logger:object, mediaDir?:string}} deps
 */
function buildDefinition({ stickerStore, config, logger, mediaDir }) {
  const log = logger ?? console;
  return {
    name: STICKER_SAVE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        source_path: {
          type: 'string',
          description: 'Absolute local path of the image to collect (the path shown in the message).',
        },
        name: {
          type: 'string',
          description: 'Optional stored base name WITHOUT extension (auto-corrected from image bytes). Duplicates get -2/-3 suffixes.',
        },
        emotion: {
          type: 'string',
          description: 'Optional short emotion label, e.g. "大笑" / "开心". Used in the sticker catalog and default file name.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional short tags (max 8).',
        },
        note: {
          type: 'string',
          description: 'Optional free-form note about when to use this sticker.',
        },
      },
      required: ['source_path'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = value && typeof value === 'object' ? value : {};
        const name = v.name || '';
        if (v.duplicate === true) {
          return [{ type: 'text', text: '已在表情包库：' + name + '（未重复收藏）' }];
        }
        const label = v.emotion ? v.emotion : '未标注情绪';
        return [{
          type: 'text',
          text: '已收藏表情 ' + name + '（' + label + '），表情包库共 ' + (v.count ?? 0) + ' 张。',
        }];
      },
    },
    async execute(args) {
      const sourceInput = args && typeof args.source_path === 'string' ? args.source_path.trim() : '';
      if (sourceInput === '') throw new Error(STICKER_SAVE_TOOL_NAME + ': source_path 不能为空');
      if (sourceInput.includes('\0')) throw new Error(STICKER_SAVE_TOOL_NAME + ': source_path 包含非法字符');
      if (!path.isAbsolute(sourceInput)) {
        throw new Error(STICKER_SAVE_TOOL_NAME + ': source_path 必须是绝对路径: ' + sourceInput);
      }
      const abs = path.resolve(sourceInput);

      // 1) 原始路径必须落在允许根内
      const { roots, restrictPaths } = resolveRoots(config, mediaDir);
      if (restrictPaths && !roots.some((root) => isWithinRoot(abs, root))) {
        throw new Error(STICKER_SAVE_TOOL_NAME + ': source_path 不在允许的目录内: ' + abs);
      }
      if (!existsSync(abs)) throw new Error(STICKER_SAVE_TOOL_NAME + ': 文件不存在: ' + abs);

      // 2) realpath 解析后仍必须落在允许根内（防符号链接逃逸）
      let realPath;
      try {
        realPath = realpathSync(abs);
      } catch (err) {
        throw new Error(STICKER_SAVE_TOOL_NAME + ': 无法解析文件真实路径: ' + (err && err.message));
      }
      if (restrictPaths && !roots.some((root) => isWithinRoot(realPath, root))) {
        throw new Error(STICKER_SAVE_TOOL_NAME + ': 文件真实路径不在允许的目录内（疑似符号链接逃逸）: ' + realPath);
      }
      let stat;
      try {
        stat = statSync(realPath);
      } catch (err) {
        throw new Error(STICKER_SAVE_TOOL_NAME + ': 无法读取文件信息: ' + (err && err.message));
      }
      if (!stat.isFile()) throw new Error(STICKER_SAVE_TOOL_NAME + ': 路径不是普通文件: ' + realPath);

      // 3) 参数校验（tags 必须是字符串数组）；name 统一去掉扩展名，由 store 按 magic 补正确扩展名，
      //    避免模型猜错 .jpg/.png 导致多次失败重试（实测踩过）。
      const rawName = optionalString(args && args.name);
      let name = rawName;
      if (typeof name === 'string') {
        name = name.replace(/\.(png|jpe?g|gif|webp)$/i, '').trim();
        if (name === '') name = undefined;
      }
      const emotion = optionalString(args && args.emotion);
      const note = optionalString(args && args.note);
      let tags;
      if (args && args.tags !== undefined && args.tags !== null) {
        if (!Array.isArray(args.tags)) {
          throw new Error(STICKER_SAVE_TOOL_NAME + ': tags 必须是字符串数组');
        }
        tags = args.tags.filter((tag) => typeof tag === 'string');
      }

      // 4) 每日收藏配额（只限制 bot 主动收藏 source='tool'；API 上传不经过本工具）
      if (typeof stickerStore.collectQuota === 'function') {
        let quota;
        try {
          quota = stickerStore.collectQuota();
        } catch (err) {
          warn(log, STICKER_SAVE_TOOL_NAME + ': 读取收藏配额失败，按未超限处理:', err && err.message);
          quota = undefined;
        }
        if (quota && quota.allowed === false) {
          throw new Error(
            STICKER_SAVE_TOOL_NAME + ': 今日收藏已达上限（' + quota.dailyLimit + ' 张），明天再收',
          );
        }
      }

      // 5) 交给 store 复制 + 登记（magic bytes / maxMB / 命名 / 去重 / 索引都在 store 内兜底）
      const result = stickerStore.importFile(realPath, {
        name,
        emotion,
        tags,
        note,
        source: 'tool',
      });
      if (!result || result.ok !== true) {
        throw new Error(STICKER_SAVE_TOOL_NAME + ': ' + ((result && result.error) || '收藏失败'));
      }
      let count = 0;
      try {
        count = stickerStore.list().length;
      } catch (err) {
        warn(log, STICKER_SAVE_TOOL_NAME + ': 统计表情包数量失败:', err && err.message);
      }
      const item = result.item && typeof result.item === 'object' ? result.item : {};
      return {
        ok: true,
        duplicate: result.duplicate === true,
        name: result.name,
        emotion: typeof item.emotion === 'string' ? item.emotion : '',
        dir: stickerStore.dir(),
        count,
      };
    },
  };
}

/**
 * 注册 qqbot_sticker_save 工具（tools 服务缺失时优雅降级，不阻断插件启动）。
 * @param {object} ctx 插件上下文
 * @param {{stickerStore?:object, config?:object, logger?:object, mediaDir?:string}} deps
 *   stickerStore 为 createStickerStore 的返回值；mediaDir 可选（缺省回退 config.mediaDir / ~/.dsh-qqbot/media）
 * @returns {() => void} 聚合 dispose；工具服务/store 不可用时返回空函数
 */
export function registerStickerTools(ctx, { stickerStore, config, logger, mediaDir, resolveBot } = {}) {
  const log = logger ?? console;
  let tools;
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined;
  } catch (err) {
    warn(log, '表情包工具注册：读取 tools 服务异常:', err && err.message);
    tools = undefined;
  }
  if (!tools || typeof tools.register !== 'function') {
    warn(log, '表情包工具注册：tools 服务不可用，' + STICKER_SAVE_TOOL_NAME + ' 未注册');
    return () => {};
  }
  if (!stickerStore || typeof stickerStore.importFile !== 'function' || typeof stickerStore.dir !== 'function'
    || typeof stickerStore.list !== 'function') {
    warn(log, '表情包工具注册：stickerStore 不可用，跳过注册');
    return () => {};
  }

  let definition;
  try {
    definition = buildDefinition({ stickerStore, config, logger: log, mediaDir });
    // 多机器人：工具只注册一次，执行时按 exec.agent 路由到所属机器人的 store/config。
    if (typeof resolveBot === 'function') {
      const cache = new Map();
      const base = definition;
      definition = {
        name: base.name,
        description: base.description,
        parameters: base.parameters,
        output: base.output,
        async execute(args, exec) {
          let bot = null;
          try { bot = resolveBot(exec); } catch { bot = null; }
          let target = base;
          if (bot) {
            const key = bot.id || bot.botId || '';
            if (cache.has(key)) {
              target = cache.get(key) || base;
            } else {
              let built = null;
              try {
                built = buildDefinition({ stickerStore: bot.stickers, config: bot.config, logger: log, mediaDir: bot.mediaDir });
              } catch {
                built = null;
              }
              cache.set(key, built);
              target = built || base;
            }
          }
          return target.execute(args, exec);
        },
      };
    }
  } catch (err) {
    warn(log, '表情包工具定义构造失败:', err && err.message);
    return () => {};
  }
  try {
    const dispose = tools.register(definition);
    return () => {
      if (typeof dispose !== 'function') return;
      try {
        dispose();
      } catch (err) {
        warn(log, '表情包工具注销失败:', err && err.message);
      }
    };
  } catch (err) {
    warn(log, '注册 ' + STICKER_SAVE_TOOL_NAME + ' 失败:', err && err.message);
    return () => {};
  }
}

export default registerStickerTools;