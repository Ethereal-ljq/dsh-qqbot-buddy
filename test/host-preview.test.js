/**
 * host/preview —— 提示词拼合预览（只读，不依赖 live agent）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildPromptPreview, visibleToolNames } from '../lib/host/preview.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-preview-'));
}

test('预览：按 prompt 顺序拼出 5 个插件段 + 技能目录', async () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'persona.md'), '你是测试人设。');
  const out = await buildPromptPreview({
    settings: {
      persona: { suppressRuntimeContext: true },
      tools: { capabilities: { workspace: true, web: true, stickers: true, skills: true } },
      memory: { enabled: true },
      kb: { enabled: true },
    },
    botId: 'bot-1',
    cwd,
    skills: [{ name: 'bili-get', description: 'B 站视频工具' }],
    memory: { recallForPrompt: () => '【长期记忆】\n- 用户喜欢猫' },
    knowledge: { search: () => [{ title: '团建', text: '周六集合' }] },
    members: { list: () => [] },
    query: '猫',
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.sections.map((s) => s.name), [
    'qqbot:persona', 'qqbot:guide', 'qqbot:memory', 'qqbot:knowledge', 'qqbot:members', 'host:skills',
  ]);
  const byName = new Map(out.sections.map((s) => [s.name, s]));
  assert.match(byName.get('qqbot:persona').text, /测试人设/);
  assert.match(byName.get('qqbot:guide').text, /能力边界/);
  assert.match(byName.get('qqbot:memory').text, /喜欢猫/);
  assert.match(byName.get('qqbot:knowledge').text, /周六集合/);
  assert.match(byName.get('host:skills').text, /bili-get/);
  assert.ok(out.notes.some((note) => note.includes('宿主')));
});

test('预览：空 query 时不召回记忆/知识；能力关闭时工具指引不含对应工具', async () => {
  const out = await buildPromptPreview({
    settings: { tools: { capabilities: { workspace: false, web: false, stickers: false, skills: false } } },
    botId: 'bot-1',
    cwd: tmpDir(),
    query: '',
    memory: { recallForPrompt: () => { throw new Error('不应调用'); } },
    knowledge: { search: () => { throw new Error('不应调用'); } },
  });
  const byName = new Map(out.sections.map((s) => [s.name, s]));
  assert.equal(byName.get('qqbot:memory').chars, 0);
  assert.equal(byName.get('qqbot:knowledge').chars, 0);
  const names = visibleToolNames({ tools: { capabilities: { workspace: false, web: false } } });
  assert.ok(!names.includes('web_search'));
  assert.ok(!names.includes('read'));
});
