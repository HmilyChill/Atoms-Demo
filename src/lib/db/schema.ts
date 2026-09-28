/**
 * 数据库 DDL（见 docs/03-项目流程Spec.md §4 核心数据模型）。
 * 使用 node:sqlite（Node 内置，零原生依赖），所有实体带 created_at/updated_at。
 */

export const SCHEMA_VERSION = 1

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  schema_version      INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION},
  current_spec_version INTEGER,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '未命名会话',
  status     TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  run_id     TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at ASC);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  status         TEXT NOT NULL,
  stage          TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'create',
  require_confirm INTEGER NOT NULL DEFAULT 1,
  user_input     TEXT NOT NULL DEFAULT '',
  error_code     TEXT,
  error_message  TEXT,
  token_usage    INTEGER NOT NULL DEFAULT 0,
  call_count     INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  project_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_artifacts_project_type ON artifacts(project_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS spec_versions (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  version        INTEGER NOT NULL,
  spec           TEXT NOT NULL,
  parent_version INTEGER,
  change_summary TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_spec_versions_project ON spec_versions(project_id, version DESC);

CREATE TABLE IF NOT EXISTS app_records (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_app_records ON app_records(project_id, collection, created_at DESC);

CREATE TABLE IF NOT EXISTS event_logs (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  event_id   INTEGER NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  UNIQUE (run_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_event_logs_run ON event_logs(run_id, event_id ASC);
`
