import Foundation

public struct MessageLabel: Codable, Equatable, Hashable, Sendable {
	public var id: String
	public var name: String
	public var color: String

	public init(id: String, name: String, color: String) {
		self.id = id
		self.name = name
		self.color = color
	}
}

/// A message as a list shows it. Bodies and attachments arrive with `MessageDetail`.
public struct MessageRow: Codable, Equatable, Hashable, Identifiable, Sendable {
	public var id: String
	public var userId: String
	public var mailboxId: String?
	public var direction: String
	public var providerMessageId: String?
	public var folderId: String?
	public var category: String
	public var fromAddr: String
	public var toAddr: String
	public var ccAddr: String?
	public var bccAddr: String?
	public var replyTo: String?
	public var subject: String?
	public var snippet: String?
	public var status: String
	public var read: Bool
	public var starred: Bool
	public var snoozedUntil: Date?
	public var threadId: String?
	public var inReplyTo: String?
	public var references: String?
	public var spamVerdict: String?
	public var trashedAt: Date?
	public var createdAt: Date
	public var attachmentCount: Int
	public var labels: [MessageLabel]
	public var fromContactName: String?
	public var toContactName: String?

	public init(
		id: String, userId: String, mailboxId: String?, direction: String = "inbound", providerMessageId: String? = nil,
		folderId: String? = nil, category: String = "primary", fromAddr: String, toAddr: String, ccAddr: String? = nil,
		bccAddr: String? = nil, replyTo: String? = nil, subject: String? = nil, snippet: String? = nil, status: String = "received",
		read: Bool = false, starred: Bool = false, snoozedUntil: Date? = nil, threadId: String? = nil, inReplyTo: String? = nil,
		references: String? = nil, spamVerdict: String? = nil, trashedAt: Date? = nil, createdAt: Date, attachmentCount: Int = 0,
		labels: [MessageLabel] = [], fromContactName: String? = nil, toContactName: String? = nil
	) {
		self.id = id; self.userId = userId; self.mailboxId = mailboxId; self.direction = direction
		self.providerMessageId = providerMessageId; self.folderId = folderId; self.category = category
		self.fromAddr = fromAddr; self.toAddr = toAddr; self.ccAddr = ccAddr; self.bccAddr = bccAddr; self.replyTo = replyTo
		self.subject = subject; self.snippet = snippet; self.status = status; self.read = read; self.starred = starred
		self.snoozedUntil = snoozedUntil; self.threadId = threadId; self.inReplyTo = inReplyTo; self.references = references
		self.spamVerdict = spamVerdict; self.trashedAt = trashedAt; self.createdAt = createdAt
		self.attachmentCount = attachmentCount; self.labels = labels
		self.fromContactName = fromContactName; self.toContactName = toContactName
	}

	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		id = try c.decode(String.self, forKey: .id)
		userId = try c.decode(String.self, forKey: .userId)
		mailboxId = try c.decodeIfPresent(String.self, forKey: .mailboxId)
		direction = try c.decode(String.self, forKey: .direction)
		providerMessageId = try c.decodeIfPresent(String.self, forKey: .providerMessageId)
		folderId = try c.decodeIfPresent(String.self, forKey: .folderId)
		category = try c.decodeIfPresent(String.self, forKey: .category) ?? "primary"
		fromAddr = try c.decode(String.self, forKey: .fromAddr)
		toAddr = try c.decode(String.self, forKey: .toAddr)
		ccAddr = try c.decodeIfPresent(String.self, forKey: .ccAddr)
		bccAddr = try c.decodeIfPresent(String.self, forKey: .bccAddr)
		replyTo = try c.decodeIfPresent(String.self, forKey: .replyTo)
		subject = try c.decodeIfPresent(String.self, forKey: .subject)
		snippet = try c.decodeIfPresent(String.self, forKey: .snippet)
		status = try c.decode(String.self, forKey: .status)
		read = try c.decode(Bool.self, forKey: .read)
		starred = try c.decode(Bool.self, forKey: .starred)
		snoozedUntil = try c.decodeIfPresent(Date.self, forKey: .snoozedUntil)
		threadId = try c.decodeIfPresent(String.self, forKey: .threadId)
		inReplyTo = try c.decodeIfPresent(String.self, forKey: .inReplyTo)
		references = try c.decodeIfPresent(String.self, forKey: .references)
		spamVerdict = try c.decodeIfPresent(String.self, forKey: .spamVerdict)
		trashedAt = try c.decodeIfPresent(Date.self, forKey: .trashedAt)
		createdAt = try c.decode(Date.self, forKey: .createdAt)
		attachmentCount = try c.decodeIfPresent(Int.self, forKey: .attachmentCount) ?? 0
		labels = try c.decodeIfPresent([MessageLabel].self, forKey: .labels) ?? []
		fromContactName = try c.decodeIfPresent(String.self, forKey: .fromContactName)
		toContactName = try c.decodeIfPresent(String.self, forKey: .toContactName)
	}

	/// The key conversations are grouped by: the thread, or the message itself when it has none.
	public var threadKey: String { threadId ?? id }
}

public struct MessageBody: Codable, Equatable, Sendable {
	public var textBody: String?
	public var htmlBody: String?

	public init(textBody: String?, htmlBody: String?) {
		self.textBody = textBody
		self.htmlBody = htmlBody
	}
}

public struct AttachmentInfo: Codable, Equatable, Hashable, Identifiable, Sendable {
	public var id: String
	public var messageId: String
	public var filename: String
	public var type: String
	public var size: Int
	public var disposition: String
	public var contentId: String?

	public init(id: String, messageId: String, filename: String, type: String, size: Int, disposition: String = "attachment", contentId: String? = nil) {
		self.id = id; self.messageId = messageId; self.filename = filename; self.type = type
		self.size = size; self.disposition = disposition; self.contentId = contentId
	}

	/// Shown in the attachment list; inline images belong to the body.
	public var isListed: Bool { disposition == "attachment" }
}

public struct MessageDetail: Codable, Equatable, Sendable {
	public var message: MessageRow
	public var body: MessageBody
	public var attachments: [AttachmentInfo]
	public var unsubscribeUrl: String?

	public init(message: MessageRow, body: MessageBody, attachments: [AttachmentInfo] = [], unsubscribeUrl: String? = nil) {
		self.message = message; self.body = body; self.attachments = attachments; self.unsubscribeUrl = unsubscribeUrl
	}

	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		message = try c.decode(MessageRow.self, forKey: .message)
		body = try c.decode(MessageBody.self, forKey: .body)
		attachments = try c.decodeIfPresent([AttachmentInfo].self, forKey: .attachments) ?? []
		unsubscribeUrl = try c.decodeIfPresent(String.self, forKey: .unsubscribeUrl)
	}
}

public struct MailboxInfo: Codable, Equatable, Hashable, Identifiable, Sendable {
	public var id: String
	public var userId: String
	public var localPart: String
	public var hostname: String
	public var displayName: String?
	public var type: String
	public var permission: String?
	public var isPrimary: Bool?
	public var signature: String?
	public var senderAddresses: [String]?

	public init(id: String, userId: String, localPart: String, hostname: String, displayName: String? = nil, type: String = "personal",
	            permission: String? = nil, isPrimary: Bool? = nil, signature: String? = nil, senderAddresses: [String]? = nil) {
		self.id = id; self.userId = userId; self.localPart = localPart; self.hostname = hostname; self.displayName = displayName
		self.type = type; self.permission = permission; self.isPrimary = isPrimary; self.signature = signature; self.senderAddresses = senderAddresses
	}

	public var address: String { "\(localPart)@\(hostname)" }
	public var isShared: Bool { type == "shared" }
}

public struct FolderInfo: Codable, Equatable, Hashable, Identifiable, Sendable {
	public var id: String
	public var mailboxId: String
	public var name: String
	public var parentId: String?
	public var color: String?

	public init(id: String, mailboxId: String, name: String, parentId: String? = nil, color: String? = nil) {
		self.id = id; self.mailboxId = mailboxId; self.name = name; self.parentId = parentId; self.color = color
	}
}

public struct FolderCount: Codable, Equatable, Hashable, Sendable {
	public var total: Int
	public var unread: Int

	public init(total: Int, unread: Int) {
		self.total = total
		self.unread = unread
	}
}

public struct MailboxCount: Codable, Equatable, Hashable, Sendable {
	public var mailboxId: String
	public var total: Int
	public var unread: Int
	public var inbox: Int
}

/// The server's own counts, which cover all mail and not just what is on the device.
public struct MailCounts: Codable, Equatable, Sendable {
	public var folders: [String: FolderCount]
	public var customFolders: [String: FolderCount]
	public var mailboxes: [MailboxCount]

	public init(folders: [String: FolderCount] = [:], customFolders: [String: FolderCount] = [:], mailboxes: [MailboxCount] = []) {
		self.folders = folders; self.customFolders = customFolders; self.mailboxes = mailboxes
	}

	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		folders = try c.decodeIfPresent([String: FolderCount].self, forKey: .folders) ?? [:]
		customFolders = try c.decodeIfPresent([String: FolderCount].self, forKey: .customFolders) ?? [:]
		mailboxes = try c.decodeIfPresent([MailboxCount].self, forKey: .mailboxes) ?? []
	}
}

/// One answer of the sync route.
public struct SyncPage: Codable, Equatable, Sendable {
	public var cursor: String
	public var more: Bool
	public var reset: Bool
	public var mailboxIds: [String]
	public var messages: [MessageRow]
	public var removed: [String]

	public init(cursor: String, more: Bool, reset: Bool = false, mailboxIds: [String], messages: [MessageRow] = [], removed: [String] = []) {
		self.cursor = cursor; self.more = more; self.reset = reset; self.mailboxIds = mailboxIds; self.messages = messages; self.removed = removed
	}
}

public struct UserInfo: Codable, Equatable, Sendable {
	public var id: String
	public var email: String
	public var name: String
	public var role: String
}

/// A device signed in to the account, as the server lists it.
public struct SignedInDevice: Codable, Equatable, Identifiable, Sendable {
	public var id: String
	public var name: String
	public var signedInAt: Date
	public var lastUsedAt: Date?
	/// True for the device that asked.
	public var current: Bool
}

public enum SignInResult: Equatable, Sendable {
	case signedIn(AccountCredentials)
	case secondFactor(challengeToken: String)
}
