/**
 * persona-store 单测（DESIGN 质量项 4）：
 * 读取兜底、保存前备份、备份列表、恢复、路径越界拒绝、原子写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPersonaStore, FALLBACK_PERSONA } from '../lib/persona-store.js';
import { createFakeLogger } from './helpers/fake-ctx.js';

/** 建临时目录并在测试结束后删除。 */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-persona-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 构造被测 store。
 * settings 用最小 fake：persona-store 的契约是"每次操作重新读 settings.get().persona.path"，
 * 用可变闭包即可验证运行期改路径是否生效。
 */
function makeStore(t) {
  const dir = tempDir(t);
  const stateDir = path.join(dir, 'state');
  const personaPath = path.join(dir, 'persona.md');
  const pathRef = { current: personaPath };
  const settings = { get: () => ({ persona: { path: pathRef.current, mode: 'replace' } }) };
  const logger = createFakeLogger();
  const store = createPersonaStore({ settings, stateDir, logger });
  return { dir, stateDir, personaPath, pathRef, settings, logger, store, backupsDir: path.join(stateDir, 'persona-backups') };
}

test('FALLBACK_PERSONA：导出非空中性兜底文案', () => {
  assert.equal(typeof FALLBACK_PERSONA, 'string');
  assert.ok(FALLBACK_PERSONA.trim().length > 0);
});

test('read：文件不存在时返回 exists:false 且不抛错', (t) => {
  const { store, personaPath } = makeStore(t);
  const snapshot = store.read();
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.text, '');
  assert.equal(snapshot.bytes, 0);
  assert.equal(snapshot.lines, 0);
  assert.equal(snapshot.mtime, 0);
  assert.equal(snapshot.path, personaPath);
});

test('write：创建文件、权限 0600、按需补结尾换行、无 tmp 残留', (t) => {
  const { store, personaPath, dir } = makeStore(t);
  const result = store.write('你是一只猫娘。');
  assert.deepEqual(result, { ok: true, backup: undefined });
  assert.equal(fs.readFileSync(personaPath, 'utf8'), '你是一只猫娘。\n');
  assert.equal(fs.statSync(personaPath).mode & 0o777, 0o600, '人设文件权限必须是 0600');

  // 已有换行则不重复追加。
  store.write('第二版\n');
  assert.equal(fs.readFileSync(personaPath, 'utf8'), '第二版\n');
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('write：空内容/非字符串/超 256KB 被拒绝且不覆盖旧文件', (t) => {
  const { store, personaPath } = makeStore(t);
  store.write('原始人设');
  for (const invalid of ['', '   \n  ', 123, null, undefined]) {
    const result = store.write(invalid);
    assert.equal(result.ok, false, '非法内容 ' + String(invalid) + ' 应被拒绝');
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  }
  const tooLarge = 'A'.repeat(256 * 1024 + 1);
  const largeResult = store.write(tooLarge);
  assert.equal(largeResult.ok, false);
  assert.match(largeResult.error, /256KB/);
  assert.equal(fs.readFileSync(personaPath, 'utf8'), '原始人设\n', '拒绝写入时不得改动旧文件');
});

test('read：返回字节数/行数/mtime，并随写更新', (t) => {
  const { store } = makeStore(t);
  const before = Date.now();
  store.write('第一行\n第二行');
  const snapshot = store.read();
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.text, '第一行\n第二行\n');
  assert.equal(snapshot.bytes, Buffer.byteLength(snapshot.text, 'utf8'));
  assert.equal(snapshot.lines, 3);
  assert.ok(snapshot.mtime >= before - 1000);
});

test('write：保存前备份旧版本到 stateDir/persona-backups/', (t) => {
  const { store, backupsDir } = makeStore(t);
  // 第一次保存没有旧内容，不产生备份。
  const first = store.write('第一版人设');
  assert.equal(first.backup, undefined);
  assert.equal(fs.existsSync(backupsDir), false);

  // 第二次保存应备份第一版。
  const second = store.write('第二版人设');
  assert.equal(second.ok, true);
  assert.ok(second.backup, '第二次保存应返回备份文件名');
  assert.match(second.backup, /^persona-\d{8}-\d{6}-save\.md$/);
  const backupText = fs.readFileSync(path.join(backupsDir, second.backup), 'utf8');
  assert.equal(backupText, '第一版人设\n');
  assert.equal(fs.statSync(path.join(backupsDir, second.backup)).mode & 0o777, 0o600, '备份权限必须是 0600');

  // 当前文件是第二版。
  assert.equal(store.read().text, '第二版人设\n');
  assert.equal(store.backups().length, 1);
});

test('backups：返回 name/size/mtime，且目录不存在时返回空数组', (t) => {
  const { store } = makeStore(t);
  assert.deepEqual(store.backups(), [], '无备份目录时应返回空数组');
  store.write('第一版');
  store.write('第二版');
  const list = store.backups();
  assert.equal(list.length, 1);
  const [item] = list;
  assert.equal(typeof item.name, 'string');
  assert.ok(item.size > 0);
  assert.ok(item.mtime > 0);
});

test('backups：旧人设为空/纯空白时不生成无意义备份', (t) => {
  const { store, personaPath } = makeStore(t);
  fs.writeFileSync(personaPath, '   \n\n', 'utf8');
  const result = store.write('新人设');
  assert.equal(result.ok, true);
  assert.equal(result.backup, undefined);
});

test('restore：从备份恢复内容，且恢复前会再备份当前版本', (t) => {
  const { store, backupsDir } = makeStore(t);
  store.write('旧人设 A');
  const saveResult = store.write('新人设 B');
  const backupName = saveResult.backup;
  assert.ok(backupName);

  const restoreResult = store.restore(backupName);
  assert.deepEqual(restoreResult, { ok: true });
  assert.equal(store.read().text, '旧人设 A\n', '恢复后应回到被备份的内容');

  // 恢复前把"新人设 B"也备份下来，避免误恢复丢内容。
  const names = store.backups().map((item) => item.name);
  assert.ok(
    names.some((name) => name.endsWith('-before-restore.md')),
    '恢复前应生成 before-restore 备份，实际为: ' + names.join(', '),
  );
  assert.ok(fs.existsSync(backupsDir));
});

test('restore：备份名越界/非法/不存在一律拒绝且不改动当前人设', (t) => {
  const { store } = makeStore(t);
  store.write('当前人设');
  const invalidNames = [
    '../../etc/passwd',
    '..\\..\\evil.md',
    'foo.txt',
    '.hidden.md',
    '',
    '   ',
    null,
    123,
    '/etc/passwd',
  ];
  for (const name of invalidNames) {
    const result = store.restore(name);
    assert.equal(result.ok, false, '非法备份名 ' + JSON.stringify(name) + ' 应被拒绝');
  }
  // 合法但不存在的备份名。
  const missing = store.restore('persona-19700101-000000-save.md');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /不存在/);
  assert.equal(store.read().text, '当前人设\n', '拒绝恢复时不得改动当前人设');
});

test('路径动态：settings 改人设路径后读写迁移到新文件', (t) => {
  const { store, dir, pathRef } = makeStore(t);
  store.write('旧路径人设');
  const newPath = path.join(dir, 'nested', 'persona-new.md');
  pathRef.current = newPath;
  assert.equal(store.path(), newPath);
  assert.equal(store.read().exists, false);
  store.write('新路径人设');
  assert.equal(fs.readFileSync(newPath, 'utf8'), '新路径人设\n');
  assert.equal(store.read().path, newPath);
});

test('read：空文件存在时 exists:true、text 为空', (t) => {
  const { store, personaPath } = makeStore(t);
  fs.writeFileSync(personaPath, '', 'utf8');
  const snapshot = store.read();
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.text, '');
  assert.equal(snapshot.bytes, 0);
});
