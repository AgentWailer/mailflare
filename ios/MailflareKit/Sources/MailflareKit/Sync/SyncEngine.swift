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
	/// Set when something was done on the device after the current run had passed the outbox.
	private var hasLocalChanges = false
	private var failureObservers: [UUID: AsyncStream<ActionFailure>.Continuation] = [:]
	/// A server error is tried again this often before the action is given up.
	private static let maxAttempts = 5
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
		let task = Task {
			// An action taken during a run is sent by another run right after it.
			for _ in 0..<4 {
				await self.run()
				guard self.hasLocalChanges else { return }
			}
		}
		running = task
		await task.value
		running = nil
	}

	// MARK: Actions

	/// Applies an action on the device at once and notes it for the server. The caller starts
	/// a sync to send it; a run that is already under way sends it when it ends.
	public func perform(_ action: MailAction, messageIds: [String]) {
		guard (try? store.perform(action, messageIds: messageIds, at: now())) != nil else { return }
		hasLocalChanges = true
	}

	/// Tells the engine that the store's outbox gained an entry it did not write itself.
	public func noteLocalChange() {
		hasLocalChanges = true
	}

	/// Actions the server refused, as they happen.
	public func actionFailures() -> AsyncStream<ActionFailure> {
		let id = UUID()
		let (stream, continuation) = AsyncStream<ActionFailure>.makeStream(bufferingPolicy: .unbounded)
		failureObservers[id] = continuation
		continuation.onTermination = { [weak self] _ in Task { await self?.removeFailureObserver(id) } }
		return stream
	}

	private func removeFailureObserver(_ id: UUID) { failureObservers[id] = nil }

	// MARK: Sending mail

	/// Sends the messages that wait to go out, oldest first. Each one becomes a draft on the
	/// server and is sent from it: the draft goes with the send, so trying again after a lost
	/// answer finds no draft and sends nothing a second time.
	private func sendOutgoing() async throws {
		for var message in try store.outgoingMessages(in: [.queued]) {
			try Task.checkCancellation()
			if let missing = message.attachments.first(where: { !FileManager.default.fileExists(atPath: $0.file.path) }) {
				message.state = .failed(reason: "attachment missing: \(missing.filename)")
				try store.saveOutgoing(message)
				continue
			}
			do {
				if let draftId = message.serverDraftId {
					// The draft exists from an earlier try or was opened from the server: bring it up to date.
					try await api.updateDraft(id: draftId, message.payload)
				} else {
					message.serverDraftId = try await api.createDraft(message.payload, requestId: message.id)
					try store.saveOutgoing(message)
				}
				try await api.send(message.payload, draftId: message.serverDraftId ?? "", attachments: message.attachments)
				try finishOutgoing(message)
			} catch {
				switch error {
				case APIError.offline, APIError.accessDenied, APIError.signedOut, is CancellationError:
					throw error
				case APIError.notFound:
					// The draft is gone: this message went out on an earlier try whose answer never arrived.
					try finishOutgoing(message)
				case APIError.server(let status, _) where (400..<500).contains(status) && status != 408:
					message.state = .failed(reason: Self.reason(for: error))
					try store.saveOutgoing(message)
				default:
					// A server error leaves the message waiting; the next run tries again, safely.
					continue
				}
			}
		}
	}

	private func finishOutgoing(_ message: OutgoingMessage) throws {
		try store.deleteOutgoing(id: message.id)
		for attachment in message.attachments { try? FileManager.default.removeItem(at: attachment.file) }
	}

	/// Sends what waits in the outbox, oldest first, before anything is pulled: the server must
	/// know what the user did before the device asks what changed.
	private func flushOutbox() async throws {
		for operation in try store.pendingOperations() {
			try Task.checkCancellation()
			do {
				try await send(operation)
				try store.completeOperation(operation.id)
			} catch {
				switch error {
				case APIError.offline, APIError.accessDenied, APIError.signedOut, is CancellationError:
					// Nothing is wrong with the action itself: it waits.
					throw error
				case APIError.notFound:
					// The message is gone on the server; the next pull removes it here too.
					try store.completeOperation(operation.id)
				case APIError.server(let status, _) where (400..<500).contains(status) && status != 408:
					try giveUp(operation, because: error)
				default:
					// A server error or a throttled request: the action stays and is tried again.
					guard try store.noteAttempt(operation.id) < Self.maxAttempts else {
						try giveUp(operation, because: error)
						continue
					}
					throw error
				}
			}
		}
	}

	private func giveUp(_ operation: PendingOperation, because error: any Error) throws {
		try store.revertOperation(operation.id)
		let failure = ActionFailure(action: operation.action, messageIds: operation.messageIds, reason: Self.reason(for: error))
		for observer in failureObservers.values { observer.yield(failure) }
	}

	private func send(_ operation: PendingOperation) async throws {
		let ids = operation.messageIds
		switch operation.action {
		case .markRead(let read): try await api.bulk(action: read ? "read" : "unread", messageIds: ids, folderId: nil)
		case .archive: try await api.bulk(action: "archive", messageIds: ids, folderId: nil)
		case .trash: try await api.bulk(action: "trash", messageIds: ids, folderId: nil)
		case .spam: try await api.bulk(action: "spam", messageIds: ids, folderId: nil)
		case .moveToInbox: try await api.bulk(action: "inbox", messageIds: ids, folderId: nil)
		case .moveToFolder(let folderId): try await api.bulk(action: "folder", messageIds: ids, folderId: folderId)
		case .deletePermanently: try await api.bulk(action: "delete", messageIds: ids, folderId: nil)
		case .star(let starred): try await each(ids) { try await self.api.star(messageId: $0, starred: starred) }
		case .snooze(let until): try await each(ids) { try await self.api.snooze(messageId: $0, until: until) }
		case .unsnooze: try await each(ids) { try await self.api.snooze(messageId: $0, until: nil) }
		}
	}

	/// For routes that take one message: a message that is gone does not hold up the others.
	private func each(_ ids: [String], _ call: (String) async throws -> Void) async throws {
		for id in ids {
			do { try await call(id) } catch APIError.notFound { continue }
		}
	}

	private func run() async {
		let firstRun = ((try? store.cursor()) ?? nil) == nil
		set(.syncing(firstRun: firstRun))
		hasLocalChanges = false
		do {
			try await sendOutgoing()
			try await flushOutbox()
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
		} catch is CancellationError {
			set(.idle(last: try? store.lastSync()))
		} catch {
			set(.failed(message: Self.reason(for: error)))
		}
	}

	/// A few words that tell one failure from another on the phone: the status the server gave
	/// and its own wording, or what kind of error it was on the device.
	static func reason(for error: any Error) -> String {
		switch error {
		case APIError.server(let status, let message):
			return [status > 0 ? String(status) : "sync did not settle", message].compactMap { $0 }.joined(separator: " ")
		case APIError.rateLimited: return "429"
		case APIError.notFound: return "404"
		case APIError.decoding: return "unreadable answer"
		default: return String(String(describing: type(of: error)).prefix(40))
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
