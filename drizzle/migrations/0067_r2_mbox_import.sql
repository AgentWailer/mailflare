CREATE TABLE mbox_import_jobs (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 object_key TEXT NOT NULL,
 object_etag TEXT NOT NULL,
 object_size INTEGER NOT NULL,
 byte_offset INTEGER NOT NULL DEFAULT 0,
 processed INTEGER NOT NULL DEFAULT 0,
 imported INTEGER NOT NULL DEFAULT 0,
 skipped INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending',
 error TEXT,
 blocked_next_offset INTEGER,
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX mbox_import_jobs_active_idx ON mbox_import_jobs(mailbox_id,object_key) WHERE status <> 'completed';
CREATE INDEX mbox_import_jobs_recovery_idx ON mbox_import_jobs(status,lease_until);
