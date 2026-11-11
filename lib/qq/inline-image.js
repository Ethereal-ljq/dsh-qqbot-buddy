/**
 * inline-image —— 把 QQ 已下载到本地的图片变成可直接投递的 ImageBlock。
 *
 * 背景：QQ 机器人原先只把图片路径写进文本（[图片] / Image: <path>），模型看不到像素，
 * 只能再调 qqbot_describe_image 转述。v4.1-flash 本身声明了 image 输入模态，
 * 所以这里在投递 followup 前把图片字节存成 durable 附件引用，作为 image block
 * 和文字一起放进同一条 UserMessage —— 模型在**同一次请求**里直接看图。
 *
 * 设计约束：
 *   1. 只做增强，绝不阻断聊天：任何失败都降级为空数组（调用方回落纯文本）。
 *   2. 只内联「当前触发消息」已经下载好的图片（下载、SSRF、大小校验都由
 *      attachment.js 中间件完成），不碰历史/引用里的旧图。
 *   3. 路由能力门控：模型没声明 image 输入时不内联（保持 describe 工具那条路），
 *      避免文本模型只拿到 "[image omitted ...]" 占位。
 *   4. 张数 / 总字节双上限：图片会留在会话历史里，每轮都随请求发送，
 *      所以默认最多 4 张、20MB，可用 settings.vision 或部署配置覆盖。
 */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * 图片魔数嗅探（移植自 v1 lib/tools/vision.js 的同名函数）。
 * 只内联明确支持的格式；未知格式返回 null，由调用方跳过。
 * @param {Uint8Array} bytes
 * @returns {string|null} image/png | image/jpeg | image/gif | image/webp
 */
export function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

/** 每轮默认最多内联几张图。 */
export const DEFAULT_MAX_IMAGES = 4;
/** 每轮图片默认总字节上限（与 pi-ai 请求侧默认内联预算同量级）。 */
export const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** 单轮张数硬上限（防御配置写错）。 */
const HARD_MAX_IMAGES = 10;

/** 安全获取可选服务（cordis 的 ctx.get 在服务缺失时可能抛错）。 */
function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** 读 settings 快照；失败按空对象（配置问题不该影响聊天）。 */
function readSnapshot(settings) {
  try {
    const value = settings && typeof settings.get === 'function' ? settings.get() : {};
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function toInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 解析内联策略（纯函数，便于单测）。
 *
 * 关闭来源（任一为真即不内联）：
 *   - settings.features.vision === false（设置页「看图片」关）
 *   - settings.vision.inlineImages === false
 *   - settings.vision.mode === 'dedicated'（独立视觉模型模式：图片不内联，
 *     改走 qqbot_describe_image 用配置档指定的更精细视觉模型阅读）
 *   - config.vision.enabled === false / config.vision.inlineImages === false（部署级覆盖）
 *
 * @param {object} args
 * @param {object} [args.settings] settings-store
 * @param {object} [args.config] 部署配置（config.vision）
 * @returns {{enabled:boolean, maxImages:number, maxTotalBytes:number}}
 */
export function resolveInlinePolicy({ settings, config } = {}) {
  const snapshot = readSnapshot(settings);
  const features = snapshot.features && typeof snapshot.features === 'object' ? snapshot.features : {};
  const vision = snapshot.vision && typeof snapshot.vision === 'object' ? snapshot.vision : {};
  const deploy = config && typeof config.vision === 'object' && config.vision ? config.vision : {};

  // 「独立视觉模型」模式与内联不可共存：内联用的是 LLM 自身视觉，而该模式明确要
  // 换更精细的独立模型（图片仍以路径进文本，模型用 qqbot_describe_image 阅读）。
  const dedicatedMode = vision.mode === 'dedicated';
  const enabled = deploy.enabled !== false
    && deploy.inlineImages !== false
    && features.vision !== false
    && vision.inlineImages !== false
    && !dedicatedMode;

  return {
    enabled: enabled,
    maxImages: toInt(
      deploy.inlineMaxImages !== undefined ? deploy.inlineMaxImages : vision.inlineMaxImages,
      1,
      HARD_MAX_IMAGES,
      DEFAULT_MAX_IMAGES,
    ),
    maxTotalBytes: toInt(
      deploy.inlineMaxBytes !== undefined ? deploy.inlineMaxBytes : vision.inlineMaxBytes,
      1024 * 1024,
      200 * 1024 * 1024,
      DEFAULT_MAX_TOTAL_BYTES,
    ),
  };
}

/**
 * 解析本轮实际生效的模型路由：优先会话已经落盘的 request header（与真正发请求的
 * 路由一致），其次 SessionManager 的设置解析，最后放弃（不内联）。
 * @param {object} manager SessionManager
 * @param {object} record 会话记录（含 agent）
 * @returns {{provider:string, model:string}|undefined}
 */
function resolveRoute(manager, record) {
  try {
    const session = record && record.agent && record.agent.session;
    const header = session && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
    const cfg = header && header.config;
    if (cfg && typeof cfg.provider === 'string' && cfg.provider !== ''
      && typeof cfg.model === 'string' && cfg.model !== '') {
      return { provider: cfg.provider, model: cfg.model };
    }
  } catch {
    /* 旧会话/异常：走下面的设置解析 */
  }
  try {
    // v2 适配器按 record 解析（profile/作用域绑定后的 model.provider/model.model）
    const resolved = manager && typeof manager.resolveModelRouteFor === 'function'
      ? manager.resolveModelRouteFor(record)
      : (manager && typeof manager.resolveModelRoute === 'function' ? manager.resolveModelRoute() : undefined);
    const route = resolved && resolved.route;
    if (route && typeof route.provider === 'string' && route.provider !== ''
      && typeof route.model === 'string' && route.model !== '') {
      return { provider: route.provider, model: route.model };
    }
  } catch {
    /* 读取设置失败：按未知路由处理 */
  }
  return undefined;
}

/**
 * v2 默认 UserMessage 工厂：协议层不 import @deepseek-ai/*（依赖方向约束）。
 * 生产路径由 gateway.deliver 交给 BotRuntime.followup 构造真正的 UserMessage；
 * 这里的兜底只服务「未注入 deliver」的测试/旧装配，因此保持最小结构即可。
 */
function defaultMakeUserMessage(input) {
  const value = input && typeof input === 'object' ? input : {};
  return { content: Array.isArray(value.content) ? value.content : [], source: value.source };
}

/** 单个文件读成 Uint8Array（不是普通文件/读失败返回 undefined）。 */
async function readImageFile(localPath, byteCap) {
  try {
    const info = await stat(localPath);
    if (!info.isFile() || info.size <= 0 || info.size > byteCap) return undefined;
    const data = new Uint8Array(await readFile(localPath));
    return data.length > 0 ? data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把已下载的 QQ 图片转成 ImageBlock[]。
 *
 * 返回空数组表示「本次不内联」：调用方按纯文本消息继续投递，模型仍可用
 * read_image / qqbot_describe_image 取图。
 *
 * @param {object} args
 * @param {Array<{contentType?:string, localPath?:string}>} [args.downloaded] 中间件下载结果
 * @param {object} [args.manager] SessionManager（取 attachments/llm 与路由）
 * @param {object} [args.record] 会话记录
 * @param {object} [args.settings] settings-store
 * @param {object} [args.config] 部署配置
 * @param {object} [args.logger] 日志对象
 * @param {number} [args.maxImages] 覆盖策略里的张数上限
 * @param {number} [args.maxTotalBytes] 覆盖策略里的总字节上限
 * @returns {Promise<Array<{type:'image', attachment:object}>>}
 */
export async function buildInlineImageBlocks({
  downloaded,
  manager,
  record,
  settings,
  config,
  logger,
  maxImages,
  maxTotalBytes,
} = {}) {
  const log = logger || console;
  try {
    const policy = resolveInlinePolicy({ settings, config });
    if (!policy.enabled) return [];

    const files = (Array.isArray(downloaded) ? downloaded : []).filter(
      (file) => file && file.contentType === 'image' && typeof file.localPath === 'string' && file.localPath !== '',
    );
    if (files.length === 0) return [];

    const ctx = manager && manager.ctx;
    const attachments = getService(ctx, 'attachments');
    const llm = getService(ctx, 'llm');
    if (!attachments || typeof attachments.saveImage !== 'function') {
      log.warn?.('inline-image: attachments 服务不可用，跳过内联');
      return [];
    }

    // 路由能力门控：模型声明了 image 输入才内联；未知路由按不内联处理。
    const route = resolveRoute(manager, record);
    if (!route) {
      log.debug?.('inline-image: 无法解析模型路由，跳过内联');
      return [];
    }
    if (!llm || typeof llm.resolveModelInfo !== 'function') {
      log.warn?.('inline-image: llm 服务不可用，跳过内联');
      return [];
    }
    const info = await llm.resolveModelInfo(route.provider, route.model);
    const modalities = info && Array.isArray(info.inputModalities) ? info.inputModalities : undefined;
    if (modalities !== undefined && !modalities.includes('image')) {
      log.debug?.('inline-image: 模型 ' + route.model + ' 不支持图片输入，保留路径 + 转述方案');
      return [];
    }

    const limitImages = toInt(
      maxImages !== undefined ? maxImages : policy.maxImages,
      1,
      HARD_MAX_IMAGES,
      DEFAULT_MAX_IMAGES,
    );
    const limitBytes = toInt(
      maxTotalBytes !== undefined ? maxTotalBytes : policy.maxTotalBytes,
      1024 * 1024,
      200 * 1024 * 1024,
      DEFAULT_MAX_TOTAL_BYTES,
    );
    const mediaTypes = attachments.imageLimits && Array.isArray(attachments.imageLimits.mediaTypes)
      ? attachments.imageLimits.mediaTypes
      : undefined;

    const blocks = [];
    let total = 0;
    for (const file of files) {
      if (blocks.length >= limitImages || total >= limitBytes) break;
      const data = await readImageFile(file.localPath, limitBytes - total);
      if (!data) continue;
      const mediaType = sniffImageMediaType(data);
      if (mediaType === null) continue;
      if (mediaTypes !== undefined && !mediaTypes.includes(mediaType)) continue;
      try {
        const ref = await attachments.saveImage({
          data: data,
          mediaType: mediaType,
          name: typeof file.filename === 'string' && file.filename !== '' ? file.filename : basename(file.localPath),
        });
        if (!ref) continue;
        blocks.push({ type: 'image', attachment: ref });
        total += data.length;
      } catch (err) {
        // 单张失败不影响其它图，也不影响聊天：继续用剩下的。
        log.warn?.('inline-image: 保存图片附件失败，跳过该图: ' + (err && err.message ? err.message : String(err)));
      }
    }
    if (blocks.length > 0) {
      log.debug?.('inline-image: 已内联 ' + blocks.length + ' 张图（route=' + route.provider + '/' + route.model + '）');
    }
    return blocks;
  } catch (err) {
    log.warn?.('inline-image: 内联失败，降级为路径文本: ' + (err && err.message ? err.message : String(err)));
    return [];
  }
}

/**
 * 带图投递 + 纯文本兜底（旧方案的最后一道保险）。
 *
 * 正常把 [text, ...imageBlocks] 投给 agent；若**带图**消息被宿主拒绝
 * （附件在投递瞬间失效、会话被释放等），自动改用「纯文本 + 路径」再投一次，
 * 保证消息本身不会因为图片而丢掉（图仍可用 read_image / qqbot_describe_image 读取）。
 * 纯文本也失败时把错误抛给调用方，由它决定是否给用户发失败提示。
 *
 * @param {object} args
 * @param {object} args.agent agent（需有 followup）
 * @param {string} args.body 组装好的纯文本正文（含 Image: 路径行）
 * @param {Array} [args.imageBlocks] buildInlineImageBlocks 的返回值
 * @param {Function} [args.makeUserMessage] UserMessage 工厂（测试可注入）
 * @param {object} [args.logger] 日志对象
 * @returns {Promise<{delivered:true, degraded:boolean}>}
 */
export async function followupWithImageFallback({
  agent, body, imageBlocks, makeUserMessage = defaultMakeUserMessage, logger,
} = {}) {
  if (!agent || typeof agent.followup !== 'function') {
    throw new Error('followupWithImageFallback: agent.followup 不可用');
  }
  const text = typeof body === 'string' ? body : '';
  const extra = Array.isArray(imageBlocks) ? imageBlocks : [];
  const content = extra.length > 0
    ? [{ type: 'text', text: text }, ...extra]
    : [{ type: 'text', text: text }];
  try {
    await agent.followup(makeUserMessage({ content, source: { kind: 'user' } }));
    return { delivered: true, degraded: false };
  } catch (err) {
    if (extra.length === 0) throw err;
    logger?.warn?.('带图投递失败，降级为纯文本重投: ' + (err && err.message ? err.message : String(err)));
    await agent.followup(makeUserMessage({ content: [{ type: 'text', text: text }], source: { kind: 'user' } }));
    return { delivered: true, degraded: true };
  }
}
