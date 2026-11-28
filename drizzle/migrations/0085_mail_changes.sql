CREATE TABLE `mail_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mailbox_id` text NOT NULL,
	`message_id` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('changed', 'removed')),
	`changed_at` integer NOT NULL
);

CREATE INDEX `mail_changes_mailbox_seq_idx` ON `mail_changes` (`mailbox_id`, `seq`);

CREATE INDEX `mail_changes_changed_at_idx` ON `mail_changes` (`changed_at`);

CREATE TRIGGER `mail_changes_messages_ai` AFTER INSERT ON `messages`
WHEN NEW.mailbox_id IS NOT NULL BEGIN
	INSERT INTO mail_changes (mailbox_id, message_id, kind, changed_at) VALUES (NEW.mailbox_id, NEW.id, 'changed', unixepoch());
END;

CREATE TRIGGER `mail_changes_messages_au` AFTER UPDATE OF mailbox_id, folder_id, category, status, read, starred, snoozed_until, subject, snippet, thread_id, from_addr, to_addr, text_body, html_body ON `messages`
BEGIN
	INSERT INTO mail_changes (mailbox_id, message_id, kind, changed_at)
	SELECT OLD.mailbox_id, OLD.id, 'removed', unixepoch()
	WHERE OLD.mailbox_id IS NOT NULL AND OLD.mailbox_id IS NOT NEW.mailbox_id;
	INSERT INTO mail_changes (mailbox_id, message_id, kind, changed_at)
	SELECT NEW.mailbox_id, NEW.id, 'changed', unixepoch()
	WHERE NEW.mailbox_id IS NOT NULL;
END;

CREATE TRIGGER `mail_changes_messages_ad` AFTER DELETE ON `messages`
WHEN OLD.mailbox_id IS NOT NULL BEGIN
	INSERT INTO mail_changes (mailbox_id, message_id, kind, changed_at) VALUES (OLD.mailbox_id, OLD.id, 'removed', unixepoch());
END;

CREATE TRIGGER `mail_changes_labels_ai` AFTER INSERT ON `message_labels` BEGIN
	INSERT INTO mail_changes (mailbox_id, message_id, kind, changed_at)
	SELECT mailbox_id, id, 'changed', unixepoch() FROM messages WHERE id = NEW.message_id AND mailbox_id IS NOT NULL;
END;

CREATE TRIGGER `mail_changes_labels_ad` AFTER DELETE ON `message_labels` BEGIN
	INSERT INTO mail_changes (mailbox_id, message_id, kind, changed_at)
	SELECT mailbox_id, id, 'changed', unixepoch() FROM messages WHERE id = OLD.message_id AND mailbox_id IS NOT NULL;
END;
