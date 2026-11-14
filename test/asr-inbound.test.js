/**
 * test/asr-inbound —— QQ 入站语音转写（lib/qq/voice-asr.js）。
 *
 * 覆盖：未开启 ASR 时跳过；开启后调用 runtime.asr 并把结果整理成 processedAttachments；
 * 转换失败/ASR 失败时静默降级（不抛错）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { encodeWav } from '../lib/core/tts/audio.js';
import { createVoiceTranscriber } from '../lib/qq/voice-asr.js';

const QUIET = { debug() {}, info() {}, warn() {}, error() {} };
const WAV = encodeWav(Buffer.alloc(3200));
const hasFfmpeg = (() => {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
  return Boolean(probe && !probe.error && probe.status === 0);
})();

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-asr-inbound-'));
}

test('voice-asr：未开启 ASR / 无引擎时直接跳过', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'v.wav');
    fs.writeFileSync(file, WAV);
    const disabled = createVoiceTranscriber({
      asr: { transcribe: async () => ({ text: '不该被调用', durationMs: 1 }) },
      getSettings: () => ({ asr: { enabled: false } }),
      logger: QUIET,
    });
    assert.deepEqual(await disabled({ message: {}, files: [{ localPath: file }] }), []);
    assert.equal(createVoiceTranscriber({ asr: null, logger: QUIET }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('voice-asr：开启后转写并输出 processedAttachments（无 ffmpeg 时跳过）', async (t) => {
  if (!hasFfmpeg) {
    t.diagnostic('ffmpeg 不可用，跳过语音转写集成用例');
    return;
  }
  const dir = tempDir();
  try {
    const file = path.join(dir, 'v.wav');
    fs.writeFileSync(file, WAV);
    const calls = [];
    const transcriber = createVoiceTranscriber({
      asr: {
        transcribe: async (input) => {
          calls.push(input);
          return { text: '你好呀', durationMs: 2400, providerId: 'tts_asr' };
        },
      },
      getSettings: () => ({ asr: { enabled: true, maxSeconds: 60 } }),
      logger: QUIET,
    });
    const processed = await transcriber({ message: {}, files: [{ localPath: file }] });
    assert.equal(calls.length, 1);
    assert.match(calls[0].filePath, /voice\.wav$/);
    assert.equal(processed.length, 1);
    assert.equal(processed[0].type, 'voice');
    assert.equal(processed[0].voiceText, '你好呀');
    assert.equal(processed[0].duration, 2);

    // ASR 抛错：静默降级，不抛给调用方
    const failing = createVoiceTranscriber({
      asr: { transcribe: async () => { throw new Error('boom'); } },
      getSettings: () => ({ asr: { enabled: true } }),
      logger: QUIET,
    });
    assert.deepEqual(await failing({ message: {}, files: [{ localPath: file }] }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
