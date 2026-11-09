/**
 * core/db —— node:sqlite 封装（Node >= 22.5 内置，零原生依赖）。
 *
 * 约定：
 * - 每个进程一个 DatabaseSync 实例；WAL + synchronous=FULL（断电安全优先）；
 * - 迁移由 PRAGMA user_version 驱动，只前进不回退；
 * - 所有写操作用 withTx 包起来，抛错自动回滚；
 * - 时间统一用毫秒整数（Date.now()）。
 */
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.js';

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = FULL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA temp_store = MEMORY',
];

/** 打开（或创建）数据库并跑迁移。 */
export function openDb(file, { readOnly = false } = {}) {
  const db = new DatabaseSync(file, { readOnly });
  for (const pragma of PRAGMAS) {
    try { db.exec(pragma); } catch { /* readOnly 下部分 pragma 会被拒，忽略 */ }
  }
  if (!readOnly) migrate(db);
  return db;
}

/** 当前 schema 版本。 */
export function schemaVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row && row.user_version ? row.user_version : 0);
}

/** 顺序执行未应用的迁移。 */
export function migrate(db) {
  const current = schemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec('PRAGMA user_version = ' + Number(migration.version));
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw new Error('数据库迁移失败 v' + migration.version + ': ' + err.message);
    }
  }
  return schemaVersion(db);
}

/** 事务包装：同步函数；抛错回滚并重新抛出。 */
export function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(db);
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/** 便捷写操作。 */
export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

/** 便捷单行查询。 */
export function get(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

/** 便捷多行查询。 */
export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

/** 读取 meta 里的 JSON 值。 */
export function metaGet(db, key, fallback = null) {
  const row = get(db, 'SELECT value FROM meta WHERE key = ?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

/** 写入 meta 的 JSON 值。 */
export function metaSet(db, key, value) {
  run(db, 'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

/** 关闭数据库（测试/停服）。 */
export function closeDb(db) {
  try { db.close(); } catch { /* ignore */ }
}
