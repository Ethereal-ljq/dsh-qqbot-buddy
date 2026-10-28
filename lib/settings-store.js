/**
 * settings-store —— 运行期配置（JSON 落盘，热生效）。
 *
 * 设计要点：
 * - 只接受已知字段，未知字段丢弃；类型/范围不合法的值被截断或回退默认；
 * - patch() 做深合并 → 归一化 → 与旧值比较 → 有变化才原子落盘并通知订阅者；
 * - get() 返回深拷贝，调用方随意读不会破坏内部状态；
 * - 文件损坏时备份为 .corrupt-<ts> 并回退默认值，绝不抛错打挂插件。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_SELF_IMPROVE_PROMPT } from './self-improve.js';

/** 所有默认值；由插件入口用 resolveDefaults({cwd}) 生成后传入。 */
export function resolveDefaults({ cwd } = {}) {
  const base = cwd && String(cwd).trim() ? path.resolve(String(cwd)) : process.cwd();
  return {
    version: 1,
    reply: {
      enabled: true,
      groupEnabled: true,
      groupMode: 'count',           // all | count | interval | probability | adaptive
      adaptive: {
        debounceSeconds: 4,
        cooldownSeconds: 12,
        maxWaitSeconds: 20,
        requireRelevance: true,
      },
      countThreshold: 3,
      flushAfterSeconds: 120,
      intervalSeconds: 90,
      probability: 0.25,
      minGapSeconds: 0,
      c2cEnabled: true,
      // 气泡拆分：auto=空行自动拆 / marker=只认 [[msg]] / off=永不拆
      bubbleSplit: 'auto',
    },
    triggers: {
      onMention: true,
      onReplyToBot: true,
      keywords: [],
    },
    agent: {
      preset: '',
    },
    features: {
      workspace: true,
      web: true,
      stickers: true,
      vision: true,
      memory: true,
    },
    model: {
      provider: '',
      model: '',
      reasoningEffort: '',
    },
    persona: {
      path: path.join(base, 'persona.md'),
      mode: 'replace',
      suppressRuntimeContext: true,
      groupExtraPrompt: '',
      directExtraPrompt: '',
    },
    stickers: {
      dir: path.join(base, 'stickers'),
      collectEnabled: true,
      maxMB: 8,
      dailyLimit: 10,
    },
    memory: {
      enabled: true,
      dir: path.join(base, 'memory'),
      injectMaxChars: 4000,
      // 自我改进提示（独立于人设）；留空则用内置默认
      selfImprovePrompt: DEFAULT_SELF_IMPROVE_PROMPT,
      // 自动记忆提炼 prompt 覆盖；留空用内置默认
      collectorPrompt: '',
      autoCollect: {
        enabled: true,
        everyRounds: 6,
        maxFacts: 5,
        maxFactChars: 400,
        provider: '',
        model: '',
      },
    },
    phrases: {
      enabled: true,
      // [{text, note, enabled}]，管理 bot 从对话里学到的口头禅
      items: [],
    },
    behavior: {
      extraInstructions: '',
    },
    // 额外放行的工具名（skill / mcp_* / 第三方插件工具）；默认空 = 只放行插件内置工具
    tools: {
      extraAllowed: [],
    },
    // 功能性提示词（与人设分开）：四段各自可开关、可编辑；text 空 = 内置默认
    prompts: {
      toolGuide: { enabled: true, text: '' },
      sendGuide: { enabled: true, text: '' },
      rhythmGuide: { enabled: true, text: '' },
      stickerGuide: { enabled: true, text: '' },
    },
    admin: {
      enabled: false,
      // QQ openid（推荐，稳定）/ 昵称（易变，仅兜底）
      openids: [],
      names: [],
    },
  };
}

// ── 基础校验工具 ──────────────────────────────────────────────
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v, def) => (typeof v === 'boolean' ? v : def);
const int = (v, min, max, def) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const num = (v, min, max, def) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const enumStr = (v, values, def) => (typeof v === 'string' && values.includes(v) ? v : def);
const text = (v, def, maxLen) => {
  if (typeof v !== 'string') return def;
  const s = v.replace(/\r\n/g, '\n');
  return s.length > maxLen ? s.slice(0, maxLen) : s;
};
const absPath = (v, def) => {
  if (typeof v !== 'string' || v.trim() === '' || v.includes('\0')) return def;
  const s = v.trim();
  return path.isAbsolute(s) ? s : def;
};
const strArray = (v, { maxItems, maxLen }) => {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s === '' || s.length > maxLen) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
};

/** adaptive 模式参数归一化（缺省回落默认；越界截断）。 */
function normalizeAdaptive(input, defaults) {
  const src = isObj(input) ? input : {};
  const d = defaults;
  return {
    debounceSeconds: int(src.debounceSeconds, 0, 30, d.debounceSeconds),
    cooldownSeconds: int(src.cooldownSeconds, 0, 600, d.cooldownSeconds),
    maxWaitSeconds: int(src.maxWaitSeconds, 2, 300, d.maxWaitSeconds),
    requireRelevance: bool(src.requireRelevance, d.requireRelevance),
  };
}

// ── 归一化 ────────────────────────────────────────────────────
function normalizeSettings(input, defaults) {
  const src = isObj(input) ? input : {};
  const d = defaults;

  const replySrc = isObj(src.reply) ? src.reply : {};
  const reply = {
    enabled: bool(replySrc.enabled, d.reply.enabled),
    groupEnabled: bool(replySrc.groupEnabled, d.reply.groupEnabled),
    groupMode: enumStr(replySrc.groupMode, ['all', 'count', 'interval', 'probability', 'adaptive'], d.reply.groupMode),
    countThreshold: int(replySrc.countThreshold, 1, 200, d.reply.countThreshold),
    flushAfterSeconds: int(replySrc.flushAfterSeconds, 0, 86400, d.reply.flushAfterSeconds),
    intervalSeconds: int(replySrc.intervalSeconds, 5, 86400, d.reply.intervalSeconds),
    probability: num(replySrc.probability, 0, 1, d.reply.probability),
    adaptive: normalizeAdaptive(replySrc.adaptive, d.reply.adaptive),
    minGapSeconds: int(replySrc.minGapSeconds, 0, 3600, d.reply.minGapSeconds),
    c2cEnabled: bool(replySrc.c2cEnabled, d.reply.c2cEnabled),
    bubbleSplit: enumStr(replySrc.bubbleSplit, ['auto', 'marker', 'off'], d.reply.bubbleSplit),
  };

  const trigSrc = isObj(src.triggers) ? src.triggers : {};
  const triggers = {
    onMention: bool(trigSrc.onMention, d.triggers.onMention),
    onReplyToBot: bool(trigSrc.onReplyToBot, d.triggers.onReplyToBot),
    keywords: trigSrc.keywords === undefined
      ? [...d.triggers.keywords]
      : strArray(trigSrc.keywords, { maxItems: 50, maxLen: 40 }),
  };

  const agentSrc = isObj(src.agent) ? src.agent : {};
  const agent = {
    preset: text(agentSrc.preset, d.agent.preset, 120).trim(),
  };

  const fSrc = isObj(src.features) ? src.features : {};
  const features = {
    workspace: bool(fSrc.workspace, d.features.workspace),
    web: bool(fSrc.web, d.features.web),
    stickers: bool(fSrc.stickers, d.features.stickers),
    vision: bool(fSrc.vision, d.features.vision),
    memory: bool(fSrc.memory, d.features.memory),
  };

  const modelSrc = isObj(src.model) ? src.model : {};
  const model = {
    provider: text(modelSrc.provider, d.model.provider, 200).trim(),
    model: text(modelSrc.model, d.model.model, 300).trim(),
    reasoningEffort: text(modelSrc.reasoningEffort, d.model.reasoningEffort, 32).trim(),
  };

  const pSrc = isObj(src.persona) ? src.persona : {};
  const persona = {
    path: absPath(pSrc.path, d.persona.path),
    mode: enumStr(pSrc.mode, ['replace', 'append'], d.persona.mode),
    suppressRuntimeContext: bool(pSrc.suppressRuntimeContext, d.persona.suppressRuntimeContext),
    groupExtraPrompt: text(pSrc.groupExtraPrompt, d.persona.groupExtraPrompt, 4000),
    directExtraPrompt: text(pSrc.directExtraPrompt, d.persona.directExtraPrompt, 4000),
  };

  const stSrc = isObj(src.stickers) ? src.stickers : {};
  const stickers = {
    dir: absPath(stSrc.dir, d.stickers.dir),
    collectEnabled: bool(stSrc.collectEnabled, d.stickers.collectEnabled),
    maxMB: int(stSrc.maxMB, 1, 50, d.stickers.maxMB),
    dailyLimit: int(stSrc.dailyLimit, 1, 100, d.stickers.dailyLimit),
  };

  const mSrc = isObj(src.memory) ? src.memory : {};
  const autoSrc = isObj(mSrc.autoCollect) ? mSrc.autoCollect : {};
  const memory = {
    enabled: bool(mSrc.enabled, d.memory.enabled),
    dir: absPath(mSrc.dir, d.memory.dir),
    injectMaxChars: int(mSrc.injectMaxChars, 0, 20000, d.memory.injectMaxChars),
    selfImprovePrompt: text(mSrc.selfImprovePrompt, d.memory.selfImprovePrompt, 8000),
    collectorPrompt: text(mSrc.collectorPrompt, d.memory.collectorPrompt, 8000),
    autoCollect: {
      enabled: bool(autoSrc.enabled, d.memory.autoCollect.enabled),
      everyRounds: int(autoSrc.everyRounds, 1, 100, d.memory.autoCollect.everyRounds),
      maxFacts: int(autoSrc.maxFacts, 1, 20, d.memory.autoCollect.maxFacts),
      maxFactChars: int(autoSrc.maxFactChars, 50, 2000, d.memory.autoCollect.maxFactChars),
      provider: text(autoSrc.provider, d.memory.autoCollect.provider, 100).trim(),
      model: text(autoSrc.model, d.memory.autoCollect.model, 200).trim(),
    },
  };

  const phSrc = isObj(src.phrases) ? src.phrases : {};
  const seenPhrases = new Set();
  const phrases = {
    enabled: bool(phSrc.enabled, d.phrases.enabled),
    items: (Array.isArray(phSrc.items) ? phSrc.items : [])
      .slice(0, 40)
      .map((item) => {
        const srcItem = isObj(item) ? item : {};
        const textValue = text(srcItem.text, '', 80).trim();
        return {
          text: textValue,
          note: text(srcItem.note, '', 300).trim(),
          enabled: bool(srcItem.enabled, true),
        };
      })
      .filter((item) => {
        if (item.text === '') return false;
        const key = item.text.toLowerCase();
        if (seenPhrases.has(key)) return false;
        seenPhrases.add(key);
        return true;
      }),
  };

  const bSrc = isObj(src.behavior) ? src.behavior : {};
  const behavior = {
    extraInstructions: text(bSrc.extraInstructions, d.behavior.extraInstructions, 8000),
  };

  const toolsSrc = isObj(src.tools) ? src.tools : {};
  const toolsCfg = {
    extraAllowed: strArray(toolsSrc.extraAllowed, { maxItems: 50, maxLen: 80 }),
  };

  const promptSrc = isObj(src.prompts) ? src.prompts : {};
  const normalizeGuide = (key) => {
    const entry = isObj(promptSrc[key]) ? promptSrc[key] : {};
    return {
      enabled: bool(entry.enabled, d.prompts[key].enabled),
      text: text(entry.text, d.prompts[key].text, 8000),
    };
  };
  const prompts = {
    toolGuide: normalizeGuide('toolGuide'),
    sendGuide: normalizeGuide('sendGuide'),
    rhythmGuide: normalizeGuide('rhythmGuide'),
    stickerGuide: normalizeGuide('stickerGuide'),
  };

  const aSrc = isObj(src.admin) ? src.admin : {};
  const admin = {
    enabled: bool(aSrc.enabled, d.admin.enabled),
    openids: strArray(aSrc.openids, { maxItems: 100, maxLen: 100 }),
    names: strArray(aSrc.names, { maxItems: 50, maxLen: 40 }),
  };

  return { version: 1, reply, triggers, agent, features, model, persona, stickers, memory, phrases, behavior, prompts, admin, tools: toolsCfg };
}

/** 深合并（数组/标量直接覆盖，对象递归）。 */
function deepMerge(base, patch) {
  if (!isObj(patch)) return patch;
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** 展开叶子路径用于变更检测。 */
function flatten(value, prefix = '', out = {}) {
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? prefix + '.' + k : k, out);
  } else {
    out[prefix] = JSON.stringify(value);
  }
  return out;
}

function diffPaths(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const key of keys) if (a[key] !== b[key]) changed.push(key);
  return changed.sort();
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * @param {{file:string, defaults:object, logger?:object}} options
 */
export function createSettingsStore({ file, defaults, logger }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new Error('settings-store: file 必须是绝对路径');
  }
  const log = logger ?? console;
  const listeners = new Set();
  let current = load();
  let writeChain = Promise.resolve();

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') log.warn?.('读取 settings.json 失败，使用默认值:', err.message);
      return clone(defaults);
    }
    try {
      return normalizeSettings(JSON.parse(raw), defaults);
    } catch (err) {
      try {
        const corrupt = file + '.corrupt-' + Date.now();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.renameSync(file, corrupt);
        log.warn?.('settings.json 损坏，已备份到 ' + corrupt + '，使用默认值:', err.message);
      } catch {
        /* ignore */
      }
      return clone(defaults);
    }
  }

  function persist(next) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function commit(next) {
    const changed = diffPaths(current, next);
    if (changed.length === 0) return Promise.resolve({ settings: clone(current), changed });
    current = next;
    const snapshot = clone(next);
    writeChain = writeChain
      .catch(() => undefined)
      .then(() => {
        try {
          persist(snapshot);
        } catch (err) {
          log.error?.('写入 settings.json 失败:', err.message);
        }
      });
    for (const fn of listeners) {
      try {
        fn(clone(next));
      } catch (err) {
        log.warn?.('settings 订阅者异常:', err && err.message);
      }
    }
    return writeChain.then(() => ({ settings: clone(next), changed }));
  }

  return {
    get file() { return file; },
    get defaults() { return clone(defaults); },
    get() { return clone(current); },
    patch(partial) {
      const merged = deepMerge(current, isObj(partial) ? partial : {});
      return commit(normalizeSettings(merged, defaults));
    },
    replace(next) {
      return commit(normalizeSettings(isObj(next) ? next : {}, defaults));
    },
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** 仅做归一化/校验，不落盘（导入配置时用）。 */
    validate(input) {
      return normalizeSettings(input, defaults);
    },
  };
}