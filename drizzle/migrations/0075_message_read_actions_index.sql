-- The implicit rowid after these two keys supports sparse read/unread batches
-- without revisiting already-correct messages or sorting the whole mailbox.
CREATE INDEX IF NOT EXISTS messages_mailbox_read_actions_idx ON messages(mailbox_id, read);
