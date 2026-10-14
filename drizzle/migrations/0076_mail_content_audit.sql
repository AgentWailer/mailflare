CREATE TABLE IF NOT EXISTS mail_content_audit_jobs (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'pending',
 phase TEXT NOT NULL DEFAULT 'rules',
 snapshot INTEGER NOT NULL,
 after_row INTEGER NOT NULL DEFAULT 0,
 total INTEGER NOT NULL DEFAULT 0,
 processed INTEGER NOT NULL DEFAULT 0,
 ai_processed INTEGER NOT NULL DEFAULT 0,
 changed INTEGER NOT NULL DEFAULT 0,
 review_count INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 retry_at INTEGER NOT NULL DEFAULT 0,
 consecutive_failures INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_content_audit_active_idx ON mail_content_audit_jobs(mailbox_id)
 WHERE status IN ('pending','running','waiting','paused');
CREATE INDEX IF NOT EXISTS mail_content_audit_recovery_idx ON mail_content_audit_jobs(status,retry_at,lease_until);
CREATE TABLE IF NOT EXISTS mail_content_audit_issues (
 id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL REFERENCES mail_content_audit_jobs(id) ON DELETE CASCADE,
 message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
 category TEXT NOT NULL,
 suggested_category TEXT,
 expected_decision TEXT,
 reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 created_at INTEGER NOT NULL,
 reviewed_at INTEGER,
 UNIQUE(job_id,message_id)
);
CREATE INDEX IF NOT EXISTS mail_content_audit_review_idx ON mail_content_audit_issues(job_id,status,created_at);
ALTER TABLE mail_sorting_feedback ADD COLUMN excerpt TEXT NOT NULL DEFAULT '';
ALTER TABLE mail_sorting_feedback ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
