/**
 * send-file —— 内置工具 qqbot_send_file：把本地文件发给当前 QQ 会话。
 *
 * 参考官方 dist/media/send-file-tool.js：
 *   - 发送目标默认自动定位（exec.agent -> SessionManager.findByAgent -> replyTarget），
 *     显式 target 参数（c2c:openid / group:openid）作为覆盖；
 *   - 按扩展名分发到 SDK 的 sendImage / sendVideo / sendVoice / sendFile；
 *   - 路径白名单：默认只允许 mediaDir + bot cwd + config.sendFile.extraRoots，
 *     config.sendFile.restrictPaths=false 时放行任意路径。
 */
import { existsSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';

/** 工具名（qqbot 前缀避免与其它通道的同名工具冲突）。 */
export const SEND_FILE_TOOL_NAME = 'qqbot_send_file';

const DESCRIPTION = 'Send a local file (image, video, voice, or generic file) to the QQ user or group '
  + 'of the current conversation. Pass the absolute path of a file that already exists on disk. '
  + 'Use this when the user asks you to deliver a generated file (chart, report, exported data, '
  + 'screenshot, etc.) or to send an existing media/file back to them.';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const VOICE_EXTS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.silk', '.amr']);

/** 安全获取可选服务。 */
function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** 解析显式 target（c2c:openid / group:openid），非法返回 undefined。 */
function parseTarget(input) {
  if (typeof input !== 'string') return undefined;
  const idx = input.indexOf(':');
  if (idx <= 0) return undefined;
  const scope = input.slice(0, idx);
  const targetId = input.slice(idx + 1);
  if (!targetId || (scope !== 'c2c' && scope !== 'group')) return undefined;
  return { scope, targetId };
}

/** 判断 filePath 是否位于 root 目录内（含 root 本身）。 */
function isWithinRoot(filePath, root) {
  const rel = relative(resolve(root), filePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 路径白名单校验。 */
function isPathAllowed(filePath, config, cwd) {
  const sendFile = config.sendFile && typeof config.sendFile === 'object' ? config.sendFile : {};
  if (sendFile.restrictPaths === false) return true;
  const extra = Array.isArray(sendFile.extraRoots) ? sendFile.extraRoots : [];
  const roots = [];
  for (const root of [mediaDirGlobal(), cwd].concat(extra)) {
    if (typeof root !== 'string' || root.trim() === '') continue;
    roots.push(resolve(root));
  }
  return roots.some((root) => isWithinRoot(filePath, root));
}

/** mediaDir 通过闭包注入（见 registerSendFileTool），这里只做占位。 */
let mediaDirGlobal = () => '';
function setMediaDir(dir) {
  const value = typeof dir === 'string' && dir !== '' ? dir : '';
  mediaDirGlobal = () => value;
}

/** 无可用发送适配器时抛错。 */
function requireSenderMethod(sender, name) {
  if (!sender || typeof sender[name] !== 'function') {
    throw new Error('qqbot_send_file: 发送通道不可用（' + name + '）');
  }
}

/**
 * 注册 qqbot_send_file 工具（tools 服务缺失时优雅降级，不阻断插件启动）。
 * @param {object} args
 * @param {object} args.ctx 插件上下文
 * @param {object} args.sender 发送适配器 {sendImage,sendVideo,sendVoice,sendFile}
 * @param {object} args.manager SessionManager
 * @param {object} args.config 部署配置
 * @param {object} args.logger 日志对象
 * @param {string} args.mediaDir 媒体目录（白名单根之一）
 * @returns {Function|undefined} tools.register 返回的注销函数
 */
export function registerSendFileTool({ ctx, sender, manager, config = {}, logger, mediaDir } = {}) {
  const log = logger || console;
  const tools = getService(ctx, 'tools');
  if (!tools || typeof tools.register !== 'function') {
    log.warn('tools 服务不可用，qqbot_send_file 工具未注册');
    return undefined;
  }
  setMediaDir(mediaDir);
  const cwd = config.cwd && String(config.cwd).trim() !== '' ? resolve(String(config.cwd)) : process.cwd();

  const definition = {
    name: SEND_FILE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the local file to send (image/video/voice/generic file).',
        },
        target: {
          type: 'string',
          description: 'Optional send target as "c2c:openid" or "group:openid". Omit to send to the current conversation.',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          fileName: { type: 'string' },
          fileSize: { type: 'integer' },
          target: { type: 'string' },
          fileUuid: { type: 'string' },
          messageId: { type: 'string' },
        },
        required: ['fileName', 'fileSize', 'target', 'fileUuid'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: '已发送 ' + value.fileName + ' -> ' + value.target }],
    },
    async execute(args, exec) {
      const runCtx = exec && typeof exec === 'object' ? exec : {};
      const filePathInput = args && typeof args.file_path === 'string' ? args.file_path.trim() : '';
      if (filePathInput === '') throw new Error('qqbot_send_file: file_path 不能为空');
      const explicitTarget = args && args.target !== undefined && args.target !== '' ? args.target : undefined;

      // 1. 解析发送目标：显式 target > 当前会话（exec.agent -> session record）
      let replyTarget;
      if (explicitTarget !== undefined) {
        replyTarget = parseTarget(explicitTarget);
        if (!replyTarget) {
          throw new Error('qqbot_send_file: target 需要 c2c:openid 或 group:openid，收到: ' + explicitTarget);
        }
      } else if (runCtx.agent !== undefined) {
        const record = typeof manager.findByAgent === 'function' ? manager.findByAgent(runCtx.agent) : undefined;
        replyTarget = record ? record.replyTarget : undefined;
      }
      if (!replyTarget) throw new Error('qqbot_send_file: 无法确定发送目标，请显式传 target 参数');

      // 2. 路径白名单 + 文件校验
      const absPath = isAbsolute(filePathInput) ? resolve(filePathInput) : resolve(cwd, filePathInput);
      if (!isPathAllowed(absPath, config, cwd)) {
        throw new Error('qqbot_send_file: file_path 不在允许的目录内: ' + absPath);
      }
      if (!existsSync(absPath)) throw new Error('qqbot_send_file: 文件不存在: ' + absPath);
      // 防符号链接逃逸：真实路径也必须落在白名单内
      let realPath = absPath;
      try {
        realPath = realpathSync(absPath);
      } catch {
        throw new Error('qqbot_send_file: 无法解析文件真实路径: ' + absPath);
      }
      if (!isPathAllowed(realPath, config, cwd)) {
        throw new Error('qqbot_send_file: 文件真实路径不在允许的目录内（疑似符号链接逃逸）: ' + realPath);
      }
      const info = await stat(realPath);
      if (!info.isFile()) throw new Error('qqbot_send_file: 路径不是普通文件: ' + realPath);

      // 3. 按扩展名分类发送
      const fileName = basename(absPath);
      const dot = absPath.lastIndexOf('.');
      const ext = dot >= 0 ? absPath.slice(dot).toLowerCase() : '';
      const source = { localPath: realPath };
      let result;
      if (IMAGE_EXTS.has(ext)) {
        requireSenderMethod(sender, 'sendImage');
        result = await sender.sendImage(replyTarget, source);
      } else if (VIDEO_EXTS.has(ext)) {
        requireSenderMethod(sender, 'sendVideo');
        result = await sender.sendVideo(replyTarget, source);
      } else if (VOICE_EXTS.has(ext)) {
        requireSenderMethod(sender, 'sendVoice');
        result = await sender.sendVoice(replyTarget, source);
      } else {
        requireSenderMethod(sender, 'sendFile');
        result = await sender.sendFile(replyTarget, source, { fileName });
      }

      const upload = result && result.upload ? result.upload : {};
      const message = result && result.message ? result.message : {};
      const fileUuid = upload.file_uuid ? String(upload.file_uuid) : '';
      if (!fileUuid) throw new Error('qqbot_send_file: 上传未返回 file_uuid');

      log.info('qqbot_send_file 发送 ' + fileName + ' (' + info.size + ' bytes) -> '
        + replyTarget.scope + ':' + replyTarget.targetId);
      const value = {
        fileName,
        fileSize: info.size,
        target: replyTarget.scope + ':' + replyTarget.targetId,
        fileUuid,
      };
      if (message.id !== undefined) value.messageId = String(message.id);
      return value;
    },
  };

  try {
    const dispose = tools.register(definition);
    log.info('qqbot_send_file 工具已注册');
    return dispose;
  } catch (err) {
    log.warn('注册 qqbot_send_file 失败: ' + (err && err.message));
    return undefined;
  }
}