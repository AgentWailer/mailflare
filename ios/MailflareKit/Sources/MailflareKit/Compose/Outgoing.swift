import Foundation

/// What a draft or a send carries, as the server's draft and send routes take it.
public struct DraftPayload: Equatable, Sendable {
	public var mailboxId: String
	public var from: String
	public var to: [String]
	public var cc: [String]
	public var bcc: [String]
	public var subject: String
	public var html: String
	public var text: String
	public var inReplyTo: String?
	public var references: String?
	public var threadId: String?
	/// Copies this message's attachments onto the new draft.
	public var forwardOfMessageId: String?
}

/// A file attached to a message that is being written or waits to be sent.
public struct OutgoingAttachment: Codable, Equatable, Hashable, Sendable {
	public var filename: String
	public var type: String
	public var file: URL

	public init(filename: String, type: String, file: URL) {
		self.filename = filename
		self.type = type
		self.file = file
	}
}

/// A message the user wrote on this device: being written, waiting to be sent, or refused.
public struct OutgoingMessage: Codable, Equatable, Identifiable, Sendable {
	public enum State: Codable, Equatable, Sendable {
		case draft
		case queued
		case failed(reason: String)

		public enum Kind: String, Sendable { case draft, queued, failed }

		public var kind: Kind {
			switch self {
			case .draft: .draft
			case .queued: .queued
			case .failed: .failed
			}
		}
	}

	/// A UUID. It also makes creating the server's draft safe to repeat.
	public var id: String
	public var mailboxId: String
	public var from: String
	public var to: [String]
	public var cc: [String]
	public var bcc: [String]
	public var subject: String
	public var html: String
	public var text: String
	public var inReplyTo: String?
	public var references: String?
	public var threadId: String?
	public var forwardOfMessageId: String?
	/// The draft on the server this message is sent from, once there is one.
	public var serverDraftId: String?
	public var attachments: [OutgoingAttachment]
	public var state: State
	public var createdAt: Date

	public init(id: String, mailboxId: String, from: String, to: [String], cc: [String], bcc: [String], subject: String, html: String, text: String,
	            inReplyTo: String?, references: String?, threadId: String?, forwardOfMessageId: String?, serverDraftId: String?,
	            attachments: [OutgoingAttachment], state: State, createdAt: Date) {
		self.id = id; self.mailboxId = mailboxId; self.from = from; self.to = to; self.cc = cc; self.bcc = bcc
		self.subject = subject; self.html = html; self.text = text; self.inReplyTo = inReplyTo; self.references = references
		self.threadId = threadId; self.forwardOfMessageId = forwardOfMessageId; self.serverDraftId = serverDraftId
		self.attachments = attachments; self.state = state; self.createdAt = createdAt
	}

	public var payload: DraftPayload {
		DraftPayload(mailboxId: mailboxId, from: from, to: to, cc: cc, bcc: bcc, subject: subject, html: html, text: text,
		             inReplyTo: inReplyTo, references: references, threadId: threadId, forwardOfMessageId: forwardOfMessageId)
	}
}

/// Someone the composer suggests while an address is typed.
public struct RecipientCandidate: Codable, Equatable, Hashable, Sendable {
	public var email: String
	public var name: String?

	public init(email: String, name: String? = nil) {
		self.email = email
		self.name = name
	}
}

/// A draft kept on the server, with its content, as the composer opens it.
public struct ServerDraft: Decodable, Equatable, Sendable {
	public var id: String
	public var mailboxId: String?
	public var fromAddr: String
	public var toAddr: String
	public var ccAddr: String?
	public var bccAddr: String?
	public var subject: String?
	public var textBody: String?
	public var htmlBody: String?
	public var inReplyTo: String?
	public var references: String?
	public var threadId: String?
	public var attachments: [AttachmentInfo]?
}
