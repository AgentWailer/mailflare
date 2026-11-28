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
		return migrator
	}
}
