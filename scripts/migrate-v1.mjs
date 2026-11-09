#!/usr/bin/env node
/**
 * v1 → v2 数据迁移器（幂等、默认 dry-run 可看摘要）。
 *
 * 迁移内容：
 *   1. settings.json（v0.x 运行期设置）→ v2 Bot/Profile 分层设置（按 schema 归一化，未知项只告警）
 *   2. persona.md → <bot cwd>/persona.md + personas 表（active 卡）
 *   3. memory/*.md → <bot cwd>/memory/ 备份 + memories 表（按行/段落拆条，source='v1-memory'）
 *   4. knowledge/ 目录 → kb.ingest（md/txt/json，按文件）
 *   5. stickers/ 目录 → <bot cwd>/stickers/ + stickers 表（hash 去重）
 *   6. sessions.json 不迁移（v2 sessionId 由 (botId,peer,epoch) 确定性派生，旧会话无法安全复用）
 *
 * 用法：
 *   node scripts/migrate-v1.mjs --dry-run
 *   node scripts/migrate-v1.mjs --from ~/.dsh-qqbot/buddy --to ~/.dsh-qqbot/v2 --bot-name 主号
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { openDb } from '../lib/core/db.js';
import { createConfigStore } from '../lib/core/config/store.js';
import { createKbStore } from '../lib/core/kb/store.js';
import { createMemoryStore } from '../lib/core/memory/store.js';
import { createStickersStore } from '../lib/core/stickers/store.js';
import { createMembersStore } from '../lib/core/members/store.js';

const FLAG = '[migrate-v1]';
const log = (msg) => process.stdout.write(FLAG + ' ' + msg + '\n');
const warn = (msg) => process.stderr.write(FLAG + ' 警告: ' + msg + '\n');
const errText = (err) => (err instanceof Error ? err.message : String(err));

function parseArgs(argv) {
  const out = {
    from: path.join(os.homedir(), '.dsh-qqbot', 'buddy'),
    to: path.join(os.homedir(), '.dsh-qqbot', 'v2'),
    workspace: path.join(os.homedir(), 'my-bot'),
    v1cwd: '',
    patch: '',
    v1Bots: '',
    botName: '迁移机器人',
    dryRun: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') out.from = path.resolve(argv[++i]);
    else if (arg === '--to') out.to = path.resolve(argv[++i]);
    else if (arg === '--workspace') out.workspace = path.resolve(argv[++i]);
    else if (arg === '--v1-cwd') out.v1cwd = path.resolve(argv[++i]);
    else if (arg === '--patch') out.patch = path.resolve(argv[++i]);
    else if (arg === '--v1-bots') out.v1Bots = path.resolve(argv[++i]);
    else if (arg === '--bot-name') out.botName = argv[++i];
    else if (arg === '--apply') out.dryRun = false;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') { console.log('用法: node scripts/migrate-v1.mjs [--from DIR] [--to DIR] [--workspace DIR] [--bot-name NAME] [--apply]'); process.exit(0); }
    else { console.error(FLAG + ' 未知参数: ' + arg); process.exit(1); }
  }
  return out;
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const hashFile = (file) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
};
const listFiles = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => path.join(dir, d.name)); } catch { return []; }
};

/** v1 settings → v2 profile 层补丁（只映射能表达的；其余进 warnings）。 */
function mapSettings(v1, warnings) {
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const secondsToMs = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) * 1000 : fallback);
  const profile = {};
  const reply = v1.reply && typeof v1.reply === 'object' ? v1.reply : {};
  const triggers = v1.triggers && typeof v1.triggers === 'object' ? v1.triggers : {};
  const adaptive = reply.adaptive && typeof reply.adaptive === 'object' ? reply.adaptive : {};
  const modeMap = {
    always: 'always', every: 'always', all: 'always',
    probability: 'probability', random: 'probability',
    interval: 'interval',
    adaptive: 'adaptive',
    mention: 'mention', wake: 'mention', at: 'mention', only_mention: 'mention', off: 'mention',
  };
  if (reply.enabled !== undefined) profile.reply = { ...(profile.reply || {}), enabled: Boolean(reply.enabled) };
  const mappedMode = modeMap[String(reply.groupMode || '')];
  if (mappedMode) profile.reply = { ...(profile.reply || {}), mode: mappedMode };
  else if (reply.groupMode) warnings.push('reply.groupMode 未识别: ' + reply.groupMode + '（回落 adaptive）');
  if (reply.probability !== undefined) profile.reply = { ...(profile.reply || {}), probability: num(reply.probability, 0.3) };
  if (adaptive.debounceSeconds !== undefined) profile.reply = { ...(profile.reply || {}), debounceMs: secondsToMs(adaptive.debounceSeconds, 1500) };
  if (adaptive.cooldownSeconds !== undefined) profile.reply = { ...(profile.reply || {}), cooldownMs: secondsToMs(adaptive.cooldownSeconds, 8000) };
  if (adaptive.maxWaitSeconds !== undefined) profile.reply = { ...(profile.reply || {}), maxWaitMs: secondsToMs(adaptive.maxWaitSeconds, 12000) };
  if (reply.intervalSeconds !== undefined) profile.reply = { ...(profile.reply || {}), intervalMs: secondsToMs(reply.intervalSeconds, 60000) };
  if (triggers.onMention !== undefined) profile.reply = { ...(profile.reply || {}), mentionAlways: Boolean(triggers.onMention) };
  if (triggers.onReplyToBot !== undefined) profile.reply = { ...(profile.reply || {}), quoteAlways: Boolean(triggers.onReplyToBot) };
  if (Array.isArray(triggers.keywords)) profile.reply = { ...(profile.reply || {}), keywords: triggers.keywords, keywordsAlways: true };
  if (reply.bubbleSplit !== undefined) profile.reply = { ...(profile.reply || {}), splitBubbles: reply.bubbleSplit !== 'off' };

  const model = v1.model && typeof v1.model === 'object' ? v1.model : {};
  profile.model = {};
  if (model.provider) profile.model.provider = String(model.provider);
  if (model.model) profile.model.model = String(model.model);
  if (model.reasoningEffort) profile.model.reasoningEffort = String(model.reasoningEffort);
  if (v1.agent && v1.agent.preset) profile.model.preset = String(v1.agent.preset);

  const features = v1.features && typeof v1.features === 'object' ? v1.features : {};
  const toolsCaps = v1.tools && v1.tools.capabilities && typeof v1.tools.capabilities === 'object' ? v1.tools.capabilities : {};
  profile.tools = { capabilities: {} };
  for (const key of ['workspace', 'web', 'memory', 'stickers', 'vision']) {
    if (features[key] !== undefined) profile.tools.capabilities[key] = Boolean(features[key]);
  }
  if (toolsCaps.skills !== undefined) profile.tools.capabilities.skills = Boolean(toolsCaps.skills);
  if (toolsCaps.imagegen !== undefined) profile.tools.capabilities.imagegen = Boolean(toolsCaps.imagegen);
  if (toolsCaps.shell !== undefined) profile.tools.capabilities.workspace = Boolean(toolsCaps.shell);
  if (Array.isArray(v1.tools?.extraAllowed)) profile.tools.allow = v1.tools.extraAllowed;
  const skills = v1.tools && v1.tools.skills && typeof v1.tools.skills === 'object' ? v1.tools.skills : {};
  if (skills.mode) profile.tools.skillsMode = skills.mode === 'all' ? 'all' : 'allow';
  if (Array.isArray(skills.allowed)) profile.tools.skills = skills.allowed;

  const persona = v1.persona && typeof v1.persona === 'object' ? v1.persona : {};
  profile.persona = {};
  if (persona.suppressRuntimeContext !== undefined) profile.persona.suppressRuntimeContext = Boolean(persona.suppressRuntimeContext);
  const extra = [persona.groupExtraPrompt, persona.directExtraPrompt, v1.behavior?.extraInstructions].filter((x) => typeof x === 'string' && x.trim() !== '');
  if (extra.length > 0) profile.persona.extraPrompt = extra.join('\n\n');

  const memory = v1.memory && typeof v1.memory === 'object' ? v1.memory : {};
  profile.memory = {};
  if (memory.enabled !== undefined) profile.memory.enabled = Boolean(memory.enabled);
  if (memory.injectMaxChars !== undefined) profile.memory.recallChars = num(memory.injectMaxChars, 1200);
  const auto = memory.autoCollect && typeof memory.autoCollect === 'object' ? memory.autoCollect : {};
  if (auto.enabled === false) profile.memory.autoExtractEvery = 0;
  else if (auto.everyRounds !== undefined) profile.memory.autoExtractEvery = num(auto.everyRounds, 10);

  const membersCfg = v1.members && typeof v1.members === 'object' ? v1.members : {};
  profile.members = {};
  if (membersCfg.enabled !== undefined) profile.members.enabled = Boolean(membersCfg.enabled);
  if (membersCfg.injectSender !== undefined) profile.members.injectSender = Boolean(membersCfg.injectSender);
  if (membersCfg.maxPerTurn !== undefined) profile.members.maxPerTurn = num(membersCfg.maxPerTurn, 3);
  if (membersCfg.maxChars !== undefined) profile.members.maxChars = num(membersCfg.maxChars, 800);
  if (Object.keys(profile.members).length === 0) delete profile.members;

  const stickers = v1.stickers && typeof v1.stickers === 'object' ? v1.stickers : {};
  if (stickers.dailyLimit !== undefined) profile.stickers = { dailyQuota: num(stickers.dailyLimit, 30) };

  const admin = v1.admin && typeof v1.admin === 'object' ? v1.admin : {};
  const adminPatch = {};
  if (admin.enabled !== undefined) adminPatch.enabled = Boolean(admin.enabled);
  if (Array.isArray(admin.openids)) adminPatch.openids = admin.openids;

  // 无法表达的部分显式告警，避免"以为迁过来了"
  for (const key of ['phrases', 'prompts', 'triggers']) {
    if (v1[key] !== undefined) warnings.push('v1.' + key + ' 在 v2 暂无对应 UI，已写入 <bot cwd>/migrated/v1-' + key + '.json');
  }
  if (Array.isArray(v1.phrases?.items) && v1.phrases.items.length > 0) {
    warnings.push('口头禅 ' + v1.phrases.items.length + ' 条待接入（v2 规划中）');
  }
  return { profile, admin: adminPatch };
}

/** 从 v1 profile 的 cordis.patch.yml 里抠出 qqbot-buddy 的 appId/appSecret（避免引 yaml 依赖）。 */
function readPatchCredentials(patchFile) {
  try {
    const text = fs.readFileSync(patchFile, 'utf8');
    // 只取 qqbot-buddy 那段（到下一个顶层 "- " 或文件尾）
    const start = text.search(/^- id: qqbot-buddy\b/m);
    if (start < 0) return null;
    const rest = text.slice(start);
    const nextTop = rest.slice(1).search(/^\S/m) >= 0 ? rest.slice(1).search(/^- /m) : -1;
    const block = nextTop >= 0 ? rest.slice(0, nextTop + 1) : rest;
    const appId = (block.match(/appId:\s*['"]?([0-9A-Za-z_-]+)['"]?/) || [])[1] || '';
    const appSecret = (block.match(/appSecret:\s*['"]?([0-9A-Za-z_-]+)['"]?/) || [])[1] || '';
    return appId !== '' ? { appId, appSecret } : null;
  } catch {
    return null;
  }
}

/** 读 v1 workspace 的 bots.json（机器人名/启用状态）。 */
function readV1Bots(file) {
  const data = readJson(file, null);
  const list = data && Array.isArray(data.bots) ? data.bots : [];
  return list.filter((item) => item && typeof item === 'object');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const settingsFile = path.join(opts.from, 'settings.json');
  const v1 = readJson(settingsFile, null);
  if (!v1) {
    console.error(FLAG + ' 找不到 v1 settings.json: ' + settingsFile);
    process.exit(1);
  }
  const warnings = [];
  const { profile, admin } = mapSettings(v1, warnings);

  // v1 读取目录：优先 settings 里的绝对路径，其次 --v1-cwd，最后 workspace（兼容旧用法）
  const v1cwd = opts.v1cwd
    || (typeof v1.persona?.path === 'string' && v1.persona.path !== '' ? path.dirname(v1.persona.path) : '')
    || (typeof v1.memory?.dir === 'string' && v1.memory.dir !== '' ? path.dirname(v1.memory.dir) : '')
    || opts.workspace;
  const personaPath = typeof v1.persona?.path === 'string' && v1.persona.path !== ''
    ? v1.persona.path
    : path.join(v1cwd, 'persona.md');
  const memoryDir = typeof v1.memory?.dir === 'string' && v1.memory.dir !== '' ? v1.memory.dir : path.join(v1cwd, 'memory');
  const stickersDir = typeof v1.stickers?.dir === 'string' && v1.stickers.dir !== '' ? v1.stickers.dir : path.join(v1cwd, 'stickers');
  const knowledgeDir = path.join(v1cwd, 'knowledge');

  // v1 凭据 / 机器人元数据（可选，用于"原地升级同一个 bot"）
  const patchCreds = opts.patch ? readPatchCredentials(opts.patch) : null;
  const v1Bots = opts.v1Bots
    ? readV1Bots(opts.v1Bots)
    : readV1Bots(path.join(v1cwd, 'bots.json'));
  const primaryBot = v1Bots.find((item) => item.enabled !== false) || v1Bots[0] || null;
  if (primaryBot && primaryBot.name && opts.botName === '迁移机器人') opts.botName = String(primaryBot.name);
  const creds = patchCreds || (primaryBot && primaryBot.appId
    ? { appId: String(primaryBot.appId), appSecret: '' }
    : null);

  const counts = {
    persona: fs.existsSync(personaPath) ? 1 : 0,
    memoryFiles: listFiles(memoryDir).length,
    knowledgeFiles: listFiles(knowledgeDir).length,
    stickerFiles: listFiles(stickersDir).length,
  };

  log('v1 源   : ' + opts.from + '  (工作区 ' + v1cwd + ')');
  log('v2 目标 : ' + opts.to + '  (workspace ' + opts.workspace + ')');
  log('bot     : ' + opts.botName + '  cwd=<workspace>/bots/<id>');
  log('迁移摘要: ' + JSON.stringify(counts));
  log('机器人   : ' + opts.botName + (creds && creds.appId ? '  appId=' + creds.appId : '  (无凭据)')
    + (creds && creds.appSecret ? '  appSecret=已读取' : ''));
  if (warnings.length > 0) {
    log('需要人工关注的项：');
    for (const item of warnings) log('  - ' + item);
  }
  if (opts.dryRun) {
    log('dry-run：未写入。加 --apply 执行。');
    log('映射后的 profile 层设置: ' + JSON.stringify(profile).slice(0, 800));
    return;
  }

  // ── 实际写入 ──
  fs.mkdirSync(opts.to, { recursive: true });
  const db = openDb(path.join(opts.to, 'buddy.db'));
  const config = createConfigStore({ db, workspaceRoot: opts.workspace });
  const kb = createKbStore({ db });
  const memory = createMemoryStore({ db });
  const stickers = createStickersStore({ db, logger: { warn: (m) => warn(m), info: () => {}, debug: () => {} } });
  const members = createMembersStore({ db });

  let bot = config.listBots().find((item) => item.name === opts.botName) || null;
  // 不指定 cwd：v2 约定 <workspace>/bots/<botId>，与 v1 目录隔离，迁移不会写回 v1 数据
  if (!bot) bot = config.createBot({ name: opts.botName });
  else log('bot 已存在，增量迁移: ' + bot.id);
  // 凭据写进 v2 DB（v2 不再从 patch 读 appId/appSecret）
  if (creds && creds.appId) {
    bot = config.updateBot(bot.id, {
      appId: creds.appId,
      ...(creds.appSecret ? { appSecret: creds.appSecret } : {}),
      ...(primaryBot && primaryBot.enabled !== undefined ? { enabled: Boolean(primaryBot.enabled) } : {}),
    });
    log('凭据已写入 bot: appId=' + bot.appId + (creds.appSecret ? '（appSecret 已保存）' : '（仅 appId）'));
  }

  const botCwd = bot.cwd || path.join(opts.workspace, 'bots', bot.id);
  fs.mkdirSync(botCwd, { recursive: true });

  // 设置：profile 层 + bot 层
  const patch = { ...profile };
  const result = config.patchSettings(bot.id, patch);
  if (result.warnings.length > 0) for (const item of result.warnings) warn('设置归一化: ' + item);
  if (Object.keys(admin).length > 0) config.patchSettings(bot.id, { admin });

  // persona
  if (fs.existsSync(personaPath)) {
    const text = fs.readFileSync(personaPath, 'utf8');
    const id = 'prs_migrated';
    db.prepare(`INSERT INTO personas(id, bot_id, name, content, active, created_at, updated_at)
      VALUES(?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, active = 1, updated_at = excluded.updated_at`)
      .run(id, bot.id, '迁移人设', text, Date.now(), Date.now());
    fs.writeFileSync(path.join(botCwd, 'persona.md'), text, { mode: 0o600 });
    log('人设已迁移');
  }

  // 记忆：优先 v1 memory/index.json 的 facts（结构化、带 tags/时间），否则退化为 MEMORY.md 行
  const memoryDest = path.join(botCwd, 'memory');
  fs.mkdirSync(memoryDest, { recursive: true });
  for (const file of listFiles(memoryDir)) {
    if (file.endsWith('.json')) continue; // 索引由下面解析，不按行拆
    try { fs.copyFileSync(file, path.join(memoryDest, path.basename(file))); } catch (err) { warn('复制记忆文件失败 ' + file + ': ' + errText(err)); }
  }
  // 递归复制 notes/ 子目录
  try {
    for (const entry of fs.readdirSync(memoryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcDir = path.join(memoryDir, entry.name);
      const destDir = path.join(memoryDest, entry.name);
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of listFiles(srcDir)) fs.copyFileSync(file, path.join(destDir, path.basename(file)));
    }
  } catch { /* 目录不存在忽略 */ }

  let memoryCount = 0;
  let memorySource = '';
  // 幂等：迁移来源标记为 v1-memory，重跑前清掉旧行，避免多跑几次成倍增长
  try {
    const cleared = db.prepare("DELETE FROM memories WHERE bot_id = ? AND source = 'v1-memory'").run(bot.id);
    if (cleared && cleared.changes > 0) log('已清理上一次迁移的 v1-memory 行: ' + cleared.changes);
  } catch (err) { warn('清理旧迁移记忆失败（忽略）: ' + errText(err)); }
  const indexFile = path.join(memoryDir, 'index.json');
  const index = readJson(indexFile, null);
  if (index && Array.isArray(index.facts)) {
    memorySource = 'index.json';
    for (const fact of index.facts) {
      const text = typeof fact?.text === 'string' ? fact.text.trim() : '';
      if (text === '') continue;
      try {
        const saved = memory.save({
          botId: bot.id,
          text: text.slice(0, 2000),
          kind: 'fact',
          tags: Array.isArray(fact.tags) ? fact.tags.filter((x) => typeof x === 'string') : [],
          source: 'v1-memory',
        });
        if (saved && saved.created !== false) memoryCount += 1;
      } catch (err) { warn('记忆迁移失败: ' + errText(err)); }
    }
  } else {
    memorySource = 'MEMORY.md';
    const mdFile = path.join(memoryDir, 'MEMORY.md');
    if (fs.existsSync(mdFile)) {
      const text = fs.readFileSync(mdFile, 'utf8');
      for (const line of text.split(/\n+/).map((x) => x.replace(/^[-*\d.、\s]+/, '').trim()).filter((x) => x.length >= 6)) {
        const saved = memory.save({ botId: bot.id, text: line.slice(0, 2000), kind: 'fact', source: 'v1-memory' });
        if (saved && saved.created !== false) memoryCount += 1;
      }
    }
  }
  log('记忆已迁移: ' + memoryCount + ' 条（来源 ' + memorySource + '；文件已复制到 <bot cwd>/memory）');

  // 知识库：v1 权威数据是 knowledge/entries/<id>.md（frontmatter + 正文），
  // index.json 只是索引，绝不能当文档整块入库（历史上误入过，这里顺手清理）。
  try {
    const stale = kb.removeDoc({ botId: bot.id, source: 'v1:index.json' });
    if (stale && stale.removed) log('已清理历史误入库的 knowledge/index.json');
  } catch (err) { warn('清理历史知识库误入库失败（忽略）: ' + errText(err)); }
  let kbCount = 0;
  const kbEntriesDir = path.join(knowledgeDir, 'entries');
  const kbSources = [];
  const kbFiles = listFiles(kbEntriesDir).filter((file) => file.toLowerCase().endsWith('.md'));
  if (kbFiles.length > 0) {
    for (const file of kbFiles) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        const head = fm ? fm[1] : '';
        const body = (fm ? raw.slice(fm[0].length) : raw).trim();
        if (body === '') continue;
        const titleLine = (head.match(/^title:\s*(.+)$/m) || [])[1] || path.basename(file, '.md');
        const title = titleLine.trim().replace(/^["']|["']$/g, '').slice(0, 200);
        const id = path.basename(file, '.md');
        kb.ingest({ botId: bot.id, source: 'v1-kb:' + id, title, text: body });
        kbSources.push(id);
        kbCount += 1;
      } catch (err) { warn('知识条目迁移失败 ' + file + ': ' + errText(err)); }
    }
  } else {
    // 兼容没有 entries/ 的旧 workspace：直接迁移 md/txt 文件（跳过 index.json）
    for (const file of listFiles(knowledgeDir)) {
      const ext = path.extname(file).toLowerCase();
      if (!['.md', '.txt', '.markdown'].includes(ext)) continue;
      try {
        kb.ingest({ botId: bot.id, source: 'v1:' + path.relative(knowledgeDir, file), title: path.basename(file), text: fs.readFileSync(file, 'utf8') });
        kbCount += 1;
      } catch (err) { warn('知识库入库失败 ' + file + ': ' + errText(err)); }
    }
  }
  log('知识库已迁移: ' + kbCount + ' 条（entries/*.md，源前缀 v1-kb:）');

  // 群友库：权威数据在 members/entries/*.md 的 frontmatter（meta 是 JSON 字符串），
  // index.json 不含 meta / openid，不能作为数据源。
  let memberCount = 0;
  const membersEntriesDir = path.join(opts.workspace, 'members', 'entries');
  for (const file of listFiles(membersEntriesDir).filter((item) => item.toLowerCase().endsWith('.md'))) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const head = fm ? fm[1] : '';
      let meta = {};
      const metaLine = (head.match(/^meta:\s*(\{.*\})\s*$/m) || [])[1];
      if (metaLine) { try { meta = JSON.parse(metaLine); } catch { meta = {}; } }
      const openid = typeof meta.openid === 'string' && meta.openid !== '' ? meta.openid : '';
      if (openid === '') continue;
      const titleLine = (head.match(/^title:\s*(.+)$/m) || [])[1] || '';
      const tagsLine = (head.match(/^tags:\s*\[(.*)\]\s*$/m) || [])[1] || '';
      const tags = tagsLine.split(',').map((item) => item.trim()).filter(Boolean);
      const profileJson = {
        ...(meta.profile && typeof meta.profile === 'object' ? meta.profile : {}),
        aliases: Array.isArray(meta.aliases) ? meta.aliases : [],
        tags,
        groups: meta.groups && typeof meta.groups === 'object' ? meta.groups : {},
        profileSource: meta.profileSource || '',
      };
      members.upsert({
        botId: bot.id,
        openid,
        nickname: typeof meta.name === 'string' && meta.name !== '' ? meta.name : titleLine.trim(),
        profileJson,
      });
      memberCount += 1;
    } catch (err) { warn('群友迁移失败 ' + file + ': ' + errText(err)); }
  }
  log('群友库已迁移: ' + memberCount + ' 位（来源 members/entries/*.md）');

  // 人格卡：personas/index.json 的 cards + 对应 md 文件
  // 先清空 active 保证「同 bot 唯一 active」不变量（之前多次迁移出现过两个 active）
  try { db.prepare('UPDATE personas SET active = 0 WHERE bot_id = ?').run(bot.id); } catch (err) { warn('重置人格卡 active 失败（忽略）: ' + errText(err)); }
  let personaCardCount = 0;
  let personaActiveSet = false;
  const personasIndex = readJson(path.join(opts.workspace, 'personas', 'index.json'), null)
    || readJson(path.join(v1cwd, 'personas', 'index.json'), null);
  if (personasIndex && Array.isArray(personasIndex.cards)) {
    const personasDir = path.dirname(path.join(opts.workspace, 'personas', 'index.json'));
    for (const card of personasIndex.cards) {
      if (!card || typeof card.id !== 'string' || card.id === '') continue;
      try {
        const file = path.join(personasDir, String(card.file || card.id + '.md'));
        const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (content.trim() === '') continue;
        const active = personasIndex.activeId === card.id ? 1 : 0;
        if (active === 1) personaActiveSet = true;
        db.prepare(`INSERT OR REPLACE INTO personas(id, bot_id, name, content, active, created_at, updated_at)
          VALUES(?,?,?,?,?,?,?)`)
          .run(card.id, bot.id, String(card.name || card.id).slice(0, 80), content, active, Date.now(), Date.now());
        personaCardCount += 1;
      } catch (err) { warn('人格卡迁移失败 ' + card.id + ': ' + errText(err)); }
    }
  }
  // 没有任何卡片被标为 active 时，用 persona.md 快照兜底（human 可读的那份）
  if (!personaActiveSet) {
    try {
      const snap = db.prepare("SELECT id FROM personas WHERE bot_id = ? AND id = 'prs_migrated'").get(bot.id);
      if (snap) db.prepare("UPDATE personas SET active = 1, name = COALESCE(NULLIF(name, ''), ?) WHERE id = 'prs_migrated' AND bot_id = ?").run('v1 人设快照', bot.id);
    } catch (err) { warn('兜底激活人设快照失败（忽略）: ' + errText(err)); }
  }
  log('人格卡已迁移: ' + personaCardCount + ' 张' + (personaActiveSet ? '' : '（active 回落为 persona.md 快照）'));

  // 表情包
  let stickerCount = 0;
  for (const file of listFiles(stickersDir)) {
    try {
      const hash = hashFile(file);
      const resultAdd = stickers.add({ botId: bot.id, name: path.basename(file), file, hash });
      if (resultAdd && resultAdd.created !== false) stickerCount += 1;
    } catch (err) { warn('表情包迁移失败 ' + file + ': ' + errText(err)); }
  }
  log('表情包已迁移: ' + stickerCount + ' 个');

  // 无法表达的原始配置存档（便于后续接入 phrases/prompts）
  const archiveDir = path.join(botCwd, 'migrated');
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const key of ['phrases', 'prompts', 'triggers', 'behavior']) {
    if (v1[key] !== undefined) {
      fs.writeFileSync(path.join(archiveDir, 'v1-' + key + '.json'), JSON.stringify(v1[key], null, 2), { mode: 0o600 });
    }
  }
  fs.writeFileSync(path.join(archiveDir, 'v1-settings.json'), JSON.stringify(v1, null, 2), { mode: 0o600 });

  config.audit({ botId: bot.id, kind: 'migrate.v1', detail: JSON.stringify(counts) });
  log('完成 ✅ botId=' + bot.id + '  cwd=' + botCwd);
  log('重启 dsh 后在控制台检查：设置/人设/记忆/知识库/表情包');
  db.close();
}

main();
