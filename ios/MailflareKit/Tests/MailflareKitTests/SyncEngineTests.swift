import Foundation
import Synchronization
import Testing
@testable import MailflareKit

@Suite struct SyncEngineTests {
	private func engine(_ server: FakeServer, _ store: MailStore, settings: SyncSettings = SyncSettings(pageSize: 10)) -> SyncEngine {
		SyncEngine(api: server, store: store, settings: settings, now: { testNow })
	}

	private func ids(_ store: MailStore, _ folder: SystemFolder = .all) throws -> Set<String> {
		Set(try store.list(ListScope(folder: folder), limit: 1000, now: testNow).map(\.message.id))
	}

	@Test func `a first run stores the window and the mail is listed after the first page`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put((0..<25).map { mail("m\($0)", age: Double($0) * 60) })
		await server.put(mail("too-old", age: 31 * 86_400))
		let seenAtSecondPage = Mutex(0)
		await server.onSyncAnswer { call in
			if call == 2 { seenAtSecondPage.withLock { $0 = (try? store.list(ListScope(folder: .all), limit: 100, now: testNow).count) ?? -1 } }
		}
		let engine = engine(server, store)
		await engine.syncNow()
		#expect(seenAtSecondPage.withLock { $0 } == 10)
		#expect(try ids(store).count == 25)
		#expect(try !ids(store).contains("too-old"))
		#expect(await engine.currentStatus == .idle(last: testNow))
		#expect(try store.lastSync() == testNow)
		#expect(try store.mailboxTree().mailboxes.map(\.id) == ["box"])
		#expect(try store.mailboxTree().folders.map(\.id) == ["folder-box"])
		#expect(try store.mailboxTree().counts.folders["inbox"]?.total == 26)
	}

	@Test func `a second run asks only for changes and applies reads and removals`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put((0..<5).map { mail("m\($0)", age: Double($0) * 60) })
		let engine = engine(server, store)
		await engine.syncNow()
		await server.forgetCalls()

		await server.put(mail("m1", read: true, age: 60))
		await server.remove("m2")
		await server.put(mail("new", age: 1))
		await engine.syncNow()
		#expect(try ids(store) == ["m0", "m1", "m3", "m4", "new"])
		#expect(try store.message(id: "m1")?.row.read == true)
		let cursors = await server.syncCursors
		#expect(cursors.count == 1)
		#expect(cursors.first != .some(nil), "no fresh start")
	}

	@Test func `a reset from the server clears the store and resyncs without duplicates`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put((0..<12).map { mail("m\($0)", age: Double($0) * 60) })
		let engine = engine(server, store)
		await engine.syncNow()
		await server.remove("m3")
		await server.prune()
		await server.put(mail("after-prune", age: 2))
		await engine.syncNow()
		var expected = Set((0..<12).map { "m\($0)" })
		expected.remove("m3")
		expected.insert("after-prune")
		#expect(try ids(store) == expected, "the removal lost with the log is honoured by the fresh start")
		#expect(await engine.currentStatus == .idle(last: testNow))
	}

	@Test func `a revoked mailbox disappears and a newly shared one arrives with its window`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.setReadable(["box", "team"])
		await server.put([mail("mine", age: 10), mail("theirs", mailbox: "team", age: 20), mail("hidden", mailbox: "later", age: 30)])
		let engine = engine(server, store)
		await engine.syncNow()
		#expect(try ids(store) == ["mine", "theirs"])

		await server.setReadable(["box"])
		await engine.syncNow()
		#expect(try ids(store) == ["mine"])
		#expect(try store.mailboxTree().mailboxes.map(\.id) == ["box"])

		await server.setReadable(["box", "later"])
		await engine.syncNow()
		#expect(try ids(store) == ["mine", "hidden"])
	}

	@Test func `a run cut off after two pages resumes at the third`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put((0..<35).map { mail("m\(String(format: "%02d", $0))", age: Double($0) * 60) })
		await server.failSync(afterCalls: 2)
		let first = engine(server, store)
		await first.syncNow()
		#expect(await first.currentStatus == .failed(message: "interrupted"))
		#expect(try ids(store).count == 20, "what arrived stays")
		let resumeFrom = try #require(try store.cursor())

		await server.failSync(afterCalls: nil)
		await server.forgetCalls()
		let second = engine(server, store)
		await second.syncNow()
		#expect(await server.syncCursors.first == .some(resumeFrom))
		#expect(try ids(store).count == 35)
		#expect(await second.currentStatus == .idle(last: testNow))
	}

	@Test func `bodies are fetched for the window, newest first, a few at a time, and one failure does not stop the rest`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put((0..<30).map { mail("m\(String(format: "%02d", $0))", age: Double($0) * 60) })
		await server.failBodies(["m05"])
		let engine = engine(server, store, settings: SyncSettings(pageSize: 50))
		await engine.syncNow()
		let fetched = await server.bodyRequests
		#expect(Set(fetched).count == 30)
		#expect(fetched.filter { $0 == "m05" }.count == 1, "a failing body is not retried within the run")
		#expect(Set(fetched.prefix(20)) == Set((0..<20).map { "m\(String(format: "%02d", $0))" }), "the newest batch first")
		#expect(await server.maxConcurrentBodies <= 4)
		#expect(try store.message(id: "m00")?.body?.textBody == "Body of m00")
		#expect(try store.message(id: "m05")?.body == nil)
		#expect(try store.messagesNeedingBody(newerThan: .distantPast, limit: 50) == ["m05"])
		#expect(await engine.currentStatus == .idle(last: testNow))
	}

	@Test func `a body opened by hand is fetched once and then read from the store`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put(mail("far", age: 400 * 86_400))
		let engine = engine(server, store)
		#expect(try await engine.fetchBody(messageId: "far").body?.textBody == "Body of far")
		#expect(try await engine.fetchBody(messageId: "far").body?.textBody == "Body of far")
		#expect(await server.bodyRequests == ["far"])
		await #expect(throws: APIError.notFound) { try await engine.fetchBody(messageId: "missing") }
	}

	@Test func `mail that left the window keeps its row and loses its body`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		try store.apply(page([mail("aged", age: 45 * 86_400)], cursor: "0|30|-1"))
		try store.saveBody(MessageDetail(message: mail("aged", age: 45 * 86_400), body: MessageBody(textBody: "Old", htmlBody: nil)))
		await engine(server, store).syncNow()
		#expect(try store.message(id: "aged")?.row.id == "aged")
		#expect(try store.message(id: "aged")?.body == nil)
	}

	@Test(arguments: [(APIError.offline, SyncStatus.offline(last: nil)), (.accessDenied, .accessDenied), (.signedOut, .signedOut), (.decoding, .failed(message: nil))])
	func `a failed run reports why and leaves the stored mail alone`(failure: APIError, expected: SyncStatus) async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		try store.apply(page([mail("kept")], cursor: "0|30|-1"))
		await server.setFailure(failure)
		let engine = engine(server, store)
		await engine.syncNow()
		#expect(await engine.currentStatus == expected)
		#expect(try ids(store) == ["kept"])
		#expect(try store.cursor() == "0|30|-1")
	}

	@Test func `offline remembers when the mail was last brought up to date`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put(mail("a"))
		let engine = engine(server, store)
		await engine.syncNow()
		await server.setFailure(.offline)
		await engine.syncNow()
		#expect(await engine.currentStatus == .offline(last: testNow))
	}

	@Test func `two simultaneous requests make one pass over the server`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put((0..<5).map { mail("m\($0)", age: Double($0)) })
		let engine = engine(server, store)
		async let first: Void = engine.syncNow()
		async let second: Void = engine.syncNow()
		_ = await (first, second)
		#expect(await server.syncCursors.filter { $0 == nil }.count == 1)
		#expect(try ids(store).count == 5)
	}

	@Test func `status updates start with the current state and follow a run`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put(mail("a"))
		let engine = engine(server, store)
		var updates = await engine.statusUpdates().makeAsyncIterator()
		#expect(await updates.next() == .idle(last: nil))
		await engine.syncNow()
		#expect(await updates.next() == .syncing(firstRun: true))
		#expect(await updates.next() == .idle(last: testNow))
	}

	@Test func `a different offline window starts over with that window`() async throws {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put([mail("recent", age: 86_400), mail("older", age: 20 * 86_400)])
		await engine(server, store, settings: SyncSettings(days: 30)).syncNow()
		#expect(try ids(store) == ["recent", "older"])
		await engine(server, store, settings: SyncSettings(days: 7)).syncNow()
		#expect(try ids(store) == ["recent"])
	}
}
