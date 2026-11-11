/**
 * core/tts/edge-token —— 微软 Edge 语音 Sec-MS-GEC v2 派生 token。
 *
 * 重要：v1 算法（sha256(ticks + TrustedClientToken) 直接拼接）已被服务端 403 拒绝，
 * 现行 token 结构为 `<cs64（16 hex）>-<sha256（64 hex）>`，配合
 * Sec-MS-GEC-Version=2-143.0.3650.96 与 ConnectionId 查询参数使用。
 *
 * 算法移植自 MIT 许可的 msedge-tts（https://github.com/Migushthe2nd/MsEdgeTTS，
 * dist/SecMsGec.js）；思路见 https://github.com/rany2/edge-tts/pull/492。
 * 原始实现 Copyright (c) Miguel Pereira，完整许可见
 * https://github.com/Migushthe2nd/MsEdgeTTS/blob/main/LICENSE 。本文件仅保留纯算法，
 * 零外部依赖（只用 node:crypto）。
 *
 * ticks = nowMs * 10000（Windows FILETIME，100ns 单位，自 1601 年）向下取整到 5 分钟；
 * message = "Copyright (C) Microsoft Corporation. All rights reserved." + ticks + TrustedClientToken；
 * sha256(message) 同时用于 cs64 与 token 后半段。
 */
import crypto from 'node:crypto';

/** Edge TTS wss 基址（QQBOT_EDGE_TTS_URL 可覆盖，用于测试/自建代理）。 */
export const EDGE_WSS_BASE = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
/** Sec-MS-GEC-Version（Edge 内核版本形态）。 */
export const EDGE_TOKEN_VERSION = '2-143.0.3650.96';
/** Edge 浏览器扩展公开的 TrustedClientToken（非用户密钥）。 */
export const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
/** token 计算时拼在 message 前缀的微软版权声明（算法的一部分，不要删）。 */
export const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.';

/** FILETIME 纪元差（1601-01-01 → 1970-01-01，以 100ns 为单位）。 */
const FILETIME_EPOCH_TICKS = 116444736000000000n;
/** 5 分钟对应的 100ns ticks。 */
const GEC_WINDOW_TICKS = 3000000000n;

/** cs64 用到的置换常量（逐位移植，勿改）。 */
const SWAP_FIRST = { swappedWord: 0xEF0569FB, swappedSum: 0x76F50F34, swappedProduct: 0xC3EFEA97 };
const SWAP_SECOND = { swappedWord: 0xC31713DB, swappedSum: 0x1881CE3C, swappedProduct: 0x35BD1EC9 };
const MIX_FIRST = [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83];
const MIX_SECOND = [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69];

/** 16 位对调（模拟 32 位无符号）。 */
function swapHalves(value) {
  return (((value << 16) | (value >>> 16)) >>> 0);
}

/** 单轮 swap 置换。 */
function swapTerm(word, key, matrix) {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), matrix.swappedWord);
  const product = Math.imul(swapHalves(sum), matrix.swappedSum) >>> 0;
  return (Math.imul(swapHalves(product), matrix.swappedProduct) + product) >>> 0;
}

/** 连续 swap + 乘法混淆。 */
function swapAndMultiply(value, multipliers) {
  let out = value >>> 0;
  for (const multiplier of multipliers) out = Math.imul(swapHalves(out), multiplier) >>> 0;
  return out;
}

/**
 * 按 msedge-tts 的算法把 message 压缩成 8 字节 cs64（大写 hex）。
 * @param {Buffer} message
 * @returns {string} 16 位大写十六进制
 */
export function cs64FromMessage(message) {
  const digest = crypto.createHash('sha256').update(message).digest();
  const firstKey = (digest.readUInt32LE(0) | 1) >>> 0;
  const secondKey = (digest.readUInt32LE(4) | 1) >>> 0;
  const blocks = Math.ceil(message.length / 8);
  let swapSum = 0;
  let mixSum = 0;
  let mix = 0;
  let lastSwap = 0;
  for (let index = 0; index < blocks; index += 1) {
    // message 按 8 字节补零分块，每块两个小端 u32
    const chunk = Buffer.alloc(8);
    message.copy(chunk, 0, index * 8, Math.min(message.length, (index + 1) * 8));
    const word1 = chunk.readUInt32LE(0);
    const word2 = chunk.readUInt32LE(4);
    const first = swapTerm(word1, firstKey, SWAP_FIRST);
    lastSwap = swapTerm(word2, secondKey, SWAP_SECOND);
    swapSum = (swapSum + first + lastSwap) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + word1, firstKey), MIX_FIRST);
    mixSum = (mixSum + mix) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + word2, secondKey), MIX_SECOND);
    mixSum = (mixSum + mix) >>> 0;
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE((lastSwap ^ mix) >>> 0, 0);
  out.writeUInt32LE((swapSum ^ mixSum) >>> 0, 4);
  return out.toString('hex').toUpperCase();
}

/**
 * 当前 5 分钟桶的 FILETIME ticks（100ns，字符串）。
 * @param {number} nowMs 毫秒时间戳
 * @returns {bigint}
 */
export function edgeTicks(nowMs = Date.now()) {
  const ms = BigInt(Math.trunc(Number(nowMs) || 0));
  let ticks = ms * 10000n + FILETIME_EPOCH_TICKS;
  ticks -= ticks % GEC_WINDOW_TICKS;
  return ticks;
}

/**
 * 派生 Sec-MS-GEC v2 token。
 * @param {{now?: number|(()=>number)}} [options] now 可以是毫秒时间戳或返回时间戳的函数（测试注入）
 * @returns {string} `<16 hex>-<64 hex>` 全大写
 */
export function secMsGec(options = {}) {
  const source = options && typeof options === 'object' ? options.now : undefined;
  const nowMs = typeof source === 'function' ? source() : (source === undefined ? Date.now() : source);
  const ticks = edgeTicks(nowMs);
  const message = Buffer.from(EDGE_COPYRIGHT + String(ticks) + EDGE_TRUSTED_CLIENT_TOKEN, 'utf8');
  const digest = crypto.createHash('sha256').update(message).digest('hex').toUpperCase();
  return cs64FromMessage(message) + '-' + digest;
}

export default { EDGE_WSS_BASE, EDGE_TOKEN_VERSION, EDGE_TRUSTED_CLIENT_TOKEN, EDGE_COPYRIGHT, cs64FromMessage, edgeTicks, secMsGec };
