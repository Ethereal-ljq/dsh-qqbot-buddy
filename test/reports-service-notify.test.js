/**
 * reports-service —— 日报失败提示开关（notifyOnFailure）。
 *
 * 覆盖：失败回一条（带日期 + 补跑命令）/ 每群每天最多一次 / 低阈值跳过不算失败 /
 * 开关关闭与「只生成不发送」都不发 / 主动消息权限不足时只记 warn。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDailyService } from '../lib/reports/service.js';

function makeService({ sendOk = true } = {}) {
  const sent = [];
  const logs = { info: [], warn: [] };
  const service = createDailyService({
    config: { getEffectiveSettings: () => ({ daily: {} }) },
    flow: { list: () => [], peers: () => [] },
    reports: {
      save: () => ({}), get: () => null, markDelivered() {}, setError() {}, setImage() {}, latest: () => null,
    },
    oneShot: { generate: async () => ({ ok: false, text: '', error: '模型未返回文本' }) },
    host: {
      runtimeOf: () => ({
        transport: {
          messageSender: {
            sendProactive: async (target, text) => {
              sent.push({ target, text });
              return sendOk ? { ok: true } : { ok: false, code: '40034105' };
            },
          },
          mediaSender: null,
        },
      }),
    },
    logger: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
    dataDir: '',
    render: null,
  });
  return { service, sent, logs };
}

const failedResult = (reason = 'llm-failed', error = '模型未返回文本') => ({ ok: false, reason, report: { error } });
const ON = { notifyOnFailure: true, delivery: 'proactive' };

test('notifyFailure：失败时在群里回一条，带日期与补跑命令', async () => {
  const { service, sent } = makeService();
  const out = await service.notifyFailure({
    botId: 'b1', peer: 'group:G1', day: '2026-11-20', cfg: ON, result: failedResult(),
  });
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].target, { scope: 'group', targetId: 'G1' });
  assert.match(sent[0].text, /群日报生成失败（2026-11-20）/);
  assert.match(sent[0].text, /模型未返回文本/);
  assert.match(sent[0].text, /\/daily 2026-11-20/);
});

test('notifyFailure：同一个群同一天只发一次（重启/重试不刷屏）', async () => {
  const { service, sent } = makeService();
  await service.notifyFailure({ botId: 'b1', peer: 'group:G1', day: '2026-11-20', cfg: ON, result: failedResult() });
  const second = await service.notifyFailure({ botId: 'b1', peer: 'group:G1', day: '2026-11-20', cfg: ON, result: failedResult() });
  assert.equal(sent.length, 1);
  assert.equal(second.skipped, 'duplicate');
  const otherDay = await service.notifyFailure({ botId: 'b1', peer: 'group:G1', day: '2026-11-21', cfg: ON, result: failedResult() });
  assert.equal(otherDay.ok, true, '换一天还能发');
  assert.equal(sent.length, 2);
});

test('notifyFailure：低阈值跳过不算失败，不发', async () => {
  const { service, sent } = makeService();
  const out = await service.notifyFailure({
    botId: 'b1', peer: 'group:G1', day: '2026-11-20', cfg: ON, result: failedResult('below-threshold', '低于阈值'),
  });
  assert.equal(out.skipped, 'not-a-failure');
  assert.equal(sent.length, 0);
});

test('notifyFailure：开关关闭 / 只生成不发送 都不发', async () => {
  const { service, sent } = makeService();
  const off = await service.notifyFailure({
    botId: 'b1', peer: 'group:G1', day: '2026-11-20', cfg: { notifyOnFailure: false, delivery: 'proactive' }, result: failedResult(),
  });
  assert.equal(off.skipped, 'disabled');
  const noDelivery = await service.notifyFailure({
    botId: 'b1', peer: 'group:G1', day: '2026-11-20', cfg: { notifyOnFailure: true, delivery: 'off' }, result: failedResult(),
  });
  assert.equal(noDelivery.skipped, 'delivery-off');
  assert.equal(sent.length, 0);
});

test('notifyFailure：主动消息无权限时只记 warn，不抛错', async () => {
  const { service, sent, logs } = makeService({ sendOk: false });
  const out = await service.notifyFailure({
    botId: 'b1', peer: 'group:G1', day: '2026-11-20', cfg: ON, result: failedResult(),
  });
  assert.equal(out.ok, false);
  assert.equal(sent.length, 1);
  assert.ok(logs.warn.some((m) => /群日报失败提示发送失败/.test(m)));
});
