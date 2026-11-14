#!/usr/bin/env node
/**
 * prompt-budget —— 只读的「提示词预算」实测工具（P0 计量层的第一个产物）。
 *
 * 它回答三个问题，全部来自真机数据，不做任何推测：
 *   1. 一次请求里工具 schema 到底占多少字符？由哪些工具贡献？（读 session 日志的 request/header）
 *   2. 系统提示词本身有多大？（读 system/message 的 text 长度）
 *   3. 这些工具真的被用过吗？（统计 tool/call 名字频次，算出「每字符换来的调用次数」）
 *
 * 数据源：$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd
 *   - request/header：DSH 每次请求前落盘的 canonical header，含 tools 数组原文（唯一权威）
 *   - tool/call / tool/result：模型实际发出的调用与结果
 *   - system/message：渲染后的系统提示词（surface node）
 *
 * 用法：
 *   node scripts/prompt-budget.mjs                       # 扫描 ~/.dsh/sessions 下最近的会话
 *   node scripts/prompt-budget.mjs --bot bot_abc --sessions 12
 *   node scripts/prompt-budget.mjs --json                # 机器可读，供控制台/CI 门禁使用
 *
 * 只读：不写数据库、不改会话、不依赖插件运行时。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHARS_PER_TOKEN = 4; // 与 @deepseek-ai/dsh-token-meter 的 estimate 保持一致

function parseArgs(argv) {
  const out = { sessions: 12, bot: '', root: '', json: false, cwd: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--sessions') out.sessions = Number(argv[++i]) || 12;
    else if (arg === '--bot') out.bot = String(argv[++i] || '');
    else if (arg === '--root') out.root = String(argv[++i] || '');
    else if (arg === '--cwd') out.cwd = String(argv[++i] || '');
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  console.log([
    'prompt-budget —— 提示词预算实测（只读）',
    '',
    '  --sessions <n>  最多扫描最近 n 个会话（默认 12）',
    '  --bot <text>    只扫描路径里含该子串的会话目录（例如 bot_fb891494bb5d）',
    '  --cwd <path>    只扫描该工作目录对应的会话（默认全部）',
    '  --root <path>   DSH_HOME/sessions 根目录（默认 ~/.dsh/sessions）',
    '  --json          输出机器可读 JSON',
  ].join('\n'));
}

/** 解压并逐行解析一个会话文件；失败返回 null（不中断整体统计）。 */
function readSession(file) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { return null; }
  let text;
  try {
    text = file.endsWith('.zstd') ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
  } catch { return null; }
  const events = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try { events.push(JSON.parse(line)); } catch { /* 半行写入截断：忽略 */ }
  }
  return events;
}

/** 会话目录名编码了 cwd：--/home/qiqi/project/qqbot-- */
function decodeDirName(name) {
  if (!name.startsWith('--')) return '';
  return '/' + name.slice(2, -2).replace(/-(?=[^/])/g, '/').replace(/\//g, '/');
}

function collectFiles(rootDir) {
  const files = [];
  let dirs = [];
  try { dirs = fs.readdirSync(rootDir); } catch { return files; }
  for (const workspace of dirs) {
    const wsPath = path.join(rootDir, workspace);
    let stat;
    try { stat = fs.statSync(wsPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let sessions = [];
    try { sessions = fs.readdirSync(wsPath); } catch { continue; }
    for (const session of sessions) {
      const sessionDir = path.join(wsPath, session);
      const file = path.join(sessionDir, 'session.v4.jsonl.zstd');
      let fst;
      try { fst = fs.statSync(file); } catch { continue; }
      files.push({ file, workspace, session, cwd: decodeDirName(workspace), mtime: fst.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

/** 一组工具 schema 的规范化 JSON 长度（与线上 payload 同构）。 */
function toolChars(tool) {
  return JSON.stringify({ name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? {} }).length;
}

function main() {
  const args = parseArgs(process.argv);
  const root = args.root || path.join(os.homedir(), '.dsh', 'sessions');
  let files = collectFiles(root);
  if (args.bot !== '') files = files.filter((item) => item.file.includes(args.bot));
  if (args.cwd !== '') files = files.filter((item) => item.cwd.includes(args.cwd));
  files = files.slice(0, Math.max(1, args.sessions));

  let sessionCount = 0;
  let headerCount = 0;
  let unknownToolResults = 0;
  const usage = new Map();          // name -> 调用次数
  const systemChars = [];           // 每次渲染的系统提示词长度
  const setChanges = new Map();     // 工具名集合变化次数（按会话）
  let largest = null;               // 字符最多的 header（最坏情况）

  for (const item of files) {
    const events = readSession(item.file);
    if (!events) continue;
    sessionCount += 1;
    let signature = null;
    let changes = 0;
    for (const event of events) {
      const type = event && event.type;
      if (type === 'request/header') {
        headerCount += 1;
        const tools = Array.isArray(event.data?.header?.tools) ? event.data.header.tools : [];
        if (tools.length > 0) {
          const chars = JSON.stringify(tools).length;
          if (largest === null || chars > largest.chars) {
            largest = { chars, tools, seq: event.seq, session: item.session };
          }
          const next = tools.map((tool) => tool.name).sort().join(',');
          if (signature !== null && signature !== next) changes += 1;
          signature = next;
        }
      } else if (type === 'tool/call') {
        const name = event.data?.name || event.data?.call?.name || '';
        if (typeof name === 'string' && name !== '') usage.set(name, (usage.get(name) || 0) + 1);
      } else if (type === 'tool/result') {
        let body = '';
        try { body = JSON.stringify(event.data ?? {}); } catch { body = ''; }
        if (/unknown tool/i.test(body)) unknownToolResults += 1;
      } else if (type === 'system/message') {
        const content = event.data?.message?.content;
        if (Array.isArray(content)) {
          let chars = 0;
          for (const block of content) if (block && block.type === 'text') chars += String(block.text ?? '').length;
          if (chars > 0) systemChars.push(chars);
        }
      }
    }
    setChanges.set(item.session, changes);
  }

  const tools = largest ? largest.tools : [];
  const rows = tools.map((tool) => ({
    name: tool.name,
    chars: toolChars(tool),
    descriptionChars: String(tool.description ?? '').length,
    parameterChars: JSON.stringify(tool.parameters ?? {}).length,
    calls: usage.get(tool.name) || 0,
  })).sort((a, b) => b.chars - a.chars);

  const totalToolChars = rows.reduce((sum, row) => sum + row.chars, 0);
  const avgSystem = systemChars.length > 0 ? Math.round(systemChars.reduce((a, b) => a + b, 0) / systemChars.length) : 0;
  const maxSystem = systemChars.length > 0 ? Math.max(...systemChars) : 0;
  const totalCalls = [...usage.values()].reduce((a, b) => a + b, 0);

  const report = {
    sessions: sessionCount,
    headers: headerCount,
    toolCount: tools.length,
    toolChars: totalToolChars,
    toolTokens: Math.ceil(totalToolChars / CHARS_PER_TOKEN),
    systemCharsAvg: avgSystem,
    systemCharsMax: maxSystem,
    systemTokensAvg: Math.ceil(avgSystem / CHARS_PER_TOKEN),
    fixedOverheadChars: totalToolChars + avgSystem,
    toolShare: totalToolChars + avgSystem > 0 ? (totalToolChars / (totalToolChars + avgSystem)) : 0,
    toolCalls: totalCalls,
    distinctToolsCalled: usage.size,
    unknownToolResults,
    headerSetChanges: [...setChanges.values()].reduce((a, b) => a + b, 0),
    tools: rows,
  };

  if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log('提示词预算实测（只读）');
  console.log('  会话样本：' + sessionCount + '　请求头：' + headerCount + '　工具集变更：' + report.headerSetChanges);
  console.log('  最大工具集：' + report.toolCount + ' 个工具 / ' + report.toolChars + ' 字符 ≈ ' + report.toolTokens + ' tokens（chars/4）');
  console.log('  系统提示词：平均 ' + avgSystem + ' 字符（最大 ' + maxSystem + '）≈ ' + report.systemTokensAvg + ' tokens');
  console.log('  单请求固定开销：' + report.fixedOverheadChars + ' 字符，其中工具占 ' + (report.toolShare * 100).toFixed(1) + '%');
  console.log('  调用样本：' + totalCalls + ' 次 / ' + usage.size + ' 个不同工具；unknown tool 结果 ' + unknownToolResults + ' 次');
  console.log('');
  console.log('  schema字符  调用  每次调用代价  工具');
  for (const row of rows) {
    const perCall = row.calls > 0 ? Math.round(row.chars / row.calls) : row.chars;
    console.log('  ' + String(row.chars).padStart(8) + String(row.calls).padStart(6)
      + String(perCall).padStart(12) + '  ' + row.name);
  }
  const unused = rows.filter((row) => row.calls === 0);
  if (unused.length > 0) {
    console.log('');
    console.log('  样本期内零调用却常驻声明：' + unused.reduce((sum, row) => sum + row.chars, 0)
      + ' 字符 / ' + unused.length + ' 个工具 —— ' + unused.map((row) => row.name).join(', '));
  }
}

main();
