import Foundation
import Testing
import MailflareKit
@testable import Mailflare

@MainActor @Suite struct MessageListModelTests {
	private func row(_ id: String, age: TimeInterval = 0, read: Bool = false, thread: String? = nil, status: String = "received") -> MessageRow {
		MessageRow(id: id, userId: "u1", mailboxId: "box", fromAddr: "a@example.test", toAddr: "me@example.test", subject: id, status: status, read: read, threadId: thread, createdAt: Date().addingTimeInterval(-age))
	}

	private func session(_ transport: RouteTransport) throws -> AccountSession {
		let access = ServerAccess(baseURL: URL(string: "https://mail.example.test")!, accessClientId: "i", accessClientSecret: "s")
		let account = AccountCredentials(userId: "u1", email: "anna@example.test", name: "Anna", role: "user", sessionToken: "dev_u1")
		let api = APIClient(access: access, sessionToken: "dev_u1", transport: transport)
		let store = try MailStore.inMemory()
		return AccountSession(account: account, api: api, store: store, engine: SyncEngine(api: api, store: store))
	}

	/// Waits until the model shows what the store holds; observation arrives on its own schedule.
	private func settle(_ model: MessageListModel, until condition: @MainActor () -> Bool) async throws {
		for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(10)) }
		#expect(condition())
	}

	@Test func `the list follows the store and the unread filter narrows it`() async throws {
		let session = try session(.signedIn())
		try session.store.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [row("a", age: 1), row("b", age: 2, read: true)]))
		let model = MessageListModel(scope: ListScope(folder: .inbox), session: session)
		model.start()
		try await settle(model) { model.items.map(\.id) == ["a", "b"] }
		model.unreadOnly = true
		try await settle(model) { model.items.map(\.id) == ["a"] }
		try session.store.apply(SyncPage(cursor: "c2", more: false, mailboxIds: ["box"], messages: [row("c", age: 0)]))
		try await settle(model) { model.items.map(\.id) == ["c", "a"] }
	}

	@Test func `the sync status is followed even when a setting was applied before the list appeared`() async throws {
		let session = try session(.signedIn())
		let model = MessageListModel(scope: ListScope(folder: .inbox, conversations: true), session: session)
		// The screen applies the stored conversation setting before it starts the model.
		model.conversations = false
		model.start()
		await session.engine.syncNow()
		try await settle(model) { if case .idle(last: .some) = model.status { true } else { false } }
	}

	@Test func `the conversation setting switches between threads and single messages`() async throws {
		let session = try session(.signedIn())
		try session.store.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [row("first", age: 20, thread: "t"), row("second", age: 10, thread: "t")]))
		let model = MessageListModel(scope: ListScope(folder: .inbox, conversations: true), session: session)
		model.start()
		try await settle(model) { model.items.map(\.id) == ["second"] }
		#expect(model.items.first?.threadCount == 2)
		model.conversations = false
		try await settle(model) { model.items.map(\.id) == ["second", "first"] }
	}

	@Test func `scrolling past what the device holds asks the server and keeps what arrives`() async throws {
		let transport = RouteTransport.signedIn()
		let older = (0..<3).map { #"{"id":"old\#($0)","userId":"u1","mailboxId":"box","direction":"inbound","category":"primary","fromAddr":"a@example.test","toAddr":"me@example.test","status":"received","read":true,"starred":false,"createdAt":"2026-01-0\#($0 + 1)T10:00:00.000Z"}"# }
		transport.answer("/api/messages", #"{"messages":[\#(older.joined(separator: ","))],"total":5}"#)
		let session = try session(transport)
		try session.store.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [row("a", age: 1), row("b", age: 2)]))
		let model = MessageListModel(scope: ListScope(mailboxId: "box", folder: .inbox), session: session)
		model.start()
		try await settle(model) { model.items.count == 2 }
		await model.loadOlder()
		try await settle(model) { model.items.count == 5 }
		#expect(model.olderState == .end, "fewer rows than asked for means there is nothing older")
		let request = try #require(transport.requests.last { $0.url?.path == "/api/messages" })
		let query = Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value ?? "") })
		#expect(query == ["direction": "inbound", "status": "received", "category": "primary", "mailboxId": "box", "offset": "2", "limit": "50"])
	}

	@Test func `without a connection the list says that older mail needs one`() async throws {
		let transport = RouteTransport.signedIn()
		let session = try session(transport)
		try session.store.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [row("a")]))
		let model = MessageListModel(scope: ListScope(folder: .inbox), session: session)
		model.start()
		try await settle(model) { model.items.count == 1 }
		transport.goOffline()
		await model.loadOlder()
		#expect(model.olderState == .needsNetwork)
		#expect(model.items.count == 1)
	}

	@Test func `the server filters of every folder match the web's`() {
		func filters(_ scope: ListScope) -> [String: String] { MessageListModel.serverFilters(for: scope) }
		#expect(filters(ListScope(folder: .inbox)) == ["direction": "inbound", "status": "received", "category": "primary"])
		#expect(filters(ListScope(folder: .invoices)) == ["direction": "inbound", "status": "received", "category": "invoices"])
		#expect(filters(ListScope(folder: .inbox, folderId: "f1")) == ["direction": "inbound", "status": "received", "folderId": "f1"])
		#expect(filters(ListScope(folder: .all)) == ["direction": "inbound"])
		#expect(filters(ListScope(folder: .starred)) == ["starred": "true"])
		#expect(filters(ListScope(folder: .snoozed)) == ["snoozed": "true"])
		#expect(filters(ListScope(folder: .sent)) == ["direction": "outbound", "status": "sent"])
		#expect(filters(ListScope(folder: .scheduled)) == ["direction": "outbound", "scheduled": "true"])
		#expect(filters(ListScope(folder: .drafts)) == ["direction": "outbound", "status": "draft"])
		#expect(filters(ListScope(folder: .archived)) == ["status": "archived"])
		#expect(filters(ListScope(folder: .spam, unreadOnly: true)) == ["status": "spam", "read": "unread"])
		#expect(filters(ListScope(folder: .inbox, conversations: true))["group"] == "thread")
		#expect(filters(ListScope(folder: .drafts, conversations: true))["group"] == nil)
	}
}
