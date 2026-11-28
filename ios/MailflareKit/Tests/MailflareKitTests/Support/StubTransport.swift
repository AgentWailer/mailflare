import Foundation
import Testing
import Synchronization
@testable import MailflareKit

/// Answers requests from a closure and records what was sent.
final class StubTransport: HTTPTransport {
	typealias Handler = @Sendable (URLRequest) throws -> (status: Int, headers: [String: String], body: Data)

	private let handler: Handler
	private let recorded = Mutex<[URLRequest]>([])

	init(_ handler: @escaping Handler) { self.handler = handler }

	var requests: [URLRequest] { recorded.withLock { $0 } }

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		recorded.withLock { $0.append(request) }
		let answer = try handler(request)
		let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers)!
		return (answer.body, response)
	}

	static func json(_ text: String, status: Int = 200) -> StubTransport {
		StubTransport { _ in (status, ["Content-Type": "application/json"], Data(text.utf8)) }
	}
}

enum Fixture {
	static func data(_ name: String) throws -> Data {
		let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
		return try Data(contentsOf: url)
	}

	static func transport(_ name: String) throws -> StubTransport {
		let body = try data(name)
		return StubTransport { _ in (200, ["Content-Type": "application/json; charset=utf-8"], body) }
	}
}

let testAccess = ServerAccess(baseURL: URL(string: "https://mail.example.test")!, accessClientId: "id.access", accessClientSecret: "secret")
