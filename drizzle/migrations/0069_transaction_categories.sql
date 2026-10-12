ALTER TABLE mbox_sorting_jobs ADD COLUMN invoices_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mbox_sorting_jobs ADD COLUMN orders_count INTEGER NOT NULL DEFAULT 0;
DROP INDEX messages_import_sorting_idx;
CREATE INDEX messages_import_sorting_idx ON messages(mailbox_id,id)
 WHERE direction='inbound' AND status IN ('received','archived') AND category='primary'
 AND folder_id IS NULL AND snoozed_until IS NULL;
-- SQLite cannot extend a CHECK constraint in place. This staging table exists
-- only during the migration; all original ids and confirmed examples survive.
CREATE TABLE mail_sorting_feedback_v4 (
 id TEXT PRIMARY KEY,
 mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
 sender TEXT NOT NULL,
 subject TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL CHECK (category IN ('primary','promotions','social','invoices','orders')),
 corrected_at TEXT NOT NULL
);
INSERT INTO mail_sorting_feedback_v4 SELECT * FROM mail_sorting_feedback;
DROP TABLE mail_sorting_feedback;
ALTER TABLE mail_sorting_feedback_v4 RENAME TO mail_sorting_feedback;
CREATE UNIQUE INDEX mail_sorting_feedback_message_idx ON mail_sorting_feedback(mailbox_id,message_id);
CREATE INDEX mail_sorting_feedback_mailbox_idx ON mail_sorting_feedback(mailbox_id,corrected_at DESC);
CREATE INDEX mail_sorting_feedback_sender_idx ON mail_sorting_feedback(mailbox_id,sender,corrected_at DESC);

-- Retain label identities, children and all rules. Folder names are unique per
-- mailbox; when Rechnung already exists retain the legacy label too, without
-- deleting either label's memberships or rules.
UPDATE folders SET name='Rechnung'
 WHERE name IN ('Abrechnungen nach Kategorie','Abrechnungen_nach_Kategorie')
 AND NOT EXISTS(SELECT 1 FROM folders target WHERE target.mailbox_id=folders.mailbox_id AND target.name='Rechnung');

-- Only explicit financial filing is a trusted historical hint. Do not override
-- marketing/social categories, spam/trash, outbound mail or manual decisions.
UPDATE messages SET category='invoices',sorting_decision='{"category":"invoices","source":"rule","reason":"imported_invoice_label","policyVersion":4}'
 WHERE direction='inbound' AND status IN ('received','archived') AND category='primary'
 AND (sorting_decision IS NULL OR CASE WHEN json_valid(sorting_decision) THEN json_extract(sorting_decision,'$.source') IN ('clef','rule','fallback') ELSE 0 END)
 AND EXISTS(SELECT 1 FROM folders f WHERE f.mailbox_id=messages.mailbox_id
   AND f.name IN ('Rechnung','Abrechnungen nach Kategorie','Abrechnungen_nach_Kategorie')
   AND (messages.folder_id=f.id OR EXISTS(SELECT 1 FROM message_labels l WHERE l.message_id=messages.id AND l.folder_id=f.id)));
