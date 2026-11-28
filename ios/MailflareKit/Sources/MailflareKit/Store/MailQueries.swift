import Foundation
import GRDB

/// The folder rules of the server's list, so a list on the device shows what the web shows.
/// Ported from `src/lib/messages/list-filter.ts` and `folder-params.ts`.
enum MailQueries {
	/// Categories that are views of the inbox rather than moves out of it.
	static let inboxCategories = ["primary", "invoices", "orders", "social"]

	static func filter(_ scope: ListScope, now: Date) -> (sql: String, arguments: StatementArguments) {
		var clauses = ["m.status <> 'template'"]
		var arguments = StatementArguments()
		func add(_ clause: String, _ values: [(any DatabaseValueConvertible)?] = []) {
			clauses.append(clause)
			arguments += StatementArguments(values)
		}
		let awake = "(m.snoozedUntil IS NULL OR m.snoozedUntil <= ?)"

		if let mailboxId = scope.mailboxId { add("m.mailboxId = ?", [mailboxId]) }
		if let folderId = scope.folderId {
			add("(m.folderId = ? OR EXISTS (SELECT 1 FROM message_label l WHERE l.messageId = m.id AND l.folderId = ?))", [folderId, folderId])
		}

		switch scope.folder {
		case .inbox, .promotions, .social, .invoices, .orders:
			add("m.direction = 'inbound'")
			if scope.folderId != nil {
				// A label lists its mail whether or not it was archived out of the inbox.
				add("m.status IN ('received', 'archived')")
			} else {
				add("m.status = 'received'")
				if scope.folder == .inbox {
					add("m.category IN (\(inboxCategories.map { "'\($0)'" }.joined(separator: ", ")))")
					add("m.folderId IS NULL")
				} else {
					add("m.category = ?", [scope.folder.rawValue])
				}
				add(awake, [now])
			}
		case .all:
			add("m.direction = 'inbound'")
		case .starred:
			add("m.starred = 1")
		case .snoozed:
			add("m.status = 'received' AND m.folderId IS NULL AND m.snoozedUntil > ?", [now])
		case .sent:
			add("m.direction = 'outbound' AND m.status = 'sent'")
		case .scheduled:
			add("m.direction = 'outbound' AND m.status IN ('queued', 'failed')")
		case .drafts:
			add("m.direction = 'outbound' AND m.status = 'draft'")
		case .archived, .spam, .trash:
			add("m.status = ?", [scope.folder.rawValue])
		}
		if scope.unreadOnly { add("m.read = 0") }
		return (clauses.joined(separator: " AND "), arguments)
	}

	static func list(_ db: Database, _ scope: ListScope, limit: Int, now: Date) throws -> [ListItem] {
		let filter = filter(scope, now: now)
		// Drafts are never grouped: each one is a message of its own being written.
		guard scope.conversations, scope.folder != .drafts else {
			let rows = try MessageRow.fetchAll(db, sql: "SELECT m.* FROM message m WHERE \(filter.sql) ORDER BY m.createdAt DESC, m.id DESC LIMIT ?", arguments: filter.arguments + [limit])
			return rows.map { ListItem(message: $0) }
		}
		let sql = """
			SELECT head.*,
				(SELECT count(*) FROM message t WHERE coalesce(t.threadId, t.id) = head.threadKey AND t.status NOT IN ('draft', 'template')) AS threadCount,
				(SELECT count(*) FROM message t WHERE coalesce(t.threadId, t.id) = head.threadKey AND t.status NOT IN ('draft', 'template') AND t.read = 0) AS threadUnread
			FROM (
				SELECT m.*, coalesce(m.threadId, m.id) AS threadKey,
					row_number() OVER (PARTITION BY coalesce(m.threadId, m.id) ORDER BY m.createdAt DESC, m.id DESC) AS position
				FROM message m WHERE \(filter.sql)
			) head
			WHERE head.position = 1
			ORDER BY head.createdAt DESC, head.id DESC LIMIT ?
			"""
		return try Row.fetchAll(db, sql: sql, arguments: filter.arguments + [limit]).map { row in
			ListItem(message: try MessageRow(row: row), threadCount: max(1, row["threadCount"]), threadUnread: row["threadUnread"])
		}
	}
}
