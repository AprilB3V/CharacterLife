/**
 * SQLite schema 与迁移。
 *
 * 用 Node 内置 `node:sqlite`（本机实测 SQLite 3.53.4），不引入任何第三方驱动，
 * 保持「clone 下来就能跑」。
 *
 * 设计要点：
 * - 所有业务表都带 `instance_id`，实例之间物理隔离（每次查询都强制带该条件）；
 * - 记忆是**结构化行**，不是把 JSON blob 塞进一列，这样才能做检索、冲突检测、删除审计；
 * - `events` 是 append-only 追加日志，`seq` 自增，状态变更以「补丁事件」形式可重放；
 * - `snapshots` 保存状态快照 + 对应的最后事件序号，恢复时只需重放其后的补丁。
 */

export const SCHEMA_VERSION = 2

/**
 * V0.2 新增：平台接入层需要的表。
 *
 * - `platform_identities`：一个平台身份 → 一个角色实例（同一实例可被多个平台身份绑定）；
 * - `platform_sessions`：每个平台身份「当前会话」，新会话不重建角色；
 * - `binding_codes`：一次性绑定码（只存哈希，带过期与尝试次数）；
 * - `processed_messages`：入站消息去重表（幂等处理的基础）。
 */
export const PLATFORM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS platform_identities (
  platform        TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  instance_id     TEXT NOT NULL REFERENCES instances(id),
  display_name    TEXT,
  binding_source  TEXT NOT NULL CHECK (binding_source IN ('primary','code','admin')),
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  PRIMARY KEY (platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS idx_platform_identities_instance ON platform_identities(instance_id);

CREATE TABLE IF NOT EXISTS platform_sessions (
  platform         TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  instance_id      TEXT NOT NULL REFERENCES instances(id),
  session_id       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (platform, platform_user_id)
);

CREATE TABLE IF NOT EXISTS binding_codes (
  code_hash    TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES instances(id),
  target_platform TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  consumed_at  TEXT,
  created_by   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_binding_codes_instance ON binding_codes(instance_id, expires_at);

CREATE TABLE IF NOT EXISTS identity_settings (
  platform         TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  quiet            INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (platform, platform_user_id)
);

CREATE TABLE IF NOT EXISTS processed_messages (
  platform            TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  instance_id         TEXT,
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (platform, platform_message_id)
);
CREATE INDEX IF NOT EXISTS idx_processed_created ON processed_messages(created_at);
`

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id            TEXT    NOT NULL,
  version       INTEGER NOT NULL,
  content_hash  TEXT    NOT NULL,
  profile_json  TEXT    NOT NULL,
  voice_json    TEXT    NOT NULL,
  timeline_json TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS instances (
  id               TEXT PRIMARY KEY,
  template_id      TEXT    NOT NULL,
  template_version INTEGER NOT NULL,
  template_hash    TEXT    NOT NULL,
  player_id        TEXT    NOT NULL,
  world_id         TEXT    NOT NULL,
  label            TEXT    NOT NULL,
  created_at       TEXT    NOT NULL,
  last_active_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instances_player ON instances(player_id, world_id);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  turn_count  INTEGER NOT NULL DEFAULT 0,
  end_reason  TEXT,
  summary     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_instance ON sessions(instance_id, started_at);

CREATE TABLE IF NOT EXISTS instance_state (
  instance_id        TEXT PRIMARY KEY REFERENCES instances(id),
  schema_version     INTEGER NOT NULL,
  relationship_json  TEXT NOT NULL,
  dynamic_json       TEXT NOT NULL,
  timeline_json      TEXT NOT NULL,
  runtime_json       TEXT NOT NULL,
  last_event_seq     INTEGER NOT NULL DEFAULT 0,
  saved_at_sim       INTEGER NOT NULL,
  saved_at_wall      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id             TEXT NOT NULL,
  instance_id    TEXT NOT NULL REFERENCES instances(id),
  kind           TEXT NOT NULL CHECK (kind IN ('episodic','user')),
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('fact','speculation','fiction')),
  origin         TEXT NOT NULL,
  trust          TEXT NOT NULL CHECK (trust IN ('trusted','untrusted')),
  confirmed      INTEGER NOT NULL DEFAULT 0,
  salience       REAL NOT NULL DEFAULT 0.5,
  tags_json      TEXT NOT NULL DEFAULT '[]',
  created_sim    INTEGER NOT NULL,
  created_wall   TEXT    NOT NULL,
  source_ref     TEXT,
  deleted_at_sim INTEGER,
  PRIMARY KEY (instance_id, id)
);
CREATE INDEX IF NOT EXISTS idx_memories_instance ON memories(instance_id, deleted_at_sim);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(instance_id, kind);

CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  session_id  TEXT,
  type        TEXT NOT NULL,
  at_sim      INTEGER NOT NULL,
  at_wall     TEXT NOT NULL,
  actor       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  data_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_instance ON events(instance_id, seq);

CREATE TABLE IF NOT EXISTS snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id    TEXT NOT NULL REFERENCES instances(id),
  schema_version INTEGER NOT NULL,
  saved_at_sim   INTEGER NOT NULL,
  saved_at_wall  TEXT NOT NULL,
  last_event_seq INTEGER NOT NULL,
  payload_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_instance ON snapshots(instance_id, id);

CREATE TABLE IF NOT EXISTS memory_conflicts (
  id              TEXT PRIMARY KEY,
  instance_id     TEXT NOT NULL REFERENCES instances(id),
  kind            TEXT NOT NULL,
  older_id        TEXT NOT NULL,
  newer_id        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  detail          TEXT NOT NULL,
  detected_at_sim INTEGER NOT NULL,
  resolution      TEXT NOT NULL DEFAULT 'unresolved',
  resolved_at_sim INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conflicts_instance ON memory_conflicts(instance_id, resolution);

CREATE TABLE IF NOT EXISTS context_requests (
  id                    TEXT PRIMARY KEY,
  instance_id           TEXT NOT NULL REFERENCES instances(id),
  session_id            TEXT,
  turn_id               TEXT NOT NULL,
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  budget                INTEGER NOT NULL,
  est_prompt_tokens     INTEGER NOT NULL,
  actual_prompt_tokens  INTEGER,
  actual_completion_tokens INTEGER,
  degradation           TEXT NOT NULL,
  dropped_history_turns INTEGER NOT NULL DEFAULT 0,
  dropped_memory_ids    TEXT NOT NULL DEFAULT '[]',
  digested_turns        INTEGER NOT NULL DEFAULT 0,
  created_at_sim        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_instance ON context_requests(instance_id, created_at_sim);
`

export function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
