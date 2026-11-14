/**
 * asr/credentials —— 读取 DSH 账号登录写入的本地凭证（仅 DeepSeek 账号鉴权用）。
 *
 * 凭证文件是 YAML（~/.dsh/.credentials.yaml），结构：
 *   records:
 *     deepseek-account-platform/default:
 *       kind: ...
 *       payload:
 *         version: 1
 *         token: <token>
 *         issuer: ...
 *
 * 这里只做最小解析：按缩进定位 records 下的目标记录，取出 payload.token。
 * 不打印 token；读取失败给出可读错误。
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ttsError } from '../tts/http.js';

/** 展开 ~ / 相对路径。 */
export function expandHome(filePath) {
  const raw = typeof filePath === 'string' ? filePath.trim() : '';
  if (raw === '') return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

/** 从凭证文件里取账号 token（找不到返回空串）。 */
export function readAccountToken({ credentialPath = '~/.dsh/.credentials.yaml', record = 'deepseek-account-platform/default' } = {}) {
  const file = expandHome(credentialPath) || path.join(os.homedir(), '.dsh', '.credentials.yaml');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw ttsError('读取 DSH 账号凭证失败（账号鉴权需要先在 DSH 登录）: ' + file + ' — ' + (err && err.message ? err.message : String(err)), 'ASR_CONFIG');
  }
  const lines = text.split(/\r?\n/);
  const recordLine = '  ' + record + ':';
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      if (line.trimEnd() === recordLine) inBlock = true;
      continue;
    }
    // 下一条同级记录（恰好两个空格缩进）结束
    if (line.trim() !== '' && !/^\s{3,}/.test(line)) break;
    const matched = line.match(/^\s+token:\s*(\S+)\s*$/);
    if (matched) return matched[1].replace(/^["']|["']$/g, '');
  }
  return '';
}
