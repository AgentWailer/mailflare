import Foundation
import Synchronization
import Testing
@testable import MailflareKit

@Suite struct SyncEngineActionTests {
	private func setup(_ rows: [MessageRow]) async throws -> (FakeServer, MailStore, SyncEngine) {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		await server.put(rows)
		let engine = SyncEngine(api: server, store: store, settings: SyncSettings(pageSize: 50), now: { testNow })
		await engine.syncNow()
		await server.forgetCalls()
		return (server, store, engine)
	}

	@Test func `an action is on the device at once and on the server after the next run`() async throws {
		let (server, store, engine) = try await setup([mail("a"), mail("b")])
		await server.setFailure(.offline)
		await engine.perform(.archive, messageIds: ["a"])
		#expect(try store.message(id: "a")?.row.status == "archived", "shown without waiting for the server")
		#expect(try store.pendingOperations().count == 1)
		#expect(await server.messages["a"]?.status == "received")

		await server.setFailure(nil)
		await engine.syncNow()
		#expect(await server.messages["a"]?.status == "archived")
		#expect(try store.pendingOperations().isEmpty)
		#expect(try store.message(id: "a")?.row.status == "archived")
		#expect(await engine.currentStatus == .idle(last: testNow))
	}

	@Test func `every action reaches its route in the order it was taken`() async throws {
		let (server, _, engine) = try await setup([mail("a", status: "trash"), mail("b"), mail("c")])
		await server.setFailure(.offline)
		let until = testNow.addingTimeInterval(3600)
		for (action, ids) in [(MailAction.markRead(true), ["b", "c"]), (.markRead(false), ["b"]), (.star(true), ["b"]), (.archive, ["b"]), (.moveToInbox, ["b"]),
		                      (.moveToFolder("f1"), ["c"]), (.spam, ["c"]), (.trash, ["c"]), (.snooze(until: until), ["b"]), (.unsnooze, ["b"]), (.deletePermanently, ["a"])] {
			await engine.perform(action, messageIds: ids)
		}
		await server.setFailure(nil)
		await server.forgetCalls()
		await engine.syncNow()
		#expect(await server.actionCalls == ["read b,c", "unread b", "star:true b", "archive b", "inbox b", "folder:f1 c", "spam c", "trash c", "snooze b", "unsnooze b", "delete a"])
		#expect(await server.messages["a"] == nil)
	}

	@Test func `starring several messages sends one request each, because that route takes one`() async throws {
		let (server, _, engine) = try await setup([mail("a"), mail("b")])
		await engine.perform(.star(true), messageIds: ["a", "b"])
		await engine.syncNow()
		#expect(Set(await server.actionCalls) == ["star:true a", "star:true b"])
	}

	@Test func `without a connection the action waits and nothing is lost`() async throws {
		let (server, store, engine) = try await setup([mail("a")])
		await server.setFailure(.offline)
		await engine.perform(.trash, messageIds: ["a"])
		await engine.syncNow()
		await engine.syncNow()
		#expect(try store.pendingOperations().count == 1)
		#expect(try store.pendingOperations().first?.attempts == 0, "being offline is not a failed try")
		#expect(try store.message(id: "a")?.row.status == "trash")
		#expect(await engine.currentStatus == .offline(last: testNow))
	}

	@Test func `an action the server refuses is put back and reported`() async throws {
		let (server, store, engine) = try await setup([mail("a"), mail("b")])
		var failures = await engine.actionFailures().makeAsyncIterator()
		await server.failActions([.server(status: 403, message: "Forbidden"), nil])
		await engine.perform(.archive, messageIds: ["a"])
		await engine.perform(.star(true), messageIds: ["b"])
		await engine.syncNow()
		#expect(try store.message(id: "a")?.row.status == "received", "back where it was")
		#expect(try store.pendingOperations().isEmpty)
		#expect(await server.messages["b"]?.starred == true, "the next action still goes out")
		let failure = await failures.next()
		#expect(failure?.action == .archive)
		#expect(failure?.messageIds == ["a"])
		#expect(failure?.reason == "403 Forbidden")
	}

	@Test func `an action on a message that is gone is dropped quietly`() async throws {
		let (server, store, engine) = try await setup([mail("a")])
		await server.failActions([.notFound])
		await engine.perform(.archive, messageIds: ["a"])
		await engine.syncNow()
		#expect(try store.pendingOperations().isEmpty)
		#expect(await engine.currentStatus == .idle(last: testNow))
	}

	@Test func `a server error keeps the action for the next run, and the fifth one gives up`() async throws {
		let (server, store, engine) = try await setup([mail("a")])
		var failures = await engine.actionFailures().makeAsyncIterator()
		await engine.perform(.archive, messageIds: ["a"])
		for attempt in 1...4 {
			await server.failActions([.server(status: 503, message: nil)])
			await engine.syncNow()
			#expect(try store.pendingOperations().first?.attempts == attempt)
			#expect(try store.message(id: "a")?.row.status == "archived", "still shown as archived while it is retried")
		}
		await server.failActions([.rateLimited(retryAfter: 60)])
		await engine.syncNow()
		#expect(try store.pendingOperations().isEmpty)
		#expect(try store.message(id: "a")?.row.status == "received")
		#expect(await failures.next()?.reason == "429")
	}

	@Test func `a refused access key or a lost session stops the outbox without losing it`() async throws {
		for (failure, status) in [(APIError.accessDenied, SyncStatus.accessDenied), (.signedOut, .signedOut)] {
			let (server, store, engine) = try await setup([mail("a")])
			await engine.perform(.archive, messageIds: ["a"])
			await server.setFailure(failure)
			await engine.syncNow()
			#expect(await engine.currentStatus == status)
			#expect(try store.pendingOperations().count == 1)
		}
	}

	@Test func `an action taken while a sync is running goes out when that run ends`() async throws {
		let (server, store, engine) = try await setup([mail("a")])
		let entered = Mutex(false)
		await server.onSyncAnswer { _ in
			guard entered.withLock({ let first = !$0; $0 = true; return first }) else { return }
			// The user acts in the middle of the run.
			_ = try? store.perform(.archive, messageIds: ["a"])
			await engine.noteLocalChange()
		}
		await engine.syncNow()
		#expect(try store.pendingOperations().isEmpty)
		#expect(await server.messages["a"]?.status == "archived")
	}

	@Test func `what the server made of an action comes back with the following sync`() async throws {
		let (server, store, engine) = try await setup([mail("a")])
		await engine.perform(.archive, messageIds: ["a"])
		await engine.syncNow()
		// Someone else moves it back in the web.
		await server.put(mail("a", read: true))
		await engine.syncNow()
		#expect(try store.message(id: "a")?.row.status == "received")
		#expect(try store.message(id: "a")?.row.read == true)
	}
}
