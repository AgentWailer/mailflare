import Foundation
import Synchronization
import MailflareKit
@testable import Mailflare

/// Answers by path, so a test reads as the conversation with the server it stands for.
final class RouteTransport: HTTPTransport {
	typealias Answer = (status: Int, body: String, html: Bool)
	private let routes = Mutex<[String: Answer]>([:])
	private let recorded = Mutex<[URLRequest]>([])
	private let failure = Mutex<URLError?>(nil)

	func answer(_ path: String, status: Int = 200, _ body: String) {
		routes.withLock { $0[path] = (status, body, false) }
	}

	func answerWithPage(_ path: String, status: Int = 200) {
		routes.withLock { $0[path] = (status, "<html>Sign in</html>", true) }
	}

	func goOffline(_ offline: Bool = true) {
		failure.withLock { $0 = offline ? URLError(.notConnectedToInternet) : nil }
	}

	var requests: [URLRequest] { recorded.withLock { $0 } }
	func paths() -> [String] { requests.compactMap { $0.url?.path } }

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		recorded.withLock { $0.append(request) }
		if let failure = failure.withLock({ $0 }) { throw failure }
		let path = request.url?.path ?? ""
		let answer = routes.withLock { $0[path] } ?? (404, #"{"error":"Not found"}"#, false)
		let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: "HTTP/1.1",
		                               headerFields: ["Content-Type": answer.html ? "text/html" : "application/json"])!
		return (Data(answer.body.utf8), response)
	}

	/// A server that accepts the key, signs the given user in and has no mail.
	static func signedIn(userId: String = "u1", email: String = "anna@example.test", role: String = "user") -> RouteTransport {
		let transport = RouteTransport()
		transport.answer("/api/auth/me", status: 401, #"{"error":"Unauthorized"}"#)
		transport.answer("/api/app/login", #"{"ok":true,"token":"dev_\#(userId)","user":{"id":"\#(userId)","email":"\#(email)","name":"Anna","role":"\#(role)"}}"#)
		transport.answer("/api/app/sync", #"{"cursor":"c","more":false,"reset":false,"mailboxIds":[],"messages":[],"removed":[]}"#)
		transport.answer("/api/mailboxes", #"{"mailboxes":[]}"#)
		transport.answer("/api/messages/counts", #"{"counts":{"folders":{},"customFolders":{},"mailboxes":[]}}"#)
		transport.answer("/api/auth/logout", #"{"ok":true}"#)
		return transport
	}
}

@MainActor
func makeModel(_ transport: RouteTransport, credentials: InMemoryCredentialStore = InMemoryCredentialStore()) -> (AppModel, URL) {
	let directory = FileManager.default.temporaryDirectory.appending(path: "mailflare-app-tests-\(UUID().uuidString)")
	let defaults = UserDefaults(suiteName: "mailflare-tests-\(UUID().uuidString)")!
	let model = AppModel(dependencies: AppDependencies(credentials: credentials, storeDirectory: directory, transport: transport, defaults: defaults, deviceName: "Test iPhone",
	                                                    removeWebData: { userId in removedWebData.withLock { $0.append(userId) } }))
	return (model, directory)
}

/// The accounts whose web data the model asked to remove, in order.
nonisolated let removedWebData = Mutex<[String]>([])
