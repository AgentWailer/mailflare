import Foundation
import Testing
import MailflareKit
@testable import Mailflare

@MainActor @Suite(.serialized) struct NotificationTests {
	private let server = URL(string: "https://mail.example.test")!

	private func model(accounts: [String] = ["u1"], transport: RouteTransport = .signedIn()) async throws -> (AppModel, RouteTransport, URL) {
		let credentials = InMemoryCredentialStore()
		try credentials.saveAccess(ServerAccess(baseURL: server, accessClientId: "id", accessClientSecret: "s"))
		for id in accounts { try credentials.save(AccountCredentials(userId: id, email: "\(id)@example.test", name: id, role: "user", sessionToken: "dev_\(id)")) }
		transport.answer("/api/app/push", #"{"ok":true,"configured":true}"#)
		let (model, directory) = makeModel(transport, credentials: credentials)
		await model.start()
		return (model, transport, directory)
	}

	private func registrations(_ transport: RouteTransport) -> [String] {
		transport.requests.filter { $0.url?.path == "/api/app/push" && $0.httpMethod == "POST" }.compactMap { request in
			guard let data = request.httpBody, let body = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return nil }
			return "\(request.value(forHTTPHeaderField: "X-Mailflare-Session") ?? "?") \(body["token"] ?? "?") \(body["environment"] ?? "?")"
		}.sorted()
	}

	private func row(_ id: String) -> MessageRow {
		MessageRow(id: id, userId: "u1", mailboxId: "box", fromAddr: "a@example.test", toAddr: "me@example.test", subject: id, status: "received", read: false, createdAt: Date())
	}

	@Test func `the address Apple gives is registered for every signed-in account, once`() async throws {
		let (model, transport, _) = try await model(accounts: ["u1", "u2"])
		await model.pushTokenReceived("abc123")
		#expect(registrations(transport) == ["dev_u1 abc123 sandbox", "dev_u2 abc123 sandbox"])
		await model.pushTokenReceived("abc123")
		#expect(registrations(transport).count == 2, "the same address is not sent again")
		await model.pushTokenReceived("def456")
		#expect(registrations(transport).count == 4, "a new address is")
	}

	@Test func `an account that signs in later is registered with the address already known`() async throws {
		let (model, transport, _) = try await model(accounts: [])
		await model.pushTokenReceived("abc123")
		#expect(registrations(transport).isEmpty)
		await model.signIn(email: "anna@example.test", password: "pw")
		for _ in 0..<100 where registrations(transport).isEmpty { try await Task.sleep(for: .milliseconds(10)) }
		#expect(registrations(transport) == ["dev_u1 abc123 sandbox"])
	}

	@Test func `a registration that failed is tried again with the next address report`() async throws {
		let transport = RouteTransport.signedIn()
		let (model, _, _) = try await model(transport: transport)
		transport.answer("/api/app/push", status: 500, #"{"error":"x"}"#)
		await model.pushTokenReceived("abc123")
		transport.answer("/api/app/push", #"{"ok":true,"configured":true}"#)
		await model.pushTokenReceived("abc123")
		#expect(registrations(transport).count == 2)
	}

	@Test func `tapping a notification opens its message, switching to its account first`() async throws {
		let (model, _, _) = try await model(accounts: ["u1", "u2"])
		#expect(model.session?.account.userId == "u1")
		await model.openFromNotification(userId: "u2", messageId: "m9")
		#expect(model.session?.account.userId == "u2")
		#expect(model.messageToOpen == "m9")
		await model.openFromNotification(userId: "gone", messageId: "m1")
		#expect(model.messageToOpen == "m9", "a notification for an account that was signed out opens nothing")
	}

	@Test func `an action on a notification is applied on the device and sent, also for an account that is not on screen`() async throws {
		let (model, transport, directory) = try await model(accounts: ["u1", "u2"])
		try model.session?.store.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [row("m1")]))
		await model.performFromNotification(.archive, userId: "u1", messageId: "m1")
		#expect(try model.session?.store.message(id: "m1")?.row.status == "archived")
		for _ in 0..<100 where transport.bulkActions().isEmpty { try await Task.sleep(for: .milliseconds(10)) }
		#expect(transport.bulkActions() == ["archive m1"])

		// The other account's mail is not open; the action must not need the user to switch.
		let other = try MailStore.open(userId: "u2", directory: directory)
		var message = row("m2")
		message.userId = "u2"
		try other.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [message]))
		try other.close()
		await model.performFromNotification(.markRead(true), userId: "u2", messageId: "m2")
		#expect(model.session?.account.userId == "u1")
		let sent = transport.requests.last { $0.url?.path == "/api/messages/bulk" }
		#expect(sent?.value(forHTTPHeaderField: "X-Mailflare-Session") == "dev_u2")
		#expect(transport.bulkActions().contains("read m2"))
	}

	@Test func `the number at the icon follows the unread mail of the inbox`() async throws {
		let (model, _, _) = try await model()
		try model.session?.store.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [row("m1"), row("m2")]))
		model.updateBadge()
		#expect(badges.withLock { $0.last } == 2)
		await model.performFromNotification(.markRead(true), userId: "u1", messageId: "m1")
		#expect(badges.withLock { $0.last } == 1)
	}
}
