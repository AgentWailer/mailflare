-- DISTINCT conversation keys must not favor an ordered index that reads large bodies.
CREATE INDEX IF NOT EXISTS messages_conversation_cover_idx ON messages(
 mailbox_id, coalesce(thread_id,id), created_at DESC, id DESC,
 category, status, folder_id, direction, snoozed_until, read, thread_id
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_category_page_cover_idx ON messages(
 mailbox_id, category, status, direction, created_at DESC, id DESC,
 snoozed_until, folder_id, thread_id, read
);
--> statement-breakpoint
-- Replaced by the complete metadata index with the same mailbox/key lookup prefix.
DROP INDEX IF EXISTS messages_mailbox_thread_key_idx;
--> statement-breakpoint
DROP INDEX IF EXISTS messages_thread_key_idx;
