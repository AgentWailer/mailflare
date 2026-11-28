import Foundation

/// Brings the mail on this device up to date with the server: first the last days in pages,
/// afterwards only what changed, then the content of the mail inside the offline window.
public actor SyncEngine {
	private let api: any MailAPI
	private let store: MailStore
	private let settings: SyncSettings
	private let now: @Sendable () -> Date
	private let attachments: AttachmentCache?
	private let isOnWiFi: @Sendable () -> Bool

	private var running: Task<Void, Never>?
	private var observers: [UUID: AsyncStream<SyncStatus>.Continuation] = [:]
	public private(set) var currentStatus: SyncStatus

	private static let bodyBatch = 20
	private static let bodyConcurrency = 4
	/// More pages than any mailbox needs; a server that never stops saying "more" ends here.
	private static let pageCap = 5_000

	public init(
		api: any MailAPI, store: MailStore, settings: SyncSettings = SyncSettings(), attachments: AttachmentCache? = nil,
		isOnWiFi: @escaping @Sendable () -> Bool = { false }, now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.attachments = attachments
		self.isOnWiFi = isOnWiFi
		self.api = api
		self.store = store
		self.settings = settings
		self.now = now
		currentStatus = .idle(last: try? store.lastSync())
	}

	/// The current status first, then every change.
	public func statusUpdates() -> AsyncStream<SyncStatus> {
		let id = UUID()
		let (stream, continuation) = AsyncStream<SyncStatus>.makeStream(bufferingPolicy: .unbounded)
		continuation.yield(currentStatus)
		observers[id] = continuation
		continuation.onTermination = { [weak self] _ in Task { await self?.removeObserver(id) } }
		return stream
	}

	private func removeObserver(_ id: UUID) { observers[id] = nil }

	private func set(_ status: SyncStatus) {
		guard status != currentStatus else { return }
		currentStatus = status
		for observer in observers.values { observer.yield(status) }
	}

	/// Runs a sync, or joins the one that is running.
	public func syncNow() async {
		if let running {
			await running.value
			return
		}
		let task = Task { await self.run() }
		running = task
		await task.value
		running = nil
	}

	private func run() async {
		let firstRun = ((try? store.cursor()) ?? nil) == nil
		set(.syncing(firstRun: firstRun))
		do {
			try await pullChanges()
			try await refreshMailboxes()
			let windowStart = now().addingTimeInterval(-Double(settings.days) * 86_400)
			try await fetchBodies(newerThan: windowStart)
			try store.trimBodies(olderThan: windowStart)
			try await fetchAttachments(newerThan: windowStart)
			try attachments?.prune(keeping: try store.attachmentIds())
			try store.markSynced(at: now())
			set(.idle(last: now()))
		} catch APIError.offline {
			set(.offline(last: try? store.lastSync()))
		} catch APIError.accessDenied {
			set(.accessDenied)
		} catch APIError.signedOut {
			set(.signedOut)
		} catch APIError.server(_, let message) {
			set(.failed(message: message))
		} catch is CancellationError {
			set(.idle(last: try? store.lastSync()))
		} catch {
			set(.failed(message: nil))
		}
	}

	private func pullChanges() async throws {
		var resets = 0
		for _ in 0..<Self.pageCap {
			try Task.checkCancellation()
			let cursor = try store.cursor()
			let page = try await api.sync(cursor: cursor, days: settings.days, limit: settings.pageSize)
			// The server no longer knows where this device stands, or the account reads other
			// mailboxes than before: what is stored cannot be patched up, so start over.
			let mailboxesChanged = try cursor != nil && store.mailboxIds().map { $0 != page.mailboxIds.sorted() } == true
			if page.reset || mailboxesChanged {
				resets += 1
				guard resets <= 2 else { throw APIError.server(status: 0, message: nil) }
				try store.reset()
				continue
			}
			try store.apply(page)
			if !page.more { return }
		}
		throw APIError.server(status: 0, message: nil)
	}

	private func refreshMailboxes() async throws {
		let mailboxes = try await api.mailboxes()
		var folders: [FolderInfo] = []
		for mailbox in mailboxes { folders += try await api.folders(mailboxId: mailbox.id) }
		try store.replaceMailboxes(mailboxes, folders: folders, counts: try await api.counts(mailboxId: nil))
	}

	/// Fetches the content of the mail inside the window, newest first and a few at a time.
	/// A body that cannot be fetched is left for the next run; losing the connection ends this one.
	private func fetchBodies(newerThan windowStart: Date) async throws {
		var failed: Set<String> = []
		while true {
			try Task.checkCancellation()
			let waiting = try store.messagesNeedingBody(newerThan: windowStart, limit: Self.bodyBatch + failed.count)
			let batch = Array(waiting.filter { !failed.contains($0) }.prefix(Self.bodyBatch))
			if batch.isEmpty { return }
			let api = api
			let store = store
			let failures = try await withThrowingTaskGroup(of: String?.self) { group in
				var failures: [String] = []
				var next = batch.makeIterator()
				func add() {
					guard let id = next.next() else { return }
					group.addTask {
						do {
							try store.saveBody(try await api.message(id: id))
							return nil
						} catch APIError.offline {
							throw APIError.offline
						} catch APIError.accessDenied {
							throw APIError.accessDenied
						} catch APIError.signedOut {
							throw APIError.signedOut
						} catch is CancellationError {
							throw CancellationError()
						} catch {
							return id
						}
					}
				}
				for _ in 0..<Self.bodyConcurrency { add() }
				while let failure = try await group.next() {
					if let failure { failures.append(failure) }
					add()
				}
				return failures
			}
			failed.formUnion(failures)
		}
	}

	/// Fetches the smaller attachments of the mail inside the window so they open offline.
	/// Skipped off Wi-Fi unless the user allowed mobile data. One that fails waits for the next run.
	private func fetchAttachments(newerThan windowStart: Date) async throws {
		guard let attachments, settings.autoAttachmentBytes > 0, isOnWiFi() || !settings.attachmentsOnWiFiOnly else { return }
		for attachment in try store.attachments(newerThan: windowStart, maxBytes: settings.autoAttachmentBytes) where attachments.file(for: attachment) == nil {
			try Task.checkCancellation()
			do {
				_ = try await download(attachment, into: attachments)
			} catch APIError.offline {
				throw APIError.offline
			} catch APIError.accessDenied {
				throw APIError.accessDenied
			} catch APIError.signedOut {
				throw APIError.signedOut
			} catch is CancellationError {
				throw CancellationError()
			} catch {
				continue
			}
		}
	}

	private func download(_ attachment: AttachmentInfo, into cache: AttachmentCache) async throws -> URL {
		let downloaded = try await api.attachment(messageId: attachment.messageId, attachmentId: attachment.id, filename: attachment.filename)
		return try cache.store(downloaded, for: attachment)
	}

	/// The attachment as a file, from the device when it is there and from the server otherwise.
	public func attachmentFile(_ attachment: AttachmentInfo) async throws -> URL {
		if let file = attachments?.file(for: attachment) { return file }
		guard let attachments else {
			return try await api.attachment(messageId: attachment.messageId, attachmentId: attachment.id, filename: attachment.filename)
		}
		return try await download(attachment, into: attachments)
	}

	/// The message with its content, fetching the content when the device does not hold it yet.
	public func fetchBody(messageId: String) async throws -> StoredMessage {
		if let stored = try store.message(id: messageId), stored.body != nil { return stored }
		try store.saveBody(try await api.message(id: messageId))
		guard let stored = try store.message(id: messageId) else { throw APIError.notFound }
		return stored
	}
}
