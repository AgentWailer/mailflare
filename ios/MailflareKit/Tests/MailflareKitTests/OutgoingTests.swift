import Foundation
import Testing
@testable import MailflareKit

func outgoing(_ id: String = "11111111-1111-4111-8111-111111111111", to: [String] = ["anna@example.org"], subject: String = "Hallo", state: OutgoingMessage.State = .queued,
              attachments: [OutgoingAttachment] = [], forwardOf: String? = nil, serverDraftId: String? = nil) -> OutgoingMessage {
	OutgoingMessage(id: id, mailboxId: "box", from: "me@example.test", to: to, cc: [], bcc: [], subject: subject, html: "<p>Text</p>", text: "Text",
	                inReplyTo: nil, references: nil, threadId: nil, forwardOfMessageId: forwardOf, serverDraftId: serverDraftId, attachments: attachments,
	                state: state, createdAt: testNow)
}

@Suite struct OutgoingStoreTests {
	@Test func `a message being written is kept, changed and listed by its state`() throws {
		let store = try MailStore.inMemory()
		try store.saveOutgoing(outgoing("a", state: .draft))
		try store.saveOutgoing(outgoing("b", state: .queued))
		var changed = outgoing("a", subject: "Neu", state: .queued)
		changed.serverDraftId = "msg_1"
		try store.saveOutgoing(changed)
		#expect(try store.outgoing(id: "a")?.subject == "Neu")
		#expect(try store.outgoing(id: "a")?.serverDraftId == "msg_1")
		#expect(try store.outgoingMessages().map(\.id) == ["a", "b"])
		#expect(try store.outgoingMessages(in: [.draft]).isEmpty)
		try store.deleteOutgoing(id: "a")
		#expect(try store.outgoing(id: "a") == nil)
	}

	@Test func `what waits to be sent survives a reset of the synced mail`() throws {
		let store = try MailStore.inMemory()
		try store.saveOutgoing(outgoing("a"))
		try store.reset()
		#expect(try store.outgoingMessages().count == 1, "a message the user wrote is never thrown away by a sync")
	}

	@Test func `the list of waiting messages is observed`() async throws {
		let store = try MailStore.inMemory()
		var iterator = store.observeOutgoing().makeAsyncIterator()
		#expect(await iterator.next()?.isEmpty == true)
		try store.saveOutgoing(outgoing("a"))
		#expect(await iterator.next()?.map(\.id) == ["a"])
	}
}

@Suite struct OutgoingEngineTests {
	private func setup() async throws -> (FakeServer, MailStore, SyncEngine) {
		let server = FakeServer()
		let store = try MailStore.inMemory()
		let engine = SyncEngine(api: server, store: store, settings: SyncSettings(pageSize: 50), now: { testNow })
		await engine.syncNow()
		await server.forgetCalls()
		return (server, store, engine)
	}

	@Test func `a queued message becomes a draft on the server, is sent from it, and leaves the device`() async throws {
		let (server, store, engine) = try await setup()
		try store.saveOutgoing(outgoing())
		await engine.noteLocalChange()
		await engine.syncNow()
		#expect(await server.sent.map(\.subject) == ["Hallo"])
		#expect(await server.sent.first?.to == ["anna@example.org"])
		#expect(await server.composeCalls == ["draft 11111111-1111-4111-8111-111111111111", "send msg_11111111-1111-4111-8111-111111111111"])
		#expect(try store.outgoingMessages().isEmpty)
	}

	@Test func `a send whose answer was lost is not sent twice`() async throws {
		let (server, store, engine) = try await setup()
		try store.saveOutgoing(outgoing())
		// The server sends the mail, but the device never hears of it.
		await server.loseNextSendAnswer()
		await engine.syncNow()
		#expect(await server.sent.count == 1)
		#expect(try store.outgoingMessages().count == 1, "still waiting, because the answer never came")
		#expect(try store.outgoingMessages().first?.serverDraftId != nil, "the draft it was sent from is remembered")
		await engine.syncNow()
		#expect(await server.sent.count == 1, "the draft is gone on the server, so nothing is sent again")
		#expect(try store.outgoingMessages().isEmpty)
	}

	@Test func `a draft whose creation answer was lost is found again instead of made twice`() async throws {
		let (server, store, engine) = try await setup()
		try store.saveOutgoing(outgoing())
		await server.loseNextDraftAnswer()
		await engine.syncNow()
		#expect(await server.sent.isEmpty)
		await engine.syncNow()
		#expect(await server.sent.count == 1)
		#expect(await server.draftCount == 0)
		#expect(await server.composeCalls.filter { $0.hasPrefix("draft") }.count == 2)
	}

	@Test func `without a connection the message waits`() async throws {
		let (server, store, engine) = try await setup()
		try store.saveOutgoing(outgoing())
		await server.setFailure(.offline)
		await engine.syncNow()
		#expect(try store.outgoingMessages().first?.state == .queued)
		await server.setFailure(nil)
		await engine.syncNow()
		#expect(await server.sent.count == 1)
	}

	@Test func `a message the server refuses stays in the outbox with the reason, and does not hold up the next one`() async throws {
		let (server, store, engine) = try await setup()
		try store.saveOutgoing(outgoing("11111111-1111-4111-8111-111111111111", subject: "Refused"))
		try store.saveOutgoing(outgoing("22222222-2222-4222-8222-222222222222", subject: "Fine"))
		await server.refuseSend(subject: "Refused", with: .server(status: 422, message: "Sending is not enabled for this domain"))
		await engine.syncNow()
		#expect(await server.sent.map(\.subject) == ["Fine"])
		let left = try #require(try store.outgoingMessages().first)
		#expect(left.state == .failed(reason: "422 Sending is not enabled for this domain"))
		await engine.syncNow()
		#expect(await server.composeCalls.filter { $0.hasPrefix("send") }.count == 2, "a failed message is not retried by itself")
	}

	@Test func `drafts and messages being written are not sent`() async throws {
		let (server, store, engine) = try await setup()
		try store.saveOutgoing(outgoing(state: .draft))
		await engine.syncNow()
		#expect(await server.sent.isEmpty)
		#expect(await server.composeCalls.isEmpty)
	}

	@Test func `a forward is made from its original on the server, once`() async throws {
		let (server, store, engine) = try await setup()
		try store.saveOutgoing(outgoing(forwardOf: "m-original"))
		await server.loseNextSendAnswer()
		await engine.syncNow()
		await engine.syncNow()
		#expect(await server.composeCalls.filter { $0.hasPrefix("forward-draft") } == ["forward-draft m-original"], "the draft that copies the attachments is made only once")
		#expect(await server.sent.count == 1)
	}

	@Test func `a message that started from a server draft is sent from that draft`() async throws {
		let (server, store, engine) = try await setup()
		await server.addDraft(id: "msg_existing")
		try store.saveOutgoing(outgoing(serverDraftId: "msg_existing"))
		await engine.syncNow()
		#expect(await server.composeCalls == ["update msg_existing", "send msg_existing"])
		#expect(await server.sent.count == 1)
	}

	@Test func `attachments travel with the send and their files are removed afterwards`() async throws {
		let (server, store, engine) = try await setup()
		let file = FileManager.default.temporaryDirectory.appending(path: "mailflare-att-\(UUID().uuidString).txt")
		try Data("hello".utf8).write(to: file)
		try store.saveOutgoing(outgoing(attachments: [OutgoingAttachment(filename: "note.txt", type: "text/plain", file: file)]))
		await engine.syncNow()
		#expect(await server.sent.first?.attachments == ["note.txt:5"])
		#expect(!FileManager.default.fileExists(atPath: file.path))
	}

	@Test func `a message whose attachment file is gone is reported, not sent without it`() async throws {
		let (server, store, engine) = try await setup()
		let missing = FileManager.default.temporaryDirectory.appending(path: "mailflare-missing-\(UUID().uuidString)")
		try store.saveOutgoing(outgoing(attachments: [OutgoingAttachment(filename: "gone.pdf", type: "application/pdf", file: missing)]))
		await engine.syncNow()
		#expect(await server.sent.isEmpty)
		if case .failed = try store.outgoingMessages().first?.state {} else { Issue.record("expected a failed state") }
	}
}
