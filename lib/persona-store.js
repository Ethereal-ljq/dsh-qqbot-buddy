/**
 * persona-store —— 人设文件读写 / 版本备份 / 恢复。
 *
 * 人设文件路径来自运行期 settings（可被设置页修改），因此每次操作都重新读取。
 * 写盘前把旧内容备份到 <stateDir>/persona-backups/，避免误操作丢内容。
 */
import fs from 'node:fs';
import path from 'node:path';

export const FALLBACK_PERSONA = '你是 QQ 上的一个真人，只做文字聊天；没有工具，不知道就说不知道。';

const MAX_PERSONA_BYTES = 256 * 1024;

function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function safeBackupName(input) {
  const raw = typeof input === 'string' ? input : '';
  const base = path.basename(raw.replace(/\\/g, '/')).trim();
  if (base === '' || base.startsWith('.') || !base.endsWith('.md')) return undefined;
  if (base.includes('/') || base.includes('\\')) return undefined;
  return base;
}

export function createPersonaStore({ settings, stateDir, logger }) {
  const log = logger ?? console;
  const backupsDir = path.join(stateDir, 'persona-backups');

  const currentPath = () => {
    try {
      return settings.get().persona.path;
    } catch {
      return '';
    }
  };

  function read() {
    const file = currentPath();
    try {
      const stat = fs.statSync(file);
      const text = fs.readFileSync(file, 'utf8');
      return {
        text,
        path: file,
        bytes: stat.size,
        lines: text.split('\n').length,
        exists: true,
        mtime: stat.mtimeMs,
      };
    } catch {
      return { text: '', path: file, bytes: 0, lines: 0, exists: false, mtime: 0 };
    }
  }

  function ensureBackupDir() {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  function backupCurrent(label) {
    const current = read();
    if (!current.exists || current.text.trim() === '') return undefined;
    ensureBackupDir();
    // 同一秒内多次保存时用 -2/-3 去重，避免备份互相覆盖
    const baseName = `persona-${localStamp()}-${label}`;
    let name = baseName + '.md';
    let seq = 2;
    while (fs.existsSync(path.join(backupsDir, name))) {
      name = baseName + '-' + seq + '.md';
      seq += 1;
    }
    const target = path.join(backupsDir, name);
    fs.writeFileSync(target, current.text, { encoding: 'utf8', mode: 0o600 });
    return name;
  }

  function write(text) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, error: '人设不能为空' };
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_PERSONA_BYTES) {
      return { ok: false, error: '人设超过 256KB' };
    }
    const backup = backupCurrent('save');
    const file = currentPath();
    try {
      atomicWrite(file, text.endsWith('\n') ? text : text + '\n');
      return { ok: true, backup };
    } catch (err) {
      log.error?.('保存人设失败:', err && err.message);
      return { ok: false, error: String(err && err.message) };
    }
  }

  function backups() {
    try {
      return fs
        .readdirSync(backupsDir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => {
          try {
            const stat = fs.statSync(path.join(backupsDir, name));
            return { name, size: stat.size, mtime: stat.mtimeMs };
          } catch {
            return undefined;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 40);
    } catch {
      return [];
    }
  }

  function restore(name) {
    const safe = safeBackupName(name);
    if (!safe) return { ok: false, error: '备份名不合法' };
    const file = path.join(backupsDir, safe);
    if (!file.startsWith(backupsDir + path.sep)) return { ok: false, error: '路径越界' };
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { ok: false, error: '备份不存在' };
    }
    backupCurrent('before-restore');
    try {
      atomicWrite(currentPath(), text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
  }

  return {
    path: currentPath,
    read,
    write,
    backups,
    restore,
    backupsDir,
    FALLBACK_PERSONA,
  };
}