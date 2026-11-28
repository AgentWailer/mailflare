import Foundation
import Testing
@testable import MailflareKit

@Suite struct MailStoreActionTests {
	private func store(_ rows: [MessageRow]) throws -> MailStore {
		let store = try MailStore.inMemory()
		try store.apply(page(rows))
		return store
	}

	private func row(_ store: MailStore, _ id: String) throws -> MessageRow? { try store.message(id: id)?.row }

	@Test func `each action changes the stored rows the way the server will`() throws {
		let later = testNow.addingTimeInterval(3600)
		let cases: [(MailAction, (MessageRow) -> Bool)] = [
			(.markRead(true), { $0.read }),
			(.star(true), { $0.starred }),
			(.archive, { $0.status == "archived" && $0.folderId == nil }),
			(.trash, { $0.status == "trash" && $0.folderId == nil }),
			(.spam, { $0.status == "spam" && $0.folderId == nil }),
			(.moveToInbox, { $0.status == "received" && $0.folderId == nil && $0.category == "primary" }),
			(.moveToFolder("f9"), { $0.status == "received" && $0.folderId == "f9" }),
			(.snooze(until: later), { $0.snoozedUntil == later }),
		]
		for (action, expected) in cases {
			let store = try store([mail("a", status: action == .moveToInbox || action == .moveToFolder("f9") ? "archived" : "received", category: "invoices", folder: "f1")])
			try store.perform(action, messageIds: ["a"])
			#expect(expected(try #require(try row(store, "a"))), "\(action)")
			#expect(try store.pendingOperations().map(\.action) == [action])
		}
		let unread = try store([mail("a", read: true, starred: true, snoozedUntil: later)])
		try unread.perform(.markRead(false), messageIds: ["a"])
		try unread.perform(.star(false), messageIds: ["a"])
		try unread.perform(.unsnooze, messageIds: ["a"])
		let after = try #require(try row(unread, "a"))
		#expect(!after.read && !after.starred && after.snoozedUntil == nil)
		#expect(try unread.pendingOperations().count == 3)
	}

	@Test func `deleting for good removes the row and can be put back`() throws {
		let store = try store([mail("a", status: "trash"), mail("b")])
		try store.saveBody(MessageDetail(message: mail("a", status: "trash"), body: MessageBody(textBody: "Text", htmlBody: nil)))
		let operation = try #require(try store.perform(.deletePermanently, messageIds: ["a"]))
		#expect(try row(store, "a") == nil)
		try store.revertOperation(operation)
		#expect(try row(store, "a")?.status == "trash")
		#expect(try store.pendingOperations().isEmpty)
	}

	@Test func `an action on several messages is one entry, and unknown ids are left out`() throws {
		let store = try store([mail("a"), mail("b"), mail("c")])
		let operation = try #require(try store.perform(.archive, messageIds: ["a", "c", "missing"]))
		let pending = try store.pendingOperations()
		#expect(pending.count == 1)
		#expect(pending[0].id == operation)
		#expect(pending[0].messageIds == ["a", "c"])
		#expect(try row(store, "b")?.status == "received")
		#expect(try store.list(ListScope(folder: .inbox), limit: 10, now: testNow).map(\.message.id) == ["b"])
	}

	@Test func `an action that names no stored message does nothing`() throws {
		let store = try store([mail("a")])
		#expect(try store.perform(.archive, messageIds: ["missing"]) == nil)
		#expect(try store.perform(.archive, messageIds: []) == nil)
		#expect(try store.pendingOperations().isEmpty)
	}

	@Test func `putting an action back restores exactly what it changed`() throws {
		let store = try store([mail("a", category: "invoices", folder: "f1", labels: [MessageLabel(id: "f1", name: "Haus", color: "#fff")]), mail("b")])
		let before = try #require(try row(store, "a"))
		let operation = try #require(try store.perform(.trash, messageIds: ["a", "b"]))
		try store.revertOperation(operation)
		#expect(try row(store, "a") == before)
		#expect(try row(store, "b")?.status == "received")
		#expect(try store.list(ListScope(folder: .inbox, folderId: "f1"), limit: 10, now: testNow).map(\.message.id) == ["a"])
	}

	@Test func `a completed action leaves its change and frees the outbox`() throws {
		let store = try store([mail("a")])
		let operation = try #require(try store.perform(.archive, messageIds: ["a"]))
		try store.completeOperation(operation)
		#expect(try store.pendingOperations().isEmpty)
		#expect(try row(store, "a")?.status == "archived")
	}

	@Test func `a sync page does not overwrite a message that waits in the outbox`() throws {
		let store = try store([mail("a"), mail("b")])
		let operation = try #require(try store.perform(.archive, messageIds: ["a"]))
		// The server still has the old state of "a", and a newer one of "b".
		try store.apply(page([mail("a", subject: "Stale"), mail("b", read: true)], cursor: "c2"))
		#expect(try row(store, "a")?.status == "archived")
		#expect(try row(store, "a")?.subject == "Note")
		#expect(try row(store, "b")?.read == true)
		#expect(try store.cursor() == "c2")
		try store.completeOperation(operation)
		try store.apply(page([mail("a", status: "archived", subject: "Fresh")], cursor: "c3"))
		#expect(try row(store, "a")?.subject == "Fresh")
	}

	@Test func `a message removed on the server stays removed even while it waits in the outbox`() throws {
		let store = try store([mail("a")])
		_ = try store.perform(.star(true), messageIds: ["a"])
		try store.apply(page([], removed: ["a"], cursor: "c2"))
		#expect(try row(store, "a") == nil)
	}

	@Test func `the outbox keeps its order and counts tries`() throws {
		let store = try store([mail("a"), mail("b")])
		let first = try #require(try store.perform(.star(true), messageIds: ["a"]))
		let second = try #require(try store.perform(.archive, messageIds: ["b"]))
		#expect(try store.pendingOperations().map(\.id) == [first, second])
		#expect(try store.noteAttempt(first) == 1)
		#expect(try store.noteAttempt(first) == 2)
		#expect(try store.pendingOperations().first?.attempts == 2)
	}

	@Test func `a reset keeps nothing waiting`() throws {
		let store = try store([mail("a")])
		_ = try store.perform(.archive, messageIds: ["a"])
		try store.reset()
		#expect(try store.pendingOperations().isEmpty)
	}

	@Test func `a conversation row acts on every message of the conversation that its list shows`() throws {
		let store = try store([
			mail("first", read: true, thread: "t", age: 300),
			mail("mine", direction: "outbound", status: "sent", read: true, thread: "t", age: 200),
			mail("latest", thread: "t", age: 100),
			mail("archived", status: "archived", thread: "t", age: 400),
			mail("alone", age: 50),
		])
		let inbox = ListScope(folder: .inbox, conversations: true)
		#expect(try store.conversationMemberIds(of: "latest", in: inbox, now: testNow) == ["latest", "first"])
		#expect(try store.conversationMemberIds(of: "alone", in: inbox, now: testNow) == ["alone"])
		#expect(try store.conversationMemberIds(of: "latest", in: ListScope(folder: .inbox), now: testNow) == ["latest"], "single messages when conversations are off")
		#expect(try store.conversationMemberIds(of: "latest", in: ListScope(folder: .starred, conversations: true), now: testNow) == ["latest"], "a message outside the list acts alone")
	}

	@Test func `a store made before the outbox existed gains it`() throws {
		let directory = FileManager.default.temporaryDirectory.appending(path: "mailflare-upgrade-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		let old = try MailStore.open(userId: "u", directory: directory, migratingUpTo: "v1")
		try old.upsert([mail("a")])
		try old.close()
		let upgraded = try MailStore.open(userId: "u", directory: directory)
		#expect(try upgraded.perform(.archive, messageIds: ["a"]) != nil)
	}
}
