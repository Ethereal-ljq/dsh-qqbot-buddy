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
    botName: '迁移机器人',
    dryRun: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') out.from = path.resolve(argv[++i]);
    else if (arg === '--to') out.to = path.resolve(argv[++i]);
    else if (arg === '--workspace') out.workspace = path.resolve(argv[++i]);
    else if (arg === '--v1-cwd') out.v1cwd = path.resolve(argv[++i]);
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

  let bot = config.listBots().find((item) => item.name === opts.botName) || null;
  // 不指定 cwd：v2 约定 <workspace>/bots/<botId>，与 v1 目录隔离，迁移不会写回 v1 数据
  if (!bot) bot = config.createBot({ name: opts.botName });
  else log('bot 已存在，增量迁移: ' + bot.id);

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

  // 知识库
  let kbCount = 0;
  for (const file of listFiles(knowledgeDir)) {
    const ext = path.extname(file).toLowerCase();
    if (!['.md', '.txt', '.markdown', '.json'].includes(ext)) continue;
    try {
      kb.ingest({ botId: bot.id, source: 'v1:' + path.relative(knowledgeDir, file), title: path.basename(file), text: fs.readFileSync(file, 'utf8') });
      kbCount += 1;
    } catch (err) { warn('知识库入库失败 ' + file + ': ' + errText(err)); }
  }
  log('知识库已迁移: ' + kbCount + ' 个文件');

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
