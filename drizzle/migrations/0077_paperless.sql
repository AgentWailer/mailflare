CREATE TABLE IF NOT EXISTS paperless_connections (
 mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 base_url TEXT NOT NULL,
 credentials TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0,
 label_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
 processed_label_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paperless_jobs (
 id TEXT PRIMARY KEY,
 mailbox_id TEXT NOT NULL REFERENCES paperless_connections(mailbox_id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 attachment_id TEXT NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
 base_url TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 task_id TEXT,
 document_id INTEGER,
 error TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(mailbox_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS paperless_jobs_recovery_idx ON paperless_jobs(status,retry_at,lease_until);
CREATE INDEX IF NOT EXISTS paperless_jobs_mailbox_idx ON paperless_jobs(mailbox_id,created_at);
CREATE INDEX IF NOT EXISTS paperless_jobs_message_idx ON paperless_jobs(message_id,status);
