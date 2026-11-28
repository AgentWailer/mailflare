import Foundation

/// Something the user does to messages. Each one sets a state, so sending it twice does no harm.
public enum MailAction: Codable, Equatable, Hashable, Sendable {
	case markRead(Bool)
	case star(Bool)
	case archive
	case trash
	case spam
	/// Back to the inbox, out of the archive, the trash, spam or a folder.
	case moveToInbox
	case moveToFolder(String)
	/// Only for mail that is already in the trash or in spam.
	case deletePermanently
	case snooze(until: Date)
	case unsnooze

	/// True for actions that need the right to manage the mailbox, not only to read it.
	public var needsManagePermission: Bool {
		switch self {
		case .markRead, .star: false
		default: true
		}
	}

	/// What the action makes of a stored row. Nil when the row goes away.
	func applied(to row: MessageRow) -> MessageRow? {
		var row = row
		switch self {
		case .markRead(let read): row.read = read
		case .star(let starred): row.starred = starred
		case .archive: row.status = "archived"; row.folderId = nil
		case .trash: row.status = "trash"; row.folderId = nil
		case .spam: row.status = "spam"; row.folderId = nil
		case .moveToInbox: row.status = "received"; row.folderId = nil; row.category = "primary"
		case .moveToFolder(let folderId): row.status = "received"; row.folderId = folderId
		case .deletePermanently: return nil
		case .snooze(let until): row.snoozedUntil = until
		case .unsnooze: row.snoozedUntil = nil
		}
		return row
	}
}

/// An action that has been applied on the device and still has to reach the server.
public struct PendingOperation: Equatable, Identifiable, Sendable {
	public let id: Int64
	public let action: MailAction
	public let messageIds: [String]
	public let attempts: Int
}
