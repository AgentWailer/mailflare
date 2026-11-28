import Foundation
@testable import MailflareKit

/// A small model of the server's side of the sync contract: mailboxes, messages and a change log.
actor FakeServer: MailAPI {
	struct Change { let seq: Int; let mailboxId: String; let messageId: String }

	var messages: [String: MessageRow] = [:]
	var readable: Set<String> = ["box"]
	var log: [Change] = []
	var nextSeq = 1
	/// Entries below this sequence number have been pruned.
	var prunedBelow = 0
	let now: Date

	// What a test can make go wrong.
	var failure: APIError?
	var failSyncAfterCalls: Int?
	var failingBodies: Set<String> = []
	var beforeSyncAnswer: (@Sendable (Int) async -> Void)?

	// What a test can check afterwards.
	private(set) var syncCursors: [String?] = []
	private(set) var bodyRequests: [String] = []
	private(set) var attachmentRequests: [String] = []
	var attachments: [String: [AttachmentInfo]] = [:]

	func attach(_ attachment: AttachmentInfo) { attachments[attachment.messageId, default: []].append(attachment) }
	private(set) var maxConcurrentBodies = 0
	private var concurrentBodies = 0

	init(now: Date = testNow) { self.now = now }

	func setFailure(_ failure: APIError?) { self.failure = failure }
	func failSync(afterCalls count: Int?) { failSyncAfterCalls = count }
	func failBodies(_ ids: Set<String>) { failingBodies = ids }
	func onSyncAnswer(_ hook: (@Sendable (Int) async -> Void)?) { beforeSyncAnswer = hook }
	func setReadable(_ ids: Set<String>) { readable = ids }
	func prune() { prunedBelow = nextSeq; log.removeAll() }
	func forgetCalls() { syncCursors = []; bodyRequests = []; attachmentRequests = []; actionCalls = [] }

	func put(_ row: MessageRow) {
		messages[row.id] = row
		record(row)
	}

	func put(_ rows: [MessageRow]) { rows.forEach(put) }

	func remove(_ id: String) {
		guard let row = messages.removeValue(forKey: id) else { return }
		record(row)
	}

	private func record(_ row: MessageRow) {
		log.append(Change(seq: nextSeq, mailboxId: row.mailboxId ?? "", messageId: row.id))
		nextSeq += 1
	}

	private func window(days: Int) -> [MessageRow] {
		let start = now.addingTimeInterval(-Double(days) * 86_400)
		return messages.values
			.filter { readable.contains($0.mailboxId ?? "") && $0.createdAt >= start }
			.sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
	}

	func sync(cursor: String?, days: Int, limit: Int) async throws -> SyncPage {
		syncCursors.append(cursor)
		if let failure { throw failure }
		if let failSyncAfterCalls, syncCursors.count > failSyncAfterCalls { throw APIError.server(status: 500, message: "interrupted") }
		await beforeSyncAnswer?(syncCursors.count)
		let mailboxIds = readable.sorted()
		let reset = SyncPage(cursor: "", more: false, reset: true, mailboxIds: mailboxIds)

		guard let cursor else { return backfill(seq: nextSeq - 1, days: days, offset: 0, limit: limit) }
		let parts = cursor.split(separator: "|").map(String.init)
		guard parts.count == 3, let seq = Int(parts[0]), let cursorDays = Int(parts[1]), let offset = Int(parts[2]) else { return reset }
		if cursorDays != days || seq < prunedBelow - 1 || seq > nextSeq - 1 { return reset }
		if offset >= 0 { return backfill(seq: seq, days: days, offset: offset, limit: limit) }

		var ids: [String] = []
		var last = seq
		var cut = false
		for change in log where change.seq > seq {
			if readable.contains(change.mailboxId), !ids.contains(change.messageId) {
				if ids.count >= limit { cut = true; break }
				ids.append(change.messageId)
			}
			last = change.seq
		}
		let rows = ids.compactMap { messages[$0] }.filter { readable.contains($0.mailboxId ?? "") }
		let found = Set(rows.map(\.id))
		return SyncPage(cursor: "\(last)|\(days)|-1", more: cut, mailboxIds: mailboxIds, messages: rows, removed: ids.filter { !found.contains($0) })
	}

	private func backfill(seq: Int, days: Int, offset: Int, limit: Int) -> SyncPage {
		let all = window(days: days)
		let rows = Array(all.dropFirst(offset).prefix(limit))
		let done = rows.count < limit
		return SyncPage(cursor: "\(seq)|\(days)|\(done ? -1 : offset + limit)", more: true, mailboxIds: readable.sorted(), messages: rows)
	}

	func message(id: String) async throws -> MessageDetail {
		bodyRequests.append(id)
		concurrentBodies += 1
		maxConcurrentBodies = max(maxConcurrentBodies, concurrentBodies)
		defer { concurrentBodies -= 1 }
		await Task.yield()
		if let failure { throw failure }
		if failingBodies.contains(id) { throw APIError.server(status: 500, message: nil) }
		guard let row = messages[id], readable.contains(row.mailboxId ?? "") else { throw APIError.notFound }
		return MessageDetail(message: row, body: MessageBody(textBody: "Body of \(id)", htmlBody: nil), attachments: attachments[id] ?? [])
	}

	func attachment(messageId: String, attachmentId: String, filename: String) async throws -> URL {
		attachmentRequests.append(attachmentId)
		if let failure { throw failure }
		let url = FileManager.default.temporaryDirectory.appending(path: "fake-\(UUID().uuidString)")
		try Data("bytes of \(attachmentId)".utf8).write(to: url)
		return url
	}

	// Actions: applied to the model and logged, as the server does.
	private(set) var actionCalls: [String] = []
	/// Errors to answer the next action calls with, in order; nil lets a call through.
	var actionFailures: [APIError?] = []
	func failActions(_ failures: [APIError?]) { actionFailures = failures }

	private func act(_ name: String, _ ids: [String], _ change: (inout MessageRow) -> Void) throws {
		actionCalls.append("\(name) \(ids.joined(separator: ","))")
		if let failure { throw failure }
		if !actionFailures.isEmpty, let failure = actionFailures.removeFirst() { throw failure }
		for id in ids {
			guard var row = messages[id] else { continue }
			change(&row)
			put(row)
		}
	}

	func bulk(action: String, messageIds: [String], folderId: String?) async throws {
		if action == "delete" {
			actionCalls.append("delete \(messageIds.joined(separator: ","))")
			if let failure { throw failure }
			if !actionFailures.isEmpty, let failure = actionFailures.removeFirst() { throw failure }
			messageIds.forEach(remove)
			return
		}
		try act(action + (folderId.map { ":\($0)" } ?? ""), messageIds) { row in
			switch action {
			case "archive": row.status = "archived"; row.folderId = nil
			case "trash": row.status = "trash"; row.folderId = nil
			case "spam": row.status = "spam"; row.folderId = nil
			case "inbox": row.status = "received"; row.folderId = nil; row.category = "primary"
			case "folder": row.status = "received"; row.folderId = folderId
			case "read": row.read = true
			case "unread": row.read = false
			default: break
			}
		}
	}

	func star(messageId: String, starred: Bool) async throws {
		guard messages[messageId] != nil || failure != nil || !actionFailures.isEmpty else {
			actionCalls.append("star \(messageId)")
			throw APIError.notFound
		}
		try act("star:\(starred)", [messageId]) { $0.starred = starred }
	}

	func snooze(messageId: String, until: Date?) async throws {
		try act(until == nil ? "unsnooze" : "snooze", [messageId]) { $0.snoozedUntil = until }
	}

	func mailboxes() async throws -> [MailboxInfo] {
		if let failure { throw failure }
		return readable.sorted().map { MailboxInfo(id: $0, userId: "owner", localPart: $0, hostname: "example.test") }
	}

	func folders(mailboxId: String) async throws -> [FolderInfo] {
		[FolderInfo(id: "folder-\(mailboxId)", mailboxId: mailboxId, name: "Work")]
	}

	func counts(mailboxId: String?) async throws -> MailCounts {
		MailCounts(folders: ["inbox": FolderCount(total: messages.count, unread: messages.values.filter { !$0.read }.count)])
	}
}
