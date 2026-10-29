/**
 * test/e2e/capability-probe.js —— 能力边界探针（QA 用，不属于插件运行时）。
 *
 * 在隔离 profile 里挂载，等 qqbot-buddy 装配完成后，用「假 agentCtx」驱动**真实的**
 * SessionManager.buildSetup()，断言 v0.8 的「能力清单 + 默认拒绝」契约：
 *   - 默认只放行能力清单里的工具，imagegen / 技能工具默认不在；
 *   - 关闭能力 → 工具与挂载同时消失；
 *   - 打开 imagegen → 4 个图片工具进入放行集（不额外挂插件）；
 *   - 技能开启 → 挂 tool-skill + 自带 provider，且**不**挂宿主 dsh-skill-filesystem；
 *   - 宿主 preset 与内置组合走同一份白名单（assembly 一律 allow 模式，无 deny 黑名单）。
 *
 * 结果原子写入 outFile，由调用方读取断言。
 */
import fs from 'node:fs';
import path from 'node:path';

export const name = 'qa-capability-probe';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errText = (error) => (error instanceof Error ? error.message : String(error));

function makeFakeAgentCtx() {
  const plugins = [];
  const restricts = [];
  return {
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
    },
    handlers: {},
    on(event, handler) {
      if (typeof event === 'string' && typeof handler === 'function') this.handlers[event] = handler;
      return () => {};
    },
    effect(fn) { return typeof fn === 'function' ? () => {} : () => {}; },
  };
}

export function apply(ctx, config = {}) {
  const outFile = config.outFile;
  // 必须导入**loader 实际加载的那一份**模块，否则 lastRuntime 落在另一个模块实例上（tgz 安装时
  // 探针若按自身位置解析会拿到仓库副本）。pluginEntry = <profile>/node_modules/<pkg>/lib/index.js
  const pluginEntry = typeof config.pluginEntry === 'string' && config.pluginEntry.trim() !== ''
    ? config.pluginEntry.trim()
    : 'dsh-qqbot-buddy';
  const results = [];
  const check = (label, fn) => {
    try {
      results.push({ label, ok: true, detail: fn() ?? null });
    } catch (error) {
      results.push({ label, ok: false, error: errText(error) });
    }
  };
  const expect = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const expectEqual = (actual, expected, message) => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(message + '（实际 ' + a + '，期望 ' + b + '）');
  };

  (async () => {
    let runtime;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      runtime = (await import(pluginEntry)).getRuntime();
      if (runtime && runtime.manager && runtime.settings && runtime.toolCatalog) break;
      await sleep(300);
    }
    if (!runtime || !runtime.manager || !runtime.settings || !runtime.toolCatalog) {
      throw new Error('等待 qqbot-buddy runtime 超时');
    }

    const manager = runtime.manager;
    const settings = runtime.settings;
    const original = settings.get();

    const runSetup = async (patch) => {
      await settings.patch(patch);
      const fake = makeFakeAgentCtx();
      await manager.buildSetup('group')(fake);
      await sleep(120);
      return fake;
    };
    const pluginNames = (fake) => fake.plugins.map((item) => item.name);
    const lastAllow = (fake) => (fake.restricts.length > 0 ? fake.restricts[fake.restricts.length - 1] : undefined);
    const allowSet = (fake) => new Set(lastAllow(fake) || []);
    const planNames = () => {
      const plan = manager.buildToolFilterPlan('qqbot-buddy');
      return { mode: plan && plan.mode, names: plan ? [...plan.names] : [] };
    };

    const CAPABILITIES_ON = { skills: false, imagegen: false };

    // ── C1 默认 ─────────────────────────────────────────────
    const def = await runSetup({
      agent: { preset: '' },
      features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
      memory: { enabled: true },
      tools: { capabilities: { ...CAPABILITIES_ON }, extraAllowed: [], skills: { mode: 'allow', allowed: ['bili-get'] } },
    });

    check('默认：挂载 fs / fs-search / web 三个工具插件', () => {
      const names = pluginNames(def);
      for (const mod of ['tool-fs', 'tool-fs-search', 'tool-web']) {
        expect(names.includes(mod), '缺少 ' + mod + '，实际: ' + names.join(','));
      }
      return names;
    });

    check('默认：放行集 = fs+web+memory+qqbot 工具，且不含 imagegen / skill', () => {
      const allow = allowSet(def);
      for (const tool of ['read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch',
        'memory_save', 'memory_search', 'memory_read', 'memory_list',
        'qqbot_send_file', 'qqbot_sticker_save', 'qqbot_describe_image']) {
        expect(allow.has(tool), '放行集缺少 ' + tool);
      }
      for (const tool of ['generate_image', 'generate_images', 'edit_image', 'find_inspiration', 'skill']) {
        expect(!allow.has(tool), '默认不应放行 ' + tool);
      }
      return [...allow];
    });

    check('默认：默认拒绝——团队/画布/bash 等未授权工具不放行', () => {
      const allow = allowSet(def);
      for (const tool of ['bash', 'spawn_teammate', 'canvas_state', 'present', 'working_directory']) {
        expect(!allow.has(tool), '不应放行 ' + tool);
      }
    });

    check('默认：不挂技能插件（tool-skill / skillProvider 都不出现）', () => {
      const names = pluginNames(def);
      expect(!names.includes('tool-skill'), '默认不应挂 tool-skill');
      expect(!names.includes('qqbot-skill-provider'), '默认不应挂自带 provider，实际: ' + names.join(','));
    });

    check('默认：assembly 过滤为 allow 模式且与全局白名单一致', () => {
      const plan = planNames();
      expect(plan.mode === 'allow', 'assembly 应为 allow 模式，实际 ' + plan.mode);
      const allow = allowSet(def);
      expectEqual(plan.names.slice().sort(), [...allow].slice().sort(), 'assembly 与全局白名单不一致');
    });

    // ── C2 宿主 preset 也走同一份白名单 ──────────────────────
    const hostPreset = await runSetup({ agent: { preset: 'standard' }, features: { workspace: true, web: true, stickers: true, vision: true, memory: true } });
    check('宿主 preset=standard：assembly 仍为 allow 模式（无手写 deny 黑名单）', () => {
      const plan = planNames();
      expect(plan.mode === 'allow', 'assembly 应为 allow，实际 ' + plan.mode);
      expect(!plan.names.includes('generate_image'), '图片生成工具不应因宿主 preset 漏进来');
      return plan.names.length;
    });

    // ── C3 关闭 workspace / web ─────────────────────────────
    const noWsWeb = await runSetup({
      agent: { preset: '' },
      features: { workspace: false, web: false, stickers: true, vision: true, memory: true },
    });
    check('关闭 workspace/web：对应工具插件不挂载，工具从白名单消失', () => {
      const names = pluginNames(noWsWeb);
      expect(!names.includes('tool-fs') && !names.includes('tool-fs-search'), '不应挂载 fs 插件: ' + names.join(','));
      expect(!names.includes('tool-web'), '不应挂载 web 插件');
      const allow = allowSet(noWsWeb);
      for (const tool of ['read', 'web_search', 'web_fetch']) expect(!allow.has(tool), '不应放行 ' + tool);
      expect(allow.has('qqbot_send_file'), '表情包工具应保留');
      return [...allow];
    });

    // ── C4 打开 imagegen ────────────────────────────────────
    const img = await runSetup({
      agent: { preset: '' },
      features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
      tools: { capabilities: { skills: false, imagegen: true } },
    });
    check('打开 imagegen：4 个图片工具进入白名单，且不新增挂载', () => {
      const allow = allowSet(img);
      for (const tool of ['generate_image', 'generate_images', 'edit_image', 'find_inspiration']) {
        expect(allow.has(tool), '应放行 ' + tool);
      }
      const names = pluginNames(img);
      expect(!names.includes('image-gen'), 'imagegen 不应由插件挂载（工具来自宿主）: ' + names.join(','));
      const plan = planNames();
      expect(plan.names.includes('generate_image'), 'assembly 也应放行 generate_image');
      return [...allow];
    });

    // ── C5 技能开启 ─────────────────────────────────────────
    const skillsOn = await runSetup({
      agent: { preset: '' },
      features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
      tools: { capabilities: { skills: true, imagegen: false }, skills: { mode: 'allow', allowed: ['bili-get'] } },
    });
    check('技能开启：挂 tool-skill + 自带 provider，且不挂宿主 dsh-skill-filesystem', () => {
      const names = pluginNames(skillsOn);
      expect(names.includes('tool-skill'), '应挂 tool-skill，实际: ' + names.join(','));
      expect(names.includes('qqbot-skill-provider'), '应挂自带 provider，实际: ' + names.join(','));
      expect(!names.includes('skill-filesystem'), '不应挂宿主 skill-filesystem');
      expect(allowSet(skillsOn).has('skill'), '应放行 skill 工具');
      return names;
    });

    check('技能开启：provider 收到白名单配置（mode=allow, allowed=[bili-get]）', () => {
      const mount = skillsOn.plugins.find((item) => item.name === 'qqbot-skill-provider');
      expect(!!mount, '未找到 provider 挂载');
      expectEqual(mount.config.mode, 'allow', 'provider mode 不符');
      expectEqual(mount.config.allowed, ['bili-get'], 'provider allowed 不符');
      return mount.config;
    });

    // ── C6 全部关闭 ─────────────────────────────────────────
    const allOff = await runSetup({
      agent: { preset: '' },
      features: { workspace: false, web: false, stickers: false, vision: false, memory: false },
      memory: { enabled: false },
      tools: { capabilities: { skills: false, imagegen: false } },
    });
    check('能力全关：白名单为空、无挂载（合法状态，不报错）', () => {
      const allow = allowSet(allOff);
      expect(allow.size === 0, '白名单应为空，实际: ' + [...allow].join(','));
      const names = pluginNames(allOff);
      expect(names.length === 0, '不应挂载任何插件，实际: ' + names.join(','));
      const plan = planNames();
      expect(plan.mode === 'allow' && plan.names.length === 0, 'assembly 也应为空 allow');
      return { plugins: names };
    });

    // ── C6.2 shell 能力（技能脚本依赖它） ────────────────────
    check('shell 默认关闭：不挂 tool-bash、不放行 bash', async () => {
      const off = await runSetup({
        agent: { preset: '' },
        features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
        tools: { capabilities: { skills: true, imagegen: false, shell: false } },
      });
      expect(!pluginNames(off).includes('tool-bash'), '默认不应挂 tool-bash');
      expect(!allowSet(off).has('bash'), '默认不应放行 bash');
      return pluginNames(off);
    });

    check('打开 shell：挂 tool-bash 并放行 bash（技能脚本才能跑）', async () => {
      const on = await runSetup({
        agent: { preset: '' },
        features: { workspace: true, web: true, stickers: true, vision: true, memory: true },
        tools: { capabilities: { skills: true, imagegen: false, shell: true } },
      });
      expect(pluginNames(on).includes('tool-bash'), '应挂 tool-bash，实际: ' + pluginNames(on).join(','));
      expect(allowSet(on).has('bash'), '应放行 bash');
      const plan = planNames();
      expect(plan.names.includes('bash'), 'assembly 也应放行 bash');
      return { plugins: pluginNames(on), allow: allowSet(on).size };
    });

    // ── C6.5 新插件工具自动发现（默认拒绝 ≠ 加功能必须改代码） ──
    check('新插件注册的工具会被装配层标记为 dropped（无需改代码即可被发现）', async () => {
      const fake = makeFakeAgentCtx();
      manager.installToolFilter(fake, 'qqbot-buddy');
      const handler = fake.handlers['system-prompt/assemble'];
      expect(typeof handler === 'function', 'installToolFilter 应注册 system-prompt/assemble');
      const assembled = {
        tools: [
          { name: 'read', description: 'x' },
          { name: 'brand_new_plugin_tool', description: '来自新插件' },
        ],
        contexts: [],
        sections: [],
      };
      const out = await handler(assembled, {}, async () => assembled);
      const kept = (out.tools || []).map((tool) => tool.name);
      expect(kept.includes('read'), '已授权的 read 应保留');
      expect(!kept.includes('brand_new_plugin_tool'), '未授权的新工具应被屏蔽');
      const audit = manager.toolAudit;
      expect(audit && Array.isArray(audit.dropped), '应记录 toolAudit.dropped');
      expect(audit.dropped.includes('brand_new_plugin_tool'), 'dropped 应含新插件工具，实际: ' + JSON.stringify(audit.dropped));
      return { dropped: audit.dropped };
    });

    check('一键放行后再装配：新工具变可见且不再出现在 dropped', async () => {
      await settings.patch({ tools: { extraAllowed: ['brand_new_plugin_tool'] } });
      const fake = makeFakeAgentCtx();
      manager.installToolFilter(fake, 'qqbot-buddy');
      const handler = fake.handlers['system-prompt/assemble'];
      const assembled = { tools: [{ name: 'brand_new_plugin_tool', description: 'x' }], contexts: [], sections: [] };
      const out = await handler(assembled, {}, async () => assembled);
      expect((out.tools || []).some((tool) => tool.name === 'brand_new_plugin_tool'), '放行后应可见');
      expect(!manager.toolAudit.dropped.includes('brand_new_plugin_tool'), '放行后不应再记为 dropped');
      await settings.patch({ tools: { extraAllowed: [] } });
      return true;
    });

    // ── C7 诊断接口 ─────────────────────────────────────────
    check('runtime.toolCatalog.diagnose()：能力状态与放行集可用', () => {
      const diag = runtime.toolCatalog.diagnose();
      // 能力项数随能力表增长，这里只校验关键能力都在（不再硬编码总数）
      expect(Array.isArray(diag.capabilities) && diag.capabilities.length >= 7, '能力项数异常: ' + (diag.capabilities ? diag.capabilities.length : '?'));
      const ids = diag.capabilities.map((item) => item.id);
      for (const id of ['workspace', 'web', 'memory', 'stickers', 'vision', 'skills', 'imagegen', 'shell']) {
        expect(ids.includes(id), '诊断缺少能力 ' + id);
      }
      expect(Array.isArray(diag.allow), '诊断应含 allow 列表');
      return { allow: diag.allow.length, capabilities: ids };
    });

    // 恢复原始设置
    try { await settings.replace(original); } catch { /* ignore */ }

    const failed = results.filter((item) => item.ok !== true);
    const payload = { ok: failed.length === 0, total: results.length, failed: failed.length, results };
    if (outFile) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      const tmp = outFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, outFile);
    }
    ctx.logger?.info?.('[qa-capability-probe] ' + (payload.ok ? '全部通过' : '有失败') + ' ' + failed.length + '/' + results.length);
  })().catch((error) => {
    const payload = { ok: false, fatal: errText(error), results };
    if (outFile) {
      try {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
      } catch { /* ignore */ }
    }
  });
}
