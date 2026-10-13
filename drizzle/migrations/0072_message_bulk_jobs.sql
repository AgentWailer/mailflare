CREATE TABLE message_bulk_jobs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, payload TEXT NOT NULL, scope TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','waiting','failed','completed','paused')),
 processed INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
 after_row INTEGER NOT NULL DEFAULT 0, pending_chunk TEXT,
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
 error TEXT, dismissed INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(user_id,request_id)
);
CREATE UNIQUE INDEX message_bulk_jobs_active_user ON message_bulk_jobs(user_id) WHERE status IN ('pending','running','waiting');
CREATE INDEX message_bulk_jobs_recovery ON message_bulk_jobs(status,retry_at,lease_until);
