/**
 * 版本号单一来源：读取本包 package.json 的 version。
 * 读取失败（如打包裁剪）时回退常量，保证 /api/state 等不因版本读取失败而崩。
 */
import { readFileSync } from 'node:fs';

const FALLBACK_VERSION = '0.2.0';

/** 每次调用重新读取 package.json，避免 HMR 复用旧模块时版本号停在旧值。 */
export function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim() !== '') return pkg.version.trim();
  } catch {
    /* 读取失败用 fallback */
  }
  return FALLBACK_VERSION;
}

/** 导入时快照（仅兼容旧引用；运行时请用 readVersion()）。 */
export const VERSION = readVersion();
export default VERSION;