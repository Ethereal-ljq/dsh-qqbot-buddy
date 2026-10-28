/**
 * vision —— 内置工具 qqbot_describe_image：用视觉模型描述一张图片。
 *
 * 参考官方 dist/media/vision-tool.js：
 *   1. 加载图片（本地绝对路径 / http(s) URL）-> magic bytes 嗅探真实 mediaType；
 *   2. attachments.saveImage -> ImageAttachmentRef（字节不进 session log）；
 *   3. createUserMessage(ImageBlock + text) -> llm.stream -> BlockAssembler 收集文本。
 *
 * 服务/配置不可用时不注册（只 warn），绝不阻断插件启动。
 */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';

/** 工具名（qqbot 前缀避免与外部 describe-image 包冲突）。 */
export const DESCRIBE_IMAGE_TOOL_NAME = 'qqbot_describe_image';

const DESCRIPTION = 'Inspect one image and return the text the user needs. The image is a local absolute path '
  + '(downloaded by the QQ bot) or an http(s) URL. Use this when the user references an image, '
  + 'or when a task needs OCR, chart/diagram reading, screenshot or UI analysis, translation of '
  + 'image text, or photo understanding. Always pass an explicit prompt with a precise '
  + 'instruction (e.g. "transcribe all text", "extract the table as CSV", "translate the text '
  + 'into Chinese") instead of relying on the generic default.';

/** 安全获取可选服务。 */
function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/** 图片 magic bytes 嗅探 -> 标准 MIME（不信声明，安全底线）。 */
function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

/** 组合取消信号（调用方 signal + 超时），兼容不支持 AbortSignal.any 的运行时。 */
function buildSignal(signal, timeoutMs) {
  const signals = [];
  if (signal) signals.push(signal);
  if (Number(timeoutMs) > 0 && typeof AbortSignal.timeout === 'function') {
    signals.push(AbortSignal.timeout(Number(timeoutMs)));
  }
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  return signals[0];
}

/** QQ 图片 URL 允许的域名后缀白名单（阻断任意 URL 造成的 SSRF）。 */
const ALLOWED_IMAGE_HOST_SUFFIXES = [
  '.qq.com',
  '.qq.com.cn',
  '.qpic.cn',
  '.gtimg.cn',
  '.ugcimg.cn',
  '.myqcloud.com',
];

/** 校验 QQ 媒体 URL：必须 HTTPS 且域名在白名单内，否则要求改用本地路径。 */
function assertSafeImageUrl(image) {
  let url;
  try {
    url = new URL(image);
  } catch {
    throw new Error('qqbot_describe_image: 图片 URL 非法: ' + image);
  }
  if (url.protocol !== 'https:') {
    throw new Error('qqbot_describe_image: 只允许 https 图片 URL，请改用本地路径: ' + image);
  }
  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
  if (!allowed) {
    throw new Error('qqbot_describe_image: 不允许下载该域名（仅限 QQ 媒体域名），请改用本地路径: ' + host);
  }
}

/** 加载图片字节（本地路径 / http(s) URL），校验大小并嗅探 MIME。 */
async function loadImageBytes(image, maxBytes, signal, timeoutMs) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : 10 * 1024 * 1024;
  const effectiveSignal = buildSignal(signal, timeoutMs);
  let data;
  if (/^https?:\/\//i.test(image)) {
    assertSafeImageUrl(image);
    const resp = await fetch(image, { signal: effectiveSignal, redirect: 'error' });
    if (!resp.ok) throw new Error('qqbot_describe_image: 图片下载失败 (HTTP ' + resp.status + ')');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > limit) throw new Error('qqbot_describe_image: 图片超过大小上限 (' + buf.length + ' bytes)');
    data = new Uint8Array(buf);
  } else {
    const info = await stat(image).catch(() => null);
    if (!info || !info.isFile()) throw new Error('qqbot_describe_image: 图片文件不存在: ' + image);
    if (info.size > limit) throw new Error('qqbot_describe_image: 图片超过大小上限 (' + info.size + ' bytes)');
    data = new Uint8Array(await readFile(image));
  }
  const mediaType = sniffImageMediaType(data);
  if (mediaType === null) {
    throw new Error('qqbot_describe_image: 无法识别的图片格式（仅支持 png/jpeg/gif/webp）');
  }
  return { data, mediaType };
}

/** 终端 finish reason -> 错误（error/aborted 视为失败）。 */
function finishError(finish) {
  if (!finish || typeof finish !== 'object') return undefined;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return new Error((finish.failure && finish.failure.message) || '视觉模型调用失败');
  }
  return undefined;
}

/** 调视觉模型描述图片，返回纯文本。 */
async function callVision(llm, visionCfg, prompt, imageRef, signal) {
  const message = createUserMessage({
    content: [
      { type: 'image', attachment: imageRef },
      { type: 'text', text: prompt },
    ],
    source: { kind: 'plugin', plugin: 'qqbot-buddy' },
  });
  const options = {
    messages: [message],
    maxTokens: Number(visionCfg.maxTokens) > 0 ? Number(visionCfg.maxTokens) : 1024,
  };
  if (visionCfg.provider) options.provider = visionCfg.provider;
  if (visionCfg.model) options.model = visionCfg.model;
  if (signal) options.signal = signal;

  const assembler = new BlockAssembler();
  for await (const chunk of llm.stream(options)) {
    assembler.push(chunk);
  }
  const terminalError = finishError(assembler.finish);
  if (terminalError !== undefined) throw terminalError;
  const text = assembler.blocks()
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim();
  if (text.length === 0) {
    const finishKind = assembler.finish && assembler.finish.kind ? assembler.finish.kind : 'unknown';
    throw new Error('qqbot_describe_image: 视觉模型没有返回文本（finish=' + finishKind + ', maxTokens=' + options.maxTokens + '）');
  }
  return text;
}

/**
 * 注册 qqbot_describe_image 工具。
 * @param {object} args
 * @param {object} args.ctx 插件上下文
 * @param {object} args.config 部署配置（config.vision）
 * @param {object} args.logger 日志对象
 * @returns {Function|undefined} tools.register 返回的注销函数
 */
export function registerVisionTool({ ctx, config = {}, logger } = {}) {
  const log = logger || console;
  const visionCfg = config.vision && typeof config.vision === 'object' ? config.vision : {};
  if (visionCfg.enabled === false) return undefined;
  // 视觉路由：显式配置 > 宿主默认模型（agentDefaultModel）。
  // 不强制要求 config.vision.provider/model，避免配置迁移/升级时忘填导致看图工具直接消失。
  let visionProvider = typeof visionCfg.provider === 'string' ? visionCfg.provider.trim() : '';
  let visionModel = typeof visionCfg.model === 'string' ? visionCfg.model.trim() : '';
  if (!visionProvider || !visionModel) {
    try {
      const defaultModel = getService(ctx, 'agentDefaultModel');
      const selection = defaultModel && typeof defaultModel.currentSelection === 'function'
        ? defaultModel.currentSelection()
        : undefined;
      if (selection && selection.provider && selection.model) {
        if (!visionProvider) visionProvider = String(selection.provider);
        if (!visionModel) visionModel = String(selection.model);
        log.info('vision.provider/model 未显式配置，回退宿主默认模型: ' + visionProvider + '/' + visionModel);
      }
    } catch (err) {
      log.warn('读取宿主默认模型失败: ' + (err && err.message));
    }
  }
  if (!visionProvider || !visionModel) {
    log.warn('vision.provider/model 未配置且宿主默认模型不可用，qqbot_describe_image 工具未注册');
    return undefined;
  }
  const effectiveVisionCfg = Object.assign({}, visionCfg, { provider: visionProvider, model: visionModel });
  const tools = getService(ctx, 'tools');
  const llm = getService(ctx, 'llm');
  const attachments = getService(ctx, 'attachments');
  if (!tools || typeof tools.register !== 'function' || !llm || typeof llm.stream !== 'function'
    || !attachments || typeof attachments.saveImage !== 'function') {
    log.warn('tools/llm/attachments 服务不可用，qqbot_describe_image 工具未注册');
    return undefined;
  }

  // 描述缓存：同一张图 + 同一 prompt 在 30 分钟内复用，避免重复 describe 浪费 token。
  const CACHE_TTL_MS = 30 * 60 * 1000;
  const CACHE_MAX = 64;
  const cache = new Map();
  const cacheKey = (hash, prompt) => hash + ':' + prompt;
  const cacheGet = (key) => {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
    return hit.text;
  };
  const cachePut = (key, text) => {
    if (cache.size >= CACHE_MAX) { const first = cache.keys().next().value; if (first !== undefined) cache.delete(first); }
    cache.set(key, { text, at: Date.now() });
  };

  const definition = {
    name: DESCRIBE_IMAGE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: 'Absolute path to a local image file, or an http(s) URL of the image.',
        },
        prompt: {
          type: 'string',
          description: 'Your precise instruction for the vision model about this image.',
        },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          model: { type: 'string' },
          image: { type: 'string' },
          mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] },
          bytes: { type: 'integer' },
        },
        required: ['text', 'model', 'image', 'mimeType', 'bytes'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const runCtx = exec && typeof exec === 'object' ? exec : {};
      const image = args && typeof args.image === 'string' ? args.image.trim() : '';
      if (image === '') throw new Error('qqbot_describe_image: image 不能为空');
      const prompt = args && typeof args.prompt === 'string' && args.prompt.trim() !== ''
        ? args.prompt.trim()
        : (effectiveVisionCfg.defaultPrompt || '用中文详细描述这张图片的内容。');
      const loaded = await loadImageBytes(image, effectiveVisionCfg.maxBytes, runCtx.signal, effectiveVisionCfg.timeoutMs);
      const hash = createHash('sha256').update(loaded.data).digest('hex').slice(0, 24);
      const key = cacheKey(hash, prompt);
      const cached = cacheGet(key);
      if (cached !== undefined) {
        log.debug?.('qqbot_describe_image 命中缓存 (' + hash + ')');
        return { text: cached, model: effectiveVisionCfg.model, image, mimeType: loaded.mediaType, bytes: loaded.data.length };
      }
      const ref = await attachments.saveImage({
        data: loaded.data,
        mediaType: loaded.mediaType,
        name: /^https?:\/\//i.test(image) ? undefined : basename(image),
      });
      let text;
      // 首次预算兜底 4096：live 里显式配的 1024/2048 对需要推理的图（几何题、长截图）不够，
      // 会只产出 reasoning、text 为空；低配置值不再直接作为首轮预算。
      const initialCfg = {
        ...effectiveVisionCfg,
        maxTokens: Math.max(4096, Number(effectiveVisionCfg.maxTokens) || 4096),
      };
      try {
        text = await callVision(llm, initialCfg, prompt, ref, runCtx.signal);
      } catch (firstError) {
        // 视觉模型（带 reasoning）可能把小 maxTokens 全花在思考上导致没有文本
        // （复杂几何图/长截图尤其明显）：逐级提升预算重试，最多 3 次、上限 16384。
        const message = firstError && firstError.message ? String(firstError.message) : '';
        if (!/没有返回文本|max.?tokens|finish/i.test(message)) throw firstError;
        const base = initialCfg.maxTokens;
        const budgets = [...new Set([base, Math.max(base * 2, 8192), 16384])]
          .filter((value) => value > base && value <= 16384);
        let lastError = firstError;
        for (const budget of budgets) {
          try {
            log.warn?.('qqbot_describe_image 无文本，提升 maxTokens=' + budget + ' 重试');
            text = await callVision(llm, { ...effectiveVisionCfg, maxTokens: budget }, prompt, ref, runCtx.signal);
            lastError = undefined;
            break;
          } catch (retryError) {
            lastError = retryError;
            const retryMessage = retryError && retryError.message ? String(retryError.message) : '';
            if (!/没有返回文本|max.?tokens|finish/i.test(retryMessage)) throw retryError;
          }
        }
        if (lastError !== undefined) throw lastError;
      }
      cachePut(key, text);
      return {
        text,
        model: effectiveVisionCfg.model,
        image,
        mimeType: loaded.mediaType,
        bytes: loaded.data.length,
      };
    },
  };

  try {
    const dispose = tools.register(definition);
    log.info('qqbot_describe_image 工具已注册 (provider=' + effectiveVisionCfg.provider + ' model=' + effectiveVisionCfg.model + ')');
    return dispose;
  } catch (err) {
    log.warn('注册 qqbot_describe_image 失败: ' + (err && err.message));
    return undefined;
  }
}