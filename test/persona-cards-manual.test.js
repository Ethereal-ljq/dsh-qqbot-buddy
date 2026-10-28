/**
 * 人格卡：手动新建（自定义内容）与读取/编辑卡正文。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPersonaCardsStore } from '../lib/persona-cards-store.js';
import { createPersonaStore } from '../lib/persona-store.js';

const BASE_PERSONA = '你是默认人格。\n';

function makeRig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-pcard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const personaFile = path.join(cwd, 'persona.md');
  fs.writeFileSync(personaFile, BASE_PERSONA, { mode: 0o600 });
  const state = {
    persona: { path: personaFile, mode: 'replace', suppressRuntimeContext: true, groupExtraPrompt: '', directExtraPrompt: '' },
  };
  const settings = { get: () => state };
  const personaStore = createPersonaStore({ settings, stateDir: path.join(dir, 'state'), logger: { warn() {}, error() {}, info() {} } });
  const store = createPersonaCardsStore({ personaStore, cwd, logger: { warn() {}, error() {}, info() {} } });
  return { dir, cwd, personaFile, store, personaStore };
}

test('手动新建卡：自定义内容不改变当前人设，激活后才写回', (t) => {
  const { store, personaFile } = makeRig(t);
  const created = store.create({ name: '高冷版', description: '话少', content: '你是高冷人格。\n' });
  assert.equal(created.ok, true);
  assert.equal(created.card.name, '高冷版');
  assert.equal(fs.readFileSync(personaFile, 'utf8'), BASE_PERSONA, '新建卡不应改动当前人设');
  assert.equal(created.custom, true, '内容与当前人设不同 -> custom');
  assert.equal(created.activeId, null);

  const activated = store.activate(created.card.id);
  assert.equal(activated.ok, true);
  assert.match(fs.readFileSync(personaFile, 'utf8'), /高冷人格/);
  const listed = store.list();
  assert.equal(listed.activeId, created.card.id);
  assert.equal(listed.custom, false);
});

test('read：读取卡正文与元信息；未知 id 报错', (t) => {
  const { store } = makeRig(t);
  const created = store.create({ name: '温柔版', description: '', content: '你是温柔人格。\n' });
  const read = store.read(created.card.id);
  assert.equal(read.ok, true);
  assert.equal(read.content, '你是温柔人格。\n');
  assert.equal(read.chars > 0, true);
  assert.equal(read.name, '温柔版');
  const missing = store.read('not-exist');
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /不存在/);
});

test('编辑卡内容：非激活卡只改卡文件；激活卡同步人设（带备份）', (t) => {
  const { store, personaFile } = makeRig(t);
  const a = store.create({ name: 'A', content: '人格 A\n' });
  const b = store.create({ name: 'B', content: '人格 B\n' });
  // 让 A 成为当前人设
  store.activate(a.card.id);
  // 改非激活卡 B
  const editedB = store.update(b.card.id, { content: '人格 B2\n' });
  assert.equal(editedB.ok, true);
  assert.equal(store.read(b.card.id).content, '人格 B2\n');
  assert.match(fs.readFileSync(personaFile, 'utf8'), /人格 A/, '改他人卡不影响人设');
  // 改激活卡 A：update 本身只改卡文件（active 由内容比对），UI 通过「update + activate」同步人设
  const editedA = store.update(a.card.id, { content: '人格 A2\n' });
  assert.equal(editedA.ok, true);
  assert.equal(store.read(a.card.id).content, '人格 A2\n');
  assert.equal(editedA.activeId, null, '改内容后与当前人设不一致 -> 变 custom');
  const reapplied = store.activate(a.card.id);
  assert.equal(reapplied.ok, true);
  assert.match(fs.readFileSync(personaFile, 'utf8'), /人格 A2/, 'activate 后同步人设');
  const backups = fs.readdirSync(path.join(path.dirname(personaFile), '..', 'state', 'persona-backups')).filter((n) => n.endsWith('.md'));
  assert.equal(backups.length > 0, true, '同步人设时应产生备份');
});
