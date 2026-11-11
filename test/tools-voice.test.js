/**
 * tools-voice —— 内置工具 qqbot_speak：TTS 合成 + 语音发送（docs/MODELS-CENTER.md §8）。
 *
 * 全部用 fake tts / mediaSender（不联网、不落盘）：覆盖
 *   - tts 缺失时降级不注册（warn）；
 *   - voice.enabled 总开关（含 getSettings 热更新）；
 *   - 无可用供应商的可读错误；
 *   - 合成成功 -> exec.agent -> replyTarget -> mediaSender.sendVoice 的完整链路；
 *   - voice/style 覆盖参数透传、长文本截断提示；
 *   - 发送失败 deliveryUnknown 原样透传；引擎错误码透传。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceTools, SPEAK_TOOL_NAME } from '../lib/tools/voice.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** 记录 warn 的 logger（降级注册断言用）。 */
function createLoggerSpy() {
  const warnings = [];
  return {
    warnings,
    info() {},
    debug() {},
    error() {},
    warn(...args) { warnings.push(args.map(String).join(' ')); },
  };
}

const TARGET = { scope: 'c2c', targetId: 'U1', msgId: 'm-in' };
const FILE_PATH = '/tmp/qqbot-tts/20261112-000000-ab12cd.mp3';

/** 假 TTS 引擎：契约见 docs/MODELS-CENTER.md §6（resolveSelection / synthesizeForSettings）。 */
function createFakeTts({ selection = { provider: 'edge', providerId: 'tts_1', voice: 'zh-CN-XiaoxiaoNeural', style: '', speed: 1, maxChars: 300 }, result } = {}) {
  const calls = { synthesize: [], resolve: [] };
  return {
    calls,
    selection,
    resolveSelection(args) { calls.resolve.push(args); return selection; },
    async synthesizeForSettings(args) {
      calls.synthesize.push(args);
      if (result !== undefined) return typeof result === 'function' ? result(args) : result;
      return {
        ok: true,
        providerId: 'tts_1',
        kind: 'edge',
        model: 'edge-tts',
        voice: args.voice || 'zh-CN-XiaoxiaoNeural',
        format: 'mp3',
        filePath: FILE_PATH,
        bytes: 2048,
        ms: 42,
        segments: 1,
        truncated: false,
        text: args.text,
      };
    },
  };
}

/** 假媒体发送器：记录 sendVoice 调用，可注入失败。 */
function createMediaSender({ error } = {}) {
  const calls = [];
  return {
    calls,
    async sendVoice(target, source) {
      calls.push({ target, source });
      if (error) throw error;
      return { message: { id: 'voice-msg-1' } };
    },
  };
}

/** 假会话管理器：findByAgent 返回 { replyTarget } 或 null。 */
function createManager({ replyTarget = TARGET, record = true } = {}) {
  return {
    calls: 0,
    findByAgent() { this.calls += 1; return record ? { replyTarget } : null; },
  };
}

/** 组装一次工具实例；rig.settings 可变，用于验证每次 execute 现读设置。 */
function createRig({ tts, settings, manager, mediaSender, logger = silentLogger } = {}) {
  const rig = {
    tts: tts === undefined ? createFakeTts() : tts,
    settings: settings === undefined ? { voice: { enabled: true } } : settings,
    manager: manager === undefined ? createManager() : manager,
    mediaSender: mediaSender === undefined ? createMediaSender() : mediaSender,
  };
  rig.defs = createVoiceTools({
    tts: rig.tts,
    manager: rig.manager,
    mediaSender: rig.mediaSender,
    getSettings: () => rig.settings,
    config: {},
    logger,
  });
  rig.def = rig.defs[0];
  return rig;
}

// ── 降级注册 ──────────────────────────────────────────────

test('TTS 引擎不可用时降级不注册（只 warn，不抛）', () => {
  const logger = createLoggerSpy();
  assert.deepEqual(createVoiceTools({ tts: null, manager: createManager(), mediaSender: createMediaSender(), logger }), []);
  assert.ok(logger.warnings.some((line) => line.includes('TTS')), '应记录 warn');
  // 形状不对（缺少 synthesizeForSettings）同样不注册
  assert.deepEqual(createVoiceTools({ tts: {}, manager: createManager(), mediaSender: createMediaSender(), logger }), []);
});

// ── 总开关 / 供应商 ──────────────────────────────────────

test('voice.enabled=false：拒绝执行且不调用引擎；打开后同一工具定义立即可用（热更新）', async () => {
  const tts = createFakeTts();
  const rig = createRig({ tts, settings: { voice: { enabled: false } } });
  assert.equal(rig.def.name, SPEAK_TOOL_NAME);
  await assert.rejects(() => rig.def.execute({ text: '你好' }, { agent: {} }), /语音合成未启用/);
  assert.equal(tts.calls.synthesize.length, 0);

  rig.settings = { voice: { enabled: true } };
  const value = await rig.def.execute({ text: '你好' }, { agent: {} });
  assert.equal(value.ok, true);
  assert.equal(tts.calls.synthesize.length, 1);
});

test('无可用供应商（resolveSelection 返回 null）：给出可读中文错误，不调用合成', async () => {
  const tts = createFakeTts({ selection: null });
  const rig = createRig({ tts });
  await assert.rejects(() => rig.def.execute({ text: '你好' }, { agent: {} }), /未配置可用的 TTS 供应商/);
  assert.equal(tts.calls.synthesize.length, 0);
});

// ── 成功链路 ─────────────────────────────────────────────

test('合成成功：经 mediaSender.sendVoice 发到当前会话并返回结构化结果', async () => {
  const tts = createFakeTts();
  const mediaSender = createMediaSender();
  const signal = new AbortController().signal;
  const rig = createRig({ tts, mediaSender });
  const value = await rig.def.execute({ text: '  你好，世界  ' }, { agent: { id: 'agent-1' }, signal });

  assert.equal(tts.calls.synthesize.length, 1);
  const synth = tts.calls.synthesize[0];
  assert.equal(synth.text, '你好，世界', 'text 应 trim 后传给引擎');
  assert.equal(synth.settings, rig.settings, '应把当前生效设置传给引擎');
  assert.equal(synth.signal, signal, '调用方 signal 应透传（取消合成/超时）');
  assert.equal('voice' in synth, false, '未指定 voice 时不能传空值覆盖配置档');
  assert.equal('style' in synth, false);

  assert.equal(mediaSender.calls.length, 1);
  assert.deepEqual(mediaSender.calls[0].target, TARGET);
  assert.deepEqual(mediaSender.calls[0].source, { localPath: FILE_PATH });

  assert.deepEqual(value, {
    ok: true,
    provider: 'tts_1',
    voice: 'zh-CN-XiaoxiaoNeural',
    format: 'mp3',
    bytes: 2048,
    filePath: FILE_PATH,
    target: 'c2c:U1',
    truncated: false,
  });
  assert.deepEqual(rig.def.output.render(undefined, value), [
    { type: 'text', text: '已发送语音（tts_1 / zh-CN-XiaoxiaoNeural） -> c2c:U1' },
  ]);
});

test('voice/style 覆盖参数透传给引擎；未提供时不传', async () => {
  const tts = createFakeTts();
  const rig = createRig({ tts });
  await rig.def.execute({ text: '第一句', voice: ' zh-CN-YunxiNeural ', style: '温柔' }, { agent: {} });
  assert.equal(tts.calls.synthesize[0].voice, 'zh-CN-YunxiNeural');
  assert.equal(tts.calls.synthesize[0].style, '温柔');

  await rig.def.execute({ text: '第二句' }, { agent: {} });
  assert.equal('voice' in tts.calls.synthesize[1], false);
  assert.equal('style' in tts.calls.synthesize[1], false);
});

test('长文本截断：truncated 透出到结果，render 明确提示已截断', async () => {
  const tts = createFakeTts({
    result: (args) => ({
      ok: true,
      providerId: 'tts_1',
      voice: 'zh-CN-XiaoxiaoNeural',
      format: 'wav',
      filePath: FILE_PATH,
      bytes: 512,
      segments: 1,
      truncated: true,
      text: args.text.slice(0, 5),
    }),
  });
  const rig = createRig({ tts });
  const value = await rig.def.execute({ text: '很长'.repeat(300) }, { agent: {} });
  assert.equal(value.truncated, true);
  assert.equal(value.format, 'wav');
  const rendered = rig.def.output.render(undefined, value)[0].text;
  assert.match(rendered, /截断/);
});

// ── 校验 / 失败语义 ──────────────────────────────────────

test('text 为空或只有空白：直接拒绝，不调用引擎', async () => {
  const tts = createFakeTts();
  const rig = createRig({ tts });
  await assert.rejects(() => rig.def.execute({}, { agent: {} }), /text 不能为空/);
  await assert.rejects(() => rig.def.execute({ text: '   ' }, { agent: {} }), /text 不能为空/);
  assert.equal(tts.calls.synthesize.length, 0);
});

test('找不到当前会话目标：可读错误且不发送', async () => {
  const mediaSender = createMediaSender();
  const rig = createRig({ manager: createManager({ record: false }), mediaSender });
  await assert.rejects(() => rig.def.execute({ text: '你好' }, { agent: {} }), /无法确定发送目标/);
  assert.equal(mediaSender.calls.length, 0);
});

test('发送失败 deliveryUnknown：原样抛（同一个错误对象，不包装不改语义）', async () => {
  const unknown = Object.assign(new Error('媒体消息可能已经发出（timeout）'), {
    deliveryUnknown: true,
    code: 'UNKNOWN_DELIVERY',
  });
  const rig = createRig({ mediaSender: createMediaSender({ error: unknown }) });
  await assert.rejects(() => rig.def.execute({ text: '你好' }, { agent: {} }), (err) => {
    assert.equal(err, unknown, '必须原样透传同一个错误对象');
    assert.equal(err.deliveryUnknown, true);
    assert.equal(err.code, 'UNKNOWN_DELIVERY');
    return true;
  });
});

test('引擎错误（TTS_UPSTREAM）原样透出 .code；返回 ok:false 时也给出可读错误', async () => {
  const failing = createFakeTts();
  failing.synthesizeForSettings = async () => {
    const err = new Error('TTS 上游服务失败');
    err.code = 'TTS_UPSTREAM';
    throw err;
  };
  const rig = createRig({ tts: failing });
  await assert.rejects(() => rig.def.execute({ text: '你好' }, { agent: {} }), (err) => {
    assert.equal(err.code, 'TTS_UPSTREAM');
    assert.match(err.message, /上游/);
    return true;
  });

  const notOk = createFakeTts({ result: { ok: false, code: 'TTS_CONFIG', error: '供应商配置缺少 baseUrl' } });
  const rig2 = createRig({ tts: notOk });
  await assert.rejects(() => rig2.def.execute({ text: '你好' }, { agent: {} }), (err) => {
    assert.equal(err.code, 'TTS_CONFIG');
    assert.match(err.message, /供应商配置缺少 baseUrl/);
    return true;
  });
});
