/**
 * test/package-manifest —— 发布包清单的静态契约。
 *
 * 这些字段错了不会让单元测试变红，但会让 npm 上的包「装得上、跑不起来」：
 * web/dist 没随包、custom 模板没随包、exports 指向不存在的文件、发到错误的 dist-tag、
 * README 里挂了不存在的截图。发版前最容易悄悄坏的就是这几处，所以在这里兜住。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

const REPO_SLUG = 'Ethereal-ljq/dsh-qqbot-buddy';
const BRANCH = 'v2';

/** 把 README 里的绝对图片/文档链接还原成仓库内相对路径（npm 上必须用绝对链接，否则不显示）。 */
function localPathOf(url) {
  const jsdelivr = /cdn\.jsdelivr\.net\/gh\/[^/@]+\/[^/@]+@[^/]+\/(.+)$/.exec(url);
  if (jsdelivr) return jsdelivr[1];
  const raw = /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/.exec(url);
  if (raw) return raw[1];
  const blob = /github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/.exec(url);
  if (blob) return blob[1];
  return '';
}

test('package.json：files 覆盖运行期必需目录', () => {
  const required = ['lib/**', 'web/dist/**', 'custom/templates/**', 'docs/**', 'scripts/**', 'cordis.patch.yml', 'README.md', 'LICENSE'];
  for (const pattern of required) {
    assert.ok(pkg.files.includes(pattern), 'files 必须包含 ' + pattern + '（否则 npm 包里缺文件）');
  }
  assert.ok(!pkg.files.some((pattern) => pattern.startsWith('test')), '测试目录不随包发布');
});

test('package.json：main / exports / bin 都指向真实文件', () => {
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), 'main 不存在: ' + pkg.main);
  for (const [key, target] of Object.entries(pkg.exports || {})) {
    if (typeof target !== 'string' || key === './package.json') continue;
    assert.ok(fs.existsSync(path.join(ROOT, target)), 'exports["' + key + '"] 指向的文件不存在: ' + target);
  }
  for (const [name, target] of Object.entries(pkg.bin || {})) {
    assert.ok(fs.existsSync(path.join(ROOT, target)), 'bin ' + name + ' 指向的文件不存在: ' + target);
  }
});

test('package.json：控制台前端产物随包（运行期不需要构建）', () => {
  const dist = path.join(ROOT, 'web', 'dist');
  assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'web/dist/index.html 必须随包');
  const assets = fs.readdirSync(path.join(dist, 'assets'));
  assert.ok(assets.some((name) => /^index-.*\.js$/.test(name)), 'web/dist/assets 下要有 index-*.js');
  assert.ok(assets.some((name) => /^index-.*\.css$/.test(name)), 'web/dist/assets 下要有 index-*.css');
});

test('package.json：最简示例模板随包（template:install 才可用）', () => {
  const minimal = path.join(ROOT, 'custom', 'templates', 'minimal');
  assert.ok(fs.existsSync(path.join(minimal, 'index.html')), 'custom/templates/minimal/index.html 必须随包');
  assert.ok(fs.existsSync(path.join(minimal, 'meta.json')), '模板 meta.json 必须随包');
  assert.ok(pkg.files.includes('custom/templates/**'), 'files 要覆盖 custom/templates');
});

test('package.json：文档截图与本地自定义模板不进 npm 包', () => {
  assert.ok(pkg.files.includes('!docs/images/**'), 'docs/images 只服务 GitHub，不进 npm 包');
  assert.ok(pkg.files.includes('!docs/SCREENSHOTS.md'), '截图文档引用的是不随包的图片，也不进 npm 包');
  assert.ok(pkg.files.includes('!custom/templates/anime/**'), '本地自定义模板（可能涉版权素材）不进 npm 包');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /assets\/anime|二次元插画/, 'README 不应再引用本地二次元素材');
});

test('package.json：预发布版本只发 next 标签，兼容范围写清楚', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'version 必须是合法 semver');
  if (pkg.version.includes('-')) {
    assert.equal(pkg.publishConfig?.tag, 'next', '预发布版本必须发到 next，避免 latest 被 alpha 覆盖');
  }
  assert.equal(pkg.publishConfig?.access, 'public');
  assert.ok(pkg.engines?.dsh, '要用 engines.dsh 声明兼容的 dsh 版本');
  assert.match(pkg.engines.dsh, /0\.2\./, 'engines.dsh 应覆盖当前 dsh 0.2.x');
  assert.match(String(pkg.engines?.node), />=\s*24/, 'Node 下限是 24（node:sqlite）');
});

test('cordis.patch.yml：bundle 声明与插件入口一致', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: qqbot-buddy/);
  assert.match(patch, /name: dsh-qqbot-buddy/);
  assert.match(patch, /id: preset-qqbot-buddy/, 'agent preset 必须随 bundle 提供');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
});

test('README：不内嵌图片，截图集中在 docs/SCREENSHOTS.md', () => {
  const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
  assert.deepEqual(images, [], 'README 保持纯文本：内嵌图片对 npm 页面没有意义，也拖慢加载');

  const shots = fs.readFileSync(path.join(ROOT, 'docs', 'SCREENSHOTS.md'), 'utf8');
  const refs = [...shots.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
  assert.ok(refs.length >= 5, 'SCREENSHOTS.md 至少要有几张截图');
  for (const ref of refs) {
    assert.ok(!/^https?:\/\//.test(ref), '截图文档用仓库相对路径（GitHub 直接渲染）: ' + ref);
    assert.ok(fs.existsSync(path.join(ROOT, 'docs', ref)), '截图不存在: docs/' + ref);
  }
});

test('README：文档链接指向仓库里真实存在的文件', () => {
  const links = [...readme.matchAll(/\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)/g)]
    .map((match) => ({ label: match[1], url: match[2] }))
    .filter((item) => item.url.includes('/' + REPO_SLUG + '/') && item.url.includes('/blob/'));
  assert.ok(links.length > 0, 'README 应链接到用户手册等文档');
  for (const link of links) {
    const local = localPathOf(link.url);
    if (local === '') continue;
    const target = local.split('#')[0];
    assert.ok(fs.existsSync(path.join(ROOT, target)), 'README 链接的文档不存在: ' + target + '（' + link.label + '）');
    assert.ok(link.url.includes('/blob/' + BRANCH + '/'), '文档链接应固定在发布分支 ' + BRANCH + '：' + link.url);
  }
});
