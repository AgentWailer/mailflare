-- Keep confirmed examples when the original email is deleted; mailbox deletion removes them.
CREATE TABLE mail_sorting_feedback (
 id TEXT PRIMARY KEY,
 mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 sender TEXT NOT NULL,
 subject TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL CHECK (category IN ('primary','promotions','social')),
 corrected_at TEXT NOT NULL
);
CREATE UNIQUE INDEX mail_sorting_feedback_message_idx ON mail_sorting_feedback(mailbox_id,message_id);
CREATE INDEX mail_sorting_feedback_mailbox_idx ON mail_sorting_feedback(mailbox_id,corrected_at DESC);
