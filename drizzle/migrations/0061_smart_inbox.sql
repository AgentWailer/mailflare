ALTER TABLE messages ADD COLUMN category TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE messages ADD COLUMN sorting_decision TEXT;
CREATE INDEX messages_category_idx ON messages(mailbox_id, category, status, created_at DESC);
CREATE TABLE message_labels (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE);
CREATE UNIQUE INDEX message_labels_unique ON message_labels(message_id,folder_id);
CREATE INDEX message_labels_folder_idx ON message_labels(folder_id);
INSERT OR IGNORE INTO message_labels(message_id,folder_id) SELECT id,folder_id FROM messages WHERE folder_id IS NOT NULL;
CREATE TABLE mailbox_sorting_settings (mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE, mode TEXT NOT NULL DEFAULT 'active', daily_limit INTEGER NOT NULL DEFAULT 1000, threshold REAL NOT NULL DEFAULT 0.90);
CREATE TABLE mail_sorting_overrides (mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,sender TEXT NOT NULL,category TEXT NOT NULL);
CREATE UNIQUE INDEX mail_sorting_overrides_unique ON mail_sorting_overrides(mailbox_id,sender);
CREATE TABLE mail_sorting_usage (mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,day TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX mail_sorting_usage_unique ON mail_sorting_usage(mailbox_id,day);
ALTER TABLE routing_rules ADD COLUMN conditions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE routing_rules ADD COLUMN condition_mode TEXT NOT NULL DEFAULT 'all';
ALTER TABLE routing_rules ADD COLUMN label_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE routing_rules ADD COLUMN category TEXT;
ALTER TABLE routing_rules ADD COLUMN skip_inbox INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER messages_label_insert AFTER INSERT ON messages WHEN NEW.folder_id IS NOT NULL BEGIN
 INSERT OR IGNORE INTO message_labels(message_id,folder_id) VALUES(NEW.id,NEW.folder_id);
END;
CREATE TRIGGER messages_label_move AFTER UPDATE OF folder_id ON messages WHEN NEW.folder_id IS NOT NULL AND NEW.folder_id IS NOT OLD.folder_id BEGIN
 INSERT OR IGNORE INTO message_labels(message_id,folder_id) VALUES(NEW.id,NEW.folder_id);
END;
