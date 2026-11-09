/**
 * E2E：真实 dsh 隔离实例验收（默认跳过，需显式开启，避免 npm test 变慢/依赖宿主环境）。
 *
 * 运行（需 Node 24 的 dsh 在 PATH 或 DSH_BIN 指定）：
 *   QQBOT_E2E=1 node --test test/e2e/real-dsh.test.js
 *
 * 可选环境变量：
 *   QQBOT_E2E_DSH_HOME   隔离 DSH_HOME（默认 <repo>/.work/integration/dsh-home）
 *   QQBOT_E2E_SKIP_SMOKE 1 = 只跑冷会话探针，不跑冒烟
 *
 * 覆盖：
 *   1) scripts/probe-tools.mjs：真实 dsh 里建会话 → 首轮 assembly → dispose → resume →
 *      再 assembly，断言工具集合与 qqbot:* 段一致（读取 .work/probe-tools.json）；
 *   2) scripts/smoke-dsh.mjs：隔离安装 → 起实例 → 控制台鉴权/接口 → 建 bot/启动失败优雅退出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENABLED = process.env.QQBOT_E2E === '1';
const DSH_HOME = process.env.QQBOT_E2E_DSH_HOME || path.join(REPO_ROOT, '.work', 'integration', 'dsh-home');
const SKIP_SMOKE = process.env.QQBOT_E2E_SKIP_SMOKE === '1';

/** 同步跑脚本（spawnSync 超时由 node:test 的 timeout 以外层兜底；脚本内部有自身超时）。 */
function runScript(script, args, timeoutMs) {
  return spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), '--dsh-home', DSH_HOME, ...args], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { DSH_HOME }),
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function outputOf(result) {
  return '\n--- stdout ---\n' + String(result.stdout || '').slice(-4000)
    + '\n--- stderr ---\n' + String(result.stderr || '').slice(-4000);
}

test('真实 dsh 冷会话探针：工具集合与 qqbot:* 段一致', { skip: !ENABLED, timeout: 360000 }, () => {
  const result = runScript('probe-tools.mjs', [], 330000);
  assert.equal(result.status, 0, 'probe-tools.mjs 应通过（exit ' + result.status + '）' + outputOf(result));

  const outFile = path.join(REPO_ROOT, '.work', 'probe-tools.json');
  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(report.ok, true, '探针整体 ok 应为 true');
  assert.equal(report.checks.toolsStable.pass, true, '两次 assembly 的工具集合必须一致');
  assert.equal(report.checks.qqbotSectionsPresent.pass, true, 'qqbot:persona / qqbot:guide 两次都必须存在');
  assert.equal(report.checks.qqbotTextStable.pass, true, 'qqbot:* 渲染文本两次必须一致');
  assert.ok(report.first.qqbotSectionNames.includes('qqbot:persona'));
  assert.ok(report.first.qqbotSectionNames.includes('qqbot:guide'));
  assert.ok(Array.isArray(report.first.visibleToolNames) && report.first.visibleToolNames.length > 0, '可见工具集合不能为空');
});

test('真实 dsh 冒烟：安装/启动/控制台/建 bot/启动失败优雅', { skip: !ENABLED || SKIP_SMOKE, timeout: 600000 }, () => {
  const result = runScript('smoke-dsh.mjs', [], 560000);
  assert.equal(result.status, 0, 'smoke-dsh.mjs 应全部步骤通过（exit ' + result.status + '）' + outputOf(result));

  const reportFile = path.join(REPO_ROOT, '.work', 'smoke-dsh.json');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.ok, true);
  const failed = report.steps.filter((step) => !step.ok);
  assert.equal(failed.length, 0, '失败步骤：' + JSON.stringify(failed));
});
