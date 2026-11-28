import Foundation
import Testing
@testable import MailflareKit

/// Builds rows with only the fields a test cares about.
func mail(
	_ id: String, mailbox: String? = "box", direction: String = "inbound", status: String = "received", category: String = "primary",
	folder: String? = nil, read: Bool = false, starred: Bool = false, snoozedUntil: Date? = nil, thread: String? = nil,
	age: TimeInterval = 0, subject: String? = "Note", labels: [MessageLabel] = [], attachments: Int = 0, now: Date = testNow
) -> MessageRow {
	MessageRow(id: id, userId: "owner", mailboxId: mailbox, direction: direction, folderId: folder, category: category,
	           fromAddr: "Sender <sender@example.test>", toAddr: "owner@example.test", subject: subject, snippet: "Short",
	           status: status, read: read, starred: starred, snoozedUntil: snoozedUntil, threadId: thread,
	           createdAt: now.addingTimeInterval(-age), attachmentCount: attachments, labels: labels)
}

let testNow = Date(timeIntervalSince1970: 1_795_000_000)

func page(_ messages: [MessageRow] = [], removed: [String] = [], cursor: String = "c1", more: Bool = false, mailboxes: [String] = ["box"]) -> SyncPage {
	SyncPage(cursor: cursor, more: more, mailboxIds: mailboxes, messages: messages, removed: removed)
}

@Suite struct MailStoreTests {
	private func ids(_ store: MailStore, _ scope: ListScope) throws -> [String] {
		try store.list(scope, limit: 100, now: testNow).map(\.message.id)
	}

	@Test func `apply upserts and removes in one step and remembers the cursor`() throws {
		let store = try MailStore.inMemory()
		#expect(try store.cursor() == nil)
		try store.apply(page([mail("a", age: 10), mail("b", age: 20)], cursor: "c1"))
		#expect(try ids(store, ListScope(folder: .inbox)) == ["a", "b"])
		#expect(try store.cursor() == "c1")
		#expect(try store.mailboxIds() == ["box"])

		var changed = mail("a", read: true, age: 10)
		changed.subject = "Changed"
		try store.apply(page([changed], removed: ["b", "never-seen"], cursor: "c2"))
		let rows = try store.list(ListScope(folder: .inbox), limit: 100, now: testNow)
		#expect(rows.map(\.message.id) == ["a"])
		#expect(rows[0].message.read == true)
		#expect(rows[0].message.subject == "Changed")
		#expect(try store.cursor() == "c2")
	}

	@Test func `applying the same page twice changes nothing`() throws {
		let store = try MailStore.inMemory()
		let same = page([mail("a", labels: [MessageLabel(id: "l1", name: "Work", color: "#fff")]), mail("b", age: 5)])
		try store.apply(same)
		let before = try store.list(ListScope(folder: .all), limit: 100, now: testNow)
		try store.apply(same)
		#expect(try store.list(ListScope(folder: .all), limit: 100, now: testNow) == before)
		#expect(try ids(store, ListScope(folder: .inbox, folderId: "l1")) == ["a"])
	}

	@Test func `a row keeps every field it arrived with`() throws {
		let store = try MailStore.inMemory()
		var row = mail("a", starred: true, snoozedUntil: testNow.addingTimeInterval(-60), thread: "t1", labels: [MessageLabel(id: "l1", name: "Work", color: "#2563eb")], attachments: 2)
		row.ccAddr = "cc@example.test"
		row.fromContactName = "Known Sender"
		row.providerMessageId = "<id@example.test>"
		try store.apply(page([row]))
		#expect(try store.list(ListScope(folder: .all), limit: 10, now: testNow).first?.message == row)
	}

	@Test func `the inbox leaves out snoozed, spam, trash, filed, sent and advertising mail`() throws {
		let store = try MailStore.inMemory()
		try store.apply(page([
			mail("plain", age: 1),
			mail("invoice", category: "invoices", age: 2),
			mail("order", category: "orders", age: 3),
			mail("social", category: "social", age: 4),
			mail("woken", snoozedUntil: testNow.addingTimeInterval(-10), age: 5),
			mail("advert", category: "promotions"),
			mail("snoozed", snoozedUntil: testNow.addingTimeInterval(3600)),
			mail("spam", status: "spam"),
			mail("trash", status: "trash"),
			mail("archived", status: "archived"),
			mail("filed", folder: "f1"),
			mail("sent", direction: "outbound", status: "sent"),
			mail("draft", direction: "outbound", status: "draft"),
			mail("template", direction: "outbound", status: "template"),
			mail("elsewhere", mailbox: "other"),
		], mailboxes: ["box", "other"]))
		#expect(try ids(store, ListScope(mailboxId: "box", folder: .inbox)) == ["plain", "invoice", "order", "social", "woken"])
		#expect(try ids(store, ListScope(folder: .inbox)).contains("elsewhere"))
		#expect(try ids(store, ListScope(mailboxId: "box", folder: .promotions)) == ["advert"])
		#expect(try ids(store, ListScope(mailboxId: "box", folder: .invoices)) == ["invoice"])
		#expect(try ids(store, ListScope(mailboxId: "box", folder: .snoozed)) == ["snoozed"])
		#expect(try ids(store, ListScope(mailboxId: "box", folder: .spam)) == ["spam"])
		#expect(try ids(store, ListScope(mailboxId: "box", folder: .trash)) == ["trash"])
		#expect(try ids(store, ListScope(mailboxId: "box", folder: .archived)) == ["archived"])
		#expect(try ids(store, ListScope(mailboxId: "box", folder: .sent)) == ["sent"])
		#expect(try ids(store, ListScope(mailboxId: "box", folder: .drafts)) == ["draft"])
		#expect(try ids(store, ListScope(mailboxId: "box", folder: .inbox, folderId: "f1")) == ["filed"])
		let all = try ids(store, ListScope(mailboxId: "box", folder: .all))
		#expect(!all.contains("template") && !all.contains("sent") && all.contains("spam"))
	}

	@Test func `starred spans folders and the unread filter narrows any scope`() throws {
		let store = try MailStore.inMemory()
		try store.apply(page([
			mail("a", read: true, starred: true, age: 1),
			mail("b", status: "archived", starred: true, age: 2),
			mail("c", age: 3),
			mail("d", direction: "outbound", status: "sent", read: true, starred: true, age: 4),
		]))
		#expect(try ids(store, ListScope(folder: .starred)) == ["a", "b", "d"])
		#expect(try ids(store, ListScope(folder: .starred, unreadOnly: true)) == ["b"])
		#expect(try ids(store, ListScope(folder: .inbox, unreadOnly: true)) == ["c"])
	}

	@Test func `a conversation scope shows one row per thread with its newest message and counts`() throws {
		let store = try MailStore.inMemory()
		try store.apply(page([
			mail("first", read: true, thread: "t1", age: 300),
			mail("reply", direction: "outbound", status: "sent", read: true, thread: "t1", age: 200),
			mail("latest", thread: "t1", age: 100),
			mail("alone", age: 150),
			mail("other-thread", thread: "t2", age: 400),
		]))
		let rows = try store.list(ListScope(folder: .inbox, conversations: true), limit: 100, now: testNow)
		#expect(rows.map(\.message.id) == ["latest", "alone", "other-thread"])
		#expect(rows[0].threadCount == 3)
		#expect(rows[0].threadUnread == 1)
		#expect(rows[1].threadCount == 1)
		#expect(try store.thread(of: "first").map(\.id) == ["first", "reply", "latest"])
		#expect(try store.thread(of: "alone").map(\.id) == ["alone"])
		let flat = try store.list(ListScope(folder: .inbox), limit: 100, now: testNow)
		#expect(flat.map(\.message.id) == ["latest", "alone", "first", "other-thread"])
	}

	@Test func `the limit cuts the list and rows of the same second keep a stable order`() throws {
		let store = try MailStore.inMemory()
		try store.apply(page((0..<30).map { mail("m\(String(format: "%02d", $0))", age: 5) }))
		let rows = try ids(store, ListScope(folder: .inbox))
		#expect(rows == rows.sorted().reversed())
		#expect(try store.list(ListScope(folder: .inbox), limit: 10, now: testNow).count == 10)
	}

	@Test func `bodies are stored apart, found when missing and trimmed without losing the row`() throws {
		let store = try MailStore.inMemory()
		try store.apply(page([mail("new", age: 100), mail("newer", age: 50), mail("old", age: 40 * 86_400)]))
		#expect(try store.messagesNeedingBody(newerThan: testNow.addingTimeInterval(-30 * 86_400), limit: 10) == ["newer", "new"])
		#expect(try store.message(id: "new")?.body == nil)

		let attachment = AttachmentInfo(id: "a1", messageId: "new", filename: "file.pdf", type: "application/pdf", size: 10)
		try store.saveBody(MessageDetail(message: mail("new", age: 100), body: MessageBody(textBody: "Text", htmlBody: "<p>Text</p>"), attachments: [attachment], unsubscribeUrl: "https://example.test/u"))
		try store.saveBody(MessageDetail(message: mail("old", age: 40 * 86_400), body: MessageBody(textBody: "Old", htmlBody: nil)))
		let stored = try #require(try store.message(id: "new"))
		#expect(stored.body == MessageBody(textBody: "Text", htmlBody: "<p>Text</p>"))
		#expect(stored.attachments == [attachment])
		#expect(stored.unsubscribeUrl == "https://example.test/u")
		#expect(stored.row.subject == "Note", "the list row is not replaced by the detail's")
		#expect(try store.messagesNeedingBody(newerThan: testNow.addingTimeInterval(-30 * 86_400), limit: 10) == ["newer"])

		#expect(try store.trimBodies(olderThan: testNow.addingTimeInterval(-30 * 86_400)) == 1)
		#expect(try store.message(id: "old")?.body == nil)
		#expect(try store.message(id: "old")?.row.id == "old")
		#expect(try store.message(id: "new")?.body != nil)

		try store.apply(page([], removed: ["new"]))
		#expect(try store.message(id: "new") == nil)
		#expect(try store.attachmentCountForTesting() == 0)
	}

	@Test func `a body for a message the device does not hold yet stores its row too`() throws {
		let store = try MailStore.inMemory()
		try store.saveBody(MessageDetail(message: mail("far", age: 400 * 86_400), body: MessageBody(textBody: "Hello", htmlBody: nil)))
		#expect(try store.message(id: "far")?.body?.textBody == "Hello")
	}

	@Test func `mailboxes, folders and counts are replaced together and survive a reset of the mail`() throws {
		let store = try MailStore.inMemory()
		let box = MailboxInfo(id: "box", userId: "owner", localPart: "owner", hostname: "example.test", isPrimary: true)
		let folder = FolderInfo(id: "f1", mailboxId: "box", name: "Work", color: "#2563eb")
		let counts = MailCounts(folders: ["inbox": FolderCount(total: 4, unread: 2)])
		try store.replaceMailboxes([box], folders: [folder], counts: counts)
		#expect(try store.mailboxTree() == MailboxTree(mailboxes: [box], folders: [folder], counts: counts))

		try store.setSetting("offline.days", "14")
		try store.apply(page([mail("a")]))
		try store.markSynced(at: testNow)
		#expect(try store.lastSync() == testNow)
		try store.reset()
		#expect(try store.cursor() == nil)
		#expect(try store.lastSync() == nil)
		#expect(try store.list(ListScope(folder: .all), limit: 10, now: testNow).isEmpty)
		#expect(try store.setting("offline.days") == "14")
		#expect(try store.mailboxTree().mailboxes == [box])
	}

	@Test func `each account has its own file and destroying one leaves the other`() throws {
		let directory = FileManager.default.temporaryDirectory.appending(path: "mailflare-store-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		let first = try MailStore.open(userId: "user/one", directory: directory)
		let second = try MailStore.open(userId: "user-two", directory: directory)
		try first.apply(page([mail("a")]))
		#expect(try second.list(ListScope(folder: .all), limit: 10, now: testNow).isEmpty)
		try first.close()
		try MailStore.destroy(userId: "user/one", directory: directory)
		let reopened = try MailStore.open(userId: "user/one", directory: directory)
		#expect(try reopened.list(ListScope(folder: .all), limit: 10, now: testNow).isEmpty)
		try second.apply(page([mail("b")]))
		#expect(try second.list(ListScope(folder: .all), limit: 10, now: testNow).count == 1)
	}

	@Test func `a list observation emits again after a page is applied`() async throws {
		let store = try MailStore.inMemory()
		var iterator = store.observeList(ListScope(folder: .inbox), limit: 50).makeAsyncIterator()
		#expect(await iterator.next()?.isEmpty == true)
		try store.apply(page([mail("a")]))
		#expect(await iterator.next()?.map(\.message.id) == ["a"])
	}
}
