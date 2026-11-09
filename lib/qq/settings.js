/**
 * settings —— v2 设置（SQLite + schema）到 v1 协议层设置形状的适配器。
 *
 * 为什么需要：lib/qq 下的 gate/adaptive/commands/outbound/sender 是从 v0.22 移植的，
 * 它们读的是 v1 settings.json 的形状（reply.groupMode / reply.countThreshold /
 * triggers.onMention / reply.bubbleSplit ...）。v2 把设置重写成了 core/config/schema.js
 * 的扁平 key（reply.mode / reply.debounceMs / reply.mentionAlways ...）。
 *
 * 本模块是唯一翻译层：协议模块只认 v1 形状，v2 形状只在这里出现。
 *  - toProtocolSettings(settings)：纯函数，v2 设置对象 -> v1 设置对象（可单测）；
 *  - createSettingsView({ botRuntime })：按 peer 现读设置（热更新立即生效）。
 *
 * 映射说明（v2 -> v1）：
 *   reply.mode always/mention/probability/interval/adaptive
 *     -> reply.groupMode all/mention/probability/interval/adaptive
 *        mention 用 count + 极大阈值实现「非 @/引用/关键词一律不回」；
 *   reply.debounceMs/cooldownMs/maxWaitMs -> reply.adaptive.{debounce,cooldown,maxWait}Seconds
 *   reply.intervalMs -> reply.intervalSeconds
 *   reply.mentionAlways/quoteAlways/keywordsAlways/keywords -> triggers.*
 *   reply.splitBubbles/maxBubbles -> reply.bubbleSplit('auto'|'off')/reply.maxBubbles
 *   admin.enabled/openids -> admin.enabled/openids
 *   vision.inlineImages/... -> vision.*（inline-image.js 直接读）
 */

/** v2 回复模式 -> v1 groupMode。 */
const MODE_TO_GROUP_MODE = {
  always: 'all',
  mention: 'mention',
  probability: 'probability',
  interval: 'interval',
  adaptive: 'adaptive',
};

/** mention 模式下 count 阈值的「无穷大」；v1 gate 的 count 分支永远不会达到。 */
const MENTION_ONLY_THRESHOLD = 1_000_000_000;

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * v2 设置对象 -> v1 协议层设置对象（纯函数）。
 * 输入缺失/非对象时按 v2 默认值构造，保证协议层永远拿到完整形状。
 * @param {object} input v2 getEffectiveSettings 的返回值
 * @returns {object} v1 形状设置
 */
export function toProtocolSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  const reply = src.reply && typeof src.reply === 'object' ? src.reply : {};
  const admin = src.admin && typeof src.admin === 'object' ? src.admin : {};
  const vision = src.vision && typeof src.vision === 'object' ? src.vision : {};
  const stickers = src.stickers && typeof src.stickers === 'object' ? src.stickers : {};

  const mode = typeof reply.mode === 'string' ? reply.mode : 'adaptive';
  const groupMode = MODE_TO_GROUP_MODE[mode] || 'adaptive';
  const keywords = Array.isArray(reply.keywords) ? reply.keywords.filter((item) => typeof item === 'string' && item.trim() !== '') : [];

  const protocolReply = {
    enabled: toBool(reply.enabled, true),
    // 私聊默认必回（v1 语义；v2 没有单独开关）
    c2cEnabled: true,
    groupEnabled: true,
    groupMode: groupMode,
    probability: typeof reply.probability === 'number' ? reply.probability : 0.3,
    minGapSeconds: 0,
    // count 模式（v1 默认）在 v2 只用于 mention：阈值无穷大，不靠累计触发
    countThreshold: groupMode === 'mention' ? MENTION_ONLY_THRESHOLD : 3,
    flushAfterSeconds: 0,
    intervalSeconds: Math.max(0, Math.round(toInt(reply.intervalMs, 60000) / 1000)),
    adaptive: {
      debounceSeconds: Math.max(0, Math.round(toInt(reply.debounceMs, 1500) / 1000)),
      cooldownSeconds: Math.max(0, Math.round(toInt(reply.cooldownMs, 8000) / 1000)),
      maxWaitSeconds: Math.max(0, Math.round(toInt(reply.maxWaitMs, 12000) / 1000)),
      requireRelevance: true,
    },
    // 气泡拆分：v2 是布尔开关 + 上限条数
    bubbleSplit: toBool(reply.splitBubbles, true) ? 'auto' : 'off',
    maxBubbles: toInt(reply.maxBubbles, 4),
    proactiveFallback: true,
  };

  return {
    version: 2,
    reply: protocolReply,
    triggers: {
      onMention: toBool(reply.mentionAlways, true),
      onReplyToBot: toBool(reply.quoteAlways, true),
      keywords: toBool(reply.keywordsAlways, true) ? keywords : [],
    },
    admin: {
      enabled: admin.enabled === true,
      openids: Array.isArray(admin.openids) ? admin.openids.filter((item) => typeof item === 'string' && item.trim() !== '') : [],
      names: [],
    },
    vision: {
      inlineImages: toBool(vision.inlineImages, true),
      inlineMaxImages: toInt(vision.inlineMaxImages, 4),
      inlineMaxBytes: toInt(vision.inlineMaxBytes, 20 * 1024 * 1024),
    },
    stickers: {
      enabled: toBool(stickers.enabled, true),
      dailyQuota: toInt(stickers.dailyQuota, 30),
    },
    persona: src.persona && typeof src.persona === 'object' ? src.persona : {},
    model: src.model && typeof src.model === 'object' ? src.model : {},
    memory: src.memory && typeof src.memory === 'object' ? src.memory : {},
    // v2 暂无 welcome / interaction 设置：留空 = 欢迎语默认关闭、互动默认投喂
    // TODO(v2): 若控制台新增欢迎语/互动开关，在这里补映射。
  };
}

/**
 * 按 peer 现读设置的视图（settingsFor 热更新立即生效）。
 * @param {{botRuntime: {settingsFor:Function}}} args
 * @returns {{forPeer:(peer:string)=>object, get:()=>object}}
 */
export function createSettingsView({ botRuntime } = {}) {
  function read(peer) {
    try {
      const raw = botRuntime && typeof botRuntime.settingsFor === 'function' ? botRuntime.settingsFor(peer) : {};
      return toProtocolSettings(raw);
    } catch {
      return toProtocolSettings({});
    }
  }
  return {
    /** 指定 peer 的生效设置（v1 形状）。 */
    forPeer(peer) { return read(peer); },
    /** 兼容 v1 的 settings.get()：bot 级默认（无作用域绑定）设置。 */
    get() { return read(''); },
    /** 生成一个「固定 peer」的 settings 壳，供只认 get() 的旧模块（inline-image 等）使用。 */
    forPeerAsStore(peer) {
      return { get: () => read(peer), forPeer: () => read(peer) };
    },
  };
}

export default createSettingsView;
