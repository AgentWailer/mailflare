-- Keep startup counts and page selection off the large MIME/body table pages.
-- These derived indexes contain only message metadata; backup tables are unchanged.
CREATE INDEX IF NOT EXISTS messages_counts_cover_idx ON messages(
 mailbox_id, folder_id, category, direction, status, read, starred, snoozed_until,
 id, thread_id, created_at
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_page_cover_idx ON messages(
 mailbox_id, status, folder_id, direction, created_at DESC, id DESC,
 category, snoozed_until, thread_id, read
);
