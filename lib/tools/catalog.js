/**
 * catalog —— agent 能力边界的唯一真相（capability manifest）。
 *
 * 设计目标（v0.8）：把原来散落在三处、各拼一遍的工具名单收敛成一份：
 *   - mountFeatureTools()  挂哪些插件
 *   - buildToolAllowList() 全局白名单
 *   - buildToolFilterPlan() assembly 过滤
 * 现在三者都从 createToolCatalog().resolve() 派生，改一处即三处一致。
 *
 * 策略：**显式允许 + 默认拒绝**。只有被「已启用能力」授权的工具名才会放行；
 * 其余一律屏蔽（宿主 preset 也不再靠手写黑名单——那会让新插件的工具默认漏进来）。
 *
 * 纯函数、无 cordis 依赖，方便单测。
 */
import { resolveSkillRoots, scanRoot, selectSkills } from '../skills/scan.js';

/** 宿主插件模块（按需挂载）。 */
const M = {
  fs: '@deepseek-ai/dsh-tool-fs',
  fsSearch: '@deepseek-ai/dsh-tool-fs-search',
  web: '@deepseek-ai/dsh-tool-web',
  toolSkill: '@deepseek-ai/dsh-tool-skill',
  toolBash: '@deepseek-ai/dsh-tool-bash',
  toolJobs: '@deepseek-ai/dsh-tool-jobs',
};

/**
 * 内置能力表。字段：
 *   id            能力标识（设置里可开关）
 *   label         中文名（设置页/诊断用）
 *   tools         该能力授权给模型的工具名（**唯一放行来源**）
 *   mounts        该能力需要的插件挂载
 *   legacyFeature 旧 settings.features 里的同名键（向后兼容）
 *   defaultEnabled 未显式配置时的默认值
 *   gate          额外条件（读其它设置项）
 */
export const CAPABILITIES = [
  {
    id: 'workspace',
    label: '工作区读写',
    boundary: '读写当前工作区里的文件：能看、能改、能新建；工作区之外一律不碰。',
    legacyFeature: 'workspace',
    tools: ['read', 'write', 'edit', 'glob', 'grep'],
    mounts: [
      { kind: 'module', moduleName: M.fs, config: { read: true, readImage: false, write: true, edit: true } },
      { kind: 'module', moduleName: M.fsSearch, config: { sampleOverCapGlobResults: false } },
    ],
  },
  {
    id: 'web',
    label: '联网',
    boundary: '可以搜索和抓取网页来回答问题，引用时给出链接。',
    legacyFeature: 'web',
    tools: ['web_search', 'web_fetch'],
    mounts: [{ kind: 'module', moduleName: M.web, config: {} }],
  },
  {
    id: 'memory',
    label: '长期记忆',
    boundary: '可以记住值得长期保留的信息，也能检索以前聊过的内容。',
    legacyFeature: 'memory',
    tools: ['memory_save', 'memory_search', 'memory_read', 'memory_list'],
  },
  {
    id: 'knowledge',
    label: '知识库',
    boundary: '可以检索和维护这个群/机器人沉淀的知识条目（群规、梗、活动、约定），回答时引用相关知识。',
    // 与长期记忆同级的核心能力，默认开启（可在设置里关掉）
    defaultEnabled: true,
    tools: ['knowledge_search', 'knowledge_read', 'knowledge_save'],
  },
  {
    id: 'members',
    label: '群友库',
    boundary: '可以查群里成员的画像与备注（谁是谁、聊过什么、偏好），也可以在需要时补充备注。',
    defaultEnabled: true,
    tools: ['member_lookup', 'member_note'],
  },
  {
    id: 'stickers',
    label: '表情包',
    boundary: '可以发表情包（一次最多一张）。',
    legacyFeature: 'stickers',
    tools: ['qqbot_send_file', 'qqbot_sticker_save'],
    /** 关闭收藏后只暴露发送工具。 */
    conditional: (settings) => ({
      'qqbot_sticker_save': !(settings.stickers && settings.stickers.collectEnabled === false),
    }),
  },
  {
    id: 'vision',
    label: '看图片',
    boundary: '能看懂对方发来的图片/表情包内容。',
    legacyFeature: 'vision',
    tools: ['qqbot_describe_image'],
  },
  {
    id: 'skills',
    label: '技能',
    boundary: '遇到专门任务时（见下方【技能】段）先加载对应技能再动手。',
    defaultEnabled: false,
    tools: ['skill'],
    mounts: [
      // 消费者：给 agent 装上 skill 工具 + 会话目录
      { kind: 'module', moduleName: M.toolSkill, config: { catalogDescriptionMaxLength: 160 } },
      // 提供者：qqbot 自己的过滤 provider（替代宿主 dsh-skill-filesystem）
      { kind: 'skillProvider', config: {} },
    ],
  },
  {
    id: 'shell',
    label: '执行命令（shell）',
    boundary: '可以在工作区里执行命令（跑脚本、调命令行工具）；长命令会转成后台任务，可以用 job_output 取结果。',
    defaultEnabled: false,
    // bash + 后台任务三件套：超时的命令会 promote 成 job，没有 job_* 就拿不到结果。
    tools: ['bash', 'job_output', 'job_list', 'job_kill'],
    // 执行器（子进程 + 沙箱）与 jobs 注册表由宿主层提供，这里只挂工具本体。
    // 技能（如 bili-get 的转写脚本）需要它才能真正跑起来。
    mounts: [
      { kind: 'module', moduleName: M.toolBash, config: { enableRunInBackground: true, promoteOnTimeout: true } },
      { kind: 'module', moduleName: M.toolJobs, config: {} },
    ],
  },
  {
    id: 'imagegen',
    label: '图片生成',
    boundary: '可以生成或编辑图片（generate_image / edit_image），生成后用 qqbot_send_file 把图片发给对方。',
    defaultEnabled: false,
    // 这些工具来自宿主面常驻的 image-gen 插件，不需要我们挂载，只需决定放不放行。
    tools: ['generate_image', 'generate_images', 'edit_image', 'find_inspiration'],
  },
];

export const CAPABILITY_IDS = CAPABILITIES.map((item) => item.id);

/** 颜色/顺序无关：能力查找表。 */
const BY_ID = new Map(CAPABILITIES.map((item) => [item.id, item]));

/** 安全读设置。 */
function readSettings(settings) {
  try {
    return settings && typeof settings.get === 'function' ? settings.get() : {};
  } catch {
    return {};
  }
}

/**
 * 计算每个能力的启用状态。
 * 优先级：tools.capabilities[id] > features[legacyFeature] > defaultEnabled。
 * skills 额外兼容旧的 extraAllowed 含 'skill' 写法。
 * @returns {Record<string, boolean>}
 */
/**
 * 合并出「当前生效的能力列表」。
 *
 * 能力不再是写死的常量：= 内置定义 − 用户删除的 + 用户新增的，
 * 且内置能力的 label/tools/enabled 可被用户条目覆盖。
 * 这样「加一个能力」只是往 settings 里写一条，不需要改代码重新发布。
 *
 * @param {object} settingsSnapshot settings.get()
 * @returns {Array<object>} 能力描述数组（含 enabled / origin / removed 标记）
 */
export function resolveCapabilityList(settingsSnapshot) {
  const cfg = settingsSnapshot && typeof settingsSnapshot === 'object' ? settingsSnapshot : {};
  const toolsCfg = cfg.tools && typeof cfg.tools === 'object' ? cfg.tools : {};
  const explicit = toolsCfg.capabilities && typeof toolsCfg.capabilities === 'object' ? toolsCfg.capabilities : {};
  const entries = toolsCfg.capabilityEntries && typeof toolsCfg.capabilityEntries === 'object' ? toolsCfg.capabilityEntries : {};
  const removed = new Set(
    Array.isArray(toolsCfg.removedCapabilities)
      ? toolsCfg.removedCapabilities.filter((item) => typeof item === 'string').map((item) => item.trim())
      : [],
  );
  const features = cfg.features && typeof cfg.features === 'object' ? cfg.features : {};
  const extraAllowed = Array.isArray(toolsCfg.extraAllowed) ? toolsCfg.extraAllowed : [];

  const out = [];
  for (const capability of CAPABILITIES) {
    if (removed.has(capability.id)) continue; // 用户「暂时删除」了它
    const override = entries[capability.id] && typeof entries[capability.id] === 'object' ? entries[capability.id] : {};
    const merged = {
      ...capability,
      origin: 'builtin',
      label: typeof override.label === 'string' && override.label.trim() !== '' ? override.label.trim() : capability.label,
      tools: Array.isArray(override.tools) && override.tools.length > 0
        ? override.tools.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
        : capability.tools.slice(),
    };
    let enabled;
    if (typeof override.enabled === 'boolean') {
      enabled = override.enabled;
    } else if (capability.legacyFeature) {
      // 旧能力：唯一真相仍是 features（与设置页旧开关一致，避免双写）
      enabled = typeof features[capability.legacyFeature] === 'boolean'
        ? features[capability.legacyFeature]
        : capability.defaultEnabled === true;
    } else if (typeof explicit[capability.id] === 'boolean') {
      enabled = explicit[capability.id];
    } else {
      enabled = capability.defaultEnabled === true;
    }
    // 向后兼容：旧配置用 extraAllowed:['skill'] 表达"允许技能"
    if (capability.id === 'skills' && typeof explicit.skills !== 'boolean' && extraAllowed.includes('skill')) {
      enabled = true;
    }
    // 记忆总开关关闭时，能力一并不生效
    if (capability.id === 'memory' && cfg.memory && cfg.memory.enabled === false) enabled = false;
    merged.enabled = enabled === true;
    out.push(merged);
  }

  // 用户新增的能力：只有工具名清单，没有挂载（挂载是内置能力的特权）
  for (const [id, raw] of Object.entries(entries)) {
    if (BY_ID.has(id)) continue; // 内置能力已在上面处理
    if (!raw || typeof raw !== 'object') continue;
    const list = Array.isArray(raw.tools)
      ? raw.tools.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
      : [];
    if (list.length === 0) continue;
    out.push({
      id,
      label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : id,
      boundary: typeof raw.boundary === 'string' ? raw.boundary : '',
      tools: list,
      mounts: [],
      origin: 'custom',
      enabled: raw.enabled !== false,
      defaultEnabled: false,
    });
  }
  return out;
}

/**
 * 计算每个能力的启用状态（向后兼容的扁平视图）。
 * @returns {Record<string, boolean>}
 */
export function resolveCapabilityState(settingsSnapshot) {
  const state = {};
  for (const capability of resolveCapabilityList(settingsSnapshot)) state[capability.id] = capability.enabled === true;
  return state;
}

/**
 * 读取技能策略（白名单）。
 * @returns {{enabled:boolean, mode:'all'|'allow', allowed:string[]}}
 */
export function resolveSkillsPolicy(settingsSnapshot) {
  const cfg = settingsSnapshot && typeof settingsSnapshot === 'object' ? settingsSnapshot : {};
  const tools = cfg.tools && typeof cfg.tools === 'object' ? cfg.tools : {};
  const raw = tools.skills && typeof tools.skills === 'object' ? tools.skills : {};
  const extraAllowed = Array.isArray(tools.extraAllowed) ? tools.extraAllowed : [];
  const capabilityState = resolveCapabilityState(cfg);
  // 旧配置迁移：extraAllowed 含 skill 且没显式写 mode -> 全部可见（保持原行为）
  const legacyAll = extraAllowed.includes('skill') && raw.mode === undefined;
  const mode = raw.mode === 'all' || legacyAll ? 'all' : 'allow';
  const allowed = Array.isArray(raw.allowed)
    ? raw.allowed.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : [];
  return { enabled: capabilityState.skills === true, mode: mode, allowed: allowed };
}

/**
 * 创建能力目录。
 * @param {object} options
 * @param {object} options.settings settings-store
 * @param {string} [options.cwd] 会话 cwd（技能根解析用）
 * @param {object} [options.logger]
 */
export function createToolCatalog({ settings, cwd, logger } = {}) {
  const log = logger ?? console;

  function snapshot() {
    return readSettings(settings);
  }

  function capabilityState() {
    return resolveCapabilityState(snapshot());
  }

  /**
   * 解析完整策略：这是所有消费方的唯一出口。
   * @returns {{enabled:string[], tools:string[], mounts:object[], diagnostics:object[], skills:object}}
   */
  function resolve() {
    const cfg = snapshot();
    const capabilityList = resolveCapabilityList(cfg);
    const skills = resolveSkillsPolicy(cfg);
    const tools = new Set();
    const mounts = [];
    const diagnostics = [];

    for (const capability of capabilityList) {
      const enabled = capability.enabled === true;
      if (!enabled) {
        diagnostics.push({ id: capability.id, label: capability.label, origin: capability.origin, enabled: false, tools: capability.tools.slice(), reason: 'capability=off' });
        continue;
      }
      // 条件性工具（如关闭表情收藏后不给 qqbot_sticker_save）
      const conditional = typeof capability.conditional === 'function' ? capability.conditional(cfg) : undefined;
      const granted = [];
      for (const name of capability.tools) {
        if (conditional && conditional[name] === false) continue;
        tools.add(name);
        granted.push(name);
      }
      for (const mount of capability.mounts || []) {
        mounts.push({
          kind: mount.kind || 'module',
          capability: capability.id,
          moduleName: mount.moduleName,
          config: mount.kind === 'skillProvider' ? { ...mount.config } : { ...mount.config },
        });
      }
      diagnostics.push({ id: capability.id, label: capability.label, origin: capability.origin, enabled: true, tools: granted, reason: 'ok' });
    }

    // 额外显式放行（escape hatch）：MCP / 第三方插件工具
    const extra = cfg.tools && Array.isArray(cfg.tools.extraAllowed) ? cfg.tools.extraAllowed : [];
    for (const name of extra) {
      if (typeof name !== 'string' || name.trim() === '') continue;
      tools.add(name.trim());
    }

    const enabledIds = capabilityList.filter((item) => item.enabled === true).map((item) => item.id);
    const boundaries = capabilityList
      .filter((item) => item.enabled === true && typeof item.boundary === 'string' && item.boundary.trim() !== '')
      .map((item) => ({ id: item.id, label: item.label, boundary: item.boundary }));
    return {
      enabled: enabledIds,
      boundaries: boundaries,
      tools: Array.from(tools),
      mounts: mounts,
      diagnostics: diagnostics,
      skills: skills,
    };
  }

  /**
   * assembly 层过滤计划。**统一为 allow 模式**（默认拒绝）：
   * 宿主 preset 也用同一份白名单，不再维护手写黑名单。
   * @returns {{mode:'allow', names:Set<string>}}
   */
  function filterPlan() {
    const plan = resolve();
    return { mode: 'allow', names: new Set(plan.tools) };
  }

  /** 技能 provider 的挂载配置（未启用技能时返回 null）。 */
  function skillProviderConfig() {
    const plan = resolve();
    const skills = plan.skills;
    if (!skills.enabled) return null;
    return {
      providerName: 'qqbot',
      mode: skills.mode,
      allowed: skills.allowed,
      cwd: cwd || '',
      includeDefaultRoots: true,
      debug: false,
    };
  }

  /**
   * 供提示词生成的可见技能列表（name + description）。
   * 只读扫描，失败返回空数组。
   * @returns {{name:string, description:string, whenToUse?:string}[]}
   */
  /**
   * 扫描技能并按策略筛选。
   * @returns {{enabled:boolean, mode:string, allowed:string[], visible:object[], hidden:string[], missing:string[]}}
   */
  function scanSkills() {
    const skills = resolveSkillsPolicy(snapshot());
    const base = {
      enabled: skills.enabled,
      mode: skills.mode,
      allowed: skills.allowed,
      visible: [],
      hidden: [],
      missing: [],
    };
    if (!skills.enabled) return base;
    try {
      const roots = resolveSkillRoots({ cwd: cwd || process.cwd() });
      const rows = [];
      for (const root of roots) rows.push(...scanRoot(root, 'qqbot', () => {}));
      const picked = selectSkills(rows, { mode: skills.mode, allowed: skills.allowed });
      return {
        ...base,
        visible: picked.visible,
        hidden: picked.hidden,
        // 白名单里写了但本机找不到的技能名：界面要提示，否则会静默失效
        missing: picked.invalid,
      };
    } catch (err) {
      log.warn?.('[catalog] 扫描技能失败: ' + (err && err.message ? err.message : String(err)));
      return base;
    }
  }

  function skillsForGuide() {
    const scanned = scanSkills();
    return scanned.visible.map((candidate) => ({
      name: candidate.name,
      description: candidate.description,
      ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
    }));
  }

  /** 设置页 / 诊断接口用的完整视图。 */
  function diagnose() {
    const plan = resolve();
    const cfg = snapshot();
    const toolsCfg = cfg.tools && typeof cfg.tools === 'object' ? cfg.tools : {};
    const removedList = Array.isArray(toolsCfg.removedCapabilities)
      ? toolsCfg.removedCapabilities.filter((item) => typeof item === 'string')
      : [];
    return {
      // 当前生效的能力（内置 − 删除 + 用户新增），每项带 origin
      capabilities: plan.diagnostics.map((entry) => {
        const capability = { id: entry.id, label: entry.label };
        const skills = plan.skills;
        return {
          id: entry.id,
          label: entry.label,
          origin: entry.origin || 'builtin',
          enabled: entry.enabled === true,
          tools: entry.tools || [],
          reason: entry.reason || 'unknown',
          ...(capability.id === 'skills'
            ? (() => {
                const scanned = scanSkills();
                return {
                  mode: skills.mode,
                  allowed: skills.allowed,
                  // 白名单里找不到的技能名（写错/未安装）：界面必须提示，否则静默失效
                  missing: scanned.missing,
                  hiddenCount: scanned.hidden.length,
                };
              })()
            : {}),
        };
      }),
      allow: plan.tools,
      mounts: plan.mounts.map((mount) => ({ kind: mount.kind, capability: mount.capability, moduleName: mount.moduleName || '(self)skill-provider' })),
      skills: skillsForGuide(),
      // 「暂时删除」的内置能力（设置页可恢复）
      removed: removedList,
      // 可在设置页新增能力的原始元数据（内置的定义，供覆盖 label/tools）
      builtins: CAPABILITIES.map((item) => ({ id: item.id, label: item.label, tools: item.tools.slice(), defaultEnabled: item.defaultEnabled === true })),
    };
  }

  return {
    capabilities: () => CAPABILITIES.slice(),
    capabilityState: capabilityState,
    resolve: resolve,
    filterPlan: filterPlan,
    skillProviderConfig: skillProviderConfig,
    skillsForGuide: skillsForGuide,
    diagnose: diagnose,
  };
}

export default createToolCatalog;
