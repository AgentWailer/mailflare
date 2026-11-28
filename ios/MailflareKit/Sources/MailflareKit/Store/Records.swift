import Foundation
import GRDB

/// The fixed lists of a mailbox, named as the web app names them.
public enum SystemFolder: String, CaseIterable, Codable, Hashable, Sendable {
	case inbox, promotions, social, invoices, orders
	case starred, snoozed, scheduled, sent, drafts, archived, spam, trash, all

	/// The categories shown as a row above the inbox.
	public static let categories: [SystemFolder] = [.inbox, .invoices, .orders, .promotions, .social]

	public var isCategory: Bool { Self.categories.contains(self) }
}

/// Which messages a list shows.
public struct ListScope: Codable, Hashable, Sendable {
	/// One mailbox, or every mailbox the account can read.
	public var mailboxId: String?
	public var folder: SystemFolder
	/// A folder or label of the user's own. Takes the place of the category within `folder`.
	public var folderId: String?
	public var unreadOnly: Bool
	/// One row per conversation instead of one per message.
	public var conversations: Bool

	public init(mailboxId: String? = nil, folder: SystemFolder, folderId: String? = nil, unreadOnly: Bool = false, conversations: Bool = false) {
		self.mailboxId = mailboxId
		self.folder = folder
		self.folderId = folderId
		self.unreadOnly = unreadOnly
		self.conversations = conversations
	}
}

/// A row of a list: a message, and for a conversation how many messages it stands for.
public struct ListItem: Equatable, Hashable, Identifiable, Sendable {
	public var message: MessageRow
	public var threadCount: Int
	public var threadUnread: Int

	public var id: String { message.id }

	public init(message: MessageRow, threadCount: Int = 1, threadUnread: Int = 0) {
		self.message = message
		self.threadCount = threadCount
		self.threadUnread = threadUnread
	}
}

/// A message as the reader shows it. `body` is nil until it has been fetched.
public struct StoredMessage: Equatable, Sendable {
	public var row: MessageRow
	public var body: MessageBody?
	public var attachments: [AttachmentInfo]
	public var unsubscribeUrl: String?

	public init(row: MessageRow, body: MessageBody? = nil, attachments: [AttachmentInfo] = [], unsubscribeUrl: String? = nil) {
		self.row = row
		self.body = body
		self.attachments = attachments
		self.unsubscribeUrl = unsubscribeUrl
	}
}

public struct MailboxTree: Equatable, Sendable {
	public var mailboxes: [MailboxInfo]
	public var folders: [FolderInfo]
	public var counts: MailCounts

	public init(mailboxes: [MailboxInfo] = [], folders: [FolderInfo] = [], counts: MailCounts = MailCounts()) {
		self.mailboxes = mailboxes
		self.folders = folders
		self.counts = counts
	}
}

extension MessageRow: FetchableRecord, PersistableRecord {
	public static let databaseTableName = "message"
}

extension AttachmentInfo: FetchableRecord, PersistableRecord {
	public static let databaseTableName = "attachment"
}

struct BodyRecord: Codable, FetchableRecord, PersistableRecord {
	static let databaseTableName = "message_body"
	var messageId: String
	var textBody: String?
	var htmlBody: String?
	var unsubscribeUrl: String?
}
