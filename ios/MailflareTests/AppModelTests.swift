import Foundation
import Testing
import MailflareKit
@testable import Mailflare

@MainActor @Suite struct AppModelTests {
	private let server = URL(string: "https://mail.example.test")!
	private let key = AccessKey(clientId: "id.access", clientSecret: "secret")

	@Test func `the phase follows what is stored`() async throws {
		let credentials = InMemoryCredentialStore()
		var (model, _) = makeModel(.signedIn(), credentials: credentials)
		await model.start()
		#expect(model.phase == .needsServer)

		try credentials.saveAccess(ServerAccess(baseURL: server, accessClientId: "id", accessClientSecret: "s"))
		(model, _) = makeModel(.signedIn(), credentials: credentials)
		await model.start()
		#expect(model.phase == .needsSignIn)

		try credentials.save(AccountCredentials(userId: "u1", email: "anna@example.test", name: "Anna", role: "user", sessionToken: "dev_u1"))
		(model, _) = makeModel(.signedIn(), credentials: credentials)
		await model.start()
		#expect(model.phase == .ready)
		#expect(model.session?.account.userId == "u1")
	}

	@Test func `setup walks from server to key to sign-in to ready`() async throws {
		let transport = RouteTransport.signedIn()
		let credentials = InMemoryCredentialStore()
		let (model, _) = makeModel(transport, credentials: credentials)
		await model.start()
		#expect(model.submitServer("mail.example.test") == true)
		#expect(model.phase == .needsAccessKey)
		await model.submitAccessKey(key)
		#expect(model.phase == .needsSignIn)
		#expect(try credentials.loadAccess() == ServerAccess(baseURL: server, accessClientId: "id.access", accessClientSecret: "secret"))
		await model.signIn(email: "anna@example.test", password: "pw")
		#expect(model.phase == .ready)
		#expect(model.errorMessage == nil)
		#expect(try credentials.accounts().map(\.userId) == ["u1"])
		let login = try #require(transport.requests.first { $0.url?.path == "/api/app/login" })
		let body = try JSONSerialization.jsonObject(with: try #require(login.httpBody)) as? [String: String]
		#expect(body?["deviceName"] == "Test iPhone")
	}

	@Test func `an address that is not one stays on the server step`() async {
		let (model, _) = makeModel(.signedIn())
		await model.start()
		#expect(model.submitServer("not a host") == false)
		#expect(model.phase == .needsServer)
		#expect(model.errorMessage != nil)
	}

	@Test func `a rejected access key stays on the key step and says why`() async throws {
		let transport = RouteTransport()
		transport.answerWithPage("/api/auth/me", status: 403)
		let credentials = InMemoryCredentialStore()
		let (model, _) = makeModel(transport, credentials: credentials)
		await model.start()
		_ = model.submitServer("mail.example.test")
		await model.submitAccessKey(key)
		#expect(model.phase == .needsAccessKey)
		#expect(model.errorMessage == APIError.accessDenied.userMessage)
		#expect(try credentials.loadAccess() == nil, "a key that does not work is not kept")

		transport.goOffline()
		await model.submitAccessKey(key)
		#expect(model.errorMessage == APIError.offline.userMessage)
		#expect(model.phase == .needsAccessKey)
	}

	@Test func `the second factor step appears only when the server asks for it`() async throws {
		let transport = RouteTransport.signedIn()
		transport.answer("/api/app/login", #"{"ok":true,"mfaRequired":true,"challengeToken":"challenge-1"}"#)
		transport.answer("/api/app/login/mfa", status: 401, #"{"error":"That code did not match"}"#)
		let (model, _) = makeModel(transport)
		await model.start()
		_ = model.submitServer("mail.example.test")
		await model.submitAccessKey(key)
		#expect(model.needsSecondFactor == false)
		await model.signIn(email: "anna@example.test", password: "pw")
		#expect(model.phase == .needsSignIn)
		#expect(model.needsSecondFactor == true)

		await model.submitSecondFactor(code: "000000")
		#expect(model.phase == .needsSignIn)
		#expect(model.errorMessage == "That code did not match")

		transport.answer("/api/app/login/mfa", #"{"ok":true,"token":"dev_u1","user":{"id":"u1","email":"anna@example.test","name":"Anna","role":"user"}}"#)
		await model.submitSecondFactor(code: "123456")
		#expect(model.phase == .ready)
		#expect(model.needsSecondFactor == false)
	}

	@Test func `wrong credentials keep the sign-in form with the server's reason`() async {
		let transport = RouteTransport.signedIn()
		transport.answer("/api/app/login", status: 401, #"{"error":"Invalid credentials"}"#)
		let (model, _) = makeModel(transport)
		await model.start()
		_ = model.submitServer("mail.example.test")
		await model.submitAccessKey(key)
		await model.signIn(email: "anna@example.test", password: "wrong")
		#expect(model.phase == .needsSignIn)
		#expect(model.errorMessage == APIError.server(status: 401, message: "Invalid credentials").userMessage)
	}

	private func twoAccounts() async throws -> (AppModel, InMemoryCredentialStore, URL, RouteTransport) {
		let transport = RouteTransport.signedIn()
		let credentials = InMemoryCredentialStore()
		try credentials.saveAccess(ServerAccess(baseURL: server, accessClientId: "id", accessClientSecret: "s"))
		try credentials.save(AccountCredentials(userId: "u1", email: "anna@example.test", name: "Anna", role: "user", sessionToken: "dev_u1"))
		try credentials.save(AccountCredentials(userId: "u2", email: "ben@example.test", name: "Ben", role: "admin", sessionToken: "dev_u2"))
		let (model, directory) = makeModel(transport, credentials: credentials)
		await model.start()
		return (model, credentials, directory, transport)
	}

	@Test func `switching accounts changes the session without signing in again and is remembered`() async throws {
		let (model, credentials, _, transport) = try await twoAccounts()
		#expect(model.session?.account.userId == "u1")
		await model.switchAccount(userId: "u2")
		#expect(model.session?.account.userId == "u2")
		#expect(!transport.paths().contains("/api/app/login"))
		#expect(model.accounts.map(\.userId) == ["u1", "u2"])
		_ = credentials
		#expect(model.activeUserIdForTesting == "u2")
	}

	@Test func `signing out one of two accounts keeps the other and deletes only its mail`() async throws {
		let (model, credentials, directory, transport) = try await twoAccounts()
		try model.session?.store.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [MessageRow(id: "m1", userId: "u1", mailboxId: "box", fromAddr: "a@b.test", toAddr: "c@d.test", createdAt: Date())]))
		await model.switchAccount(userId: "u2")
		try model.session?.store.setSetting("kept", "yes")
		await model.signOut(userId: "u1")
		#expect(try credentials.accounts().map(\.userId) == ["u2"])
		#expect(model.phase == .ready)
		#expect(model.session?.account.userId == "u2")
		#expect(try model.session?.store.setting("kept") == "yes")
		let logout = try #require(transport.requests.last { $0.url?.path == "/api/auth/logout" })
		#expect(logout.value(forHTTPHeaderField: "Authorization") == "Bearer dev_u1")
		let reopened = try MailStore.open(userId: "u1", directory: directory)
		#expect(try reopened.list(ListScope(folder: .all), limit: 10).isEmpty, "the signed-out account's mail is gone")
	}

	@Test func `signing out the last account returns to sign-in and works without a connection`() async throws {
		let transport = RouteTransport.signedIn()
		let credentials = InMemoryCredentialStore()
		try credentials.saveAccess(ServerAccess(baseURL: server, accessClientId: "id", accessClientSecret: "s"))
		try credentials.save(AccountCredentials(userId: "u1", email: "anna@example.test", name: "Anna", role: "user", sessionToken: "dev_u1"))
		let (model, _) = makeModel(transport, credentials: credentials)
		await model.start()
		transport.goOffline()
		await model.signOut(userId: "u1")
		#expect(model.phase == .needsSignIn)
		#expect(model.session == nil)
		#expect(try credentials.accounts().isEmpty)
		#expect(try credentials.loadAccess() != nil, "the access key stays for the next sign-in")
	}

	@Test func `a session the server ended wipes that account and says so`() async throws {
		let (model, credentials, directory, _) = try await twoAccounts()
		try model.session?.store.apply(SyncPage(cursor: "c", more: false, mailboxIds: ["box"], messages: [MessageRow(id: "m1", userId: "u1", mailboxId: "box", fromAddr: "a@b.test", toAddr: "c@d.test", createdAt: Date())]))
		await model.handleSignedOut(userId: "u1")
		#expect(try credentials.accounts().map(\.userId) == ["u2"])
		#expect(model.session?.account.userId == "u2")
		#expect(model.notice != nil)
		let reopened = try MailStore.open(userId: "u1", directory: directory)
		#expect(try reopened.list(ListScope(folder: .all), limit: 10).isEmpty)
	}

	@Test func `replacing the access key keeps accounts and mail`() async throws {
		let (model, credentials, _, _) = try await twoAccounts()
		await model.replaceAccessKey(AccessKey(clientId: "new.access", clientSecret: "new-secret"))
		#expect(try credentials.loadAccess()?.accessClientId == "new.access")
		#expect(model.session?.account.userId == "u1")
		#expect(model.session?.api.access.accessClientId == "new.access")
		#expect(try credentials.accounts().count == 2)
	}
}
