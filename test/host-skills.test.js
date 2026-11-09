/**
 * host-skills 单测：frontmatter 解析（含折叠块）、技能扫描、按配置档白名单过滤、agent 作用域登记。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createSkillProvider, filterSkillsBySettings, parseFrontmatter, registerAgentSkillScope,
} from '../lib/host/skills.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-skills-'));
}

function writeSkill(root, name, frontmatter, body = '正文') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\n' + frontmatter + '\n---\n\n' + body + '\n', 'utf8');
}

test('parseFrontmatter：引号、折叠块、布尔与嵌套 mapping', () => {
  const parsed = parseFrontmatter('---\nname: demo\ndescription: >\n  第一行\n  第二行\ndisable-model-invocation: true\nmetadata:\n  author: x\n---\n内容');
  assert.equal(parsed.data.name, 'demo');
  assert.equal(parsed.data.description, '第一行 第二行');
  assert.equal(parsed.data['disable-model-invocation'], 'true');
  assert.equal(parsed.data.metadata.author, undefined, '嵌套键不展开（忽略即可）');
  assert.equal(parsed.body.trim(), '内容');
  assert.equal(parseFrontmatter('no frontmatter'), null);
});

test('filterSkillsBySettings：白名单非空只留列表内；空列表/全开放行全部', () => {
  const skills = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.deepEqual(filterSkillsBySettings({ tools: { skillsMode: 'allow', skills: ['b'] } }, skills).map((s) => s.name), ['b']);
  assert.deepEqual(filterSkillsBySettings({ tools: { skillsMode: 'allow', skills: [] } }, skills).map((s) => s.name), ['a', 'b', 'c']);
  assert.deepEqual(filterSkillsBySettings({ tools: { skillsMode: 'all', skills: ['b'] } }, skills).map((s) => s.name), ['a', 'b', 'c']);
  assert.deepEqual(filterSkillsBySettings({}, skills).map((s) => s.name), ['a', 'b', 'c']);
});

test('provider：扫描技能目录、折叠描述、invocation 标记与 get 内容', async () => {
  const home = tempRoot();
  const workspace = path.join(home, 'workspace');
  const userSkills = path.join(home, 'skills');
  fs.mkdirSync(userSkills, { recursive: true });
  writeSkill(userSkills, 'plain-skill', 'name: plain-skill\ndescription: 普通技能');
  writeSkill(userSkills, 'folded-skill', 'name: folded-skill\ndescription: >\n  折叠描述\n  第二行\ndisable-model-invocation: true', 'FOLDED BODY');
  const provider = createSkillProvider({
    workspaceRoot: workspace, dshHome: home, agentsHome: path.join(home, 'agents'), logger: { warn() {} },
  });
  const candidates = await provider.list({ cwd: workspace });
  const names = candidates.map((item) => item.name).sort();
  assert.deepEqual(names, ['folded-skill', 'plain-skill']);
  const folded = candidates.find((item) => item.name === 'folded-skill');
  assert.equal(folded.description, '折叠描述 第二行');
  assert.equal(folded.invocation.modelInvocable, false);
  assert.equal(folded.invocation.userInvocable, true);
  const plain = candidates.find((item) => item.name === 'plain-skill');
  assert.equal(plain.invocation.modelInvocable, true);
  const definition = await provider.get(plain);
  assert.equal(definition.name, 'plain-skill');
  assert.ok(definition.content.includes('正文'));
  assert.equal(definition.provider, 'qqbot');
});

test('provider：按 agent 作用域的配置档白名单过滤（scope 为空返回全部）', async () => {
  const home = tempRoot();
  const userSkills = path.join(home, 'skills');
  fs.mkdirSync(userSkills, { recursive: true });
  writeSkill(userSkills, 'skill-a', 'name: skill-a\ndescription: A');
  writeSkill(userSkills, 'skill-b', 'name: skill-b\ndescription: B');
  const provider = createSkillProvider({
    workspaceRoot: path.join(home, 'workspace'), dshHome: home, agentsHome: path.join(home, 'agents'), logger: { warn() {} },
  });
  const agent = { id: 'agent-1' };
  const runtime = {
    config: {
      getEffectiveSettings(botId, peer) {
        assert.equal(botId, 'bot_x');
        assert.equal(peer, 'group:g1');
        return { tools: { skillsMode: 'allow', skills: ['skill-b'] } };
      },
    },
  };
  registerAgentSkillScope(agent, { runtime, botId: 'bot_x', peer: 'group:g1' });
  const scoped = await provider.list({ scope: agent, cwd: path.join(home, 'workspace') });
  assert.deepEqual(scoped.map((item) => item.name), ['skill-b'], '白名单外的技能必须从 catalog 消失');
  const unscoped = await provider.list({ cwd: path.join(home, 'workspace') });
  assert.equal(unscoped.length, 2, '控制台/根视图仍能看到全部技能');
});
