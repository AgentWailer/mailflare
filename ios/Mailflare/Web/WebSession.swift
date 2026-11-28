import Foundation
import CryptoKit
import WebKit
import MailflareKit

/// What an in-app web page needs to be signed in like the app: the Mailflare session and the
/// Cloudflare Access cookie of this device's key.
enum WebSession {
	static func sessionCookie(access: ServerAccess, token: String) -> HTTPCookie? {
		guard let host = access.baseURL.host() else { return nil }
		var allowed = CharacterSet.alphanumerics
		allowed.insert(charactersIn: "-_.~")
		var properties: [HTTPCookiePropertyKey: Any] = [
			.name: "ep_session",
			.value: token.addingPercentEncoding(withAllowedCharacters: allowed) ?? token,
			.domain: host,
			.path: "/",
			HTTPCookiePropertyKey("HttpOnly"): "TRUE",
		]
		if access.baseURL.scheme == "https" { properties[.secure] = "TRUE" }
		return HTTPCookie(properties: properties)
	}

	/// True for addresses of the installation itself: same scheme, host and port.
	static func isInstallation(_ url: URL, access: ServerAccess) -> Bool {
		if url.absoluteString == "about:blank" { return true }
		return url.scheme == access.baseURL.scheme && url.host() == access.baseURL.host() && url.port == access.baseURL.port
	}

	/// A stable identifier for the account's own website data, so two accounts never share cookies.
	static func storeIdentifier(userId: String) -> UUID {
		let digest = Array(SHA256.hash(data: Data("mailflare-web-\(userId)".utf8)).prefix(16))
		return UUID(uuid: (digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
		                   digest[8], digest[9], digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]))
	}

	/// Signs the web pages of this account in. Throws when the installation cannot be reached.
	static func prepare(_ store: WKWebsiteDataStore, session: AccountSession) async throws {
		var cookies = try await session.api.accessCookies()
		if let cookie = sessionCookie(access: session.api.access, token: session.account.sessionToken) { cookies.append(cookie) }
		for cookie in cookies { await store.httpCookieStore.setCookie(cookie) }
	}
}
