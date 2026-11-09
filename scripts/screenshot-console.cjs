/* eslint-disable */
/** 控制台视觉验收：登录 + 逐页截图。用法：NODE_PATH=$(npm root -g) node scripts/screenshot-console.cjs <baseUrl> <token> <outDir> */
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:6211';
  const token = process.argv[3] || fs.readFileSync(path.join(__dirname, '..', '.work/console-dev/console-token.txt'), 'utf8').trim();
  const outDir = process.argv[4] || path.join(__dirname, '..', '.work/shots');
  fs.mkdirSync(outDir, { recursive: true });

  const executablePath = process.env.CHROME_PATH || undefined;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

  const shot = async (name) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, name + '.png'), fullPage: false });
    console.log('shot:', name);
  };

  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot('01-login');

  const input = page.locator('#console-token');
  if (await input.count()) {
    await input.fill(token);
    const btn = page.getByRole('button', { name: /登录|进入|连接/ }).first();
    if (await btn.count()) await btn.click();
  }
  await page.waitForTimeout(1500);
  await shot('02-overview');

  for (const [route, name] of [['/bots', '03-bots'], ['/profiles', '04-profiles'], ['/tools', '05-tools'], ['/knowledge', '06-knowledge'], ['/settings', '07-settings'], ['/audit', '08-audit']]) {
    await page.goto(base + '/#' + route, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await shot(name);
  }

  console.log('console errors:', errors.length ? JSON.stringify(errors.slice(0, 8)) : 'none');
  console.log('final url:', page.url());
  await browser.close();
})().catch((err) => { console.error('SCREENSHOT FAIL', err); process.exit(1); });
