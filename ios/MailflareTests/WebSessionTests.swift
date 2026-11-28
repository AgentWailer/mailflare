import Foundation
import Testing
import MailflareKit
@testable import Mailflare

@Suite struct WebSessionTests {
	private let access = ServerAccess(baseURL: URL(string: "https://mail.example.test")!, accessClientId: "i", accessClientSecret: "s")

	@Test func `the session cookie is set for the installation only, secure and hidden from scripts`() throws {
		let cookie = try #require(WebSession.sessionCookie(access: access, token: "dev token/1"))
		#expect(cookie.name == "ep_session")
		#expect(cookie.value == "dev%20token%2F1")
		#expect(cookie.domain == "mail.example.test")
		#expect(cookie.path == "/")
		#expect(cookie.isSecure)
		#expect(cookie.isHTTPOnly)
	}

	@Test func `a plain http test server gets a cookie that is not marked secure`() throws {
		let local = ServerAccess(baseURL: URL(string: "http://localhost:3000")!, accessClientId: "i", accessClientSecret: "s")
		let cookie = try #require(WebSession.sessionCookie(access: local, token: "t"))
		#expect(cookie.domain == "localhost")
		#expect(!cookie.isSecure)
	}

	@Test func `only pages of the installation open inside the app`() {
		#expect(WebSession.isInstallation(URL(string: "https://mail.example.test/settings")!, access: access))
		#expect(WebSession.isInstallation(URL(string: "about:blank")!, access: access))
		#expect(!WebSession.isInstallation(URL(string: "https://evil.example/settings")!, access: access))
		#expect(!WebSession.isInstallation(URL(string: "https://mail.example.test.evil.example/")!, access: access))
		#expect(!WebSession.isInstallation(URL(string: "http://mail.example.test/")!, access: access), "a downgrade to http leaves the app")
		#expect(!WebSession.isInstallation(URL(string: "https://mail.example.test:8443/")!, access: access))
	}

	@Test func `each account keeps its web pages in a store of its own`() {
		#expect(WebSession.storeIdentifier(userId: "u1") == WebSession.storeIdentifier(userId: "u1"))
		#expect(WebSession.storeIdentifier(userId: "u1") != WebSession.storeIdentifier(userId: "u2"))
	}
}
