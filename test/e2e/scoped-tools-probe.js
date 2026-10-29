/**
 * test/e2e/scoped-tools-probe.js —— v0.17 工具作用域探针（QA 用，不属于插件运行时）。
 *
 * 在隔离 dev 实例里挂载：等 qqbot-buddy runtime 就绪后，用「假 agentCtx」驱动真实的
 * SessionManager.buildSetup()，断言：
 *   1. 插件工具不再出现在**全局** tools 注册表（其它 preset / 普通 Web agent 看不到）；
 *   2. buildSetup 会把插件工具注册进该 agent 的 scope（qqbot 会话专属）；
 *   3. 作用域注册可被 agentCtx.effect 正常注销；
 *   4. 知识自动提炼器已装配（config/stats/extractNow 可用）。
 * 结果原子写入 config.outFile。
 */
import fs from 'node:fs';
import path from 'node:path';

export const name = 'qa-scoped-tools-probe';

const PLUGIN_TOOL_NAMES = [
  'memory_save', 'memory_search', 'memory_read', 'memory_list',
  'knowledge_search', 'knowledge_read', 'knowledge_save',
  'member_lookup', 'member_note',
  'qqbot_send_file', 'qqbot_sticker_save', 'qqbot_describe_image',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errText = (error) => (error instanceof Error ? error.message : String(error));

function makeFakeAgentCtx(forwardGet) {
  const tools = new Map();
  const restricts = [];
  const disposers = [];
  return {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
      restrict(options) {
        restricts.push(options && Array.isArray(options.allow) ? [...options.allow] : []);
      },
      view() {
        return { knownNames: new Set(tools.keys()) };
      },
    },
    _tools: tools,
    _restricts: restricts,
    // 返回 undefined（同步插件）；返回 thenable 但从不 resolve 会让 buildSetup 永远挂起
    plugin() { return undefined; },
    on() { return () => {}; },
    get(name) {
      const key = typeof name === 'string' ? name : '';
      if (key === 'tools') return undefined; // 真实宿主 get 返回无 scope 实例，探针里不让工具走它
      try { return typeof forwardGet === 'function' ? forwardGet(key) : undefined; } catch { return undefined; }
    },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    _disposeAll() {
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        try { dispose(); } catch { /* ignore */ }
      }
    },
  };
}

function writeResult(file, result) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    console.error('[scoped-tools-probe] 写结果失败:', errText(error));
  }
}

export function apply(ctx, config = {}) {
  const outFile = typeof config.outFile === 'string' && config.outFile !== '' ? config.outFile : '/tmp/scoped-tools-probe.json';
  const pluginEntry = typeof config.pluginEntry === 'string' ? config.pluginEntry : '';
  const result = { at: new Date().toISOString(), checks: [] };
  const check = (label, fn) => {
    try {
      result.checks.push({ label: label, ok: true, detail: fn() ?? null });
    } catch (error) {
      result.checks.push({ label: label, ok: false, error: errText(error) });
    }
  };
  const expect = (condition, message) => { if (!condition) throw new Error(message); };

  // 后台执行，避免阻塞 dsh 启动（探针在 qqbot-buddy 装配完成前就开始等）
  void (async () => {
  try {
    let runtime;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      // 优先用插件 debug 模式暴露的 runtime（同一个宿主进程内，避免模块实例不一致）
      try {
        const debug = globalThis.__QQBOT_BUDDY_DEBUG__;
        if (debug && debug.runtime) runtime = debug.runtime;
      } catch { /* ignore */ }
      if (!runtime) {
        try {
          const mod = await import(pluginEntry);
          runtime = typeof mod.getRuntime === 'function' ? mod.getRuntime() : null;
        } catch {
          runtime = null;
        }
      }
      if (runtime && runtime.manager && runtime.settings) break;
      await sleep(300);
    }
    if (!runtime || !runtime.manager) throw new Error('等待 qqbot-buddy runtime 超时');
    const activeBot = runtime && runtime.__host && typeof runtime.__host.activeBot === 'function'
      ? runtime.__host.activeBot()
      : runtime;
    result.botId = activeBot && activeBot.id ? activeBot.id : '';
    result.workspaceDir = activeBot && activeBot.workspaceDir ? activeBot.workspaceDir : '';

    // 1) 全局注册表不应出现插件工具
    check('全局 tools 注册表不含插件工具', () => {
      const tools = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : null;
      let known = [];
      try {
        const view = tools && typeof tools.view === 'function' ? tools.view(undefined) : null;
        if (view && view.knownNames instanceof Set) known = [...view.knownNames];
      } catch {
        known = [];
      }
      const leaked = PLUGIN_TOOL_NAMES.filter((name) => known.includes(name));
      expect(leaked.length === 0, '全局注册表出现插件工具: ' + leaked.join(','));
      return { globalToolCount: known.length, pluginLeaked: leaked };
    });

    // 2) buildSetup 把插件工具注册进 agent scope
    const fake = makeFakeAgentCtx((name) => (ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined));
    await runtime.manager.buildSetup('group')(fake);
    await sleep(200);
    check('buildSetup 注册作用域插件工具', () => {
      const names = [...fake._tools.keys()];
      const missing = PLUGIN_TOOL_NAMES.filter((name) => !names.includes(name));
      expect(missing.length === 0, '作用域缺少工具: ' + missing.join(','));
      return names.slice().sort();
    });
    check('作用域工具可执行（knowledge_save 定义可调用）', () => {
      const def = fake._tools.get('knowledge_save');
      expect(def && typeof def.execute === 'function', '缺少 knowledge_save execute');
      expect(typeof def.parameters === 'object', 'knowdedge_save 缺少 parameters');
      return { name: def.name };
    });
    check('scope 注销后工具消失', () => {
      fake._disposeAll();
      expect(fake._tools.size === 0, '注销后仍有工具: ' + [...fake._tools.keys()].join(','));
      return { remaining: fake._tools.size };
    });

    // 3) 知识自动提炼器装配
    check('知识自动提炼器已装配（默认关闭 + 参数完整）', () => {
      const extractor = runtime.knowledgeExtractor;
      expect(extractor && typeof extractor.extractNow === 'function', '缺少 extractNow');
      const cfg = extractor.config();
      expect(cfg.enabled === false, '默认应为关闭');
      for (const key of ['everyRounds', 'maxEntries', 'minConfidence', 'provider', 'model']) {
        expect(key in cfg, '缺少配置项 ' + key);
      }
      const stats = extractor.stats();
      expect(typeof stats.lastExtractAt === 'number', 'stats.lastExtractAt 类型异常');
      return { config: cfg, stats: { enabled: stats.enabled, roundsSinceExtract: stats.roundsSinceExtract } };
    });

    // 4) 审核状态字段可用（条目库）
    check('条目库支持 status（pending 不进 recall）', () => {
      const store = runtime.knowledge;
      expect(store && typeof store.save === 'function', '知识库不可用');
      const saved = store.save({ title: 'qa-probe-pending', body: '仅探针使用', status: 'pending', scope: 'global' });
      const pendingList = store.list({ status: 'pending' });
      const hit = store.recall({ query: 'qa-probe-pending' });
      store.remove(saved.id);
      expect(pendingList.total >= 1, 'pending 列表未命中');
      expect(hit.length === 0, 'pending 不应进入 recall');
      return { id: saved.id };
    });
  } catch (error) {
    result.fatal = errText(error);
  }
  result.finishedAt = new Date().toISOString();
  writeResult(outFile, result);
  console.log('[scoped-tools-probe] 结果已写入 ' + outFile);
  })();
}

export default { name, apply };
