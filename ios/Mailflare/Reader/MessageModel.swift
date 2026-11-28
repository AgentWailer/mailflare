import Foundation
import Observation
import MailflareKit

/// One opened message: its head from the list at once, its content from the device or, when it
/// is not there yet, from the server.
@Observable
final class MessageModel {
	enum State: Equatable { case loading, ready, needsNetwork, failed(String) }

	private(set) var message: StoredMessage?
	private(set) var earlier: [MessageRow] = []
	private(set) var state: State = .loading
	private(set) var document: MailHTML.Document?
	private(set) var hasQuote = false
	var showsQuote = false { didSet { render() } }
	var allowsRemoteContent: Bool { didSet { render() } }
	var previewFile: URL?
	var attachmentError: String?
	private(set) var loadingAttachmentId: String?

	let messageId: String
	let session: AccountSession
	private var observation: Task<Void, Never>?
	private var inlineImages: [String: String] = [:]
	private var requestedBody = false
	/// Opening a message marks it read once. After that the user's own choice stands.
	private var markedRead = false
	/// Embedded pictures above this size are left out rather than held in memory as text.
	private static let inlineImageLimit = 2_000_000

	init(messageId: String, session: AccountSession) {
		self.messageId = messageId
		self.session = session
		allowsRemoteContent = (try? session.store.setting(SettingKey.externalContent)) == "1"
	}

	/// The attachments listed below the message; embedded pictures belong to the content.
	var attachments: [AttachmentInfo] { message?.attachments.filter(\.isListed) ?? [] }

	func start() {
		guard observation == nil else { return }
		let stream = session.store.observeMessage(id: messageId)
		observation = Task { [weak self] in
			for await stored in stream {
				guard let self else { return }
				await self.received(stored)
			}
		}
	}

	func stop() {
		observation?.cancel()
		observation = nil
	}

	private func received(_ stored: StoredMessage?) async {
		message = stored
		earlier = ((try? session.store.thread(of: messageId)) ?? []).filter { $0.id != messageId }
		if let stored, stored.body != nil {
			state = .ready
			render()
			if !markedRead {
				markedRead = true
				if !stored.row.read { await session.perform(.markRead(true), on: [messageId]) }
			}
			await loadInlineImages()
		} else if !requestedBody {
			requestedBody = true
			await fetchBody()
		}
	}

	/// Whether the account may move and delete in this message's mailbox.
	var canManage: Bool {
		MailActions.canManage(mailboxId: message?.row.mailboxId, in: (try? session.store.mailboxTree()) ?? MailboxTree())
	}

	func perform(_ action: MailAction) async {
		await session.perform(action, on: [messageId])
	}

	func retry() async {
		state = .loading
		await fetchBody()
	}

	private func fetchBody() async {
		do {
			// Storing the content makes the observation deliver it; nothing to do with the result here.
			_ = try await session.engine.fetchBody(messageId: messageId)
		} catch APIError.offline {
			state = .needsNetwork
		} catch let error as APIError {
			state = .failed(error.userMessage)
		} catch {
			state = .failed(String(localized: "That did not work. Try again."))
		}
	}

	private func render() {
		guard let message, let body = message.body else { return }
		var html = body.htmlBody
		if let source = html {
			let split = QuoteSplitter.split(html: source)
			hasQuote = split.quoted != nil
			if !showsQuote { html = split.visible }
		}
		document = MailHTML.document(html: html, text: body.textBody, snippet: message.row.snippet, allowRemoteContent: allowsRemoteContent, inlineImages: inlineImages)
	}

	/// Pictures embedded in the mail are attachments with a content id; they are put into the page as data.
	private func loadInlineImages() async {
		guard let message else { return }
		let embedded = message.attachments.filter { $0.contentId != nil && $0.type.hasPrefix("image/") && $0.size <= Self.inlineImageLimit && inlineImages[Self.contentId($0)] == nil }
		guard !embedded.isEmpty else { return }
		for attachment in embedded {
			guard let file = try? await session.engine.attachmentFile(attachment), let data = try? Data(contentsOf: file) else { continue }
			inlineImages[Self.contentId(attachment)] = "data:\(attachment.type);base64,\(data.base64EncodedString())"
		}
		render()
	}

	private static func contentId(_ attachment: AttachmentInfo) -> String {
		(attachment.contentId ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "<>"))
	}

	func open(_ attachment: AttachmentInfo) async {
		attachmentError = nil
		loadingAttachmentId = attachment.id
		defer { loadingAttachmentId = nil }
		do {
			previewFile = try await session.engine.attachmentFile(attachment)
		} catch let error as APIError {
			attachmentError = error.userMessage
			Haptics.play(.error)
		} catch {
			attachmentError = String(localized: "That did not work. Try again.")
			Haptics.play(.error)
		}
	}
}
