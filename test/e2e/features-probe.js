/**
 * test/e2e/features-probe.js —— 【已过时，v0.8 起被 capability-probe.js 取代】
 *
 * v0.8 把「工具白名单」统一成能力目录（显式允许 + 默认拒绝），本探针里断言的
 * 旧契约（默认白名单不含 fs/web 工具、workspace/web 关闭时白名单不变、
 * 宿主 preset 走手写 deny 黑名单）已经全部不成立。
 *
 * 新的验收入口：scripts/blank-profile-test.sh + test/e2e/capability-probe.js
 * 本文件仅保留作历史参考，不要再用 --probe 跑它。
 *
 * ---- 以下为原始说明 ----
 * 功能开关探针（仅 QA 隔离验收用，不属于插件运行时）。
 *
 * 用法：通过 test-profile.sh 的 overlay insert 挂载，config:
 *   { outFile: <结果 JSON 路径>, pluginEntry: <profile node_modules 里的 lib/index.js 绝对路径> }
 *
 * 原理：轮询 qqbot-buddy 的 apply.lastRuntime / getRuntime()，拿到真实 SessionManager 后，
 * 用「假 agentCtx」调用 manager.buildSetup('group') —— 走真实的 preset 装配/动态工具挂载/
 * 全局白名单逻辑，但不会真的创建 agent、不会触发 LLM 或 QQ 网络。探针断言后把结果原子写入
 * outFile，测试脚本读取断言。设置改动在结束时恢复原值。
 */
import fs from 'node:fs';
import path from 'node:path';

export const name = 'qa-features-probe';

/** 工具插件 → 其注册的模型可见工具名（用于断言“工具集”）。 */
const TOOL_MODULES = [
  { name: 'tool-fs', tools: ['read', 'write', 'edit'] },
  { name: 'tool-fs-search', tools: ['glob', 'grep'] },
  { name: 'tool-web', tools: ['web_search', 'web_fetch'] },
];
const FULL_ALLOW = [
  'memory_save',
  'memory_search',
  'memory_read',
  'memory_list',
  'qqbot_send_file',
  'qqbot_sticker_save',
  'qqbot_describe_image',
];
const MEMORY_TOOLS = ['memory_save', 'memory_search', 'memory_read', 'memory_list'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 断言助手：失败抛可读错误，由 check() 转成 {ok:false}。 */
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(message + '（实际 ' + a + '，期望 ' + b + '）');
}

/** 假 agentCtx：记录 plugin() 挂载与 tools.restrict() allow 列表。 */
function makeFakeAgentCtx() {
  const plugins = [];
  const restricts = [];
  const fake = {
    plugins,
    restricts,
    tools: {
      restrict(options) {
        restricts.push(options && Array.isArray(options.allow) ? [...options.allow] : []);
        return () => {};
      },
    },
    plugin(namespace, config) {
      plugins.push({
        name: namespace && typeof namespace.name === 'string' ? namespace.name : '?',
        config: config && typeof config === 'object' ? config : {},
      });
      // cordis plugin() 返回 thenable Fiber；这里返回已 resolve 的 Promise 让 await 通过。
      return Promise.resolve();
    },
    get(service) {
      if (service === 'tools') return fake.tools;
      return undefined;
    },
    effect(callback) {
      try {
        const dispose = callback();
        if (typeof dispose === 'function') dispose();
      } catch {
        /* ignore */
      }
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return fake;
}

/** 原子写结果 JSON（tmp + rename, 0600）。 */
function writeResult(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function apply(ctx, config = {}) {
  const outFile = typeof config.outFile === 'string' && config.outFile.trim() !== '' ? config.outFile.trim() : '';
  const pluginEntry = typeof config.pluginEntry === 'string' ? config.pluginEntry.trim() : '';
  const result = { ok: false, startedAt: new Date().toISOString(), checks: [], errors: [], pluginEntry };

  const check = (name, run) => {
    try {
      const detail = run();
      result.checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
    } catch (error) {
      result.checks.push({ name, ok: false, error: errText(error) });
    }
  };

  try {
    if (outFile === '' || pluginEntry === '') throw new Error('探针缺少 outFile / pluginEntry 配置');
    // 1. 等 qqbot-buddy 插件装配完成并拿到 runtime（同一模块实例共享 apply.lastRuntime）。
    const mod = await import(pluginEntry);
    let runtime;
    for (let i = 0; i < 300; i += 1) {
      runtime = typeof mod.getRuntime === 'function' ? mod.getRuntime() : (mod.apply && mod.apply.lastRuntime);
      if (runtime && runtime.manager && typeof runtime.manager.buildSetup === 'function' && runtime.settings) break;
      await sleep(300);
    }
    if (!runtime || !runtime.manager || !runtime.settings) throw new Error('等待 qqbot-buddy runtime 超时（90s）');

    const manager = runtime.manager;
    const settings = runtime.settings;
    const original = settings.get();
    const runSetup = async (patch) => {
      await settings.patch(patch);
      const fake = makeFakeAgentCtx();
      await manager.buildSetup('group')(fake);
      return fake;
    };
    const pluginNames = (fake) => fake.plugins.map((item) => item.name);
    const lastAllow = (fake) => (fake.restricts.length > 0 ? fake.restricts[fake.restricts.length - 1] : undefined);

    // ── C1 默认（内置组合 + features 全开） ──────────────────
    const def = await runSetup({
      agent: { preset: '' },
      features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
      memory: { enabled: true },
    });
    check('默认：挂载 workspace + web 工具插件（tool-fs/tool-fs-search/tool-web）', () => {
      const names = pluginNames(def);
      for (const item of TOOL_MODULES) expect(names.includes(item.name), '缺少工具插件 ' + item.name + '，实际: ' + names.join(','));
      return { modules: names };
    });
    check('默认：tool-fs 配置 read/write/edit=true、readImage=false，fs-search 关闭超限采样', () => {
      const fsMount = def.plugins.find((item) => item.name === 'tool-fs');
      const searchMount = def.plugins.find((item) => item.name === 'tool-fs-search');
      expectEqual(fsMount.config, { read: true, readImage: false, write: true, edit: true }, 'tool-fs 配置不符');
      expectEqual(searchMount.config, { sampleOverCapGlobResults: false }, 'tool-fs-search 配置不符');
    });
    check('默认：全局白名单 = memory_* + qqbot_send_file + qqbot_describe_image', () => {
      expectEqual(lastAllow(def), FULL_ALLOW, '默认白名单不符');
      return lastAllow(def);
    });
    check('默认：assembly 工具过滤白名单含 qqbot_sticker_save', () => {
      const plan = manager.buildToolFilterPlan('qqbot-buddy');
      expect(plan && plan.mode === 'allow', 'assembly plan 应为 allow 模式');
      expect(plan.names.has('qqbot_sticker_save'), 'assembly 白名单缺少 qqbot_sticker_save');
      for (const name of FULL_ALLOW) expect(plan.names.has(name), 'assembly 白名单缺少 ' + name);
      return [...plan.names];
    });
    check('默认：工具名覆盖 read/write/edit/glob/grep/web_search/web_fetch', () => {
      const names = pluginNames(def);
      const toolNames = [];
      for (const item of TOOL_MODULES) if (names.includes(item.name)) toolNames.push(...item.tools);
      for (const tool of ['read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch']) {
        expect(toolNames.includes(tool), '工具集缺少 ' + tool);
      }
      return toolNames;
    });

    // ── C2 workspace/web 关闭 ────────────────────────────────
    const noWsWeb = await runSetup({
      agent: { preset: '' },
      features: { workspace: false, web: false, stickers: true, vision: true, memory: true },
      memory: { enabled: true },
    });
    check('features.workspace=false&web=false：不挂载 fs/fs-search/web 工具插件', () => {
      const names = pluginNames(noWsWeb);
      for (const item of TOOL_MODULES) expect(!names.includes(item.name), '不应挂载 ' + item.name + '，实际: ' + names.join(','));
      return { modules: names };
    });
    check('features.workspace/web=false 时全局白名单不变（表情包/看图/记忆仍开）', () => {
      expectEqual(lastAllow(noWsWeb), FULL_ALLOW, '白名单不应受 workspace/web 影响');
    });

    // ── C3 表情包/看图/记忆全关 ──────────────────────────────
    const noGlobal = await runSetup({
      features: { workspace: true, web: true, stickers: false, vision: false, memory: false },
    });
    check('stickers/vision/memory=false：全局白名单为空（宿主 preset 的 scoped 工具不受影响）', () => {
      expectEqual(lastAllow(noGlobal), [], '白名单应为空');
    });

    // ── C3.5 收藏开关 / 表情包总开关只影响 qqbot_sticker_save ──
    const collectOff = await runSetup({
      features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
      stickers: { collectEnabled: false },
      memory: { enabled: true },
    });
    check('stickers.collectEnabled=false：白名单/assembly 保留 qqbot_send_file、移除 qqbot_sticker_save', () => {
      const allow = lastAllow(collectOff);
      expect(allow.includes('qqbot_send_file'), '应保留 qqbot_send_file');
      expect(!allow.includes('qqbot_sticker_save'), '不应包含 qqbot_sticker_save');
      const plan = manager.buildToolFilterPlan('qqbot-buddy');
      expect(plan && plan.mode === 'allow', 'assembly plan 应为 allow 模式');
      expect(plan.names.has('qqbot_send_file'), 'assembly 应保留 qqbot_send_file');
      expect(!plan.names.has('qqbot_sticker_save'), 'assembly 不应包含 qqbot_sticker_save');
      return allow;
    });

    const stickersOff = await runSetup({
      features: { workspace: true, web: true, stickers: false, vision: true, memory: true },
      stickers: { collectEnabled: true },
      memory: { enabled: true },
    });
    check('features.stickers=false：白名单/assembly 同时移除 qqbot_send_file 与 qqbot_sticker_save', () => {
      const allow = lastAllow(stickersOff);
      expect(!allow.includes('qqbot_send_file'), '不应包含 qqbot_send_file');
      expect(!allow.includes('qqbot_sticker_save'), '不应包含 qqbot_sticker_save');
      const plan = manager.buildToolFilterPlan('qqbot-buddy');
      expect(!plan.names.has('qqbot_send_file'), 'assembly 不应包含 qqbot_send_file');
      expect(!plan.names.has('qqbot_sticker_save'), 'assembly 不应包含 qqbot_sticker_save');
      return allow;
    });

    // ── C4 memory.enabled=false 只影响 memory_* ──────────────
    const memOff = await runSetup({
      features: { workspace: true, web: true, memory: true, stickers: true, vision: true },
      memory: { enabled: false },
    });
    check('memory.enabled=false：白名单移除 memory_*，保留 send_file/describe_image', () => {
      const allow = lastAllow(memOff);
      for (const tool of MEMORY_TOOLS) expect(!allow.includes(tool), '不应包含 ' + tool);
      expect(allow.includes('qqbot_send_file'), '应保留 qqbot_send_file');
      expect(allow.includes('qqbot_describe_image'), '应保留 qqbot_describe_image');
      return allow;
    });

    // ── C5 宿主 preset 模式 ─────────────────────────────────
    let hostPresetId = '';
    try {
      const presets = await manager.listPresets();
      const candidate = (Array.isArray(presets) ? presets : []).find((item) => item && item.id && item.id !== 'qqbot-buddy');
      if (candidate) hostPresetId = candidate.id;
    } catch {
      /* 列不出来就用占位 id */
    }
    if (hostPresetId === '') hostPresetId = 'qa-probe-host-preset';
    const hostMode = await runSetup({
      agent: { preset: hostPresetId },
      features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
      memory: { enabled: true },
    });
    check('宿主 preset：不挂载内置组合的 workspace/web 工具插件', () => {
      const names = pluginNames(hostMode);
      for (const item of TOOL_MODULES) expect(!names.includes(item.name), '宿主 preset 模式不应挂载 ' + item.name);
    });
    check('宿主 preset：presetInfo().builtIn=false 且白名单仍生效', () => {
      const info = manager.presetInfo();
      expect(info.selected === hostPresetId, 'selected 不符: ' + info.selected);
      expect(info.effective === hostPresetId, 'effective 不符: ' + info.effective);
      expect(info.builtIn === false, 'builtIn 应为 false');
      expectEqual(lastAllow(hostMode), FULL_ALLOW, '宿主 preset 模式白名单不符');
      return { selected: info.selected, effective: info.effective, builtIn: info.builtIn };
    });

    // ── C6 恢复设置 ─────────────────────────────────────────
    await settings.replace(original);
    check('探针结束后恢复原始 settings（agent/features 不变）', () => {
      const now = settings.get();
      expectEqual(now.agent, original.agent, 'agent 未恢复');
      expectEqual(now.features, original.features, 'features 未恢复');
    });
  } catch (error) {
    result.errors.push(errText(error));
  }

  result.ok = result.errors.length === 0 && result.checks.length > 0 && result.checks.every((item) => item.ok);
  result.finishedAt = new Date().toISOString();
  if (outFile !== '') {
    try {
      writeResult(outFile, result);
    } catch (error) {
      try {
        console.error('[qa-features-probe] 写结果失败: ' + errText(error));
      } catch {
        /* ignore */
      }
    }
  }
  if (ctx && typeof ctx.logger === 'object' && ctx.logger !== null) {
    try {
      const logger = ctx.logger;
      const level = result.ok ? 'info' : 'error';
      if (typeof logger[level] === 'function') {
        logger[level]('[qa-features-probe] ok=' + result.ok + ' checks=' + result.checks.filter((item) => item.ok).length + '/' + result.checks.length);
      }
    } catch {
      /* ignore */
    }
  }
  return result;
}