import Foundation
import Observation
import MailflareKit

/// One list of mail on screen: what the device holds for a scope, kept current, with older
/// mail fetched from the server when the user scrolls past it.
@Observable
final class MessageListModel {
	enum OlderState: Equatable { case idle, loading, end, needsNetwork }

	private(set) var items: [ListItem] = []
	private(set) var status: SyncStatus = .idle(last: nil)
	private(set) var olderState: OlderState = .idle
	private(set) var hasLoaded = false

	var unreadOnly: Bool { didSet { if unreadOnly != oldValue { restart() } } }
	var conversations: Bool { didSet { if conversations != oldValue { restart() } } }

	let session: AccountSession
	private let base: ListScope
	private var limit = pageSize
	private var listTask: Task<Void, Never>?
	private var statusTask: Task<Void, Never>?
	private static let pageSize = 50

	init(scope: ListScope, session: AccountSession) {
		base = scope
		self.session = session
		unreadOnly = scope.unreadOnly
		conversations = scope.conversations
	}

	var scope: ListScope {
		var scope = base
		scope.unreadOnly = unreadOnly
		scope.conversations = conversations
		return scope
	}

	func start() {
		// A setting applied before the screen appears has already started the list; the status has its own guard.
		if listTask == nil { restart() }
		guard statusTask == nil else { return }
		let engine = session.engine
		statusTask = Task { [weak self] in
			for await status in await engine.statusUpdates() { self?.status = status }
		}
	}

	func stop() {
		listTask?.cancel()
		statusTask?.cancel()
		listTask = nil
		statusTask = nil
	}

	private func restart() {
		listTask?.cancel()
		olderState = .idle
		let stream = session.store.observeList(scope, limit: limit)
		listTask = Task { [weak self] in
			for await items in stream {
				self?.items = items
				self?.hasLoaded = true
			}
		}
	}

	func refresh() async {
		await session.engine.syncNow()
	}

	/// Called when the last row comes into view: first shows more of what the device holds,
	/// then asks the server for mail older than that.
	func loadOlder() async {
		guard olderState != .loading, olderState != .end else { return }
		if items.count >= limit {
			limit += Self.pageSize
			restart()
			return
		}
		olderState = .loading
		do {
			let rows = try await session.api.messages(filters: Self.serverFilters(for: scope), offset: items.count, limit: Self.pageSize)
			try session.store.upsert(rows)
			limit += rows.count
			restart()
			olderState = rows.count < Self.pageSize ? .end : .idle
		} catch APIError.offline {
			olderState = .needsNetwork
		} catch {
			olderState = .idle
		}
	}

	/// The parameters the web sends for the same list (`src/lib/messages/folder-params.ts`).
	static func serverFilters(for scope: ListScope) -> [String: String] {
		var filters: [String: String] = [:]
		switch scope.folder {
		case .inbox, .promotions, .social, .invoices, .orders:
			filters["direction"] = "inbound"
			filters["status"] = "received"
			if scope.folderId == nil { filters["category"] = scope.folder == .inbox ? "primary" : scope.folder.rawValue }
		case .all: filters["direction"] = "inbound"
		case .starred: filters["starred"] = "true"
		case .snoozed: filters["snoozed"] = "true"
		case .sent: filters["direction"] = "outbound"; filters["status"] = "sent"
		case .scheduled: filters["direction"] = "outbound"; filters["scheduled"] = "true"
		case .drafts: filters["direction"] = "outbound"; filters["status"] = "draft"
		case .archived, .spam, .trash: filters["status"] = scope.folder.rawValue
		}
		if let folderId = scope.folderId { filters["folderId"] = folderId }
		if let mailboxId = scope.mailboxId { filters["mailboxId"] = mailboxId }
		if scope.unreadOnly { filters["read"] = "unread" }
		if scope.conversations, scope.folder != .drafts { filters["group"] = "thread" }
		return filters
	}
}
