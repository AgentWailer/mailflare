import Foundation
import Synchronization
import Testing
@testable import MailflareKit

/// Plays back what a server would send, then drops the connection.
final class ScriptedSocket: RealtimeSocket {
	private let script: Mutex<[String]>
	let sent = Mutex<[String]>([])
	let closed = Mutex(false)

	/// How long the connection stays open after the script has been played.
	let lingers: Duration

	init(_ messages: [String], lingers: Duration = .zero) {
		script = Mutex(messages)
		self.lingers = lingers
	}

	func receive() async throws -> String {
		let next: String? = script.withLock { $0.isEmpty ? nil : $0.removeFirst() }
		guard let next else {
			if lingers > .zero { try await Task.sleep(for: lingers) }
			throw URLError(.networkConnectionLost)
		}
		return next
	}

	func send(_ text: String) async throws { sent.withLock { $0.append(text) } }
	func close() { closed.withLock { $0 = true } }
}

@Suite struct RealtimeListenerTests {
	/// Runs the listener over the given connections and stops it when they are used up.
	private func run(_ sockets: [ScriptedSocket], pingInterval: Duration = .seconds(3600)) async -> (changes: Int, delays: [Duration], requests: [URLRequest]) {
		let remaining = Mutex(sockets)
		let requests = Mutex<[URLRequest]>([])
		let delays = Mutex<[Duration]>([])
		let changes = Mutex(0)
		let listener = RealtimeListener(
			access: testAccess, sessionToken: "dev_token",
			connect: { request in
				requests.withLock { $0.append(request) }
				return remaining.withLock { $0.isEmpty ? ScriptedSocket([]) : $0.removeFirst() }
			},
			sleep: { duration in
				delays.withLock { $0.append(duration) }
				if remaining.withLock({ $0.isEmpty }) { throw CancellationError() }
			},
			pingInterval: pingInterval
		)
		await listener.run { changes.withLock { $0 += 1 } }
		return (changes.withLock { $0 }, delays.withLock { $0 }, requests.withLock { $0 })
	}

	@Test func `new mail and a changed revision are reported, a ping answer and an unchanged revision are not`() async {
		let socket = ScriptedSocket([
			#"{"type":"new_message","messageId":"m1","mailboxId":"box"}"#,
			"pong",
			#"{"type":"revision","revision":"r1","changed":false}"#,
			#"{"type":"revision","revision":"r2","changed":true}"#,
			#"{"type":"agent_draft","id":"d1"}"#,
			"not json",
		])
		let result = await run([socket])
		#expect(result.changes == 2)
		#expect(socket.closed.withLock { $0 })
	}

	@Test func `the connection is opened as a WebSocket with the Access key and the bearer token`() async throws {
		let result = await run([ScriptedSocket([])])
		let request = try #require(result.requests.first)
		#expect(request.url?.absoluteString == "wss://mail.example.test/api/realtime")
		#expect(request.value(forHTTPHeaderField: "X-Mailflare-Session") == "dev_token")
		#expect(request.value(forHTTPHeaderField: "Authorization") == nil)
		#expect(request.value(forHTTPHeaderField: "CF-Access-Client-Id") == "id.access")
		#expect(request.value(forHTTPHeaderField: "CF-Access-Client-Secret") == "secret")
	}

	@Test func `it asks for the revision when it connects, so missed changes are noticed`() async {
		let socket = ScriptedSocket([#"{"type":"revision","revision":"r1","changed":false}"#])
		_ = await run([socket])
		#expect(socket.sent.withLock { $0 } == [#"{"type":"ping","revision":null}"#])
		let second = ScriptedSocket([])
		_ = await run([ScriptedSocket([#"{"type":"revision","revision":"r7","changed":false}"#]), second])
		#expect(second.sent.withLock { $0 } == [#"{"type":"ping","revision":"r7"}"#], "after a drop it asks with the last revision it saw")
	}

	@Test func `after a drop it waits longer each time, up to a minute, and starts over once it has heard from the server`() async {
		let failing = (0..<8).map { _ in ScriptedSocket([]) }
		let result = await run(failing)
		#expect(result.delays.prefix(8) == [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(16), .seconds(32), .seconds(60), .seconds(60)])

		let recovered = await run([ScriptedSocket([]), ScriptedSocket([]), ScriptedSocket(["pong"]), ScriptedSocket([])])
		#expect(recovered.delays.prefix(4) == [.seconds(1), .seconds(2), .seconds(1), .seconds(2)])
	}

	@Test func `while connected it keeps asking, always with the newest revision it has seen`() async {
		let socket = ScriptedSocket([#"{"type":"revision","revision":"r1","changed":false}"#], lingers: .milliseconds(150))
		let result = await run([socket], pingInterval: .milliseconds(20))
		let sent = socket.sent.withLock { $0 }
		#expect(sent.first == #"{"type":"ping","revision":null}"#)
		#expect(sent.count >= 3)
		#expect(sent.dropFirst().allSatisfy { $0 == #"{"type":"ping","revision":"r1"}"# })
		#expect(result.changes == 0)
	}
}
