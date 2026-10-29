/**
 * skill provider 测试：证明「插件自己实现技能发现 + 白名单过滤」这条路可行，
 * 且宿主不可用时能安全降级（适应不同 dsh 版本）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveSkillRoots,
  scanRoot,
  selectSkills,
  splitFrontmatter,
  readSkillMeta,
  SKILL_NAME,
} from '../lib/skills/scan.js';
import { apply as applyProvider } from '../lib/skills/provider.js';

/** 建临时目录树：roots = { '<source>': { '<skillName>': 'frontmatter+body' } }。 */
function makeFixture(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-skill-'));
  const roots = {};
  for (const [rootName, skills] of Object.entries(spec)) {
    const rootDir = path.join(dir, rootName);
    fs.mkdirSync(rootDir, { recursive: true });
    roots[rootName] = rootDir;
    for (const [skillName, body] of Object.entries(skills)) {
      if (body === null) {
        // 目录存在但没有 SKILL.md
        fs.mkdirSync(path.join(rootDir, skillName), { recursive: true });
        continue;
      }
      const skillDir = path.join(rootDir, skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body, 'utf8');
    }
  }
  return { dir, roots };
}

function skillDoc(name, description, extra = '') {
  return '---\nname: ' + name + '\ndescription: ' + JSON.stringify(description) + '\n' + extra + '---\n\n# ' + name + '\n\nbody of ' + name + '\n';
}

test('splitFrontmatter：正常拆分、CRLF、无 frontmatter', () => {
  const ok = splitFrontmatter(skillDoc('alpha', 'A skill'));
  assert.equal(ok.data.name, 'alpha');
  assert.match(ok.content, /body of alpha/);

  const crlf = splitFrontmatter('---\r\nname: beta\r\ndescription: B\r\n---\r\nbody\r\n');
  assert.equal(crlf.data.name, 'beta');

  assert.equal(splitFrontmatter('# no frontmatter'), null);
  assert.equal(splitFrontmatter('---\nname: x'), null);
});

test('readSkillMeta：kebab 名校验、必填 description、invocation 反解', () => {
  assert.equal(readSkillMeta({ name: 'Bad Name', description: 'x' }), null);
  assert.equal(readSkillMeta({ name: 'ok-name', description: '' }), null);
  assert.match('a-b-c', SKILL_NAME);

  const plain = readSkillMeta({ name: 'ok', description: 'd' });
  assert.deepEqual(plain.invocation, { modelInvocable: true, userInvocable: true });

  const disabled = readSkillMeta({ name: 'ok', description: 'd', 'disable-model-invocation': 'yes', 'user-invocable': 'off' });
  assert.deepEqual(disabled.invocation, { modelInvocable: false, userInvocable: false });

  // 非法布尔值 => 整个 skill 被丢弃（与宿主一致）
  assert.equal(readSkillMeta({ name: 'ok', description: 'd', 'user-invocable': 'maybe' }), null);
});

test('scanRoot：目录 bundle + 平铺 .md，跳过隐藏目录与无 SKILL.md 目录', () => {
  const { roots } = makeFixture({
    'user-dsh': {
      'bili-get': skillDoc('bili-get', 'B站视频'),
      'docx': skillDoc('docx', 'Word 文档'),
      '.system': null,
      'no-cover': null,
    },
  });
  const rootDir = roots['user-dsh'];
  // 平铺 md
  fs.writeFileSync(path.join(rootDir, 'flat-one.md'), skillDoc('flat-one', '平铺技能'), 'utf8');
  // 隐藏目录里塞一个不该被发现的
  fs.mkdirSync(path.join(rootDir, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.hidden', 'SKILL.md'), skillDoc('hidden-skill', '不该出现'), 'utf8');

  const rows = scanRoot({ path: rootDir, source: 'user-dsh', rank: 400 }, 'qqbot');
  const names = rows.map((row) => row.candidate.name).sort();
  assert.deepEqual(names, ['bili-get', 'docx', 'flat-one']);
  assert.ok(rows.every((row) => row.candidate.provider === 'qqbot'));
  assert.ok(rows.every((row) => row.candidate.rank === 400));
});

test('selectSkills：mode=allow 只留白名单，all 全留，missing 单独报告', () => {
  const rows = [
    { candidate: { name: 'bili-get', rank: 400 } },
    { candidate: { name: 'docx', rank: 400 } },
    { candidate: { name: 'pdf', rank: 400 } },
  ];
  const allow = selectSkills(rows, { mode: 'allow', allowed: ['bili-get'] });
  assert.deepEqual(allow.visible.map((c) => c.name), ['bili-get']);
  assert.deepEqual(allow.hidden.sort(), ['docx', 'pdf']);
  assert.deepEqual(allow.invalid, []);

  const all = selectSkills(rows, { mode: 'all' });
  assert.equal(all.visible.length, 3);

  const missing = selectSkills(rows, { mode: 'allow', allowed: ['bili-get', 'ghost'] });
  assert.deepEqual(missing.invalid, ['ghost']);
});

test('selectSkills：同名去重，rank 小的赢', () => {
  const rows = [
    { candidate: { name: 'dup', rank: 500, source: 'user-agents' } },
    { candidate: { name: 'dup', rank: 100, source: 'project-dsh' } },
  ];
  const picked = selectSkills(rows, { mode: 'all' });
  assert.equal(picked.visible.length, 1);
  assert.equal(picked.visible[0].source, 'project-dsh');
});

test('resolveSkillRoots：默认含 project + user 根，可关闭', () => {
  const withDefaults = resolveSkillRoots({ cwd: '/tmp/x', dshHome: '/home/u/.dsh', agentsHome: '/home/u/.agents' });
  const sources = withDefaults.map((root) => root.source);
  assert.ok(sources.includes('project-dsh'));
  assert.ok(sources.includes('user-dsh'));
  assert.ok(sources.includes('user-agents'));

  const onlyCustom = resolveSkillRoots({ customSkillDirs: ['/tmp/a'], includeDefaultRoots: false });
  assert.deepEqual(onlyCustom.map((r) => r.source), ['custom']);
});

test('apply：无 ctx.skills 时安全降级（不抛错、不注册）', () => {
  const warnings = [];
  const ctx = {
    logger: { warn: (m) => warnings.push(m), debug: () => {} },
    get: () => undefined,
  };
  assert.doesNotThrow(() => applyProvider(ctx, { mode: 'allow', allowed: ['x'] }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /registerProvider/);
});

test('apply：注册 provider，list() 按白名单过滤，get() 返回正文与 resourceBase', async () => {
  const { roots } = makeFixture({
    'user-dsh': {
      'bili-get': skillDoc('bili-get', 'B站视频工具'),
      'docx': skillDoc('docx', 'Word 文档'),
    },
  });
  let provider;
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    get: (name) => (name === 'skills' ? {
      registerProvider: (create) => {
        provider = create({ signal: new AbortController().signal, invalidate: () => {} });
        return () => {};
      },
    } : undefined),
  };

  applyProvider(ctx, {
    providerName: 'qqbot',
    mode: 'allow',
    allowed: ['bili-get'],
    customSkillDirs: [roots['user-dsh']],
    includeDefaultRoots: false,
  });

  assert.ok(provider, 'provider 应已注册');
  assert.equal(provider.name, 'qqbot');

  const candidates = await provider.list({ cwd: '/tmp/x' });
  assert.equal(candidates.length, 1, '白名单外技能必须被过滤');
  assert.equal(candidates[0].name, 'bili-get');
  assert.equal(candidates[0].provider, 'qqbot');
  assert.ok(candidates[0].locator.file.endsWith('SKILL.md'));

  const loaded = await provider.get(candidates[0]);
  assert.equal(loaded.name, 'bili-get');
  assert.equal(loaded.provider, 'qqbot');
  assert.equal(loaded.resourceBase.kind, 'directory');
  assert.match(loaded.content, /body of bili-get/);
  // 正文里不应再包含 frontmatter
  assert.ok(!loaded.content.includes('description:'));
});

test('apply：mode=all 时全部可见', async () => {
  const { roots } = makeFixture({
    'user-dsh': { 'a-one': skillDoc('a-one', 'A'), 'b-two': skillDoc('b-two', 'B') },
  });
  let provider;
  const ctx = {
    logger: { warn: () => {}, debug: () => {} },
    get: (name) => (name === 'skills' ? {
      registerProvider: (create) => {
        provider = create({ signal: new AbortController().signal, invalidate: () => {} });
        return () => {};
      },
    } : undefined),
  };
  applyProvider(ctx, { mode: 'all', customSkillDirs: [roots['user-dsh']], includeDefaultRoots: false });
  const candidates = await provider.list({});
  assert.deepEqual(candidates.map((c) => c.name).sort(), ['a-one', 'b-two']);
});

test('apply：registerProvider 抛错时降级不崩', () => {
  const warnings = [];
  const ctx = {
    logger: { warn: (m) => warnings.push(m), debug: () => {} },
    get: (name) => (name === 'skills' ? {
      registerProvider: () => { throw new Error('duplicate provider'); },
    } : undefined),
  };
  assert.doesNotThrow(() => applyProvider(ctx, { mode: 'allow', allowed: ['x'] }));
  assert.ok(warnings.some((m) => /注册 skill provider 失败/.test(m)));
});
