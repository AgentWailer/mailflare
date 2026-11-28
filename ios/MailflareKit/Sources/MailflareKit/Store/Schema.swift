import GRDB

enum Schema {
	static var migrator: DatabaseMigrator {
		var migrator = DatabaseMigrator()
		migrator.registerMigration("v1") { db in
			try db.create(table: "message") { t in
				t.primaryKey("id", .text)
				t.column("userId", .text).notNull()
				t.column("mailboxId", .text)
				t.column("direction", .text).notNull()
				t.column("providerMessageId", .text)
				t.column("folderId", .text)
				t.column("category", .text).notNull()
				t.column("fromAddr", .text).notNull()
				t.column("toAddr", .text).notNull()
				t.column("ccAddr", .text)
				t.column("bccAddr", .text)
				t.column("replyTo", .text)
				t.column("subject", .text)
				t.column("snippet", .text)
				t.column("status", .text).notNull()
				t.column("read", .boolean).notNull()
				t.column("starred", .boolean).notNull()
				t.column("snoozedUntil", .datetime)
				t.column("threadId", .text)
				t.column("inReplyTo", .text)
				t.column("references", .text)
				t.column("spamVerdict", .text)
				t.column("trashedAt", .datetime)
				t.column("createdAt", .datetime).notNull()
				t.column("attachmentCount", .integer).notNull()
				t.column("labels", .text).notNull()
				t.column("fromContactName", .text)
				t.column("toContactName", .text)
			}
			try db.create(index: "message_list_idx", on: "message", columns: ["mailboxId", "status", "createdAt"])
			try db.create(index: "message_created_idx", on: "message", columns: ["createdAt"])
			try db.create(index: "message_thread_idx", on: "message", columns: ["threadId"])

			try db.create(table: "message_label") { t in
				t.column("messageId", .text).notNull().references("message", onDelete: .cascade)
				t.column("folderId", .text).notNull()
				t.primaryKey(["messageId", "folderId"])
			}
			try db.create(index: "message_label_folder_idx", on: "message_label", columns: ["folderId"])

			try db.create(table: "message_body") { t in
				t.primaryKey("messageId", .text).references("message", onDelete: .cascade)
				t.column("textBody", .text)
				t.column("htmlBody", .text)
				t.column("unsubscribeUrl", .text)
			}
			try db.create(table: "attachment") { t in
				t.primaryKey("id", .text)
				t.column("messageId", .text).notNull().references("message", onDelete: .cascade)
				t.column("filename", .text).notNull()
				t.column("type", .text).notNull()
				t.column("size", .integer).notNull()
				t.column("disposition", .text).notNull()
				t.column("contentId", .text)
			}
			try db.create(index: "attachment_message_idx", on: "attachment", columns: ["messageId"])

			// Mailboxes, folders and counts arrive whole and are kept as they came.
			try db.create(table: "document") { t in
				t.primaryKey("key", .text)
				t.column("json", .blob).notNull()
			}
			// The cursor and other bookkeeping of the sync. Cleared by a reset.
			try db.create(table: "sync_state") { t in
				t.primaryKey("key", .text)
				t.column("value", .text).notNull()
			}
			// What the user chose on this device. Survives a reset.
			try db.create(table: "setting") { t in
				t.primaryKey("key", .text)
				t.column("value", .text).notNull()
			}
		}
		migrator.registerMigration("v2") { db in
			// Actions applied on the device that still have to reach the server, oldest first.
			// `snapshot` holds the rows as they were, so a refused action can be put back.
			try db.create(table: "outbox") { t in
				t.autoIncrementedPrimaryKey("id")
				t.column("action", .text).notNull()
				t.column("messageIds", .text).notNull()
				t.column("snapshot", .text).notNull()
				t.column("attempts", .integer).notNull().defaults(to: 0)
				t.column("createdAt", .datetime).notNull()
			}
		}
		migrator.registerMigration("v3") { db in
			// Messages the user wrote on this device: being written, waiting to be sent, or refused.
			// Not synced mail, so a reset of the synced mail leaves it alone.
			try db.create(table: "outgoing") { t in
				t.primaryKey("id", .text)
				t.column("json", .text).notNull()
				t.column("state", .text).notNull()
				t.column("createdAt", .datetime).notNull()
			}
		}
		migrator.registerMigration("v4") { db in
			// The search index: one row per message, under the message's rowid. Triggers keep the
			// head in step; the content is written where a body is stored, because mail that has
			// only HTML needs its text taken out first.
			try db.execute(sql: """
				CREATE VIRTUAL TABLE message_search USING fts5(subject, sender, recipients, snippet, body, tokenize = "unicode61 remove_diacritics 2");
				CREATE TRIGGER message_search_ai AFTER INSERT ON message BEGIN
					INSERT INTO message_search(rowid, subject, sender, recipients, snippet, body)
					VALUES (new.rowid, coalesce(new.subject, ''), new.fromAddr || ' ' || coalesce(new.fromContactName, ''),
						new.toAddr || ' ' || coalesce(new.ccAddr, '') || ' ' || coalesce(new.toContactName, ''), coalesce(new.snippet, ''), '');
				END;
				CREATE TRIGGER message_search_au AFTER UPDATE OF subject, fromAddr, fromContactName, toAddr, ccAddr, toContactName, snippet ON message
				WHEN old.subject IS NOT new.subject OR old.fromAddr IS NOT new.fromAddr OR old.fromContactName IS NOT new.fromContactName
					OR old.toAddr IS NOT new.toAddr OR old.ccAddr IS NOT new.ccAddr OR old.toContactName IS NOT new.toContactName OR old.snippet IS NOT new.snippet
				BEGIN
					UPDATE message_search SET subject = coalesce(new.subject, ''), sender = new.fromAddr || ' ' || coalesce(new.fromContactName, ''),
						recipients = new.toAddr || ' ' || coalesce(new.ccAddr, '') || ' ' || coalesce(new.toContactName, ''), snippet = coalesce(new.snippet, '')
					WHERE rowid = new.rowid;
				END;
				CREATE TRIGGER message_search_ad AFTER DELETE ON message BEGIN
					DELETE FROM message_search WHERE rowid = old.rowid;
				END;
				INSERT INTO message_search(rowid, subject, sender, recipients, snippet, body)
				SELECT rowid, coalesce(subject, ''), fromAddr || ' ' || coalesce(fromContactName, ''),
					toAddr || ' ' || coalesce(ccAddr, '') || ' ' || coalesce(toContactName, ''), coalesce(snippet, ''), '' FROM message;
				""")
			let bodies = try Row.fetchCursor(db, sql: "SELECT m.rowid AS position, b.textBody, b.htmlBody FROM message_body b JOIN message m ON m.id = b.messageId")
			var texts: [(Int64, String)] = []
			while let row = try bodies.next() {
				texts.append((row["position"], SearchText.body(text: row["textBody"], html: row["htmlBody"])))
			}
			for (position, text) in texts where !text.isEmpty {
				try db.execute(sql: "UPDATE message_search SET body = ? WHERE rowid = ?", arguments: [text, position])
			}
		}
		return migrator
	}
}
