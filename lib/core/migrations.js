/**
 * core/migrations —— schema 版本化迁移（只增不改）。
 *
 * v1: 基础表（bots/profiles/bindings/sessions/settings）+ 记忆 + 知识库(FTS5 trigram)
 *     + 群友/人设/表情包 + 审计/控制台会话。
 *
 * FTS5 说明：中文用 trigram 分词器（子串匹配、无需分词器），英文同样可用。
 * 硬限制：trigram 索引的最小匹配长度是 3 个字符，1-2 字的中文查询无法命中，
 * 检索层（core/kb/store.js）必须对 < 3 字符的查询回退 LIKE 并标注 searchMode。
 */
export const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 机器人（QQ 应用 + 每个 bot 独立工作目录）
CREATE TABLE IF NOT EXISTS bots (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  app_id     TEXT NOT NULL DEFAULT '',
  app_secret TEXT NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  cwd        TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 配置档：只影响 prompt/模型/回复策略/工具策略；记忆与知识库按 bot 共享
CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 作用域绑定：scope 形如 qq:group:* / qq:group:123 / qq:c2c:* / *；数值大者优先，精确匹配优先于通配
CREATE TABLE IF NOT EXISTS bindings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  priority   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(bot_id, scope)
);

-- peer -> dsh session 映射（含会话级 cwd，重启不丢）
CREATE TABLE IF NOT EXISTS sessions (
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  peer       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd        TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, peer)
);

-- 全局设置（按 bot：bot_id = '' 表示全局）
CREATE TABLE IF NOT EXISTS settings (
  bot_id TEXT NOT NULL DEFAULT '',
  key    TEXT NOT NULL,
  value  TEXT NOT NULL,
  PRIMARY KEY (bot_id, key)
);

-- 长期记忆（按 bot 共享；peer 记录来源会话，便于回溯）
CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  peer       TEXT,
  kind       TEXT NOT NULL DEFAULT 'fact',
  text       TEXT NOT NULL,
  tags       TEXT,
  source     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_bot ON memories(bot_id, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text, content='memories', content_rowid='id', tokenize='trigram'
);

-- 知识库文档 / 分块
CREATE TABLE IF NOT EXISTS kb_docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  title      TEXT,
  hash       TEXT NOT NULL,
  meta       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(bot_id, source)
);
CREATE INDEX IF NOT EXISTS idx_kb_docs_bot ON kb_docs(bot_id);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
  ord    INTEGER NOT NULL,
  text   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
  text, content='kb_chunks', content_rowid='id', tokenize='trigram'
);

-- 群友库（按 bot 共享）
CREATE TABLE IF NOT EXISTS members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id       TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  openid       TEXT NOT NULL,
  nickname     TEXT,
  note         TEXT,
  profile_json TEXT,
  updated_at   INTEGER NOT NULL,
  UNIQUE(bot_id, openid)
);

-- 人格卡
CREATE TABLE IF NOT EXISTS personas (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 表情包库
CREATE TABLE IF NOT EXISTS stickers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  file       TEXT NOT NULL,
  emotion    TEXT,
  hash       TEXT,
  created_at INTEGER NOT NULL
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  bot_id TEXT,
  kind   TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);

-- 控制台登录会话（token 只存 scrypt 哈希）
CREATE TABLE IF NOT EXISTS console_tokens (
  id         TEXT PRIMARY KEY,
  label      TEXT,
  hash       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used  INTEGER
);
CREATE TABLE IF NOT EXISTS console_sessions (
  sid        TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  user_agent TEXT,
  ip         TEXT
);

-- FTS 同步触发器
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE OF text ON kb_chunks BEGIN
  INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
`,
  },
  {
    version: 2,
    sql: `
-- 后台任务状态（每 N 轮提炼 / 知识抽取的轮次计数，重启不丢）
CREATE TABLE IF NOT EXISTS job_state (
  bot_id     TEXT NOT NULL DEFAULT '',
  peer       TEXT NOT NULL DEFAULT '',
  job        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, peer, job)
);
CREATE INDEX IF NOT EXISTS idx_job_state_job ON job_state(job, updated_at DESC);
`,
  },
  {
    version: 3,
    sql: `
-- 会话轮换（/new）：epoch 自增后 sessionId 随之变化，旧会话留在磁盘可 /resume
ALTER TABLE sessions ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;
`,
  },
];
