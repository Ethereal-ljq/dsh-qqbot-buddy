#!/usr/bin/env node
/**
 * probe-tools.mjs —— 真实 dsh 冷会话探针（DESIGN-v2 §0.3 / M2 收尾验收）。
 *
 * 验收目标：同一个 bot+peer 上，首轮 assembly 与「dispose 后从持久化 resume」的冷会话
 * assembly 必须完全一致：
 *   - agent 可见工具集合（agentCtx.tools.view(agent).visible）两次相同；
 *   - 我们的 qqbot:* prompt 段两次都存在且文本一致；
 *   - 记录各 section 名字/摘要、assembly 工具声明、contexts、variables，供文档引用。
 *
 * 实现方式（不依赖任何宿主私有 API、不改 lib/**）：
 *   本文件同时是「驱动」和「被 dsh 加载的探针 plugin」：
 *   - 直接执行（node scripts/probe-tools.mjs）= 驱动：把自身复制到系统临时目录，
 *     生成 --patch 覆盖层（qqbot-buddy 隔离 config + 插入探针 plugin 行），
 *     在隔离 DSH_HOME 里后台起 dsh web，等待探针把 JSON 写到 .work/probe-tools.json；
 *   - 被 dsh 加载时（环境变量 QQBOT_PROBE_PLUGIN=1）= 探针 plugin：
 *     通过已安装插件的 getRuntime()（debug:false 也可用，不依赖 apply 返回值）拿 runtime，
 *     建/取 bot 会话 → assemble → dispose → 重新 getOrCreate（resume）→ 再 assemble → 断言。
 *
 * 探针文件必须放在「没有任何 package.json 祖先」的临时目录里运行：dsh 的 client-modules
 * 会按 loader row 的最近 package.json 判定 dsh.client；放在仓库内会被误认成 qqbot-buddy 包
 * （仓库 package.json 声明了 dsh.client 但没有 ./client 导出），导致 web profile 启动失败。
 *
 * 用法：
 *   node scripts/probe-tools.mjs                     # 默认：DSH_HOME=.work/integration/dsh-home
 *   node scripts/probe-tools.mjs --dsh-home /tmp/x --port 33085 --out .work/probe-tools.json
 *   DSH_BIN=/path/to/dsh node scripts/probe-tools.mjs
 *
 * 前提：目标 profile 已装 dsh-qqbot-buddy；未装时驱动会自动执行 scripts/install.mjs --local。
 * 退出码：0 = 冷会话一致；1 = 探针失败/断言不一致；2 = 环境/启动失败。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IS_PLUGIN = process.env.QQBOT_PROBE_PLUGIN === '1';
const PLUGIN_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(PLUGIN_FILE), '..');
const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errText = (err) => (err instanceof Error ? (err.stack || err.message) : String(err));

/* ───────────────────────────── 探针 plugin ───────────────────────────── */

export const name = 'qqbot-probe';

/** cordis plugin 入口：异步跑探针，不阻塞激活、不返回值（返回值会被当作 effect）。 */
export function apply() {
  if (!IS_PLUGIN) return;
  const out = process.env.QQBOT_PROBE_OUT || '';
  if (out === '') {
    console.error('[probe] 缺少 QQBOT_PROBE_OUT，探针无法上报');
    return;
  }
  setTimeout(() => {
    runProbe(out)
      .then((result) => writeResult(out, result))
      .catch((err) => writeResult(out, { ok: false, fatal: errText(err), generatedAt: new Date().toISOString() }));
  }, 300);
}

function writeResult(out, payload) {
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = out + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, out);
  } catch (err) {
    console.error('[probe] 写结果失败: ' + errText(err));
  }
  console.log('[probe] 结果已写入 ' + out + '（ok=' + payload.ok + '）');
}

/** 取插件 runtime：优先模块 getRuntime()（同一模块实例，见文件头说明），回退 debug 全局。 */
async function resolveRuntime(deadline) {
  const entry = process.env.QQBOT_PROBE_ENTRY || '';
  while (Date.now() < deadline) {
    if (entry !== '') {
      try {
        const mod = await import(pathToFileURL(entry).href);
        if (typeof mod.getRuntime === 'function') {
          const runtime = mod.getRuntime();
          if (runtime && runtime.host) return { runtime, source: 'getRuntime()' };
        }
      } catch (err) {
        console.log('[probe] import 插件入口失败（继续重试）: ' + errText(err).split('\n')[0]);
      }
    }
    const debug = globalThis.__QQBOT_V2_DEBUG__;
    if (debug && debug.runtime && debug.runtime.host) return { runtime: debug.runtime, source: '__QQBOT_V2_DEBUG__' };
    await SLEEP(300);
  }
  throw new Error('等待 qqbot-buddy runtime 超时（host/ctx 未就绪）');
}

function serviceOf(ctx, serviceName) {
  if (!ctx) return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const service = ctx.get(serviceName);
      if (service) return service;
    }
  } catch { /* ignore */ }
  return ctx[serviceName];
}

function textOf(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function truncate(text, max = 500) {
  const value = textOf(text);
  return value.length > max ? value.slice(0, max) + '…(' + value.length + ' chars)' : value;
}

/** 用 assembly.variables 把 {{name}} 占位渲染出来（只用于记录/对比，不改 assembly）。 */
function renderSectionText(text, variables) {
  const raw = textOf(text);
  return raw.replace(/\{\{([a-z][a-z0-9_]*)\}\}/gi, (match, key) => {
    const value = variables ? variables[key] : undefined;
    if (typeof value === 'string') return value;
    return match;
  });
}

/** 读一次 assembly + 工具可见性快照。 */
async function captureSnapshot(host, agent) {
  const hostCtx = host.ctx;
  const sp = serviceOf(hostCtx, 'systemPrompt');
  if (!sp || typeof sp.assemble !== 'function') throw new Error('宿主 systemPrompt.assemble 不可用');
  const agentCtx = agent.ctx;
  if (!agentCtx) throw new Error('agent.ctx 不可用（无法读取 scoped 工具视图）');
  const toolsService = serviceOf(agentCtx, 'tools');
  if (!toolsService || typeof toolsService.view !== 'function') throw new Error('宿主 tools.view 不可用');

  const assembly = await sp.assemble({ agent, scope: agent });
  const view = toolsService.view(agent);
  const sections = (Array.isArray(assembly.sections) ? assembly.sections : []).map((section) => ({
    name: textOf(section && section.name),
    chars: textOf(section && section.text).length,
    text: truncate(textOf(section && section.text), 400),
  }));
  const variables = assembly.variables && typeof assembly.variables === 'object' ? assembly.variables : {};
  const qqbotSections = [];
  for (const section of Array.isArray(assembly.sections) ? assembly.sections : []) {
    const sectionName = textOf(section && section.name);
    if (!sectionName.startsWith('qqbot:')) continue;
    const raw = textOf(section && section.text);
    qqbotSections.push({
      name: sectionName,
      chars: raw.length,
      renderedChars: renderSectionText(raw, variables).length,
      raw: truncate(raw, 200),
      rendered: truncate(renderSectionText(raw, variables), 400),
    });
  }
  const session = agent && agent.session ? agent.session : null;
  const variableValues = {};
  for (const [variableName, value] of Object.entries(variables)) {
    variableValues[variableName] = {
      type: typeof value,
      chars: typeof value === 'string' ? value.length : null,
      preview: typeof value === 'string' ? truncate(value, 160) : '',
    };
  }
  return {
    at: new Date().toISOString(),
    sessionId: session && session.id !== undefined ? String(session.id) : '',
    sessionEventCount: session && Array.isArray(session.log) ? session.log.length : null,
    sessionFirstLiveSeq: session && Number.isFinite(session.firstLiveSeq) ? session.firstLiveSeq : null,
    sessionInheritedEventCount: session && Number.isFinite(session.inheritedEventCount) ? session.inheritedEventCount : null,
    sections,
    sectionNames: sections.map((item) => item.name),
    qqbotSections,
    qqbotSectionNames: qqbotSections.map((item) => item.name),
    variables: Object.keys(variables).sort(),
    variableValues,
    contexts: (Array.isArray(assembly.contexts) ? assembly.contexts : []).map((entry) => textOf(entry && entry.name)),
    assemblyToolNames: (Array.isArray(assembly.tools) ? assembly.tools : []).map((tool) => textOf(tool && tool.name)).sort(),
    visibleToolNames: [...view.visible.keys()].map(String).sort(),
    knownToolNames: view.knownNames instanceof Set ? [...view.knownNames].map(String).sort() : [],
    restrictableToolNames: view.restrictableNames instanceof Set ? [...view.restrictableNames].map(String).sort() : [],
    promptChars: sections.reduce((sum, item) => sum + item.chars, 0),
  };
}

function sameStringSet(a, b) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function diffList(a, b) {
  const right = new Set(b);
  const left = new Set(a);
  return {
    onlyFirst: a.filter((value) => !right.has(value)),
    onlySecond: b.filter((value) => !left.has(value)),
  };
}

/** 探针主流程：首轮 assembly → dispose → 冷 resume → 再 assembly → 断言。 */
async function runProbe(out) {
  const timeoutMs = Number(process.env.QQBOT_PROBE_TIMEOUT_MS || 120000);
  const deadline = Date.now() + timeoutMs;
  const steps = [];
  const step = (text) => { steps.push(text); console.log('[probe] ' + text); };

  const resolved = await resolveRuntime(deadline);
  const runtime = resolved.runtime;
  step('拿到 runtime（来源 ' + resolved.source + '）: dataDir=' + textOf(runtime.paths && runtime.paths.dataDir));
  const host = runtime.host;

  // bot：优先用数据库里已有的；没有就建一个（enabled=false，不触发传输层）
  let bot = (() => {
    try { return runtime.config.listBots()[0] || null; } catch { return null; }
  })();
  if (!bot) {
    bot = runtime.config.createBot({ name: '冷会话探针号', appId: '', appSecret: '', enabled: false });
    host.bots.set(bot.id, bot);
    step('新建探针 bot: ' + bot.id);
  } else {
    step('复用已有 bot: ' + bot.id + '（enabled=' + bot.enabled + '）');
  }
  const instance = host.ensureRuntime(bot.id);
  if (!instance) throw new Error('host.ensureRuntime 返回空（bot 未进入宿主）');

  const peer = 'group:cold-probe';
  // 播种人设文件，让 qqbot:persona 段有非空文本，冷/热两次 assembly 才能做「文本一致」的实质断言
  const personaMarker = '冷会话探针人设：你是QQ群里的测试机器人，回答简短。';
  try {
    fs.mkdirSync(instance.cwd, { recursive: true });
    fs.writeFileSync(path.join(instance.cwd, 'persona.md'), personaMarker + '\n', 'utf8');
    step('播种 persona.md: ' + path.join(instance.cwd, 'persona.md'));
  } catch (err) {
    step('写 persona.md 失败（继续）: ' + errText(err).split('\n')[0]);
  }
  const dshHome = textOf(process.env.DSH_HOME);
  const sessionPersisted = () => {
    if (dshHome === '') return false;
    const root = path.join(dshHome, 'sessions');
    try {
      for (const project of fs.readdirSync(root)) {
        const dir = path.join(root, project, firstSessionId());
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          if (files.some((name) => name.startsWith('session.'))) return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  };
  let persistedSessionId = '';
  const firstSessionId = () => persistedSessionId;
  step('创建会话: bot=' + bot.id + ' peer=' + peer);
  const firstRecord = await instance.getOrCreate(peer);
  persistedSessionId = String(firstRecord.sessionId);
  const first = await captureSnapshot(host, firstRecord.agent);
  step('首轮 assembly: sections=' + first.sectionNames.length + ' tools=' + first.visibleToolNames.length
    + ' qqbot段=' + first.qqbotSectionNames.join(',') + ' session=' + first.sessionId);

  // 释放 agent（模拟会话结束 / 冷路径），并清掉宿主 live 缓存，下一次 getOrCreate 才会走 resume
  await SLEEP(300);
  const persistedBeforeDispose = sessionPersisted();
  step('释放 agent（handle.dispose）并清 live 缓存');
  try { await firstRecord.handle.dispose(); } catch (err) { step('dispose 抛错（记录后继续）: ' + errText(err).split('\n')[0]); }
  try { instance.sessions.delete(peer); } catch { /* ignore */ }
  try { host.sessionIndex.delete(String(firstRecord.sessionId)); } catch { /* ignore */ }
  await SLEEP(800);
  const persistedBeforeResume = sessionPersisted();
  step('会话持久化文件: dispose 前=' + persistedBeforeDispose + ' resume 前=' + persistedBeforeResume);

  step('冷路径重新 getOrCreate（应走 dsh 持久化 resume）');
  const secondRecord = await instance.getOrCreate(peer);
  const second = await captureSnapshot(host, secondRecord.agent);
  step('冷会话 assembly: sections=' + second.sectionNames.length + ' tools=' + second.visibleToolNames.length
    + ' qqbot段=' + second.qqbotSectionNames.join(',') + ' session=' + second.sessionId);

  // ── 断言 ──
  const toolsDiff = diffList(first.visibleToolNames, second.visibleToolNames);
  const toolsStable = toolsDiff.onlyFirst.length === 0 && toolsDiff.onlySecond.length === 0;
  const legacyQqbotNames = ['qqbot:persona', 'qqbot:guide'];
  const qqbotPresent = legacyQqbotNames.every((sectionName) =>
    first.qqbotSectionNames.includes(sectionName) && second.qqbotSectionNames.includes(sectionName));
  const qqbotNamesStable = sameStringSet(first.qqbotSectionNames, second.qqbotSectionNames);
  const firstBySection = new Map(first.qqbotSections.map((item) => [item.name, item.rendered]));
  const qqbotTextChanges = second.qqbotSections
    .filter((item) => firstBySection.has(item.name) && firstBySection.get(item.name) !== item.rendered)
    .map((item) => item.name);
  const qqbotTextStable = qqbotTextChanges.length === 0;
  const sectionsStable = sameStringSet(first.sectionNames, second.sectionNames);
  const agentRecreated = firstRecord.agent !== secondRecord.agent;
  const sessionIdStable = first.sessionId !== '' && first.sessionId === second.sessionId;

  const personaSection = (snapshot) => (snapshot.qqbotSections.find((item) => item.name === 'qqbot:persona') || {});
  const guideSection = (snapshot) => (snapshot.qqbotSections.find((item) => item.name === 'qqbot:guide') || {});
  const personaNonEmpty = (personaSection(first).renderedChars || 0) > 0
    && (personaSection(second).renderedChars || 0) > 0
    && (personaSection(first).rendered || '').includes(personaMarker);
  const resumeEvidence = {
    sessionEventCountFirst: first.sessionEventCount,
    sessionEventCountSecond: second.sessionEventCount,
    sessionInheritedEventCountSecond: second.sessionInheritedEventCount,
    note: '第二次 getOrCreate 未新建 session（sessionId 相同），事件数非零说明从持久化恢复',
  };
  const checks = {
    runtimeResolved: { pass: true, via: resolved.source },
    sessionIdStable: { pass: sessionIdStable, first: first.sessionId, second: second.sessionId },
    agentRecreated: { pass: agentRecreated, note: '释放后重新建/恢复了不同的 agent 实例' },
    toolsStable: { pass: toolsStable, count: first.visibleToolNames.length, diff: toolsDiff },
    assemblyToolsStable: { pass: sameStringSet(first.assemblyToolNames, second.assemblyToolNames), diff: diffList(first.assemblyToolNames, second.assemblyToolNames) },
    qqbotSectionsPresent: { pass: qqbotPresent, required: legacyQqbotNames, first: first.qqbotSectionNames, second: second.qqbotSectionNames },
    qqbotSectionNamesStable: { pass: qqbotNamesStable },
    qqbotTextStable: {
      pass: qqbotTextStable,
      changed: qqbotTextChanges,
      note: '渲染后文本（{{}} 已用 assembly.variables 展开）逐段一致',
    },
    qqbotPersonaNonEmpty: {
      pass: personaNonEmpty,
      marker: personaMarker,
      firstChars: personaSection(first).renderedChars,
      secondChars: personaSection(second).renderedChars,
      note: '人设段两次都渲染出非空文本，排除「空文本一致」的伪通过',
    },
    qqbotGuideDiagnostic: {
      pass: true,
      firstChars: guideSection(first).renderedChars || 0,
      secondChars: guideSection(second).renderedChars || 0,
      note: '工具指引段长度（0 = 工具指引链路未产出文本，见 SMOKE-REPORT 已知问题；不作为冷会话一致性判据）',
    },
    sessionPersisted: {
      pass: persistedBeforeResume === true,
      beforeDispose: persistedBeforeDispose,
      beforeResume: persistedBeforeResume,
      evidence: resumeEvidence,
    },
    sectionsStable: { pass: sectionsStable, diff: diffList(first.sectionNames, second.sectionNames) },
    variablesStable: { pass: sameStringSet(first.variables, second.variables), first: first.variables, second: second.variables },
    contextsStable: { pass: sameStringSet(first.contexts, second.contexts), first: first.contexts, second: second.contexts },
  };
  // ── 召回段验证（M4 接线）：记忆/知识命中时 qqbot:memory / qqbot:knowledge 必须非空 ──
  // 检索语义是「整串子串/短语匹配」（DESIGN §7.1），query 必须是种子文本的连续子串
  const recallQuery = '滨江公园';
  const memoryMarker = '探针长期记忆：管理员喜欢喝乌龙茶，常去滨江公园';
  const kbMarker = '探针知识条目：周五下午三点在滨江公园集合';
  const kbTitle = '探针知识库';
  const recallDebug = { seededMemory: false, seededKnowledge: false, followup: 'not-run' };
  try {
    if (runtime.memory && typeof runtime.memory.save === 'function') {
      runtime.memory.save({ botId: bot.id, text: memoryMarker, kind: 'fact', source: 'probe' });
      recallDebug.seededMemory = true;
    }
  } catch (err) { recallDebug.memoryError = errText(err).split('\n')[0]; }
  try {
    if (runtime.kb && typeof runtime.kb.ingest === 'function') {
      runtime.kb.ingest({ botId: bot.id, source: 'probe:kb', title: kbTitle, text: kbMarker });
      recallDebug.seededKnowledge = true;
    }
  } catch (err) { recallDebug.knowledgeError = errText(err).split('\n')[0]; }
  step('召回段验证：播种记忆/知识 → followup 触发召回（' + 'seededMemory=' + recallDebug.seededMemory + ' seededKnowledge=' + recallDebug.seededKnowledge + '）');
  try {
    const outcome = await Promise.race([
      instance.followup(peer, { text: recallQuery })
        .then((value) => ({ done: true, value }))
        .catch((err) => ({ done: true, error: errText(err).split('\n')[0] })),
      SLEEP(20000).then(() => ({ done: false, timeout: true })),
    ]);
    recallDebug.followup = outcome;
  } catch (err) { recallDebug.followup = { error: errText(err).split('\n')[0] }; }
  await SLEEP(1200);
  let third = null;
  try { third = await captureSnapshot(host, secondRecord.agent); } catch (err) {
    recallDebug.snapshotError = errText(err).split('\n')[0];
  }
  const recallSection = (snapshot, sectionName) => {
    if (!snapshot) return {};
    return snapshot.qqbotSections.find((item) => item.name === sectionName) || {};
  };
  const memoryRecallText = recallSection(third, 'qqbot:memory').rendered || '';
  const knowledgeRecallText = recallSection(third, 'qqbot:knowledge').rendered || '';
  checks.qqbotGuideNonEmpty = {
    pass: (guideSection(first).renderedChars || 0) > 0 && (guideSection(second).renderedChars || 0) > 0,
    firstChars: guideSection(first).renderedChars || 0,
    secondChars: guideSection(second).renderedChars || 0,
    note: '工具指引段两次都必须有文本（v2 用 agent scope 工具视图生成）',
  };
  checks.hostToolsMounted = {
    pass: first.visibleToolNames.length > 6
      && first.visibleToolNames.some((toolName) => ['read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch'].includes(toolName)),
    count: first.visibleToolNames.length,
    restrictable: first.restrictableToolNames,
    note: '插件工具之外还应有宿主工具（能力开关 workspace/web/memory 生效）',
  };
  checks.qqbotMemoryRecall = {
    pass: recallDebug.seededMemory === true && memoryRecallText.includes(memoryMarker),
    chars: memoryRecallText.length,
    preview: truncate(memoryRecallText, 240),
    seeded: recallDebug.seededMemory,
    followup: recallDebug.followup,
    note: '播种长期记忆 → followup 触发 recall → qqbot:memory 段应包含该记忆',
  };
  checks.qqbotKnowledgeRecall = {
    pass: recallDebug.seededKnowledge === true && knowledgeRecallText.includes(kbMarker),
    chars: knowledgeRecallText.length,
    preview: truncate(knowledgeRecallText, 240),
    seeded: recallDebug.seededKnowledge,
    note: '播种知识库 → followup 触发 kb.search → qqbot:knowledge 段应包含该知识',
  };
  try { await secondRecord.handle.dispose(); } catch { /* ignore */ }

  const ok = Object.values(checks).every((check) => check.pass === true);

  return {
    ok,
    generatedAt: new Date().toISOString(),
    node: process.version,
    pluginVersion: runtime.version || '',
    runtimeSource: resolved.source,
    dataDir: textOf(runtime.paths && runtime.paths.dataDir),
    workspaceRoot: textOf(runtime.paths && runtime.paths.workspaceRoot),
    botId: bot.id,
    peer,
    first,
    second,
    recall: {
      query: recallQuery,
      memoryMarker,
      kbMarker,
      debug: recallDebug,
      qqbotSections: third ? third.qqbotSections : null,
    },
    steps,
    checks,
  };
}

/* ───────────────────────────── 驱动模式 ───────────────────────────── */

function parseArgs(argv) {
  const out = {
    dshHome: path.join(REPO_ROOT, '.work', 'integration', 'dsh-home'),
    profile: 'web',
    port: 33085,
    out: path.join(REPO_ROOT, '.work', 'probe-tools.json'),
    timeoutMs: 180000,
    install: true,
    reinstall: false,
    keepTemp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dsh-home') out.dshHome = path.resolve(argv[++i]);
    else if (arg === '--profile') out.profile = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--out') out.out = path.resolve(argv[++i]);
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (arg === '--no-install') out.install = false;
    else if (arg === '--reinstall') out.reinstall = true;
    else if (arg === '--keep-temp') out.keepTemp = true;
    else if (arg === '--help' || arg === '-h') { printDriverHelp(); process.exit(0); }
    else { console.error('[probe] 未知参数: ' + arg); process.exit(2); }
  }
  out.out = path.resolve(out.out);
  out.log = path.join(path.dirname(out.out), 'probe-tools.log');
  return out;
}

function printDriverHelp() {
  console.log([
    '用法: node scripts/probe-tools.mjs [选项]',
    '',
    '  --dsh-home <dir>   隔离 DSH_HOME（默认 .work/integration/dsh-home）',
    '  --profile <name>   目标 profile（默认 web）',
    '  --port <n>         dsh web 主端口（默认 33085，需空闲）',
    '  --out <file>       探针 JSON 输出（默认 .work/probe-tools.json）',
    '  --timeout-ms <n>   探针整体超时（默认 180000）',
    '  --no-install       不自动补装插件（profile 里必须已装）',
    '  --reinstall        强制从当前仓库重新复制安装（验收当前工作树）',
    '  --keep-temp        保留临时探针目录（排查用）',
    '',
  ].join('\n'));
}

/** 探测 127.0.0.1:port 是否已被占用。 */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => { try { socket.destroy(); } catch { /* ignore */ } resolve(value); };
    socket.setTimeout(600);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 从 start 起找空闲端口（33085+ 避让同机其他实例）。 */
async function findFreePort(start) {
  for (let port = start; port < start + 30; port += 1) {
    if (!(await isPortOpen(port))) return port;
  }
  throw new Error('端口 ' + start + '~' + (start + 29) + ' 都被占用');
}

/** 找 dsh 可执行文件；优先与当前 node 同版本目录，其次 PATH，最后 nvm v24+。 */
function findDsh() {
  const candidates = [];
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN);
  const nodeDir = path.dirname(process.execPath);
  candidates.push(path.join(nodeDir, 'dsh'));
  candidates.push('dsh');
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmRoot)
      .filter((entry) => /^v(\d+)\./.test(entry))
      .sort((a, b) => Number(b.slice(1).split('.')[0]) - Number(a.slice(1).split('.')[0]) || b.localeCompare(a));
    for (const version of versions) candidates.push(path.join(nvmRoot, version, 'bin', 'dsh'));
  } catch { /* ignore */ }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const which = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (which.status === 0 && textOf(which.stdout).trim() !== '') return textOf(which.stdout).trim();
  }
  return '';
}

/** dsh 可执行文件所在 node 版本（用来提示 Node >= 24）。 */
function nodeVersionFor(dshBin) {
  const dir = path.dirname(dshBin);
  const node = path.join(dir, 'node');
  if (!fs.existsSync(node)) return '';
  const result = spawnSync(node, ['-v'], { encoding: 'utf8' });
  return textOf(result.stdout).trim();
}

function ensureInstalled(opts, dshBin) {
  const profileDir = path.join(opts.dshHome, 'profiles', opts.profile);
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    // 新 DSH_HOME：先让 dsh 从随附模板初始化 profile（否则 install 只会建个缺 base 的最小 manifest）
    const init = spawnSync(dshBin, ['--profile', opts.profile, '--dump-default-config'], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { DSH_HOME: opts.dshHome }),
      encoding: 'utf8',
    });
    if (init.status !== 0) throw new Error('初始化隔离 profile 失败: ' + String(init.stderr || '').slice(-800));
  }
  const installed = path.join(profileDir, 'node_modules', 'dsh-qqbot-buddy', 'package.json');
  let registered = false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    const bundles = manifest && manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles;
    registered = Array.isArray(bundles) && bundles.includes('dsh-qqbot-buddy');
  } catch { /* profile 未初始化 */ }
  if (fs.existsSync(installed) && registered && opts.reinstall !== true) return { installed: true, profileDir };
  if (opts.reinstall === true) {
    try { fs.rmSync(path.dirname(installed), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (!opts.install) throw new Error('profile 里没有安装 dsh-qqbot-buddy（' + profileDir + '）；去掉 --no-install 或先执行 node scripts/install.mjs --local --profile ' + opts.profile);
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'install.mjs'), '--local', '--profile', opts.profile], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { DSH_HOME: opts.dshHome }),
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('自动安装失败（exit ' + result.status + '）');
  return { installed: true, profileDir };
}

/** 把探针本体复制到系统临时目录（不能放在仓库内，见文件头说明）。 */
function stagePlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-cold-probe-'));
  const file = path.join(dir, 'probe-plugin.mjs');
  fs.copyFileSync(PLUGIN_FILE, file);
  return { dir, file };
}

function writePatch(opts, pluginFile, installedEntry) {
  const patchFile = path.join(path.dirname(pluginFile), 'probe.patch.yml');
  const probeDir = path.join(REPO_ROOT, '.work', 'probe-env');
  const workRoot = path.join(probeDir, 'workspace');
  const dataDir = path.join(probeDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });
  const yaml = [
    '# 冷会话探针专用覆盖层（由 scripts/probe-tools.mjs 生成，位于系统临时目录）',
    '- id: qqbot-buddy',
    '  config:',
    '    dataDir: ' + JSON.stringify(dataDir),
    '    workspaceRoot: ' + JSON.stringify(workRoot),
    '    debug: true',
    '    autoStart: false',
    '    console:',
    '      enabled: false',
    '- insert:',
    '    - id: qqbot-probe',
    '      name: ' + JSON.stringify(pluginFile),
    '',
  ].join('\n');
  fs.writeFileSync(patchFile, yaml, 'utf8');
  return { patchFile, dataDir, workRoot, installedEntry };
}

function tailFile(file, lines = 40) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim().split('\n');
    return text.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

async function runDriver() {
  const opts = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(opts.port) || opts.port <= 0) throw new Error('--port 非法');
  const dshBin = findDsh();
  if (dshBin === '') throw new Error('找不到 dsh 可执行文件（可用 DSH_BIN 指定）');
  const requestedPort = opts.port;
  opts.port = await findFreePort(opts.port);
  if (opts.port !== requestedPort) console.log('[probe] 端口避让：dsh web ' + requestedPort + ' 被占用 → ' + opts.port);
  const nodeVer = nodeVersionFor(dshBin);
  if (nodeVer !== '' && Number(nodeVer.replace(/^v/, '').split('.')[0]) < 24) {
    throw new Error('dsh 所在 Node ' + nodeVer + ' < 24；请用 Node 24 的 dsh（--help 见 DSH_BIN）');
  }
  console.log('[probe] dsh=' + dshBin + ' node=' + (nodeVer || '(未知)'));
  console.log('[probe] DSH_HOME=' + opts.dshHome + ' profile=' + opts.profile + ' out=' + opts.out);

  const { profileDir } = ensureInstalled(opts, dshBin);
  const entry = path.join(profileDir, 'node_modules', 'dsh-qqbot-buddy', 'lib', 'index.js');
  if (!fs.existsSync(entry)) throw new Error('已安装插件入口不存在: ' + entry);

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.mkdirSync(path.dirname(opts.log), { recursive: true });
  try { fs.rmSync(opts.out, { force: true }); } catch { /* ignore */ }
  // 每次探针用全新的 DB/workspace：首次 getOrCreate 一定走 create，第二次才走持久化 resume
  try { fs.rmSync(path.join(REPO_ROOT, '.work', 'probe-env'), { recursive: true, force: true }); } catch { /* ignore */ }

  const staged = stagePlugin();
  const stagedMeta = writePatch(opts, staged.file, entry);
  const logStream = fs.createWriteStream(opts.log, { flags: 'w' });
  const env = Object.assign({}, process.env, {
    DSH_HOME: opts.dshHome,
    PATH: path.dirname(dshBin) + path.delimiter + textOf(process.env.PATH),
    QQBOT_PROBE_PLUGIN: '1',
    QQBOT_PROBE_ENTRY: entry,
    QQBOT_PROBE_OUT: opts.out,
    QQBOT_PROBE_TIMEOUT_MS: String(Math.max(30000, opts.timeoutMs - 30000)),
  });
  console.log('[probe] 启动隔离 dsh web（port=' + opts.port + '，日志 ' + opts.log + '）');
  const child = spawn(dshBin, [
    '--profile', opts.profile,
    '--patch', stagedMeta.patchFile,
    '--port', String(opts.port),
    '--no-open',
  ], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => logStream.write(chunk));
  child.stderr.on('data', (chunk) => logStream.write(chunk));
  let childExit = null;
  child.on('exit', (code, signal) => { childExit = { code, signal }; });

  const deadline = Date.now() + opts.timeoutMs;
  let payload = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(opts.out)) {
      try { payload = JSON.parse(fs.readFileSync(opts.out, 'utf8')); } catch { payload = null; }
      if (payload) break;
    }
    if (childExit && childExit.code !== null) break;
    await SLEEP(400);
  }

  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  const killDeadline = Date.now() + 8000;
  while (childExit === null && Date.now() < killDeadline) await SLEEP(200);
  if (childExit === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  await SLEEP(300);
  try { logStream.end(); } catch { /* ignore */ }
  if (!opts.keepTemp) { try { fs.rmSync(staged.dir, { recursive: true, force: true }); } catch { /* ignore */ } }

  if (!payload) {
    console.error('[probe] 失败：未拿到探针结果（dsh exit=' + JSON.stringify(childExit) + '）');
    console.error('[probe] 日志尾部:\n' + tailFile(opts.log));
    process.exit(2);
  }
  payload.driver = {
    dshBin,
    dshNode: nodeVer,
    profile: opts.profile,
    dshHome: opts.dshHome,
    patchFile: opts.keepTemp ? stagedMeta.patchFile : '(已清理)',
    log: opts.log,
    dshExit: childExit,
  };
  fs.writeFileSync(opts.out, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('[probe] ===== 冷会话探针结论 =====');
  console.log('[probe] runtime 来源 : ' + (payload.runtimeSource || payload.checks?.runtimeResolved?.via || '-'));
  console.log('[probe] 工具集合     : ' + (payload.first ? payload.first.visibleToolNames.join(', ') : '-'));
  console.log('[probe] qqbot 段     : ' + (payload.first ? payload.first.qqbotSectionNames.join(', ') : '-'));
  for (const [checkName, check] of Object.entries(payload.checks || {})) {
    console.log('[probe] ' + (check.pass ? 'PASS' : 'FAIL') + ' ' + checkName + (check.pass ? '' : ' ' + JSON.stringify(check).slice(0, 300)));
  }
  console.log('[probe] 整体: ' + (payload.ok ? 'PASS' : 'FAIL') + '（' + opts.out + '）');
  process.exit(payload.ok ? 0 : 1);
}

const ENTRY_URL = pathToFileURL(PLUGIN_FILE).href;
function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return pathToFileURL(fs.realpathSync(argv1)).href === ENTRY_URL; } catch { return false; }
}

if (!IS_PLUGIN && isMainModule()) {
  runDriver().catch((err) => {
    console.error('[probe] 驱动异常: ' + errText(err));
    process.exit(2);
  });
}
