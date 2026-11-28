import Foundation
import Observation
import UIKit
import MailflareKit

/// What the composer is opened for.
enum ComposeIntent: Hashable, Identifiable {
	case new(to: [String] = [], subject: String = "", body: String = "")
	case reply(messageId: String, all: Bool)
	case forward(messageId: String)
	/// A draft kept on the server, as the Drafts list shows it.
	case serverDraft(id: String)
	/// A message written on this device that was put aside or refused.
	case outgoing(id: String)

	var id: Self { self }
}

/// An address a message can be sent from, and the mailbox it belongs to.
struct Sender: Hashable, Identifiable {
	let mailboxId: String
	let address: String
	var id: String { address }
}

/// One message being written.
@Observable
final class ComposeModel {
	enum AttachmentError: Error, Equatable { case tooLarge, tooMany, unreadable }

	/// The server takes ten files of about ten megabytes each.
	static let maxAttachments = 10
	static let maxAttachmentBytes = 10_000_000

	var to: [String] = []
	var cc: [String] = []
	var bcc: [String] = []
	var subject = ""
	var body = NSAttributedString(string: "")
	var from = ""
	var includesQuote = true
	private(set) var attachments: [OutgoingAttachment] = []
	private(set) var senders: [Sender] = []
	private(set) var isLoading = true
	private(set) var loadError: String?
	/// True when the original's attachments travel with a forward; they are copied on the server.
	private(set) var forwardsAttachments = false

	let session: AccountSession
	private let intent: ComposeIntent
	private let filesDirectory: URL
	private var id = UUID().uuidString.lowercased()
	private var quotedHTML: String?
	private var inReplyTo: String?
	private var references: String?
	private var threadId: String?
	private var forwardOfMessageId: String?
	private var serverDraftId: String?
	private var book: [RecipientCandidate] = []
	private var initialBody = ""
	private var createdAt = Date()

	init(intent: ComposeIntent, session: AccountSession, filesDirectory: URL? = nil) {
		self.intent = intent
		self.session = session
		self.filesDirectory = filesDirectory ?? (session.store.directory ?? FileManager.default.temporaryDirectory).appending(path: "outgoing", directoryHint: .isDirectory)
	}

	var hasQuote: Bool { quotedHTML != nil }

	private static let addressPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

	static func isValid(_ entry: String) -> Bool {
		MailAddress(entry).address.wholeMatch(of: addressPattern) != nil
	}

	var invalidRecipients: [String] { (to + cc + bcc).filter { !Self.isValid($0) } }

	var canSend: Bool { !to.isEmpty && invalidRecipients.isEmpty && !from.isEmpty && !isLoading }

	/// True once there is something worth keeping when the composer is closed.
	var hasContent: Bool {
		!to.isEmpty || !cc.isEmpty || !bcc.isEmpty || !subject.trimmingCharacters(in: .whitespaces).isEmpty || !attachments.isEmpty
			|| body.string.trimmingCharacters(in: .whitespacesAndNewlines) != initialBody.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	// MARK: Loading

	func load() async {
		defer { isLoading = false }
		let tree = (try? session.store.mailboxTree()) ?? MailboxTree()
		senders = tree.mailboxes.filter { $0.permission != "read_only" }.flatMap { mailbox in
			(mailbox.senderAddresses ?? [mailbox.address]).map { Sender(mailboxId: mailbox.id, address: $0) }
		}
		if let json = try? session.store.setting(SettingKey.recipientBook), let cached = try? JSONDecoder().decode([RecipientCandidate].self, from: Data(json.utf8)) { book = cached }
		refreshBook()
		from = senders.first?.address ?? ""

		do {
			switch intent {
			case .new(let to, let subject, let text):
				self.to = to
				self.subject = subject
				setBody(text + signatureText(for: from, tree: tree))
			case .reply(let messageId, let all):
				let original = try await session.engine.fetchBody(messageId: messageId)
				let row = original.row
				let own = senders.filter { $0.mailboxId == row.mailboxId }.map(\.address)
				chooseSender(for: row, tree: tree)
				let recipients = ReplyBuilder.recipients(for: row, ownAddresses: own.isEmpty ? [session.account.email] : own, all: all)
				to = recipients.to
				cc = recipients.cc
				subject = ReplyBuilder.replySubject(row.subject)
				(inReplyTo, references, threadId) = ReplyBuilder.threading(for: row)
				quotedHTML = ReplyBuilder.replyQuoteHTML(sender: row.fromAddr, sentAt: Presentation.current.fullDate(row.createdAt), text: original.body?.textBody, html: original.body?.htmlBody, phrases: phrases)
				setBody(signatureText(for: from, tree: tree))
			case .forward(let messageId):
				let original = try await session.engine.fetchBody(messageId: messageId)
				let row = original.row
				chooseSender(for: row, tree: tree)
				subject = ReplyBuilder.forwardSubject(row.subject)
				references = ReplyBuilder.threading(for: row).references
				threadId = row.threadId
				forwardOfMessageId = row.id
				forwardsAttachments = original.attachments.contains(where: \.isListed)
				quotedHTML = ReplyBuilder.forwardHTML(for: row, sentAt: Presentation.current.fullDate(row.createdAt), text: original.body?.textBody, html: original.body?.htmlBody, phrases: phrases)
				setBody(signatureText(for: from, tree: tree))
			case .serverDraft(let draftId):
				let draft = try await session.api.draft(id: draftId)
				serverDraftId = draft.id
				to = MailAddress.list(draft.toAddr).map(Self.entry)
				cc = MailAddress.list(draft.ccAddr ?? "").map(Self.entry)
				bcc = MailAddress.list(draft.bccAddr ?? "").map(Self.entry)
				subject = draft.subject ?? ""
				inReplyTo = draft.inReplyTo; references = draft.references; threadId = draft.threadId
				if let sender = senders.first(where: { $0.address.caseInsensitiveCompare(MailAddress(draft.fromAddr).address) == .orderedSame }) { from = sender.address }
				let split = QuoteSplitter.split(html: draft.htmlBody ?? "")
				quotedHTML = split.quoted.map { "\(QuoteSplitter.marker)\($0)</div>" }
				setBody(draft.htmlBody == nil ? (draft.textBody ?? "") : ReplyBuilder.plainText(fromHTML: split.visible))
				forwardsAttachments = !(draft.attachments ?? []).isEmpty
			case .outgoing(let outgoingId):
				guard let stored = try session.store.outgoing(id: outgoingId) else { throw APIError.notFound }
				restore(stored)
			}
		} catch let error as APIError {
			loadError = error.userMessage
		} catch {
			loadError = String(localized: "That did not work. Try again.")
		}
	}

	private var phrases: ReplyBuilder.Phrases {
		Locale.current.language.languageCode?.identifier == "de" ? .german : .english
	}

	private func setBody(_ text: String) {
		body = NSAttributedString(string: text, attributes: [.font: UIFont.preferredFont(forTextStyle: .body), .foregroundColor: UIColor.label])
		initialBody = text
	}

	/// The mailbox's signature as text, two lines below where the writing starts.
	private func signatureText(for address: String, tree: MailboxTree) -> String {
		guard let mailboxId = senders.first(where: { $0.address == address })?.mailboxId,
		      let signature = tree.mailboxes.first(where: { $0.id == mailboxId })?.signature else { return "" }
		let text = ReplyBuilder.plainText(fromHTML: signature)
		return text.isEmpty ? "" : "\n\n\(text)"
	}

	/// A reply comes from the address the original was written to, when that is one of the user's.
	private func chooseSender(for row: MessageRow, tree: MailboxTree) {
		let written = Set((MailAddress.list(row.toAddr) + MailAddress.list(row.ccAddr ?? "")).map { $0.address.lowercased() })
		let own = senders.filter { $0.mailboxId == row.mailboxId }
		if let match = own.first(where: { written.contains($0.address.lowercased()) }) ?? own.first { from = match.address }
	}

	// MARK: Recipients

	private func refreshBook() {
		let session = session
		Task { [weak self] in
			guard let fresh = try? await session.api.recipients() else { return }
			self?.book = fresh
			if let json = try? JSONEncoder().encode(fresh) { try? session.store.setSetting(SettingKey.recipientBook, String(decoding: json, as: UTF8.self)) }
		}
	}

	private static func folded(_ text: String) -> String {
		text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
	}

	/// People to offer while an address is typed, in the order the server ranked them.
	func suggestions(for typed: String) -> [RecipientCandidate] {
		let query = Self.folded(typed.trimmingCharacters(in: .whitespaces))
		guard !query.isEmpty else { return [] }
		let chosen = Set((to + cc + bcc).map { MailAddress($0).address.lowercased() })
		return Array(book.lazy.filter { candidate in
			guard !chosen.contains(candidate.email.lowercased()) else { return false }
			if Self.folded(candidate.email).hasPrefix(query) { return true }
			return Self.folded(candidate.name ?? "").split(whereSeparator: { !$0.isLetter && !$0.isNumber }).contains { $0.hasPrefix(query) }
		}.prefix(6))
	}

	/// How a suggested person is written into a recipient line.
	func entry(for candidate: RecipientCandidate) -> String {
		Self.entry(MailAddress(candidate.name.map { "\($0) <\(candidate.email)>" } ?? candidate.email))
	}

	private static func entry(_ address: MailAddress) -> String {
		address.name.map { "\($0) <\(address.address)>" } ?? address.address
	}

	// MARK: Attachments

	func attach(fileAt source: URL, type: String) throws {
		guard attachments.count < Self.maxAttachments else { throw AttachmentError.tooMany }
		guard let size = try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize else { throw AttachmentError.unreadable }
		guard size <= Self.maxAttachmentBytes else { throw AttachmentError.tooLarge }
		// The picked file may disappear; the message keeps a copy of its own.
		let folder = filesDirectory.appending(path: "\(id)/\(UUID().uuidString)", directoryHint: .isDirectory)
		try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
		let copy = folder.appending(path: source.lastPathComponent, directoryHint: .notDirectory)
		do { try FileManager.default.copyItem(at: source, to: copy) } catch { throw AttachmentError.unreadable }
		attachments.append(OutgoingAttachment(filename: source.lastPathComponent, type: type, file: copy))
	}

	func removeAttachment(_ attachment: OutgoingAttachment) {
		attachments.removeAll { $0 == attachment }
		try? FileManager.default.removeItem(at: attachment.file.deletingLastPathComponent())
	}

	// MARK: Keeping and sending

	private var sidecarKey: String { "compose.\(id)" }

	private struct Sidecar: Codable {
		var body: Data
		var quotedHTML: String?
		var includesQuote: Bool
	}

	private func message(state: OutgoingMessage.State) -> OutgoingMessage {
		let written = RichTextHTML.html(from: body)
		let html = written + (includesQuote ? quotedHTML ?? "" : "")
		let trimmedSubject = subject.trimmingCharacters(in: .whitespacesAndNewlines)
		return OutgoingMessage(
			id: id, mailboxId: senders.first { $0.address == from }?.mailboxId ?? "", from: from, to: to, cc: cc, bcc: bcc,
			// The server requires a subject.
			subject: trimmedSubject.isEmpty && state == .queued ? phrases.noSubject : trimmedSubject,
			html: html, text: ReplyBuilder.plainText(fromHTML: html), inReplyTo: inReplyTo, references: references, threadId: threadId,
			forwardOfMessageId: serverDraftId == nil ? forwardOfMessageId : nil, serverDraftId: serverDraftId, attachments: attachments, state: state, createdAt: createdAt
		)
	}

	private func store(_ state: OutgoingMessage.State) -> Bool {
		do {
			try session.store.saveOutgoing(message(state: state))
			// The editor's own state, so the message can be opened again as it was written.
			let rtf = (try? body.data(from: NSRange(location: 0, length: body.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])) ?? Data()
			if let json = try? JSONEncoder().encode(Sidecar(body: rtf, quotedHTML: quotedHTML, includesQuote: includesQuote)) {
				try? session.store.setSetting(sidecarKey, String(decoding: json, as: UTF8.self))
			}
			return true
		} catch {
			return false
		}
	}

	private func restore(_ stored: OutgoingMessage) {
		id = stored.id
		createdAt = stored.createdAt
		to = stored.to; cc = stored.cc; bcc = stored.bcc
		subject = stored.subject
		if senders.contains(where: { $0.address == stored.from }) { from = stored.from }
		inReplyTo = stored.inReplyTo; references = stored.references; threadId = stored.threadId
		forwardOfMessageId = stored.forwardOfMessageId
		serverDraftId = stored.serverDraftId
		attachments = stored.attachments.filter { FileManager.default.fileExists(atPath: $0.file.path) }
		if let json = try? session.store.setting(sidecarKey), let sidecar = try? JSONDecoder().decode(Sidecar.self, from: Data(json.utf8)),
		   let text = try? NSAttributedString(data: sidecar.body, options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil) {
			body = text
			quotedHTML = sidecar.quotedHTML
			includesQuote = sidecar.includesQuote
		} else {
			let split = QuoteSplitter.split(html: stored.html)
			quotedHTML = split.quoted.map { "\(QuoteSplitter.marker)\($0)</div>" }
			setBody(ReplyBuilder.plainText(fromHTML: split.visible))
		}
		initialBody = ""
	}

	/// Queues the message. It goes out with the sync that follows, or when there is a network again.
	func send() async -> Bool {
		guard canSend, store(.queued) else { return false }
		await session.engine.noteLocalChange()
		let engine = session.engine
		Task { await engine.syncNow() }
		return true
	}

	/// Puts the message aside on this device.
	func saveDraft() {
		_ = store(.draft)
	}

	/// Throws the message away, with its files.
	func discard() {
		try? session.store.deleteOutgoing(id: id)
		try? session.store.setSetting(sidecarKey, nil)
		try? FileManager.default.removeItem(at: filesDirectory.appending(path: id, directoryHint: .isDirectory))
		attachments = []
	}
}
