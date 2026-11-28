import Foundation
import Testing
import MailflareKit
@testable import Mailflare

@MainActor @Suite struct MessageModelTests {
	private let detail = #"""
	{"message":{"id":"m1","userId":"u1","mailboxId":"box","direction":"inbound","category":"primary","fromAddr":"Anna <anna@example.org>","toAddr":"me@example.test","subject":"Hello","status":"received","read":false,"starred":false,"createdAt":"2026-11-27T10:00:00.000Z"},
	 "body":{"textBody":"Plain","htmlBody":"<p>Hello</p><img src=\"https://cdn.example/a.png\"><div class=\"mailflare-quote\" data-mailflare-quote=\"1\"><p>Earlier</p></div>"},
	 "attachments":[{"id":"a1","messageId":"m1","filename":"file.pdf","type":"application/pdf","size":10,"disposition":"attachment","contentId":null}],"unsubscribeUrl":null}
	"""#

	private func session(_ transport: RouteTransport) throws -> AccountSession {
		let access = ServerAccess(baseURL: URL(string: "https://mail.example.test")!, accessClientId: "i", accessClientSecret: "s")
		let account = AccountCredentials(userId: "u1", email: "me@example.test", name: "Me", role: "user", sessionToken: "dev_u1")
		let api = APIClient(access: access, sessionToken: "dev_u1", transport: transport)
		let store = try MailStore.inMemory()
		try store.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [
			MessageRow(id: "m0", userId: "u1", mailboxId: "box", fromAddr: "Anna <anna@example.org>", toAddr: "me@example.test", subject: "Hello", read: true, threadId: "t", createdAt: Date(timeIntervalSince1970: 1_795_000_000)),
			MessageRow(id: "m1", userId: "u1", mailboxId: "box", fromAddr: "Anna <anna@example.org>", toAddr: "me@example.test", subject: "Hello", threadId: "t", createdAt: Date(timeIntervalSince1970: 1_795_000_100)),
		]))
		return AccountSession(account: account, api: api, store: store, engine: SyncEngine(api: api, store: store))
	}

	private func settle(until condition: @MainActor () -> Bool) async throws {
		for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
		#expect(condition())
	}

	@Test func `opening a message whose content is not on the device fetches and keeps it`() async throws {
		let transport = RouteTransport.signedIn()
		transport.answer("/api/messages/m1", detail)
		let session = try session(transport)
		let model = MessageModel(messageId: "m1", session: session)
		model.start()
		try await settle { model.document != nil }
		#expect(model.state == .ready)
		#expect(model.message?.row.subject == "Hello")
		#expect(model.attachments.map(\.filename) == ["file.pdf"])
		#expect(try session.store.message(id: "m1")?.body?.textBody == "Plain")
		#expect(model.earlier.map(\.id) == ["m0"], "the rest of the conversation, without the open message")
	}

	@Test func `the quoted original is folded and remote pictures wait for the user`() async throws {
		let transport = RouteTransport.signedIn()
		transport.answer("/api/messages/m1", detail)
		let model = MessageModel(messageId: "m1", session: try session(transport))
		model.start()
		try await settle { model.document != nil }
		#expect(model.hasQuote == true)
		#expect(model.document?.html.contains("Earlier") == false)
		#expect(model.document?.blockedRemoteContent == true)
		#expect(model.document?.html.contains("cdn.example") == false)
		model.showsQuote = true
		#expect(model.document?.html.contains("Earlier") == true)
		model.allowsRemoteContent = true
		#expect(model.document?.html.contains("https://cdn.example/a.png") == true)
		#expect(model.document?.blockedRemoteContent == false)
	}

	@Test func `the account's external content setting is the default for every message`() async throws {
		let transport = RouteTransport.signedIn()
		transport.answer("/api/messages/m1", detail)
		let session = try session(transport)
		try session.store.setSetting(SettingKey.externalContent, "1")
		let model = MessageModel(messageId: "m1", session: session)
		model.start()
		try await settle { model.document != nil }
		#expect(model.document?.html.contains("https://cdn.example/a.png") == true)
	}

	@Test func `without a connection a message that is not on the device says so, and loads once there is one`() async throws {
		let transport = RouteTransport.signedIn()
		transport.answer("/api/messages/m1", detail)
		transport.goOffline()
		let model = MessageModel(messageId: "m1", session: try session(transport))
		model.start()
		try await settle { model.state == .needsNetwork }
		#expect(model.document == nil)
		#expect(model.message?.row.subject == "Hello", "the head from the list is shown meanwhile")
		transport.goOffline(false)
		await model.retry()
		try await settle { model.state == .ready && model.document != nil }
	}

	@Test func `a message that no longer exists says so`() async throws {
		let transport = RouteTransport.signedIn()
		let model = MessageModel(messageId: "m1", session: try session(transport))
		model.start()
		try await settle { model.state == .failed(APIError.notFound.userMessage) }
	}

	@Test func `an attachment is fetched when tapped and offered as a file`() async throws {
		let transport = RouteTransport.signedIn()
		transport.answer("/api/messages/m1", detail)
		transport.answer("/api/messages/m1/attachments/a1", "%PDF")
		let model = MessageModel(messageId: "m1", session: try session(transport))
		model.start()
		try await settle { !model.attachments.isEmpty }
		await model.open(model.attachments[0])
		#expect(model.previewFile?.lastPathComponent == "file.pdf")
		#expect(model.attachmentError == nil)
		transport.goOffline()
		model.previewFile = nil
		await model.open(AttachmentInfo(id: "a2", messageId: "m1", filename: "other.pdf", type: "application/pdf", size: 10))
		#expect(model.previewFile == nil)
		#expect(model.attachmentError == APIError.offline.userMessage)
	}

	@Test func `opening an unread message marks it read on the device and notes it for the server`() async throws {
		let transport = RouteTransport.signedIn()
		transport.answer("/api/messages/m1", detail)
		let session = try session(transport)
		let model = MessageModel(messageId: "m1", session: session)
		model.start()
		try await settle { model.document != nil && model.message?.row.read == true }
		try await settle { transport.bulkActions() == ["read m1"] }
	}

	@Test func `a message that was already read is not marked again, and marking unread by hand stays`() async throws {
		let transport = RouteTransport.signedIn()
		transport.answer("/api/messages/m1", detail)
		transport.goOffline()
		let session = try session(transport)
		try session.store.saveBody(MessageDetail(message: try #require(try session.store.message(id: "m0")?.row), body: MessageBody(textBody: "Earlier", htmlBody: nil)))
		let model = MessageModel(messageId: "m0", session: session)
		model.start()
		try await settle { model.document != nil }
		#expect(try session.store.pendingOperations().isEmpty, "m0 was read already")
		await model.perform(.markRead(false))
		try await settle { model.message?.row.read == false }
		try await Task.sleep(for: .milliseconds(100))
		#expect(model.message?.row.read == false, "the reader does not mark it read again behind the user's back")
	}

	@Test func `acting on a message from the reader changes it at once`() async throws {
		let transport = RouteTransport.signedIn()
		transport.answer("/api/messages/m1", detail)
		let session = try session(transport)
		let model = MessageModel(messageId: "m1", session: session)
		model.start()
		try await settle { model.document != nil }
		await model.perform(.star(true))
		try await settle { model.message?.row.starred == true }
		await model.perform(.archive)
		try await settle { model.message?.row.status == "archived" }
	}
}
