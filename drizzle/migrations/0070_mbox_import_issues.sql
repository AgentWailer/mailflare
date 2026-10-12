ALTER TABLE mbox_import_jobs ADD COLUMN scan_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mbox_import_jobs ADD COLUMN scan_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mbox_import_jobs ADD COLUMN scan_starts_line INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mbox_import_jobs ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mbox_import_jobs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
CREATE TABLE mbox_import_issues (
 id TEXT PRIMARY KEY NOT NULL,
 import_job_id TEXT NOT NULL REFERENCES mbox_import_jobs(id) ON DELETE CASCADE,
 byte_offset INTEGER NOT NULL,
 next_offset INTEGER NOT NULL,
 message_size INTEGER NOT NULL,
 reason TEXT NOT NULL,
 error TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dismissed')),
 created_at INTEGER NOT NULL,
 reviewed_at INTEGER,
 UNIQUE(import_job_id,byte_offset)
);
CREATE INDEX mbox_import_issues_review_idx ON mbox_import_issues(import_job_id,status,byte_offset);
