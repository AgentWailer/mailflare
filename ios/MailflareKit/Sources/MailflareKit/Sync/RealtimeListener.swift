import Foundation
import os

/// A WebSocket, reduced to what the listener needs, so a test can stand in for it.
public protocol RealtimeSocket: Sendable {
	func receive() async throws -> String
	func send(_ text: String) async throws
	func close()
}

/// Listens on the installation's realtime connection and says when the mail has changed, so the
/// app can sync without the user pulling. It only ever triggers a sync; it carries no mail.
public struct RealtimeListener: Sendable {
	public typealias Connect = @Sendable (URLRequest) -> any RealtimeSocket

	private let access: ServerAccess
	private let sessionToken: String
	private let connect: Connect
	private let sleep: @Sendable (Duration) async throws -> Void
	private let pingInterval: Duration

	public init(
		access: ServerAccess, sessionToken: String,
		connect: @escaping Connect = { URLSessionRealtimeSocket(request: $0) },
		sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
		pingInterval: Duration = .seconds(45)
	) {
		self.access = access
		self.sessionToken = sessionToken
		self.connect = connect
		self.sleep = sleep
		self.pingInterval = pingInterval
	}

	var request: URLRequest? {
		guard var components = URLComponents(url: access.baseURL, resolvingAgainstBaseURL: false) else { return nil }
		components.scheme = components.scheme == "http" ? "ws" : "wss"
		components.path = "/api/realtime"
		guard let url = components.url else { return nil }
		var request = URLRequest(url: url)
		request.setValue(sessionToken, forHTTPHeaderField: APIClient.sessionHeader)
		request.setValue(access.accessClientId, forHTTPHeaderField: "CF-Access-Client-Id")
		request.setValue(access.accessClientSecret, forHTTPHeaderField: "CF-Access-Client-Secret")
		return request
	}

	/// Stays connected until the surrounding task is cancelled, reconnecting after 1, 2, 4 … 60 seconds.
	public func run(onChange: @escaping @Sendable () async -> Void) async {
		guard let request else { return }
		var delay = 1
		// Shared with the task that pings, which must always ask with the newest revision.
		let revision = OSAllocatedUnfairLock<String?>(initialState: nil)
		while !Task.isCancelled {
			let socket = connect(request)
			var heard = false
			do {
				// Asking with the last revision seen makes the server say whether anything was missed.
				try await socket.send(Self.ping(revision.withLock { $0 }))
				let pinger = Task { [pingInterval] in
					while !Task.isCancelled {
						try await Task.sleep(for: pingInterval)
						try await socket.send(Self.ping(revision.withLock { $0 }))
					}
				}
				defer { pinger.cancel() }
				while true {
					let text = try await socket.receive()
					heard = true
					guard let message = try? JSONDecoder().decode(Message.self, from: Data(text.utf8)) else { continue }
					if let latest = message.revision { revision.withLock { $0 = latest } }
					if message.type == "new_message" || (message.type == "revision" && message.changed == true) { await onChange() }
				}
			} catch is CancellationError {
				socket.close()
				return
			} catch {
				socket.close()
			}
			if heard { delay = 1 }
			do { try await sleep(.seconds(delay)) } catch { return }
			delay = min(delay * 2, 60)
		}
	}

	private static func ping(_ revision: String?) -> String {
		let value = revision.map { "\"\($0.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\"" } ?? "null"
		return #"{"type":"ping","revision":\#(value)}"#
	}

	private struct Message: Decodable {
		let type: String
		let revision: String?
		let changed: Bool?

		enum CodingKeys: String, CodingKey { case type, revision, changed }

		init(from decoder: any Decoder) throws {
			let container = try decoder.container(keyedBy: CodingKeys.self)
			type = try container.decode(String.self, forKey: .type)
			// Other message kinds use `revision` for a number; only the string form is ours.
			revision = try? container.decode(String.self, forKey: .revision)
			changed = try? container.decode(Bool.self, forKey: .changed)
		}
	}
}

/// The real connection.
public final class URLSessionRealtimeSocket: RealtimeSocket {
	private let task: URLSessionWebSocketTask

	public init(request: URLRequest) {
		task = URLSession(configuration: .ephemeral).webSocketTask(with: request)
		task.resume()
	}

	public func receive() async throws -> String {
		switch try await task.receive() {
		case .string(let text): return text
		case .data(let data): return String(decoding: data, as: UTF8.self)
		@unknown default: return ""
		}
	}

	public func send(_ text: String) async throws {
		try await task.send(.string(text))
	}

	public func close() {
		task.cancel(with: .goingAway, reason: nil)
	}
}
