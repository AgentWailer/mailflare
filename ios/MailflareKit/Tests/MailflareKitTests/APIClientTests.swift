import Foundation
import Testing
@testable import MailflareKit

@Suite struct APIClientTests {
	private func client(_ transport: StubTransport, token: String? = "dev_token") -> APIClient {
		APIClient(access: testAccess, sessionToken: token, transport: transport)
	}

	@Test func `every request carries the Access headers and the bearer token`() async throws {
		let transport = try Fixture.transport("mailboxes")
		_ = try await client(transport).mailboxes()
		let request = try #require(transport.requests.first)
		#expect(request.url?.absoluteString == "https://mail.example.test/api/mailboxes")
		#expect(request.value(forHTTPHeaderField: "CF-Access-Client-Id") == "id.access")
		#expect(request.value(forHTTPHeaderField: "CF-Access-Client-Secret") == "secret")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer dev_token")
		#expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
		#expect(request.value(forHTTPHeaderField: "Cookie") == nil)
	}

	@Test func `a request before sign-in sends no bearer token`() async throws {
		let transport = StubTransport.json(#"{"error":"Unauthorized"}"#, status: 401)
		try await client(transport, token: nil).checkAccess()
		#expect(transport.requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
	}

	@Test(arguments: [301, 302, 303, 307])
	func `a redirect from Cloudflare Access is accessDenied`(status: Int) async {
		let transport = StubTransport { _ in (status, ["Location": "https://team.cloudflareaccess.com/cdn-cgi/access/login"], Data()) }
		await #expect(throws: APIError.accessDenied) { try await client(transport).mailboxes() }
	}

	@Test func `a sign-in page answered with 200 is accessDenied, not a decoding failure`() async {
		let transport = StubTransport { _ in (200, ["Content-Type": "text/html; charset=UTF-8"], Data("<!DOCTYPE html><title>Sign in</title>".utf8)) }
		await #expect(throws: APIError.accessDenied) { try await client(transport).mailboxes() }
		await #expect(throws: APIError.accessDenied) { try await client(transport).checkAccess() }
	}

	@Test func `a 403 page from Access is accessDenied but a 403 from Mailflare is not`() async {
		let page = StubTransport { _ in (403, ["Content-Type": "text/html"], Data("<html>Forbidden</html>".utf8)) }
		await #expect(throws: APIError.accessDenied) { try await client(page).mailboxes() }
		let app = StubTransport.json(#"{"error":"Account disabled"}"#, status: 403)
		await #expect(throws: APIError.server(status: 403, message: "Account disabled")) { try await client(app).mailboxes() }
	}

	@Test func `Mailflare's own answers map to their cases`() async {
		await #expect(throws: APIError.signedOut) { try await client(.json(#"{"error":"Unauthorized"}"#, status: 401)).mailboxes() }
		await #expect(throws: APIError.notFound) { try await client(.json(#"{"error":"Not found"}"#, status: 404)).message(id: "m1") }
		await #expect(throws: APIError.server(status: 500, message: nil)) { try await client(.json("{}", status: 500)).mailboxes() }
		await #expect(throws: APIError.decoding) { try await client(.json(#"{"mailboxes": 7}"#)).mailboxes() }
		let limited = StubTransport { _ in (429, ["Content-Type": "application/json", "Retry-After": "60"], Data(#"{"error":"Too many"}"#.utf8)) }
		await #expect(throws: APIError.rateLimited(retryAfter: 60)) { try await client(limited).mailboxes() }
	}

	@Test func `no connection is offline`() async {
		for code in [URLError.notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotFindHost, .cannotConnectToHost, .dataNotAllowed] {
			let transport = StubTransport { _ in throw URLError(code) }
			await #expect(throws: APIError.offline) { try await client(transport).mailboxes() }
		}
	}

	@Test func `checkAccess accepts any JSON answer from Mailflare`() async throws {
		try await client(.json(#"{"error":"Unauthorized"}"#, status: 401), token: nil).checkAccess()
		try await client(try Fixture.transport("me")).checkAccess()
	}

	@Test func `sign-in returns credentials or asks for the second factor`() async throws {
		let ok = StubTransport.json(#"{"ok":true,"token":"dev_abc","user":{"id":"u1","email":"a@example.test","name":"Anna","role":"user"}}"#)
		let result = try await client(ok, token: nil).signIn(email: "a@example.test", password: "pw", deviceName: "iPhone")
		#expect(result == .signedIn(AccountCredentials(userId: "u1", email: "a@example.test", name: "Anna", role: "user", sessionToken: "dev_abc")))
		let request = try #require(ok.requests.first)
		#expect(request.httpMethod == "POST")
		#expect(request.url?.path == "/api/app/login")
		let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: String]
		#expect(body == ["email": "a@example.test", "password": "pw", "deviceName": "iPhone"])

		let mfa = StubTransport.json(#"{"ok":true,"mfaRequired":true,"challengeToken":"challenge-1"}"#)
		#expect(try await client(mfa, token: nil).signIn(email: "a@example.test", password: "pw", deviceName: "iPhone") == .secondFactor(challengeToken: "challenge-1"))

		let verified = StubTransport.json(#"{"ok":true,"token":"dev_xyz","method":"totp","user":{"id":"u1","email":"a@example.test","name":"Anna","role":"admin"}}"#)
		let credentials = try await client(verified, token: nil).verifySecondFactor(challengeToken: "challenge-1", code: "123456", deviceName: "iPhone")
		#expect(credentials.sessionToken == "dev_xyz")
		#expect(verified.requests.first?.url?.path == "/api/app/login/mfa")
	}

	@Test func `wrong credentials are reported with the server's words, not as a lost session`() async {
		let wrong = StubTransport.json(#"{"error":"Invalid credentials"}"#, status: 401)
		await #expect(throws: APIError.server(status: 401, message: "Invalid credentials")) {
			try await client(wrong, token: nil).signIn(email: "a@example.test", password: "x", deviceName: "iPhone")
		}
		let code = StubTransport.json(#"{"error":"That code did not match"}"#, status: 401)
		await #expect(throws: APIError.server(status: 401, message: "That code did not match")) {
			try await client(code, token: nil).verifySecondFactor(challengeToken: "c", code: "000000", deviceName: "iPhone")
		}
	}

	@Test func `sync sends cursor, days and limit and decodes a recorded page`() async throws {
		let transport = try Fixture.transport("sync-first")
		let page = try await client(transport).sync(cursor: "abc_-", days: 30, limit: 100)
		let url = try #require(transport.requests.first?.url)
		let query = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value) })
		#expect(url.path == "/api/app/sync")
		#expect(query == ["cursor": "abc_-", "days": "30", "limit": "100"])
		#expect(page.more == true)
		#expect(page.reset == false)
		#expect(page.mailboxIds == ["box", "shared"])
		#expect(!page.cursor.isEmpty)
		#expect(page.messages.count == 2)
		let first = try #require(page.messages.first { $0.id == "m1" })
		#expect(first.subject == "Termin am Donnerstag")
		#expect(first.fromAddr == "Anna Krüger <anna@example.org>")
		#expect(first.fromContactName == "Anna Krüger")
		#expect(first.read == false)
		#expect(first.starred == true)
		#expect(first.attachmentCount == 1)
		#expect(first.labels.map(\.id) == ["label"])
		#expect(first.threadId == "t1")
		#expect(first.createdAt.timeIntervalSinceNow > -86_400 * 3650)
	}

	@Test func `a first sync omits the cursor`() async throws {
		let transport = try Fixture.transport("sync-first")
		_ = try await client(transport).sync(cursor: nil, days: 30, limit: 100)
		#expect(transport.requests.first?.url?.query?.contains("cursor") == false)
	}

	@Test func `a row with unknown fields and missing optional ones still decodes`() async throws {
		let transport = StubTransport.json(#"""
		{"cursor":"c","more":false,"reset":false,"mailboxIds":["box"],"removed":["gone"],"futureField":{"a":1},
		 "messages":[{"id":"m9","userId":"u","mailboxId":"box","direction":"inbound","category":"primary","fromAddr":"a@b.test","toAddr":"c@d.test",
		  "status":"received","read":true,"starred":false,"createdAt":"2026-11-27T10:00:00.000Z","somethingNew":true}]}
		"""#)
		let page = try await client(transport).sync(cursor: nil, days: 30, limit: 10)
		let row = try #require(page.messages.first)
		#expect(row.subject == nil)
		#expect(row.labels.isEmpty)
		#expect(row.attachmentCount == 0)
		#expect(row.snoozedUntil == nil)
		#expect(page.removed == ["gone"])
	}

	@Test func `the detail, mailboxes, folders and counts of the real routes decode`() async throws {
		let detail = try await client(try Fixture.transport("message")).message(id: "m1")
		#expect(detail.message.id == "m1")
		#expect(detail.body.htmlBody?.contains("Unterlagen") == true)
		#expect(detail.body.textBody?.hasPrefix("Passt dir") == true)
		#expect(detail.attachments.map(\.filename) == ["Unterlagen.pdf"])
		#expect(detail.attachments.first?.size == 48213)
		#expect(detail.attachments.first?.type == "application/pdf")

		let mailboxes = try await client(try Fixture.transport("mailboxes")).mailboxes()
		#expect(mailboxes.map(\.id) == ["box", "shared"])
		#expect(mailboxes[0].address == "owner@example.test")
		#expect(mailboxes[0].isPrimary == true)
		#expect(mailboxes[1].type == "shared")

		let folders = try await client(try Fixture.transport("folders")).folders(mailboxId: "box")
		#expect(folders.map(\.name) == ["Work"])
		#expect(folders[0].color == "#2563eb")

		let counts = try await client(try Fixture.transport("counts")).counts(mailboxId: nil)
		#expect(counts.folders["inbox"] == FolderCount(total: 2, unread: 1))
		#expect(counts.customFolders["label"]?.unread == 1)
		#expect(counts.mailboxes.first { $0.mailboxId == "shared" }?.inbox == 1)

		let user = try await client(try Fixture.transport("me")).currentUser()
		#expect(user.email == "owner@example.test")
		#expect(user.role == "admin")
	}

	@Test func `the message list passes its filters through and decodes rows`() async throws {
		let transport = try Fixture.transport("list")
		let rows = try await client(transport).messages(filters: ["status": "received", "mailboxId": "box"], offset: 50, limit: 25)
		#expect(!rows.isEmpty)
		let url = try #require(transport.requests.first?.url)
		let query = Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value) })
		#expect(query == ["status": "received", "mailboxId": "box", "offset": "50", "limit": "25"])
	}

	@Test func `an attachment is saved to a file that keeps its name`() async throws {
		let transport = StubTransport { _ in (200, ["Content-Type": "application/pdf"], Data("%PDF-1.7".utf8)) }
		let file = try await client(transport).attachment(messageId: "m 1", attachmentId: "a/1", filename: "Unter/lagen.pdf")
		defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
		#expect(try Data(contentsOf: file) == Data("%PDF-1.7".utf8))
		#expect(file.lastPathComponent == "Unter_lagen.pdf")
		#expect(transport.requests.first?.url?.absoluteString == "https://mail.example.test/api/messages/m%201/attachments/a%2F1?download=1")
	}

	@Test func `a server address with a path or trailing slash still reaches the API`() async throws {
		let access = ServerAccess(baseURL: URL(string: "https://mail.example.test/")!, accessClientId: "i", accessClientSecret: "s")
		let transport = try Fixture.transport("mailboxes")
		_ = try await APIClient(access: access, sessionToken: "t", transport: transport).mailboxes()
		#expect(transport.requests.first?.url?.absoluteString == "https://mail.example.test/api/mailboxes")
	}
}
