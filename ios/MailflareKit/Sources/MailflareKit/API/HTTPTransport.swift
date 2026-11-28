import Foundation

/// The network, reduced to what the client needs, so tests can stand in for it.
public protocol HTTPTransport: Sendable {
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// `URLSession` without cookies, without a cache and without following redirects: a redirect
/// here means Cloudflare Access wants an interactive sign-in, which the caller must see.
public struct URLSessionTransport: HTTPTransport {
	private let session: URLSession

	public init() {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.httpCookieStorage = nil
		configuration.httpShouldSetCookies = false
		configuration.urlCache = nil
		configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
		configuration.timeoutIntervalForRequest = 30
		configuration.waitsForConnectivity = false
		session = URLSession(configuration: configuration, delegate: RedirectRefuser(), delegateQueue: nil)
	}

	public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let (data, response) = try await session.data(for: request)
		guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
		return (data, http)
	}
}

private final class RedirectRefuser: NSObject, URLSessionTaskDelegate {
	func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
		nil
	}
}
