/**
 * test/members-mention.test.js —— 群友提及匹配（懒加载）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveMentionedMembers, memberPromptLine, aliasesOf } from '../lib/members/mention.js';

const members = [
  { id: 'm1', name: '老周', aliases: ['周哥'], profile: { nicknames: ['群主'], personality: ['豪爽'], deeds: ['组织活动'], affinity: { level: 1, note: '常一起玩' } } },
  { id: 'm2', name: '阿岚', aliases: [], profile: { nicknames: ['岚岚'], personality: [], deeds: [], affinity: { level: 0, note: '' } } },
  { id: 'm3', name: '小满', aliases: [], profile: { nicknames: [], personality: [], deeds: [], affinity: { level: 0, note: '' } } },
];

test('提及匹配：昵称/别名/常见称呼都能命中，最长优先', () => {
  const hits = resolveMentionedMembers('今天老周和岚岚都来了，小满没来', members, { limit: 5 });
  const names = hits.map((row) => row.member.name);
  assert.deepEqual(names.sort(), ['小满', '老周', '阿岚']);
  // 别名「周哥」也能命中
  const byAlias = resolveMentionedMembers('周哥在吗', members);
  assert.equal(byAlias.length, 1);
  assert.equal(byAlias[0].member.name, '老周');
  // 不相关文本不命中
  assert.equal(resolveMentionedMembers('今天天气不错', members).length, 0);
});

test('prompt 行：包含称呼/性格/事迹/关系，且不超长', () => {
  const line = memberPromptLine(members[0], { isSender: true });
  assert.match(line, /群友 老周/);
  assert.match(line, /称呼 群主/);
  assert.match(line, /性格 豪爽/);
  assert.match(line, /事迹 组织活动/);
  assert.match(line, /关系 亲近/);
  assert.match(line, /当前发言人/);
  assert.ok(line.length < 220);
});

test('aliasesOf 去重且忽略过短称呼', () => {
  assert.deepEqual(aliasesOf({ name: '阿岚', aliases: ['阿岚', '岚'], profile: { nicknames: ['岚岚'] } }), ['阿岚', '岚岚']);
});
