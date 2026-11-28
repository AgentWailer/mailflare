import Foundation
import Observation
import MailflareKit

/// A search while it is typed: what the device holds at once, and after a pause what only the
/// server has, such as mail older than the device keeps.
@Observable
final class SearchModel {
	enum ServerState: Equatable { case idle, searching, done, needsNetwork, failed }

	private(set) var onDevice: [ListItem] = []
	private(set) var onServer: [ListItem] = []
	private(set) var serverState: ServerState = .idle
	private(set) var text = ""

	private let local: (String) -> [ListItem]
	private let remote: (String) async throws -> [MessageRow]
	private let pause: Duration
	private var task: Task<Void, Never>?
	static let limit = 50

	init(pause: Duration = .milliseconds(400), local: @escaping (String) -> [ListItem], remote: @escaping (String) async throws -> [MessageRow]) {
		self.pause = pause
		self.local = local
		self.remote = remote
	}

	convenience init(session: AccountSession, mailboxId: String?) {
		let store = session.store
		let api = session.api
		self.init(
			local: { (try? store.search($0, mailboxId: mailboxId, limit: Self.limit)) ?? [] },
			remote: { text in
				var filters = ["q": text]
				if let mailboxId { filters["mailboxId"] = mailboxId }
				return try await api.messages(filters: filters, offset: 0, limit: Self.limit)
			}
		)
	}

	var isSearching: Bool { !text.isEmpty }
	var isEmpty: Bool { onDevice.isEmpty && onServer.isEmpty }

	/// Called for every change of the search field.
	func search(_ typed: String) {
		let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
		guard text != self.text else { return }
		self.text = text
		task?.cancel()
		onServer = []
		guard !text.isEmpty else {
			onDevice = []
			serverState = .idle
			return
		}
		onDevice = local(text)
		serverState = .searching
		task = Task { [weak self, pause, remote] in
			// Not every keystroke is a question to the server.
			try? await Task.sleep(for: pause)
			guard !Task.isCancelled else { return }
			do {
				let rows = try await remote(text)
				guard let self, !Task.isCancelled, self.text == text else { return }
				// The device may have learnt of a message in the meantime; it is listed once.
				let known = Set(self.onDevice.map(\.id))
				self.onServer = rows.filter { !known.contains($0.id) }.map { ListItem(message: $0) }
				self.serverState = .done
			} catch {
				guard let self, !Task.isCancelled, self.text == text else { return }
				if case APIError.offline = error { self.serverState = .needsNetwork } else { self.serverState = .failed }
			}
		}
	}

	/// The device's own results again, after mail changed underneath them.
	func refreshLocal() {
		guard isSearching else { return }
		onDevice = local(text)
		let known = Set(onDevice.map(\.id))
		onServer.removeAll { known.contains($0.id) }
	}
}
