import Foundation
import GRDB

/// The mail of one account on this device. Every screen reads from here, so the app shows
/// the same thing with and without a network.
public final class MailStore: Sendable {
	private let writer: any DatabaseWriter

	private init(writer: any DatabaseWriter, migratingUpTo version: String? = nil) throws {
		self.writer = writer
		if let version { try Schema.migrator.migrate(writer, upTo: version) } else { try Schema.migrator.migrate(writer) }
	}

	// MARK: Opening

	public static func inMemory() throws -> MailStore {
		try MailStore(writer: DatabaseQueue(configuration: configuration))
	}

	/// Opens the account's own database file below `directory`, creating it when missing.
	public static func open(userId: String, directory: URL) throws -> MailStore {
		try open(userId: userId, directory: directory, migratingUpTo: nil)
	}

	/// For tests of an upgrade: opens the database as an older version of the app left it.
	static func open(userId: String, directory: URL, migratingUpTo version: String?) throws -> MailStore {
		let folder = folder(userId: userId, directory: directory)
		try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		#if os(iOS)
		// Readable once the phone has been unlocked after a restart, so a background sync can write.
		try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: folder.path)
		#endif
		return try MailStore(writer: DatabasePool(path: folder.appending(path: "mail.sqlite").path, configuration: configuration), migratingUpTo: version)
	}

	public static func destroy(userId: String, directory: URL) throws {
		let folder = folder(userId: userId, directory: directory)
		if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
	}

	public func close() throws {
		try writer.close()
	}

	private static var configuration: Configuration {
		var configuration = Configuration()
		configuration.foreignKeysEnabled = true
		return configuration
	}

	/// A folder name that cannot collide or leave `directory`, whatever the account id contains.
	private static func folder(userId: String, directory: URL) -> URL {
		let name = userId.utf8.map { String(format: "%02x", $0) }.joined()
		return directory.appending(path: "accounts/\(name)", directoryHint: .isDirectory)
	}

	// MARK: Sync

	/// Takes one answer of the sync route: stores its messages, drops the removed ones and
	/// remembers the cursor, all or nothing.
	public func apply(_ page: SyncPage) throws {
		try writer.write { db in
			// A message with an action still waiting keeps what the user made of it: the server's
			// row is older than that action, and a fresh one follows once the action has arrived.
			let waiting = try Self.idsWithPendingOperations(db)
			try Self.upsert(db, waiting.isEmpty ? page.messages : page.messages.filter { !waiting.contains($0.id) })
			for id in page.removed { try MessageRow.deleteOne(db, key: id) }
			try Self.setState(db, "cursor", page.cursor)
			try Self.setState(db, "mailboxIds", String(decoding: try JSONEncoder().encode(page.mailboxIds.sorted()), as: UTF8.self))
		}
	}

	/// Stores rows that came from the server's list, such as mail older than the offline window.
	public func upsert(_ rows: [MessageRow]) throws {
		try writer.write { db in try Self.upsert(db, rows) }
	}

	private static func upsert(_ db: Database, _ rows: [MessageRow]) throws {
		for row in rows {
			try row.upsert(db)
			try db.execute(sql: "DELETE FROM message_label WHERE messageId = ?", arguments: [row.id])
			for label in row.labels {
				try db.execute(sql: "INSERT OR IGNORE INTO message_label (messageId, folderId) VALUES (?, ?)", arguments: [row.id, label.id])
			}
		}
	}

	/// Drops the mail and the sync position. Settings, mailboxes and folders stay.
	public func reset() throws {
		try writer.write { db in
			try db.execute(sql: "DELETE FROM message")
			try db.execute(sql: "DELETE FROM sync_state")
			try db.execute(sql: "DELETE FROM outbox")
		}
	}

	public func cursor() throws -> String? {
		try writer.read { try Self.state($0, "cursor") }
	}

	/// The mailboxes the last sync said the account can read, sorted. Nil before the first sync.
	public func mailboxIds() throws -> [String]? {
		try writer.read { db in
			guard let json = try Self.state(db, "mailboxIds") else { return nil }
			return try JSONDecoder().decode([String].self, from: Data(json.utf8))
		}
	}

	public func markSynced(at date: Date) throws {
		try writer.write { try Self.setState($0, "lastSync", String(date.timeIntervalSince1970)) }
	}

	public func lastSync() throws -> Date? {
		try writer.read { db in try Self.state(db, "lastSync").flatMap(Double.init).map(Date.init(timeIntervalSince1970:)) }
	}

	private static func state(_ db: Database, _ key: String) throws -> String? {
		try String.fetchOne(db, sql: "SELECT value FROM sync_state WHERE key = ?", arguments: [key])
	}

	private static func setState(_ db: Database, _ key: String, _ value: String) throws {
		try db.execute(sql: "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", arguments: [key, value])
	}

	// MARK: Actions

	/// Applies an action to the stored messages at once and notes it for the server, all or
	/// nothing. Returns the outbox entry, or nil when none of the messages is on the device.
	@discardableResult
	public func perform(_ action: MailAction, messageIds: [String], at date: Date = Date()) throws -> Int64? {
		try writer.write { db in
			var before: [MessageRow] = []
			for id in messageIds {
				if let row = try MessageRow.fetchOne(db, key: id) { before.append(row) }
			}
			guard !before.isEmpty else { return nil }
			for row in before {
				if let changed = action.applied(to: row) { try Self.upsert(db, [changed]) } else { try MessageRow.deleteOne(db, key: row.id) }
			}
			let encoder = JSONEncoder()
			try db.execute(sql: "INSERT INTO outbox (action, messageIds, snapshot, createdAt) VALUES (?, ?, ?, ?)", arguments: [
				String(decoding: try encoder.encode(action), as: UTF8.self),
				String(decoding: try encoder.encode(before.map(\.id)), as: UTF8.self),
				String(decoding: try encoder.encode(before), as: UTF8.self),
				date,
			])
			return db.lastInsertedRowID
		}
	}

	public func pendingOperations() throws -> [PendingOperation] {
		try writer.read { db in
			try Row.fetchAll(db, sql: "SELECT id, action, messageIds, attempts FROM outbox ORDER BY id").map { row in
				PendingOperation(
					id: row["id"],
					action: try JSONDecoder().decode(MailAction.self, from: Data((row["action"] as String).utf8)),
					messageIds: try JSONDecoder().decode([String].self, from: Data((row["messageIds"] as String).utf8)),
					attempts: row["attempts"]
				)
			}
		}
	}

	/// The server has taken the action: the change stays, the entry goes.
	public func completeOperation(_ id: Int64) throws {
		try writer.write { try $0.execute(sql: "DELETE FROM outbox WHERE id = ?", arguments: [id]) }
	}

	/// The server refused the action for good: the messages go back to what they were.
	public func revertOperation(_ id: Int64) throws {
		try writer.write { db in
			guard let snapshot = try String.fetchOne(db, sql: "SELECT snapshot FROM outbox WHERE id = ?", arguments: [id]) else { return }
			try Self.upsert(db, try JSONDecoder().decode([MessageRow].self, from: Data(snapshot.utf8)))
			try db.execute(sql: "DELETE FROM outbox WHERE id = ?", arguments: [id])
		}
	}

	/// Counts a failed try and returns how many there have been.
	@discardableResult
	public func noteAttempt(_ id: Int64) throws -> Int {
		try writer.write { db in
			try db.execute(sql: "UPDATE outbox SET attempts = attempts + 1 WHERE id = ?", arguments: [id])
			return try Int.fetchOne(db, sql: "SELECT attempts FROM outbox WHERE id = ?", arguments: [id]) ?? 0
		}
	}

	private static func idsWithPendingOperations(_ db: Database) throws -> Set<String> {
		var ids: Set<String> = []
		for json in try String.fetchAll(db, sql: "SELECT messageIds FROM outbox") {
			ids.formUnion(try JSONDecoder().decode([String].self, from: Data(json.utf8)))
		}
		return ids
	}

	/// The messages a row of the list stands for: in a conversation list every message of the
	/// conversation that the list shows, newest first; otherwise the message itself.
	public func conversationMemberIds(of messageId: String, in scope: ListScope, now: Date = Date()) throws -> [String] {
		guard scope.conversations, scope.folder != .drafts else { return [messageId] }
		return try writer.read { db in
			let filter = MailQueries.filter(scope, now: now)
			let ids = try String.fetchAll(db, sql: """
				SELECT m.id FROM message m JOIN message head ON head.id = ?
				WHERE coalesce(m.threadId, m.id) = coalesce(head.threadId, head.id) AND \(filter.sql)
				ORDER BY m.createdAt DESC, m.id DESC
				""", arguments: [messageId] + filter.arguments)
			return ids.contains(messageId) ? ids : [messageId]
		}
	}

	// MARK: Messages the user wrote

	public func saveOutgoing(_ message: OutgoingMessage) throws {
		try writer.write { db in
			try db.execute(sql: """
				INSERT INTO outgoing (id, json, state, createdAt) VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET json = excluded.json, state = excluded.state
				""", arguments: [message.id, String(decoding: try JSONEncoder().encode(message), as: UTF8.self), message.state.kind.rawValue, message.createdAt])
		}
	}

	public func outgoing(id: String) throws -> OutgoingMessage? {
		try writer.read { db in
			try String.fetchOne(db, sql: "SELECT json FROM outgoing WHERE id = ?", arguments: [id]).map { try JSONDecoder().decode(OutgoingMessage.self, from: Data($0.utf8)) }
		}
	}

	/// The messages written on this device, oldest first; all of them, or those in the given states.
	public func outgoingMessages(in states: [OutgoingMessage.State.Kind]? = nil) throws -> [OutgoingMessage] {
		try writer.read { try Self.outgoingMessages($0, states) }
	}

	private static func outgoingMessages(_ db: Database, _ states: [OutgoingMessage.State.Kind]?) throws -> [OutgoingMessage] {
		let all = try String.fetchAll(db, sql: "SELECT json FROM outgoing ORDER BY rowid").map { try JSONDecoder().decode(OutgoingMessage.self, from: Data($0.utf8)) }
		guard let states else { return all }
		return all.filter { states.contains($0.state.kind) }
	}

	public func deleteOutgoing(id: String) throws {
		try writer.write { try $0.execute(sql: "DELETE FROM outgoing WHERE id = ?", arguments: [id]) }
	}

	public func observeOutgoing() -> AsyncStream<[OutgoingMessage]> {
		stream(ValueObservation.tracking { try Self.outgoingMessages($0, nil) })
	}

	// MARK: Bodies

	/// Stores a fetched body and its attachments. The list row is left as the sync delivered it;
	/// it is only created here for a message the device does not hold yet.
	public func saveBody(_ detail: MessageDetail) throws {
		try writer.write { db in
			let id = detail.message.id
			if try !MessageRow.exists(db, key: id) { try Self.upsert(db, [detail.message]) }
			try BodyRecord(messageId: id, textBody: detail.body.textBody, htmlBody: detail.body.htmlBody, unsubscribeUrl: detail.unsubscribeUrl).upsert(db)
			try db.execute(sql: "UPDATE message_search SET body = ? WHERE rowid = (SELECT rowid FROM message WHERE id = ?)",
			               arguments: [SearchText.body(text: detail.body.textBody, html: detail.body.htmlBody), id])
			try db.execute(sql: "DELETE FROM attachment WHERE messageId = ?", arguments: [id])
			for attachment in detail.attachments { try attachment.upsert(db) }
		}
	}

	/// Messages inside the offline window whose body has not been fetched, newest first.
	public func messagesNeedingBody(newerThan date: Date, limit: Int) throws -> [String] {
		try writer.read { db in
			try String.fetchAll(db, sql: """
				SELECT m.id FROM message m LEFT JOIN message_body b ON b.messageId = m.id
				WHERE b.messageId IS NULL AND m.createdAt >= ? ORDER BY m.createdAt DESC, m.id DESC LIMIT ?
				""", arguments: [date, limit])
		}
	}

	/// Frees the bodies of mail that has left the offline window. The rows stay in their lists.
	@discardableResult
	public func trimBodies(olderThan date: Date) throws -> Int {
		try writer.write { db in
			try db.execute(sql: "DELETE FROM attachment WHERE messageId IN (SELECT id FROM message WHERE createdAt < ?)", arguments: [date])
			try db.execute(sql: """
				UPDATE message_search SET body = '' WHERE rowid IN
					(SELECT m.rowid FROM message m JOIN message_body b ON b.messageId = m.id WHERE m.createdAt < ?)
				""", arguments: [date])
			try db.execute(sql: "DELETE FROM message_body WHERE messageId IN (SELECT id FROM message WHERE createdAt < ?)", arguments: [date])
			return db.changesCount
		}
	}

	// MARK: Attachments

	/// Attachments of mail inside the offline window that are small enough to fetch unasked, newest mail first.
	public func attachments(newerThan date: Date, maxBytes: Int) throws -> [AttachmentInfo] {
		try writer.read { db in
			try AttachmentInfo.fetchAll(db, sql: """
				SELECT a.* FROM attachment a JOIN message m ON m.id = a.messageId
				WHERE m.createdAt >= ? AND a.size <= ? ORDER BY m.createdAt DESC, a.rowid
				""", arguments: [date, maxBytes])
		}
	}

	public func attachmentIds() throws -> Set<String> {
		try writer.read { Set(try String.fetchAll($0, sql: "SELECT id FROM attachment")) }
	}

	/// Where this account's files live next to its database. Nil for a store that is only in memory.
	public var directory: URL? {
		let path = writer.path
		return path.isEmpty || path == ":memory:" ? nil : URL(filePath: path).deletingLastPathComponent()
	}

	// MARK: Reading

	public func list(_ scope: ListScope, limit: Int, now: Date = Date()) throws -> [ListItem] {
		try writer.read { try MailQueries.list($0, scope, limit: limit, now: now) }
	}

	public func message(id: String) throws -> StoredMessage? {
		try writer.read { try Self.message($0, id: id) }
	}

	/// Unread mail in the inbox of every mailbox, as the number at the app's icon counts it:
	/// without promotions, spam, trash, archived and snoozed mail.
	public func unreadInboxCount(now: Date = Date()) throws -> Int {
		let filter = MailQueries.filter(ListScope(folder: .inbox, unreadOnly: true), now: now)
		return try writer.read { try Int.fetchOne($0, sql: "SELECT count(*) FROM message m WHERE \(filter.sql)", arguments: filter.arguments) ?? 0 }
	}

	/// The mail on this device that contains every word of `text`, newest first. Spam is left out,
	/// as the server's search leaves it out.
	public func search(_ text: String, mailboxId: String? = nil, limit: Int) throws -> [ListItem] {
		guard let match = SearchText.match(text) else { return [] }
		return try writer.read { db in
			var sql = "SELECT m.* FROM message m WHERE m.rowid IN (SELECT rowid FROM message_search WHERE message_search MATCH ?) AND m.status NOT IN ('template', 'spam')"
			var arguments: StatementArguments = [match]
			if let mailboxId { sql += " AND m.mailboxId = ?"; arguments += [mailboxId] }
			return try MessageRow.fetchAll(db, sql: sql + " ORDER BY m.createdAt DESC, m.id DESC LIMIT ?", arguments: arguments + [limit]).map { ListItem(message: $0) }
		}
	}

	private static func message(_ db: Database, id: String) throws -> StoredMessage? {
		guard let row = try MessageRow.fetchOne(db, key: id) else { return nil }
		let body = try BodyRecord.fetchOne(db, key: id)
		let attachments = try AttachmentInfo.fetchAll(db, sql: "SELECT * FROM attachment WHERE messageId = ? ORDER BY rowid", arguments: [id])
		return StoredMessage(row: row, body: body.map { MessageBody(textBody: $0.textBody, htmlBody: $0.htmlBody) }, attachments: attachments, unsubscribeUrl: body?.unsubscribeUrl)
	}

	/// The conversation a message belongs to, oldest first, without drafts.
	public func thread(of messageId: String) throws -> [MessageRow] {
		try writer.read { db in
			try MessageRow.fetchAll(db, sql: """
				SELECT t.* FROM message t JOIN message m ON m.id = ?
				WHERE coalesce(t.threadId, t.id) = coalesce(m.threadId, m.id) AND (t.id = m.id OR t.status NOT IN ('draft', 'template'))
				ORDER BY t.createdAt, t.id
				""", arguments: [messageId])
		}
	}

	// MARK: Mailboxes

	public func replaceMailboxes(_ mailboxes: [MailboxInfo], folders: [FolderInfo], counts: MailCounts) throws {
		try writer.write { db in
			try Self.setDocument(db, "mailboxes", mailboxes)
			try Self.setDocument(db, "folders", folders)
			try Self.setDocument(db, "counts", counts)
		}
	}

	public func mailboxTree() throws -> MailboxTree {
		try writer.read { try Self.mailboxTree($0) }
	}

	private static func mailboxTree(_ db: Database) throws -> MailboxTree {
		MailboxTree(
			mailboxes: try document(db, "mailboxes", [MailboxInfo].self) ?? [],
			folders: try document(db, "folders", [FolderInfo].self) ?? [],
			counts: try document(db, "counts", MailCounts.self) ?? MailCounts()
		)
	}

	private static func setDocument(_ db: Database, _ key: String, _ value: some Encodable) throws {
		try db.execute(sql: "INSERT INTO document (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json", arguments: [key, try JSONEncoder().encode(value)])
	}

	private static func document<T: Decodable>(_ db: Database, _ key: String, _ type: T.Type) throws -> T? {
		guard let data = try Data.fetchOne(db, sql: "SELECT json FROM document WHERE key = ?", arguments: [key]) else { return nil }
		// A document written by another version of the app is fetched again by the next sync.
		return try? JSONDecoder().decode(type, from: data)
	}

	// MARK: Settings

	public func setting(_ key: String) throws -> String? {
		try writer.read { try String.fetchOne($0, sql: "SELECT value FROM setting WHERE key = ?", arguments: [key]) }
	}

	public func setSetting(_ key: String, _ value: String?) throws {
		try writer.write { db in
			if let value {
				try db.execute(sql: "INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", arguments: [key, value])
			} else {
				try db.execute(sql: "DELETE FROM setting WHERE key = ?", arguments: [key])
			}
		}
	}

	// MARK: Observing

	/// The list, again whenever the stored mail changes.
	public func observeList(_ scope: ListScope, limit: Int) -> AsyncStream<[ListItem]> {
		stream(ValueObservation.tracking { try MailQueries.list($0, scope, limit: limit, now: Date()) })
	}

	public func observeMessage(id: String) -> AsyncStream<StoredMessage?> {
		stream(ValueObservation.tracking { try Self.message($0, id: id) })
	}

	public func observeMailboxes() -> AsyncStream<MailboxTree> {
		stream(ValueObservation.tracking { try Self.mailboxTree($0) })
	}

	private func stream<Value: Sendable>(_ observation: ValueObservation<ValueReducers.Fetch<Value>>) -> AsyncStream<Value> {
		AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
			let cancellable = observation.start(
				in: writer,
				scheduling: .async(onQueue: .global(qos: .userInitiated)),
				onError: { _ in continuation.finish() },
				onChange: { continuation.yield($0) }
			)
			continuation.onTermination = { _ in cancellable.cancel() }
		}
	}

	func executeForTesting(_ sql: String) throws {
		try writer.write { try $0.execute(sql: sql) }
	}

	func attachmentCountForTesting() throws -> Int {
		try writer.read { try Int.fetchOne($0, sql: "SELECT count(*) FROM attachment") ?? 0 }
	}
}
