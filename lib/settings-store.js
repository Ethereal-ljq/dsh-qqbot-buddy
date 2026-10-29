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
import { STICKER_FREQUENCY_LEVELS } from './prompt-guides.js';

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
      // 主动发表情包的节奏：只影响【表情包】提示段里的频率指引，不拦截工具调用
      frequency: 'normal',
    },
    memory: {
      enabled: true,
      dir: path.join(base, 'memory'),
      injectMaxChars: 4000,
      // 自我改进提示（独立于人设）；留空则用内置默认
      selfImprovePrompt: DEFAULT_SELF_IMPROVE_PROMPT,
      // 自动记忆提炼 prompt 覆盖；留空用内置默认
      collectorPrompt: '',
      // 每轮相关性召回：按当前消息只挑相关记忆注入（“必要时涌现”）
      recall: {
        enabled: true,
        maxItems: 6,
        maxChars: 1200,
        recencyHalfLifeDays: 30,
        importanceWeight: 2,
        minScore: 0.15,
      },
      autoCollect: {
        enabled: true,
        everyRounds: 6,
        maxFacts: 5,
        maxFactChars: 400,
        provider: '',
        model: '',
      },
    },
    // 知识库（条目 = 标题 + 正文 + 标签 + 作用域；按机器人隔离）
    knowledge: {
      enabled: true,
      dir: path.join(base, 'knowledge'),
      injectMaxChars: 2500,
      maxPerTurn: 4,
      // 自动提炼（阶段一：只提炼知识库；默认关闭，需在设置页显式开启）
      autoExtract: {
        enabled: false,
        everyRounds: 6,
        maxEntries: 3,
        minConfidence: 0.8,
        provider: '',
        model: '',
      },
    },
    // 群友库（复用条目实现；按群记录成员画像）
    members: {
      enabled: true,
      dir: path.join(base, 'members'),
      autoRecord: true,
      injectSender: true,
      maxPerTurn: 3,
      maxChars: 800,
    },
    phrases: {
      enabled: true,
      // [{text, note, enabled}]，管理 bot 从对话里学到的口头禅
      items: [],
    },
    behavior: {
      extraInstructions: '',
    },
    // 能力边界（唯一真相在 lib/tools/catalog.js；这里只存用户选择）
    // 未列出的能力按 catalog 的 defaultEnabled 走。
    tools: {
      // 新能力开关（旧的 workspace/web/memory/stickers/vision 仍存在 features，见下）
      // 未列出的按 catalog 的 defaultEnabled 走。
      capabilities: {
        skills: false,
        imagegen: false,
        shell: false,
      },
      // 用户新增/覆盖的能力条目：{ [id]: { label?, tools?: string[], enabled?: bool, boundary? } }
      // 内置能力的 id 写在这里是「覆盖」，新 id 写在这里是「新增能力」。
      capabilityEntries: {},
      // 「暂时删除」的内置能力 id（可恢复，不丢定义）
      removedCapabilities: [],
      // 额外显式放行的工具名（MCP / 第三方插件工具）；默认空 = 只放行能力清单里的工具
      extraAllowed: [],
      // 技能策略：mode=all 全部可见；mode=allow 只允许 allowed 列表
      skills: {
        mode: 'allow',
        allowed: ['bili-get'],
      },
    },
    // 功能性提示词（与人设分开）：四段各自可开关、可编辑；text 空 = 内置默认
    prompts: {
      toolGuide: { enabled: true, text: '' },
      sendGuide: { enabled: true, text: '' },
      rhythmGuide: { enabled: true, text: '' },
      stickerGuide: { enabled: true, text: '' },
      // 分段覆盖：{ [sectionId]: { enabled, text } }
      // 每个提示段都能独立开关/独立存储文本，最终按重要性统一拼装。
      sections: {},
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

function normalizeKnowledgeAutoExtract(input, defaults) {
  const d = defaults && typeof defaults === 'object' ? defaults : { enabled: false, everyRounds: 6, maxEntries: 3, minConfidence: 0.8, provider: '', model: '' };
  if (input === true) return { ...d, enabled: true };
  const src = isObj(input) ? input : {};
  return {
    enabled: bool(src.enabled, d.enabled),
    everyRounds: int(src.everyRounds, 1, 100, d.everyRounds),
    maxEntries: int(src.maxEntries, 1, 10, d.maxEntries),
    minConfidence: num(src.minConfidence, 0, 1, d.minConfidence),
    provider: text(src.provider, d.provider, 100).trim(),
    model: text(src.model, d.model, 200).trim(),
  };
}

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
    frequency: enumStr(stSrc.frequency, STICKER_FREQUENCY_LEVELS, d.stickers.frequency),
  };

  const mSrc = isObj(src.memory) ? src.memory : {};
  const autoSrc = isObj(mSrc.autoCollect) ? mSrc.autoCollect : {};
  const recallSrc = isObj(mSrc.recall) ? mSrc.recall : {};
  const recallD = d.memory.recall;
  const memory = {
    enabled: bool(mSrc.enabled, d.memory.enabled),
    dir: absPath(mSrc.dir, d.memory.dir),
    injectMaxChars: int(mSrc.injectMaxChars, 0, 20000, d.memory.injectMaxChars),
    selfImprovePrompt: text(mSrc.selfImprovePrompt, d.memory.selfImprovePrompt, 8000),
    collectorPrompt: text(mSrc.collectorPrompt, d.memory.collectorPrompt, 8000),
    recall: {
      enabled: bool(recallSrc.enabled, recallD.enabled),
      maxItems: int(recallSrc.maxItems, 1, 30, recallD.maxItems),
      maxChars: int(recallSrc.maxChars, 100, 10000, recallD.maxChars),
      recencyHalfLifeDays: num(recallSrc.recencyHalfLifeDays, 0.5, 3650, recallD.recencyHalfLifeDays),
      importanceWeight: num(recallSrc.importanceWeight, 0, 10, recallD.importanceWeight),
      minScore: num(recallSrc.minScore, 0, 1, recallD.minScore),
    },
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
  const capSrc = isObj(toolsSrc.capabilities) ? toolsSrc.capabilities : {};
  const legacyExtra = strArray(toolsSrc.extraAllowed, { maxItems: 50, maxLen: 80 });
  const capabilities = {};
  // 只持久化非 legacy 的新能力；workspace/web/memory/stickers/vision 的唯一真相仍是 features，
  // 避免同一开关存两份、changed 路径重复。
  for (const key of ['skills', 'imagegen', 'shell']) {
    const raw = capSrc[key];
    capabilities[key] = typeof raw === 'boolean' ? raw : d.tools.capabilities[key];
  }
  for (const [key, raw] of Object.entries(capSrc)) {
    if (!(key in capabilities) && typeof raw === 'boolean' && /^[A-Za-z0-9_-]{1,40}$/.test(key)) {
      capabilities[key] = raw;
    }
  }
  // 旧配置迁移：只写过 extraAllowed:['skill'] 的用户，升级后仍应"全部技能可见"
  const legacySkillOnly = legacyExtra.includes('skill') && capSrc.skills === undefined;
  if (legacySkillOnly) capabilities.skills = true;
  // 能力条目：只保留结构合法的（id 安全、tools 为字符串数组）
  const entriesSrc = isObj(toolsSrc.capabilityEntries) ? toolsSrc.capabilityEntries : {};
  const capabilityEntries = {};
  for (const [rawId, rawEntry] of Object.entries(entriesSrc)) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) continue;
    if (!isObj(rawEntry)) continue;
    const entry = {};
    if (typeof rawEntry.label === 'string' && rawEntry.label.trim() !== '') entry.label = rawEntry.label.trim().slice(0, 40);
    if (typeof rawEntry.boundary === 'string' && rawEntry.boundary.trim() !== '') entry.boundary = rawEntry.boundary.trim().slice(0, 500);
    if (typeof rawEntry.enabled === 'boolean') entry.enabled = rawEntry.enabled;
    if (rawEntry.tools !== undefined) {
      const list = strArray(rawEntry.tools, { maxItems: 100, maxLen: 80 });
      entry.tools = list;
    }
    if (Object.keys(entry).length > 0) capabilityEntries[id] = entry;
  }
  const removedCapabilities = strArray(toolsSrc.removedCapabilities, { maxItems: 50, maxLen: 40 });

  const skillsSrc = isObj(toolsSrc.skills) ? toolsSrc.skills : {};
  const allowedList = strArray(skillsSrc.allowed, { maxItems: 100, maxLen: 80 });
  const toolsCfg = {
    capabilities: capabilities,
    capabilityEntries: capabilityEntries,
    removedCapabilities: removedCapabilities,
    extraAllowed: legacyExtra,
    skills: {
      mode: enumStr(skillsSrc.mode, ['all', 'allow'], legacySkillOnly ? 'all' : d.tools.skills.mode),
      allowed: skillsSrc.allowed === undefined && !legacySkillOnly ? [...d.tools.skills.allowed] : allowedList,
    },
  };

  const knSrc = isObj(src.knowledge) ? src.knowledge : {};
  const knowledge = {
    enabled: bool(knSrc.enabled, d.knowledge.enabled),
    dir: absPath(knSrc.dir, d.knowledge.dir),
    injectMaxChars: int(knSrc.injectMaxChars, 0, 20000, d.knowledge.injectMaxChars),
    maxPerTurn: int(knSrc.maxPerTurn, 0, 20, d.knowledge.maxPerTurn),
    autoExtract: normalizeKnowledgeAutoExtract(knSrc.autoExtract, d.knowledge.autoExtract),
  };

  const memSrc = isObj(src.members) ? src.members : {};
  const members = {
    enabled: bool(memSrc.enabled, d.members.enabled),
    dir: absPath(memSrc.dir, d.members.dir),
    autoRecord: bool(memSrc.autoRecord, d.members.autoRecord),
    injectSender: bool(memSrc.injectSender, d.members.injectSender),
    maxPerTurn: int(memSrc.maxPerTurn, 0, 20, d.members.maxPerTurn),
    maxChars: int(memSrc.maxChars, 0, 10000, d.members.maxChars),
  };

  const promptSrc = isObj(src.prompts) ? src.prompts : {};
  const normalizeGuide = (key) => {
    const entry = isObj(promptSrc[key]) ? promptSrc[key] : {};
    return {
      enabled: bool(entry.enabled, d.prompts[key].enabled),
      text: text(entry.text, d.prompts[key].text, 8000),
    };
  };
  // 分段覆盖：只保留结构合法的条目（id 安全、text 有长度上限）
  const sectionsSrc = isObj(promptSrc.sections) ? promptSrc.sections : {};
  const sectionOverrides = {};
  for (const [rawId, rawEntry] of Object.entries(sectionsSrc)) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id)) continue;
    if (!isObj(rawEntry)) continue;
    const entry = {
      enabled: bool(rawEntry.enabled, true),
      text: text(rawEntry.text, '', 8000),
    };
    sectionOverrides[id] = entry;
  }
  const prompts = {
    toolGuide: normalizeGuide('toolGuide'),
    sendGuide: normalizeGuide('sendGuide'),
    rhythmGuide: normalizeGuide('rhythmGuide'),
    stickerGuide: normalizeGuide('stickerGuide'),
    sections: sectionOverrides,
  };

  const aSrc = isObj(src.admin) ? src.admin : {};
  const admin = {
    enabled: bool(aSrc.enabled, d.admin.enabled),
    openids: strArray(aSrc.openids, { maxItems: 100, maxLen: 100 }),
    names: strArray(aSrc.names, { maxItems: 50, maxLen: 40 }),
  };

  return {
    version: 1, reply, triggers, agent, features, model, persona, stickers, memory,
    knowledge, members, phrases, behavior, prompts, admin, tools: toolsCfg,
  };
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
    /**
     * 与 patch 相同，但 replacePaths 指定的路径**整体替换**而不是深合并。
     *
     * 深合并无法删除键：patch({tools:{capabilityEntries:{}}}) 不会清空已有条目，
     * 导致「删除自定义能力」失效。对这类集合型配置必须能整体替换。
     *
     * @param {object} partial 补丁
     * @param {string[]} replacePaths 例如 ['tools.capabilityEntries']
     */
    patchReplace(partial, replacePaths) {
      const src = isObj(partial) ? partial : {};
      const merged = deepMerge(current, src);
      const paths = Array.isArray(replacePaths) ? replacePaths : [];
      for (const dotted of paths) {
        if (typeof dotted !== 'string' || dotted.trim() === '') continue;
        const keys = dotted.split('.').filter(Boolean);
        if (keys.length === 0) continue;
        // 从补丁里取新值（若补丁没给，则视为“清空”）
        let incoming;
        let cursor = src;
        let found = true;
        for (const key of keys) {
          if (!isObj(cursor) || !(key in cursor)) { found = false; break; }
          incoming = cursor[key];
          cursor = incoming;
        }
        if (!found) incoming = undefined;
        // 写回 merged 的同一路径
        let target = merged;
        for (let i = 0; i < keys.length - 1; i += 1) {
          if (!isObj(target[keys[i]])) target[keys[i]] = {};
          target = target[keys[i]];
        }
        target[keys[keys.length - 1]] = incoming === undefined ? {} : incoming;
      }
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