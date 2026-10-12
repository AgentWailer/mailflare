CREATE TABLE mbox_sorting_jobs (
 import_job_id TEXT PRIMARY KEY NOT NULL REFERENCES mbox_import_jobs(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'pending',
 processed INTEGER NOT NULL DEFAULT 0,
 primary_count INTEGER NOT NULL DEFAULT 0,
 promotions_count INTEGER NOT NULL DEFAULT 0,
 social_count INTEGER NOT NULL DEFAULT 0,
 error TEXT,
 wait_reason TEXT,
 retry_at INTEGER NOT NULL DEFAULT 0,
 consecutive_failures INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX mbox_sorting_jobs_recovery_idx ON mbox_sorting_jobs(status,retry_at,lease_until);
-- Completed decisions leave this small index; already categorized mail is never scanned for AI.
CREATE INDEX messages_import_sorting_idx ON messages(mailbox_id,id)
 WHERE direction='inbound' AND status='received' AND category='primary'
 AND folder_id IS NULL AND sorting_decision IS NULL AND snoozed_until IS NULL;
