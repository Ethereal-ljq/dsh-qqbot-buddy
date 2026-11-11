/**
 * test/tts-providers —— TTS 供应商元数据 / 入参校验 / 脱敏视图（core/tts/providers.js）。
 *
 * 只测纯函数，不碰 DB / 网络 / 文件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TTS_KINDS, TTS_KIND_LIST, kindOf, publicKinds, defaultConfigFor,
  normalizeProviderInput, providerView, fieldOptions,
} from '../lib/core/tts/providers.js';

const EXPECTED_KINDS = ['bailian', 'command', 'custom', 'edge', 'mimo', 'openai'];
const FIELD_TYPES = new Set(['text', 'textarea', 'select', 'number', 'json']);

test('kind 元数据齐全且自洽', () => {
  assert.deepEqual(Object.keys(TTS_KINDS).sort(), EXPECTED_KINDS);
  assert.equal(TTS_KIND_LIST.length, EXPECTED_KINDS.length);
  for (const meta of TTS_KIND_LIST) {
    assert.equal(TTS_KINDS[meta.id], meta, 'TTS_KIND_LIST 与 TTS_KINDS 指向同一对象');
    for (const key of ['label', 'short', 'desc', 'secretHelp']) {
      assert.equal(typeof meta[key], 'string', meta.id + '.' + key);
    }
    assert.equal(typeof meta.needsSecret, 'boolean');
    assert.ok(['mp3', 'wav'].includes(meta.outputFormat), meta.id + '.outputFormat');
    assert.ok(meta.maxCharsPerRequest > 0, meta.id + '.maxCharsPerRequest');
    assert.ok(meta.timeoutMs > 0, meta.id + '.timeoutMs');
    assert.ok(Array.isArray(meta.voices), meta.id + '.voices');
    assert.ok(Array.isArray(meta.models), meta.id + '.models');
    for (const item of [...meta.voices, ...meta.models]) {
      assert.equal(typeof item.value, 'string');
      assert.equal(typeof item.label, 'string');
    }
    const fieldKeys = new Set();
    for (const field of meta.fields) {
      assert.ok(FIELD_TYPES.has(field.type), meta.id + '.' + field.key + ' 字段类型非法: ' + field.type);
      assert.equal(typeof field.key, 'string');
      assert.ok(field.label !== undefined && field.label !== '', meta.id + '.' + field.key + ' 缺少 label');
      assert.equal(fieldKeys.has(field.key), false, meta.id + ' 字段 key 重复: ' + field.key);
      fieldKeys.add(field.key);
    }
    // defaultConfig 里的 key 必须是可编辑字段（否则 normalize 会忽略，默认值静默丢失）
    for (const key of Object.keys(meta.defaultConfig)) {
      assert.ok(fieldKeys.has(key), meta.id + '.defaultConfig 含未知字段: ' + key);
    }
  }
});

test('kindOf / publicKinds / defaultConfigFor 的边界与深拷贝', () => {
  assert.equal(kindOf('edge'), TTS_KINDS.edge);
  assert.equal(kindOf('nope'), null);
  assert.equal(kindOf(''), null);
  assert.equal(kindOf(123), null);
  assert.equal(kindOf(undefined), null);

  const first = publicKinds();
  assert.equal(first.length, EXPECTED_KINDS.length);
  first[0].label = '被外部改掉';
  first[0].fields[0].label = '被外部改掉';
  const second = publicKinds();
  assert.notEqual(second[0].label, '被外部改掉', 'publicKinds 必须返回深拷贝');
  assert.notEqual(second[0].fields[0].label, '被外部改掉');

  const config = defaultConfigFor('edge');
  assert.equal(config.voice, 'zh-CN-XiaoxiaoNeural');
  config.voice = '被外部改掉';
  assert.notEqual(defaultConfigFor('edge').voice, '被外部改掉');
  assert.deepEqual(defaultConfigFor('nope'), {});
});

test('normalizeProviderInput：新增时填充默认配置、忽略未知字段并告警', () => {
  const { value, warnings } = normalizeProviderInput({
    name: '   ',
    kind: 'edge',
    config: { rate: '+10%', notAField: 'x' },
  });
  assert.equal(value.kind, 'edge');
  assert.equal(value.name, TTS_KINDS.edge.label, '名称为空时回退 kind label');
  assert.equal(value.enabled, true);
  assert.equal(value.config.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(value.config.rate, '+10%');
  assert.equal('notAField' in value.config, false);
  // 未知字段被忽略时给出可读告警（控制台可展示）
  assert.ok(warnings.some((item) => item.includes('notAField')), '应提示未知配置项');
  // 不传 secret 时 value 里没有 secret 字段（新增由 store 落为空串）
  assert.equal(value.secret, undefined);
});

test('normalizeProviderInput：未知 kind / 必填缺失 / 非法 JSON 都抛中文错误', () => {
  assert.throws(() => normalizeProviderInput({ kind: 'nope' }), /未知的 TTS 供应商类型/);
  assert.throws(() => normalizeProviderInput({}), /未知的 TTS 供应商类型/);
  // custom 的 url 是必填：不传 / 传空串都会在必填校验处被拦下
  assert.throws(() => normalizeProviderInput({ kind: 'custom' }), /custom\.url/);
  assert.throws(() => normalizeProviderInput({ kind: 'custom', config: { url: '' } }), /custom\.url/);
  assert.throws(() => normalizeProviderInput({ kind: 'custom', config: { url: 'ftp://example.com/tts' } }), /只支持 http/);
  assert.throws(
    () => normalizeProviderInput({ kind: 'custom', config: { url: 'https://example.com/tts', responseType: 'json_base64', responsePath: '  ' } }),
    /responsePath/,
  );
  assert.throws(() => normalizeProviderInput({ kind: 'command', config: { command: '   ' } }), /command\.command/);
});

test('normalizeProviderInput：number 夹取 / json 请求头归一化 / secret 裁剪', () => {
  const openai = normalizeProviderInput({ kind: 'openai', config: { speed: 99 } });
  assert.equal(openai.value.config.speed, 4, 'number 字段超上限应夹取');
  const tooSmall = normalizeProviderInput({ kind: 'openai', config: { speed: 0.0001 } });
  assert.equal(tooSmall.value.config.speed, 0.25);

  const custom = normalizeProviderInput({
    kind: 'custom',
    secret: '  sk-abc  ',
    config: {
      url: 'http://127.0.0.1:9/tts',
      headers: { 'X-Trace': 'v', '': 'drop', 'X-Num': 2 },
    },
  });
  assert.deepEqual(custom.value.config.headers, { 'X-Trace': 'v', 'X-Num': '2' });
  assert.equal(custom.value.secret, 'sk-abc', 'secret 应裁剪首尾空白');
});

test('normalizeProviderInput：编辑时保留未提交的 name/config/enabled', () => {
  const existing = {
    id: 'tts_existing',
    name: '旧名字',
    kind: 'openai',
    enabled: 1,
    config: {
      baseUrl: 'https://old.example.com/v1',
      model: 'tts-1',
      voice: 'alloy',
      format: 'mp3',
      speed: 1,
      instructions: '温柔一点',
    },
  };
  const { value } = normalizeProviderInput({ kind: 'openai', config: { voice: 'nova' } }, { existing });
  assert.equal(value.name, '旧名字');
  assert.equal(value.enabled, true);
  assert.equal(value.config.baseUrl, 'https://old.example.com/v1');
  assert.equal(value.config.voice, 'nova');
  assert.equal(value.config.instructions, '温柔一点');
  assert.equal(value.secret, undefined, '未提交 secret 时 value 不应带 secret（store 保留原值）');

  const emptySecret = normalizeProviderInput({ kind: 'openai', secret: '' }, { existing });
  assert.equal(emptySecret.value.secret, '', '空串 secret 原样透传，由 store 决定保留语义');

  const disabled = normalizeProviderInput({ kind: 'openai', enabled: false }, { existing });
  assert.equal(disabled.value.enabled, false);
});

test('normalizeProviderInput：mimo voiceclone / voicedesign 的前置校验', () => {
  assert.throws(
    () => normalizeProviderInput({ kind: 'mimo', config: { model: 'mimo-v2.5-tts-voiceclone', samplePath: '   ' } }),
    /克隆样本/,
  );
  const clone = normalizeProviderInput({
    kind: 'mimo',
    config: { model: 'mimo-v2.5-tts-voiceclone', samplePath: '/tmp/sample.wav' },
  });
  assert.equal(clone.value.config.samplePath, '/tmp/sample.wav');
  assert.equal(clone.value.config.voice, 'mimo_default', '其余默认配置仍应填充');

  assert.throws(
    () => normalizeProviderInput({ kind: 'mimo', config: { model: 'mimo-v2.5-tts-voicedesign', style: '  ' } }),
    /描述想要的声音/,
  );
  const design = normalizeProviderInput({
    kind: 'mimo',
    config: { model: 'mimo-v2.5-tts-voicedesign', style: '温柔、稍快的女声' },
  });
  assert.equal(design.value.config.style, '温柔、稍快的女声');
});

test('providerView：脱敏、状态与摘要', () => {
  const row = {
    id: 'tts_000000000001',
    name: '我的百炼',
    kind: 'bailian',
    enabled: 1,
    config: { model: 'qwen3-tts-flash', voice: 'Cherry' },
    secret: 'sk-secret',
    created_at: 111,
    updated_at: 222,
  };
  const view = providerView(row);
  assert.equal('secret' in view, false, 'providerView 绝不能带 secret');
  assert.equal(view.hasSecret, true);
  assert.equal(view.id, row.id);
  assert.equal(view.kind, 'bailian');
  assert.equal(view.kindLabel, TTS_KINDS.bailian.label);
  assert.equal(view.kindShort, TTS_KINDS.bailian.short);
  assert.equal(view.outputFormat, 'wav');
  assert.equal(view.summary, 'qwen3-tts-flash · Cherry');
  assert.equal(view.createdAt, 111);
  assert.equal(view.updatedAt, 222);
  assert.equal(view.enabled, true);

  const emptySecret = providerView({ ...row, secret: '' });
  assert.equal(emptySecret.hasSecret, false);
  const disabled = providerView({ ...row, enabled: 0 });
  assert.equal(disabled.enabled, false);
  assert.equal(providerView(null), null);

  // 未知 kind 也不能抛错（老数据容错）
  const unknown = providerView({ id: 'tts_x', name: 'x', kind: 'mystery', enabled: 1, config: {}, secret: '', created_at: 1, updated_at: 1 });
  assert.equal(unknown.kindLabel, 'mystery');
  assert.equal(unknown.outputFormat, 'mp3');
  assert.equal(unknown.summary, '');

  // 摘要规则：command 截断命令、custom 无 model/voice 时显示 URL
  const commandView = providerView({ id: 'tts_c', name: 'c', kind: 'command', enabled: 1, config: { command: 'edge-tts --text hi --write-media out.mp3' }, secret: '', created_at: 1, updated_at: 1 });
  assert.match(commandView.summary, /^edge-tts --text hi/);
  const customView = providerView({ id: 'tts_u', name: 'u', kind: 'custom', enabled: 1, config: { url: 'https://example.com/tts' }, secret: '', created_at: 1, updated_at: 1 });
  assert.equal(customView.summary, 'https://example.com/tts');
});

test('fieldOptions：展开 voices/models 与静态 options', () => {
  const edgeVoice = TTS_KINDS.edge.fields.find((field) => field.key === 'voice');
  assert.deepEqual(fieldOptions('edge', edgeVoice), TTS_KINDS.edge.voices);

  const mimoModel = TTS_KINDS.mimo.fields.find((field) => field.key === 'model');
  assert.deepEqual(fieldOptions('mimo', mimoModel), TTS_KINDS.mimo.models);

  const customMethod = TTS_KINDS.custom.fields.find((field) => field.key === 'method');
  assert.deepEqual(fieldOptions('custom', customMethod), [
    { value: 'POST', label: 'POST' },
    { value: 'GET', label: 'GET' },
  ]);

  assert.deepEqual(fieldOptions('nope', edgeVoice), []);
  assert.deepEqual(fieldOptions('edge', null), []);
  assert.deepEqual(fieldOptions('edge', { key: 'model' }), []);
});
