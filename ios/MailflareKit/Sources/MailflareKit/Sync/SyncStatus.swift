import Foundation

/// Where the copy of the mail on this device stands.
public enum SyncStatus: Equatable, Sendable {
	case idle(last: Date?)
	case syncing(firstRun: Bool)
	/// No connection. The stored mail stays readable; `last` is when it was last brought up to date.
	case offline(last: Date?)
	/// Cloudflare Access refused the device's key.
	case accessDenied
	/// Mailflare no longer accepts the session. The app decides what happens to the stored mail.
	case signedOut
	case failed(message: String?)
}

public struct SyncSettings: Equatable, Sendable {
	/// How many days of mail are kept with their content.
	public var days: Int
	/// Attachments up to this size are fetched without being asked for.
	public var autoAttachmentBytes: Int
	public var attachmentsOnWiFiOnly: Bool
	public var pageSize: Int

	public init(days: Int = 30, autoAttachmentBytes: Int = 5_000_000, attachmentsOnWiFiOnly: Bool = true, pageSize: Int = 100) {
		self.days = days
		self.autoAttachmentBytes = autoAttachmentBytes
		self.attachmentsOnWiFiOnly = attachmentsOnWiFiOnly
		self.pageSize = pageSize
	}
}

/// The part of the server the sync needs, so a test can stand in for it.
public protocol MailAPI: Sendable {
	func sync(cursor: String?, days: Int, limit: Int) async throws -> SyncPage
	func message(id: String) async throws -> MessageDetail
	func mailboxes() async throws -> [MailboxInfo]
	func folders(mailboxId: String) async throws -> [FolderInfo]
	func counts(mailboxId: String?) async throws -> MailCounts
}

extension APIClient: MailAPI {}
