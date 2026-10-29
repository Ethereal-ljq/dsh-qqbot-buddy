#!/usr/bin/env node
/**
 * test/e2e/settings-screenshots.cjs —— 浏览器验收：设置页「QQ 机器人」5 个 tab 截图 + 控制台错误检查。
 *
 * 用法（Playwright 全局安装，用 NODE_PATH 解析）：
 *   NODE_PATH=$(npm root -g) node test/e2e/settings-screenshots.cjs \
 *     --url "http://127.0.0.1:3099/?token=XXXX" \
 *     --out /tmp/dsh-qqbot-test/project/dsh-qqbot-buddy/test/artifacts \
 *     --state-url http://127.0.0.1:3099/qqbot-buddy/api/state
 *
 * 退出码：0=全部 tab 截到且无控制台错误；1=有失败（打印 JSON 明细）。
 * 说明：DSH web 的首次访问 URL 带 ?token=，用它建立浏览器信任；脚本不会修改任何状态。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = { urls: [], timeout: 90000 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--url') { out.url = next; i += 1; }
    else if (key === '--out') { out.out = next; i += 1; }
    else if (key === '--state-url') { out.stateUrl = next; i += 1; }
    else if (key === '--bind-state-url') { out.bindStateUrl = next; i += 1; }
    else if (key === '--timeout') { out.timeout = Number(next); i += 1; }
    else if (key.startsWith('--')) { out.urls.push(key); }
  }
  return out;
}

// UI（v0.15「工作区 → 页面」）：6 个工作区 / 16 个页面。
// 结构来自 lib/settings-schema.js —— 这里只列验收顺序，label 必须与之完全一致。
// group = 顶部工作区 tab；page = 工作区内的页面胶囊（单页工作区为 null）。
const TABS = [
  { id: 'overview', group: '概览', label: null, file: '01-overview.png' },
  { id: 'reply', group: '对话', label: '回复策略', file: '02-dialog-reply.png' },
  { id: 'triggers', group: '对话', label: '触发规则', file: '03-dialog-triggers.png' },
  { id: 'messageStyle', group: '对话', label: '语气与分条', file: '04-dialog-style.png' },
  { id: 'model', group: '能力', label: '模型与预设', file: '05-ability-model.png' },
  { id: 'tools', group: '能力', label: '能力与工具', file: '06-ability-tools.png' },
  { id: 'promptOrder', group: '提示词', label: '组装顺序', file: '07-prompts-order.png' },
  { id: 'identity', group: '提示词', label: '身份与人格', file: '08-prompts-identity.png' },
  { id: 'speech', group: '提示词', label: '说话方式', file: '09-prompts-speech.png' },
  { id: 'phrases', group: '提示词', label: '口头禅', file: '10-prompts-phrases.png' },
  { id: 'toolGuide', group: '提示词', label: '工具约定', file: '11-prompts-toolguide.png' },
  { id: 'finalPrompt', group: '提示词', label: '最终提示词', file: '12-prompts-final.png' },
  { id: 'stickers', group: '内容', label: '表情包', file: '13-content-stickers.png' },
  { id: 'memory', group: '内容', label: '记忆与自我改进', file: '14-content-memory.png' },
  { id: 'commands', group: '权限', label: '命令与管理员', file: '15-security-commands.png' },
  { id: 'safety', group: '权限', label: '安全红线', file: '16-security-safety.png' },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.out) {
    console.error('用法: node settings-screenshots.cjs --url <带 token 的 URL> --out <截图目录> [--state-url URL]');
    process.exit(2);
  }
  fs.mkdirSync(args.out, { recursive: true });
  let playwright;
  try {
    playwright = require('playwright');
  } catch (error) {
    console.error('找不到 playwright，请用 NODE_PATH=$(npm root -g) 运行:', error.message);
    process.exit(2);
  }

  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const badResponses = [];
  const report = { ok: false, url: args.url, out: args.out, tabs: [], consoleErrors, pageErrors, requestFailures, badResponses };

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(String(error && error.message ? error.message : error)));
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      requestFailures.push({ url: request.url(), error: failure ? failure.errorText : 'unknown' });
    });
    page.on('response', (response) => {
      if (response.status() >= 400) badResponses.push({ status: response.status(), url: response.url() });
    });

    // 1. 打开 DSH Web（URL 带 token，首次访问建立浏览器信任）。
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: args.timeout });
    await page.waitForTimeout(1500);

    // 2. 关闭首屏引导/提示弹层（空白 profile 没有凭据：会出现「预览版说明」「开始使用」）。
    await page.waitForTimeout(2500);
    const dismissOnboarding = async () => {
      for (let i = 0; i < 5; i += 1) {
        const dialogs = page.locator('[role="dialog"]');
        if ((await dialogs.count()) === 0) return;
        let acted = false;
        for (const name of ['继续', '我知道了', '开始使用', '关闭']) {
          const btn = page.getByRole('button', { name, exact: true }).first();
          if (await btn.count()) {
            await btn.click({ timeout: 3000 }).catch(() => {});
            acted = true;
            await page.waitForTimeout(500);
            break;
          }
        }
        if (!acted) {
          const x = dialogs.first().locator('button[aria-label="关闭"], button[aria-label="Close"]').first();
          if (await x.count()) { await x.click({ timeout: 3000 }).catch(() => {}); acted = true; }
        }
        if (!acted) { await page.keyboard.press('Escape').catch(() => {}); }
        await page.waitForTimeout(400);
      }
    };
    await dismissOnboarding();
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    const closeHint = page.locator('button[aria-label="关闭提示"]').first();
    if (await closeHint.count()) {
      await closeHint.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
    }

    // 3. 打开设置：本版 DSH 的设置入口在左下角「更多（账号菜单）」→ menuitem「设置」。
    let settingsOpened = false;
    const menuButton = page.locator('button[aria-label="账号菜单"]').first();
    if (await menuButton.count()) {
      try {
        await menuButton.click({ timeout: 8000 });
        await page.waitForTimeout(800);
        const settingsItem = page.getByRole('menuitem', { name: '设置', exact: true }).first();
        if (await settingsItem.count()) {
          await settingsItem.click({ timeout: 8000 });
          settingsOpened = true;
        }
      } catch (error) {
        settingsOpened = false;
      }
    }
    // 兜底 1：直接的设置齿轮按钮（部分布局/版本）。
    if (!settingsOpened) {
      const gear = page.locator('button[aria-label="设置"], button[aria-label="Settings"]').first();
      if (await gear.count()) {
        await gear.click({ timeout: 8000 }).catch(() => {});
        settingsOpened = true;
      }
    }
    // 兜底 2：快捷键（设置页注册了 Ctrl+, / Command+,）。
    if (!settingsOpened) await page.keyboard.press('Control+Comma').catch(() => {});
    await page.waitForTimeout(1800);
    report.settingsOpened = settingsOpened;
    await page.screenshot({ path: path.join(args.out, '00-settings-panel.png'), fullPage: true }).catch(() => {});

    // 4. 找到「QQ 机器人」栏目（settings.section 注册项）；找不到时保存调试截图 + 正文。
    const sectionTitle = page.getByText('QQ 机器人', { exact: false }).first();
    try {
      await sectionTitle.waitFor({ state: 'visible', timeout: 30000 });
    } catch (error) {
      await page.screenshot({ path: path.join(args.out, '00-debug-no-section.png'), fullPage: true }).catch(() => {});
      report.bodyText = String(await page.textContent('body').catch(() => '')).slice(0, 4000);
      throw new Error('设置面板里找不到「QQ 机器人」section（客户端 bundle 是否加载失败？），已保存 00-debug-no-section.png');
    }
    await sectionTitle.scrollIntoViewIfNeeded().catch(() => {});
    // 侧栏 nav 里点击「QQ 机器人」激活该 section（默认是第一个 section）。
    if ((await page.getByRole('tab', { name: TABS[0].group, exact: true }).count()) === 0) {
      await sectionTitle.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
    report.sectionFound = true;

    /** 关闭 DSH 右上角的提示气泡（如「试试更轻巧的侧栏」），避免遮挡截图。 */
    const dismissToasts = async () => {
      for (let i = 0; i < 4; i += 1) {
        const close = page.locator('button[aria-label="关闭提示"]');
        if ((await close.count()) === 0) break;
        await close.first().click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(200);
      }
    };

    /** 点一个 workspce/page 标签：优先 role=tab，其次 button，最后按文本。 */
    const clickLabel = async (label) => {
      const candidates = [
        page.getByRole('tab', { name: new RegExp('^' + label) }).first(),
        page.getByRole('button', { name: new RegExp('^' + label) }).first(),
        page.getByText(label, { exact: true }).first(),
      ];
      for (const candidate of candidates) {
        try {
          if (await candidate.count()) {
            await candidate.click({ timeout: 8000 });
            return true;
          }
        } catch (error) {
          /* 换下一个候选 */
        }
      }
      return false;
    };

    // 4. 逐个「工作区 → 页面」点击 + 截图。
    for (const tab of TABS) {
      let clickedTab = false;
      if (await clickLabel(tab.group)) {
        await page.waitForTimeout(600);
        clickedTab = tab.label === null ? true : await clickLabel(tab.label);
      }
      await page.waitForTimeout(900);
      await dismissToasts();
      // 「权限 → 命令与管理员」页下方是管理员设置卡片：截图前滚到该区域，保证一图覆盖命令列表 + 管理员配置。
      if (tab.id === 'commands') {
        const adminHeading = page.getByText('管理员', { exact: false }).last();
        if (await adminHeading.count()) {
          await adminHeading.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(300);
        }
      }
      const target = path.join(args.out, tab.file);
      await page.screenshot({ path: target, fullPage: true });
      const bodyText = await page.textContent('body').catch(() => '');
      report.tabs.push({ id: tab.id, label: tab.label, file: target, clicked: clickedTab, textLength: String(bodyText || '').length });
      if (!clickedTab) report.tabsError = (report.tabsError || []).concat((tab.group || '') + '/' + (tab.label || '') + ' 未能点击');
    }

    // 5. 概览页的「连接/绑定」卡片单独截图（17-binding.png）。
    try {
      if (await clickLabel('概览')) await page.waitForTimeout(1200);
      await dismissToasts();
      const bindingFile = path.join(args.out, '17-binding.png');
      // 优先只截「连接与绑定」卡片；找不到时退回整页截图。
      const bindingCard = page.locator('.qqb-card', { hasText: '连接与绑定' }).first();
      if (await bindingCard.count()) {
        await bindingCard.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(400);
        await bindingCard.screenshot({ path: bindingFile });
      } else {
        await page.screenshot({ path: bindingFile, fullPage: true });
      }
      report.bindingScreenshot = bindingFile;
    } catch (error) {
      report.bindingScreenshotError = String(error && error.message ? error.message : error);
    }

    // 6. 校验绑定态：隔离实例必须不是 bound（避免把 live 真实凭据当成已绑定）。
    if (args.bindStateUrl) {
      try {
        const response = await context.request.get(args.bindStateUrl, { timeout: 30000 });
        const bindState = await response.json();
        report.bindState = { status: response.status(), body: bindState };
        if (response.status() !== 200 || bindState.ok !== true) {
          report.ok = false;
          report.bindStateError = 'bind/state 非 200/ok';
        } else if (bindState.phase === 'bound') {
          report.ok = false;
          report.bindStateError = '隔离实例意外处于 bound 状态（可能使用了真实凭据）';
        }
      } catch (error) {
        report.ok = false;
        report.bindStateError = String(error && error.message ? error.message : error);
      }
    }

    // 7. 再直接验证一次 /api/state（页面内 fetch，走同源）。
    if (args.stateUrl) {
      try {
        const response = await context.request.get(args.stateUrl, { timeout: 30000 });
        report.state = { status: response.status(), body: await response.json() };
      } catch (error) {
        report.state = { error: String(error && error.message ? error.message : error) };
      }
    }

    report.ok = consoleErrors.length === 0 && pageErrors.length === 0 && report.tabs.every((tab) => tab.clicked);
  } finally {
    await browser.close().catch(() => {});
    fs.writeFileSync(path.join(args.out, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('浏览器验收脚本异常:', error && error.stack ? error.stack : error);
  process.exit(1);
});