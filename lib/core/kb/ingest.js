/**
 * core/kb/ingest —— 知识源文件入库辅助（有文件 IO，检索/分块逻辑在 store.js、chunk.js）。
 *
 * 职责：把本地文本/Markdown 文件读入并交给 createKbStore().ingest()；
 * source 缺省取文件名（同一文件重复 ingest 幂等），title 缺省取去掉扩展名的文件名。
 * 文件大小有上限，避免误把大二进制/日志塞进库。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 单个知识源文件默认上限：2 MiB。 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 从文件入库。
 * @param {ReturnType<import('./store.js').createKbStore>} store
 * @param {{ botId: string, filePath: string, source?: string, title?: string,
 *           meta?: object, maxChars?: number, overlap?: number, maxBytes?: number }} input
 * @returns {{ docId: number, chunks: number, changed: boolean }}
 */
export function ingestFile(store, input = {}) {
  if (!store || typeof store.ingest !== 'function') {
    throw new TypeError('ingestFile: 需要 createKbStore() 返回的 store');
  }
  const botId = String(input.botId ?? '').trim();
  if (!botId) throw new TypeError('ingestFile: botId 不能为空');
  const filePath = path.resolve(String(input.filePath ?? '')).toString();
  if (!input.filePath) throw new TypeError('ingestFile: filePath 不能为空');

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new TypeError('ingestFile: 不是普通文件 ' + filePath);
  const maxBytes = input.maxBytes === undefined ? DEFAULT_MAX_BYTES : Number(input.maxBytes);
  if (stat.size > maxBytes) {
    throw new RangeError('ingestFile: 文件超过 ' + maxBytes + ' 字节上限: ' + filePath);
  }

  const baseName = path.basename(filePath);
  const text = fs.readFileSync(filePath, 'utf8');
  const source = input.source === undefined || input.source === null || String(input.source).trim() === ''
    ? baseName
    : String(input.source).trim();
  const title = input.title === undefined || input.title === null || String(input.title).trim() === ''
    ? path.basename(filePath, path.extname(filePath))
    : String(input.title).trim();
  const meta = input.meta !== undefined && input.meta !== null
    ? input.meta
    : { filePath, bytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) };

  return store.ingest({ botId, source, title, text, meta, maxChars: input.maxChars, overlap: input.overlap });
}
