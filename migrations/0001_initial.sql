CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES entries(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
  bucket_id TEXT,
  object_key TEXT,
  version_id TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  cleanup_after INTEGER NOT NULL DEFAULT 0,
  CHECK ((kind = 'folder' AND bucket_id IS NULL AND object_key IS NULL AND version_id IS NULL)
      OR (kind = 'file' AND bucket_id IS NOT NULL AND object_key IS NOT NULL AND version_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS entries_name ON entries(parent_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS entries_list ON entries(parent_id, deleted_at, kind, name, id);
CREATE INDEX IF NOT EXISTS entries_bucket ON entries(bucket_id);
CREATE INDEX IF NOT EXISTS entries_pending_deletion ON entries(deleted_at) WHERE deleted_at IS NOT NULL;
INSERT INTO entries (id, name, kind, created_at, updated_at) VALUES ('root', '我的文件', 'folder', 0, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  bucket_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  multipart INTEGER NOT NULL,
  multipart_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'done', 'cancelled', 'cleaned')),
  expires_at INTEGER NOT NULL,
  lock_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  write_started INTEGER NOT NULL DEFAULT 1 CHECK (write_started IN (0, 1))
);

CREATE INDEX IF NOT EXISTS uploads_bucket ON uploads(bucket_id, state);
CREATE INDEX IF NOT EXISTS uploads_expiry ON uploads(state, expires_at);
CREATE INDEX IF NOT EXISTS uploads_parent ON uploads(parent_id, state);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  password_salt TEXT,
  password_hash TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS share_attempts (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  requester TEXT NOT NULL,
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (share_id, requester, window)
);

CREATE INDEX IF NOT EXISTS share_attempts_expiry ON share_attempts(window);

CREATE TABLE IF NOT EXISTS demo_parts (
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE IF NOT EXISTS bucket_health (
  bucket_id TEXT PRIMARY KEY,
  retry_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  digest TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  requester TEXT NOT NULL,
  window INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (requester, window)
);

CREATE INDEX IF NOT EXISTS admin_login_attempts_expiry ON admin_login_attempts(window);

CREATE TABLE IF NOT EXISTS bucket_settings (
  bucket_id TEXT PRIMARY KEY,
  name TEXT COLLATE NOCASE UNIQUE,
  region TEXT,
  quota INTEGER,
  priority INTEGER,
  credentials TEXT,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  removed INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1))
);
